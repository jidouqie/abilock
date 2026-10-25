import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectionSchema, type Connection } from "../src/connections.js";
import { Store } from "../src/store.js";
import { createGitAdapter } from "../src/protocols/git.js";

// No Git executable runs here: workspace listing, dropping and alias cleanup
// are broker filesystem operations on synthetic directories.
const runtime = {
  windows: false,
  binary: "/nonexistent/git-must-not-run",
  environment: {},
  validate: async () => {},
};
const adapter = createGitAdapter({
  runtime,
  acquireLock: async () => ({ release: async () => {} }),
});

function git(alias = "GIT_A"): Connection {
  return connectionSchema.parse({
    alias,
    name: "Synthetic repository",
    kind: "git",
    config: {
      transport: "https",
      url: "https://git.example.test/org/repo.git",
      authType: "none",
    },
    trustBoundary: "independent-target",
  });
}
const repoId = () => crypto.randomBytes(16).toString("hex");

async function workspace(dataDir: string, alias: string, id: string) {
  const repository = path.join(dataDir, "git-repositories", alias, id);
  await fs.mkdir(path.join(repository, "tree", ".git"), { recursive: true });
  await fs.writeFile(
    path.join(repository, "binding.json"),
    JSON.stringify({ identity: "0".repeat(64) }),
  );
  await fs.writeFile(path.join(dataDir, "git-repositories", alias, `${id}.lock`), "");
  return repository;
}

async function temporary(work: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-git-workspaces-"));
  try {
    await work(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("workspaces lists broker repositories and drop removes one but keeps its lock", async () => {
  await temporary(async (dataDir) => {
    const first = repoId(),
      second = repoId();
    await workspace(dataDir, "GIT_A", first);
    const kept = await workspace(dataDir, "GIT_A", second);
    const context = {
      connection: git(),
      secret: {},
      signal: new AbortController().signal,
      allowLocal: false,
      dataDir,
    };
    const listed = await adapter.run(context, {
      args: ["workspaces"],
      timeoutMs: 30000,
    });
    assert.equal(listed.exitCode, 0);
    const items = (listed.data as { workspaces: { repoId: string; current: boolean }[] })
      .workspaces;
    assert.deepEqual(items.map((item) => item.repoId).sort(), [first, second].sort());
    // Synthetic bindings belong to another identity, so neither is current.
    assert.ok(items.every((item) => item.current === false));

    const dropped = await adapter.run(context, { args: ["drop", first], timeoutMs: 30000 });
    assert.deepEqual(dropped.data, { repoId: first, removed: true });
    await assert.rejects(fs.lstat(path.join(dataDir, "git-repositories", "GIT_A", first)));
    await fs.lstat(path.join(dataDir, "git-repositories", "GIT_A", `${first}.lock`));
    await fs.lstat(kept);
    await assert.rejects(
      adapter.run(context, { args: ["drop", first], timeoutMs: 30000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "GIT_REPO",
    );
    await assert.rejects(
      adapter.run(context, { args: ["workspaces", "--all"], timeoutMs: 30000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "GIT_OPTION",
    );
  });
});

// A shell stand-in for Git: it never contacts a remote. It creates synthetic
// tracked files, reports a fixed HEAD and records reset requests.
const fakeGit = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -c) shift 2 ;;
    --*) shift ;;
    *) break ;;
  esac
done
command="$1"; shift
case "$command" in
  clone)
    for last; do :; done
    mkdir -p "$last/.git/objects" "$last/.git/refs"
    echo "ref: refs/heads/main" > "$last/.git/HEAD"
    : > "$last/.git/config"
    count=$(cat "$FAKE_STATE/clone-count")
    i=0; while [ $i -lt $count ]; do echo "c$i" > "$last/c$i.txt"; i=$((i+1)); done ;;
  pull)
    count=$(cat "$FAKE_STATE/pull-count")
    i=0; while [ $i -lt $count ]; do echo "p$i" > "p$i.txt"; i=$((i+1)); done ;;
  ls-files)
    find . -type f ! -path './.git/*' | sed 's|^\\./||' | tr '\\n' '\\000' ;;
  rev-parse) echo 1111111111111111111111111111111111111111 ;;
  reset) echo "reset $*" >> "$FAKE_STATE/log"; rm -f p*.txt ;;
