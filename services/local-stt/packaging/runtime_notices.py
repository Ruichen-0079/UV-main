"""Stage notices from the actual build interpreter and installed distributions."""
from pathlib import Path
import hashlib
import importlib.metadata as metadata
import json
import sys
import subprocess
import ctypes
import base64
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
    # Match each shipped native object to an installed wheel, CPython, or Debian
    # package by bytes. Unknown native inputs fail the release build.
    native_origins = {}
    if sys.platform.startswith("linux"):
        if not Path("/etc/debian_version").is_file() or sys.prefix == sys.base_prefix:
            raise RuntimeError("Linux release requires an isolated Debian build environment")
        report = Path(sys.prefix) / "install-report.json"
        if not report.is_file():
            raise RuntimeError("Missing fresh dependency installation report")
        installed = json.loads(report.read_text())
        lock = json.loads((Path(__file__).parent / "linux-wheels.lock.json").read_text())
        normalize = lambda name: name.lower().replace("_", "-")
        expected = {normalize(item["name"]): item for item in lock}
        actual = {normalize(item["metadata"]["name"]): item for item in installed["install"]}
        if set(actual) != set(expected):
            raise RuntimeError("Dependency installation differs from release lock")
        for name, item in actual.items():
            if item["metadata"]["version"] != expected[name]["version"] or item["download_info"]["archive_info"]["hashes"]["sha256"] != expected[name]["sha256"]:
                raise RuntimeError("Dependency installation hash differs from release lock")
        (output / "dependency-install-report.json").write_text(json.dumps({"environment": installed["environment"], "wheels": lock, "debian": Path("/etc/debian_version").read_text().strip(), "isolatedEnvironment": True}, indent=2) + "\n")
        candidates = {}
        def add(file, owner):
            file = Path(file)
            if file.is_file() and file.read_bytes()[:4] == b"\x7fELF":
                candidates[hashlib.sha256(file.read_bytes()).hexdigest()] = owner
        for dist in metadata.distributions():
            for item in dist.files or []:
                file = Path(dist.locate_file(item))
                if file.is_file() and file.read_bytes()[:4] == b"\x7fELF":
                    if not item.hash or item.hash.mode != "sha256" or base64.urlsafe_b64encode(hashlib.sha256(file.read_bytes()).digest()).decode().rstrip("=") != item.hash.value:
                        raise RuntimeError(f"Wheel RECORD mismatch: {dist.metadata['Name']}/{item}")
                    add(file, {"component": dist.metadata["Name"], "version": dist.version, "origin": "Debian fresh pip installation", "input": str(item)})
        for file in (Path(sys.base_prefix) / "lib" / "python3.11" / "lib-dynload").glob("*.so"):
            add(file, {"component": "CPython", "version": sys.version.split()[0], "origin": "Debian Python image"})
        add(Path(sys.base_prefix) / "lib/libpython3.11.so.1.0", {"component": "CPython", "version": sys.version.split()[0], "origin": "Debian Python image"})
        for package in ["libssl3", "libffi8", "libbz2-1.0", "liblzma5", "libtinfo6"]:
            paths = subprocess.check_output(["dpkg-query", "-L", package], text=True).splitlines()
            version = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", package], text=True)
            for file in paths:
                if ".so" in file:
                    add(file, {"component": package, "version": version, "origin": "Debian package"})
            shipped_hashes = {hashlib.sha256(f.read_bytes()).hexdigest() for f in (output / "_internal").rglob("*") if f.is_file()}
            if any(candidates[h]["component"] == package for h in shipped_hashes if h in candidates):
                name = f"Debian-{package}.copyright.txt"
                (dest / name).write_bytes((Path("/usr/share/doc") / package / "copyright").read_bytes())
                source_package = subprocess.check_output(["dpkg-query", "-W", "-f=${source:Package}", package], text=True)
                source_version = subprocess.check_output(["dpkg-query", "-W", "-f=${source:Version}", package], text=True)
                components.append({"name": package, "version": version, "notice": f"licenses/runtime/{name}", "source": "https://sources.debian.org/src/" + source_package + "/" + quote(source_version, safe="") + "/"})
        for file in (output / "_internal").rglob("*"):
            if not file.is_file() or file.read_bytes()[:4] != b"\x7fELF":
                continue
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if digest not in candidates:
                raise RuntimeError(f"Unattributed native input: {file.name}")
            native_origins[file.relative_to(output).as_posix()] = candidates[digest]
        for file in Path("/usr/share/common-licenses").iterdir():
            if file.is_file():
                (dest / ("Debian-common-" + file.name + ".txt")).write_bytes(file.read_bytes())
        class OrtApiBase(ctypes.Structure):
            _fields_ = [("get_api", ctypes.c_void_p), ("version", ctypes.CFUNCTYPE(ctypes.c_char_p))]
        ort = ctypes.CDLL(str(output / "_internal/libonnxruntime.so"))
        ort.OrtGetApiBase.restype = ctypes.POINTER(OrtApiBase)
        ort_version = ort.OrtGetApiBase().contents.version().decode()
        if ort_version != "1.27.1":
            raise RuntimeError("ONNX Runtime changed; refresh its pinned notices")
        components.append({"name": "ONNX Runtime", "version": ort_version, "notice": "licenses/runtime/onnxruntime.LICENSE.txt", "thirdPartyNotices": "licenses/runtime/onnxruntime.ThirdPartyNotices.txt"})
        components.extend([
            {"name": "ALSA (wheel native library)", "notice": "licenses/runtime/alsa-lib.COPYING.txt"},
            {"name": "NumPy OpenBLAS / GCC runtime", "notice": f"licenses/runtime/numpy-{metadata.version('numpy')}.LICENSE.txt"},
        ])
    core = metadata.distribution("sherpa-onnx-core")
    components.append({"name": "sherpa-onnx-core", "version": core.version, "notice": f"licenses/runtime/sherpa-onnx-{core.version}.LICENSE.txt"})
    files = []
    for file in sorted((output / "_internal").rglob("*")):
        if file.is_file():
            files.append({"path": file.relative_to(output).as_posix(), "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    (output / "runtime-inventory.json").write_text(json.dumps({"schemaVersion": 1, "components": sorted(components, key=lambda c: c["name"]), "files": files, "nativeOrigins": native_origins}, indent=2) + "\n")
