import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./schema.js";

export const isolatedInstallRoot = "/usr/local/libexec/abilock";
export const isolatedProgramRoot = `${isolatedInstallRoot}/runtime`;
export const isolatedDataRoot = "/private/var/db/abilock";
export const isolatedNode = `${isolatedInstallRoot}/node`;
export const isolatedLauncher = `${isolatedInstallRoot}/launch`;

function invalid() {
  return new AppError(
    503,
    "ISOLATION_INVALID",
    "隔离执行程序不可用；请在可信终端重新安装，不会回退到普通用户执行",
  );
}

/** Fixed paths and effective identity are validated before loading any secret. */
export async function assertIsolatedEnvironment() {
  const uid = process.getuid?.();
  const euid = process.geteuid?.();
  if (
    uid === undefined ||
    uid === 0 ||
    euid !== uid ||
    process.env.HOME !== isolatedDataRoot ||
    ![
      path.join(isolatedDataRoot, "tmp"),
      path.join(isolatedDataRoot, "tmp") + "/",
    ].includes(process.env.TMPDIR ?? "") ||
    process.cwd() !== isolatedProgramRoot ||
    process.execPath !== isolatedNode ||
    Object.keys(process.env).some((name) =>
      /^(ABILOCK|PERMIVELO|COI)_|^(NODE_|DYLD_|LD_)/.test(name),
    )
  )
    throw invalid();
  try {
    for (const file of [
      isolatedInstallRoot,
      isolatedProgramRoot,
      isolatedNode,
      path.join(isolatedProgramRoot, "dist/src/isolated-worker.js"),
      path.join(isolatedProgramRoot, "dist/src/local-config.js"),
    ]) {
      const stat = await fs.lstat(file);
      if (
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        stat.mode & 0o022 ||
        (!stat.isDirectory() && !stat.isFile())
      )
        throw invalid();
    }
    const data = await fs.lstat(isolatedDataRoot);
    if (
      !data.isDirectory() ||
      data.isSymbolicLink() ||
      data.uid !== uid ||
      data.mode & 0o077
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}

export async function assertIsolatedAdmin() {
  try {
    const uid = process.getuid?.();
    const values: string[] = [];
    for (const name of ["admin-auth.json", "admin-auth.v2"]) {
      const file = path.join(isolatedDataRoot, "data", name);
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        stat.mode & 0o077 ||
        stat.size > 4096
      )
        throw invalid();
      values.push(await fs.readFile(file, "utf8"));
    }
    const record = JSON.parse(values[0]) as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.algorithm !== "scrypt" ||
      typeof record.salt !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.salt) ||
      typeof record.hash !== "string" ||
      !/^[a-f0-9]{128}$/.test(record.hash) ||
      values[1] !== "password-management-v2\n"
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}
