import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const { planPublicBindings, applyPublicBindings, cliWrapper } = await import(new URL("../bin/install-bundle.mjs", import.meta.url).href);
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "abilock-public-install-")));
  const home = path.join(root, "home"), program = path.join(root, "protected");
  const fixedCommand = path.join(root, "system/bin/abl"), brew = path.join(root, "brew");
  await fs.mkdir(home);
  await fs.mkdir(path.dirname(fixedCommand), { recursive: true });
  await fs.writeFile(fixedCommand, cliWrapper, { mode: 0o755 });
  await fs.mkdir(path.join(program, "runtime/desktop/Abilock.app"), { recursive: true });
  await fs.mkdir(path.join(program, "runtime/skills/abilock"), { recursive: true });
  await fs.writeFile(path.join(program, "runtime/skills/abilock/SKILL.md"), "---\nname: abilock\n---\nNew Skill\n");
  await fs.mkdir(path.join(brew, "lib/node_modules/abilock/bin"), { recursive: true });
  await fs.mkdir(path.join(brew, "bin"));
  await fs.writeFile(path.join(brew, "lib/node_modules/abilock/package.json"), JSON.stringify({ name: "abilock", version: "2.1.3", bin: { abl: "bin/abl.mjs" } }));
  await fs.writeFile(path.join(brew, "lib/node_modules/abilock/bin/abl.mjs"), "OLD PUBLIC CLI", { mode: 0o755 });
  await fs.symlink("../lib/node_modules/abilock/bin/abl.mjs", path.join(brew, "bin/abl"));
  return { root, home, program, fixedCommand, brew, options: { home, uid: process.getuid!(), root: program, fixedCommand,
    pathValue: [path.join(brew, "bin"), path.dirname(fixedCommand)].join(path.delimiter) } };
}

test("unified installer replaces the known first npm link without changing its package or shell profile", async () => {
  const item = await fixture();
  try {
    const plan = await planPublicBindings(item.options);
    assert.equal(await fs.readlink(path.join(item.brew, "bin/abl")), "../lib/node_modules/abilock/bin/abl.mjs");
    const result = await applyPublicBindings(plan);
    assert.equal(result.command, path.join(item.brew, "bin/abl"));
    assert.equal(await fs.realpath(result.command), item.fixedCommand);
    assert.equal(await fs.readFile(path.join(item.brew, "lib/node_modules/abilock/bin/abl.mjs"), "utf8"), "OLD PUBLIC CLI");
    assert.equal(await fs.realpath(path.join(item.home, "Applications/Abilock.app")), path.join(item.program, "runtime/desktop/Abilock.app"));
    for (const name of [".codex", ".claude", ".agents"])
      assert.equal(await fs.realpath(path.join(item.home, name, "skills/abilock")), path.join(item.program, "runtime/skills/abilock"));
    assert.equal((await planPublicBindings(item.options)).links.length, 0);
    await assert.rejects(fs.access(path.join(item.home, ".zshrc")));
  } finally { await fs.rm(item.root, { recursive: true, force: true }); }
});

test("unrelated first command is rejected before any public installation changes", async () => {
  const item = await fixture();
  try {
    await fs.unlink(path.join(item.brew, "bin/abl"));
    await fs.writeFile(path.join(item.brew, "bin/abl"), "#!/bin/sh\necho unrelated\n", { mode: 0o755 });
    await assert.rejects(planPublicBindings(item.options), /unrelated abl command/);
    assert.match(await fs.readFile(path.join(item.brew, "bin/abl"), "utf8"), /unrelated/);
    await assert.rejects(fs.access(path.join(item.home, "Applications")));
  } finally { await fs.rm(item.root, { recursive: true, force: true }); }
});

test("existing product Skill directory is preserved as a backup before linking the new Skill", async () => {
  const item = await fixture();
  try {
    const skill = path.join(item.home, ".claude/skills/abilock");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: abilock\n---\nOld instructions\n");
    await fs.writeFile(path.join(skill, "custom.txt"), "User additions");
    const result = await applyPublicBindings(await planPublicBindings(item.options));
    assert.equal(result.backups.length, 1);
    assert.equal(await fs.readFile(path.join(result.backups[0], "custom.txt"), "utf8"), "User additions");
    assert.equal(await fs.realpath(skill), path.join(item.program, "runtime/skills/abilock"));
  } finally { await fs.rm(item.root, { recursive: true, force: true }); }
});

test("late public-entry replacement is retained instead of overwritten", async () => {
  const item = await fixture();
  try {
    const plan = await planPublicBindings(item.options);
    await fs.unlink(path.join(item.brew, "bin/abl"));
    await fs.writeFile(path.join(item.brew, "bin/abl"), "Concurrent user command", { mode: 0o755 });
    await assert.rejects(applyPublicBindings(plan), /entry changed/);
    assert.equal(await fs.readFile(path.join(item.brew, "bin/abl"), "utf8"), "Concurrent user command");
  } finally { await fs.rm(item.root, { recursive: true, force: true }); }
});

test("fixed privileged CLI registration preserves conflicts and uses the identical wrapper", async () => {
  const python = `
import importlib.util, pathlib, tempfile, os, stat, types
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installer', ${JSON.stringify(path.resolve("scripts/isolation-install.py"))})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert module.CLI_WRAPPER.decode() == ${JSON.stringify(cliWrapper)}
with tempfile.TemporaryDirectory(prefix='abl-public-cli-') as directory:
    root=pathlib.Path(directory).resolve(); module.PUBLIC_CLI=root/'bin/abl'; module.PUBLIC_CLI.parent.mkdir()
    original=pathlib.Path.lstat
    def synthetic_root(file):
        value=original(file)
        return types.SimpleNamespace(st_mode=(value.st_mode & ~0o777)|0o755 if stat.S_ISDIR(value.st_mode) else value.st_mode,
          st_uid=0,st_dev=value.st_dev,st_ino=value.st_ino,st_size=value.st_size,st_nlink=value.st_nlink)
    with patch.object(pathlib.Path,'lstat',synthetic_root), patch.object(module,'acl_text',lambda _:b''), \
         patch.object(module,'root_directory',lambda _:None), patch.object(module.os,'fchown',lambda *args:None):
        assert module.public_cli_state(os.getuid()) is None
        module.register_public_cli(os.getuid(), None)
        assert module.PUBLIC_CLI.read_bytes()==module.CLI_WRAPPER
        assert stat.S_IMODE(original(module.PUBLIC_CLI).st_mode)==0o555
        before=module.public_cli_state(os.getuid()); module.register_public_cli(os.getuid(),before)
        os.chmod(module.PUBLIC_CLI,0o644); module.PUBLIC_CLI.write_bytes(b'unrelated command')
        try: module.public_cli_state(os.getuid()); raise AssertionError('accepted conflict')
        except ValueError: pass
        try: module.register_public_cli(os.getuid(),None); raise AssertionError('overwrote conflict')
        except ValueError: pass
        assert module.PUBLIC_CLI.read_bytes()==b'unrelated command'
`;
  execFileSync("python3", ["-c", python], { encoding: "utf8" });
});
