import {
  gitManifestPathAllowed,
  gitManifestPathsAllowed,
} from "../src/protocols/git-manifest-policy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkpointDeletions,
  applyTrackedWorktree,
  checkpointMarker,
  validateManifestPaths,
  gitFileSafe,
  commitCheckpoint,
  digest,
  trackedCheckpoint,
  validateCheckpoint,
  type Checkpoint,
} from "../bin/client-files.mjs";

// Pure manifest/checkpoint logic and synthetic temporary files only: no Git/native calls.
const selector = "REPO",
  repoId = "a".repeat(32);
const data = { repoId, filesAreFullManifest: true };
const manifest = (name: string, content: string) => ({
  path: name,
  base64: Buffer.from(content).toString("base64"),
});

test("commit records only the actual broker tracked manifest, never all uploaded files", () => {
  const previous = trackedCheckpoint(
    [manifest("tracked.txt", "old")],
    selector,
    data,
  );
  const uploaded = [
    manifest("tracked.txt", "new"),
    manifest("ignored-business.txt", "retain-me"),
  ];
  const next = commitCheckpoint(
    previous,
    [uploaded[0]],
    selector,
    data,
    repoId,
  );
  assert.ok(next);
  assert.equal(next.version, 2);
  assert.equal(next.trackedSource, "broker-full-manifest");
  assert.deepEqual(next.files, [
    { path: "tracked.txt", sha256: digest("new") },
  ]);
  assert.deepEqual(
    checkpointDeletions(next, trackedCheckpoint([], selector, data)).map(
      (file) => file.path,
    ),
    ["tracked.txt"],
  );
});

test("missing commit full manifest leaves the old checkpoint untouched", () => {
  const previous = trackedCheckpoint(
    [manifest("tracked", "before")],
    selector,
    data,
  );
  const original = JSON.stringify(previous);
  assert.equal(
    commitCheckpoint(
      previous,
      [manifest("ignored", "data")],
      selector,
      { repoId },
      repoId,
    ),
    undefined,
  );
  assert.equal(
    commitCheckpoint(previous, undefined, selector, data, repoId),
    undefined,
  );
  assert.equal(JSON.stringify(previous), original);
});

test("old v1 possibly poisoned checkpoint cannot authorize any pull deletion", () => {
  const previous: Checkpoint = {
    version: 1,
    selector,
    repoId,
    files: [
      { path: "tracked.txt", sha256: digest("old") },
      { path: "ignored-business.txt", sha256: digest("business") },
    ],
  };
  const next = trackedCheckpoint(
    [manifest("tracked.txt", "new")],
    selector,
    data,
  );
  assert.deepEqual(checkpointDeletions(previous, next), []);
  assert.deepEqual(
    checkpointDeletions(previous, trackedCheckpoint([], selector, data)),
    [],
  );
});

test("v2 missing tracked files are the sole deletion candidates; unknown files are retained", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-checkpoint-pure-"));
  try {
    await fs.writeFile(path.join(root, "tracked.txt"), "old");
    await fs.writeFile(path.join(root, "ignored-business.txt"), "business");
    await fs.writeFile(path.join(root, "untracked.txt"), "untracked");
    const previous = trackedCheckpoint(
      [manifest("tracked.txt", "old")],
      selector,
      data,
    );
    const next = trackedCheckpoint([], selector, data);
    for (const file of checkpointDeletions(previous, next)) {
      assert.equal(
        digest(await fs.readFile(path.join(root, file.path))),
        file.sha256,
      );
      await fs.unlink(path.join(root, file.path));
    }
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "ignored-business.txt",
      "untracked.txt",
    ]);
    assert.equal(
      await fs.readFile(path.join(root, "ignored-business.txt"), "utf8"),
      "business",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("old v1 migration preserves synthetic ignored business data then tracks only server files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-migration-pure-"));
  try {
    await fs.writeFile(path.join(root, "ignored.txt"), "do-not-delete");
    const previous: Checkpoint = {
      version: 1,
      selector,
      repoId,
      files: [{ path: "ignored.txt", sha256: digest("do-not-delete") }],
    };
    const next = trackedCheckpoint([], selector, data);
    for (const file of checkpointDeletions(previous, next))
      await fs.unlink(path.join(root, file.path));
    assert.equal(
      await fs.readFile(path.join(root, "ignored.txt"), "utf8"),
      "do-not-delete",
    );
    assert.deepEqual(next.files, []);
    assert.deepEqual(
      checkpointDeletions(next, trackedCheckpoint([], selector, data)),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid manifests, duplicate paths, traversal, malformed hashes and repo mismatch fail closed", () => {
  const previous = trackedCheckpoint(
    [manifest("tracked", "before")],
    selector,
    data,
  );
  for (const files of [
    [manifest("../business", "bad")],
    [manifest(".git/config", "bad")],
    [manifest(".abilock-worktree.json", "bad")],
    [manifest("a", "1"), manifest("a", "2")],
    [{ path: "a", base64: "%%%" }],
  ])
    assert.throws(() => trackedCheckpoint(files, selector, data));
  assert.throws(() =>
    validateCheckpoint(
      { ...previous, files: [{ path: "a", sha256: "wrong" }] },
      selector,
      repoId,
    ),
  );
  assert.throws(() =>
    validateCheckpoint(
      { ...previous, trackedSource: undefined },
      selector,
      repoId,
    ),
  );
  assert.throws(() =>
    commitCheckpoint(
      previous,
      [],
      selector,
      { ...data, repoId: "b".repeat(32) },
      repoId,
    ),
  );
  assert.throws(() =>
    checkpointDeletions(previous, { ...previous, selector: "OTHER" }),
  );
  assert.throws(() =>
    checkpointDeletions(previous, {
      ...previous,
      version: 1,
      trackedSource: undefined,
    }),
  );
  assert.throws(() =>
    trackedCheckpoint([manifest("a", "b")], selector, {
      repoId,
      filesAreFullManifest: false,
    }),
  );
});

