import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./schema.js";
import { assertPrivatePath } from "./platform-files.js";
import { sameWindowsPath, windowsPaths } from "./windows-paths.js";

export const windowsRuntime = windowsPaths();
function invalid() {
  return new AppError(
    503,
    "ISOLATION_INVALID",
    "The protected Windows runtime is unavailable",
  );
}

export async function assertWindowsEnvironment() {
  if (
    process.platform !== "win32" ||
    !sameWindowsPath(process.execPath, windowsRuntime.node) ||
    !sameWindowsPath(process.cwd(), windowsRuntime.program) ||
    !sameWindowsPath(process.env.HOME ?? "", windowsRuntime.data) ||
    !sameWindowsPath(process.env.USERPROFILE ?? "", windowsRuntime.data) ||
    !sameWindowsPath(process.env.TEMP ?? "", windowsRuntime.temporary) ||
    Object.keys(process.env).some((name) =>
      /^(ABILOCK|PERMIVELO|COI)_|^(NODE_|DYLD_|LD_)/i.test(name),
    )
  )
    throw invalid();
  // The native check verifies the actual service SID and protected ACLs before
  // this process opens any configuration or secret. POSIX stat.mode is not ACL evidence.
  try {
    await assertPrivatePath(windowsRuntime.data, "directory");
  } catch {
    throw invalid();
  }
}

export async function assertWindowsAdmin() {
  try {
    const files = ["admin-auth.json", "admin-auth.v2"].map((name) =>
      path.join(windowsRuntime.data, "data", name),
    );
    for (const file of files) {
      const info = await assertPrivatePath(file, "file");
      if (info.size > 4096) throw invalid();
    }
    const record = JSON.parse(await fs.readFile(files[0], "utf8")) as Record<
      string,
      unknown
    >;
    if (
      record.version !== 1 ||
      record.algorithm !== "scrypt" ||
      typeof record.salt !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.salt) ||
      typeof record.hash !== "string" ||
      !/^[a-f0-9]{128}$/.test(record.hash) ||
      (await fs.readFile(files[1], "utf8")) !== "password-management-v2\n"
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}
