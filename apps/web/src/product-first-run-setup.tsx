import { apiClient, request, type Live2DModelState } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { t } from "./locale.js";

type FirstRunConfiguration = {
  configuration: {
    routes: {
      chat: string[];
    };
  };
};

export type FirstRunSetupState = {
  chatConfigured: boolean;
  companionInstalled: boolean;
  complete: boolean;
};

export function deriveFirstRunSetupState(
  product: FirstRunConfiguration,
  live2d: Pick<Live2DModelState, "models">
): FirstRunSetupState {
  const chatConfigured = product.configuration.routes.chat.length > 0;
  const companionInstalled = live2d.models.length > 0;
  return {
    chatConfigured,
    companionInstalled,
    complete: chatConfigured && companionInstalled
  };
}

export function ProductFirstRunSetup(props: {
  onNavigate(view: "advanced" | "appearance"): void;
}): JSX.Element | null {
  const state = useAsyncData(async (signal) => {
    const [product, live2d] = await Promise.all([
      request<FirstRunConfiguration>("/product/configuration", { signal }),
      apiClient.getLive2DModels(signal)
    ]);
    return deriveFirstRunSetupState(product, live2d);
  }, []);

  if (!state.data || state.data.complete) return null;

  return (
    <section className="yuvi-card grid gap-4" aria-label={t("First-run setup")}>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">
          {t("First-run setup")}
        </div>
        <h2 className="mb-0 mt-1 text-xl font-semibold">{t("Set up YUVI")}</h2>
        <p className="mb-0 mt-2 text-sm leading-6 text-[var(--yuvi-muted)]">
          {t("Only Chat and a Companion model are required to begin. Voice, Memory, Vision, and proactive features can stay unconfigured.")}
        </p>
      </div>

      <ol className="m-0 grid list-none gap-3 p-0">
        <li className="yuvi-card grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{t("1. Connect Chat")}</strong>
            <span>{state.data.chatConfigured ? t("Configured") : t("Required")}</span>
          </div>
          <p className="m-0 text-sm text-[var(--yuvi-muted)]">
            {state.data.chatConfigured
              ? t("A Chat route is configured. Current availability is shown by normal product health.")
              : t("Add a provider, model, and Chat route using the existing Advanced settings.")}
          </p>
          {!state.data.chatConfigured ? (
            <div>
              <button
                type="button"
                className="yuvi-product-action is-active"
                onClick={() => props.onNavigate("advanced")}
              >
                {t("Configure Chat")}
              </button>
            </div>
          ) : null}
        </li>

        <li className="yuvi-card grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{t("2. Choose Companion")}</strong>
            <span>{state.data.companionInstalled ? t("Installed") : t("Required")}</span>
          </div>
          <p className="m-0 text-sm text-[var(--yuvi-muted)]">
            {state.data.companionInstalled
              ? t("A Live2D model is installed. You can select or disable it later from Appearance.")
              : t("Import a Live2D / VTube Studio ZIP or choose an existing model in Appearance.")}
          </p>
          {!state.data.companionInstalled ? (
            <div>
              <button
                type="button"
                className="yuvi-product-action is-active"
                onClick={() => props.onNavigate("appearance")}
              >
                {t("Choose Companion model")}
              </button>
            </div>
          ) : null}
        </li>
      </ol>
    </section>
  );
}
