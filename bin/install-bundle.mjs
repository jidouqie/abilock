import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
export const protectedRoot = "/usr/local/libexec/abilock";
export const systemCommand = "/usr/local/bin/abl";
export const cliWrapper = '#!/bin/sh\nexec /usr/local/libexec/abilock/node /usr/local/libexec/abilock/runtime/bin/abl.mjs "$@"\n';
const digestOf = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * @typedef {{ dev: number, ino: number, uid: number, mode: number, size: number }} EntryState
 * @param {string} file
 * @returns {Promise<(EntryState & ({ kind: "link", target: string } | { kind: "directory" | "file" })) | null>}
 */
async function snapshot(file) {
  try {
    const info = await fs.lstat(file);
    const state = { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode, size: info.size };
    if (info.isSymbolicLink()) return { ...state, kind: "link", target: await fs.readlink(file) };
    if (info.isDirectory()) return { ...state, kind: "directory" };
    if (info.isFile() && info.nlink === 1) return { ...state, kind: "file" };
    throw new Error("A public installation entry has an unsupported file type.");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writableParent(destination, uid) {
  let parent = path.dirname(destination);
  while (!(await snapshot(parent))) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error("A public installation directory is unavailable.");
    parent = next;
  }
  const info = await fs.stat(parent);
  if (!info.isDirectory() || info.uid !== uid)
    throw new Error("A public installation directory is not owned by the signed-in user.");
  await fs.access(parent, fs.constants.W_OK | fs.constants.X_OK);
}

async function knownNpmCli(file) {
  const entry = await snapshot(file);
  if (!entry || entry.kind !== "link") return false;
  const target = path.resolve(path.dirname(file), entry.target);
  if (!target.endsWith("/lib/node_modules/abilock/bin/abl.mjs")) return false;
  const metadataFile = path.resolve(path.dirname(target), "../package.json");
  const metadata = await snapshot(metadataFile);
  if (!metadata || metadata.kind !== "file" || metadata.size > 65536) return false;
  try {
    const value = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    return value.name === "abilock" && value.bin?.abl === "bin/abl.mjs";
  } catch { return false; }
}

async function knownCli(file, entry, fixedCommand) {
  if (!entry) return true;
  if (entry.kind === "link") {
    if (path.resolve(path.dirname(file), entry.target) === fixedCommand) return true;
    return knownNpmCli(file);
  }
  return entry.kind === "file" && entry.size === Buffer.byteLength(cliWrapper) &&
    await fs.readFile(file, "utf8") === cliWrapper;
}

async function knownSkill(directory) {
  let target;
  try { target = await fs.realpath(directory); } catch { return false; }
  const file = path.join(target, "SKILL.md"), info = await snapshot(file);
  if (!info || info.kind !== "file" || info.size > 65536) return false;
  const text = await fs.readFile(file, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return !!frontmatter && /^name:\s*(?:abilock|"abilock"|'abilock')\s*$/m.test(frontmatter[1]);
}

async function firstPathCommand(pathValue) {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "abl");
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; }
    catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  return null;
}

// Public-only preparation is separate from authorization. Tests use fake roots;
// the executable entry always uses the fixed production roots below.
export async function planPublicBindings({ home = os.homedir(), uid = process.getuid(),
  pathValue = process.env.PATH ?? "", root = protectedRoot, fixedCommand = systemCommand } = {}) {
  const links = [];
  async function link(destination, target, kind) {
    const before = await snapshot(destination);
    if (before?.kind === "link" && path.resolve(path.dirname(destination), before.target) === target) return;
    if (before && before.uid !== uid) throw new Error("An existing public entry is not owned by the signed-in user.");
    if (kind === "app" && before) throw new Error("An unrelated Abilock.app already exists. It was not replaced.");
    if (kind === "cli" && !(await knownCli(destination, before, fixedCommand)))
      throw new Error("An unrelated abl command already exists. It was not replaced.");
    if (kind === "skill" && before && !(await knownSkill(destination)))
      throw new Error("An unrelated abilock Skill already exists. It was not replaced.");
    await writableParent(destination, uid);
    links.push({ destination, target, kind, before });
  }
  const current = await firstPathCommand(pathValue);
  if (current && path.resolve(current) !== fixedCommand) await link(current, fixedCommand, "cli");
  else if (!current && pathValue.split(path.delimiter).includes(path.join(home, ".local/bin")))
    await link(path.join(home, ".local/bin/abl"), fixedCommand, "cli");
  if (!(await knownCli(fixedCommand, await snapshot(fixedCommand), fixedCommand)))
    throw new Error("An unrelated abl command exists at the system path. It was not replaced.");
  await link(path.join(home, "Applications/Abilock.app"), path.join(root, "runtime/desktop/Abilock.app"), "app");
  for (const container of [".codex/skills", ".claude/skills", ".agents/skills"])
    await link(path.join(home, container, "abilock"), path.join(root, "runtime/skills/abilock"), "skill");
  return { links, pathValue, fixedCommand, application: path.join(home, "Applications/Abilock.app") };
}

