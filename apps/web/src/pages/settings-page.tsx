import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import {
  ApiError,
  apiClient,
  type LayeredSetting,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderVerificationResponse,
  type ProvidersStatusResponse,
  type RuntimeSettingsReloadResponse,
  type RuntimeSettingsResponse
} from "../api/client.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import {
  compareSettingsForms,
  isCurrentSettingsOperation,
  mergeSettingsBaseline,
  normalizeRuntimeSettingForComparison,
  reconcileSavedSecretClears,
  resolveSettingsOperationState,
  settingsDraftDiffers,
  settingsFingerprint,
  settingsStateLabels,
  shouldReplaceSettingsDraft,
  synchronizeSettingsDraftState,
  type SettingsApplyState,
  type SettingsOperationMode
} from "../settings-state.js";
import {
  cachedObservationDetail,
  providerObservationLabel,
  providerReadinessLabel
} from "../provider-diagnostics.js";
import { ProviderVerificationResult } from "../dashboard-provider-verification.js";
import { Definition, Field, Notice, PageShell, Panel } from "../dashboard-ui.js";

function deepRestartErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "Deep restart requires supervisor mode. Start with: YUVI_DEV_SUPERVISOR=1 ./scripts/dev.sh";
    }
    if (error.status === 401) {
      return "Dashboard dev token required. Enter DASHBOARD_DEV_TOKEN in the dashboard token field.";
    }
    if (error.status === 403) {
      return "Deep restart is localhost-only.";
    }
    if (error.status === 404 || error.status === 405) {
      return "Deep restart is disabled in production.";
    }
  }
  return error instanceof Error ? error.message : "Deep restart failed";
}

