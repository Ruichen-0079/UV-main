# -*- mode: python ; coding: utf-8 -*-
"""YUVI local STT Windows/Linux x64 onedir spec."""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


PACKAGING_DIR = Path(
    os.environ.get("YUVI_LOCAL_STT_SPEC_DIR", str(Path.cwd() / "packaging"))
).resolve()
SERVICE_ROOT = PACKAGING_DIR.parent
ENTRY = SERVICE_ROOT / "server.py"

sherpa_datas, sherpa_binaries, sherpa_hiddenimports = collect_all("sherpa_onnx")
# Python modules are already in the executable archive; SDK headers are build-only.
sherpa_datas = [(source, dest) for source, dest in sherpa_datas
                if Path(source).suffix not in {".py", ".pyi", ".h", ".hpp"}]
hiddenimports = [
    *sherpa_hiddenimports,
    "numpy",
    "speaker_store",
    *collect_submodules("numpy._core"),
]

a = Analysis(
    [str(ENTRY)],
    pathex=[str(SERVICE_ROOT)],
    binaries=sherpa_binaries,
    datas=sherpa_datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pkg_resources", "setuptools", "backports", "readline"],
    noarchive=False,
    optimize=0,
)
# Never redistribute build-host GCC/zlib binaries (rolling distros may require
# newer glibc or CPU ISA). Use the supported distro's standard runtime libraries.
if os.name != "nt":
    system_runtime = {"libstdc++.so.6", "libgcc_s.so.1", "libz.so.1"}
    a.binaries = [entry for entry in a.binaries if Path(entry[0]).name not in system_runtime]
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="yuvi-local-stt",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="local-stt",
)
