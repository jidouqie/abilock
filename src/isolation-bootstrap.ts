import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { z } from "zod";
import { loadLocalRuntime } from "./local-state.js";
import { assertPrivatePath, syncDirectory } from "./platform-files.js";
import { acquireProcessLock } from "./process-lock.js";
import { validPasswordLength } from "./password-policy.js";
import {
  assertIsolatedEnvironment,
  isolatedDataRoot,
} from "./isolated-environment.js";

const inputSchema = z
  .object({ password: z.string().min(8).max(1024) })
  .strict();
export async function readBootstrapPassword(input: Readable) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 8192) throw new Error("Invalid bootstrap input");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks);
  try {
    const data = inputSchema.parse(JSON.parse(text.toString("utf8")));
    if ([...data.password].length < 8 || [...data.password].length > 256)
      throw new Error("Invalid bootstrap input");
    return data.password;
  } finally {
    text.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Installer-only bootstrap. Ordinary execute/config entry points never call it. */
export async function initializeIsolatedAdmin(password: string) {
  await assertIsolatedEnvironment();
  await initializeAdminAtRoot(password, isolatedDataRoot);
}

const markerContents = "password-management-v2\n";
async function exists(file: string) {
  try { await fs.lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function writeAtomic(file: string, text: string, prefix: string) {
  const temporary = path.join(path.dirname(file), prefix + crypto.randomUUID());
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/** Used only after the platform-specific native identity check has succeeded. */
export async function initializeAdminAtRoot(password: string, dataRoot: string) {
  if (!validPasswordLength(password)) throw new Error("Invalid bootstrap input");
  const dataDir = path.join(dataRoot, "data");
  const runtime = await loadLocalRuntime({ dir: dataRoot, initializeEmptyDirectory: true });
  let lock: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
  try {
    // Store only serializes individual state commits. Bootstrap has its own
    // cross-process lock covering the complete authentication transaction.
    lock = await acquireProcessLock(path.join(dataDir, "bootstrap.lock"), { busyCode: "BOOTSTRAP_BUSY" });
    for (const name of ["admin-auth.json", "admin-auth.v2"])
      if (await exists(path.join(dataDir, name))) throw new Error("Admin already initialized");
    const salt = crypto.randomBytes(32).toString("hex");
    const hash = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(salt, "hex"), 64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, value) => error ? reject(error) : resolve(value));
    });
    try {
      await writeAtomic(path.join(dataDir, "admin-auth.json"), JSON.stringify({
        version: 1, algorithm: "scrypt", salt, hash: hash.toString("hex"),
      }) + "\n", ".admin-bootstrap-");
    } finally { hash.fill(0); }
    await writeAtomic(path.join(dataDir, "admin-auth.v2"), markerContents, ".admin-marker-");
  } finally {
    try { await lock?.release(); }
    finally { await runtime.store.close(); }
  }
}

/** Installer-only recovery; never returns credentials or changes an existing password. */
export async function verifyAdminAtRoot(dataRoot: string): Promise<"initialized" | "setup-required"> {
  const dataDir = path.join(dataRoot, "data");
  try { await assertPrivatePath(dataDir, "directory"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "setup-required";
    throw error;
  }
  const lock = await acquireProcessLock(path.join(dataDir, "bootstrap.lock"), { busyCode: "BOOTSTRAP_BUSY" });
  try {
    const auth = path.join(dataDir, "admin-auth.json"), marker = path.join(dataDir, "admin-auth.v2");
    const hasAuth = await exists(auth), hasMarker = await exists(marker);
    if (!hasAuth && !hasMarker) return "setup-required";
    if (!hasAuth) throw new Error("Partial initialization");
    const stat = await assertPrivatePath(auth, "file");
    if (stat.size > 4096) throw new Error("Invalid authentication record");
    const record = JSON.parse(await fs.readFile(auth, "utf8"));
    if (record.version !== 1 || record.algorithm !== "scrypt" ||
        typeof record.salt !== "string" || !/^[a-f0-9]{64}$/.test(record.salt) ||
        typeof record.hash !== "string" || !/^[a-f0-9]{128}$/.test(record.hash))
      throw new Error("Invalid authentication record");
    let contents = "";
    if (hasMarker) {
      const markerStat = await assertPrivatePath(marker, "file");
      if (markerStat.size > 4096) throw new Error("Invalid authentication marker");
      contents = await fs.readFile(marker, "utf8");
      // Only a missing/empty/interrupted fixed marker is repairable. Unknown
      // bytes are retained for review, never treated as a new configuration.
      if (!markerContents.startsWith(contents)) throw new Error("Invalid authentication marker");
    }
    const runtime = await loadLocalRuntime({ dir: dataRoot, readOnly: true, requireExisting: true });
    await runtime.store.close();
    if (!hasMarker || contents !== markerContents)
      await writeAtomic(marker, markerContents, ".admin-marker-");
    return "initialized";
  } finally { await lock.release(); }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  if (process.argv.slice(2).length !== 0) {
    process.stderr.write("ISOLATION_INVALID: 安装入口不接受额外参数\n");
    process.exitCode = 2;
  } else {
    void (async () => {
      try {
        // Validate the fixed identity before accepting the private input.
        await assertIsolatedEnvironment();
        await initializeIsolatedAdmin(
          await readBootstrapPassword(process.stdin),
        );
        process.stdout.write(
          JSON.stringify({ ok: true, event: "initialized" }) + "\n",
        );
      } catch {
        process.stderr.write("ISOLATION_BOOTSTRAP_FAILED: 初次配置未完成\n");
        process.exitCode = 3;
      }
    })();
  }
}
