import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  prepareGitDeletions,
  applyGitDeletions,
} from "../src/protocols/git-delete-policy.js";
import {
  applyTrackedWorktree,
  collectGitCommitFiles,
  gitCommitDeletions,
  trackedCheckpoint,
} from "../bin/client-files.mjs";
import { redactBytes } from "../src/security.js";

// Synthetic files and pure helpers only: no CLI, native Git, sockets or providers.
const hash = (bytes: string | Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = (name: string, text: string) => ({
  path: name,
  base64: Buffer.from(text).toString("base64"),
});
const repoId = "a".repeat(32);
async function fixture(action: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-git-delete-pure-"));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("local commit carries only explicitly missing v2 tracked paths and their old hashes", async () => {
  await fixture(async (root) => {
    const tree = path.join(root, "checkout");
    const original = [
      manifest("remove.txt", "old"),
      manifest("keep.txt", "keep"),
    ];
    await applyTrackedWorktree(original, tree, "clone", "REPO", {
      repoId,
      filesAreFullManifest: true,
    });
    await fs.unlink(path.join(tree, "remove.txt"));
    await fs.writeFile(path.join(tree, "keep.txt"), "changed");
    await fs.writeFile(path.join(tree, "new.txt"), "new");
    const marker = path.join(tree, ".abilock-worktree.json");
    const before = await fs.readFile(marker);
    const collected = await collectGitCommitFiles(tree, "repo", repoId);
    assert.deepEqual(collected.deletions, [
      { path: "remove.txt", sha256: hash("old") },
    ]);
    assert.deepEqual(
      collected.files.map((file) => file.path),
      ["keep.txt", "new.txt"],
    );
    assert.equal(collected.checkpointHash, hash(before));
    assert.deepEqual(await fs.readFile(marker), before);
    await assert.rejects(
      collectGitCommitFiles(tree, "OTHER", repoId),
      /checkpoint/,
    );
    await assert.rejects(
      collectGitCommitFiles(tree, "REPO", "b".repeat(32)),
      /checkpoint/,
    );
  });
});

test("legacy checkpoints cannot authorize deletes and conflicting path shapes are rejected", () => {
  const previous = trackedCheckpoint([manifest("remove.txt", "old")], "REPO", {
    repoId,
    filesAreFullManifest: true,
  });
  assert.deepEqual(gitCommitDeletions({ ...previous, version: 1 }, []), []);
  assert.throws(
    () => gitCommitDeletions(previous, [manifest("REMOVE.TXT", "new")]),
    /collision/,
  );
  assert.throws(
    () => gitCommitDeletions(previous, [manifest("remove.txt/child", "new")]),
    /collision/,
  );
});

