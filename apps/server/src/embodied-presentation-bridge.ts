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
      observe?: (report: EmbodiedPresentationOutcomeReport) => Promise<void>;
      progress: Promise<void>;
    }
  >();

  constructor(private readonly eventBus: Pick<EventBus, "publish">) {}

  async present(
    request: EmbodiedPresentationRequest,
    traceAnchor: RuntimeEvent,
    observe?: (report: EmbodiedPresentationOutcomeReport) => Promise<void>
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
      this.pending.set(request.effectId, {
        resolve,
        timer,
        progress: Promise.resolve(),
        ...(observe && request.behavior.behavior.kind !== "SILENCE" ? { observe } : {})
      });
    });

    try {
      await this.eventBus.publish(
        createEvent("runtime.embodied.presentation.request", request, {
          traceId: traceAnchor.traceId,
          parentId: traceAnchor.id
        })
      );
    } catch (error) {
      const entry = this.pending.get(request.effectId);
      if (entry) clearTimeout(entry.timer);
      this.pending.delete(request.effectId);
      throw error;
    }
    return report;
  }

  resolve(input: unknown): boolean {
    const report = createEmbodiedPresentationOutcomeReport(input);
    const entry = this.pending.get(report.effectId);
    if (!entry) return false;
    if (report.outcome === "STARTED" && entry.observe) {
      entry.progress = entry.progress.then(() => entry.observe!(report));
      // Fail this request if Runtime observation/publication fails; never leak a rejection.
      void entry.progress.catch(() => {
        if (this.pending.get(report.effectId) === entry) {
          clearTimeout(entry.timer);
          this.pending.delete(report.effectId);
          entry.resolve({ ...report, outcome: "FAILED" });
        }
      });
      return true;
    }
    clearTimeout(entry.timer);
    this.pending.delete(report.effectId);
    void entry.progress.then(
      () => entry.resolve(report),
      () => entry.resolve({ ...report, outcome: "FAILED" })
    );
    return true;
  }

  close(): void {
    for (const [effectId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        version: "embodied-presentation-outcome-7k.v1",
        effectId,
        outcome: "INTERRUPTED"
      });
    }
    this.pending.clear();
  }
}