export function SettingsPage(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const [form, setForm] = useState<SettingsForm>(() => emptySettingsForm());
  const [loadedForm, setLoadedForm] = useState<SettingsForm | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsApplyState>("clean");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    mode: SettingsOperationMode;
    changedKeys: string[];
    restartRequired: boolean;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<RuntimeSettingsReloadResponse | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<ProviderCapability | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [clearedSecrets, setClearedSecrets] = useState<Set<SettingsKey>>(() => new Set());
  const [dashboardDevToken, setDashboardDevTokenState] = useState("");
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const operationSeqRef = useRef(0);
  const seededRef = useRef(false);
  const draftTouchedBeforeLoadRef = useRef(false);
  const formRef = useRef(form);
  const clearedSecretsRef = useRef(clearedSecrets);
  const clearRevisionRef = useRef(new Map<SettingsKey, number>());
  formRef.current = form;
  clearedSecretsRef.current = clearedSecrets;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!seededRef.current && !settings.data) {
      draftTouchedBeforeLoadRef.current =
        settingsFingerprint(form, clearedSecrets) !==
        settingsFingerprint(emptySettingsForm(), new Set());
    }
  }, [form, clearedSecrets, settings.data]);

  useEffect(() => {
    if (settings.data) {
      const next = settingsFormFromResponse(settings.data);
      setLoadedForm((current) => current ?? next);
      if (!seededRef.current) {
        const replaceDraft = shouldReplaceSettingsDraft(
          seededRef.current,
          draftTouchedBeforeLoadRef.current
        );
        seededRef.current = true;
        if (replaceDraft) setForm(next);
        else setSettingsState("dirty");
      }
    }
  }, [settings.data]);

  const draftDirty = settingsDraftDiffers(form, loadedForm, clearedSecrets);
  const operationBusy = saving || applying;

  useEffect(() => {
    const nextState = synchronizeSettingsDraftState(settingsState, draftDirty, operationBusy);
    if (nextState !== settingsState) setSettingsState(nextState);
  }, [draftDirty, operationBusy, settingsState]);

  function beginOperation(): number {
    const operation = ++operationSeqRef.current;
    setSaveError(null);
    setApplyError(null);
    setSaveResult(null);
    setApplyResult(null);
    return operation;
  }

  function operationIsCurrent(operation: number): boolean {
    return isCurrentSettingsOperation(mountedRef.current, operation, operationSeqRef.current);
  }

  function localValidation(snapshot: SettingsForm): string | null {
    const port = Number(snapshot.SERVER_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "SERVER_PORT 必须是 1 到 65535 之间的整数。";
    }
    if (!snapshot.MEMORY_REPOSITORY.trim()) return "MEMORY_REPOSITORY 不能为空。";
    return null;
  }

  function updateSavedBaseline(snapshot: SettingsForm, persisted: SettingsForm): void {
    setLoadedForm((current) => {
      return mergeSettingsBaseline(current, persisted, snapshot, new Set(settingsSecretKeys));
    });
  }

  function reconcileSavedClearIntents(
    snapshotClearedSecrets: Set<SettingsKey>,
    snapshotClearRevisions: ReadonlyMap<SettingsKey, number>
  ): Set<SettingsKey> {
    const reconciled = reconcileSavedSecretClears(
      clearedSecretsRef.current,
      snapshotClearedSecrets,
      snapshotClearRevisions,
      clearRevisionRef.current
    );
    clearedSecretsRef.current = reconciled;
    setClearedSecrets(reconciled);
    return reconciled;
  }

  function clearSecretField(key: SettingsKey): void {
    clearSecret(setForm, setClearedSecrets, key);
    const nextRevision = (clearRevisionRef.current.get(key) ?? 0) + 1;
    clearRevisionRef.current.set(key, nextRevision);
    clearedSecretsRef.current = new Set([...clearedSecretsRef.current, key]);
  }

  async function saveAndApply(): Promise<void> {
    if (operationBusy) return;
    const snapshot = { ...form };
    const snapshotClearedSecrets = new Set(clearedSecrets);
    const snapshotClearRevisions = new Map(clearRevisionRef.current);
    const validationError = localValidation(snapshot);
    if (validationError) {
      setSettingsState("failed");
      setSaveError(validationError);
      return;
    }
    const operation = beginOperation();
    let stage: "save" | "reload" | "refresh" = "save";
    setSaving(true);
    setSettingsState("saving");
    try {
      const response = await apiClient.updateRuntimeSettings({
        values: buildSettingsUpdate(snapshot, snapshotClearedSecrets)
      });
      if (!operationIsCurrent(operation)) return;
      const persistedForm = settingsFormFromResponse(response.settings);
      updateSavedBaseline(snapshot, persistedForm);
      reconcileSavedClearIntents(snapshotClearedSecrets, snapshotClearRevisions);
      setSaveResult({
        mode: "save-and-apply",
        changedKeys: response.changedKeys,
        restartRequired: response.restartRequired
      });
      setSettingsState("reloading");
      setApplying(true);
      stage = "reload";
      const reloadResponse = await apiClient.reloadRuntimeSettings();
      if (!operationIsCurrent(operation)) return;
      setApplyResult(reloadResponse);
      setSettingsState("refreshing");
      stage = "refresh";
      const refreshedResponse = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshedResponse) {
        setSettingsState(
          resolveSettingsOperationState("save-and-apply", {
            saveSucceeded: true,
            refreshSucceeded: false
          })
        );
        setApplyError("配置已保存，但重新读取生效值失败。");
        return;
      }
      const refreshedForm = settingsFormFromResponse(refreshedResponse);
      const comparison = compareSettingsForms(
        persistedForm,
        refreshedForm,
        new Set(settingsSecretKeys)
      );
      const activeRuntimeMismatch =
        refreshedResponse.runtime.serverHost !== refreshedResponse.activeRuntimeConfig.serverHost ||
        refreshedResponse.runtime.serverPort !== refreshedResponse.activeRuntimeConfig.serverPort ||
        normalizeRuntimeSettingForComparison("EVENT_BUS", refreshedResponse.runtime.eventBus) !==
          normalizeRuntimeSettingForComparison(
            "EVENT_BUS",
            refreshedResponse.activeRuntimeConfig.eventBus
          ) ||
        normalizeRuntimeSettingForComparison(
          "MEMORY_REPOSITORY",
          refreshedResponse.memory.memoryRepository
        ) !==
          normalizeRuntimeSettingForComparison(
            "MEMORY_REPOSITORY",
            refreshedResponse.activeRuntimeConfig.memoryRepository
          ) ||
        (refreshedResponse.memory.memoryExtractor !== undefined &&
          refreshedResponse.activeRuntimeConfig.memoryExtractor !== undefined &&
          refreshedResponse.memory.memoryExtractor !==
            refreshedResponse.activeRuntimeConfig.memoryExtractor);
      if (comparison.mismatchedKeys.length === 0) {
        updateSavedBaseline(snapshot, refreshedForm);
      }
      const draftChangedDuringSave =
        settingsFingerprint(formRef.current, clearedSecretsRef.current) !==
        settingsFingerprint(snapshot);
      const restartRequired =
        response.restartRequired ||
        reloadResponse.restartRequired ||
        refreshedResponse.restartRequired ||
        refreshedResponse.runtime.pendingRestart ||
        reloadResponse.notHotReloaded.length > 0;
      const applyConfirmed =
        reloadResponse.applied && !restartRequired && comparison.mismatchedKeys.length === 0;
      const confirmedActiveRuntime = applyConfirmed && !activeRuntimeMismatch;
      const resolvedState = resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: confirmedActiveRuntime,
        restartRequired,
        draftChangedDuringOperation: draftChangedDuringSave
      });
      setSettingsState(resolvedState);
      if (resolvedState === "restart-required") {
        setApplyError(
          reloadResponse.notHotReloaded.length > 0
            ? `配置已保存，需要重启后生效：${reloadResponse.notHotReloaded.join(", ")}`
            : "配置已保存，需要重启后生效。"
        );
      } else if (resolvedState === "failed") {
        let applyFailureMessage = "配置已保存，但 Runtime 应用或刷新确认未完成。";
        if (comparison.mismatchedKeys.length > 0) {
          applyFailureMessage = `配置已保存，但实际生效值不一致：${comparison.mismatchedKeys.join(", ")}`;
        } else if (activeRuntimeMismatch) {
          applyFailureMessage =
            "配置已保存，但 refreshed activeRuntimeConfig 仍与 saved / effective configuration 不一致。";
        }
        setApplyError(applyFailureMessage);
      }
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      const message = caught instanceof Error ? caught.message : "保存或应用配置失败";
      if (stage === "save") {
        setSaveError(message);
      } else {
        setApplyError("配置已保存，但 Runtime 应用或刷新确认失败。请检查 Runtime 状态后重试。");
      }
    } finally {
      if (operationIsCurrent(operation)) {
        setSaving(false);
        setApplying(false);
      }
    }
  }

  async function saveOnly(): Promise<void> {
    if (operationBusy) return;
    const snapshot = { ...form };
    const snapshotClearedSecrets = new Set(clearedSecrets);
    const snapshotClearRevisions = new Map(clearRevisionRef.current);
    const validationError = localValidation(snapshot);
    if (validationError) {
      setSettingsState("failed");
      setSaveError(validationError);
      return;
    }
    const operation = beginOperation();
    let stage: "save" | "refresh" = "save";
    setSaving(true);
    setSettingsState("saving");
    try {
      const response = await apiClient.updateRuntimeSettings({
        values: buildSettingsUpdate(snapshot, snapshotClearedSecrets)
      });
      if (!operationIsCurrent(operation)) return;
      const persistedForm = settingsFormFromResponse(response.settings);
      updateSavedBaseline(snapshot, persistedForm);
      reconcileSavedClearIntents(snapshotClearedSecrets, snapshotClearRevisions);
      setSaveResult({
        mode: "save-only",
        changedKeys: response.changedKeys,
        restartRequired: response.restartRequired
      });
      stage = "refresh";
      const refreshed = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshed) {
        setSettingsState(
          resolveSettingsOperationState("save-only", {
            saveSucceeded: true,
            refreshSucceeded: false
          })
        );
        setApplyError("配置已保存，但刷新观察失败；Active Runtime 未在本次仅保存操作中应用。");
        return;
      }
      const refreshedForm = settingsFormFromResponse(refreshed);
      const observationComparison = compareSettingsForms(
        persistedForm,
        refreshedForm,
        new Set(settingsSecretKeys)
      );
      if (observationComparison.mismatchedKeys.length === 0) {
        updateSavedBaseline(snapshot, refreshedForm);
      }
      const draftChangedDuringSave =
        settingsFingerprint(formRef.current, clearedSecretsRef.current) !==
        settingsFingerprint(snapshot);
      const restartRequired =
        response.restartRequired || refreshed.restartRequired || refreshed.runtime.pendingRestart;
      setSettingsState(
        resolveSettingsOperationState("save-only", {
          saveSucceeded: true,
          refreshSucceeded: true,
          restartRequired,
          draftChangedDuringOperation: draftChangedDuringSave
        })
      );
      if (!draftChangedDuringSave) {
        setClearedSecrets(new Set());
      }
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      if (stage === "save") {
        setSaveError(caught instanceof Error ? caught.message : "保存配置失败");
      } else {
        setApplyError("配置已保存，但刷新观察失败；Active Runtime 未在本次仅保存操作中应用。");
      }
    } finally {
      if (operationIsCurrent(operation)) setSaving(false);
    }
  }

  async function reloadCurrentConfig(): Promise<void> {
    if (operationBusy) return;
    if (draftDirty && !window.confirm("当前有未保存更改，重新载入会丢弃草稿。继续吗？")) return;
    const operation = beginOperation();
    setApplying(true);
    setSettingsState("refreshing");
    try {
      const refreshed = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshed) {
        setSettingsState("failed");
        setApplyError("重新载入配置失败。");
        return;
      }
      const next = settingsFormFromResponse(refreshed);
      setForm(next);
      setLoadedForm(next);
      setClearedSecrets(new Set());
      setSettingsState("clean");
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      setApplyError(caught instanceof Error ? caught.message : "重新载入配置失败");
    } finally {
      if (operationIsCurrent(operation)) setApplying(false);
    }
  }

  async function verify(capability: ProviderCapability): Promise<void> {
    setVerifying(capability);
    setVerification(null);
    const configOnly = capability === "tts" || capability === "stt" || capability === "vision";
    try {
      const result = await apiClient.verifyProvider(capability);
      if (mountedRef.current) setVerification(result);
    } catch (caught) {
      if (mountedRef.current) {
        setVerification({
          ok: false,
          provider: "unknown",
          capability,
          mock: false,
          ...(configOnly ? { configOnly: true as const } : {}),
          verificationMode: configOnly ? "config_only" : "live",
          error: caught instanceof Error ? caught.message : "Provider 验证失败"
        });
      }
    } finally {
      // Status reads are local/cache-only and let the settings summaries show
      // any observation recorded by an explicit live verification.
      void settings.refresh();
      if (mountedRef.current) setVerifying(null);
    }
  }

  async function deepRestart(): Promise<void> {
    if (
      !window.confirm(
        "Restart the local runtime, reload env files, and possibly run db:migrate? This is dev-only."
      )
    ) {
      return;
    }
    setRestartBusy(true);
    setRestartResult(null);
    setRestartError(null);
    try {
      const response = await apiClient.deepRestartRuntime();
      if (mountedRef.current) setRestartResult(response.message);
    } catch (caught) {
      if (mountedRef.current) setRestartError(deepRestartErrorMessage(caught));
    } finally {
      if (mountedRef.current) setRestartBusy(false);
    }
  }

  const activeChat = settings.data?.providers.deepseek.status?.chat;
  const activeReasoning = settings.data?.providers.deepseek.status?.reasoning;
  const savedDeepSeekButRuntimeMock =
    Boolean(settings.data?.providers.deepseek.apiKeyConfigured) && activeChat?.mock === true;
  const savedConfigDiffersFromActive =
    savedDeepSeekButRuntimeMock ||
    Boolean(
      settings.data &&
        (settings.data.runtime.serverHost !== settings.data.activeRuntimeConfig.serverHost ||
          settings.data.runtime.serverPort !== settings.data.activeRuntimeConfig.serverPort ||
          normalizeRuntimeSettingForComparison("EVENT_BUS", settings.data.runtime.eventBus) !==
            normalizeRuntimeSettingForComparison(
              "EVENT_BUS",
              settings.data.activeRuntimeConfig.eventBus
            ) ||
          normalizeRuntimeSettingForComparison(
            "MEMORY_REPOSITORY",
            settings.data.memory.memoryRepository
          ) !==
            normalizeRuntimeSettingForComparison(
              "MEMORY_REPOSITORY",
              settings.data.activeRuntimeConfig.memoryRepository
            ) ||
          (settings.data.memory.memoryExtractor !== undefined &&
            settings.data.activeRuntimeConfig.memoryExtractor !== undefined &&
            settings.data.memory.memoryExtractor !==
              settings.data.activeRuntimeConfig.memoryExtractor))
    );
  const configLayerKeys = [
    "SERVER_HOST",
    "SERVER_PORT",
    "EVENT_BUS",
    "PROVIDER_ALLOW_MOCKS",
    "DEFAULT_CHAT_PROVIDER",
    "DEFAULT_REASONING_PROVIDER",
    "MEMORY_REPOSITORY",
    "DATABASE_URL",
    "MEMORY_EXTRACTOR",
    "DEEPSEEK_API_BASEURL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_CHAT_MODEL",
    "DEEPSEEK_REASONING_MODEL",
    "OPENAI_COMPATIBLE_API_BASEURL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_CHAT_MODEL",
    "OPENAI_COMPATIBLE_REASONING_MODEL",
    "XAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_API_KEY"
  ];
  const restartStatus = settings.data?.runtime.devSupervisor;
  const restartSupported = restartStatus?.restartSupported;
  const deepRestartDisabled =
    restartBusy ||
    settings.data?.runtime.runtimeMode === "production" ||
    restartSupported === false;
  const savedEffectiveRuntimeSummary = settings.data
    ? `${settings.data.runtime.serverHost}:${settings.data.runtime.serverPort} · event bus ${settings.data.runtime.eventBus} · memory ${settings.data.memory.memoryRepository}`
    : "unknown";
  const activeRuntimeSummary = settings.data
    ? `${settings.data.activeRuntimeConfig.serverHost}:${settings.data.activeRuntimeConfig.serverPort} · event bus ${settings.data.activeRuntimeConfig.eventBus} · memory ${settings.data.activeRuntimeConfig.memoryRepository}`
    : "unknown";
  const effectiveConfigKeyCount = Object.keys(settings.data?.effectiveConfig ?? {}).length;
  const pendingRestart = settings.data?.runtime.pendingRestart ?? false;

  function updateDashboardDevToken(value: string): void {
    setDashboardDevTokenState(value);
    apiClient.setDashboardDevToken(value.trim());
  }

  return (
    <PageShell title="Settings" subtitle="Local development runtime configuration.">
      {settings.loading && (
        <Notice tone="info" title="Loading" message="Fetching safe runtime settings." />
      )}
      {settings.error && (
        <Notice tone="error" title="Settings load failed" message={settings.error} />
      )}
      <Panel title="Settings truth">
        <div className="grid grid-cols-3 gap-3">
          <Definition
            label="Draft (editor only)"
            value={draftDirty ? "Unsaved changes" : "No unsaved changes"}
          />
          <Definition
            label="Saved / effective configuration"
            value={
              settings.data ? `effectiveConfig · ${effectiveConfigKeyCount} safe keys` : "unknown"
            }
          />
          <Definition label="Active Runtime" value="activeRuntimeConfig" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm leading-6 text-ink-600">
          <p>
            Saved / effective:{" "}
            <span className="font-mono text-ink-700">{savedEffectiveRuntimeSummary}</span>
          </p>
          <p>
            Active Runtime: <span className="font-mono text-ink-700">{activeRuntimeSummary}</span>
          </p>
        </div>
        <p className="mt-2 text-xs leading-5 text-ink-500">
          Draft values exist only in this editor. Saved / effective values come from the layered
          .env and .env.local configuration; Active Runtime values come from the running Runtime
          snapshot. They can differ until Save &amp; Apply or Deep Restart completes.
        </p>
        {pendingRestart && (
          <Notice
            tone="info"
            title="Restart evidence"
            message="Saved / effective configuration contains a pending restart difference; Active Runtime has not converged for those settings."
          />
        )}
      </Panel>
      {draftDirty && (
        <Notice
          tone="info"
          title={settingsStateLabels.dirty}
          message="草稿尚未保存到 .env.local。"
        />
      )}
      {settingsState === "saving" && (
        <Notice tone="info" title={settingsStateLabels.saving} message="正在保存配置草稿。" />
      )}
      {settingsState === "reloading" && (
        <Notice
          tone="info"
          title={settingsStateLabels.reloading}
          message="正在将配置应用到 Runtime。"
        />
      )}
      {settingsState === "refreshing" && (
        <Notice
          tone="info"
          title={settingsStateLabels.refreshing}
          message="正在重新读取配置以确认生效。"
        />
      )}
      {settingsState === "saved-not-applied" && (
        <Notice
          tone="info"
          title={settingsStateLabels["saved-not-applied"]}
          message="配置已写入 .env.local，并在 saved / effective configuration 中确认；本次“仅保存”没有重新加载 Active Runtime。使用“保存并应用”或 Deep Restart 才会尝试让 Active Runtime 收敛。"
        />
      )}
      {settingsState === "applied" && (
        <Notice
          tone="info"
          title={settingsStateLabels.applied}
          message="保存、Runtime reload 和刷新确认均成功；本次保存快照已确认在 Active Runtime 中生效。"
        />
      )}
      {settingsState === "restart-required" && !applyError && (
        <Notice
          tone="info"
          title={settingsStateLabels["restart-required"]}
          message="Saved / effective configuration 已更新，但 Active Runtime 尚未应用需要重启的设置。请执行 Deep Restart。"
        />
      )}
      {saveError && <Notice tone="error" title="保存失败" message={saveError} />}
      {applyError && (
        <Notice
          tone="error"
          title={settingsState === "restart-required" ? "已保存，需要重启" : "应用失败"}
          message={applyError}
        />
      )}
      {restartError && <Notice tone="error" title="Deep restart failed" message={restartError} />}
      {restartResult && (
        <Notice tone="info" title="Deep restart requested" message={restartResult} />
      )}
      {saveResult && (
        <Notice
          tone="info"
          title={saveResult.mode === "save-only" ? "已保存（saved / effective）" : "保存阶段完成"}
          message={`${saveResult.changedKeys.length || 0} 项发生变化。${saveResult.mode === "save-only" ? "本次 Save Only 未应用到 Active Runtime。" : "Save & Apply 的 Active Runtime 结果以 Runtime 应用和刷新确认状态为准。"}${saveResult.restartRequired ? "部分配置需要重启。" : ""}`}
        />
      )}
      {applyResult && (
        <Notice
          tone="info"
          title="Runtime 应用结果"
          message={`${applyResult.message}${applyResult.notHotReloaded.length ? `；需要重启：${applyResult.notHotReloaded.join(", ")}` : ""}`}
        />
      )}
      {savedDeepSeekButRuntimeMock && (
        <Notice
          tone="info"
          title="已保存但尚未生效"
          message="DeepSeek 配置已保存，但当前 Runtime 仍是 mock。请点击“保存并应用”或重启服务。"
        />
      )}
      {savedConfigDiffersFromActive && (
        <Notice
          tone="info"
          title="Saved / effective 与 Active Runtime 不一致"
          message="配置已写入 .env.local，但 activeRuntimeConfig 仍显示不同值。请点击“保存并应用”重新加载可热更新配置；记忆或服务边界变更需要 Deep Restart。"
        />
      )}
      <div className="grid grid-cols-2 gap-4">
        <Panel title="Runtime">
          <SettingsInput form={form} name="SERVER_HOST" setForm={setForm} />
          <SettingsInput form={form} name="SERVER_PORT" setForm={setForm} />
          <SettingsInput form={form} name="EVENT_BUS" setForm={setForm} />
          <SettingsInput form={form} name="PROVIDER_ALLOW_MOCKS" setForm={setForm} />
          <Definition
            label="Runtime mode"
            value={settings.data?.runtime.runtimeMode ?? "unknown"}
          />
          <Definition
            label="Mock fallback allowed"
            value={settings.data?.runtime.providerAllowMocks ? "true" : "false"}
          />
          <Field label="X-YUVI-Dev-Token">
            <input
              className="field"
              type="password"
              value={dashboardDevToken}
              autoComplete="off"
              onChange={(event) => updateDashboardDevToken(event.target.value)}
              placeholder="Local dashboard token"
            />
          </Field>
          <p className="text-xs leading-5 text-ink-500">
            Stored only in this browser session and sent as a header for protected local POST,
            PATCH, and DELETE requests.
          </p>
          <p className="text-xs leading-5 text-ink-500">
            Active Runtime (activeRuntimeConfig):{" "}
            {settings.data?.runtime.activeServerHost ?? "unknown"}:
            {settings.data?.runtime.activeServerPort ?? "unknown"} · event bus{" "}
            {settings.data?.runtime.activeEventBus ?? "unknown"}
          </p>
          <div className="mt-4 rounded-md border border-ink-100 bg-ink-50 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Definition
                label="Supervisor active"
                value={settings.data?.runtime.devSupervisor?.active ? "true" : "false"}
              />
              <Definition
                label="Auto migrate"
                value={settings.data?.runtime.devSupervisor?.autoMigrate ? "true" : "false"}
              />
              <Definition
                label="Restart supported"
                value={settings.data?.runtime.devSupervisor?.restartSupported ? "true" : "false"}
              />
              <Definition
                label="Env dir"
                value={settings.data?.runtime.devSupervisor?.runtimeEnvDir ?? "unknown"}
              />
            </div>
          </div>
          {settings.data?.runtime.pendingRestart && (
            <Notice
              tone="info"
              title="Restart required"
              message=".env.local contains pending overrides. Restart the dev server for active runtime values to match."
            />
          )}
        </Panel>
        <Panel title="Memory">
          <Field label="MEMORY_REPOSITORY">
            <select
              className="field"
              value={form.MEMORY_REPOSITORY}
              onChange={(event) => setFormValue(setForm, "MEMORY_REPOSITORY", event.target.value)}
            >
              <option value="in-memory">in-memory</option>
              <option value="postgres">postgres</option>
            </select>
          </Field>
          <p className="mt-3 text-sm leading-6 text-ink-600">
            Active mode: {settings.data?.memory.activeMemoryRepository ?? "unknown"}. in-memory
            resets on server restart. postgres requires DATABASE_URL and pnpm db:migrate.
          </p>
          {form.MEMORY_REPOSITORY === "postgres" && (
            <Notice
              tone="info"
              title="Postgres reminder"
              message="This change is config-only for now. Restart the server after ensuring DATABASE_URL is set and migrations have been applied."
            />
          )}
          <SecretInput
            label="DATABASE_URL"
            configured={settings.data?.memory.databaseUrlConfigured}
            preview={undefined}
            value={form.DATABASE_URL}
            onChange={(value) => setFormValue(setForm, "DATABASE_URL", value)}
            onClear={() => clearSecretField("DATABASE_URL")}
          />
          <div className="mt-4 border-t border-ink-100 pt-4">
            <Field label="MEMORY_EXTRACTOR">
              <select
                className="field"
                value={form.MEMORY_EXTRACTOR}
                onChange={(event) => setFormValue(setForm, "MEMORY_EXTRACTOR", event.target.value)}
              >
                <option value="llm">llm - recommended/default</option>
                <option value="rule-based">rule-based - no token usage</option>
              </select>
            </Field>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              llm uses DeepSeek Reasoning for higher-quality memory candidates and may consume
              tokens only when Write Memory is ON. rule-based is simpler and never consumes model
              tokens.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Definition
                label="Saved extractor"
                value={settings.data?.memory.memoryExtractor ?? "llm"}
              />
              <Definition
                label="Active extractor"
                value={`${settings.data?.memory.activeMemoryExtractor ?? "unknown"} / ${settings.data?.memory.memoryExtractorActive ?? "unknown"}`}
              />
              <Definition
                label="Reasoning configured"
                value={settings.data?.memory.reasoningProviderConfigured ? "yes" : "no"}
              />
              <Definition
                label="Fallback used"
                value={settings.data?.memory.memoryExtractorFallbackUsed ? "true" : "false"}
              />
            </div>
            {form.MEMORY_EXTRACTOR === "llm" &&
              settings.data?.memory.reasoningProviderConfigured === false && (
                <Notice
                  tone="info"
                  title="Reasoning provider not configured"
                  message="LLM extractor is selected, but DeepSeek Reasoning is not configured. YUVI will fall back to rule-based extraction without crashing normal chat."
                />
              )}
            {settings.data?.memory.memoryExtractorSkippedReason && (
              <Notice
                tone="info"
                title="Extractor note"
                message={settings.data.memory.memoryExtractorSkippedReason}
              />
            )}
            {(settings.data?.memory.memoryExtractorFallbackUsed ||
              (settings.data?.memory.memoryExtractorValidationIssues?.length ?? 0) > 0) && (
              <div className="mt-3 rounded-md border border-ink-100 bg-ink-50 p-3">
                <h4 className="text-sm font-semibold text-ink-800">Extractor diagnostics</h4>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {settings.data?.memory.memoryExtractorFailureStage && (
                    <Definition
                      label="Failure stage"
                      value={settings.data.memory.memoryExtractorFailureStage}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorFinishReason && (
                    <Definition
                      label="Finish reason"
                      value={settings.data.memory.memoryExtractorFinishReason}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorSelectedOutputSource && (
                    <Definition
                      label="Selected output"
                      value={settings.data.memory.memoryExtractorSelectedOutputSource}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorAnswerLength !== undefined && (
                    <Definition
                      label="Answer length"
                      value={String(settings.data.memory.memoryExtractorAnswerLength)}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorReasoningLength !== undefined && (
                    <Definition
                      label="Reasoning length"
                      value={String(settings.data.memory.memoryExtractorReasoningLength)}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorLastAttemptAt && (
                    <Definition
                      label="Last attempt"
                      value={settings.data.memory.memoryExtractorLastAttemptAt}
                    />
                  )}
                </div>
                {settings.data?.memory.memoryExtractorValidationIssues &&
                  settings.data.memory.memoryExtractorValidationIssues.length > 0 && (
                    <p className="mt-2 text-sm leading-6 text-ink-600">
                      Validation issues:{" "}
                      {settings.data.memory.memoryExtractorValidationIssues.join("; ")}
                    </p>
                  )}
                {settings.data?.memory.memoryExtractorRawPreview && (
                  <p className="mt-2 break-all text-sm leading-6 text-ink-600">
                    Raw preview: {settings.data.memory.memoryExtractorRawPreview}
                  </p>
                )}
              </div>
            )}
          </div>
        </Panel>
      </div>
      <Panel title="Active Runtime" badge="activeRuntimeConfig">
        <p className="mb-3 text-sm leading-6 text-ink-600">
          These values describe the running Runtime, not the editor draft or saved / effective
          configuration.
        </p>
        <div className="grid grid-cols-5 gap-3">
          <Definition label="Chat Provider" value={activeChat?.provider ?? "unknown"} />
          <Definition label="Chat Model" value={activeChat?.model ?? "unknown"} />
          <Definition
            label="Chat Mode"
            value={activeChat ? (activeChat.mock ? "mock" : "real") : "unknown"}
          />
          <Definition
            label="Reasoning"
            value={
              activeReasoning
                ? `${activeReasoning.provider} / ${activeReasoning.mock ? "mock" : "real"}`
                : "unknown"
            }
          />
          <Definition
            label="Memory Repository"
            value={settings.data?.activeRuntimeConfig.memoryRepository ?? "unknown"}
          />
          <Definition
            label="Memory Extractor"
            value={`${settings.data?.activeRuntimeConfig.memoryExtractor ?? "unknown"} / ${settings.data?.activeRuntimeConfig.memoryExtractorActive ?? "unknown"}`}
          />
        </div>
      </Panel>
      <Panel title="Developer Tools / Deep Restart" badge="Development only">
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-ink-800">Save &amp; Apply / 保存并应用</h3>
            <ul className="space-y-1 text-sm leading-6 text-ink-600">
              <li>Save Only / 仅保存 updates saved / effective configuration only.</li>
              <li>Reloads supported runtime config in-process.</li>
              <li>Does not restart the server.</li>
              <li>Does not run migrations.</li>
            </ul>
          </div>
          <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-ink-800">Deep Restart</h3>
            <ul className="space-y-1 text-sm leading-6 text-ink-600">
              <li>Fully restarts the supervised local runtime.</li>
              <li>Reloads .env and .env.local.</li>
              <li>May run pnpm db:migrate when Postgres mode is active.</li>
              <li>Requires YUVI_DEV_SUPERVISOR=1.</li>
            </ul>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Definition label="Supervisor active" value={restartStatus?.active ? "true" : "false"} />
          <Definition label="Auto migrate" value={restartStatus?.autoMigrate ? "true" : "false"} />
          <Definition
            label="Restart supported"
            value={restartSupported === undefined ? "unknown" : restartSupported ? "true" : "false"}
          />
          <Definition label="Runtime env dir" value={restartStatus?.runtimeEnvDir ?? "unknown"} />
          <Definition
            label="Memory repository"
            value={settings.data?.memory.activeMemoryRepository ?? "unknown"}
          />
          <Definition
            label="Database configured"
            value={settings.data?.memory.databaseUrlConfigured ? "true" : "false"}
          />
        </div>
        <Notice
          tone="info"
          title="Deep Restart Runtime"
          message="Deep Restart reloads .env/.env.local, may run pnpm db:migrate, and restarts the local supervised runtime. Development only."
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            className="button-primary"
            type="button"
            disabled={deepRestartDisabled}
            onClick={() => void deepRestart()}
          >
            {restartBusy ? "Requesting Restart" : "Deep Restart Runtime"}
          </button>
          {restartSupported === false && (
            <span className="text-sm text-ink-500">
              Start with: YUVI_DEV_SUPERVISOR=1 ./scripts/dev.sh
            </span>
          )}
        </div>
      </Panel>
      <Panel title="Saved / Effective Configuration" badge="layered settings">
        <Notice
          tone="info"
          title="Saved / effective source"
          message=".env.local overrides .env. Dashboard writes to .env.local for safety and does not modify .env automatically. The effective column is the saved configuration source; it is separate from Active Runtime."
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Definition
            label="Base .env"
            value={
              settings.data?.configFiles[".env"].exists
                ? "exists / git ignored"
                : "missing / git ignored"
            }
          />
          <Definition
            label="Local override .env.local"
            value={
              settings.data?.configFiles[".env.local"].exists
                ? "exists / git ignored"
                : "missing / git ignored"
            }
          />
        </div>
        <div className="mt-4 max-h-[340px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-500">
              <tr>
                <th className="px-2 py-2">Key</th>
                <th className="px-2 py-2">Base .env</th>
                <th className="px-2 py-2">Local override .env.local</th>
                <th className="px-2 py-2">Effective value</th>
                <th className="px-2 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {configLayerKeys.map((key) => (
                <ConfigLayerRow key={key} name={key} setting={settings.data?.settings[key]} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Model Priority Chains" badge="Provider fallback">
        <div className="grid grid-cols-3 gap-3">
          <SettingsInput form={form} name="DEFAULT_CHAT_PROVIDER" setForm={setForm} />
          <SettingsInput form={form} name="DEFAULT_REASONING_PROVIDER" setForm={setForm} />
          <SettingsInput form={form} name="CHAT_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="REASONING_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="TTS_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="STT_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="VISION_PROVIDER_CHAIN" setForm={setForm} />
        </div>
        <p className="mt-3 text-sm leading-6 text-ink-600">
          Provider chains are tried left to right. Mock is ignored unless PROVIDER_ALLOW_MOCKS=true.
          保存并应用会重新加载可热更新的 Runtime 配置；Deep Restart 会重启受监管的 Runtime。
        </p>
      </Panel>
      <Notice
        tone="info"
        title="Provider diagnostics"
        message="Local readiness is a configuration check, not proof that a provider is reachable. Cached observation comes only from an explicit live check. Chat, reasoning, and embedding controls below perform provider I/O and may be billable; TTS, STT, and Vision controls are config-only and make no provider call."
      />
      <div className="grid grid-cols-3 gap-4">
        <Panel
          title="DeepSeek"
          actions={
            <div className="flex gap-2">
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("chat")}
              >
                {verifying === "chat" ? "Live verifying Chat" : "Live verify Chat"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("reasoning")}
              >
                {verifying === "reasoning" ? "Live verifying Reasoning" : "Live verify Reasoning"}
              </button>
            </div>
          }
        >
          <SettingsInput form={form} name="DEEPSEEK_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="DEEPSEEK_API_KEY"
            configured={settings.data?.providers.deepseek.apiKeyConfigured}
            preview={settings.data?.providers.deepseek.apiKeyPreview}
            value={form.DEEPSEEK_API_KEY}
            onChange={(value) => setFormValue(setForm, "DEEPSEEK_API_KEY", value)}
            onClear={() => clearSecretField("DEEPSEEK_API_KEY")}
          />
          <SettingsInput form={form} name="DEEPSEEK_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="DEEPSEEK_REASONING_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="Chat"
            health={settings.data?.activeRuntimeConfig.providers.chat}
          />
          <ProviderDiagnosticsSummary
            label="Reasoning"
            health={settings.data?.activeRuntimeConfig.providers.reasoning}
          />
        </Panel>
        <Panel title="OpenAI-compatible" badge="Chat + Cognition">
          <SettingsInput form={form} name="OPENAI_COMPATIBLE_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="OPENAI_COMPATIBLE_API_KEY"
            configured={settings.data?.providers.openaiCompatible.apiKeyConfigured}
            preview={settings.data?.providers.openaiCompatible.apiKeyPreview}
            value={form.OPENAI_COMPATIBLE_API_KEY}
            onChange={(value) => setFormValue(setForm, "OPENAI_COMPATIBLE_API_KEY", value)}
            onClear={() => clearSecretField("OPENAI_COMPATIBLE_API_KEY")}
          />
          <SettingsInput form={form} name="OPENAI_COMPATIBLE_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="OPENAI_COMPATIBLE_REASONING_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="Chat"
            health={settings.data?.providers.openaiCompatible.status?.chat}
          />
          <ProviderDiagnosticsSummary
            label="Cognition"
            health={settings.data?.providers.openaiCompatible.status?.reasoning}
          />
        </Panel>
        <Panel title="xAI" badge="Optional · TTS and Vision implemented">
          <SettingsInput form={form} name="XAI_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="XAI_API_KEY"
            configured={settings.data?.providers.xai.apiKeyConfigured}
            preview={settings.data?.providers.xai.apiKeyPreview}
            value={form.XAI_API_KEY}
            onChange={(value) => setFormValue(setForm, "XAI_API_KEY", value)}
            onClear={() => clearSecretField("XAI_API_KEY")}
          />
          <SettingsInput form={form} name="XAI_TTS_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="XAI_TTS_VOICE" setForm={setForm} />
          <SettingsInput form={form} name="XAI_VISION_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="TTS (optional)"
            health={settings.data?.activeRuntimeConfig.providers.tts}
          />
          <ProviderDiagnosticsSummary
            label="Vision (optional)"
            health={settings.data?.activeRuntimeConfig.providers.vision}
          />
        </Panel>
        <Panel title="NVIDIA API" badge="OpenAI-compatible v1">
          <SettingsInput form={form} name="NVIDIA_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="NVIDIA_API_KEY"
            configured={secretSettingConfigured(settings.data, "NVIDIA_API_KEY")}
            preview={secretSettingPreview(settings.data, "NVIDIA_API_KEY")}
            value={form.NVIDIA_API_KEY}
            onChange={(value) => setFormValue(setForm, "NVIDIA_API_KEY", value)}
            onClear={() => clearSecretField("NVIDIA_API_KEY")}
          />
          <SettingsInput form={form} name="NVIDIA_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_REASONING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_VISION_MODEL" setForm={setForm} />
        </Panel>
        <Panel title="Local Models" badge="OpenAI-compatible">
          <SettingsInput form={form} name="LOCAL_MODEL_BASEURL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_REASONING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_TTS_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_STT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_VISION_MODEL" setForm={setForm} />
        </Panel>
        <Panel
          title="DashScope / Embedding"
          badge="DashScope STT optional · implemented"
          actions={
            <div className="flex flex-wrap gap-2">
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("embedding")}
              >
                {verifying === "embedding" ? "Live verifying Embedding" : "Live verify Embedding"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("stt")}
              >
                {verifying === "stt" ? "Inspecting STT config" : "Inspect STT config"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("tts")}
              >
                {verifying === "tts" ? "Inspecting TTS config" : "Inspect TTS config"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("vision")}
              >
                {verifying === "vision" ? "Inspecting Vision config" : "Inspect Vision config"}
              </button>
            </div>
          }
        >
          <SettingsInput form={form} name="DASHSCOPE_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="DASHSCOPE_API_KEY"
            configured={settings.data?.providers.dashscope.apiKeyConfigured}
            preview={settings.data?.providers.dashscope.apiKeyPreview}
            value={form.DASHSCOPE_API_KEY}
            onChange={(value) => setFormValue(setForm, "DASHSCOPE_API_KEY", value)}
            onClear={() => clearSecretField("DASHSCOPE_API_KEY")}
          />
          <SettingsInput form={form} name="DASHSCOPE_STT_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="STT (optional)"
            health={settings.data?.activeRuntimeConfig.providers.stt}
          />
          <SettingsInput form={form} name="EMBEDDING_PROVIDER" setForm={setForm} />
          <div className="rounded-md border border-ink-100 bg-ink-50 p-2 text-xs text-ink-600">
            Local readiness:{" "}
            {providerReadinessLabel(settings.data?.providers.embedding.status?.readiness)} · Cached
            observation:{" "}
            {providerObservationLabel(settings.data?.providers.embedding.status?.observed)} · mode:{" "}
            {settings.data?.providers.embedding.status?.mode ?? "unknown"} · mock:{" "}
            {String(settings.data?.providers.embedding.status?.mock ?? false)} · dimensions:{" "}
            {settings.data?.providers.embedding.status?.dimensions ??
              (settings.data?.providers.embedding.dimensions || "unknown")}
            {" · semantic: "}
            {String(settings.data?.providers.embedding.status?.semanticEmbedding ?? false)}
            {settings.data?.providers.embedding.status?.semanticEmbedding === false && (
              <div className="mt-1 text-amber-700">
                {settings.data.providers.embedding.status.embeddingNote ??
                  "Mock embeddings validate the pipeline but do not provide real semantic similarity."}
              </div>
            )}
            {settings.data?.providers.embedding.status?.missingFields?.length ? (
              <div className="mt-1 text-rose-700">
                Missing: {settings.data.providers.embedding.status.missingFields.join(", ")}
              </div>
            ) : null}
            {embeddingSettingsHint(settings.data?.providers.embedding.status)}
          </div>
          <SettingsInput form={form} name="EMBEDDING_API_BASEURL" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SecretInput
            label="EMBEDDING_API_KEY"
            configured={settings.data?.providers.embedding.apiKeyConfigured}
            preview={settings.data?.providers.embedding.apiKeyPreview}
            value={form.EMBEDDING_API_KEY}
            onChange={(value) => setFormValue(setForm, "EMBEDDING_API_KEY", value)}
            onClear={() => clearSecretField("EMBEDDING_API_KEY")}
          />
        </Panel>
      </div>
      {verification && <ProviderVerificationResult result={verification} />}
      <div className="flex justify-end gap-3">
        <button
          className="button-secondary"
          disabled={operationBusy}
          onClick={() => void reloadCurrentConfig()}
        >
          {applying ? "正在重新载入" : "重新载入当前配置"}
        </button>
        <button
          className="button-secondary"
          disabled={operationBusy || !draftDirty}
          onClick={() => {
            if (loadedForm) {
              setForm(loadedForm);
              setClearedSecrets(new Set());
              setSettingsState("clean");
            }
          }}
        >
          重置草稿
        </button>
        <button
          className="button-secondary"
          disabled={operationBusy}
          onClick={() => void saveOnly()}
        >
          {saving ? "正在保存" : "仅保存"}
        </button>
        <button
          className="button-primary"
          disabled={operationBusy}
          onClick={() => void saveAndApply()}
        >
          {saving ? "正在保存" : applying ? "正在应用" : "保存并应用"}
        </button>
      </div>
    </PageShell>
  );
}

type SettingsForm = Record<SettingsKey, string>;

type SettingsKey =
  | "SERVER_HOST"
  | "SERVER_PORT"
  | "EVENT_BUS"
  | "PROVIDER_ALLOW_MOCKS"
  | "DEFAULT_CHAT_PROVIDER"
  | "DEFAULT_REASONING_PROVIDER"
  | "MEMORY_REPOSITORY"
  | "DATABASE_URL"
  | "MEMORY_EXTRACTOR"
  | "CHAT_PROVIDER_CHAIN"
  | "REASONING_PROVIDER_CHAIN"
  | "EMBEDDING_PROVIDER_CHAIN"
  | "TTS_PROVIDER_CHAIN"
  | "STT_PROVIDER_CHAIN"
  | "VISION_PROVIDER_CHAIN"
  | "DEEPSEEK_API_BASEURL"
  | "DEEPSEEK_API_KEY"
  | "DEEPSEEK_CHAT_MODEL"
  | "DEEPSEEK_REASONING_MODEL"
  | "OPENAI_COMPATIBLE_API_BASEURL"
  | "OPENAI_COMPATIBLE_API_KEY"
  | "OPENAI_COMPATIBLE_CHAT_MODEL"
  | "OPENAI_COMPATIBLE_REASONING_MODEL"
  | "NVIDIA_API_BASEURL"
  | "NVIDIA_API_KEY"
  | "NVIDIA_CHAT_MODEL"
  | "NVIDIA_REASONING_MODEL"
  | "NVIDIA_EMBEDDING_MODEL"
  | "NVIDIA_EMBEDDING_DIMENSIONS"
  | "NVIDIA_VISION_MODEL"
  | "LOCAL_MODEL_BASEURL"
  | "LOCAL_CHAT_MODEL"
  | "LOCAL_REASONING_MODEL"
  | "LOCAL_EMBEDDING_MODEL"
  | "LOCAL_EMBEDDING_DIMENSIONS"
  | "LOCAL_TTS_MODEL"
  | "LOCAL_STT_MODEL"
  | "LOCAL_VISION_MODEL"
  | "XAI_API_BASEURL"
  | "XAI_API_KEY"
  | "XAI_TTS_MODEL"
  | "XAI_TTS_VOICE"
  | "XAI_VISION_MODEL"
  | "DASHSCOPE_API_BASEURL"
  | "DASHSCOPE_API_KEY"
  | "DASHSCOPE_STT_MODEL"
  | "EMBEDDING_PROVIDER"
  | "EMBEDDING_API_BASEURL"
  | "EMBEDDING_API_KEY"
  | "EMBEDDING_MODEL"
  | "EMBEDDING_DIMENSIONS";

const settingsSecretKeys: SettingsKey[] = [
  "DATABASE_URL",
  "DEEPSEEK_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "NVIDIA_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "EMBEDDING_API_KEY"
];

function emptySettingsForm(): SettingsForm {
  return {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "6121",
    EVENT_BUS: "in-memory",
    PROVIDER_ALLOW_MOCKS: "false",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    DEFAULT_REASONING_PROVIDER: "openai-compatible",
    MEMORY_REPOSITORY: "in-memory",
    DATABASE_URL: "",
    MEMORY_EXTRACTOR: "llm",
    CHAT_PROVIDER_CHAIN: "deepseek,nvidia,local,mock",
    REASONING_PROVIDER_CHAIN: "deepseek,nvidia,local,mock",
    EMBEDDING_PROVIDER_CHAIN: "openai-compatible,nvidia,local,mock",
    TTS_PROVIDER_CHAIN: "xai,local,mock",
    STT_PROVIDER_CHAIN: "dashscope,local,mock",
    VISION_PROVIDER_CHAIN: "xai,nvidia,local,mock",
    DEEPSEEK_API_BASEURL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: "",
    DEEPSEEK_REASONING_MODEL: "",
    OPENAI_COMPATIBLE_API_BASEURL: "https://api.deepinfra.com/v1/openai",
    OPENAI_COMPATIBLE_API_KEY: "",
    OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
    OPENAI_COMPATIBLE_REASONING_MODEL: "glm-4.7-flash",
    NVIDIA_API_BASEURL: "https://integrate.api.nvidia.com/v1",
    NVIDIA_API_KEY: "",
    NVIDIA_CHAT_MODEL: "",
    NVIDIA_REASONING_MODEL: "",
    NVIDIA_EMBEDDING_MODEL: "",
    NVIDIA_EMBEDDING_DIMENSIONS: "1536",
    NVIDIA_VISION_MODEL: "",
    LOCAL_MODEL_BASEURL: "",
    LOCAL_CHAT_MODEL: "",
    LOCAL_REASONING_MODEL: "",
    LOCAL_EMBEDDING_MODEL: "",
    LOCAL_EMBEDDING_DIMENSIONS: "1536",
    LOCAL_TTS_MODEL: "",
    LOCAL_STT_MODEL: "",
    LOCAL_VISION_MODEL: "",
    XAI_API_BASEURL: "",
    XAI_API_KEY: "",
    XAI_TTS_MODEL: "",
    XAI_TTS_VOICE: "",
    XAI_VISION_MODEL: "",
    DASHSCOPE_API_BASEURL: "",
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_STT_MODEL: "",
    EMBEDDING_PROVIDER: "openai-compatible",
    EMBEDDING_API_BASEURL: "",
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: "",
    EMBEDDING_DIMENSIONS: "1536"
  };
}

function settingsFormFromResponse(settings: RuntimeSettingsResponse): SettingsForm {
  return {
    SERVER_HOST: settings.runtime.serverHost,
    SERVER_PORT: String(settings.runtime.serverPort),
    EVENT_BUS: settings.runtime.eventBus,
    PROVIDER_ALLOW_MOCKS: settings.runtime.providerAllowMocks ? "true" : "false",
    DEFAULT_CHAT_PROVIDER: runtimeSetting(settings, "DEFAULT_CHAT_PROVIDER"),
    DEFAULT_REASONING_PROVIDER: runtimeSetting(settings, "DEFAULT_REASONING_PROVIDER"),
    MEMORY_REPOSITORY: settings.memory.memoryRepository,
    DATABASE_URL: "",
    MEMORY_EXTRACTOR: settings.memory.memoryExtractor ?? "llm",
    CHAT_PROVIDER_CHAIN: runtimeSetting(settings, "CHAT_PROVIDER_CHAIN"),
    REASONING_PROVIDER_CHAIN: runtimeSetting(settings, "REASONING_PROVIDER_CHAIN"),
    EMBEDDING_PROVIDER_CHAIN: runtimeSetting(settings, "EMBEDDING_PROVIDER_CHAIN"),
    TTS_PROVIDER_CHAIN: runtimeSetting(settings, "TTS_PROVIDER_CHAIN"),
    STT_PROVIDER_CHAIN: runtimeSetting(settings, "STT_PROVIDER_CHAIN"),
    VISION_PROVIDER_CHAIN: runtimeSetting(settings, "VISION_PROVIDER_CHAIN"),
    DEEPSEEK_API_BASEURL: settings.providers.deepseek.baseUrl,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: settings.providers.deepseek.chatModel,
    DEEPSEEK_REASONING_MODEL: settings.providers.deepseek.reasoningModel,
    OPENAI_COMPATIBLE_API_BASEURL: settings.providers.openaiCompatible.baseUrl,
    OPENAI_COMPATIBLE_API_KEY: "",
    OPENAI_COMPATIBLE_CHAT_MODEL: settings.providers.openaiCompatible.chatModel,
    OPENAI_COMPATIBLE_REASONING_MODEL: settings.providers.openaiCompatible.reasoningModel,
    NVIDIA_API_BASEURL: runtimeSetting(settings, "NVIDIA_API_BASEURL"),
    NVIDIA_API_KEY: "",
    NVIDIA_CHAT_MODEL: runtimeSetting(settings, "NVIDIA_CHAT_MODEL"),
    NVIDIA_REASONING_MODEL: runtimeSetting(settings, "NVIDIA_REASONING_MODEL"),
    NVIDIA_EMBEDDING_MODEL: runtimeSetting(settings, "NVIDIA_EMBEDDING_MODEL"),
    NVIDIA_EMBEDDING_DIMENSIONS: runtimeSetting(settings, "NVIDIA_EMBEDDING_DIMENSIONS"),
    NVIDIA_VISION_MODEL: runtimeSetting(settings, "NVIDIA_VISION_MODEL"),
    LOCAL_MODEL_BASEURL: runtimeSetting(settings, "LOCAL_MODEL_BASEURL"),
    LOCAL_CHAT_MODEL: runtimeSetting(settings, "LOCAL_CHAT_MODEL"),
    LOCAL_REASONING_MODEL: runtimeSetting(settings, "LOCAL_REASONING_MODEL"),
    LOCAL_EMBEDDING_MODEL: runtimeSetting(settings, "LOCAL_EMBEDDING_MODEL"),
    LOCAL_EMBEDDING_DIMENSIONS: runtimeSetting(settings, "LOCAL_EMBEDDING_DIMENSIONS"),
    LOCAL_TTS_MODEL: runtimeSetting(settings, "LOCAL_TTS_MODEL"),
    LOCAL_STT_MODEL: runtimeSetting(settings, "LOCAL_STT_MODEL"),
    LOCAL_VISION_MODEL: runtimeSetting(settings, "LOCAL_VISION_MODEL"),
    XAI_API_BASEURL: settings.providers.xai.baseUrl,
    XAI_API_KEY: "",
    XAI_TTS_MODEL: settings.providers.xai.ttsModel,
    XAI_TTS_VOICE: settings.providers.xai.ttsVoice,
    XAI_VISION_MODEL: settings.providers.xai.visionModel,
    DASHSCOPE_API_BASEURL: settings.providers.dashscope.baseUrl,
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_STT_MODEL: settings.providers.dashscope.sttModel,
    EMBEDDING_PROVIDER: settings.providers.embedding.provider,
    EMBEDDING_API_BASEURL: settings.providers.embedding.baseUrl,
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: settings.providers.embedding.model,
    EMBEDDING_DIMENSIONS: settings.providers.embedding.dimensions
  };
}

function runtimeSetting(settings: RuntimeSettingsResponse, key: string): string {
  const setting = settings.settings[key];
  const value = setting && "effective" in setting ? setting.effective : "";
  return typeof value === "string" ? value : "";
}

function secretSettingConfigured(
  settings: RuntimeSettingsResponse | null | undefined,
  key: string
): boolean {
  const setting = settings?.settings[key];
  return Boolean(setting && "effectiveConfigured" in setting && setting.effectiveConfigured);
}

function secretSettingPreview(
  settings: RuntimeSettingsResponse | null | undefined,
  key: string
): string | undefined {
  const setting = settings?.settings[key];
  return setting && "maskedValue" in setting ? setting.maskedValue : undefined;
}

function setFormValue(
  setForm: Dispatch<SetStateAction<SettingsForm>>,
  key: SettingsKey,
  value: string
): void {
  setForm((current) => ({ ...current, [key]: value }));
}

function clearSecret(
  setForm: Dispatch<SetStateAction<SettingsForm>>,
  setClearedSecrets: Dispatch<SetStateAction<Set<SettingsKey>>>,
  key: SettingsKey
): void {
  setFormValue(setForm, key, "");
  setClearedSecrets((current) => new Set([...current, key]));
}

function buildSettingsUpdate(
  form: SettingsForm,
  clearedSecrets: Set<SettingsKey>
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(form) as Array<[SettingsKey, string]>) {
    if (isSecretSettingsKey(key) && value === "" && !clearedSecrets.has(key)) {
      continue;
    }
    values[key] = value;
  }
  return values;
}

function isSecretSettingsKey(key: SettingsKey): boolean {
  return (
    key === "DEEPSEEK_API_KEY" ||
    key === "OPENAI_COMPATIBLE_API_KEY" ||
    key === "DATABASE_URL" ||
    key === "NVIDIA_API_KEY" ||
    key === "XAI_API_KEY" ||
    key === "DASHSCOPE_API_KEY" ||
    key === "EMBEDDING_API_KEY"
  );
}

function SettingsInput(props: {
  form: SettingsForm;
  name: SettingsKey;
  setForm: Dispatch<SetStateAction<SettingsForm>>;
}): JSX.Element {
  return (
    <Field label={props.name}>
      <input
        className="field"
        value={props.form[props.name]}
        onChange={(event) => setFormValue(props.setForm, props.name, event.target.value)}
      />
    </Field>
  );
}

function SecretInput(props: {
  label: SettingsKey;
  configured: boolean | undefined;
  preview: string | undefined;
  value: string;
  onChange(value: string): void;
  onClear(): void;
}): JSX.Element {
  return (
    <Field label={props.label}>
      <div className="space-y-2">
        <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {props.configured ? (
            <span>
              Configured:{" "}
              <span className="font-mono text-ink-800">{props.preview ?? "••••••••••••"}</span>
            </span>
          ) : (
            "Not configured / 未配置"
          )}
        </div>
        <input
          className="field"
          type="password"
          placeholder={props.configured ? "Enter a new value to replace saved key" : "Enter key"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.configured && (
          <button className="button-secondary w-full" type="button" onClick={props.onClear}>
            Clear saved key on next save
          </button>
        )}
      </div>
    </Field>
  );
}

function ConfigLayerRow(props: { name: string; setting: LayeredSetting | undefined }): JSX.Element {
  const setting = props.setting;
  const isSecret = Boolean(setting && "effectiveConfigured" in setting);

  return (
    <tr className="border-t border-ink-100">
      <td className="px-2 py-2 font-mono text-ink-700">{props.name}</td>
      <td className="px-2 py-2">{setting ? formatLayerValue(setting, "base") : "unknown"}</td>
      <td className="px-2 py-2">
        {setting ? formatLayerValue(setting, "localOverride") : "unknown"}
      </td>
      <td className="px-2 py-2 font-medium text-ink-700">
        {setting ? formatLayerValue(setting, "effective") : "unknown"}
      </td>
      <td className="px-2 py-2">
        <span
          className={`rounded-full px-2 py-0.5 ${
            setting?.source === ".env.local"
              ? "bg-cyan-50 text-cyan-700"
              : "bg-ink-100 text-ink-600"
          }`}
        >
          {isSecret
            ? `${setting?.source ?? "unknown"} / secret masked`
            : (setting?.source ?? "unknown")}
        </span>
      </td>
    </tr>
  );
}

function formatLayerValue(
  setting: LayeredSetting,
  layer: "base" | "localOverride" | "effective"
): string {
  if ("effectiveConfigured" in setting) {
    const configured =
      layer === "base"
        ? setting.baseConfigured
        : layer === "localOverride"
          ? setting.localOverrideConfigured
          : setting.effectiveConfigured;
    if (!configured) {
      return "Not configured";
    }
    return layer === "effective" ? (setting.maskedValue ?? "Configured") : "Configured";
  }

  const value =
    layer === "base"
      ? setting.base
      : layer === "localOverride"
        ? setting.localOverride
        : setting.effective;
  return value || "Not set";
}

function ProviderDiagnosticsSummary(props: {
  label: string;
  health: ProviderHealth | undefined;
}): JSX.Element {
  return (
    <div className="mt-3 rounded-md border border-ink-100 bg-ink-50 p-2 text-xs text-ink-600">
      <div className="font-semibold text-ink-800">{props.label}</div>
      <div className="mt-1">Local readiness: {providerReadinessLabel(props.health?.readiness)}</div>
      <div className="mt-1">Cached observation: {cachedObservationDetail(props.health ?? {})}</div>
    </div>
  );
}

function embeddingSettingsHint(
  health: ProvidersStatusResponse["providers"]["embedding"] | undefined
): JSX.Element | null {
  if (!health) {
    return null;
  }
  if (health.mock) {
    return (
      <div className="mt-1 text-amber-700">
        Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity.
      </div>
    );
  }
  if (health.readiness === "not_ready") {
    return (
      <div className="mt-1 text-rose-700">
        OpenAI-compatible embedding provider is selected but not configured or unavailable. Fill
        EMBEDDING_API_BASEURL, EMBEDDING_API_KEY, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS, then
        Save and Apply Now.
      </div>
    );
  }
  if (health.configured && health.semanticEmbedding) {
    return (
      <div className="mt-1 text-emerald-700">
        Real embedding provider is locally configured. Run Live verify Embedding to record remote
        reachability, then run pnpm memory:embed:backfill for existing memories.
      </div>
    );
  }
  return null;
}
