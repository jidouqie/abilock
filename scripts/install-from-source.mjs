// Build a committed source checkout, then use the existing platform installer.
// This entry never reads private Abilock data or accepts credentials or targets.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitOptions = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const requiredSources = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "scripts/install-from-source.mjs",
  "scripts/prepare-isolation.mjs", "scripts/build-isolation-launcher.mjs", "scripts/build-desktop.mjs",
  "scripts/isolation-install.py", "scripts/install-macos.sh", "skills/abilock/SKILL.md"];
// Use the original validator without invoking its host installation preflight.
// Preparation must not depend on an installed app being idle, or inspect data.
export const publicBundleValidationScript = "import pathlib, runpy, sys; bundle = pathlib.Path(sys.argv[1]); " +
  "installer = runpy.run_path(str(bundle / 'runtime/scripts/isolation-install.py')); " +
  "installer['validate_bundle'](bundle, sys.argv[2]); print('Abilock public bundle verified.')";

export function parseSourceInstallOptions(arguments_) {
  if (arguments_.length === 0) return { mode: "install" };
  if (arguments_.length === 1 && arguments_[0] === "--check") return { mode: "check" };
  if (arguments_.length === 1 && arguments_[0] === "--prepare-only") return { mode: "prepare" };
  if (arguments_.length === 1 && arguments_[0] === "--help") return { mode: "help" };
  throw new Error("Usage: node scripts/install-from-source.mjs [--check | --prepare-only | --help]");
}

// Do not carry model, npm, Git, loader, test, or development overrides into a build.
export function sourceInstallEnvironment(environment) {
  const result = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TZ"])
    if (typeof environment[key] === "string") result[key] = environment[key];
  result.GIT_TERMINAL_PROMPT = "0";
  result.CI = "1";
  return result;
}

export function validateSourceMetadata(metadata, shrinkwrap, lock) {
  if (metadata.name !== "abilock" || !/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.bin?.abl !== "bin/abl.mjs")
    throw new Error("This checkout does not contain valid Abilock package metadata.");
  for (const item of [shrinkwrap, lock]) {
    if (item.name !== metadata.name || item.version !== metadata.version || item.lockfileVersion !== 3 ||
      item.packages?.[""]?.version !== metadata.version || item.packages?.[""]?.name !== metadata.name)
      throw new Error("The package version and dependency lock versions do not match.");
    for (const [name, record] of Object.entries(item.packages)) {
      if (name === "") continue;
      let url;
      try { url = new URL(record.resolved); } catch { throw new Error("A dependency has no pinned npm registry source."); }
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password ||
        url.search || url.hash || !/^sha512-[A-Za-z0-9+/]+=*$/.test(record.integrity ?? "") || record.link)
        throw new Error("Dependencies must use integrity-pinned official npm registry archives.");
    }
  }
  if (JSON.stringify(shrinkwrap) !== JSON.stringify(lock))
    throw new Error("The two dependency locks differ; reconcile them before installation.");
  return metadata.version;
}

export function validateCommittedTree(tree) {
  const names = new Set();
  let totalSize = 0;
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\s+(\d+)\t([^\0]+)$/.exec(entry);
    if (!match) throw new Error("The source tree contains a link, submodule, or unsupported entry.");
    const name = match[4];
    if (name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") ||
      [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\\"))
      throw new Error("The source tree contains an unsafe path.");
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|service\.env|state\.json|experience\.json|admin-auth(?:\.json|\.v[0-9]+)?|installation\.json|vault(?:\.json|\.db|\.enc)?|master[-_.]?key|node_modules|artifacts|data|backups?)(?:\/|$)/i.test(name) && name !== ".env.example")
      throw new Error("The source tree contains local configuration, data, or generated artifacts.");
    totalSize += Number(match[3]);
    if (Number(match[3]) > 20 * 1024 * 1024 || totalSize > 100 * 1024 * 1024 || names.size >= 10000)
      throw new Error("The committed source exceeds the installation size limit.");
    names.add(name);
  }
  for (const name of requiredSources)
    if (!names.has(name)) throw new Error("A required installer source is not committed.");
  return { files: names.size, bytes: totalSize };
}

async function readMetadata(root) {
  const items = [];
  for (const name of ["package.json", "npm-shrinkwrap.json", "package-lock.json"]) {
    const file = path.join(root, name), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024)
      throw new Error("Package metadata is not an ordinary bounded file.");
    items.push(JSON.parse(await fs.readFile(file, "utf8")));
  }
  return validateSourceMetadata(...items);
}