test("CLI commit wiring passes response files and never uses uploaded files as its checkpoint", async () => {
  const source = await fs.readFile(
    new URL("../bin/abl.mjs", import.meta.url),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("async function updateGitCheckpoint"),
    source.indexOf("async function prepareGit"),
  );
  assert.match(
    block,
    /commitCheckpoint\(\s*previous,\s*trackedFiles,\s*selector,\s*data,\s*operation\.args\[1\],?\s*\)/,
  );
  assert.doesNotMatch(block, /operation\.files/);
  assert.match(source, /payload\.data,\s*payload\.files,/);
  assert.match(
    source,
    /applyTrackedWorktree\(\s*files,\s*destination,\s*operation.args\[0\],\s*selector,\s*data,?\s*\)/,
  );
  assert.match(source, /marker = await checkpointMarker\(root\)/);
  assert.match(source, /validateManifestPaths\(files, git\)/);
});

async function worktreeFixture(action: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-worktree-pure-"));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function readMarker(root: string) {
  return fs.readFile(path.join(root, ".abilock-worktree.json"), "utf8");
}
async function treeState(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name),
        relative = prefix + name;
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) {
        result[relative + "/"] = "directory";
        await visit(target, relative + "/");
      } else result[relative] = (await fs.readFile(target)).toString("base64");
    }
  }
  await visit(root, "");
  return result;
}

test("portable manifest policy rejects case, prefix, reserved and Unicode aliases before output", () => {
  for (const names of [
    ["A", "a"],
    ["Dir/File", "dir/file"],
    ["a", "A/b"],
    ["A/b", "a/c"],
    ["x/A/b", "x/a/c"],
    [".GIT/config"],
    ["nested/.Git/config"],
    [".ABILOCK-WORKTREE.JSON"],
    ["nested/.Abilock-Worktree.Json"],
    [".git. /config"],
    ["caf\u00e9.txt"],
    ["cafe\u0301.txt"],
    ["\u212A.txt"],
  ]) {
    const files = names.map((name) => manifest(name, "business"));
    assert.throws(() => trackedCheckpoint(files, selector, data));
    assert.equal(gitManifestPathsAllowed(names), false);
  }
  const accepted = ["A/file.txt", "b space/file+.json", ".gitignore"];
  assert.equal(gitManifestPathsAllowed(accepted), true);
  assert.doesNotThrow(() =>
    validateManifestPaths(
      accepted.map((name) => manifest(name, "ok")),
      true,
    ),
  );
  for (const name of [
    ...accepted,
    ".ABILOCK-WORKTREE.JSON",
    ".GIT/config",
    "中文.txt",
  ])
    assert.equal(gitFileSafe({ path: name }), gitManifestPathAllowed(name));
  assert.throws(() =>
    validateManifestPaths([manifest("A", "a"), manifest("a", "b")]),
  );
  assert.throws(() =>
    validateCheckpoint(
      {
        version: 2,
        trackedSource: "broker-full-manifest",
        selector,
        repoId,
        files: [
          { path: "A", sha256: digest("a") },
          { path: "a", sha256: digest("b") },
        ],
      },
      selector,
      repoId,
    ),
  );
});

