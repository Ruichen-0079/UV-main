# Astra 5 Linux release closure

Continuation of `release/astra5-v0.1.0`, preserving checkpoints `944b10d` and
`7498eee`. Astra 1–3 interpretation contracts are unchanged.

## Trusted binding authority

Explicit VoiceProfile → Person binding uses `LocalControllerEvidenceProvider`
through `getVoiceBindingProvider()`. General Memory continues through
`getMemoryProvider()`, including optional Mem0. Backend reloads reconstruct the
same local evidence store under Runtime DATA. The reference JSON is only an
index. Corruption, superseded evidence, conflicting assignments, invalid scopes,
and unrelated writes fail closed. Tests cover durable IDs across Mem0 on/off.

## Debian build provenance

The build root is Debian 12, glibc 2.36, with CPython 3.11.16 from the official
Python Bookworm image, manifest
`sha256:b1add8a6f2aca6bcfcf0b9c9b522352f7ce0d62a3d556a2f2f32511aa0cca250`.
Runtime CPython native inputs were byte-compared with a
separate clean extraction of that image. Previously copied host site-packages
are excluded by a fresh venv (`include-system-site-packages = false`).

`services/local-stt/packaging/linux-wheels.lock.json` records the actual PyPI
wheel URLs and SHA256 values. Dependencies are installed inside Debian with
`--force-reinstall --require-hashes`. PyInstaller also runs inside Debian.
Every shipped STT ELF is matched by SHA256 to a wheel RECORD, CPython, or a
Debian package. Unknown native inputs fail the build. The final ABI audit
rejects GLIBC requirements above 2.36.

```sh
export YUVI_LINUX_BUILD_ROOTFS=/absolute/path/to/debian12-rootfs
node scripts/desktop-package/prepare-linux-baseline.mjs
export YUVI_PYTHON311="$PWD/scripts/desktop-package/linux-baseline-python.mjs"
pnpm desktop:package:linux-daily
node scripts/desktop-package/audit-linux-public-artifact.mjs
node scripts/desktop-package/package-linux-release.mjs
```

The prepared rootfs needs CPython 3.11, venv/pip, binutils, and Debian runtime
libraries. An optional `/opt/yuvi-release-wheels` directory allows offline
installation of the locked wheels. No system Python is required by the product.

## Candidate real voice gate

Public LibriSpeech A1–A3 were enrolled through Product → LocalSTTProvider →
packaged STT. Fresh CONFIG/DATA reported seven NOT_CONFIGURED routes, and opening
voice metadata left STT stopped. Provider + Model + Chat enabled conversational
readiness. Enrollment was observed starting a Supervisor lease; release stopped
STT with no configured STT route.

Full restart in Debian restored Person, VoiceProfile and trusted binding. A4
matched the same profile; speaker B remained NO_MATCH. Mixed A/B audio produced
two diarization clusters, cluster-scoped results, and no whole-capture match.
The identical candidate repeated these voice/restart results on CachyOS.
The Debian execution hid system Python and mounted only product resources and
isolated user DATA. Fixtures and recordings stay outside public artifacts.

## Redistribution inventory

Runtime/Supervisor esbuild inputs and rendered WebUI modules generate actual
bundled JS dependency notices. Node's distribution LICENSE is included.
Local STT inventories record hashes and native origin, with Python, PyInstaller,
NumPy/OpenBLAS/GCC, sherpa-onnx, ONNX Runtime, ALSA and Debian library notices.
Existing SenseVoice/FunASR, 3D-Speaker, pyannote and Silero notices are preserved.
Cubism Web Framework notices are preserved; Cubism Core and proprietary sample
assets are excluded. The official provisioning seam remains.

Archive creation writes `release-sbom.json`, normalizes tar metadata, uses one
compression thread, and emits `SHA256SUMS`. Packaging completion and final merged
source identity must be recorded only after the remaining acceptance/CI gates.

## Installer and portable acceptance

Candidate `bfe03c0` passed real systemd user-manager installation in an isolated
network/filesystem namespace, with system Python masked and no checkout mounted.
First-run, public-fixture enrollment, reinstall, restart match, uninstall,
CONFIG/DATA retention and zero Runtime/WebUI/STT listeners all passed.

The portable archive passed extract → run → rename → run → move → run with
spaces and Chinese characters, read-only package mounts and external DATA.
Each run included real voice identity checks. Deleting the extracted package
preserved Person, VoiceProfile and binding evidence. Portable execution created
no systemd units or desktop entries. The existing installed YUVI was unaffected.

The final installer additionally removes retained managed versions on uninstall;
unrecognized directories are not removed. Source/privacy auditing rejects source
files, environment files, biometric state and escaping resource symlinks.
