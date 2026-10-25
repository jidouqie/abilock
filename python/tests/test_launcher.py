import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "python"))
cli = importlib.import_module("abilock.cli")


class LauncherTests(unittest.TestCase):
    def test_source_checkout_resolves_canonical_cli(self):
        self.assertEqual(cli.cli_script(), PROJECT_ROOT / "bin" / "abl.mjs")

    def test_bundled_cli_takes_priority(self):
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "abilock"
            (package / "node_cli").mkdir(parents=True)
            script = package / "node_cli" / "abl.mjs"
            script.write_text("// synthetic fixture\n")
            with patch.object(cli, "__file__", str(package / "cli.py")):
                self.assertEqual(cli.cli_script(), script.resolve())

    def test_missing_node_is_clear_and_never_resolves_abl(self):
        error = io.StringIO()
        with patch.object(cli.shutil, "which", return_value=None) as which:
            with contextlib.redirect_stderr(error):
                self.assertEqual(cli.main(), 127)
        which.assert_called_once_with("node")
        self.assertIn("Node.js >= 22.12", error.getvalue())

    def test_outdated_node_never_executes_cli(self):
        with patch.object(cli.shutil, "which", return_value="/synthetic/node"):
            with patch.object(cli, "node_version", return_value=(22, 11, 0)):
                with patch.object(cli.os, "execv") as execute:
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(cli.main(), 126)
                    execute.assert_not_called()

    def test_version_probe_rejects_untrusted_error_output(self):
        response = subprocess.CompletedProcess([], 1, stdout="synthetic-secret", stderr="synthetic-secret")
        with patch.object(cli.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(ValueError, "Could not verify"):
                cli.node_version("/synthetic/node")

    def test_timeout_fails_without_echoing_process_output(self):
        error = io.StringIO()
        timeout = subprocess.TimeoutExpired("node", 10, output="synthetic-secret")
        with patch.object(cli.shutil, "which", return_value="/synthetic/node"):
            with patch.object(cli, "node_version", side_effect=timeout):
                with contextlib.redirect_stderr(error):
                    self.assertEqual(cli.main(), 126)
        self.assertNotIn("synthetic-secret", error.getvalue())

    @unittest.skipIf(os.name == "nt", "Executable fixture uses a Unix shebang")
    def test_direct_exec_preserves_arguments_environment_streams_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            node = directory / "node"
            node.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "if sys.argv[1:] == ['--version']:\n"
                "    print('v22.12.0')\n"
                "    raise SystemExit(0)\n"
                "print(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read(), "
                "'sentinel': os.environ.get('ABILOCK_WRAPPER_TEST')}, ensure_ascii=False))\n"
                "sys.stderr.write('synthetic-node-stderr\\n')\n"
                "raise SystemExit(7)\n"
            )
            node.chmod(0o755)
            recursive = directory / "abl"
            recursive.write_text(f"#!{sys.executable}\nraise SystemExit('recursive-call')\n")
            recursive.chmod(0o755)
            arguments = ["discover", "--query", "生图 with spaces", "literal;$()", "line\nbreak"]
            result = subprocess.run(
                [sys.executable, "-m", "abilock", *arguments],
                input="synthetic-stdin\n",
                text=True,
                capture_output=True,
                env={
                    "PATH": str(directory),
                    "PYTHONPATH": str(PROJECT_ROOT / "python"),
                    "ABILOCK_WRAPPER_TEST": "synthetic-sentinel",
                },
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 7)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["argv"], [str(PROJECT_ROOT / "bin" / "abl.mjs"), *arguments])
            self.assertEqual(payload["stdin"], "synthetic-stdin\n")
            self.assertEqual(payload["sentinel"], "synthetic-sentinel")
            self.assertEqual(result.stderr, "synthetic-node-stderr\n")


if __name__ == "__main__":
    unittest.main()
