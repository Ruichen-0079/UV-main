/** Produce deterministic release archives from one validated resource tree. */
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
const abi = auditLinuxAbi(root);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "install-manifest.json"), "utf8"));
if (!/^[a-f0-9]{40}$/.test(manifest.checkoutSha)) throw new Error("Missing source identity.");
const epoch = execFileSync("git", ["show", "-s", "--format=%ct", manifest.checkoutSha], {
  encoding: "utf8"
}).trim();
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const files = fs
  .readdirSync(root, { recursive: true })
  .map(String)
  .sort()
  .filter((name) => fs.statSync(path.join(root, name)).isFile() && name !== "release-sbom.json");
const sbom = {
  schemaVersion: 1,
  checkoutSha: manifest.checkoutSha,
  platform: "linux-x64",
  abi,
  noticeInventories: files.filter((name) =>
    /THIRD_PARTY_NOTICES|runtime-inventory|models\.manifest|Node\.LICENSE/.test(name)
  ),
  files: files.map((name) => ({
    path: name,
    bytes: fs.statSync(path.join(root, name)).size,
    sha256: sha256(path.join(root, name))
  }))
};
fs.writeFileSync(path.join(root, "release-sbom.json"), JSON.stringify(sbom, null, 2) + "\n");
fs.mkdirSync(output, { recursive: true });
const portable = path.join(output, "yuvi-v0.1.0-linux-x64-portable.tar.zst");
execFileSync("tar", [
  "--sort=name",
  `--mtime=@${epoch}`,
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--mode=u+rwX,go+rX,go-w",
  "--format=gnu",
  "--use-compress-program=zstd -10 -T1",
  "-cf",
  portable,
  "-C",
  root,
  "."
]);
const archive = fs.readFileSync(portable);
const hash = sha256(portable);
const installer = path.join(output, "yuvi-v0.1.0-linux-x64-installer.run");
const header = `#!/bin/sh
set -eu
umask 077
base="\${YUVI_INSTALL_ROOT:-\${HOME}/.local/lib/YUVI}"
case "$base" in /*) ;; *) echo 'Install root must be absolute.' >&2; exit 1;; esac
if [ "\${1:-}" = --uninstall ]; then
  exec "$base/current/runtime/node" "$base/current/install-linux-daily.mjs" --uninstall
fi
release="$base/releases/${manifest.checkoutSha}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
line=$(awk '/^__YUVI_ARCHIVE_BELOW__$/ {print NR + 1; exit}' "$0")
tail -n +"$line" "$0" > "$tmp/resources.tar.zst"
printf '%s  %s\\n' '${hash}' "$tmp/resources.tar.zst" | sha256sum -c -
if systemctl --user is-active --quiet yuvi-daily.service; then
  systemctl --user stop yuvi-daily.service yuvi-daily-web.service
fi
mkdir -p "$release"
tar --zstd -xf "$tmp/resources.tar.zst" -C "$release"
"$release/runtime/node" "$release/install-linux-daily.mjs" --managed-install
ln -sfn "releases/${manifest.checkoutSha}" "$base/current"
echo "Installed YUVI. Start with: systemctl --user start yuvi-daily.service"
echo "Uninstall with: $0 --uninstall"
exit 0
__YUVI_ARCHIVE_BELOW__
`;
fs.writeFileSync(installer, Buffer.concat([Buffer.from(header), archive]), { mode: 0o755 });
const artifacts = [installer, portable].map((file) => ({
  file: path.basename(file),
  bytes: fs.statSync(file).size,
  sha256: sha256(file)
}));
fs.writeFileSync(
  path.join(output, "artifacts.json"),
  JSON.stringify({ checkoutSha: manifest.checkoutSha, artifacts }, null, 2) + "\n"
);
fs.writeFileSync(
  path.join(output, "SHA256SUMS"),
  artifacts.map((a) => `${a.sha256}  ${a.file}\n`).join("")
);
console.log(JSON.stringify(artifacts, null, 2));
