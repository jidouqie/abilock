import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "darwin") {
  await fs.access(path.join(root, "native/prebuilt", process.arch, "file-lock"));
} else if (process.platform === "linux") {
  const output = path.join(root, "native/file-lock");
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2",
    path.join(root, "native/abilock-lock.c"), "-o", output], { stdio: "inherit" });
  await fs.chmod(output, 0o755);
} else if (process.platform === "win32") {
  // Windows uses the protected native Host. Compilation is performed by the
  // Windows release builder, never by an ordinary business request.
} else {
  throw new Error("The local execution core needs a supported native file-lock helper");
}
