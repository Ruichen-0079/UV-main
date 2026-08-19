from __future__ import annotations

import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from agentbus.browser_extension.package import (
    EXTENSION_ID,
    SOURCE_FILES,
    install_persistent_extension,
    package_extension,
    validate_extension_sources,
    verify_signed_xpi,
)
from agentbus.paths import AgentbusError


class BrowserPackagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = Path(__file__).resolve().parents[1] / "browser_extension"
        self.temp = tempfile.TemporaryDirectory(prefix="yuvi-browser-package-")
        self.root = Path(self.temp.name)
        self.copy = self.root / "source"
        shutil.copytree(
            self.source,
            self.copy,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        self.artifacts = self.root / "artifacts"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_manifest_and_runtime_fences_reject_explicit_port_and_wrong_endpoint(self) -> None:
        manifest_path = self.copy / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["permissions"][-1] = "http://127.0.0.1:6738/*"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(AgentbusError):
            validate_extension_sources(self.copy)

        shutil.copytree(
            self.source,
            self.copy,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        background = self.copy / "background.js"
        background.write_text(
            background.read_text(encoding="utf-8").replace(
                'fetch(JOBS_URL, { cache: "no-store" })',
                'fetch("http://192.168.1.9/jobs", { cache: "no-store" })',
            ),
            encoding="utf-8",
        )
        with self.assertRaises(AgentbusError):
            validate_extension_sources(self.copy)

        shutil.copytree(
            self.source,
            self.copy,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        background = self.copy / "background.js"
        background.write_text(
            background.read_text(encoding="utf-8").replace(":6738/", ":6739/"),
            encoding="utf-8",
        )
        with self.assertRaises(AgentbusError):
            validate_extension_sources(self.copy)

    def test_xpi_is_allowlisted_reproducible_and_id_stable(self) -> None:
        first = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        first_bytes = Path(first["xpi"]).read_bytes()
        second = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        self.assertEqual(first["version"], second["version"])
        self.assertEqual(first_bytes, Path(second["xpi"]).read_bytes())
        with zipfile.ZipFile(first["xpi"]) as archive:
            self.assertEqual(set(archive.namelist()), set(SOURCE_FILES))
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["version"], first["version"])
        self.assertEqual(manifest["browser_specific_settings"]["gecko"]["id"], EXTENSION_ID)

    def test_unit_packaging_never_launches_firefox(self) -> None:
        with patch(
            "agentbus.browser_extension.package.subprocess.run",
            side_effect=AssertionError("packaging must not launch Firefox or any browser"),
        ):
            result = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        self.assertFalse(result["signed"])

    def test_source_change_advances_patch_version_without_editing_manifest(self) -> None:
        first = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        content = self.copy / "content.js"
        content.write_text(content.read_text(encoding="utf-8") + "\n// deterministic source update\n", encoding="utf-8")
        second = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        self.assertEqual(first["version"], "1.0.0")
        self.assertEqual(second["version"], "1.0.1")
        self.assertNotEqual(first["xpi"], second["xpi"])

    def _make_signed_fixture(self) -> Path:
        unsigned = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        signed = self.root / "signed.xpi"
        with zipfile.ZipFile(unsigned["xpi"]) as source_archive, zipfile.ZipFile(signed, "w", zipfile.ZIP_DEFLATED) as output:
            for name in SOURCE_FILES:
                output.writestr(name, source_archive.read(name))
            # The real Mozilla signature is cryptographically verified by
            # Firefox. The installer only accepts the signed archive shape;
            # this marker keeps the policy test deterministic and offline.
            output.writestr("META-INF/mozilla.rsa", b"test signature marker")
            output.writestr("META-INF/mozilla.sf", b"test signature marker")
        return signed

    def test_unsigned_xpi_is_rejected_and_policy_merge_preserves_unrelated_entries(self) -> None:
        unsigned = package_extension(source_dir=self.copy, artifact_dir=self.artifacts)
        with self.assertRaises(AgentbusError) as failure:
            install_persistent_extension(unsigned["xpi"], policy_path=self.root / "policies.json")
        self.assertEqual(failure.exception.code, "SIGNING_SETUP_REQUIRED")

        signed = self._make_signed_fixture()
        policy_path = self.root / "policies.json"
        policy_path.write_text(
            json.dumps(
                {
                    "policies": {
                        "DisableTelemetry": True,
                        "ExtensionSettings": {
                            "unrelated@example": {"installation_mode": "blocked"}
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        result = install_persistent_extension(signed, policy_path=policy_path)
        self.assertTrue(result["changed"])
        self.assertTrue(Path(result["backup"]).is_file())
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        self.assertTrue(policy["policies"]["DisableTelemetry"])
        self.assertEqual(
            policy["policies"]["ExtensionSettings"]["unrelated@example"],
            {"installation_mode": "blocked"},
        )
        self.assertEqual(
            policy["policies"]["ExtensionSettings"][EXTENSION_ID],
            {
                "installation_mode": "normal_installed",
                "install_url": signed.resolve().as_uri(),
            },
        )
        repeat = install_persistent_extension(signed, policy_path=policy_path)
        self.assertFalse(repeat["changed"])
        self.assertIsNone(repeat["backup"])
        self.assertEqual(verify_signed_xpi(signed)["extension_id"], EXTENSION_ID)

    def test_policy_dry_run_does_not_mutate_file(self) -> None:
        signed = self._make_signed_fixture()
        policy_path = self.root / "policies.json"
        original = '{"policies": {"DisableTelemetry": true}}\n'
        policy_path.write_text(original, encoding="utf-8")
        result = install_persistent_extension(signed, policy_path=policy_path, dry_run=True)
        self.assertTrue(result["changed"])
        self.assertEqual(policy_path.read_text(encoding="utf-8"), original)
