import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Official Node LTS standalone distributions. These pinned SHA-256 values were
// obtained from nodejs.org/dist/v24.21.0/SHASUMS256.txt, not from Homebrew.
export const nodeRelease = Object.freeze({
  version: "v24.21.0",
  arm64: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  x64: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
});

async function copyPublicTree(source, destination) {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1))
    throw new Error("Public runtime files contain a link or special file.");
  if (info.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source))
      await copyPublicTree(path.join(source, entry), path.join(destination, entry));
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function downloadNode(destination, architecture) {
  const archiveName = `node-${nodeRelease.version}-darwin-${architecture}.tar.gz`;
  const response = await fetch(`https://nodejs.org/dist/${nodeRelease.version}/${archiveName}`, {
    redirect: "error", signal: globalThis.AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body) throw new Error("The official Node runtime could not be downloaded.");
  const archive = path.join(destination, "node-download.tar.gz");
  const handle = await fs.open(archive, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 100 * 1024 * 1024) throw new Error("The Node download exceeds the size limit.");
      hash.update(bytes);
      await handle.writeFile(bytes);
    }
  } finally { await handle.close(); }
  if (hash.digest("hex") !== nodeRelease[architecture]) throw new Error("The official Node checksum did not match.");
  const extracted = path.join(destination, "node-extract");
  await fs.mkdir(extracted);
  const member = archiveName.slice(0, -7) + "/bin/node";
  await run("/usr/bin/tar", ["-xzf", archive, "-C", extracted, member], { timeout: 30000 });
  await fs.copyFile(path.join(extracted, member), path.join(destination, "node"));
  await fs.chmod(path.join(destination, "node"), 0o755);
  await fs.rm(extracted, { recursive: true });
  await fs.unlink(archive);
  // No @rpath or Homebrew dependency may cross the protected runtime boundary.
  const linkage = await run("/usr/bin/otool", ["-L", path.join(destination, "node")]);
  for (const line of linkage.stdout.split("\n").slice(1)) {
    const dependency = line.trim().split(" (")[0];
    if (dependency && !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/"))
      throw new Error("The Node runtime depends on a user-writable library.");
  }
  const version = await run(path.join(destination, "node"), ["--version"]);
  if (version.stdout.trim() !== nodeRelease.version) throw new Error("The Node runtime version did not match.");
}

async function removeDependencyLinks(directory) {
  // npm's .bin links are not used by a fixed Node entry; exclude them entirely.
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.name === ".bin") await fs.rm(location, { recursive: true, force: true });
    else if (entry.isSymbolicLink()) throw new Error("Production dependencies contain an unsupported link.");
    else if (entry.isDirectory()) await removeDependencyLinks(location);
  }
}

