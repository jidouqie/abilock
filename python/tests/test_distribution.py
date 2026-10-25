import configparser
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_VERSION = json.loads((PROJECT_ROOT / "package.json").read_text())["version"]
WHEEL = PROJECT_ROOT / "artifacts" / "packages" / f"abilock-{PACKAGE_VERSION}-py3-none-any.whl"
SDIST = PROJECT_ROOT / "artifacts" / "packages" / f"abilock-{PACKAGE_VERSION}.tar.gz"


@unittest.skipUnless(WHEEL.is_file(), "Build the local Abilock wheel to verify its distribution.")
class WheelTests(unittest.TestCase):
    def test_console_entry_and_resources_match_single_source(self):
        with zipfile.ZipFile(WHEEL) as archive:
            entry = configparser.ConfigParser()
            entry.read_string(archive.read(f"abilock-{PACKAGE_VERSION}.dist-info/entry_points.txt").decode())
            self.assertEqual(dict(entry["console_scripts"]), {"abl": "abilock.cli:main"})
            self.assertEqual(archive.read("abilock/request-limits.json"), (PROJECT_ROOT / "request-limits.json").read_bytes())
            for source in sorted((PROJECT_ROOT / "bin").glob("*.mjs")):
                self.assertEqual(archive.read(f"abilock/node_cli/{source.name}"), source.read_bytes())
            for source in (PROJECT_ROOT / "node_modules" / "ws").rglob("*"):
                if source.is_file() and source.name != "README.md":
                    relative = source.relative_to(PROJECT_ROOT / "node_modules" / "ws")
                    self.assertEqual(archive.read(f"abilock/node_cli/node_modules/ws/{relative.as_posix()}"), source.read_bytes())
            metadata = archive.read(f"abilock-{PACKAGE_VERSION}.dist-info/METADATA").decode()
            self.assertIn("Name: abilock\n", metadata)
            self.assertIn("Node.js >= 22.12", metadata)
            self.assertFalse(any(name.startswith("src/") or Path(name).name.startswith(".env") for name in archive.namelist()))

    @unittest.skipUnless(shutil.which("node"), "Node.js is needed for the bundled CLI smoke check.")
    def test_extracted_wheel_runs_help_and_loads_ssh_dependency(self):
        node = shutil.which("node")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with zipfile.ZipFile(WHEEL) as archive:
                archive.extractall(directory)
            result = subprocess.run(
                [sys.executable, "-m", "abilock", "--help"],
                cwd=directory,
                env={"PATH": str(Path(node).parent), "PYTHONPATH": str(directory)},
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Abilock · abl", result.stdout)
            self.assertIn("abl list [--json]", result.stdout)
            self.assertIn("abl doc ALIAS", result.stdout)
            self.assertIn("abl api ALIAS chat TEXT", result.stdout)
            self.assertIn("abl ssh", result.stdout)
            ws_uri = (directory / "abilock" / "node_cli" / "node_modules" / "ws" / "wrapper.mjs").resolve().as_uri()
            result = subprocess.run(
                [node, "--input-type=module", "-e", f"import WebSocket from {json.dumps(ws_uri)}; console.log(typeof WebSocket);"],
                cwd=directory,
                env={"PATH": str(Path(node).parent)},
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "function\n")


@unittest.skipUnless(SDIST.is_file(), "Build the local Abilock source distribution to verify its inputs.")
class SourceDistributionTests(unittest.TestCase):
    def test_source_archive_carries_cli_dependency_and_license_without_credentials(self):
        with tarfile.open(SDIST) as archive:
            prefix = f"abilock-{PACKAGE_VERSION}/"
            names = archive.getnames()
            self.assertIn(prefix + "node_modules/ws/LICENSE", names)
            self.assertIn(prefix + "node_modules/ws/lib/websocket.js", names)
            self.assertIn(prefix + "python/build_support.py", names)
            self.assertIn(prefix + "request-limits.json", names)
            for source in (PROJECT_ROOT / "bin").glob("*.mjs"):
                member = archive.extractfile(prefix + "bin/" + source.name)
                self.assertEqual(member.read(), source.read_bytes())
            self.assertFalse(any(Path(name).name.startswith(".env") or "/src/" in name for name in names))


if __name__ == "__main__":
    unittest.main()
