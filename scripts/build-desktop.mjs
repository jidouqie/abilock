import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin")
  throw new Error("Build the macOS app on macOS. Use native/desktop/windows/Build.ps1 for Windows.");
const options = process.argv.slice(2);
if (options.length > 1 || (options[0] && !path.isAbsolute(options[0])))
  throw new Error("Usage: node scripts/build-desktop.mjs [absolute-output-directory]");
const destination = options[0] ?? path.join(root, "artifacts/desktop");
const app = path.join(destination, "Abilock.app");
const contents = path.join(app, "Contents");
const executable = path.join(contents, "MacOS/Abilock");
const resources = path.join(contents, "Resources");
const packageData = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(packageData.version)) throw new Error("Invalid application version.");
await fs.mkdir(path.dirname(executable), { recursive: true });
await fs.mkdir(resources, { recursive: true });
const temporary = await fs.mkdtemp(path.join(destination, ".desktop-build-"));
try {
  const slices = [];
  for (const architecture of ["arm64", "x86_64"]) {
    const target = path.join(temporary, `Abilock-${architecture}`);
    execFileSync("/usr/bin/cc", ["-arch", architecture, "-mmacosx-version-min=13.0", "-fobjc-arc",
      "-O2", "-Wall", "-Wextra", "-Werror", "-fstack-protector-strong",
      "-framework", "AppKit", "-framework", "WebKit",
      path.join(root, "native/desktop/Abilock.m"), path.join(root, "native/desktop/desktop-policy.m"),
      "-o", target], { stdio: "inherit" });
    slices.push(target);
  }
  execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", executable], { stdio: "inherit" });
  const iconChunks = [];
  // ICNS supports PNG payloads directly; packaging these avoids depending on
  // iconutil's GUI image services in an unattended build environment.
  for (const [size, type] of [[16, "icp4"], [32, "icp5"], [64, "icp6"], [128, "ic07"],
    [256, "ic08"], [512, "ic09"], [1024, "ic10"]]) {
    const png = path.join(temporary, `icon-${size}.png`);
    execFileSync("/usr/bin/sips", ["-z", String(size), String(size),
      path.join(root, "web/assets/abilock-logo.png"), "--out", png], { stdio: "ignore" });
    const data = await fs.readFile(png);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    iconChunks.push(header, data);
  }
  const iconHeader = Buffer.alloc(8);
  iconHeader.write("icns", 0, "ascii");
  iconHeader.writeUInt32BE(8 + iconChunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  await fs.writeFile(path.join(resources, "Abilock.icns"), Buffer.concat([iconHeader, ...iconChunks]));
  await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.abilock.desktop</string>
<key>CFBundleName</key><string>Abilock</string>
<key>CFBundleDisplayName</key><string>Abilock</string>
<key>CFBundleExecutable</key><string>Abilock</string>
<key>CFBundleIconFile</key><string>Abilock.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${packageData.version}</string>
<key>CFBundleVersion</key><string>${packageData.version}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`);
  await fs.chmod(executable, 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--timestamp=none", app], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`Built ${app}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