async function copyNativeBinaries(destination, architecture) {
  const base = path.join(sourceRoot, "native/prebuilt");
  const manifest = JSON.parse(await fs.readFile(path.join(base, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.platform !== "darwin" || !Array.isArray(manifest.sources))
    throw new Error("The native runtime manifest is invalid.");
  for (const source of manifest.sources) {
    if (typeof source.path !== "string" || !/^(native\/abilock-[a-z]+\.(?:c|m)|scripts\/(?:isolation-install\.py|build-isolation-launcher\.mjs))$/.test(source.path))
      throw new Error("The native source manifest is invalid.");
    const hash = crypto.createHash("sha256").update(await fs.readFile(path.join(sourceRoot, source.path))).digest("hex");
    if (hash !== source.sha256) throw new Error("Native binaries do not match the current source.");
  }
  const entries = manifest.architectures?.[architecture]?.files;
  if (!Array.isArray(entries) || entries.length !== 5 ||
      new Set(entries.map((entry) => entry.path)).size !== 5)
    throw new Error("Native binaries for this architecture are missing.");
  for (const entry of entries) {
    if (!["launch", "password", "authorize", "verify-launch", "file-lock"].includes(entry.path) || entry.mode !== 0o755)
      throw new Error("A native runtime file type is invalid.");
    const source = path.join(base, architecture, entry.path);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o6000)
      throw new Error("Native binaries contain links or special permissions.");
    const bytes = await fs.readFile(source);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("A native binary checksum did not match.");
    await fs.copyFile(source, path.join(destination, entry.path));
    await fs.chmod(path.join(destination, entry.path), 0o755);
    await run("/usr/bin/codesign", ["--verify", "--strict", path.join(destination, entry.path)]);
  }
}

/**
 * @param {string} destination
 * @param {(message: string) => void} [progress]
 */
export async function prepareIsolation(destination, progress = () => {}) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new Error("Use the macOS isolation package on a supported Mac.");
  const target = path.resolve(destination);
  await fs.mkdir(target, { mode: 0o700 });
  let success = false;
  try {
    const runtime = path.join(target, "runtime");
    await fs.mkdir(runtime);
    for (const name of ["package.json", "npm-shrinkwrap.json", "request-limits.json", "LICENSE", "README.md", "bin", "dist/request-limits.json", "dist/src", "dist/web", "docs", "native", "scripts/isolation-install.py", "scripts/install-macos.sh", "scripts/prepare-isolation.mjs", "scripts/build-isolation-launcher.mjs", "scripts/build-file-lock.mjs", "scripts/verify-isolation.py", "skills/abilock/SKILL.md", "skills/abilock/agents/openai.yaml", "skills/abilock/references"])
      await copyPublicTree(path.join(sourceRoot, name), path.join(runtime, name));
    await fs.copyFile(path.join(sourceRoot, "scripts/install-macos.sh"), path.join(target, "Install.command"));
    await fs.chmod(path.join(target, "Install.command"), 0o755);
    const packageMetadata = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
    // The npm runtime never contains its own archive. A complete release may
    // attach these two prebuilt Skill installer assets without recursive packing.
    const skillAssets = path.join(sourceRoot, "skills/abilock/assets");
    const skillManifestFile = path.join(skillAssets, "runtime-manifest.json");
    if (await fs.lstat(skillManifestFile).then(() => true).catch(error => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) {
      for (const name of ["runtime-manifest.json", "abilock-runtime.tgz"]) {
        const info = await fs.lstat(path.join(skillAssets, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error("Skill installer assets contain a link or special file.");
      }
      const skillManifest = JSON.parse(await fs.readFile(skillManifestFile, "utf8"));
      const skillArchive = path.join(skillAssets, "abilock-runtime.tgz");
      if (skillManifest.name !== "abilock" || skillManifest.version !== packageMetadata.version ||
          skillManifest.runtime !== "abilock-runtime.tgz" ||
          crypto.createHash("sha256").update(await fs.readFile(skillArchive)).digest("hex") !== skillManifest.sha256)
        throw new Error("Rebuild the Skill installer assets for the current release before preparing this bundle.");
      for (const name of ["runtime-manifest.json", "abilock-runtime.tgz"])
        await copyPublicTree(path.join(skillAssets, name), path.join(runtime, "skills/abilock/assets", name));
    }
    const application = path.join(sourceRoot, "desktop/macos/Abilock.app");
    if (await fs.lstat(application).then(info => info.isDirectory()).catch(() => false)) {
      await run("/usr/bin/codesign", ["--verify", "--strict", application]);
      await copyPublicTree(application, path.join(runtime, "desktop/Abilock.app"));
    } else if (Number(packageMetadata.version.split(".")[0]) > 2 ||
        (Number(packageMetadata.version.split(".")[0]) === 2 && Number(packageMetadata.version.split(".")[1]) >= 2))
      throw new Error("The complete desktop application must be built before preparing this release.");
    progress("Preparing production dependencies.");
    const userConfig = path.join(runtime, ".npmrc");
    await fs.writeFile(userConfig, "", { flag: "wx" });
    const packageCache = path.join(target, ".npm-cache");
    await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--registry=https://registry.npmjs.org", `--cache=${packageCache}`, `--userconfig=${userConfig}`, "--globalconfig=/dev/null", "--no-audit", "--no-fund"],
      { cwd: runtime, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    await fs.rm(packageCache, { recursive: true, force: true });
    await fs.unlink(userConfig);
    await removeDependencyLinks(path.join(runtime, "node_modules"));
    progress("Downloading and verifying the official standalone runtime.");
    await downloadNode(target, process.arch);
    progress("Verifying protected launchers.");
    await copyNativeBinaries(target, process.arch);
    const files = [];
    async function collect(directory) {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else {
          const info = await fs.lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("The runtime bundle contains an unsafe file.");
          const relative = path.relative(target, file).split(path.sep).join("/");
          files.push({ path: relative, sha256: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"),
            mode: ["launch", "password", "node", "authorize", "verify-launch", "file-lock", "Install.command", "runtime/desktop/Abilock.app/Contents/MacOS/Abilock"].includes(relative) ? 0o755 : 0o644 });
        }
      }
    }
    await collect(target);
    const manifest = { version: 1, platform: "darwin", arch: process.arch, nodeVersion: nodeRelease.version,
      runtimeVersion: packageMetadata.version, files };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    await fs.writeFile(path.join(target, "manifest.json"), manifestText, { flag: "wx", mode: 0o600 });
    const digest = crypto.createHash("sha256").update(manifestText).digest("hex");
    success = true;
    return { bundle: target, digest, files: files.length, nodeVersion: nodeRelease.version };
  } finally {
    if (!success) await fs.rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ?? path.join(os.tmpdir(), "abilock-isolation-" + crypto.randomUUID());
  try {
    const result = await prepareIsolation(destination, (message) => console.error(message));
    console.log(JSON.stringify(result));
  } catch {
    console.error("Bundle preparation failed. System accounts, permissions, and credentials were not changed.");
    process.exitCode = 78;
  }
}
