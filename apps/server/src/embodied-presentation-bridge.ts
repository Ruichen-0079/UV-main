import {
  createEmbodiedPresentationOutcomeReport,
  createEvent,
  type EmbodiedPresentationOutcomeReport,
  type EmbodiedPresentationRequest,
  type RuntimeEvent
} from "@companion/protocol";
import type { EventBus } from "@companion/event-bus";

const PRESENTATION_TIMEOUT_MS = 15_000;

/** The server-side transport port for the already-admitted Runtime effect. */
export class EmbodiedPresentationBridge {
  private readonly pending = new Map<
    string,
    {
      resolve: (report: EmbodiedPresentationOutcomeReport) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly eventBus: Pick<EventBus, "publish">) {}

  async present(
    request: EmbodiedPresentationRequest,
    traceAnchor: RuntimeEvent
  ): Promise<EmbodiedPresentationOutcomeReport> {
    if (this.pending.has(request.effectId)) {
      return {
        version: "embodied-presentation-outcome-7k.v1",
        effectId: request.effectId,
        outcome: "REJECTED"
      };
    }

    const report = new Promise<EmbodiedPresentationOutcomeReport>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.effectId);
        resolve({
          version: "embodied-presentation-outcome-7k.v1",
          effectId: request.effectId,
          outcome: "FAILED"
        });
      }, PRESENTATION_TIMEOUT_MS);
      this.pending.set(request.effectId, { resolve, timer });
    });

    await this.eventBus.publish(
      createEvent("runtime.embodied.presentation.request", request, {
        traceId: traceAnchor.traceId,
        parentId: traceAnchor.id
      })
    );
    return report;
  }

  resolve(input: unknown): boolean {
    const report = createEmbodiedPresentationOutcomeReport(input);
    const entry = this.pending.get(report.effectId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(report.effectId);
    entry.resolve(report);
    return true;
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
