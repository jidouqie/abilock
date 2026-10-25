"""Copy the canonical CLI and its existing JS dependency into a local wheel."""

import json
from pathlib import Path

from setuptools.command.build_py import build_py
from setuptools.errors import SetupError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CLI_FILES = tuple(path.name for path in sorted((PROJECT_ROOT / "bin").glob("*.mjs")))
WS_FILES = ("package.json", "LICENSE", "browser.js", "index.js", "wrapper.mjs")


class NodeCliBuild(build_py):
    def run(self):
        if "abl.mjs" not in CLI_FILES:
            raise SetupError("The canonical bin/abl.mjs CLI is required to build Abilock.")
        ws_source = PROJECT_ROOT / "node_modules" / "ws"
        package_file = ws_source / "package.json"
        if not package_file.is_file():
            raise SetupError(
                "The existing ws dependency is required to build Abilock. "
                "Prepare repository dependencies first; this build never downloads them."
            )
        installed_ws = json.loads(package_file.read_text(encoding="utf-8"))
        locked_ws = json.loads(
            (PROJECT_ROOT / "package-lock.json").read_text(encoding="utf-8")
        )["packages"]["node_modules/ws"]["version"]
        if installed_ws.get("version") != locked_ws or installed_ws.get("license") != "MIT":
            raise SetupError("The local ws version or license does not match the locked dependency.")

        cli_sources = [PROJECT_ROOT / "bin" / filename for filename in CLI_FILES]
        limits_source = PROJECT_ROOT / "request-limits.json"
        ws_sources = [ws_source / filename for filename in WS_FILES]
        ws_sources += sorted((ws_source / "lib").glob("*.js"))
        for source in cli_sources + ws_sources + [limits_source]:
            if not source.is_file() or source.is_symlink():
                raise SetupError(f"Missing or invalid required build input: {source.name}")
        if not (ws_source / "lib" / "websocket.js").is_file():
            raise SetupError("The local ws JavaScript implementation is incomplete.")

        super().run()
        destination = Path(self.build_lib) / "abilock" / "node_cli"
        self.copy_file(str(limits_source), str(destination.parent / "request-limits.json"))
        for source in cli_sources:
            self.mkpath(str(destination))
            self.copy_file(str(source), str(destination / source.name))
        for source in ws_sources:
            relative = source.relative_to(ws_source)
            target = destination / "node_modules" / "ws" / relative
            self.mkpath(str(target.parent))
            self.copy_file(str(source), str(target))

    def get_outputs(self, include_bytecode=1):
        outputs = super().get_outputs(include_bytecode)
        destination = Path(self.build_lib) / "abilock" / "node_cli"
        if destination.is_dir():
            outputs += [str(path) for path in sorted(destination.rglob("*")) if path.is_file()]
            outputs.append(str(destination.parent / "request-limits.json"))
        return outputs
