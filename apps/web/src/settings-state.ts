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
 * Normalize only representations that the existing settings authority accepts
 * and projects canonically. Unknown values, invalid values, and missing values
 * remain distinct so comparison cannot hide an invalid editor draft.
 */
export function normalizeSettingsValueForComparison(
  key: string,
  value: string | undefined
): string | undefined {
  if (value === undefined) return undefined;

  if (key === "EVENT_BUS" || key === "MEMORY_REPOSITORY") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "memory" || normalized === "in-memory") return "in-memory";
    if (key === "MEMORY_REPOSITORY" && normalized === "postgres") return "postgres";
    return value;
  }

  if (key === "PROVIDER_ALLOW_MOCKS") {
    const normalized = value.toLowerCase();
    if (normalized === "" || ["false", "0", "no", "off"].includes(normalized)) {
      return "false";
    }
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return "true";
    }
  }

  if (key === "SERVER_PORT" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return String(parsed);
    }
  }

  return value;
}

/**
 * Runtime responses use empty and `memory` as aliases for the canonical
 * in-memory implementations. This helper intentionally keeps that defaulting
 * behavior separate from editor comparison, where an empty invalid draft must
 * remain visible as different from an explicit canonical value.
 */
export function normalizeRuntimeSettingForComparison(
  key: RuntimeAliasSettingKey,
  value: string | undefined
): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized || normalized === "memory" || normalized === "in-memory") {
    return "in-memory";
  }
  if (key === "MEMORY_REPOSITORY" && normalized === "postgres") return "postgres";
  return value ?? "";
}

/**
 * Compatibility name retained for the focused settings-state tests and callers
 * that specifically compare editor forms.
 */
export function normalizeSettingsFormValueForComparison(
  key: string,
  value: string | undefined
): string | undefined {
  return normalizeSettingsValueForComparison(key, value);
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
    form: Object.fromEntries(
      Object.entries(form).map(([key, value]) => [
        key,
        normalizeSettingsFormValueForComparison(key, value)
      ])
    ),
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
    if (
      normalizeSettingsFormValueForComparison(key, expected[key]) !==
      normalizeSettingsFormValueForComparison(key, actual[key])
    ) {
      mismatchedKeys.push(key);
    }
  }
  return { mismatchedKeys, ignoredSensitiveKeys };
}

/**
 * Merge a successful persistence response into the saved baseline. Secret
 * response values are intentionally empty or masked, so only the submitted
 * operation snapshot may supply secret baseline values.
 */
export function mergeSettingsBaseline<T extends Record<string, string>>(
  currentBaseline: T | null,
  persistedForm: T,
  submittedSnapshot: T,
  sensitiveKeys: ReadonlySet<string>
): T {
  const baseline: Record<string, string> = { ...(currentBaseline ?? persistedForm) };
  for (const key of Object.keys(persistedForm)) {
    baseline[key] = sensitiveKeys.has(key)
      ? (submittedSnapshot[key] ?? "")
      : (persistedForm[key] ?? "");
  }
  return baseline as T;
}

/**
 * Remove only clear intents that were included in a successful operation.
 * Revision maps let the UI preserve a same-key clear created after the
 * operation snapshot; the optional maps keep the helper useful for simple
 * set-based reconciliation tests and callers.
 */
export function reconcileSavedSecretClears<T extends string>(
  currentClearedSecrets: Iterable<T>,
  persistedClearedSecrets: Iterable<T>,
  snapshotClearRevisions?: ReadonlyMap<T, number>,
  currentClearRevisions?: ReadonlyMap<T, number>
): Set<T> {
  const next = new Set<T>(currentClearedSecrets);
  const persisted = new Set<T>(persistedClearedSecrets);
  for (const key of persisted) {
    if (snapshotClearRevisions && currentClearRevisions) {
      const snapshotRevision = snapshotClearRevisions.get(key);
      if (snapshotRevision !== undefined && currentClearRevisions.get(key) !== snapshotRevision) {
        continue;
      }
    }
    next.delete(key);
  }
  return next;
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
