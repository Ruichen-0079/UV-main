import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";

/** Concrete dots complete-audio transport. Model and reference assets belong to the service. */
export class DotsTTSProvider implements TTSProvider {
  readonly name = "local";
  constructor(private readonly config: { baseUrl: string; model: string; timeoutMs?: number }) {}

  async healthCheck(): Promise<ProviderHealth> {
    let available = false;
    let message = "Local TTS service unavailable.";
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      const body = (await response.json()) as {
        service?: string;
        state?: string;
        model_loaded?: boolean;
        ready_on_demand?: boolean;
      };
      const hibernated = body.state === "hibernated" || body.ready_on_demand === true;
      available =
        response.ok &&
        body.service === "yuvi-dots-tts" &&
        ((body.state === "ready" && body.model_loaded === true) ||
          (hibernated && body.state !== "error" && body.state !== "warming"));
      message = available
        ? body.state === "hibernated" || (body.ready_on_demand === true && body.model_loaded !== true)
          ? "Local TTS ready on demand."
          : "Local TTS ready."
        : body.state === "warming"
          ? "Local TTS warming."
          : "Local TTS unavailable.";
    } catch {
      /* sanitized public diagnostic */
    }
    return {
      provider: this.name,
      capability: "tts",
      status: available ? "healthy" : "unavailable",
      configured: true,
      available,
      mock: false,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      checkedAt: new Date().toISOString(),
      message
    };
  }

  async synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput> {
    const transport = createTransportAbort({
      signal: options?.signal ?? input.signal,
      timeoutMs: this.config.timeoutMs ?? 120_000
    });
    const requestId = crypto.randomUUID();
    const base = this.config.baseUrl.replace(/\/$/, "");
    let started = false;
    const cancel = () => {
      if (!started) return;
      void fetch(`${base}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
        signal: AbortSignal.timeout(2000)
      }).catch(() => undefined);
    };
    transport.signal.addEventListener("abort", cancel, { once: true });
    try {
      transport.signal.throwIfAborted();
      const language =
        typeof input.metadata?.["language"] === "string"
          ? input.metadata["language"].toUpperCase()
          : undefined;
      if (
        !input.text.trim() ||
        (input.format && input.format !== "wav") ||
        input.speed !== undefined ||
        (language !== undefined && !["JA", "EN", "ZH"].includes(language))
      ) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.UnsupportedInput,
          message: "Local TTS requires text, WAV format and a supported language.",
          retryable: false
        });
      }
      started = transport.markStarted();
      transport.signal.throwIfAborted();
      let response: Response;
      do {
        response = await fetch(`${base}/tts`, {
          method: "POST",
          signal: transport.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId,
            text: input.text,
            language,
            ...(input.voice ? { voice: input.voice } : {})
          })
        });
        if (response.status !== 429 && response.status !== 503) break;
        await response.arrayBuffer();
        // Only transient unavailability (no work admitted) may be retried.
        // The local single-flight wrapper answers 429 while busy and 503
        // while warming; both mean "try again shortly". One prior cancelled
        // generation can drain.
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Cancelled", "AbortError"));
          };
          const timer = setTimeout(() => {
            transport.signal.removeEventListener("abort", abort);
            resolve();
          }, 200);
          transport.signal.addEventListener("abort", abort, { once: true });
          if (transport.signal.aborted) abort();
        });
      } while (!transport.signal.aborted);
      transport.signal.throwIfAborted();
      if (!response.ok)
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: mapHttpStatusToProviderErrorCode(response.status),
          message: `Local TTS returned HTTP ${response.status}.`,
          retryable: false
        });
      const audio = new Uint8Array(await response.arrayBuffer());
      transport.signal.throwIfAborted();
      if (
        audio.length < 44 ||
        new TextDecoder().decode(audio.slice(0, 4)) !== "RIFF" ||
        new TextDecoder().decode(audio.slice(8, 12)) !== "WAVE"
      ) {
        throw new Error("Invalid WAV");
      }
      return {
        audio,
        mimeType: "audio/wav",
        model: this.config.model,
        finalProvider: this.name,
        providerMetadata: { language }
      };
    } catch (error) {
      if (transport.source !== null)
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code:
            transport.source === "caller" ? ProviderErrorCode.Cancelled : ProviderErrorCode.Timeout,
          message: transport.source === "caller" ? "Local TTS cancelled." : "Local TTS timed out.",
          effectState: transport.effectState ?? "unknown",
          retryable: false
        });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.NetworkError,
        message: "Local TTS transport failed.",
        retryable: false
      });
    } finally {
      transport.signal.removeEventListener("abort", cancel);
      transport.cleanup();
    }
  }
}