test("tracked file-to-directory and directory-to-file conversions preserve unknown business", async () => {
  await worktreeFixture(async (root) => {
    await applyTrackedWorktree(
      [manifest("a", "first")],
      root,
      "clone",
      selector,
      data,
    );
    await fs.writeFile(path.join(root, "unknown.txt"), "keep business");
    await applyTrackedWorktree(
      [manifest("a/b", "second")],
      root,
      "pull",
      selector,
      data,
    );
    assert.equal(await fs.readFile(path.join(root, "a/b"), "utf8"), "second");
    await applyTrackedWorktree(
      [manifest("a", "third")],
      root,
      "pull",
      selector,
      data,
    );
    assert.equal(await fs.readFile(path.join(root, "a"), "utf8"), "third");
    assert.equal(
      await fs.readFile(path.join(root, "unknown.txt"), "utf8"),
      "keep business",
    );
    assert.deepEqual(JSON.parse(await readMarker(root)).files, [
      { path: "a", sha256: digest("third") },
    ]);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      ".abilock-worktree.json",
      "a",
      "unknown.txt",
    ]);
    await applyTrackedWorktree(
      [manifest("a", "third")],
      root,
      "pull",
      selector,
      data,
    );
    assert.equal(await fs.readFile(path.join(root, "a"), "utf8"), "third");
  });
});

test("entire conversion graph is checked before any write; unknown files and empty directories are retained", async () => {
  for (const unknown of ["business.txt", "business-empty/"])
    await worktreeFixture(async (root) => {
      await applyTrackedWorktree(
        [manifest("a/b", "old")],
        root,
        "clone",
        selector,
        data,
      );
      if (unknown.endsWith("/")) await fs.mkdir(path.join(root, "a", unknown));
      else await fs.writeFile(path.join(root, "a", unknown), "business");
      const before = await treeState(root);
      await assert.rejects(
        applyTrackedWorktree(
          [manifest("would-have-written", "new"), manifest("a", "new")],
          root,
          "pull",
          selector,
          data,
        ),
        /untracked/,
      );
      assert.deepEqual(await treeState(root), before);
    });
});

test("changed tracked files, symlink ancestors and v1 deletion ambiguity refuse conversion without mutations", async () => {
  for (const kind of ["changed", "v1", "symlink"])
    await worktreeFixture(async (root) => {
      await applyTrackedWorktree(
        [manifest("a", "old")],
        root,
        "clone",
        selector,
        data,
      );
      if (kind === "changed")
        await fs.writeFile(path.join(root, "a"), "local business edit");
      if (kind === "v1") {
        const marker = JSON.parse(await readMarker(root));
        marker.version = 1;
        delete marker.trackedSource;
        await fs.writeFile(
          path.join(root, ".abilock-worktree.json"),
          JSON.stringify(marker),
        );
      }
      if (kind === "symlink") {
        await fs.rename(path.join(root, "a"), path.join(root, "other"));
        await fs.symlink("other", path.join(root, "a"));
      }
      const markerBefore = await readMarker(root);
      await assert.rejects(
        applyTrackedWorktree(
          [manifest("a/b", "new")],
          root,
          "pull",
          selector,
          data,
        ),
      );
      assert.equal(await readMarker(root), markerBefore);
      assert.equal(
        (await fs.readdir(root)).some((name) =>
          name.startsWith(".abl-worktree-"),
        ),
        false,
      );
      assert.equal(
        await fs.readFile(path.join(root, "a"), "utf8"),
        kind === "changed" ? "local business edit" : "old",
      );
    });
});

test("controlled write failures recover both conversion directions and the original checkpoint", async () => {
  for (const [oldName, newName] of [
    ["a", "a/b"],
    ["a/b", "a"],
  ])
    for (const phase of ["staged", "old-staged", "written", "before-marker"])
      await worktreeFixture(async (root) => {
        await applyTrackedWorktree(
          [manifest(oldName, "old"), manifest("z", "old z")],
          root,
          "clone",
          selector,
          data,
        );
        await fs.writeFile(path.join(root, "unknown"), "business");
        const before = await treeState(root);
        await assert.rejects(
          applyTrackedWorktree(
            [manifest(newName, "new"), manifest("z", "new z")],
            root,
            "pull",
            selector,
            data,
            {
              audit: (at) => {
                if (at === phase) throw new Error("synthetic write failure");
              },
            },
          ),
          /synthetic write failure/,
        );
        assert.deepEqual(
          await treeState(root),
          before,
          oldName + " -> " + newName + " / " + phase,
        );
      });
});

