import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin" || process.getuid() === 0 || process.argv.length !== 2)
  throw new Error("Run this fixed desktop fixture builder as a normal macOS user.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = "/private/tmp/abilock-desktop-mac-fixture";
const marker = path.join(directory, "abilock-build.marker");
try {
  const existing = await fs.lstat(directory);
  if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid() ||
      await fs.readFile(marker, "utf8") !== "Abilock desktop fixture") throw new Error("Unsafe fixture directory.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(marker, "Abilock desktop fixture", { mode: 0o600 });
}
for (const name of ["window-failed.txt", "window-loaded.txt", "fixture-started.json", "fixture-stopped.txt", "smoke-report.json"])
  await fs.rm(path.join(directory, name), { force: true });
await fs.copyFile(path.join(root, "native/desktop/mac-fixture.mjs"), path.join(directory, "mock-config.mjs"));
const node = await fs.realpath(process.execPath);
const launcher = `#include <unistd.h>\n#include <string.h>\nint main(int argc, char **argv) { if (argc != 2 || strcmp(argv[1], "config")) return 78; char *args[] = {${JSON.stringify(node)}, "/private/tmp/abilock-desktop-mac-fixture/mock-config.mjs", 0}; char *env[] = {"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", 0}; execve(args[0], args, env); return 78; }\n`;
await fs.writeFile(path.join(directory, "launch.c"), launcher);
execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", path.join(directory, "launch.c"), "-o", path.join(directory, "launch")]);
const app = path.join(directory, "Abilock Fixture.app");
const contents = path.join(app, "Contents");
await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
execFileSync("/usr/bin/cc", ["-fobjc-arc", "-DABILOCK_DESKTOP_TEST_FIXTURE", "-mmacosx-version-min=13.0", "-O2", "-Wall", "-Wextra", "-Werror",
  "-framework", "AppKit", "-framework", "WebKit", path.join(root, "native/desktop/Abilock.m"), path.join(root, "native/desktop/desktop-policy.m"),
  "-o", path.join(contents, "MacOS/AbilockFixture")], { stdio: "inherit" });
await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.abilock.desktop.fixture</string><key>CFBundleName</key><string>Abilock Fixture</string><key>CFBundleExecutable</key><string>AbilockFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--timestamp=none", app], { stdio: "inherit" });
console.log(app);
