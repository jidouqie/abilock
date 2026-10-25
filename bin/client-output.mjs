import fs from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  inspectOutputDestination,
  inspectSelectedPath,
  verifySelectedPath,
} from "./client-files.mjs";

const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}`;
const state = (stat) =>
  `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;

async function leaf(destination) {
  try {
    const snapshot = await inspectSelectedPath(destination);
    if (!snapshot.stat.isFile() || snapshot.stat.nlink !== 1n)
      throw new Error("output is not a selected regular file");
    return snapshot;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function createParents(parent) {
  const absolute = path.resolve(parent),
    root = path.parse(absolute).root;
  let snapshot = await inspectSelectedPath(root);
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    const next = path.join(snapshot.absolute, part);
    await verifySelectedPath(snapshot);
    let child;
    try {
      child = await inspectSelectedPath(next);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(next, { mode: 0o700 });
      child = await inspectSelectedPath(next);
    }
    await verifySelectedPath(snapshot);
    // inspectSelectedPath permits only the exact macOS /var and /tmp system
    // aliases. Walk their verified canonical directory rather than link stats.
    if (child.stat.isSymbolicLink())
      child = await inspectSelectedPath(child.canonical);
    if (!child.stat.isDirectory())
      throw new Error("output parent is not a directory");
    snapshot = child;
  }
  await verifySelectedPath(snapshot);
  return inspectSelectedPath(absolute);
}

export async function prepareOutput(destination, options = {}) {
  await inspectOutputDestination(destination);
  const absolute = path.resolve(destination);
  const parent = options.createParents
    ? await createParents(path.dirname(absolute))
    : await inspectSelectedPath(path.dirname(absolute));
  if (!parent.stat.isDirectory())
    throw new Error("output parent is not a directory");
  const dest = path.join(parent.canonical, path.basename(absolute));
  const temp = `${dest}.abl-${process.pid}-${crypto.randomUUID()}.part`;
  await inspectOutputDestination(dest);
  await inspectOutputDestination(temp);
  if (await leaf(temp)) throw new Error("output staging path exists");
  const previous = await leaf(dest);
  await verifySelectedPath(parent);
  return { dest, temp, parent, leaf: previous };
}

async function verifyOutput(plan) {
  await verifySelectedPath(plan.parent);
  await inspectOutputDestination(plan.dest);
  await inspectOutputDestination(plan.temp);
  const current = await leaf(plan.dest);
  if (plan.leaf) {
    if (!current || state(current.stat) !== state(plan.leaf.stat))
      throw new Error("output destination changed");
  } else if (current) throw new Error("output destination appeared");
  await verifySelectedPath(plan.parent);
}

async function cleanPart(plan, owned) {
  if (!owned) return;
  try {
    await verifySelectedPath(plan.parent);
    const stat = await fs.lstat(plan.temp, { bigint: true });
    if (
      stat.isFile() &&
      stat.nlink === 1n &&
      identity(stat) === identity(owned)
    )
      await fs.unlink(plan.temp);
  } catch {
    // Replaced paths are not owned cleanup, even when their names still match.
  }
}

/**
 * @param {import("./client-output.mjs").OutputPlan} plan
 * @param {import("node:stream").Readable | (() => import("node:stream").Readable)} source
 * @param {AbortSignal} signal
 * @param {{ audit?: (phase: "opened" | "written") => void | Promise<void> }} [options]
 */
export async function saveOutput(plan, source, signal, { audit } = {}) {
  let handle, owned;
  try {
    signal.throwIfAborted();
    await verifyOutput(plan);
    handle = await fs.open(
      plan.temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    owned = await handle.stat({ bigint: true });
    if (!owned.isFile() || owned.nlink !== 1n)
      throw new Error("invalid output staging file");
    // Module-only test seam; neither a request nor a CLI option can provide code.
    await audit?.("opened");
    await verifySelectedPath(plan.parent);
    const staging = await inspectSelectedPath(plan.temp);
    if (identity(staging.stat) !== identity(owned))
      throw new Error("output staging file changed");
    const writer = new Writable({
      write(chunk, _encoding, done) {
        void (async () => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (let offset = 0; offset < bytes.length;) {
            signal.throwIfAborted();
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.length - offset,
              null,
            );
            if (!bytesWritten) throw new Error("output write failed");
            offset += bytesWritten;
          }
        })().then(() => done(), done);
      },
    });
    signal.throwIfAborted();
    // Defer adapting an HTTP body until pipeline can own its error events.
    // Cancellation during path checks must not emit an unhandled stream error.
    await pipeline(typeof source === "function" ? source() : source, writer, {
      signal,
    });
    await handle.sync();
    const finished = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await audit?.("written");
    await verifyOutput(plan);
    const current = await verifySelectedPath(staging);
    if (current.stat.nlink !== 1n || state(current.stat) !== state(finished))
      throw new Error("output staging file changed");
    signal.throwIfAborted();
    // Checks detect observable changes; same-user path resolution is not atomic.
    await fs.rename(plan.temp, plan.dest);
    owned = undefined;
  } catch (error) {
    if (signal.aborted) throw error;
    throw Object.assign(new Error("响应保存失败或目标已变化；未覆盖目标文件"), {
      code: "FILE_OUTPUT",
      exit: 3,
    });
  } finally {
    await handle?.close().catch(() => {});
    await cleanPart(plan, owned);
  }
}
