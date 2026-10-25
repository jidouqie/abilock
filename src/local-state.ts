import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./schema.js";
import { Store } from "./store.js";
import { assertPrivatePath } from "./platform-files.js";

export type LocalStoreOptions = {
  readOnly?: boolean;
  dir?: string;
  signal?: AbortSignal;
  requireExisting?: boolean;
  // Internal trusted-install bootstrap only; never accepted from CLI or IPC.
  initializeEmptyDirectory?: boolean;
};
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const localPackageRoot = path.resolve(
  sourceDirectory,
  path.basename(path.dirname(sourceDirectory)) === "dist" ? "../.." : "..",
);
const keys = new Set([
  "ABILOCK_MASTER_KEY",
  "ABILOCK_EXEC_TOKEN",
  "ABILOCK_DATA_DIR",
  "ABILOCK_ADMIN_HOST",
  "ABILOCK_EXEC_HOST",
  "ABILOCK_ADMIN_PORT",
  "ABILOCK_EXEC_PORT",
]);

function configError() {
  return new AppError(
    409,
    "LOCAL_CONFIG_INVALID",
    "本机配置无效；不会覆盖或重新生成，请在可信环境检查配置",
  );
}
function required() {
  return new AppError(
    409,
    "CONFIG_REQUIRED",
    "请先运行 abl config 完成本机配置",
  );
}
function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppError(499, "CANCELLED", "配置页启动已取消");
}
function assertLocalEnvironment() {
  // Local processes must not inherit a remote/mock deployment's policy.
  // The CLI launches them with these prefixes removed, without loading values.
  if (
    Object.keys(process.env).some((name) =>
      /^(ABILOCK|PERMIVELO|COI)_/.test(name),
    )
  )
    throw new AppError(
      409,
      "LOCAL_ENV_CONFLICT",
      "本机执行环境与服务环境混用，请通过 abl 本机命令启动",
    );
}
function parseConfig(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !keys.has(match[1]) || Object.hasOwn(values, match[1]))
      throw configError();
    let value = match[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        throw configError();
      }
      if (typeof value !== "string") throw configError();
    }
    if (["\r", "\n", "\0"].some((char) => value.includes(char)))
      throw configError();
    values[match[1]] = value;
  }
  return values;
}
async function privatePath(filename: string, kind: "file" | "directory") {
  try { return await assertPrivatePath(filename, kind); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw configError();
  }
}
async function privateDirectory(dir: string) {
  await privatePath(dir, "directory");
}
async function createInitialConfiguration(
  rootDir: string,
  initializeEmptyDirectory = false,
) {
  // Exclusive directory creation also prevents two first-use processes from
  // regenerating a master key or altering an existing installation.
  try {
    await fs.mkdir(rootDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (!initializeEmptyDirectory) return;
      await privateDirectory(rootDir);
      const entries = await fs.readdir(rootDir);
      if (entries.length !== 0) {
        // Windows can create its profile AppData before the trusted bootstrap
        // writes service.env. It is not application state. Validate its private
        // ACL without reading, removing, or adopting any of its contents.
        const allowed = process.platform === "win32" ? ["tmp", "AppData"] : ["tmp"];
        if (entries.some((entry) => !allowed.includes(entry))) return;
        for (const entry of entries) await privateDirectory(path.join(rootDir, entry));
        if (entries.includes("tmp")) {
          const temporary = await fs.lstat(path.join(rootDir, "tmp"));
          if (
            (process.platform !== "win32" && temporary.uid !== process.getuid?.()) ||
            (await fs.readdir(path.join(rootDir, "tmp"))).length !== 0
          )
            throw configError();
        }
      }
    } else throw configError();
  }
  const contents =
    [
      `ABILOCK_MASTER_KEY=${crypto.randomBytes(32).toString("hex")}`,
      `ABILOCK_EXEC_TOKEN=${crypto.randomBytes(32).toString("hex")}`,
      `ABILOCK_DATA_DIR=${JSON.stringify(path.join(rootDir, "data"))}`,
      "ABILOCK_ADMIN_HOST=127.0.0.1",
      "ABILOCK_EXEC_HOST=127.0.0.1",
      "ABILOCK_ADMIN_PORT=4317",
      "ABILOCK_EXEC_PORT=4318",
    ].join("\n") + "\n";
  await fs.writeFile(path.join(rootDir, "service.env"), contents, {
    flag: "wx",
    mode: 0o600,
  });
}

/** Internal broker loading only. Never returns private configuration to the CLI. */
export async function loadLocalRuntime(options: LocalStoreOptions = {}) {
  assertNotCancelled(options.signal);
  assertLocalEnvironment();
  const rootDir = path.resolve(
    options.dir ?? path.join(os.homedir(), ".abilock"),
  );
  if (!options.readOnly && !options.requireExisting)
    await createInitialConfiguration(rootDir, options.initializeEmptyDirectory);
  let values: Record<string, string>;
  try {
    await privateDirectory(rootDir);
    const named = await privatePath(path.join(rootDir, "service.env"), "file");
    const handle = await fs.open(
      path.join(rootDir, "service.env"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192 || stat.dev !== named.dev || stat.ino !== named.ino)
        throw configError();
      values = parseConfig(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw required();
    if (error instanceof AppError) throw error;
    throw configError();
  }
  const master = values.ABILOCK_MASTER_KEY;
  const execToken = values.ABILOCK_EXEC_TOKEN;
  const dataDir = path.join(rootDir, "data");
  if (
    !/^[a-f0-9]{64}$/i.test(master ?? "") ||
    !/^[a-f0-9]{64}$/i.test(execToken ?? "") ||
    values.ABILOCK_DATA_DIR !== dataDir ||
    master.toLowerCase() === execToken.toLowerCase() ||
    [values.ABILOCK_ADMIN_HOST, values.ABILOCK_EXEC_HOST].some(
      (host) => host !== undefined && host !== "127.0.0.1",
    )
  )
    throw configError();
  for (const name of ["ABILOCK_ADMIN_PORT", "ABILOCK_EXEC_PORT"]) {
    const value = values[name];
    if (
      value !== undefined &&
      (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    )
      throw configError();
  }
  try {
    await privateDirectory(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw configError();
    if (options.readOnly || options.requireExisting) throw required();
  }
  let fresh = false;
  try {
    await privatePath(path.join(dataDir, "state.json"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw configError();
    fresh = true;
  }
  if ((options.readOnly || options.requireExisting) && fresh) throw required();
  const store = new Store(dataDir, master, [execToken], {
    readOnly: options.readOnly,
    signal: options.signal,
  });
  try {
    await store.init();
    assertNotCancelled(options.signal);
  } catch (error) {
    await store.close();
    if (
      error instanceof AppError &&
      ["CONFIG_REQUIRED", "CANCELLED", "CONFIG_BUSY"].includes(error.code)
    )
      throw error;
    throw configError();
  }
  return {
    store,
    execToken,
    rootDir,
    adminPort: Number(values.ABILOCK_ADMIN_PORT ?? 4317),
  };
}

export async function loadLocalStore(
  options: LocalStoreOptions = {},
): Promise<Store> {
  return (await loadLocalRuntime(options)).store;
}
