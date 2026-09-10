# Live2D Cubism Core provisioning

Updated: 2026-09-10

YUVI uses the open-source Cubism SDK for Web Framework separately from Live2D Cubism Core. Cubism Core is proprietary software and is **not** committed to this repository or embedded in YUVI's public Linux release artifacts by default.

## Release disposition

The project reviewed these official Live2D sources for A10:

- Proprietary Software License Agreement: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- Cubism SDK Release License / Publication License guidance: https://www.live2d.com/en/sdk/license/
- Cubism Core manual: https://docs.live2d.com/en/cubism-sdk-manual/cubism-core-api-reference/
- Official Cubism SDK for Web download: https://www.live2d.com/en/sdk/download/web/

The Proprietary Software License Agreement permits redistribution only within its licensed redistribution/publication conditions, including the files designated by Live2D as redistributable. Live2D's publication guidance also treats an "Expandable Application" as a special case requiring review and a Publication License rather than relying on the ordinary individual/small-scale exemption.

YUVI lets users import additional Live2D model packages. The repository does not contain evidence of a Live2D Publication License or other written approval covering YUVI's public release distribution. A10 therefore takes the conservative release position: **do not redistribute Cubism Core in the public YUVI artifact until the applicable Live2D publication/redistribution permission for YUVI is documented.** This is a project compliance disposition, not legal advice.

The public-artifact audit deliberately rejects `live2dcubismcore.min.js`, so an accidental Core copy cannot silently enter a GitHub release.

## Deterministic user provisioning

Obtain the official Cubism SDK for Web from Live2D and locate the file named exactly:

```text
live2dcubismcore.min.js
```

YUVI does not download, scrape, mirror, or select a substitute Core at runtime. The provisioning command validates that the input is a non-empty regular file with the exact expected name, copies it atomically into YUVI's durable data root, records a SHA-256/provenance receipt without retaining the original source path, and lets the existing DesktopSupervisor/Runtime resolver discover that managed copy after restart.

### Portable Linux

From the extracted Portable package:

```sh
./yuvi cubism-core import /absolute/path/to/live2dcubismcore.min.js
./yuvi cubism-core status
./yuvi stop
./yuvi start
```

The managed copy is stored under the same version-isolated Portable data namespace established by the package identity:

```text
~/.local/share/YUVI/portable/<version>/data/CubismCore/live2dcubismcore.min.js
```

`YUVI_PORTABLE_STATE_ROOT` continues to be the explicit exact-root operator override. Portable provisioning never scans or borrows Installed YUVI state or another Portable version.

### Installed Linux

For a managed Installed release, run the provisioner with the packaged Node binary:

```sh
~/.local/lib/YUVI/current/runtime/node \
  ~/.local/lib/YUVI/current/provision-cubism-core.mjs \
  --from /absolute/path/to/live2dcubismcore.min.js
systemctl --user restart yuvi-daily.service
```

The normal Linux destination is:

```text
~/.local/share/YUVI/CubismCore/live2dcubismcore.min.js
```

If the installation intentionally uses another absolute YUVI data root, pass the same root to the provisioner with `--data-root /absolute/path`.

## Runtime verification

After restart, verify the existing Product proxy serves the managed Core rather than a machine-random path. For Installed Linux:

```sh
curl -f http://127.0.0.1:5173/api/live2d-core/live2dcubismcore.min.js >/dev/null
```

For Portable Linux, use its own Product origin instead of Installed ports:

```sh
curl -f http://127.0.0.1:15173/api/live2d-core/live2dcubismcore.min.js >/dev/null
```

The Product proxy strips `/api` and forwards to the matching Runtime's existing `/live2d-core/live2dcubismcore.min.js` route.

A complete product acceptance still requires all of the following on a machine where the user has legitimately obtained the official Core and a valid model package:

1. Core endpoint returns HTTP 200.
2. A valid Live2D ZIP imports successfully.
3. The imported model becomes the active selection.
4. Companion renderer transitions through loading to `ready`.

A missing Core is an explicit prerequisite failure; YUVI must not silently claim renderer readiness or perform a runtime network download.
