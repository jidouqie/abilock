import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuilt = process.argv[2] === "--prebuilt";
const destination = path.resolve((prebuilt ? process.argv[3] : process.argv[2]) ??
  path.join(project, prebuilt ? "native/prebuilt" : "artifacts/isolation/native"));
if (process.platform !== "darwin") throw new Error("Isolation installation currently supports macOS only");
await fs.mkdir(destination, { recursive: true });
const installerHash = crypto.createHash("sha256").update(await fs.readFile(path.join(project, "scripts/isolation-install.py"))).digest("hex");
const architectures = prebuilt ? ["arm64", "x64"] : [process.arch];
const manifest = { version: 1, platform: "darwin", minimumNativeMacOS: "13.0", installerSha256: installerHash, sources: [], architectures: {} };
for (const name of ["native/abilock-launch.c", "native/abilock-lock.c", "native/abilock-password.m", "native/abilock-authorize.c", "scripts/isolation-install.py", "scripts/build-isolation-launcher.mjs"])
  manifest.sources.push({ path: name, sha256: crypto.createHash("sha256").update(await fs.readFile(path.join(project, name))).digest("hex") });
for (const architecture of architectures) {
  const target = prebuilt ? path.join(destination, architecture) : destination;
  await fs.mkdir(target, { recursive: true });
  const common = ["-arch", architecture === "x64" ? "x86_64" : "arm64", "-mmacosx-version-min=13.0",
    "-O2", "-Wall", "-Wextra", "-Werror", "-fstack-protector-strong"];
  execFileSync("/usr/bin/cc", [...common, "-std=c11", "-D_FORTIFY_SOURCE=2", path.join(project, "native/abilock-launch.c"),
    "-o", path.join(target, "launch")], { stdio: "inherit" });
  execFileSync("/usr/bin/cc", [...common, "-std=c11", "-D_FORTIFY_SOURCE=2", path.join(project, "native/abilock-lock.c"),
    "-o", path.join(target, "file-lock")], { stdio: "inherit" });
  execFileSync("/usr/bin/cc", [...common, "-fobjc-arc", "-framework", "AppKit", path.join(project, "native/abilock-password.m"),
    "-o", path.join(target, "password")], { stdio: "inherit" });
  execFileSync("/usr/bin/cc", [...common, "-DINSTALL_SCRIPT_SHA256=" + JSON.stringify(installerHash), "-framework", "Security",
    path.join(project, "native/abilock-authorize.c"), "-o", path.join(target, "authorize")], { stdio: "inherit" });
  // This separate acceptance binary has one compiled, root-only fixture path.
  // It has no setuid bit in the package and never points at the real vault.
  execFileSync("/usr/bin/cc", [...common, "-std=c11", "-D_FORTIFY_SOURCE=2", "-DABILOCK_LAUNCH_TEST_FIXTURE",
    '-DINSTALL="/private/var/db/.abilock-isolation-fixture/install"',
    '-DDATA="/private/var/db/.abilock-isolation-fixture/private"', '-DACCOUNT="nobody"',
    path.join(project, "native/abilock-launch.c"), "-o", path.join(target, "verify-launch")], { stdio: "inherit" });
  const files = [];
  for (const name of ["launch", "password", "authorize", "verify-launch", "file-lock"]) {
    const file = path.join(target, name);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--timestamp=none", file], { stdio: "inherit" });
    await fs.chmod(file, 0o755);
    files.push({ path: name, sha256: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"), mode: 0o755 });
  }
  manifest.architectures[architecture] = { files };
}
if (prebuilt)
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Abilock native installation files prepared.");
