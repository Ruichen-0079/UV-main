import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";
import { HealthPills } from "./HealthPills.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { productClient, type ProductOverview } from "./product-client.js";

export function ProductShell(props: {
  children: ReactNode;
  companionReady: boolean;
  onCompanion(action: "show_companion" | "hide_companion" | "reopen_companion"): void;
  events?: Array<{ id: string; type: string; timestamp?: string }>;
}): JSX.Element {
  const [overview, setOverview] = useState<ProductOverview | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  async function reload(): Promise<void> {
    const next = await productClient.overview();
    setOverview(next);
    document.documentElement.dataset["yuviTheme"] = next.preferences.appearance.theme;
  }

  useEffect(() => {
    void reload().catch(() => undefined);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setSettingsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="yuvi-shell">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-[var(--yuvi-line)] bg-[color-mix(in_srgb,var(--yuvi-bg)_92%,white)] px-4 py-3 backdrop-blur">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--yuvi-muted)]">YUVI</div>
          <div className="text-lg font-semibold">Companion</div>
        </div>
        {overview ? (
          <HealthPills items={overview.compactHealth} onOpenDiagnostics={() => setDiagnosticsOpen(true)} />
        ) : (
          <span className="text-xs text-[var(--yuvi-muted)]">Checking health…</span>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--yuvi-muted)]">
            {props.companionReady ? "Lumi connected" : "Lumi offline"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setCommandOpen(true)}>
            ⌘K
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDiagnosticsOpen(true)}>
            Diagnostics
          </Button>
          <Button size="sm" onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">{props.children}</main>

      {settingsOpen && overview ? (
        <div className="fixed inset-0 z-40 bg-black/20 p-4" role="dialog" aria-label="Settings">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 flex justify-end">
              <Button variant="secondary" onClick={() => setSettingsOpen(false)}>
                Close
              </Button>
            </div>
            <SettingsPanel overview={overview} onReload={reload} onCompanion={props.onCompanion} />
          </div>
        </div>
      ) : null}

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        health={overview?.compactHealth ?? []}
        events={props.events ?? []}
      />

      {commandOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-start bg-black/20 pt-24" onClick={() => setCommandOpen(false)}>
          <div
            className="w-full max-w-lg rounded-[18px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] p-3 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="px-2 pb-2 text-xs text-[var(--yuvi-muted)]">Command palette</p>
            {[
              ["Open settings", () => setSettingsOpen(true)],
              ["Open diagnostics", () => setDiagnosticsOpen(true)],
              ["Show Lumi", () => props.onCompanion("show_companion")],
              ["Hide Lumi", () => props.onCompanion("hide_companion")]
            ].map(([label, action]) => (
              <button
                key={String(label)}
                type="button"
                className="block w-full rounded-[12px] px-3 py-2 text-left text-sm hover:bg-[var(--yuvi-accent-soft)]"
                onClick={() => {
                  (action as () => void)();
                  setCommandOpen(false);
                }}
              >
                {label as string}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
