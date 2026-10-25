import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Store } from "../src/store.js";
import { platformSchema, type State } from "../src/schema.js";
import { loadLocalStore } from "../src/local-state.js";
import { assertLockReleased } from "./helpers/store-lock.js";

const platform = platformSchema.parse({
  alias: "FAKE",
  name: "Synthetic fixture",
  baseUrl: "https://example.test",
  auth: { type: "none" },
  rules: [{ method: "GET", path: "/status" }],
});
const original = {
  title: "Synthetic manual",
  sourceUrl: "https://example.test/docs",
  markdown: "Original public usage",
};
const fixture = path.resolve("tests/fixtures/store-lock-owner.ts");

function start(dir: string, kind: "reader" | "writer" | "contender" = "writer") {
  const child = fork(fixture, [dir, kind], {
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  const exited = once(child, "exit");
  const ready = Promise.race([
    once(child, "message").then(
      ([message]) => message as { type: string; code?: string },
    ),
    exited.then(() => {
      throw new Error("fixture exited before ready");
    }),
  ]);
  return { child, ready, exited };
}

async function stop(child: ChildProcess, exited: Promise<unknown>) {
  if (child.connected) child.send("close");
  await exited;
}

test(
  "active transactions exclude one another, readers coexist, and SIGKILL releases a stable lock inode",
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-store-lock-"));
    const children: ReturnType<typeof start>[] = [];
    try {
      // An old PID text is inert: neither mtime nor PID liveness controls the lock.
      await fs.writeFile(path.join(dir, "service.lock"), "999999", {
        mode: 0o600,
      });
      const inode = (await fs.stat(path.join(dir, "service.lock"))).ino;
      const owner = start(dir);
      children.push(owner);
      assert.equal((await owner.ready).type, "ready");
      const competing = start(dir, "contender");
      children.push(competing);
      assert.deepEqual(await competing.ready, {
        type: "error",
        code: "CONFIG_BUSY",
      });
      await competing.exited;
      const readers = [start(dir, "reader"), start(dir, "reader")];
      children.push(...readers);
      assert.deepEqual(
        await Promise.all(readers.map((reader) => reader.ready)),
        [{ type: "ready" }, { type: "ready" }],
      );
      await Promise.all(
        readers.map((reader) => stop(reader.child, reader.exited)),
      );
      owner.child.kill("SIGKILL");
      await owner.exited;
      // The kernel releases the owner's descriptor without deleting the lock
      // inode or requiring administrator intervention.
      let restored = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await assertLockReleased(path.join(dir, "service.lock"));
          restored = true;
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== "CONFIG_BUSY") throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(restored, true);
      assert.equal((await fs.stat(path.join(dir, "service.lock"))).ino, inode);
      assert.equal(
        await fs.readFile(path.join(dir, "service.lock"), "utf8"),
        "999999",
      );
      const reopened = start(dir);
      children.push(reopened);
      assert.equal((await reopened.ready).type, "ready");
      await stop(reopened.child, reopened.exited);
      await assertLockReleased(path.join(dir, "service.lock"));
    } finally {
      await Promise.all(
        children.map(async ({ child, exited }) => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await exited;
        }),
      );
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test("requireExisting local learning accepts an unlocked legacy lock file", async () => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-stale-local-"),
  );
  const dir = path.join(parent, "private");
  let store: Store | undefined;
  try {
    store = await loadLocalStore({ dir });
    await store.close();
    await fs.writeFile(path.join(dir, "data/service.lock"), "999999");
    store = await loadLocalStore({ dir, requireExisting: true });
    await store.close();
  } finally {
    await store?.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a rejected state commit cannot advance the document mirror", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-doc-commit-"));
  const store = new Store(dir, "9".repeat(64));
  try {
    await store.init();
    await store.save(platform, undefined, false, 0);
    const doc = await store.saveDoc("FAKE", original, "manual");
    const before = await fs.readFile(path.join(dir, "state.json"));
    const mirror = path.join(dir, "docs", `FAKE-${doc.id}.md`);
    const oldMirror = await fs.readFile(mirror);
    const rename = fs.rename.bind(fs);
    const mocked = t.mock.method(
      fs,
      "rename",
      async (from: PathLike, to: PathLike) => {
        if (to === path.join(dir, "state.json"))
          throw Object.assign(new Error("synthetic state failure"), {
            code: "EIO",
          });
        return rename(from, to);
      },
    );
    await assert.rejects(
      store.saveDoc(
        "FAKE",
        { ...original, markdown: "Rejected replacement" },
        "manual",
        doc.id,
        doc.revision,
      ),
    );
    assert.deepEqual(await fs.readFile(path.join(dir, "state.json")), before);
    assert.deepEqual(await fs.readFile(mirror), oldMirror);
    assert.equal(store.state.docs[0].revision, doc.revision);
    assert.ok(
      !(await fs.readdir(dir)).some((name) => name.startsWith(".state-")),
    );
    mocked.mock.restore();
    await store.saveDoc(
      "FAKE",
      { ...original, markdown: "Successful replacement" },
      "manual",
      doc.id,
      doc.revision,
    );
    assert.equal(store.docsExportStatus.status, "ready");
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("failed Markdown export reports saved state and a durable recovery warning; restart rebuilds from authority", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-doc-rebuild-"));
  const store = new Store(dir, "9".repeat(64));
  let reader: Store | undefined;
  let reopened: Store | undefined;
  try {
    await store.init();
    await store.save(platform, undefined, false, 0);
    const doc = await store.saveDoc("FAKE", original, "manual");
    const mirror = path.join(dir, "docs", `FAKE-${doc.id}.md`);
    const rename = fs.rename.bind(fs);
    const mocked = t.mock.method(
      fs,
      "rename",
      async (from: PathLike, to: PathLike) => {
        if (to === mirror) {
          const authority = JSON.parse(
            await fs.readFile(path.join(dir, "state.json"), "utf8"),
          ) as State;
          assert.equal(authority.docs[0].markdown, "Committed replacement");
          throw new Error(
            "synthetic-sensitive-upstream-detail-must-not-escape",
          );
        }
        return rename(from, to);
      },
    );
    const saved = await store.saveDoc(
      "FAKE",
      { ...original, markdown: "Committed replacement" },
      "manual",
      doc.id,
      doc.revision,
    );
    assert.equal(saved.revision, doc.revision + 1);
    assert.equal(store.state.docs[0].revision, saved.revision);
    assert.equal(store.docsExportStatus.status, "pending");
    assert.match(JSON.stringify(store.docsExportStatus), /已保存/);
    assert.ok(
      !JSON.stringify(store.docsExportStatus).includes("synthetic-sensitive"),
    );
    assert.match(await fs.readFile(mirror, "utf8"), /Original public usage/);
    assert.ok(
      !(await fs.readdir(path.join(dir, "docs"))).some((name) =>
        name.endsWith(".part"),
      ),
    );
    await fs.access(path.join(dir, ".docs-export-pending"));
    const nextConfiguration = await store.save(
      { ...platform, name: "Next committed configuration" },
      undefined,
      false,
      1,
    );
    assert.equal(nextConfiguration.revision, 2);
    assert.equal(store.state.docs[0].revision, saved.revision);
    reader = new Store(dir, "9".repeat(64), [], { readOnly: true });
    await reader.init();
    assert.equal(reader.docsExportStatus.status, "pending");
    assert.equal(reader.state.docs[0].markdown, "Committed replacement");
    await reader.close();
    await store.close();
    mocked.mock.restore();
    reopened = new Store(dir, "9".repeat(64));
    await reopened.init();
    assert.equal(reopened.docsExportStatus.status, "ready");
    assert.match(await fs.readFile(mirror, "utf8"), /Committed replacement/);
    await assert.rejects(fs.access(path.join(dir, ".docs-export-pending")), {
      code: "ENOENT",
    });
    const next = await reopened.saveDoc(
      "FAKE",
      { ...original, markdown: "Next valid revision" },
      "manual",
      doc.id,
      saved.revision,
    );
    assert.equal(next.revision, saved.revision + 1);
  } finally {
    await reader?.close();
    await reopened?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
