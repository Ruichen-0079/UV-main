"""Stage notices from the actual build interpreter and installed distributions."""
from pathlib import Path
import hashlib
import importlib.metadata as metadata
import json
import sys
import subprocess
from urllib.parse import quote


def stage_runtime_notices(output: Path) -> None:
    dest = output / "licenses" / "runtime"
    dest.mkdir(parents=True, exist_ok=True)
    components = []
    for package, filename in [("numpy", "LICENSE.txt"), ("sherpa-onnx", "licenses/LICENSE"), ("pyinstaller", "COPYING.txt")]:
        dist = metadata.distribution(package)
        candidates = [dist.locate_file(f) for f in dist.files or [] if str(f).endswith(".dist-info/" + filename)]
        if len(candidates) != 1:
            raise RuntimeError(f"Required redistribution notice missing for {package}")
        name = f"{package}-{dist.version}.LICENSE.txt"
        (dest / name).write_bytes(Path(candidates[0]).read_bytes())
        components.append({"name": package, "version": dist.version, "notice": f"licenses/runtime/{name}"})
    python_license = Path(sys.base_prefix) / "lib" / "python3.11" / "LICENSE.txt"
    if not python_license.is_file():
        python_license = Path(sys.base_prefix) / "LICENSE.txt"
    (dest / "CPython.LICENSE.txt").write_bytes(python_license.read_bytes())
    components.append({"name": "CPython", "version": sys.version.split()[0], "notice": "licenses/runtime/CPython.LICENSE.txt"})
    # Debian's actual native runtime notices; PyInstaller flattens these library paths.
    if sys.platform.startswith("linux") and Path("/etc/debian_version").is_file():
        for package in ["libssl3", "libffi8", "libbz2-1.0", "liblzma5"]:
            copyright_file = Path("/usr/share/doc") / package / "copyright"
            name = f"Debian-{package}.copyright.txt"
            (dest / name).write_bytes(copyright_file.read_bytes())
            version = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", package], text=True)
            components.append({"name": package, "version": version, "notice": f"licenses/runtime/{name}", "source": "https://sources.debian.org/src/" + subprocess.check_output(["dpkg-query", "-W", "-f=${source:Package}", package], text=True) + "/" + quote(subprocess.check_output(["dpkg-query", "-W", "-f=${source:Version}", package], text=True), safe="") + "/"})
    core = metadata.distribution("sherpa-onnx-core")
    components.append({"name": "sherpa-onnx-core", "version": core.version, "notice": f"licenses/runtime/sherpa-onnx-{core.version}.LICENSE.txt"})
    files = []
    for file in sorted((output / "_internal").rglob("*")):
        if file.is_file():
            files.append({"path": file.relative_to(output).as_posix(), "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    (output / "runtime-inventory.json").write_text(json.dumps({"schemaVersion": 1, "components": sorted(components, key=lambda c: c["name"]), "files": files}, indent=2) + "\n")