test("concurrent user modification prevents destructive rollback and retains recoverable tracked backups", async () => {
  await worktreeFixture(async (root) => {
    await applyTrackedWorktree(
      [manifest("a", "old")],
      root,
      "clone",
      selector,
      data,
    );
    const markerBefore = await readMarker(root);
    await assert.rejects(
      applyTrackedWorktree(
        [manifest("a/b", "new")],
        root,
        "pull",
        selector,
        data,
        {
          audit: async (phase) => {
            if (phase === "written") {
              await fs.writeFile(path.join(root, "a/b"), "concurrent business");
              throw new Error("synthetic failure");
            }
          },
        },
      ),
      /recovery files retained/,
    );
    assert.equal(
      await fs.readFile(path.join(root, "a/b"), "utf8"),
      "concurrent business",
    );
    assert.equal(await readMarker(root), markerBefore);
    const stageName = (await fs.readdir(root)).find((name) =>
      name.startsWith(".abl-worktree-"),
    );
    assert.ok(stageName);
    const recovery = JSON.parse(
      await fs.readFile(path.join(root, stageName, "recovery.json"), "utf8"),
    );
    assert.equal(recovery.backups.length, 1);
    assert.equal(await fs.readFile(recovery.backups[0].backup, "utf8"), "old");
    assert.equal(
      (await fs.stat(path.join(root, stageName))).mode & 0o777,
      0o700,
    );
  });
});

test("local spelling collisions and marker variants fail before modifying any business file", async () => {
  await worktreeFixture(async (root) => {
    await applyTrackedWorktree(
      [manifest("A", "old")],
      root,
      "clone",
      selector,
      data,
    );
    const before = await treeState(root);
    await assert.rejects(
      applyTrackedWorktree(
        [manifest("a", "new")],
        root,
        "pull",
        selector,
        data,
      ),
      /collision|alias/,
    );
    assert.deepEqual(await treeState(root), before);
    await fs.rename(
      path.join(root, ".abilock-worktree.json"),
      path.join(root, ".ABILOCK-WORKTREE.JSON"),
    );
    const renamed = await treeState(root);
    await assert.rejects(checkpointMarker(root), /collision|alias/);
    await assert.rejects(
      applyTrackedWorktree(
        [manifest("A", "new")],
        root,
        "pull",
        selector,
        data,
      ),
      /collision|alias/,
    );
    assert.deepEqual(await treeState(root), renamed);
  });
});

test("invalid later manifest entries cannot create clone destinations or replace markers", async () => {
  await worktreeFixture(async (root) => {
    const destination = path.join(root, "not-created");
    for (const bad of [".ABILOCK-WORKTREE.JSON", ".Git/config", "中文.txt"])
      await assert.rejects(
        applyTrackedWorktree(
          [manifest("first", "good"), manifest(bad, "bad")],
          destination,
          "clone",
          selector,
          data,
        ),
      );
    assert.deepEqual(await fs.readdir(root), []);
  });
});

async function legacyWorktree(root: string) {
  await fs.mkdir(path.join(root, "business"));
  await fs.writeFile(
    path.join(root, "business", "ignored-business.txt"),
    "local ignored business",
    { mode: 0o640 },
  );
  await fs.writeFile(
    path.join(root, "legacy-only.txt"),
    "retained old ignored data",
  );
  await fs.writeFile(path.join(root, "unknown.txt"), "unknown business");
  const previous: Checkpoint = {
    version: 1,
    selector,
    repoId,
    files: [
      {
        path: "business/ignored-business.txt",
        sha256: digest("local ignored business"),
      },
      { path: "legacy-only.txt", sha256: digest("retained old ignored data") },
    ],
  };
  await fs.writeFile(
    path.join(root, ".abilock-worktree.json"),
    JSON.stringify(previous) + "\n",
  );
  return previous;
}

test("v1 migration adopts same-content names without rewriting inode or permissions and retains old unknown business", async () => {
  await worktreeFixture(async (root) => {
    await legacyWorktree(root);
    const selected = path.join(root, "business", "ignored-business.txt");
    const before = await fs.stat(selected);
    const next = [
      manifest("business/ignored-business.txt", "local ignored business"),
      manifest("new/tracked.txt", "new tracked data"),
    ];
    const record = await applyTrackedWorktree(
      next,
      root,
      "pull",
      selector,
      data,
    );
    const after = await fs.stat(selected);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.equal(await fs.readFile(selected, "utf8"), "local ignored business");
    assert.equal(
      await fs.readFile(path.join(root, "legacy-only.txt"), "utf8"),
      "retained old ignored data",
    );
    assert.equal(
      await fs.readFile(path.join(root, "unknown.txt"), "utf8"),
      "unknown business",
    );
    assert.equal(
      await fs.readFile(path.join(root, "new/tracked.txt"), "utf8"),
      "new tracked data",
    );
    assert.equal(record.version, 2);
    assert.deepEqual(
      record.files,
      trackedCheckpoint(next, selector, data).files,
    );
    assert.deepEqual(JSON.parse(await readMarker(root)), record);
  });
});

