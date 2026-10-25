import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Writable } from "node:stream";
import { Store } from "../src/store.js";
import { platformSchema } from "../src/schema.js";
import { acquireProcessLock } from "../src/process-lock.js";
import { executeLocalRequest, LocalResponse } from "../src/local-execution.js";
import { assertLockReleased } from "./helpers/store-lock.js";

const key = "9".repeat(64);
const platform = (alias = "FAKE", name = "Synthetic API") => platformSchema.parse({
  alias, name, baseUrl: "https://example.test", auth: { type: "bearer" }, rules: [],
});
const manifest = (expectedRevision = 1) => ({
  expectedRevision, sourceUrl: "https://example.test/docs", title: "Public API",
  markdown: "GET /status returns health", rules: [{ method: "GET", path: "/status" }],
  capabilityNotes: [],
});
type Reply = { id: number; value?: unknown; error?: { code?: string } };
function worker(dir: string) {
  const child = fork(path.resolve("tests/fixtures/store-transaction-worker.ts"), [dir], {
    execArgv: ["--import", "tsx"], silent: true,
  });
  const exited = once(child, "exit");
  const ready = Promise.race([
    once(child, "message").then(([value]) => assert.deepEqual(value, { type: "ready" })),
    exited.then(() => { throw new Error("fixture exited before ready"); }),
  ]);
  let sequence = 0;
  const call = (message: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { cleanup(); reject(new Error("fixture timed out")); }, 12000);
    const receive = (value: unknown) => {
      if (!value || typeof value !== "object" || Reflect.get(value, "id") !== id) return;
      cleanup();
      resolve(value as Reply);
    };
    const closed = () => { cleanup(); reject(new Error("fixture exited")); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", closed);
    };
    child.on("message", receive);
    child.once("exit", closed);
    child.send({ ...message, id });
  });
  return { child, ready, call, async close() {
    if (child.connected) child.send({ action: "close" });
    await exited;
  }};
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-transactions-"));
  const store = new Store(dir, key);
  await store.init();
  await store.save(platform(), { value: "synthetic-private-value-1042" }, false, 0);
  return { dir, store };
}

test("independent configuration and learning transactions merge without a window-lifetime lock", { timeout: 20000 }, async () => {
  const { dir, store } = await setup();
  const a = worker(dir), b = worker(dir);
  let gate: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
  try {
    await Promise.all([a.ready, b.ready]);
    await assertLockReleased(path.join(dir, "service.lock"));
    const reader = new Store(dir, key, [], { readOnly: true });
    await reader.init();
    try {
      gate = await acquireProcessLock(path.join(dir, "service.lock"));
      const saving = a.call({ action: "save", value: platform("SECOND"), expected: 0 });
      const learning = b.call({ action: "learn", alias: "FAKE", value: manifest() });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await gate.release(); gate = undefined;
      const [saved, learned] = await Promise.all([saving, learning]);
      assert.equal(saved.error, undefined);
      assert.equal(learned.error, undefined);
      await reader.refresh();
      assert.deepEqual(reader.list().map((item) => item.alias).sort(), ["FAKE", "SECOND"]);
      assert.equal(reader.platform("FAKE").revision, 2);
      assert.equal(reader.state.docs[0].markdown, manifest().markdown);
      assert.ok(!JSON.stringify(reader.list()).includes("synthetic-private-value"));
      // The long-lived management Store must also pick up the child's commit.
      await store.refresh();
      assert.equal(store.state.docs[0].id, reader.state.docs[0].id);
      await assertLockReleased(path.join(dir, "service.lock"));
    } finally { await reader.close(); }
  } finally {
    await gate?.release();
    await Promise.all([a.close(), b.close()]);
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("two processes racing the same revision reject one stale edit without restoring old target or credentials", { timeout: 20000 }, async () => {
  const { dir, store } = await setup();
  const a = worker(dir), b = worker(dir);
  try {
    await Promise.all([a.ready, b.ready]);
    const changed = { ...platform(), baseUrl: "https://new.example.test" };
    const results = await Promise.all([
      a.call({ action: "save", value: changed, expected: 1 }),
      b.call({ action: "learn", alias: "FAKE", value: manifest() }),
    ]);
    assert.equal(results.filter((item) => !item.error).length, 1);
    assert.equal(results.find((item) => item.error)!.error!.code, "REVISION_CONFLICT");
    await store.refresh();
    const current = store.platform("FAKE");
    assert.equal(current.revision, 2);
    assert.equal(store.unseal(current.sealed!).value, "synthetic-private-value-1042");
    if (!results[0].error) {
      assert.equal(current.baseUrl, changed.baseUrl);
      assert.deepEqual(current.rules, []);
      assert.equal(store.state.docs.length, 0);
    } else {
      assert.equal(current.baseUrl, platform().baseUrl);
      assert.equal(store.state.docs.length, 1);
    }
    const before = await fs.readFile(path.join(dir, "state.json"));
    const replay = await b.call({ action: "learn", alias: "FAKE", value: manifest() });
    assert.equal(replay.error!.code, "REVISION_CONFLICT");
    assert.deepEqual(await fs.readFile(path.join(dir, "state.json")), before);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a reused read-only local API store refreshes committed manuals before returning context", async () => {
  const { dir, store } = await setup();
  const reader = new Store(dir, key, [], { readOnly: true });
  try {
    await reader.init();
    await store.applyLearnedPlatform("FAKE", manifest() as Parameters<Store["applyLearnedPlatform"]>[1]);
    const before = await fs.readFile(path.join(dir, "state.json"));
    const chunks: Buffer[] = [];
    const response = new LocalResponse(new Writable({ write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk)); done();
    }}), () => {});
    await executeLocalRequest(reader, { type: "request", method: "GET", url: "/v1/context/FAKE", headers: {} }, response,
      { signal: new AbortController().signal, programRoot: path.resolve(".") });
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(value.platform.revision, 2);
    assert.equal(value.docs[0].markdown, manifest().markdown);
    assert.deepEqual(await fs.readFile(path.join(dir, "state.json")), before);
  } finally {
    await reader.close(); await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cancelling a waiting transaction does not change authority or release another process lock", async () => {
  const { dir, store } = await setup();
  const controller = new AbortController();
  const waiting = new Store(dir, key, [], { signal: controller.signal });
  let gate: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
  try {
    await waiting.init();
    const before = await fs.readFile(path.join(dir, "state.json"));
    gate = await acquireProcessLock(path.join(dir, "service.lock"));
    const save = waiting.save(platform("CANCELLED"), undefined, false, 0);
    const rejected = assert.rejects(save, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await rejected;
    await waiting.close();
    assert.deepEqual(await fs.readFile(path.join(dir, "state.json")), before);
    await assert.rejects(acquireProcessLock(path.join(dir, "service.lock")), { code: "CONFIG_BUSY" });
    // Refresh does not wait on the active writer's descriptor or repair files.
    await store.refresh();
    assert.equal(store.list().length, 1);
  } finally {
    await gate?.release();
    await waiting.close(); await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
