/** Produce installer and portable from one already validated immutable resource tree. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { auditLinuxAbi } from "./audit-linux-abi.mjs";
import { auditLinuxPublicArtifact } from "./audit-linux-public-artifact.mjs";
import { LINUX_BUILD_ROOT } from "./prepare-linux-daily.mjs";
const root = path.resolve(process.argv[2] || LINUX_BUILD_ROOT);
const output = path.resolve(process.argv[3] || path.join(root, "..", "release"));
auditLinuxPublicArtifact(root);
auditLinuxAbi(root);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "install-manifest.json"), "utf8"));
if (!/^[a-f0-9]{40}$/.test(manifest.checkoutSha)) throw new Error("Missing source identity.");
fs.mkdirSync(output, { recursive: true });
const portable = path.join(output, "YUVI-v0.1.0-linux-x64-portable.tar.gz");
execFileSync("tar", ["-czf", portable, "-C", root, "."]);
const archive = fs.readFileSync(portable);
const hash = createHash("sha256").update(archive).digest("hex");
const installer = path.join(output, "YUVI-v0.1.0-linux-x64-installer.run");
const header = `#!/bin/sh
set -eu
umask 077
base="\${YUVI_INSTALL_ROOT:-\${HOME}/.local/lib/YUVI}"
case "$base" in /*) ;; *) echo 'Install root must be absolute.' >&2; exit 1;; esac
release="$base/releases/${manifest.checkoutSha}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
line=$(awk '/^__YUVI_ARCHIVE_BELOW__$/ {print NR + 1; exit}' "$0")
tail -n +"$line" "$0" > "$tmp/resources.tar.gz"
printf '%s  %s\\n' '${hash}' "$tmp/resources.tar.gz" | sha256sum -c -
# Stop the installed instance before replacing its immutable resources.
if systemctl --user is-active --quiet yuvi-daily.service; then
  systemctl --user stop yuvi-daily.service yuvi-daily-web.service
fi
mkdir -p "$release"
tar -xzf "$tmp/resources.tar.gz" -C "$release"
"$release/runtime/node" "$release/install-linux-daily.mjs"
echo "Installed YUVI. Start with: systemctl --user start yuvi-daily.service"
echo "Uninstall integration with: $release/runtime/node $release/install-linux-daily.mjs --uninstall"
exit 0
__YUVI_ARCHIVE_BELOW__
`;
fs.writeFileSync(installer, Buffer.concat([Buffer.from(header), archive]), { mode: 0o755 });
const artifacts = [installer, portable].map(file => ({ file: path.basename(file), bytes: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
fs.writeFileSync(path.join(output, "artifacts.json"), JSON.stringify({ checkoutSha: manifest.checkoutSha, artifacts }, null, 2) + "\n");
console.log(JSON.stringify(artifacts, null, 2));