test("v1 same-name different-content pull rejects the complete batch before any output or staging writes", async () => {
  for (const localChanged of [false, true])
    await worktreeFixture(async (root) => {
      await legacyWorktree(root);
      if (localChanged)
        await fs.writeFile(
          path.join(root, "business", "ignored-business.txt"),
          "user already changed ignored business",
        );
      const before = await treeState(root);
      const selected = path.join(root, "business", "ignored-business.txt");
      const statBefore = await fs.stat(selected);
      let audits = 0;
      await assert.rejects(
        applyTrackedWorktree(
          [
            manifest("new/would-have-written.txt", "otherwise valid output"),
            manifest(
              "business/ignored-business.txt",
              "remote now tracked different content",
            ),
          ],
          root,
          "pull",
          selector,
          data,
          {
            audit: () => {
              audits++;
            },
          },
        ),
        /v1 checkpoint cannot authorize an overwrite/,
      );
      assert.equal(audits, 0);
      assert.deepEqual(await treeState(root), before);
      const statAfter = await fs.stat(selected);
      assert.equal(statAfter.ino, statBefore.ino);
      assert.equal(statAfter.mode, statBefore.mode);
      assert.equal(
        (await fs.readdir(root)).some((name) =>
          name.startsWith(".abl-worktree-"),
        ),
        false,
      );
    });
});

test("interrupted same-content v1 migration restores other outputs without touching adopted or ignored business", async () => {
  for (const phase of ["staged", "old-staged", "written", "before-marker"])
    await worktreeFixture(async (root) => {
      await legacyWorktree(root);
      const before = await treeState(root);
      const selected = path.join(root, "business", "ignored-business.txt");
      const statBefore = await fs.stat(selected);
      await assert.rejects(
        applyTrackedWorktree(
          [
            manifest("business/ignored-business.txt", "local ignored business"),
            manifest("new/first.txt", "new first"),
            manifest("new/second.txt", "new second"),
          ],
          root,
          "pull",
          selector,
          data,
          {
            audit: (at) => {
              if (at === phase)
                throw new Error("synthetic interrupted migration");
            },
          },
        ),
        /synthetic interrupted migration/,
      );
      assert.deepEqual(await treeState(root), before, phase);
      const statAfter = await fs.stat(selected);
      assert.equal(statAfter.ino, statBefore.ino, phase);
      assert.equal(statAfter.mode, statBefore.mode, phase);
    });
});

test("v1 adopted business changed just before marker commit is preserved while new outputs are rolled back", async () => {
  await worktreeFixture(async (root) => {
    await legacyWorktree(root);
    const markerBefore = await readMarker(root);
    const selected = path.join(root, "business", "ignored-business.txt");
    const before = await fs.stat(selected);
    await assert.rejects(
      applyTrackedWorktree(
        [
          manifest("business/ignored-business.txt", "local ignored business"),
          manifest("new/tracked.txt", "new tracked data"),
        ],
        root,
        "pull",
        selector,
        data,
        {
          audit: async (phase) => {
            if (phase === "before-marker")
              await fs.writeFile(selected, "user concurrent business edit");
          },
        },
      ),
      /v1 adoption has local changes/,
    );
    assert.equal(
      await fs.readFile(selected, "utf8"),
      "user concurrent business edit",
    );
    assert.equal((await fs.stat(selected)).ino, before.ino);
    assert.equal((await fs.stat(selected)).mode, before.mode);
    assert.equal(await readMarker(root), markerBefore);
    assert.equal(
      await fs.readFile(path.join(root, "legacy-only.txt"), "utf8"),
      "retained old ignored data",
    );
    assert.equal(
      await fs.readFile(path.join(root, "unknown.txt"), "utf8"),
      "unknown business",
    );
    assert.deepEqual((await fs.readdir(root)).sort(), [
      ".abilock-worktree.json",
      "business",
      "legacy-only.txt",
      "unknown.txt",
    ]);
  });
});