async function defaultRunner(command, arguments_, options) {
  return execute(command, arguments_, { ...options, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function sanitizeBuildOutput(output) {
  return String(output ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/g, text => {
      try { const url = new URL(text); return url.origin + url.pathname; } catch { return "[URL omitted]"; }
    });
}

// Injection is limited to in-process tests. The executable accepts only the three
// documented flags, and never obtains commands, roots, or installers from env.
export async function installFromSource({ root = sourceRoot, mode = "install", environment = process.env,
  platform = process.platform, architecture = process.arch, nodeVersion = process.versions.node,
  uid = process.getuid?.(), nodeExecutable = process.execPath, runner = defaultRunner,
  progress = message => console.error(message) } = {}) {
  if (!["check", "prepare", "install"].includes(mode)) throw new Error("Unknown source installation mode.");
  if (platform !== "darwin" || !["arm64", "x64"].includes(architecture))
    throw new Error("Source installation currently supports macOS only. Use a verified Windows platform package on Windows.");
  const versionParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (!versionParts || Number(versionParts[1]) < 22 || (Number(versionParts[1]) === 22 && Number(versionParts[2]) < 12))
    throw new Error("Source installation requires Node.js 22.12 or later and npm.");
  if (!Number.isInteger(uid) || uid < 500) throw new Error("Run this entry as the signed-in macOS user, without sudo.");
  root = await fs.realpath(root);
  const env = sourceInstallEnvironment(environment);
  env.PATH = path.dirname(nodeExecutable) + path.delimiter + (env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin");
  const baseOptions = { cwd: root, env, timeout: 30000 };
  const npm = path.join(path.dirname(nodeExecutable), "npm");
  async function run(command, arguments_, options = {}) {
    return runner(command, arguments_, { ...baseOptions, ...options });
  }
  async function git(arguments_) { return (await run("/usr/bin/git", [...gitOptions, "-C", root, ...arguments_])).stdout.trim(); }
  let commit, tree, version;
  try {
    const macVersion = (await run("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim();
    if (!/^\d+(?:\.\d+){1,2}$/.test(macVersion) || Number(macVersion.split(".")[0]) < 13)
      throw new Error("macOS 13 or later is required.");
    await run("/usr/bin/xcrun", ["--find", "clang"]);
    await run("/usr/bin/python3", ["-I", "-c", "import sys; assert sys.version_info >= (3, 8)"]);
    // A distinct absent global config avoids npm's double-loading rejection,
    // without creating a file during --check or reading the user's npm config.
    const absentConfig = path.join(os.tmpdir(), ".abilock-empty-npm-" + crypto.randomUUID());
    await run(npm, ["--version", "--userconfig=/dev/null", `--globalconfig=${absentConfig}`], { cwd: "/usr/bin" });
    try { commit = await git(["rev-parse", "--verify", "HEAD^{commit}"]); }
    catch { throw new Error("A committed source revision (Git HEAD) is required. No installation was attempted."); }
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("A committed source revision is required.");
    if (await git(["status", "--porcelain=v1", "--untracked-files=no"]))
      throw new Error("Commit or set aside tracked changes before building this revision; existing files were not changed.");
    tree = validateCommittedTree(await git(["ls-tree", "-r", "-l", "-z", "--full-tree", commit]));
    version = await readMetadata(root);
  } catch (error) {
    if (error instanceof Error && !Object.hasOwn(error, "cmd")) throw error;
    throw new Error("Source preflight failed. Check the committed checkout, npm beside Node, system Python 3, and Apple command-line tools. No installation was attempted.");
  }
  const source = { version, commit, platform, architecture, sourceFiles: tree.files, sourceBytes: tree.bytes };
  if (mode === "check") return { status: "prerequisites-checked", ...source, networkUsed: false, systemPreflight: false, installed: false };

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-source-"));
  await fs.chmod(workspace, 0o700);
  const build = path.join(workspace, "source"), bundle = path.join(workspace, "bundle");
  const archive = path.join(workspace, "source.tar"), cache = path.join(workspace, "npm-cache");
  const userConfig = path.join(workspace, "empty.npmrc"), buildLog = path.join(workspace, "build.log");
  await fs.writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
  await fs.writeFile(buildLog, "", { flag: "wx", mode: 0o600 });
  // Both paths must be different: npm rejects loading /dev/null twice.
  env.npm_config_userconfig = userConfig;
  env.npm_config_globalconfig = "/dev/null";
  env.npm_config_registry = "https://registry.npmjs.org";
  let prepared = false;
  let logBytes = 0;
  let stage = "source snapshot";
  async function log(output) {
    const remaining = 512 * 1024 - logBytes;
    if (remaining <= 0) return;
    const bytes = Buffer.from(sanitizeBuildOutput(output)).subarray(0, remaining);
    await fs.appendFile(buildLog, bytes);
    logBytes += bytes.length;
  }
  async function step(label, command, arguments_, options = {}) {
    stage = label;
    progress(label);
    await log(`\n${label}\n`);
    const heartbeat = setInterval(() => progress(`Still running: ${label}`), 30000);
    heartbeat.unref();
    // No administrator dialog or privileged installer output enters the log.
    const recordOutput = !command.endsWith("/Install.command");
    try {
      const result = await run(command, arguments_, { cwd: build, timeout: 300000, ...options });
      if (recordOutput) await log(`${result.stdout ?? ""}${result.stderr ?? ""}`);
      return result;
    } catch (error) {
      if (recordOutput) await log(`${error?.stdout ?? ""}${error?.stderr ?? ""}`);
      throw error;
    } finally { clearInterval(heartbeat); }
  }
  try {
    await fs.mkdir(build, { mode: 0o700 });
    await step("Creating a committed source snapshot.", "/usr/bin/git", [...gitOptions, "-C", root, "archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
    await step("Extracting the public source snapshot.", "/usr/bin/tar", ["-xf", archive, "-C", build]);
    if (await readMetadata(build) !== version) throw new Error("Snapshot metadata differs from the checked source.");
    await step("Installing locked build dependencies from npm.", npm, ["ci", "--ignore-scripts", "--registry=https://registry.npmjs.org",
      `--cache=${cache}`, `--userconfig=${userConfig}`, "--globalconfig=/dev/null", "--no-audit", "--no-fund"]);
    await step("Building native launchers.", nodeExecutable, ["scripts/build-isolation-launcher.mjs", "--prebuilt"]);
    await step("Running lint, type checks, tests, and the application build.", npm, ["run", "check"], { timeout: 600000 });
    await step("Building the desktop application.", nodeExecutable, ["scripts/build-desktop.mjs", path.join(build, "desktop/macos")]);
    await step("Preparing and verifying the standalone runtime.", nodeExecutable, ["scripts/prepare-isolation.mjs", bundle], { timeout: 600000 });
    const manifestFile = path.join(bundle, "manifest.json");
    const manifestBytes = await fs.readFile(manifestFile), manifest = JSON.parse(manifestBytes);
    if (manifest.runtimeVersion !== version || manifest.platform !== platform || manifest.arch !== architecture)
      throw new Error("Prepared runtime identity does not match the source and current platform.");
    const digest = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    await step("Validating public package integrity without checking the installed system.", "/usr/bin/python3",
      ["-I", "-c", publicBundleValidationScript, bundle, digest], { timeout: 180000 });
    if (mode === "install")
      await step("Checking host installation readiness before system authorization.", "/usr/bin/python3", ["-I", path.join(bundle, "runtime/scripts/isolation-install.py"),
        "--check", "--bundle", bundle, "--digest", digest], { timeout: 180000 });
    const result = { status: "prepared", ...source, bundle, manifestSha256: digest, buildLog,
      publicBundleVerified: true, systemPreflight: mode === "install", installed: false };
    await fs.writeFile(path.join(workspace, "source-build.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    prepared = true;
    if (mode === "install") {
      // The original installer owns authorization, protected backup, conflicts,
      // data preservation, and public Skill/CLI/app registration. Never retry it.
      await step("Starting the verified Install.command. Complete system authorization in macOS.", path.join(bundle, "Install.command"), [], { cwd: bundle, timeout: 660000 });
      result.status = "installer-completed";
      result.installed = true;
      await fs.writeFile(path.join(workspace, "source-build.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    }
    return result;
  } catch {
    throw new Error(prepared
      ? `Installation did not return success. No retry was attempted. Retained verified package: ${bundle}. Check the installer state before retrying.`
      : `Source preparation stopped at: ${stage} No system installation was attempted. Bounded local build diagnostics: ${buildLog}`);
  } finally {
    for (const file of [build, archive, cache, userConfig, ...(!prepared ? [bundle] : [])])
      await fs.rm(file, { recursive: true, force: true });
  }
}

const entryPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => "") : "";
if (entryPath === await fs.realpath(fileURLToPath(import.meta.url))) {
  try {
    const options = parseSourceInstallOptions(process.argv.slice(2));
    if (options.mode === "help") console.log("Usage: node scripts/install-from-source.mjs [--check | --prepare-only | --help]\nmacOS 13+, Node.js 22.12+, npm, Git, system Python 3 and Apple command-line tools required.\n--check performs read-only prerequisites and committed-source checks.\n--prepare-only builds and validates public package integrity; it does not check host installation readiness or install.\nThe default runs full host preflight and the original Install.command once; passwords stay in macOS/application UI.");
    else console.log(JSON.stringify(await installFromSource(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Source installation did not complete.");
    process.exitCode = 3;
  }
}
