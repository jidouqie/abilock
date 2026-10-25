import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const credentialDirectories = new Set([
  ".ssh",
  ".aws",
  ".kube",
  ".codex",
  ".config",
  ".gnupg",
  ".git",
  ".abilock",
]);
const credentialFiles = new Set([".netrc", ".npmrc", ".git-credentials"]);
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function safeManifestPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1000 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    value.normalize("NFC") === value &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function validateManifestPaths(files, git = false) {
  if (!Array.isArray(files)) throw new Error("invalid manifest");
  const seen = new Set();
  const spellings = new Map();
  for (const file of files) {
    if (!safeManifestPath(file?.path) || (git && !gitFileSafe(file)))
      throw new Error("invalid manifest path");
    const key = file.path.toLowerCase();
    const parts = file.path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const spelling = parts.slice(0, count).join("/");
      const canonical = spelling.toLowerCase();
      if (spellings.has(canonical) && spellings.get(canonical) !== spelling)
        throw new Error("manifest directory spelling collision");
      spellings.set(canonical, spelling);
    }
    if (seen.has(key)) throw new Error("manifest path collision");
    seen.add(key);
  }
  for (const key of seen) {
    let ancestor = key;
    while (ancestor.includes("/")) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      if (seen.has(ancestor))
        throw new Error("manifest file/directory collision");
    }
  }
  return files;
}

function selectedPath(source) {
  const absolute = path.resolve(source);
  // This is a path policy, not content DLP or isolation from the user's shell.
  if (
    absolute
      .split(path.sep)
      .some(
        (part) =>
          credentialDirectories.has(part.normalize("NFC").toLowerCase()) ||
          credentialFiles.has(part.normalize("NFC").toLowerCase()) ||
          /^\.env(?:\.|$)/i.test(part),
      )
  )
    throw new Error("credential path");
  return absolute;
}

