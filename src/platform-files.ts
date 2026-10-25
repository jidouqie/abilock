import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "./schema.js";
import { windowsHostEnvironment, windowsPaths } from "./windows-paths.js";

const run = promisify(execFile);
export async function assertPrivatePath(
  filename: string,
  kind?: "file" | "directory",
) {
  // Preserve ENOENT: callers distinguish a new file from an unsafe existing one.
  const stat = await fs.lstat(filename);
  if (
    stat.isSymbolicLink() ||
    (kind === "file" && !stat.isFile()) ||
    (kind === "directory" && !stat.isDirectory()) ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (stat.isFile() && stat.nlink !== 1)
  )
    throw new AppError(
      503,
      "PRIVATE_PATH_INVALID",
      "Private storage permissions are invalid",
    );
  if (process.platform === "win32") {
    try {
      const result = await run(
        windowsPaths().host,
        ["check-private", filename],
        {
          env: windowsHostEnvironment(),
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 1024,
        },
      );
      if (result.stdout.replace(/\r/g, "") !== "OK\n")
        throw new Error("Invalid receipt");
    } catch {
      throw new AppError(
        503,
        "PRIVATE_PATH_INVALID",
        "Private storage permissions are invalid",
      );
    }
  } else if (stat.mode & 0o077) {
    throw new AppError(
      503,
      "PRIVATE_PATH_INVALID",
      "Private storage permissions are invalid",
    );
  }
  return stat;
}

export async function syncDirectory(directory: string) {
  // Node's Windows backend cannot open directory handles for fsync. Individual
  // transaction files are flushed before their same-volume atomic replacement.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