test("server deletes the declared tracked file and keeps all undeclared files", async () => {
  await fixture(async (root) => {
    await fs.writeFile(path.join(root, "remove.txt"), "old");
    await fs.writeFile(path.join(root, "undeclared.txt"), "must remain");
    const plan = await prepareGitDeletions(
      root,
      [{ path: "remove.txt", sha256: hash("old") }],
      ["remove.txt", "undeclared.txt"],
    );
    await applyGitDeletions(plan);
    await assert.rejects(fs.stat(path.join(root, "remove.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      await fs.readFile(path.join(root, "undeclared.txt"), "utf8"),
      "must remain",
    );
  });
});

test("stale content and untracked deletes are refused before any deletion", async () => {
  await fixture(async (root) => {
    await fs.writeFile(path.join(root, "first.txt"), "first");
    await fs.writeFile(path.join(root, "last.txt"), "new upstream");
    await assert.rejects(
      prepareGitDeletions(
        root,
        [
          { path: "first.txt", sha256: hash("first") },
          { path: "last.txt", sha256: hash("old upstream") },
        ],
        ["first.txt", "last.txt"],
      ),
      { code: "GIT_DELETE_CONFLICT" },
    );
    await assert.rejects(
      prepareGitDeletions(
        root,
        [{ path: "first.txt", sha256: hash("first") }],
        [],
      ),
      { code: "GIT_DELETE_CONFLICT" },
    );
    assert.equal(
      await fs.readFile(path.join(root, "first.txt"), "utf8"),
      "first",
    );
    assert.equal(
      await fs.readFile(path.join(root, "last.txt"), "utf8"),
      "new upstream",
    );
  });
});

test("server refuses traversal, reserved metadata, links and non-files", async () => {
  await fixture(async (root) => {
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(root, "outside.txt"), "outside");
    await fs.symlink(
      path.join(root, "outside.txt"),
      path.join(tree, "link.txt"),
    );
    await fs.link(path.join(root, "outside.txt"), path.join(tree, "hard.txt"));
    await fs.mkdir(path.join(tree, "directory"));
    await fs.symlink(root, path.join(tree, "linked-dir"));
    for (const name of [
      "../outside.txt",
      ".git/config",
      ".abilock-worktree.json",
      "link.txt",
      "hard.txt",
      "directory",
      "linked-dir/outside.txt",
    ]) {
      await assert.rejects(
        prepareGitDeletions(
          tree,
          [{ path: name, sha256: hash("outside") }],
          [name],
        ),
        { code: "GIT_DELETE_CONFLICT" },
      );
    }
    assert.equal(
      await fs.readFile(path.join(root, "outside.txt"), "utf8"),
      "outside",
    );
  });
});

test("late changes and cancelled requests leave deletion batches untouched", async () => {
  await fixture(async (root) => {
    for (const name of ["first.txt", "last.txt"])
      await fs.writeFile(path.join(root, name), name);
    const files = ["first.txt", "last.txt"].map((name) => ({
      path: name,
      sha256: hash(name),
    }));
    const plan = await prepareGitDeletions(
      root,
      files,
      files.map((file) => file.path),
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(applyGitDeletions(plan, abort.signal), {
      name: "AbortError",
    });
    await fs.writeFile(path.join(root, "last.txt"), "late change");
    await assert.rejects(applyGitDeletions(plan), {
      code: "GIT_DELETE_CONFLICT",
    });
    assert.equal(
      await fs.readFile(path.join(root, "first.txt"), "utf8"),
      "first.txt",
    );
    assert.equal(
      await fs.readFile(path.join(root, "last.txt"), "utf8"),
      "late change",
    );
  });
});

test("deletion hash matches the same redacted bytes returned in a tracked manifest", async () => {
  await fixture(async (root) => {
    const fakeSecret = "FAKE-KEY-only-test-2395864";
    const bytes = Buffer.from(`business text ${fakeSecret}`);
    await fs.writeFile(path.join(root, "redacted.txt"), bytes);
    const plan = await prepareGitDeletions(
      root,
      [
        {
          path: "redacted.txt",
          sha256: hash(redactBytes(bytes, [fakeSecret])),
        },
      ],
      ["redacted.txt"],
      [fakeSecret],
    );
    await applyGitDeletions(plan);
    await assert.rejects(fs.stat(path.join(root, "redacted.txt")), {
      code: "ENOENT",
    });
  });
});

test("cancellation during a delete batch restores already removed ordinary files", async () => {
  await fixture(async (root) => {
    for (const name of ["first.txt", "last.txt"])
      await fs.writeFile(path.join(root, name), name);
    const files = ["first.txt", "last.txt"].map((name) => ({
      path: name,
      sha256: hash(name),
    }));
    const plan = await prepareGitDeletions(
      root,
      files,
      files.map((file) => file.path),
    );
    const abort = new AbortController();
    const unlink = fs.unlink;
    fs.unlink = async (filename) => {
      await unlink(filename);
      if (filename === path.join(root, "first.txt")) abort.abort();
    };
    try {
      await assert.rejects(applyGitDeletions(plan, abort.signal), {
        name: "AbortError",
      });
    } finally {
      fs.unlink = unlink;
    }
    assert.equal(
      await fs.readFile(path.join(root, "first.txt"), "utf8"),
      "first.txt",
    );
    assert.equal(
      await fs.readFile(path.join(root, "last.txt"), "utf8"),
      "last.txt",
    );
  });
});
