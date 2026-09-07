import type { LumiController } from "./lumi-live2d.js";
import {
  createInitialCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import type { LumiExpression } from "./lumi-presentation-calibration.js";

/** DEV-only consolidated visual rehearsal; never admits Runtime work or generates speech. */
export function installPresentationRehearsal(
  controller: LumiController,
  current: () => CompanionPresenceProjection
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const host = window as Window & { __yuviPresentationRehearsal?: () => () => void };
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (running) controller.setPresentationProjection(current());
    running = false;
  };
  const run = () => {
    stop();
    if (controller.getModelLifecycle() !== "ready")
      throw new Error("Wait for the Companion model to be ready.");
    running = true;
    const epoch = `preview:${Date.now()}`;
    const base = { ...createInitialCompanionPresence(), epoch, lifecycle: "active" as const };
    const stages: {
      label: string;
      expression?: LumiExpression;
      projection?: Partial<CompanionPresenceProjection>;
      gaze?: { x: number; y: number; strength: number };
      ms?: number;
    }[] = [
      { label: "idle", ms: 6000 },
      { label: "soft smile", expression: "soft-smile" },
      {
        label: "speaking sway (motion preview; check real voice afterwards)",
        expression: "soft-smile",
        projection: { speech: "active" }
      },
      { label: "large X sway / amused", expression: "amused" },
      { label: "Y bounce / excited", expression: "excited" },
      { label: "thinking", expression: "thinking", projection: { activity: "thinking" } },
      {
        label: "attentive gaze",
        expression: "attentive",
        projection: { activity: "listening" },
        gaze: { x: 0.65, y: 0.25, strength: 1 }
      },
      { label: "expressive peak before interruption", expression: "excited", ms: 700 },
      {
        label: "interruption / arrest",
        projection: { transition: "interrupted", speech: "cancelled" }
      },
      { label: "hide Companion now, then show it again", expression: "excited", ms: 10000 },
      { label: "settled idle", ms: 6000 }
    ];
    let index = 0;
    const next = () => {
      if (!running) return;
      const stage = stages[index++];
      if (!stage) {
        stop();
        console.info(
          "YUVI rehearsal complete. Check one real spoken turn and barge-in, then give one feedback batch."
        );
        return;
      }
      console.info(`YUVI presentation: ${stage.label}`);
      controller.setPresentationProjection({ ...base, ...stage.projection });
      controller.setGazeTarget(stage.gaze ?? null);
      if (stage.expression)
        controller.executeEmbodiedPresentationRequest({
          version: "embodied-presentation-request-7ad.v1",
          effectId: `${epoch}:effect:${index}`,
          behavior: {
            version: "embodied-behavior-7b.v1",
            behavior: {
              version: "embodied-behavior-7a.v1",
              kind: "EXPRESSION",
              cause: { kind: "character", reference: `${epoch}:cause` },
              intent: stage.expression
            },
            sourceInstance: { reference: `${epoch}:source:${index}`, createdAtMs: Date.now() },
            correlation: { kind: "turn", reference: epoch }
          }
        });
      timer = setTimeout(next, stage.ms ?? 4000);
    };
    next();
    return stop;
  };
  host.__yuviPresentationRehearsal = run;
  return () => {
    stop();
    if (host.__yuviPresentationRehearsal === run) delete host.__yuviPresentationRehearsal;
  };
}
