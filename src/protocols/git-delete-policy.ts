import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError } from "../schema.js";
import { redactBytes } from "../security.js";
import { gitManifestPathsAllowed } from "./git-manifest-policy.js";

export type GitDeletion = { path: string; sha256: string };
type DeletionPlan = {
  tree: string;
  files: Array<{ path: string; stat: Stats; bytes: Buffer }>;
};
const MAX_BYTES = 20 * 1024 * 1024;

function conflict(message: string): never {
  throw new AppError(409, "GIT_DELETE_CONFLICT", message);
}
function sameFile(a: Stats, b: Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink
  );
}
async function regularFile(tree: string, relative: string) {
  let current = tree;
  const parts = relative.split("/");
  const root = await fs.lstat(tree);
  if (!root.isDirectory() || root.isSymbolicLink())
    conflict("Git 删除目录无效");
  for (let index = 0; index < parts.length; index++) {
    const entries = await fs.readdir(current);
    if (
      !entries.includes(parts[index]) ||
      entries.some(
        (entry) =>
          entry !== parts[index] &&
          entry.toLowerCase() === parts[index].toLowerCase(),
      )
    )
      conflict("Git 删除路径不存在或大小写冲突");
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1
        ? !stat.isDirectory()
        : !stat.isFile() || stat.nlink !== 1)
    )
      conflict("Git 删除仅允许工作区内无链接的普通文件");
    if (index === parts.length - 1) return stat;
  }
  conflict("Git 删除路径无效");
}

// Called while holding the repository process lock. A full tracked checkpoint
// authorizes only these explicit paths, never everything absent from an upload.
export async function prepareGitDeletions(
  tree: string,
  deletions: GitDeletion[],
  tracked: string[],
  secrets: string[] = [],
): Promise<DeletionPlan> {
  if (
    deletions.length > 1000 ||
    !gitManifestPathsAllowed(deletions.map((file) => file.path))
  )
    conflict("Git 删除清单路径无效");
  const trackedPaths = new Set(tracked);
  const files: DeletionPlan["files"] = [];
  let total = 0;
  for (const file of deletions) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !trackedPaths.has(file.path))
      conflict("Git 删除项必须来自已跟踪文件及旧内容摘要");
    const before = await regularFile(tree, file.path);
    total += before.size;
    if (total > MAX_BYTES) conflict("Git 删除文件总量超过 20 MiB");
    const handle = await fs.open(
      path.join(tree, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      if (!sameFile(before, await handle.stat()))
        conflict("Git 删除文件已变化");
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) conflict("Git 删除文件已变化");
        offset += bytesRead;
      }
      if (!sameFile(before, await handle.stat()))
        conflict("Git 删除文件已变化");
    } finally {
      await handle.close();
    }
    // Checkpoints describe the public, redacted export, not private raw bytes.
    const hash = crypto
      .createHash("sha256")
      .update(redactBytes(bytes, secrets))
      .digest("hex");
    if (hash !== file.sha256)
      conflict("Git 删除文件与本地检出记录不同，请先同步后重试");
    files.push({ path: file.path, stat: before, bytes });
  }
  return { tree, files };
}

export async function applyGitDeletions(
  plan: DeletionPlan,
  signal?: AbortSignal,
) {
  // Recheck every item before the first mutation, so a late conflict cannot
  // partially delete an otherwise valid batch.
  for (const file of plan.files) {
    signal?.throwIfAborted();
    if (!sameFile(file.stat, await regularFile(plan.tree, file.path)))
      conflict("Git 删除文件已变化");
  }
  const removed: DeletionPlan["files"] = [];
  try {
    for (const file of plan.files) {
      signal?.throwIfAborted();
      await fs.unlink(path.join(plan.tree, file.path));
      removed.push(file);
    }
  } catch (error) {
    let restoreFailed = false;
    for (const file of removed) {
      // No overwrite on restoration: another writer's bytes must not be lost.
      try {
        await fs.writeFile(path.join(plan.tree, file.path), file.bytes, {
          flag: "wx",
          mode: file.stat.mode & 0o777,
        });
      } catch {
        restoreFailed = true;
      }
    }
    if (restoreFailed)
      conflict("Git 删除中断且恢复未完成，请保留本地检出并检查工作区");
    throw error;
  }
}
