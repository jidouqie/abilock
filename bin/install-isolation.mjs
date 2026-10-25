import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareIsolation } from "../scripts/prepare-isolation.mjs";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const launch = "/usr/local/libexec/abilock/launch";
const installRoot = "/usr/local/libexec/abilock";
const transaction = "/private/var/db/.abilock-install-transaction";

export function compareRuntimeVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
      throw new Error("隔离运行包版本无效；不会覆盖现有安装");
    return value.split(".").map(Number);
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function installationState() {
  // Recovery metadata is root-only. Inspect only its directory, never its
  // content or a migrated private snapshot. The installer resolves it.
  try {
    const pending = await fs.lstat(transaction);
    if (!pending.isDirectory() || pending.uid !== 0 || (pending.mode & 0o7777) !== 0o700)
      throw new Error("隔离安装恢复目录无效");
    return "recover";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const info = await fs.lstat(launch);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o4755)
      throw new Error("隔离启动器无效；不会覆盖或退回同用户执行");
    const manifestPath = path.join(installRoot, "manifest.json");
    const metadata = await fs.lstat(manifestPath);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.nlink !== 1 ||
        (metadata.mode & 0o7777) !== 0o444 || metadata.size > 16 * 1024 * 1024)
      throw new Error("隔离运行包版本信息无效");
    const installed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const current = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (installed.version !== 1 || installed.platform !== "darwin")
      throw new Error("隔离运行包格式不兼容");
    return compareRuntimeVersions(current.version, installed.runtimeVersion) > 0 ? "upgrade" : "ready";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.lstat(installRoot);
    throw new Error("隔离安装不完整；不会覆盖或退回同用户执行");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return "install";
}

export async function ensureIsolatedInstallation() {
  if (process.platform === "win32") {
    const { ensureWindowsInstallation } = await import("./install-windows.mjs");
    return ensureWindowsInstallation();
  }
  if (process.platform !== "darwin" || !process.getuid || process.getuid() < 500)
    throw new Error("隔离安装目前支持 macOS 普通用户；不会退回同用户执行");
  const state = await installationState();
  if (state === "ready") return;
  const destination = path.join(os.tmpdir(), "abilock-install-" + crypto.randomUUID());
  try {
    process.stderr.write(state === "upgrade"
      ? "发现新版：检查运行包，随后由系统请求一次管理员授权更新。连接、密钥和手册保留。\n"
      : state === "recover" ? "检测到未完成安装：检查运行包，随后由系统请求一次管理员授权恢复并完成。\n"
        : "首次安装：准备权限隔离，随后由系统请求一次管理员授权。\n");
    const prepared = await prepareIsolation(destination, (message) => process.stderr.write(message + "\n"));
    // Validate the new bundle AND the current protected public runtime before
    // presenting a dialog. The privileged path repeats every trust check.
    await run("/usr/bin/python3", ["-I", path.join(packageRoot, "scripts/isolation-install.py"),
      "--check", "--bundle", prepared.bundle, "--digest", prepared.digest],
      { timeout: 180000, maxBuffer: 1024 * 1024 });
    const result = await run(path.join(prepared.bundle, "authorize"), [prepared.bundle, prepared.digest],
      { timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stdout.trim() !== "Abilock isolated runtime installed.")
      throw new Error("安装没有返回完成结果");
    if (await installationState() !== "ready")
      throw new Error("安装完成后的版本核对失败");
    process.stderr.write(state === "install" ? "权限隔离已安装。\n" : "权限隔离已更新。\n");
  } catch {
    throw Object.assign(new Error("隔离安装或更新未完成；原数据不会重置。关闭正在运行的 Abilock 调用和配置页后，在用户终端重试 abl config。"),
      { code: "ISOLATION_INSTALL", exit: 3 });
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
}
