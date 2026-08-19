export type SettingsApplyState =
  | "clean"
  | "dirty"
  | "saving"
  | "reloading"
  | "refreshing"
  | "saved-not-applied"
  | "applied"
  | "failed"
  | "restart-required";

export type SettingsOperationMode = "save-only" | "save-and-apply";

export type RuntimeAliasSettingKey = "EVENT_BUS" | "MEMORY_REPOSITORY";

export type SettingsOperationOutcome = {
  saveSucceeded: boolean;
  refreshSucceeded: boolean;
  applyConfirmed?: boolean;
  restartRequired?: boolean;
  draftChangedDuringOperation?: boolean;
};

export type SettingsStateEvent =
  | "edit"
  | "save-start"
  | "save-success"
  | "save-only-success"
  | "reload-start"
  | "refresh-start"
  | "apply-success"
  | "restart-required"
  | "failure"
  | "reset"
  | "provider-verify-success"
  | "provider-verify-failure";

export const settingsStateLabels: Record<SettingsApplyState, string> = {
  clean: "",
  dirty: "有未保存更改",
  saving: "正在保存",
  reloading: "正在应用到 Runtime",
  refreshing: "正在确认生效结果",
  "saved-not-applied": "已保存，尚未应用",
  applied: "已应用",
  failed: "应用失败",
  "restart-required": "已保存，需要重启"
};

/**
 * Compare the saved/effective and active Runtime representations using the
 * same aliases accepted by the existing settings authority. The authority
 * reports the active value canonically as `in-memory`, while either editable
 * setting may still contain the valid `memory` alias (or its default empty
 * representation).
 */
export function normalizeRuntimeSettingForComparison(
  key: RuntimeAliasSettingKey,
  value: string | undefined
): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  switch (key) {
    case "EVENT_BUS":
    case "MEMORY_REPOSITORY":
      return !normalized || normalized === "memory" ? "in-memory" : normalized;
  }
  return normalized;
}

export function reduceSettingsState(
  state: SettingsApplyState,
  event: SettingsStateEvent
): SettingsApplyState {
  switch (event) {
    case "edit":
      return state === "saving" || state === "reloading" || state === "refreshing"
        ? state
        : "dirty";
    case "save-start":
      return "saving";
    case "save-success":
    case "save-only-success":
      return "saved-not-applied";
    case "reload-start":
      return "reloading";
    case "refresh-start":
      return "refreshing";
    case "apply-success":
      return "applied";
    case "restart-required":
      return "restart-required";
    case "failure":
      return "failed";
    case "reset":
      return "clean";
    case "provider-verify-success":
    case "provider-verify-failure":
      return state;
  }
}

/**
 * Resolve the presentation state only after the operation's required evidence
 * has arrived. A save-only operation never produces an applied state because
 * it does not reload the Runtime.
 */
export function resolveSettingsOperationState(
  mode: SettingsOperationMode,
  outcome: SettingsOperationOutcome
): SettingsApplyState {
  if (!outcome.saveSucceeded || !outcome.refreshSucceeded) return "failed";
  if (outcome.restartRequired) return "restart-required";
  if (mode === "save-only") {
    return outcome.draftChangedDuringOperation ? "dirty" : "saved-not-applied";
  }
  if (!outcome.applyConfirmed) return "failed";
  return outcome.draftChangedDuringOperation ? "dirty" : "applied";
}

/**
 * Keep the presentation state aligned with the current draft once no
 * settings operation is in flight. Reverting an edit must clear only the
 * transient dirty marker; saved/effective and restart-required outcomes are
 * still represented by their own states.
 */
export function synchronizeSettingsDraftState(
  state: SettingsApplyState,
  draftDirty: boolean,
  operationBusy: boolean
): SettingsApplyState {
  if (operationBusy) return state;
  if (draftDirty) {
    return state === "failed" || state === "restart-required" ? state : "dirty";
  }
  return state === "dirty" ? "clean" : state;
}

export function settingsFingerprint<T extends Record<string, string>>(
  form: T,
  clearedSecrets: Iterable<string> = []
): string {
  return JSON.stringify({
    form,
    clearedSecrets: [...clearedSecrets].sort()
  });
}

export function settingsDraftDiffers<T extends Record<string, string>>(
  draft: T,
  baseline: T | null,
  clearedSecrets: Iterable<string> = []
): boolean {
  if (!baseline) return false;
  return settingsFingerprint(draft, clearedSecrets) !== settingsFingerprint(baseline);
}

export function compareSettingsForms<T extends Record<string, string>>(
  expected: T,
  actual: T,
  sensitiveKeys: ReadonlySet<string>
): { mismatchedKeys: string[]; ignoredSensitiveKeys: string[] } {
  const mismatchedKeys: string[] = [];
  const ignoredSensitiveKeys: string[] = [];
  for (const key of Object.keys(expected)) {
    if (sensitiveKeys.has(key)) {
      ignoredSensitiveKeys.push(key);
      continue;
    }
    if (expected[key] !== actual[key]) mismatchedKeys.push(key);
  }
  return { mismatchedKeys, ignoredSensitiveKeys };
}

export function isCurrentSettingsOperation(
  mounted: boolean,
  operation: number,
  currentOperation: number
): boolean {
  return mounted && operation === currentOperation;
}

export function shouldReplaceSettingsDraft(
  alreadySeeded: boolean,
  draftTouchedBeforeLoad: boolean
): boolean {
  return !alreadySeeded && !draftTouchedBeforeLoad;
}
