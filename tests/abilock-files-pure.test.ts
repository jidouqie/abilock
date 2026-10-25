import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readSelectedFile,
  collectSelectedFiles,
  checkpointMarker,
  applyTrackedWorktree,
  validateManifestPaths,
} from "../bin/client-files.mjs";
import { gitManifestPathAllowed } from "../src/protocols/git-manifest-policy.js";

// Pure algorithms and synthetic temporary files only; no native Git or network.
async function directory(action: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-files-pure-"));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("client refuses the new .abilock credential namespace before content reads", async () => {
  await directory(async (root) => {
    const secretDir = path.join(root, ".abilock");
    await fs.mkdir(secretDir);
    const file = path.join(secretDir, "state.json");
    await fs.writeFile(file, "synthetic-storage-only");
    let reads = 0;
    await assert.rejects(
      readSelectedFile(file, {
        audit: () => {
          reads++;
        },
      }),
      /credential path/,
    );
    await assert.rejects(collectSelectedFiles(file, false), /credential path/);
    await assert.rejects(
      collectSelectedFiles(secretDir, true),
      /credential path/,
    );
    assert.equal(reads, 0);
  });
});
test("both old and new public worktree marker names remain reserved in manifests", () => {
  for (const marker of [
    ".abilock-worktree.json",
    ".permivelo-worktree.json",
    ".ABILOCK-WORKTREE.JSON.",
    ".PERMIVELO-WORKTREE.JSON ",
  ]) {
    assert.equal(gitManifestPathAllowed(marker), false);
    assert.throws(() => validateManifestPaths([{ path: marker }], true));
  }
});
test("new checkouts use the new marker while existing legacy markers remain safe and usable", async () => {
  await directory(async (root) => {
    const dest = path.join(root, "business-checkout");
    const files = (text: string) => [
      { path: "README.md", base64: Buffer.from(text).toString("base64") },
    ];
    const data = { repoId: "a".repeat(32), filesAreFullManifest: true };
    await applyTrackedWorktree(files("original"), dest, "clone", "REPO", data);
    assert.equal(
      await checkpointMarker(dest),
      path.join(dest, ".abilock-worktree.json"),
    );
    await fs.rename(
      path.join(dest, ".abilock-worktree.json"),
      path.join(dest, ".permivelo-worktree.json"),
    );
    await applyTrackedWorktree(files("updated"), dest, "pull", "REPO", data);
    assert.equal(
      await fs.readFile(path.join(dest, "README.md"), "utf8"),
      "updated",
    );
    assert.equal(
      await checkpointMarker(dest),
      path.join(dest, ".permivelo-worktree.json"),
    );
    const old = await fs.readFile(path.join(dest, ".permivelo-worktree.json"));
    await fs.writeFile(path.join(dest, ".abilock-worktree.json"), old);
    await assert.rejects(
      applyTrackedWorktree(
        files("must not overwrite"),
        dest,
        "pull",
        "REPO",
        data,
      ),
      /ambiguous/,
    );
    assert.equal(
      await fs.readFile(path.join(dest, "README.md"), "utf8"),
      "updated",
    );
  });
});
