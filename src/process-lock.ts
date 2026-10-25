import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AppError } from "./schema.js";
import { windowsHostEnvironment, windowsPaths } from "./windows-paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root =
  path.basename(path.dirname(here)) === "dist"
    ? path.resolve(here, "../..")
    : path.resolve(here, "..");
function executable() {
  if (path.basename(root) === "runtime") return path.join(root, "../file-lock");
  return process.platform === "darwin"
    ? path.join(root, "native/prebuilt", process.arch, "file-lock")
    : path.join(root, "native/file-lock");
}

export async function acquireProcessLock(
  filename: string,
  options: { signal?: AbortSignal; busyCode?: string } = {},
): Promise<{ release(): Promise<void> }> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32")
    return acquireWindowsLock(filename, options);
  const helper = executable();
  const binary = await fs.lstat(helper).catch(() => undefined);
  if (
    !binary?.isFile() ||
    binary.isSymbolicLink() ||
    !(binary.mode & 0o111) ||
    binary.mode & 0o022
  )
    throw new AppError(
      503,
      "LOCK_RUNTIME_REQUIRED",
      "缺少可信文件锁组件，请更新完整运行包",
    );
  const handle = await fs.open(
    filename,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let held = false,
    released = false;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== process.getuid?.() ||
      opened.mode & 0o077
    )
      throw new AppError(503, "LOCK_INVALID", "文件锁状态无效");
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(helper, [], {
        stdio: ["ignore", "pipe", "ignore", handle.fd],
        env: { PATH: "/usr/bin:/bin" },
        cwd: root,
      });
      let output = "",
        aborted = false;
      const cancel = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(cancel, 5000);
      timer.unref();
      options.signal?.addEventListener("abort", cancel, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      };
      child.stdout!.on("data", (bytes: Buffer) => {
        if (output.length + bytes.length > 32) cancel();
        else output += bytes.toString("ascii");
      });
      child.once("error", () => {
        cleanup();
        reject(
          new AppError(503, "LOCK_RUNTIME_REQUIRED", "无法启动文件锁组件"),
        );
      });
      child.once("close", (code) => {
        cleanup();
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (code === 75)
          reject(
            new AppError(
              409,
              options.busyCode ?? "CONFIG_BUSY",
              "资源正在使用，请稍后重试",
            ),
          );
        else if (aborted || code !== 0 || output !== "LOCKED\n")
          reject(new AppError(503, "LOCK_FAILED", "无法取得文件锁"));
        else resolve();
      });
      if (options.signal?.aborted) cancel();
    });
    options.signal?.throwIfAborted();
    const current = await fs.lstat(filename);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new AppError(409, "LOCK_CHANGED", "文件锁位置已变化");
    held = true;
    return {
      async release() {
        if (released) return;
        released = true;
        await handle.close();
      },
    };
  } finally {
    if (!held) await handle.close();
  }
}

async function acquireWindowsLock(
  filename: string,
  options: { signal?: AbortSignal; busyCode?: string },
) {
  const child = spawn(windowsPaths().host, ["file-lock", filename], {
    env: windowsHostEnvironment(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let held = false,
    released = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.stdin.on("error", () => {});
  // A lost writer lock invalidates the whole worker. Never continue a write
  // after an unexpectedly terminated native lock owner.
  child.once("exit", () => {
    if (held && !released) {
      process.stderr.write("LOCK_LOST: The storage lock was lost.\n");
      process.exit(3);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "",
        settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else {
          held = true;
          resolve();
        }
      };
      const cancel = () => {
        child.stdin.end();
        finish(
          new AppError(
            499,
            "CANCELLED",
            "Storage lock acquisition was cancelled",
          ),
        );
      };
      const timer = setTimeout(() => {
        child.stdin.end();
        child.kill();
        finish(
          new AppError(
            503,
            "LOCK_FAILED",
            "The storage lock could not be acquired",
          ),
        );
      }, 5000);
      options.signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (bytes: Buffer) => {
        output += bytes.toString("ascii");
        if (output.length > 32) {
          child.stdin.end();
          finish(new AppError(503, "LOCK_FAILED", "Invalid lock receipt"));
        } else if (output.replace(/\r/g, "") === "LOCKED\n") finish();
      });
      child.once("error", () =>
        finish(
          new AppError(
            503,
            "LOCK_RUNTIME_REQUIRED",
            "The native lock component is unavailable",
          ),
        ),
      );
      child.once("close", (code) =>
        finish(
          new AppError(
            code === 75 ? 409 : 503,
            code === 75 ? (options.busyCode ?? "CONFIG_BUSY") : "LOCK_FAILED",
            code === 75
              ? "Resource is busy; retry shortly"
              : "The storage lock could not be acquired",
          ),
        ),
      );
      if (options.signal?.aborted) cancel();
    });
  } catch (error) {
    released = true;
    child.stdin.end();
    child.kill();
    await closed;
    throw error;
  }
  return {
    async release() {
      if (released) return;
      released = true;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      timer.unref();
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
