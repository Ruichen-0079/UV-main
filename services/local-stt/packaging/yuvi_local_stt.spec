# -*- mode: python ; coding: utf-8 -*-
"""YUVI local STT Windows x64 onedir spec."""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


PACKAGING_DIR = Path(
    os.environ.get("YUVI_LOCAL_STT_SPEC_DIR", str(Path.cwd() / "packaging"))
).resolve()
SERVICE_ROOT = PACKAGING_DIR.parent
ENTRY = SERVICE_ROOT / "server.py"

sherpa_datas, sherpa_binaries, sherpa_hiddenimports = collect_all("sherpa_onnx")
hiddenimports = [
    *sherpa_hiddenimports,
    "numpy",
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
    excludes=["pkg_resources", "setuptools", "backports"],
    noarchive=False,
    optimize=0,
)
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
