// Build the distributable Skill from the current public npm runtime.
// Platform installers are packaged separately because they contain native runtimes.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
if (pkg.name !== "abilock" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
  throw new Error("Invalid Abilock package metadata.");
const output = path.join(root, "artifacts/packages");
await fs.mkdir(output, { recursive: true });
const packed = await run(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", output,
    "--cache", path.join(output, ".npm-pack-cache")],
  {
    cwd: root,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const records = JSON.parse(packed.stdout);
if (
  records.length !== 1 ||
  records[0].filename !== `abilock-${pkg.version}.tgz`
)
  throw new Error("Unexpected npm package output.");
const files = records[0].files.map((entry) => entry.path);
if (
  files.some((name) =>
    /(?:^|\/)\.env(?:$|\.(?!example$))|(?:^|\/)state\.json$|(?:^|\/)service\.env$/.test(
      name,
    ),
  ) ||
  files.some((name) => name.startsWith("skills/abilock/assets/"))
)
  throw new Error("The npm package contains a private or recursive asset.");
for (const required of [
  "bin/abl.mjs",
  "bin/app.mjs",
  "bin/install-bundle.mjs",
  "bin/windows-transport.mjs",
  "dist/src/windows-worker.js",
  "scripts/windows/Install-Abilock.ps1",
  "scripts/windows/git-runtime.json",
  "desktop/macos/Abilock.app/Contents/MacOS/Abilock",
])
  if (!files.includes(required))
    throw new Error(`Missing runtime file: ${required}`);
const archive = path.join(output, records[0].filename);
const bytes = await fs.readFile(archive);
const skill = path.join(root, "skills/abilock");
await fs.mkdir(path.join(skill, "assets"), { recursive: true });
await fs.writeFile(path.join(skill, "assets/abilock-runtime.tgz"), bytes);
const manifest = {
  name: "abilock",
  version: pkg.version,
  runtime: "abilock-runtime.tgz",
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  executable: "abl",
  minimumNodeVersion: "22.12.0",
  minimumMacOSVersion: "13.0",
  localMode: "macOS and Windows isolated one-shot CLI",
  firstConfiguration: "system authorization; no Abilock daemon",
  nativeFiles: "macOS arm64/x64 and Windows native host",
  installationTools:
    "complete platform package recommended; macOS system Python 3 and otool required",
  remoteMode: "explicit existing gateway only",
  minimumIsolatedClientVersion: "2.1.0",
  desktopVersion: pkg.version,
  platformPackages: ["macos-arm64", "windows-arm64", "windows-x64"].map(
    (platform) => `abilock-${pkg.version}-${platform}.zip`,
  ),
  platformPackageAvailability:
    "These are expected names, not download or availability claims. Use the delivered project README and release files for available platform versions.",
  privateRuntimeUpgrade:
    "use the verified platform installer; preserve account identity and private data",
  longHttpRequirements: {
    client: "2.1.3",
    protectedRuntime: "2.1.3",
    defaultTimeoutMs: 420000,
    maximumTimeoutMs: 420000,
  },
};
await fs.writeFile(
  path.join(skill, "assets/runtime-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const staging = await fs.mkdtemp(path.join(output, ".skill-stage-"));
try {
  await fs.cp(skill, path.join(staging, "abilock"), {
    recursive: true,
    dereference: false,
  });
  const zip = path.join(output, `abilock-skill-${pkg.version}.zip`);
  await fs.rm(zip, { force: true });
  await run("/usr/bin/zip", ["-q", "-r", zip, "abilock"], {
    cwd: staging,
    timeout: 120000,
  });
  await fs.writeFile(
    path.join(output, `abilock-skill-${pkg.version}.json`),
    JSON.stringify(
      {
        version: pkg.version,
        runtime: path.basename(archive),
        runtimeSha256: manifest.sha256,
        skill: path.basename(zip),
        skillSha256: crypto
          .createHash("sha256")
          .update(await fs.readFile(zip))
          .digest("hex"),
        runtimeFiles: files.length,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ runtime: archive, skill: zip, files: files.length }),
  );
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
