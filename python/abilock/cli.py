"""Forward abl directly to Node, preserving terminal streams and arguments."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

MINIMUM_NODE = (22, 12, 0)


def cli_script() -> Path:
    package = Path(__file__).resolve().parent
    bundled = package / "node_cli" / "abl.mjs"
    if bundled.is_file():
        return bundled
    source = package.parents[1] / "bin" / "abl.mjs"
    if source.is_file():
        return source
    raise FileNotFoundError("Abilock's bundled Node CLI is missing. Reinstall a complete Abilock wheel.")


def node_version(node: str) -> tuple[int, int, int]:
    result = subprocess.run(
        [node, "--version"], capture_output=True, text=True, timeout=10, check=False
    )
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\s*", result.stdout)
    if result.returncode != 0 or not match:
        raise ValueError("Could not verify the Node.js runtime version.")
    return tuple(int(part) for part in match.groups())


def main() -> int:
    node = shutil.which("node")
    if node is None:
        print("Abilock requires Node.js >= 22.12. Install Node.js and make node available on PATH.", file=sys.stderr)
        return 127
    try:
        if node_version(node) < MINIMUM_NODE:
            print("Abilock requires Node.js >= 22.12. Update the Node.js runtime on PATH.", file=sys.stderr)
            return 126
        script = cli_script()
        # Never resolve or call abl again; exec the actual Node executable directly.
        os.execv(node, [node, str(script), *sys.argv[1:]])
    except FileNotFoundError:
        print("Abilock could not find its Node CLI or runtime. Reinstall a complete wheel and check Node.js on PATH.", file=sys.stderr)
        return 127
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Abilock could not start Node.js >= 22.12. Check the runtime on PATH.", file=sys.stderr)
        return 126
    return 0
