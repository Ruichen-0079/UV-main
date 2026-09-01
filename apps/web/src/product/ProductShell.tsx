import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";
import { HealthPills } from "./HealthPills.js";
import { parseProductHash, productHashFor, type ProductHashView } from "./product-hash.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { productClient, type ProductOverview } from "./product-client.js";

function currentHashView(): ProductHashView {
  const hash = typeof window === "undefined" ? "" : (window.location?.hash ?? "");
  return parseProductHash(hash);
}

function writeMainHash(view: ProductHashView): void {
  if (typeof window === "undefined" || !window.location) return;
  if (view.surface !== "main") return;
  const next = productHashFor(view);
  if (window.location.hash !== next) {
    const path = window.location.pathname ?? "";
    const search = window.location.search ?? "";
    history.replaceState(null, "", `${path}${search}${next}`);
  }
}

export function ProductShell(props: {
  children: ReactNode;
  companionReady: boolean;
  onCompanion(action: "show_companion" | "hide_companion" | "reopen_companion"): void;
  events?: Array<{ id: string; type: string; timestamp?: string }>;
}): JSX.Element {
  const [overview, setOverview] = useState<ProductOverview | null>(null);
  const [hashView, setHashView] = useState<ProductHashView>(currentHashView);
  const [firstRunOpen, setFirstRunOpen] = useState(false);

  const settingsOpen = hashView.settingsOpen;
  const diagnosticsOpen = hashView.diagnosticsOpen;
  const commandOpen = hashView.commandOpen;

  function setMainView(
    patch: Partial<Omit<ProductHashView, "surface">> & { firstRunOpen?: boolean }
  ): void {
    const { firstRunOpen: firstRunFlag, ...hashPatch } = patch;
    const next: ProductHashView = {
      ...hashView,
      surface: "main",
      ...hashPatch
    };
    setHashView(next);
    writeMainHash(next);
    if (firstRunFlag === false) setFirstRunOpen(false);
  }

  async function reload(): Promise<void> {
    const next = await productClient.overview();
    setOverview(next);
    document.documentElement.dataset["yuviTheme"] = next.preferences.appearance.theme;
    if (!next.preferences.firstRun.completed && !next.preferences.firstRun.skipped) {
      setFirstRunOpen(true);
    }
  }

  useEffect(() => {
    void reload().catch(() => undefined);
  }, []);

  useEffect(() => {
    function onHash() {
      setHashView(currentHashView());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMainView({
          commandOpen: !commandOpen,
          settingsOpen: false,
          diagnosticsOpen: false,
          firstRunForced: false
        });
      }
      if (event.key === "Escape") {
        setMainView({
          commandOpen: false,
          settingsOpen: false,
          diagnosticsOpen: false,
          firstRunForced: false,
          firstRunOpen: false
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commandOpen, hashView]);

  const showFirstRun = firstRunOpen || hashView.firstRunForced;

  return (
    <div className="yuvi-shell">
      <header className="yuvi-topbar">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--yuvi-muted)]">
            YUVI
          </div>
          <div className="truncate text-base font-semibold leading-tight">Companion</div>
        </div>
        {overview ? (
          <HealthPills
            items={overview.compactHealth}
            onOpenDiagnostics={() =>
              setMainView({ diagnosticsOpen: true, settingsOpen: false, commandOpen: false })
            }
          />
        ) : (
          <span className="text-xs text-[var(--yuvi-muted)]">Checking health…</span>
        )}
        <div className="yuvi-topbar-actions">
          <span className="hidden text-xs text-[var(--yuvi-muted)] sm:inline">
            {props.companionReady ? "Lumi connected" : "Lumi offline"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setMainView({ commandOpen: true })}>
            ⌘K
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setMainView({ diagnosticsOpen: true, settingsOpen: false, commandOpen: false })
            }
          >
            Diagnostics
          </Button>
          <Button
            size="sm"
            onClick={() =>
              setMainView({
                settingsOpen: true,
                settingsSection: "general",
                diagnosticsOpen: false,
                commandOpen: false
              })
            }
          >
            Settings
          </Button>
        </div>
      </header>

      <main className="yuvi-shell-main">{props.children}</main>

      {settingsOpen ? (
        <div className="yuvi-settings-overlay" role="dialog" aria-label="Settings">
          {overview ? (
            <SettingsPanel
              overview={overview}
              section={hashView.settingsSection}
              onSection={(section) => setMainView({ settingsOpen: true, settingsSection: section })}
              onClose={() => setMainView({ settingsOpen: false })}
              onReload={reload}
              onCompanion={props.onCompanion}
            />
          ) : (
            <div className="yuvi-settings">
              <div className="yuvi-settings-body">
                <p className="text-sm text-[var(--yuvi-muted)]">Loading settings…</p>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onClose={() => setMainView({ diagnosticsOpen: false })}
        health={overview?.compactHealth ?? []}
        events={props.events ?? []}
      />

      {showFirstRun ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"
          role="dialog"
          aria-label="First run"
        >
          <div className="yuvi-dialog max-w-md">
            <h2 className="text-xl font-semibold">Set up YUVI</h2>
            <p className="mt-2 text-sm text-[var(--yuvi-muted)]">
              You can configure chat, voice, and Memory from Settings. Nothing here creates an
              account. Skip anytime.
            </p>
            <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
              <li>Add a Character provider</li>
              <li>Optionally connect Cognition and Voice</li>
              <li>Check Memory backend health</li>
            </ol>
            <div className="mt-5 flex gap-2">
              <Button
                onClick={() => {
                  setFirstRunOpen(false);
                  setMainView({
                    settingsOpen: true,
                    settingsSection: "providers",
                    firstRunForced: false,
                    firstRunOpen: false
                  });
                  void productClient.savePreferences({ firstRun: { completed: true } });
                }}
              >
                Open settings
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setFirstRunOpen(false);
                  setMainView({ firstRunForced: false, firstRunOpen: false });
                  void productClient.savePreferences({ firstRun: { skipped: true } });
                }}
              >
                Skip
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {commandOpen ? (
        <div className="yuvi-palette-overlay" onClick={() => setMainView({ commandOpen: false })}>
          <div className="yuvi-palette" onClick={(event) => event.stopPropagation()}>
            <p className="px-2 pb-2 text-xs text-[var(--yuvi-muted)]">Command palette</p>
            {(
              [
                [
                  "Open settings",
                  () =>
                    setMainView({
                      settingsOpen: true,
                      settingsSection: "general",
                      commandOpen: false
                    })
                ],
                [
                  "Memory",
                  () =>
                    setMainView({
                      settingsOpen: true,
                      settingsSection: "memory",
                      commandOpen: false
                    })
                ],
                [
                  "Capabilities",
                  () =>
                    setMainView({ settingsOpen: true, settingsSection: "mcp", commandOpen: false })
                ],
                [
                  "Open diagnostics",
                  () =>
                    setMainView({ diagnosticsOpen: true, commandOpen: false, settingsOpen: false })
                ],
                [
                  "Developer dashboard",
                  () => {
                    window.location.hash = "#/dashboard";
                  }
                ],
                [
                  "Show Lumi",
                  () => {
                    props.onCompanion("show_companion");
                    setMainView({ commandOpen: false });
                  }
                ],
                [
                  "Hide Lumi",
                  () => {
                    props.onCompanion("hide_companion");
                    setMainView({ commandOpen: false });
                  }
                ]
              ] as Array<[string, () => void]>
            ).map(([label, action]) => (
              <button
                key={label}
                type="button"
                className="block w-full rounded-[12px] px-3 py-2 text-left text-sm hover:bg-[var(--yuvi-accent-soft)]"
                onClick={action}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
