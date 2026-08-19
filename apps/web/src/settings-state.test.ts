import { describe, expect, it } from "vitest";
import {
  compareSettingsForms,
  isCurrentSettingsOperation,
  normalizeRuntimeSettingForComparison,
  reduceSettingsState,
  resolveSettingsOperationState,
  shouldReplaceSettingsDraft,
  settingsDraftDiffers,
  settingsStateLabels,
  synchronizeSettingsDraftState
} from "./settings-state.js";

describe("settings apply state", () => {
  it("keeps Save Only in a saved/effective but not applied state", () => {
    expect(reduceSettingsState("saving", "save-only-success")).toBe("saved-not-applied");
    expect(
      resolveSettingsOperationState("save-only", {
        saveSucceeded: true,
        refreshSucceeded: true
      })
    ).toBe("saved-not-applied");
    expect(settingsStateLabels["saved-not-applied"]).toBe("已保存，尚未应用");
    expect(
      resolveSettingsOperationState("save-only", {
        saveSucceeded: true,
        refreshSucceeded: true,
        restartRequired: true
      })
    ).toBe("restart-required");
  });

  it("models save, reload, refresh and applied in order", () => {
    let state = reduceSettingsState("dirty", "save-start");
    state = reduceSettingsState(state, "reload-start");
    state = reduceSettingsState(state, "refresh-start");
    state = reduceSettingsState(state, "apply-success");
    expect(state).toBe("applied");
    expect(settingsStateLabels[state]).toBe("已应用");
  });

  it("reports Save & Apply as applied only after refresh confirmation", () => {
    expect(
      resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: true
      })
    ).toBe("applied");
    expect(
      resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: false
      })
    ).toBe("failed");
  });

  it("keeps failure and restart-required outcomes distinct", () => {
    expect(
      resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: false
      })
    ).toBe("failed");
    expect(
      resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: true,
        restartRequired: true
      })
    ).toBe("restart-required");
    expect(reduceSettingsState("refreshing", "failure")).toBe("failed");
    expect(reduceSettingsState("refreshing", "restart-required")).toBe("restart-required");
    expect(settingsStateLabels.failed).toBe("应用失败");
    expect(settingsStateLabels["restart-required"]).toBe("已保存，需要重启");
  });

  it("keeps edits made during an operation as a new dirty draft", () => {
    expect(reduceSettingsState("saving", "edit")).toBe("saving");
    expect(reduceSettingsState("reloading", "edit")).toBe("reloading");
    expect(reduceSettingsState("refreshing", "edit")).toBe("refreshing");
    expect(
      resolveSettingsOperationState("save-only", {
        saveSucceeded: true,
        refreshSucceeded: true,
        draftChangedDuringOperation: true
      })
    ).toBe("dirty");
    expect(
      resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: true,
        draftChangedDuringOperation: true
      })
    ).toBe("dirty");
  });

  it("does not turn an applied configuration into a save failure when verification fails", () => {
    const state = reduceSettingsState("applied", "provider-verify-failure");
    expect(state).toBe("applied");
  });

  it("keeps a draft dirty when it differs from the last baseline", () => {
    const baseline = { SERVER_PORT: "6121", DEEPSEEK_API_KEY: "" };
    expect(settingsDraftDiffers({ ...baseline, SERVER_PORT: "7000" }, baseline)).toBe(true);
    expect(settingsDraftDiffers(baseline, baseline)).toBe(false);
    expect(settingsDraftDiffers({ ...baseline, DEEPSEEK_API_KEY: "new" }, baseline)).toBe(true);
  });

  it("clears only the transient dirty state when a draft is restored", () => {
    expect(synchronizeSettingsDraftState("dirty", false, false)).toBe("clean");
    expect(synchronizeSettingsDraftState("saved-not-applied", false, false)).toBe(
      "saved-not-applied"
    );
    expect(synchronizeSettingsDraftState("restart-required", false, false)).toBe(
      "restart-required"
    );
    expect(synchronizeSettingsDraftState("dirty", false, true)).toBe("dirty");
  });

  it("does not replace a dirty draft when settings data refreshes", () => {
    expect(shouldReplaceSettingsDraft(false, false)).toBe(true);
    expect(shouldReplaceSettingsDraft(false, true)).toBe(false);
    expect(shouldReplaceSettingsDraft(true, false)).toBe(false);
  });

  it("ignores masked secret values while comparing ordinary fields", () => {
    const result = compareSettingsForms(
      { SERVER_PORT: "6121", DEEPSEEK_API_KEY: "new-secret" },
      { SERVER_PORT: "6122", DEEPSEEK_API_KEY: "" },
      new Set(["DEEPSEEK_API_KEY"])
    );
    expect(result.mismatchedKeys).toEqual(["SERVER_PORT"]);
    expect(result.ignoredSensitiveKeys).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("normalizes valid runtime aliases before comparing saved and active values", () => {
    expect(normalizeRuntimeSettingForComparison("EVENT_BUS", "memory")).toBe("in-memory");
    expect(normalizeRuntimeSettingForComparison("MEMORY_REPOSITORY", "memory")).toBe(
      "in-memory"
    );
    expect(normalizeRuntimeSettingForComparison("MEMORY_REPOSITORY", "in-memory")).toBe(
      "in-memory"
    );
    expect(
      normalizeRuntimeSettingForComparison("MEMORY_REPOSITORY", undefined)
    ).toBe("in-memory");
  });

  it("rejects stale responses and callbacks after unmount", () => {
    expect(isCurrentSettingsOperation(true, 2, 1)).toBe(false);
    expect(isCurrentSettingsOperation(false, 2, 2)).toBe(false);
    expect(isCurrentSettingsOperation(true, 2, 2)).toBe(true);
  });
});
