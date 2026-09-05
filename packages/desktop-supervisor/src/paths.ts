import path from "node:path";

const WINDOWS_DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;

/**
 * True when the string is a Windows absolute path (drive or UNC),
 * regardless of the host OS running the check.
 */
export function isWindowsStylePath(input: string): boolean {
  const trimmed = input.trim();
  return WINDOWS_DRIVE_ABS.test(trimmed) || WINDOWS_UNC.test(trimmed);
}

/**
 * Canonicalize a path for ownership comparisons.
 *
 * - Windows drive absolute (`C:\...`) and UNC (`\\server\...`) always use
 *   `path.win32` normalization so Ubuntu CI does not treat them as POSIX
 *   relative segments under process.cwd().
 * - Other paths use the host platform `path.resolve`.
 * - Trailing separators are stripped, except for roots (`C:\`, `/`).
 */
export function canonicalPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  if (isWindowsStylePath(trimmed)) {
    // Keep drive/UNC absolute; never resolve against POSIX cwd.
    let normalized = path.win32.normalize(trimmed.replaceAll("/", "\\"));
    // Drive root: C:\
    if (/^[A-Za-z]:\\$/.test(normalized)) {
      return normalized;
    }
    // UNC root-ish: \\server\share (do not collapse to empty)
    if (normalized.startsWith("\\\\")) {
      const stripped = normalized.replace(/\\+$/, "");
      return stripped.length >= 3 ? stripped : normalized;
    }
    return normalized.replace(/\\+$/, "");
  }

  try {
    const resolved = path.resolve(trimmed);
    const root = path.parse(resolved).root;
    if (resolved === root) {
      return resolved;
    }
    return resolved.replace(/[\\/]+$/, "") || resolved;
  } catch {
    if (trimmed === "/") return "/";
    return trimmed.replace(/[\\/]+$/, "") || trimmed;
  }
}

/**
 * Equality for ownership path fields.
 * Windows-style *inputs* compare case-insensitively; POSIX inputs keep case
 * semantics (even when the host resolves them onto a Windows drive letter).
 */
export function pathsEqual(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  // Case folding is driven by input style only — not by host resolve side effects.
  if (isWindowsStylePath(a) || isWindowsStylePath(b)) {
    return ca.toLowerCase() === cb.toLowerCase();
  }
  return ca === cb;
}

/**
 * Whether a process command line mentions `expectedPath`.
 * Slash style and quoting are normalized; Windows paths ignore case.
 * Does not depend on the host platform path module for the search itself.
 */
export function commandLineContainsPath(commandLine: string, expectedPath: string): boolean {
  const expected = canonicalPath(expectedPath);
  if (!expected) return false;

  const asWindows = isWindowsStylePath(expectedPath) || isWindowsStylePath(expected);
  const variants = pathSearchVariants(expected, asWindows);

  // Compare against both raw and de-quoted command lines.
  const haystacks = asWindows
    ? [commandLine.toLowerCase(), stripQuotes(commandLine).toLowerCase()]
    : [commandLine, stripQuotes(commandLine)];

  for (const hay of haystacks) {
    for (const variant of variants) {
      if (hay.includes(variant)) {
        return true;
      }
    }
  }
  return false;
}

function pathSearchVariants(canonical: string, asWindows: boolean): string[] {
  const base = asWindows ? canonical.toLowerCase() : canonical;
  const withSlash = base.replaceAll("\\", "/");
  const withBackslash = base.replaceAll("/", "\\");
  return [...new Set([base, withSlash, withBackslash])];
}

function stripQuotes(input: string): string {
  return input.replace(/"/g, "").replace(/'/g, "");
}

export function defaultStateDirectory(): string {
  const local = process.env["LOCALAPPDATA"];
  if (local && local.trim()) {
    return path.join(local, "YUVI", "DesktopSupervisor");
  }
  return path.join(process.cwd(), ".yuvi-desktop-supervisor");
}

export function parseUrlOrigin(url: string): { host: string; port: number; origin: string } | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!Number.isFinite(port)) return null;
    return {
      host: parsed.hostname || "127.0.0.1",
      port,
      origin: `${parsed.protocol}//${parsed.host}`
    };
  } catch {
    return null;
  }
}
