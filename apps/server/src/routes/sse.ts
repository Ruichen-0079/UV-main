import type { ServerResponse } from "node:http";

export class SseConnectionClosedError extends Error {
  constructor(message = "SSE connection closed.") {
    super(message);
    this.name = "SseConnectionClosedError";
  }
}

export function encodeSseFrame(event: string, data: unknown): string {
  const serialized = JSON.stringify(data);
  if (serialized === undefined || serialized.includes("\r") || serialized.includes("\n")) {
    throw new Error("SSE data must serialize to one line of JSON.");
  }
  return `event: ${event}\ndata: ${serialized}\n\n`;
}

export async function writeSseFrame(
  response: ServerResponse,
  event: string,
  data: unknown,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted || response.destroyed || response.writableEnded) {
    throw new SseConnectionClosedError();
  }

  const accepted = response.write(encodeSseFrame(event, data));
  if (accepted) {
    return;
  }

  await waitForDrain(response, signal);
}

function waitForDrain(response: ServerResponse, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, new SseConnectionClosedError());
    const onError = (error: Error) => finish(reject, error);
    const onAbort = () => finish(reject, new SseConnectionClosedError("SSE write aborted."));

    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (callback: () => void, error?: Error) => {
      cleanup();
      if (error) {
        reject(error);
      } else {
        callback();
      }
    };

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (signal?.aborted || response.destroyed || response.writableEnded) {
      onAbort();
    }
  });
}