export async function applyPublicBindings(plan) {
  const backups = [];
  for (const item of plan.links) {
    if (JSON.stringify(await snapshot(item.destination)) !== JSON.stringify(item.before))
      throw new Error("A public installation entry changed. Existing files were retained.");
    await fs.mkdir(path.dirname(item.destination), { recursive: true });
    const temporary = `${item.destination}.abilock-${crypto.randomUUID()}`;
    const backup = item.before?.kind === "directory" ? `${item.destination}.backup-${crypto.randomUUID()}` : null;
    await fs.symlink(item.target, temporary);
    try {
      if (JSON.stringify(await snapshot(item.destination)) !== JSON.stringify(item.before))
        throw new Error("A public installation entry changed. Existing files were retained.");
      if (backup) await fs.rename(item.destination, backup);
      try {
        if (item.before && !backup) await fs.rename(temporary, item.destination);
        else {
          // Exclusive creation preserves a conflicting name added after preflight.
          await fs.symlink(item.target, item.destination);
          await fs.unlink(temporary);
        }
      } catch (error) {
        if (backup && !(await snapshot(item.destination))) await fs.rename(backup, item.destination);
        throw error;
      }
      if (backup) backups.push(backup);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  const resolved = await firstPathCommand(plan.pathValue);
  if (resolved && await fs.realpath(resolved) !== await fs.realpath(plan.fixedCommand))
    throw new Error("PATH still resolves to another command. Use /usr/local/bin/abl explicitly.");
  return { backups, command: resolved ?? plan.fixedCommand };
}

async function protectedBundleReady(digest) {
  for (const file of [path.join(protectedRoot, "manifest.json"), systemCommand]) {
    const info = await snapshot(file);
    if (!info || info.kind !== "file" || info.uid !== 0 || info.mode & 0o022) return false;
    if (file === systemCommand && (info.mode & 0o777) !== 0o555) return false;
  }
  return digestOf(await fs.readFile(path.join(protectedRoot, "manifest.json"))) === digest &&
    await fs.readFile(systemCommand, "utf8") === cliWrapper;
}

export async function installBundle() {
  if (process.platform !== "darwin" || process.argv.length !== 3 || !process.getuid || process.getuid() < 500)
    throw new Error("Run the installer as the signed-in macOS user.");
  const bundle = await fs.realpath(process.argv[2]);
  const bytes = await fs.readFile(path.join(bundle, "manifest.json"));
  const manifest = JSON.parse(bytes.toString("utf8")), digest = digestOf(bytes);
  if (manifest.platform !== "darwin" || manifest.version !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.runtimeVersion))
    throw new Error("The installation manifest is invalid.");
  const plan = await planPublicBindings();
  process.stdout.write("Checking the complete Abilock package before requesting system authorization.\n");
  const installer = path.join(bundle, "runtime/scripts/isolation-install.py");
  try { await run("/usr/bin/python3", ["-I", installer, "--check", "--bundle", bundle, "--digest", digest],
    { timeout: 180000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error("Package preflight failed. Existing data was not changed. Check the command path, system Python 3, and Apple command-line tools."); }
  if (!(await protectedBundleReady(digest))) {
    const installed = await run(path.join(bundle, "authorize"), [bundle, digest], { timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    if (installed.stdout.trim() !== "Abilock isolated runtime installed.")
      throw new Error("The installer did not return a completion receipt.");
  }
  if (!(await protectedBundleReady(digest))) throw new Error("The protected installation could not be verified.");
  const result = await applyPublicBindings(plan);
  for (const backup of result.backups) process.stdout.write(`Previous Skill preserved: ${backup}\n`);
  process.stdout.write(`Abilock installed. CLI location: ${result.command}\n`);
  process.stdout.write("AI calls run on demand and exit. Shell settings were not changed.\n");
  try { await run("/usr/bin/open", [plan.application], { timeout: 10000, maxBuffer: 1024 }); }
  catch { process.stdout.write("The app could not be opened automatically. Open Abilock from Applications.\n"); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  installBundle().catch((error) => {
    const message = error instanceof Error && typeof error.message === "string" &&
      [...error.message].every((character) => character === "\n" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) <= 126))
      ? error.message : "Abilock installation did not complete. Existing data was retained.";
    process.stderr.write(message + "\n");
    process.exitCode = 3;
  });
