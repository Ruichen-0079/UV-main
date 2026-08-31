export const SETTINGS_SECTIONS = [
  "general",
  "providers",
  "routing",
  "voice",
  "vision",
  "memory",
  "mcp",
  "companion",
  "appearance",
  "advanced"
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export type ProductHashView = {
  surface: "dashboard" | "main" | "companion";
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  diagnosticsOpen: boolean;
  commandOpen: boolean;
  firstRunForced: boolean;
};

const SECTION_ALIASES: Record<string, SettingsSectionId> = {
  capabilities: "mcp",
  alice: "voice",
  models: "providers"
};

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function parseProductHash(hash: string): ProductHashView {
  const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
  const root = parts[0] ?? "main";
  if (root === "dashboard") {
    return {
      surface: "dashboard",
      settingsOpen: false,
      settingsSection: "general",
      diagnosticsOpen: false,
      commandOpen: false,
      firstRunForced: false
    };
  }
  if (root === "companion") {
    return {
      surface: "companion",
      settingsOpen: false,
      settingsSection: "general",
      diagnosticsOpen: false,
      commandOpen: false,
      firstRunForced: false
    };
  }

  const leaf = parts[1] ?? "";
  const sectionToken = parts[2] ?? "";
  const aliased = SECTION_ALIASES[sectionToken] ?? sectionToken;
  const settingsSection = isSettingsSectionId(aliased) ? aliased : "general";

  return {
    surface: "main",
    settingsOpen: leaf === "settings",
    settingsSection,
    diagnosticsOpen: leaf === "diagnostics",
    commandOpen: leaf === "palette",
    firstRunForced: leaf === "first-run"
  };
}

export function productHashFor(
  view: Pick<
    ProductHashView,
    | "surface"
    | "settingsOpen"
    | "settingsSection"
    | "diagnosticsOpen"
    | "commandOpen"
    | "firstRunForced"
  >
): string {
  if (view.surface === "dashboard") return "#/dashboard";
  if (view.surface === "companion") return "#/companion";
  if (view.firstRunForced) return "#/main/first-run";
  if (view.commandOpen) return "#/main/palette";
  if (view.diagnosticsOpen) return "#/main/diagnostics";
  if (view.settingsOpen) {
    return view.settingsSection === "general"
      ? "#/main/settings"
      : `#/main/settings/${view.settingsSection}`;
  }
  return "#/main";
}
