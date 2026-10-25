import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { parseSourceInstallOptions, sourceInstallEnvironment, validateSourceMetadata,
  validateCommittedTree, installFromSource, sanitizeBuildOutput, publicBundleValidationScript } = await import(new URL("../scripts/install-from-source.mjs", import.meta.url).href);

const sources = ["scripts/install-from-source.mjs", "scripts/prepare-isolation.mjs", "scripts/build-isolation-launcher.mjs",
  "scripts/build-desktop.mjs", "scripts/isolation-install.py", "scripts/install-macos.sh", "skills/abilock/SKILL.md"];
const metadata = { name: "abilock", version: "2.2.11", bin: { abl: "bin/abl.mjs" } };
const lock = { name: "abilock", version: "2.2.11", lockfileVersion: 3, packages: {
  "": { name: "abilock", version: "2.2.11" },
  "node_modules/synthetic": { resolved: "https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz", integrity: "sha512-c3ludGhldGlj" },
} };
type CommandOptions = { cwd: string; env: Record<string, string>; timeout: number };

test("source CLI runs through a filesystem alias instead of exiting silently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-source-alias-"));
  try {
    const actual = path.join(root, "actual"), alias = path.join(root, "alias");
    await fs.mkdir(actual);
    await fs.copyFile(new URL("../scripts/install-from-source.mjs", import.meta.url), path.join(actual, "install-from-source.mjs"));
    await fs.symlink(actual, alias, "dir");
    const result = await execute(process.execPath, [path.join(alias, "install-from-source.mjs"), "--help"]);
    assert.match(result.stdout, /Usage: node scripts\/install-from-source\.mjs/);
    assert.match(result.stdout, /--prepare-only/);
    assert.equal(result.stderr, "");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-source-test-"));
  for (const name of sources) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), "// Synthetic installation source only.\n");
  }
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(metadata));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), JSON.stringify(lock));
  const git = (arguments_: string[]) => execute("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...arguments_]);
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Synthetic Installer", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Synthetic source"]);
  await fs.writeFile(path.join(root, ".env"), "SYNTHETIC_UNTRACKED_SENTINEL=do-not-copy\n");
  const calls: { command: string; arguments_: string[]; options: CommandOptions }[] = [];
  const workspaces = new Set<string>();
  let failure = "";
  async function runner(command: string, arguments_: string[], options: CommandOptions) {
    calls.push({ command, arguments_, options });
    if (command === "/usr/bin/git" && arguments_.includes("archive")) {
      const archive = arguments_.find(value => value.startsWith("--output="))!.slice("--output=".length);
      workspaces.add(path.dirname(archive));
    }
    if (failure && (command.endsWith(failure) || arguments_.includes(failure))) throw new Error("Synthetic stage failure.");
    if (command === "/usr/bin/git" || command === "/usr/bin/tar") return execute(command, arguments_, options);
    if (command === "/usr/bin/sw_vers") return { stdout: "13.6.0\n", stderr: "" };
    if (arguments_[0] === "scripts/prepare-isolation.mjs") {
      await assert.rejects(fs.access(path.join(options.cwd, ".env")));
      const bundle = arguments_[1];
      await fs.mkdir(path.join(bundle, "runtime/scripts"), { recursive: true });
      await fs.writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ runtimeVersion: "2.2.11", platform: "darwin", arch: "arm64" }));
      await fs.writeFile(path.join(bundle, "Install.command"), "# synthetic, never executed\n");
    }
    return { stdout: "synthetic prerequisite or build result\n", stderr: "" };
  }
  const options = { root, environment: { PATH: process.env.PATH ?? "", HOME: root, NODE_OPTIONS: "synthetic-unsafe", ABILOCK_DEVELOPMENT: "1" },
    platform: "darwin", architecture: "arm64", nodeVersion: "22.12.0", uid: 501, nodeExecutable: "/synthetic/node", runner, progress: () => {} };
  return { root, git, options, calls, workspaces, fail: (value: string) => { failure = value; },
    async cleanup() { for (const directory of [root, ...workspaces]) await fs.rm(directory, { recursive: true, force: true }); } };
}

