# Linux release procedure

Use a clean checkout of the final merged main commit. Root `package.json` is the
product version authority; desktop npm, Tauri and Cargo versions must agree.
Internal private package versions and historical release evidence are independent.

The trusted local build remains the release authority. GitHub Check and Linux
Persistence gate the PR; a generic hosted runner must not replace the Debian
rootfs or bypass its native dependency inventory. No release workflow is added.

Prepare a Debian 12 rootfs with CPython 3.11 from the official Python Bookworm
image recorded in `../future/astra5-linux-release-evidence.md`, and Debian
build-essential, pkg-config, binutils, libwebkit2gtk-4.1-dev,
libayatana-appindicator3-dev, librsvg2-dev, libxdo-dev, libssl-dev and libsecret-1-dev.
Provide a Rust toolchain and a populated Cargo cache matching Cargo.lock.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm smoke
cargo test --locked --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
export YUVI_LINUX_BUILD_ROOTFS=/absolute/path/to/debian12-rootfs
node scripts/desktop-package/prepare-linux-baseline.mjs
node scripts/desktop-package/build-linux-desktop.mjs
export YUVI_PYTHON311="$PWD/scripts/desktop-package/linux-baseline-python.mjs"
pnpm desktop:package:linux-daily
node scripts/desktop-package/audit-linux-public-artifact.mjs
node scripts/desktop-package/audit-linux-abi.mjs build/desktop/linux-x64
node scripts/desktop-package/package-linux-release.mjs
```

`YUVI_RELEASE_CARGO_HOME` optionally selects the populated Cargo cache.
The desktop build uses Debian libraries, the locked Cargo dependency graph and
Tauri's custom protocol. Its receipt binds the binary hash to commit and version.
Packaging rejects dirty sources, mismatched versions and mismatched shell receipts.
The existing locked STT wheel, license, privacy and ABI audits remain mandatory.

Test the exact packaged installer and portable archive using isolated CONFIG/DATA
and service ownership; check real KDE window/tray behavior and appearance. Verify
reinstall/uninstall preserve durable user data, portable relocation works, and
shutdown leaves no owned processes. Never validate by replacing the user's live
installation. Repeat deterministic packaging and compare hashes before publication.

Tag the validated final main SHA, then attach the installer, portable archive,
SHA256SUMS, artifacts.json and release-sbom.json to the GitHub Release. The SBOM
also lives inside each package. Keep private acceptance logs outside public assets.