const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fileState = (stat) =>
  `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;

async function pathSnapshot(absolute) {
  const root = path.parse(absolute).root;
  let current = root;
  const parts = [
    root,
    ...absolute.slice(root.length).split(path.sep).filter(Boolean),
  ];
  const records = [];
  for (let i = 0; i < parts.length; i++) {
    if (i) current = path.join(current, parts[i]);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      // macOS's system aliases are checked exactly, then both the link and
      // canonical ancestor chain are included in subsequent identity checks.
      if (
        process.platform !== "darwin" ||
        !["/var", "/tmp"].includes(current) ||
        path.resolve(path.dirname(current), await fs.readlink(current)) !==
          `/private${current}` ||
        (await fs.realpath(current)) !== `/private${current}`
      )
        throw new Error("ancestor symlink");
    } else if (i < parts.length - 1 && !stat.isDirectory()) {
      throw new Error("ancestor is not a directory");
    }
    records.push({ path: current, identity: identity(stat), stat });
  }
  const canonical = await fs.realpath(absolute);
  selectedPath(canonical);
  if (canonical !== absolute) {
    const canonicalRecords = await pathSnapshot(canonical);
    records.push(...canonicalRecords.records);
  }
  return { absolute, canonical, records, stat: records[parts.length - 1].stat };
}

export async function inspectSelectedPath(source) {
  return pathSnapshot(selectedPath(source));
}

export async function verifySelectedPath(snapshot) {
  const current = await inspectSelectedPath(snapshot.absolute);
  if (
    current.canonical !== snapshot.canonical ||
    current.records.length !== snapshot.records.length ||
    current.records.some(
      (record, index) =>
        record.path !== snapshot.records[index].path ||
        record.identity !== snapshot.records[index].identity,
    )
  )
    throw new Error("selected path changed");
  return current;
}

/**
 * @param {string} source
 * @param {{ maxBytes?: number,
 *   audit?: (phase: "inspected" | "before-read" | "after-read") => void | Promise<void> }} [options]
 */
export async function readSelectedFile(
  source,
  { maxBytes = 10 * 1024 * 1024, audit } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("invalid limit");
  const snapshot = await inspectSelectedPath(source);
  if (
    !snapshot.stat.isFile() ||
    snapshot.stat.nlink !== 1n ||
    snapshot.stat.size > BigInt(maxBytes)
  )
    throw new Error("not a selected regular file");
  // audit is a module-only test seam; no request/CLI option can supply code.
  await audit?.("inspected");
  const handle = await fs.open(
    snapshot.absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      fileState(before) !== fileState(snapshot.stat)
    )
      throw new Error("selected file changed");
    await verifySelectedPath(snapshot);
    await audit?.("before-read");
    await verifySelectedPath(snapshot);
    const chunks = [];
    let total = 0;
    for (;;) {
      // Read through the pinned descriptor, bounded even if the file grows.
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("selected file exceeds limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await audit?.("after-read");
    const after = await handle.stat({ bigint: true });
    const checked = await verifySelectedPath(snapshot);
    if (
      fileState(after) !== fileState(before) ||
      fileState(checked.stat) !== fileState(before) ||
      BigInt(total) !== before.size
    )
      throw new Error("selected file changed during read");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function readSelectedDirectory(snapshot) {
  if (!snapshot.stat.isDirectory()) throw new Error("not a directory");
  await verifySelectedPath(snapshot);
  const entries = (await fs.readdir(snapshot.absolute)).sort();
  await verifySelectedPath(snapshot);
  return entries;
}

function fileExcludes(patterns) {
  return patterns.map((pattern) => {
    if (
      !pattern ||
      pattern.length > 1000 ||
      /[\\\0[\]{}]/.test(pattern) ||
      pattern.split("/").includes("..")
    )
      throw new Error("invalid exclude");
    const anchored = pattern.startsWith("/"),
      directory = pattern.endsWith("/");
    const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
    let expression = "";
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      if (char === "*" && normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          expression += "(?:.*/)?";
          i += 2;
        } else {
          expression += ".*";
          i++;
        }
      } else if (char === "*") expression += "[^/]*";
      else if (char === "?") expression += "[^/]";
      else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(
      `${anchored || normalized.includes("/") ? "^" : "(?:^|/)"}${expression}${directory ? "(?:/|$)" : "$"}`,
    );
  });
}

export async function collectSelectedFiles(source, recursive, patterns = []) {
  const excludes = fileExcludes(patterns),
    files = [];
  const root = await inspectSelectedPath(source);
  if (
    root.stat.isDirectory() &&
    (!recursive ||
      root.canonical === path.parse(root.canonical).root ||
      root.absolute === path.resolve(process.env.HOME ?? "/") ||
      root.canonical === path.resolve(process.env.HOME ?? "/"))
  )
    throw new Error("directory needs an explicit project selection");
  let size = 0;
  async function visit(snapshot, relative) {
    if (snapshot.stat.isDirectory()) {
      for (const entry of await readSelectedDirectory(snapshot)) {
        if (
          [
            ".git",
            ".abilock-worktree.json",
            ".permivelo-worktree.json",
          ].includes(entry.toLowerCase())
        )
          continue;
        const child = relative ? `${relative}/${entry}` : entry;
        if (excludes.some((pattern) => pattern.test(child))) continue;
        await visit(
          await inspectSelectedPath(path.join(snapshot.absolute, entry)),
          child,
        );
      }
      await verifySelectedPath(snapshot);
    } else if (snapshot.stat.isFile()) {
      if (!safeManifestPath(relative) || files.length >= 100)
        throw new Error("invalid upload manifest");
      const bytes = await readSelectedFile(snapshot.absolute, {
        maxBytes: 10 * 1024 * 1024 - size,
      });
      size += bytes.length;
      files.push({ path: relative, base64: bytes.toString("base64") });
    } else throw new Error("not a regular file");
  }
  await visit(root, root.stat.isFile() ? path.basename(root.absolute) : "");
  await verifySelectedPath(root);
  validateManifestPaths(files);
  return {
    files,
    label: path.basename(root.absolute),
    directory: root.stat.isDirectory(),
  };
}

export const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export function gitFileSafe(file) {
  return (
    safeManifestPath(file?.path) &&
    // Git snapshots deliberately use ASCII names; other transfers retain NFC Unicode.
    /^[\x20-\x7e]+$/.test(file.path) &&
    !file.path
      .split("/")
      .some((part) =>
        [".git", ".abilock-worktree.json", ".permivelo-worktree.json"].includes(
          part.toLowerCase().replace(/[. ]+$/, ""),
        ),
      )
  );
}

export function trackedCheckpoint(files, selector, data) {
  if (
    !Array.isArray(files) ||
    files.length > 1000 ||
    data?.filesAreFullManifest !== true ||
    !/^[a-f0-9]{32}$/.test(data.repoId ?? "") ||
    typeof selector !== "string"
  )
    throw new Error("missing tracked manifest");
  validateManifestPaths(files, true);
  const seen = new Set();
  let size = 0;
  const tracked = files.map((file) => {
    if (
      !gitFileSafe(file) ||
      seen.has(file.path) ||
      typeof file.base64 !== "string" ||
      !base64Pattern.test(file.base64)
    )
      throw new Error("invalid tracked manifest");
    seen.add(file.path);
    const bytes = Buffer.from(file.base64, "base64");
    size += bytes.length;
    if (size > 20 * 1024 * 1024)
      throw new Error("tracked manifest exceeds limit");
    return { path: file.path, sha256: digest(bytes) };
  });
  return {
    version: 2,
    trackedSource: "broker-full-manifest",
    selector,
    repoId: data.repoId,
    files: tracked,
  };
}

export function validateCheckpoint(record, selector, repoId) {
  if (
    !record ||
    ![1, 2].includes(record.version) ||
    record.repoId !== repoId ||
    typeof record.selector !== "string" ||
    record.selector.toLowerCase() !== selector.toLowerCase() ||
    !Array.isArray(record.files) ||
    record.files.length > 1000 ||
    (record.version === 2 && record.trackedSource !== "broker-full-manifest")
  )
    throw new Error("invalid checkpoint");
  validateManifestPaths(record.files, true);
  const seen = new Set();
  for (const file of record.files) {
    if (
      !gitFileSafe(file) ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
    )
      throw new Error("invalid checkpoint file");
    seen.add(file.path);
  }
  return record;
}

export function checkpointDeletions(previous, next) {
  validateCheckpoint(previous, next.selector, next.repoId);
  validateCheckpoint(next, next.selector, next.repoId);
  if (next.version !== 2 || next.trackedSource !== "broker-full-manifest")
    throw new Error("deletion requires a new tracked full manifest");
  // v1 may have recorded ignored uploads as tracked. Never infer deletes from it.
  if (
    previous.version !== 2 ||
    previous.trackedSource !== "broker-full-manifest"
  )
    return [];
  const remaining = new Set(next.files.map((file) => file.path));
  return previous.files.filter((file) => !remaining.has(file.path));
}

export function gitCommitDeletions(previous, files) {
  validateCheckpoint(previous, previous.selector, previous.repoId);
  validateManifestPaths(files, true);
  // v1 checkpoints could contain ignored uploads. They cannot authorize a delete.
  if (
    previous.version !== 2 ||
    previous.trackedSource !== "broker-full-manifest"
  )
    return [];
  const remaining = new Set(files.map((file) => file.path));
  const deletions = previous.files.filter((file) => !remaining.has(file.path));
  validateManifestPaths([...files, ...deletions], true);
  return deletions.map(({ path, sha256 }) => ({ path, sha256 }));
}

export async function collectGitCommitFiles(directory, selector, repoId) {
  const marker = await checkpointMarker(directory);
  const markerBytes = await readSelectedFile(marker);
  const previous = validateCheckpoint(
    JSON.parse(markerBytes.toString("utf8")),
    selector,
    repoId,
  );
  const collected = await collectSelectedFiles(directory, true);
  if (!collected.directory)
    throw new Error("Git commit needs a worktree directory");
  const deletions = gitCommitDeletions(previous, collected.files);
  // A concurrent pull/commit must not silently change our deletion authority.
  if (!(await readSelectedFile(marker)).equals(markerBytes))
    throw new Error("Git checkpoint changed while collecting files");
  return {
    files: collected.files,
    deletions,
    checkpointHash: digest(markerBytes),
  };
}

export function commitCheckpoint(previous, files, selector, data, repoId) {
  validateCheckpoint(previous, selector, repoId);
  if (data?.repoId !== repoId) throw new Error("commit repo mismatch");
  // Old brokers without an actual tracked manifest cannot author a new checkpoint.
  if (data.filesAreFullManifest !== true || files === undefined)
    return undefined;
  return trackedCheckpoint(files, selector, data);
}

// ASCII manifest names plus exact directory entries avoid case/Unicode aliases.
async function exactEntry(parent, name) {
  const entries = await fs.readdir(parent);
  if (
    entries.some(
      (entry) => entry !== name && entry.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("local path spelling collision");
  try {
    const stat = await fs.lstat(path.join(parent, name));
    if (!entries.includes(name)) throw new Error("local filesystem path alias");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function safeDestinationParents(target) {
  const absolute = selectedPath(target),
    root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    const stat = await exactEntry(current, part);
    current = path.join(current, part);
    if (!stat) return;
    if (stat.isSymbolicLink()) await inspectSelectedPath(current);
    else if (!stat.isDirectory())
      throw new Error("destination ancestor is not a directory");
  }
}

export async function inspectOutputDestination(target) {
  const absolute = selectedPath(target),
    root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const stat = await exactEntry(current, parts[index]);
    current = path.join(current, parts[index]);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      if (index === parts.length - 1) throw new Error("output symlink");
      await inspectSelectedPath(current);
    } else if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error("output ancestor is not a directory");
    else if (index === parts.length - 1 && !stat.isFile())
      throw new Error("output is not a regular file");
  }
}

export async function checkpointMarker(directory) {
  const root = path.resolve(directory);
  await safeDestinationParents(root);
  const snapshot = await inspectSelectedPath(root);
  if (!snapshot.stat.isDirectory())
    throw new Error("invalid worktree directory");
  const current = await exactEntry(root, ".abilock-worktree.json");
  const legacy = await exactEntry(root, ".permivelo-worktree.json");
  if (current && legacy) throw new Error("ambiguous worktree markers");
  const name =
    !current && legacy ? ".permivelo-worktree.json" : ".abilock-worktree.json";
  const stat = current ?? legacy;
  if (stat && !stat.isFile()) throw new Error("invalid worktree marker");
  return path.join(root, name);
}

/**
 * @param {import("./client-files.mjs").ManifestFile[]} files
 * @param {string} destination
 * @param {string} command
 * @param {string} selector
 * @param {import("./client-files.mjs").ManifestData} data
 * @param {{ audit?: (phase: "staged" | "old-staged" | "written" | "before-marker",
 *   index?: number) => void | Promise<void> }} [options]
 */
export async function applyTrackedWorktree(
  files,
  destination,
  command,
  selector,
  data,
  { audit } = {},
) {
  if (!["clone", "pull"].includes(command))
    throw new Error("unsupported worktree operation");
  const record = trackedCheckpoint(files, selector, data);
  const root = path.resolve(destination);
  await safeDestinationParents(root);
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (rootStat && !rootStat.isDirectory())
    throw new Error("invalid worktree directory");
  if (command === "clone" && rootStat && (await fs.readdir(root)).length)
    throw new Error("clone needs an empty directory");
  let previous, markerBytes;
  let marker = path.join(root, ".abilock-worktree.json");
  if (command === "pull") {
    if (!rootStat) throw new Error("missing worktree directory");
    marker = await checkpointMarker(root);
    markerBytes = await readSelectedFile(marker);
    previous = validateCheckpoint(
      JSON.parse(markerBytes.toString("utf8")),
      selector,
      data.repoId,
    );
  }
  const oldFiles = new Map(
    (previous?.files ?? []).map((file) => [file.path, file]),
  );
  const deletions = previous ? checkpointDeletions(previous, record) : [];
  const removable = new Map(deletions.map((file) => [file.path, file]));
  const removeDirectories = new Set();
  const legacyAdoptions = new Set();
  if (previous?.version === 1) {
    // v1 included ignored uploads, so its hashes cannot authorize overwrites.
    // Only adopt identical content without replacing the existing business file.
    for (const file of record.files) {
      const prior = oldFiles.get(file.path);
      if (!prior) continue;
      if (prior.sha256 !== file.sha256)
        throw new Error(
          "v1 checkpoint cannot authorize an overwrite; use a new empty directory",
        );
      legacyAdoptions.add(file.path);
    }
  }

  async function probe(relative, allowBlocked = false) {
    let parent = root;
    const parts = relative.split("/");
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index],
        rel = parts.slice(0, index + 1).join("/");
      const stat = await exactEntry(parent, name),
        current = path.join(parent, name);
      if (!stat) return { kind: "missing", path: current };
      if (stat.isSymbolicLink()) throw new Error("worktree symlink");
      await inspectSelectedPath(current);
      if (index === parts.length - 1)
        return {
          kind: stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : "other",
          path: current,
        };
      if (!stat.isDirectory()) {
        if (allowBlocked && stat.isFile() && removable.has(rel))
          return { kind: "blocked", path: current };
        throw new Error("worktree ancestor conflict");
      }
      parent = current;
    }
    throw new Error("invalid worktree path");
  }
  async function verifyOldFiles() {
    for (const file of oldFiles.values()) {
      if (
        (await probe(file.path)).kind !== "file" ||
        digest(
          await readSelectedFile(path.join(root, file.path), {
            maxBytes: 20 * 1024 * 1024,
          }),
        ) !== file.sha256
      )
        throw new Error("worktree has local changes");
    }
  }
  async function verifyLegacyAdoptions() {
    for (const relative of legacyAdoptions) {
      if (
        (await probe(relative)).kind !== "file" ||
        digest(
          await readSelectedFile(path.join(root, relative), {
            maxBytes: 20 * 1024 * 1024,
          }),
        ) !== oldFiles.get(relative).sha256
      )
        throw new Error("v1 adoption has local changes");
    }
  }
  async function inspectRemovableDirectory(relative) {
    // Empty unknown directories are business data too; ownership is not inferred.
    if (![...removable.keys()].some((name) => name.startsWith(`${relative}/`)))
      throw new Error("untracked directory conflict");
    const directory = path.join(root, relative);
    await inspectSelectedPath(directory);
    for (const name of await fs.readdir(directory)) {
      const child = `${relative}/${name}`;
      if (!gitFileSafe({ path: child }))
        throw new Error("untracked path conflict");
      const entry = await probe(child);
      if (entry.kind === "directory") await inspectRemovableDirectory(child);
      else if (entry.kind !== "file" || !removable.has(child))
        throw new Error("untracked file conflict");
    }
    removeDirectories.add(relative);
  }
  async function preflight() {
    removeDirectories.clear();
    if (previous) {
      await checkpointMarker(root);
      if (digest(await readSelectedFile(marker)) !== digest(markerBytes))
        throw new Error("worktree marker changed");
      await verifyOldFiles();
    }
    for (const file of files) {
      const entry = rootStat
        ? await probe(file.path, true)
        : { kind: "missing" };
      if (entry.kind === "file" && !oldFiles.has(file.path))
        throw new Error("untracked file conflict");
      if (entry.kind === "directory")
        await inspectRemovableDirectory(file.path);
      if (!["file", "directory", "missing", "blocked"].includes(entry.kind))
        throw new Error("worktree path conflict");
    }
  }
  // Validate all conflicts before outputs or deletions; no native Git runs here.
  await preflight();
  if (!rootStat) {
    await fs.mkdir(root, { recursive: true });
    await safeDestinationParents(root);
    if ((await fs.readdir(root)).length)
      throw new Error("clone directory changed");
    rootStat = await fs.lstat(root);
  }
  const rootSnapshot = await inspectSelectedPath(root);
  const staging = await fs.mkdtemp(path.join(root, ".abl-worktree-"));
  await fs.chmod(staging, 0o700);
  const stagingIdentity = identity(await fs.lstat(staging, { bigint: true }));
  const backups = [],
    written = [],
    createdDirectories = [],
    removedDirectories = [];
  const nextNames = new Set(record.files.map((file) => file.path));
  const affected = [...oldFiles.values()].filter(
    (file) =>
      removable.has(file.path) ||
      (nextNames.has(file.path) && !legacyAdoptions.has(file.path)),
  );
  const plannedBackups = affected.map((file, index) => ({
    original: path.join(root, file.path),
    backup: path.join(staging, `backup-${index}`),
    sha256: file.sha256,
  }));
  let committed = false,
    recovered = true;
  async function safeParent(relative) {
    let parent = root;
    for (const name of relative.split("/").slice(0, -1)) {
      const stat = await exactEntry(parent, name),
        current = path.join(parent, name);
      if (!stat) {
        await fs.mkdir(current);
        createdDirectories.push(current);
      } else if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("worktree ancestor changed");
      await inspectSelectedPath(current);
      parent = current;
    }
    return parent;
  }
  try {
    for (let index = 0; index < files.length; index++)
      await fs.writeFile(
        path.join(staging, String(index)),
        Buffer.from(files[index].base64, "base64"),
        { flag: "wx", mode: 0o600 },
      );
    await fs.writeFile(
      path.join(staging, "recovery.json"),
      JSON.stringify(
        {
          version: 1,
          status: "in-progress",
          previous,
          next: record,
          backups: plannedBackups,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await audit?.("staged"); // Module-only fault seam, never a CLI/request option.
    await preflight();
    for (let index = 0; index < affected.length; index++) {
      const file = affected[index],
        original = path.join(root, file.path),
        backup = path.join(staging, `backup-${index}`);
      await verifySelectedPath(rootSnapshot);
      if (
        (await probe(file.path)).kind !== "file" ||
        digest(
          await readSelectedFile(original, { maxBytes: 20 * 1024 * 1024 }),
        ) !== file.sha256
      )
        throw new Error("worktree changed before staging old file");
      await fs.rename(original, backup);
      backups.push({ original, backup, file });
    }
    for (const relative of [...removeDirectories].sort(
      (a, b) => b.split("/").length - a.split("/").length,
    )) {
      await verifySelectedPath(rootSnapshot);
      const entry = await probe(relative);
      if (entry.kind !== "directory" || (await fs.readdir(entry.path)).length)
        throw new Error("worktree directory changed");
      const mode = (await fs.lstat(entry.path)).mode;
      await fs.rmdir(entry.path); // Never recursive: unknown user files stay safe.
      removedDirectories.push({ path: entry.path, mode });
    }
    await audit?.("old-staged");
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (legacyAdoptions.has(file.path)) continue;
      await verifySelectedPath(rootSnapshot);
      const parent = await safeParent(file.path),
        name = file.path.split("/").at(-1);
      if (await exactEntry(parent, name))
        throw new Error("worktree destination appeared");
      const dest = path.join(root, file.path);
      await fs.rename(path.join(staging, String(index)), dest);
      written.push({
        dest,
        sha256: digest(Buffer.from(file.base64, "base64")),
        relative: file.path,
      });
      await audit?.("written", index);
    }
    await verifySelectedPath(rootSnapshot);
    await verifyLegacyAdoptions();
    await checkpointMarker(root);
    if (
      previous &&
      digest(await readSelectedFile(marker)) !== digest(markerBytes)
    )
      throw new Error("worktree marker changed");
    if (
      !previous &&
      ((await exactEntry(root, ".abilock-worktree.json")) ||
        (await exactEntry(root, ".permivelo-worktree.json")))
    )
      throw new Error("worktree marker appeared");
    const stagedMarker = path.join(staging, "marker");
    await fs.writeFile(stagedMarker, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await audit?.("before-marker");
    await verifySelectedPath(rootSnapshot);
    await verifyLegacyAdoptions();
    await checkpointMarker(root);
    if (
      previous &&
      digest(await readSelectedFile(marker)) !== digest(markerBytes)
    )
      throw new Error("worktree marker changed");
    if (
      !previous &&
      ((await exactEntry(root, ".abilock-worktree.json")) ||
        (await exactEntry(root, ".permivelo-worktree.json")))
    )
      throw new Error("worktree marker appeared");
    await fs.rename(stagedMarker, marker);
    committed = true;
    return record;
  } catch (error) {
    // Restore only our own unchanged outputs; concurrent user edits win.
    try {
      await verifySelectedPath(rootSnapshot);
      for (const file of written.reverse()) {
        const entry = await probe(file.relative);
        if (
          entry.kind !== "file" ||
          digest(
            await readSelectedFile(file.dest, { maxBytes: 20 * 1024 * 1024 }),
          ) !== file.sha256
        )
          throw new Error("recovery conflicts with a local change");
        await fs.unlink(file.dest);
      }
      for (const directory of createdDirectories.reverse()) {
        await inspectSelectedPath(directory);
        if ((await fs.readdir(directory)).length)
          throw new Error("recovery directory changed");
        await fs.rmdir(directory);
      }
      for (const directory of removedDirectories.reverse()) {
        const relative = path.relative(root, directory.path);
        const parent = await safeParent(`${relative}/placeholder`);
        await inspectSelectedPath(parent);
        await fs.chmod(parent, directory.mode);
      }
      for (const { original, backup, file } of backups) {
        const parent = await safeParent(file.path);
        if (await exactEntry(parent, file.path.split("/").at(-1)))
          throw new Error("recovery destination changed");
        if (
          digest(
            await readSelectedFile(backup, { maxBytes: 20 * 1024 * 1024 }),
          ) !== file.sha256
        )
          throw new Error("recovery backup changed");
        await fs.rename(backup, original);
      }
    } catch {
      recovered = false;
      try {
        await verifySelectedPath(rootSnapshot);
        if (
          identity(await fs.lstat(staging, { bigint: true })) !==
          stagingIdentity
        )
          throw new Error("recovery staging changed");
        const recoveryUpdate = path.join(staging, "recovery-next.json");
        await fs.writeFile(
          recoveryUpdate,
          JSON.stringify(
            {
              version: 1,
              status: "recovery-incomplete",
              reason:
                "filesystem or concurrent changes prevented safe automatic recovery",
              backups: backups.map(({ original, backup, file }) => ({
                original,
                backup,
                sha256: file.sha256,
              })),
              previous,
            },
            null,
            2,
          ) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        await fs.rename(recoveryUpdate, path.join(staging, "recovery.json"));
      } catch {
        /* Original pre-mutation recovery plan remains available. */
      }
    }
    if (!recovered)
      throw Object.assign(
        new Error(
          `worktree update stopped; recovery files retained at ${staging}`,
        ),
        { code: "GIT_WORKTREE_RECOVERY" },
      );
    throw error;
  } finally {
    await verifySelectedPath(rootSnapshot);
    if (
      (committed || recovered) &&
      identity(await fs.lstat(staging, { bigint: true })) === stagingIdentity
    )
      await fs.rm(staging, { recursive: true, force: true });
  }
}