esac
exit 0
`;

test("an unexportable clone is not kept, and an unexportable pull is undone", async () => {
  await temporary(async (dataDir) => {
    const state = path.join(dataDir, "fake-state");
    await fs.mkdir(state);
    const binary = path.join(state, "git");
    await fs.writeFile(binary, fakeGit, { mode: 0o700 });
    const fake = createGitAdapter({
      runtime: {
        windows: false,
        binary,
        environment: { PATH: "/usr/bin:/bin", FAKE_STATE: state },
        validate: async () => {},
      },
      acquireLock: async () => ({ release: async () => {} }),
    });
    // A private literal address needs no DNS; the fake never connects.
    const connection = connectionSchema.parse({
      ...git(),
      config: {
        transport: "https",
        url: "https://10.0.0.5/org/repo.git",
        authType: "none",
      },
    });
    const context = {
      connection,
      secret: {},
      signal: new AbortController().signal,
      allowLocal: false,
      dataDir,
    };
    const aliasDirectory = path.join(dataDir, "git-repositories", "GIT_A");
    const repositories = async () =>
      (await fs.readdir(aliasDirectory)).filter((name) => /^[a-f0-9]{32}$/.test(name));

    await fs.writeFile(path.join(state, "clone-count"), "1001");
    await assert.rejects(
      fake.run(context, { args: ["clone"], timeoutMs: 30000 }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "GIT_EXPORT" &&
        /未保留 broker 工作区/.test(error.message),
    );
    assert.deepEqual(await repositories(), []);

    await fs.writeFile(path.join(state, "clone-count"), "2");
    const cloned = await fake.run(context, { args: ["clone"], timeoutMs: 30000 });
    assert.equal(cloned.exitCode, 0);
    assert.equal(cloned.files?.length, 2);
    const { repoId: id } = cloned.data as { repoId: string };

    await fs.writeFile(path.join(state, "pull-count"), "1000");
    await assert.rejects(
      fake.run(context, { args: ["pull", id], timeoutMs: 30000 }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "GIT_EXPORT" &&
        /已恢复到操作前的提交/.test(error.message),
    );
    assert.match(
      await fs.readFile(path.join(state, "log"), "utf8"),
      /reset --hard --quiet 1{40}/,
    );
    // The workspace is still there and consistent with the local checkpoint.
    assert.deepEqual(await repositories(), [id]);
    const tree = path.join(aliasDirectory, id, "tree");
    assert.deepEqual(
      (await fs.readdir(tree)).filter((name) => name !== ".git").sort(),
      ["c0.txt", "c1.txt"],
    );
  });
});

test("removing or renaming a Git connection cleans up or moves its broker workspaces", async () => {
  await temporary(async (dir) => {
    const store = new Store(dir, crypto.randomBytes(32).toString("hex"));
    await store.init();
    try {
      const dataDir = path.join(dir, "workspaces");
      const saved = await store.saveConnection(git(), undefined, false, 0);
      const id = repoId();
      await workspace(dataDir, "GIT_A", id);
      const renamed = await store.saveConnection(
        git("GIT_B"),
        undefined,
        false,
        saved.revision,
        "GIT_A",
      );
      assert.equal(renamed.alias, "GIT_B");
      await fs.lstat(path.join(dataDir, "git-repositories", "GIT_B", id, "binding.json"));
      await assert.rejects(fs.lstat(path.join(dataDir, "git-repositories", "GIT_A")));

      await store.removeConnection("GIT_B", renamed.revision);
      await assert.rejects(fs.lstat(path.join(dataDir, "git-repositories", "GIT_B", id)));
      // Lock files are never deleted to unlock a possible concurrent holder.
      await fs.lstat(path.join(dataDir, "git-repositories", "GIT_B", `${id}.lock`));
    } finally {
      await store.close();
    }
  });
});