test("source installer accepts only its bounded modes and strips execution overrides", () => {
  assert.deepEqual(parseSourceInstallOptions([]), { mode: "install" });
  assert.deepEqual(parseSourceInstallOptions(["--check"]), { mode: "check" });
  assert.deepEqual(parseSourceInstallOptions(["--prepare-only"]), { mode: "prepare" });
  for (const args of [["--check", "--prepare-only"], ["--root", "/tmp"], ["--installer=evil"], ["--check", "--check"]])
    assert.throws(() => parseSourceInstallOptions(args), /Usage/);
  assert.deepEqual(sourceInstallEnvironment({ HOME: "/tmp", PATH: "/usr/bin", NODE_OPTIONS: "bad", NPM_CONFIG_REGISTRY: "bad",
    ABILOCK_EXEC_TOKEN: "synthetic-only", GIT_SSH_COMMAND: "bad", PYTHONPATH: "bad", BASH_ENV: "bad" }),
  { HOME: "/tmp", PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", CI: "1" });
  const output = sanitizeBuildOutput("Bearer synthetic-secret-value https://user:password@example.invalid/result?key=synthetic#token sk-syntheticlongtokenvalue");
  assert.equal(output, "Bearer [redacted] https://example.invalid/result [redacted]");
});

test("source dependency metadata must match and pin official registry integrity", () => {
  assert.equal(validateSourceMetadata(metadata, lock, structuredClone(lock)), "2.2.11");
  const altered = structuredClone(lock);
  altered.version = "2.2.10";
  assert.throws(() => validateSourceMetadata(metadata, lock, altered), /versions/);
  altered.version = "2.2.11";
  altered.packages["node_modules/synthetic"].resolved = "https://registry.npmjs.org.evil.invalid/archive.tgz";
  assert.throws(() => validateSourceMetadata(metadata, altered, altered), /official npm/);
  altered.packages["node_modules/synthetic"].resolved = "https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz";
  altered.packages["node_modules/synthetic"].integrity = "";
  assert.throws(() => validateSourceMetadata(metadata, altered, altered), /integrity-pinned/);
});

test("source tree rejects symlinks, submodules, private artifacts, traversal and oversize entries", () => {
  const entry = (name: string, mode = "100644", size = 10) => `${mode} blob ${"a".repeat(40)} ${size}\t${name}\0`;
  const good = ["package.json", "package-lock.json", "npm-shrinkwrap.json", ...sources].map(name => entry(name)).join("");
  assert.equal(validateCommittedTree(good + entry(".env.example")).files, 11);
  assert.equal(validateCommittedTree(good + entry("src/admin-auth.ts") + entry("tests/admin-auth.test.ts")).files, 12);
  for (const bad of [entry("link", "120000"), entry("submodule", "160000"), entry(".env"), entry("nested/.npmrc"),
    entry("artifacts/private.png"), entry("state.json"), entry("experience.json"), entry("admin-auth.v2"), entry("installation.json"),
    entry("../escape"), entry("huge", "100644", 21 * 1024 * 1024)])
    assert.throws(() => validateCommittedTree(good + bad));
});

test("source --check does not write source, fetch dependencies or invoke installation", async () => {
  const item = await fixture();
  try {
    const before = await fs.readFile(path.join(item.root, "package.json"));
    const result = await installFromSource({ ...item.options, mode: "check" });
    assert.equal(result.status, "prerequisites-checked");
    assert.equal(result.networkUsed, false);
    assert.equal(result.installed, false);
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(await fs.readFile(path.join(item.root, "package.json")), before);
    assert.equal(item.workspaces.size, 0);
    assert.ok(item.calls.every(call => !call.arguments_.includes("ci") && !call.command.endsWith("Install.command")));
    assert.ok(item.calls.every(call => call.options.env.NODE_OPTIONS === undefined && call.options.env.ABILOCK_DEVELOPMENT === undefined));
    const npmVersion = item.calls.find(call => call.arguments_[0] === "--version")!;
    assert.ok(npmVersion.arguments_.includes("--userconfig=/dev/null"));
    assert.ok(npmVersion.arguments_.some(value => value.startsWith("--globalconfig=") && value !== "--globalconfig=/dev/null"));
    assert.equal(npmVersion.options.cwd, "/usr/bin");
  } finally { await item.cleanup(); }
});

test("source preflight rejects unsupported platforms, root, old Node and uncommitted edits", async () => {
  const item = await fixture();
  try {
    await assert.rejects(installFromSource({ ...item.options, mode: "check", platform: "linux" }), /macOS only/);
    await assert.rejects(installFromSource({ ...item.options, mode: "check", uid: 0 }), /without sudo/);
    await assert.rejects(installFromSource({ ...item.options, mode: "check", nodeVersion: "22.11.0" }), /22.12/);
    await fs.appendFile(path.join(item.root, "skills/abilock/SKILL.md"), "unsaved user change");
    await assert.rejects(installFromSource({ ...item.options, mode: "check" }), /tracked changes/);
    assert.equal(item.workspaces.size, 0);
    assert.match(await fs.readFile(path.join(item.root, "skills/abilock/SKILL.md"), "utf8"), /unsaved user change/);
  } finally { await item.cleanup(); }
});

test("source prepare-only uses committed snapshot, retains verified bundle and cleans only its build workspace", async () => {
  const item = await fixture();
  try {
    const result = await installFromSource({ ...item.options, mode: "prepare" });
    assert.equal(result.status, "prepared");
    assert.equal(result.installed, false);
    assert.equal(result.publicBundleVerified, true);
    assert.equal(result.systemPreflight, false);
    assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
    await fs.access(path.join(result.bundle, "Install.command"));
    await assert.rejects(fs.access(path.join(path.dirname(result.bundle), "source")));
    await fs.access(path.join(item.root, ".env"));
    assert.ok(item.calls.some(call => call.arguments_.includes("--ignore-scripts") && call.arguments_.includes("--registry=https://registry.npmjs.org")));
    const dependencyInstall = item.calls.find(call => call.arguments_[0] === "ci")!;
    assert.ok(dependencyInstall.arguments_.some(value => value.startsWith("--userconfig=") && value !== "--userconfig=/dev/null"));
    assert.equal(dependencyInstall.options.env.npm_config_globalconfig, "/dev/null");
    const check = item.calls.findIndex(call => call.arguments_[0] === "run" && call.arguments_[1] === "check");
    const validation = item.calls.findIndex(call => call.command === "/usr/bin/python3" && call.arguments_.includes(publicBundleValidationScript));
    assert.ok(check > 0 && validation > check);
    assert.deepEqual(item.calls[validation].arguments_.slice(0, 3), ["-I", "-c", publicBundleValidationScript]);
    assert.match(publicBundleValidationScript, /installer\['validate_bundle'\]/);
    assert.doesNotMatch(publicBundleValidationScript, /check_installation|__main__/);
    assert.equal(item.calls.filter(call => call.arguments_.includes("--check") || call.arguments_.includes("--bundle")).length, 0);
    assert.equal(item.calls.filter(call => call.command.endsWith("Install.command")).length, 0);
  } finally { await item.cleanup(); }
});

test("source build or verification failure prevents authorization and retains only bounded diagnostics", async () => {
  for (const stage of ["ci", "scripts/prepare-isolation.mjs", publicBundleValidationScript, "--bundle"]) {
    const item = await fixture();
    try {
      item.fail(stage);
      await assert.rejects(installFromSource({ ...item.options, mode: "install" }), /No system installation was attempted/);
      assert.equal(item.calls.filter(call => call.command.endsWith("Install.command")).length, 0);
      for (const directory of item.workspaces) {
        assert.deepEqual(await fs.readdir(directory), ["build.log"]);
        const info = await fs.stat(path.join(directory, "build.log"));
        assert.equal(info.mode & 0o777, 0o600);
        assert.ok(info.size <= 512 * 1024);
      }
      await fs.access(path.join(item.root, ".env"));
    } finally { await item.cleanup(); }
  }
});

test("source installer calls only the prepared original entry once and never retries uncertain failures", async () => {
  for (const failed of [false, true]) {
    const item = await fixture();
    try {
      if (failed) item.fail("Install.command");
      if (failed) await assert.rejects(installFromSource({ ...item.options, mode: "install" }), /No retry was attempted/);
      else {
        const result = await installFromSource({ ...item.options, mode: "install" });
        assert.equal(result.installed, true);
        assert.equal(result.systemPreflight, true);
        assert.equal(result.publicBundleVerified, true);
      }
      const installs = item.calls.filter(call => call.command.endsWith("Install.command"));
      assert.equal(installs.length, 1);
      assert.deepEqual(installs[0].arguments_, []);
      assert.equal(installs[0].command, path.join(installs[0].options.cwd, "Install.command"));
      const publicValidation = item.calls.findIndex(call => call.arguments_.includes(publicBundleValidationScript));
      const hostPreflight = item.calls.findIndex(call => call.arguments_.includes("--check") && call.arguments_.includes("--bundle"));
      assert.ok(publicValidation > 0 && hostPreflight > publicValidation && hostPreflight < item.calls.indexOf(installs[0]));
      for (const directory of item.workspaces) {
        await fs.access(path.join(directory, "bundle/manifest.json"));
        await assert.rejects(fs.access(path.join(directory, "source")));
      }
    } finally { await item.cleanup(); }
  }
});
