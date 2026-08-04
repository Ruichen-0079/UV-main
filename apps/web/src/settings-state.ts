export type SettingsApplyState =
  | "clean"
  | "dirty"
  | "saving"
  | "reloading"
  | "refreshing"
  | "applied"
  | "failed"
  | "restart-required";

export type SettingsStateEvent =
  | "edit"
  | "save-start"
  | "save-success"
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
  applied: "已应用",
  failed: "应用失败",
  "restart-required": "已保存，需要重启"
};

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
      return "clean";
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
