/** Audit a Linux public package for private/user leakage and required Local STT files. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LINUX_BUILD_ROOT } from "./prepare-linux-daily.mjs";
import { validateLocalSttArtifact } from "./build-local-stt.mjs";
import { REPO_ROOT } from "./constants.mjs";

const FORBIDDEN_NAME = [
  /(^|\/)\.env(?:\..*)?$/i,
  /\.(?:wav|py|pyi|h|hpp|spec|ts|tsx)$/i,
  /(^|\/)(?:state|controller-evidence)(\/|$)/i,
  /(^|\/)(?:product-settings|voice-review|voice-binding-references|p8-corrections)\.json$/i,
  /(^|\/)speakers\.(json|npz)$/i,
  /(^|\/)0-four-speakers-zh\.wav$/i,
  /(^|\/)dots\.tts(\/|$)/i,
  /(^|\/)dots-tts(\/|$)/i,
  /(^|\/)rei(\/|$)/i,
  /(^|\/)hf-cache(\/|$)/i,
  /(^|\/)\.venv(\/|$)/i,
  /(^|\/)(?:services|node_modules|tests?)(\/|$)/i,
  /(?:live2dcubismcore|hiyori|esbuild-metafile|\.moc3$|\.map$)/i
];

function listFiles(dir, out = [], root = fs.realpathSync(dir)) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(full);
      if (!target.startsWith(root + path.sep))
        throw new Error(`Artifact symlink escapes resources: ${entry.name}`);
    }
    if (entry.isDirectory()) listFiles(full, out, root);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function auditLinuxPublicArtifact(root = LINUX_BUILD_ROOT, options = {}) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`Linux package root missing: ${resolved}`);
  const files = listFiles(resolved);
  const rels = files.map((file) => path.relative(resolved, file).replaceAll("\\", "/"));
  for (const rel of rels) {
    if (FORBIDDEN_NAME.some((pattern) => pattern.test(rel)))
      throw new Error(`Forbidden path in Linux public artifact: ${rel}`);
  }
  const repoMarker = String(options.repoRoot ?? REPO_ROOT);
  for (const file of files) {
    const rel = path.relative(resolved, file).replaceAll("\\", "/");
    if (!/\.(json|md|txt|mjs|cjs|js|service|desktop)$/i.test(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes(repoMarker))
      throw new Error(`Repository path leaked into Linux public artifact: ${rel}`);
  }
  const localStt = path.join(resolved, "local-stt");
  const stt = validateLocalSttArtifact(localStt, { repoRoot: options.repoRoot ?? REPO_ROOT });
  for (const required of [
    "runtime/Node.LICENSE.txt",
    "runtime/THIRD_PARTY_NOTICES.runtime.json",
    "supervisor/THIRD_PARTY_NOTICES.supervisor.json",
    "web/dist/THIRD_PARTY_NOTICES.web.json",
    "web/dist/licenses/cubism-framework/LICENSE.md",
    "desktop/yuvi-desktop",
    "desktop/yuvi-desktop-launcher",
    "desktop/yuvi.png",
    "desktop/build-provenance.json",
    "local-stt/runtime-inventory.json"
  ]) {
    if (!fs.existsSync(path.join(resolved, required)))
      throw new Error(`Missing release notice inventory: ${required}`);
  }
  const notices = path.join(resolved, "THIRD_PARTY_NOTICES.local-stt.md");
  if (!fs.existsSync(notices)) throw new Error("Public Local STT notices file is missing.");
  if (rels.some((rel) => rel.startsWith("services/local-stt/")))
    throw new Error("Linux public artifact still contains Local STT adapter sources.");
  return {
    root: resolved,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
    localSttBytes: stt.bytes,
    localSttFiles: stt.files
  };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = auditLinuxPublicArtifact(process.argv[2] || LINUX_BUILD_ROOT);
    console.info(
      `[linux-public-audit] ${result.files} files, ${result.bytes} bytes; local-stt ${result.localSttFiles} files, ${result.localSttBytes} bytes`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
