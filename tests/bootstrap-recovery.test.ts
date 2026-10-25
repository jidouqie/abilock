import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { initializeAdminAtRoot, verifyAdminAtRoot } from "../src/isolation-bootstrap.js";
import { loadLocalRuntime } from "../src/local-state.js";
import { platformSchema } from "../src/schema.js";
import { assertLockReleased } from "./helpers/store-lock.js";

const firstPassword = "synthetic-first-bootstrap-6328";
const otherPassword = "synthetic-second-bootstrap-6328";
const markerValue = "password-management-v2\n";
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-bootstrap-transaction-"));
  const root = path.join(parent, "private"), data = path.join(root, "data");
  const runtime = await loadLocalRuntime({ dir: root });
  await runtime.store.save(platformSchema.parse({ alias: "FAKE", name: "Synthetic bootstrap fixture",
    baseUrl: "https://example.test", auth: { type: "bearer" }, rules: [] }),
  { value: "synthetic-bootstrap-provider-6328" }, false, 0);
  await runtime.store.close();
  return { root, data, auth: path.join(data, "admin-auth.json"), marker: path.join(data, "admin-auth.v2"),
    env: path.join(root, "service.env"), async close() { await fs.rm(parent, { recursive: true, force: true }); } };
}
async function matchesPassword(file: string, password: string) {
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  const digest = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, Buffer.from(record.salt, "hex"), 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
  try { return digest.toString("hex") === record.hash; } finally { digest.fill(0); }
}

test("concurrent bootstrap cannot replace the password of the successful initializer", { timeout: 10000 }, async (t) => {
  const f = await fixture();
  const environment = await fs.readFile(f.env);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const open = fs.open.bind(fs);
  let waiting = true;
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (waiting && typeof args[0] === "string" && args[0].startsWith(path.join(f.data, ".admin-bootstrap-"))) {
      waiting = false; entered(); await gate;
    }
    return open(...args);
  });
  const first = initializeAdminAtRoot(firstPassword, f.root);
  try {
    await entry;
    await assert.rejects(initializeAdminAtRoot(otherPassword, f.root), { code: "BOOTSTRAP_BUSY" });
    await assert.rejects(verifyAdminAtRoot(f.root), { code: "BOOTSTRAP_BUSY" });
    release(); await first;
    assert.equal(await matchesPassword(f.auth, firstPassword), true);
    assert.equal(await matchesPassword(f.auth, otherPassword), false);
    const saved = await fs.readFile(f.auth);
    await assert.rejects(initializeAdminAtRoot(otherPassword, f.root), /already initialized/);
    assert.deepEqual(await fs.readFile(f.auth), saved);
    assert.deepEqual(await fs.readFile(f.env), environment);
    await assertLockReleased(path.join(f.data, "bootstrap.lock"));
  } finally { release(); await first.catch(() => {}); hook.mock.restore(); await f.close(); }
});

test("a partial marker write is never published and installer verification repairs it without changing the password or master", async (t) => {
  const f = await fixture();
  const environment = await fs.readFile(f.env);
  const open = fs.open.bind(fs);
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (typeof args[0] === "string" && args[0].startsWith(path.join(f.data, ".admin-marker-"))) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (value, options) => {
        assert.equal(typeof value, "string");
        await write((value as string).slice(0, 4), options);
        throw Object.assign(new Error("synthetic marker interruption"), { code: "EIO" });
      };
    }
    return handle;
  });
  try {
    await assert.rejects(initializeAdminAtRoot(firstPassword, f.root), { code: "EIO" });
    hook.mock.restore();
    const auth = await fs.readFile(f.auth);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
    assert.ok(!(await fs.readdir(f.data)).some((name) => name.startsWith(".admin-marker-")));
    assert.equal(await verifyAdminAtRoot(f.root), "initialized");
    assert.equal(await fs.readFile(f.marker, "utf8"), markerValue);
    assert.deepEqual(await fs.readFile(f.auth), auth);
    assert.deepEqual(await fs.readFile(f.env), environment);
    assert.equal(await matchesPassword(f.auth, firstPassword), true);
    await assertLockReleased(path.join(f.data, "bootstrap.lock"));
  } finally { hook.mock.restore(); await f.close(); }
});

test("verification repairs missing, empty and partial fixed markers and preserves unknown data", async () => {
  const f = await fixture();
  try {
    await initializeAdminAtRoot(firstPassword, f.root);
    const auth = await fs.readFile(f.auth), environment = await fs.readFile(f.env);
    for (const partial of [null, "", "password-", markerValue]) {
      if (partial === null) await fs.unlink(f.marker);
      else await fs.writeFile(f.marker, partial);
      assert.equal(await verifyAdminAtRoot(f.root), "initialized");
      assert.equal(await fs.readFile(f.marker, "utf8"), markerValue);
      assert.deepEqual(await fs.readFile(f.auth), auth);
      assert.deepEqual(await fs.readFile(f.env), environment);
    }
    await fs.writeFile(f.marker, "unknown-marker");
    await assert.rejects(verifyAdminAtRoot(f.root), /Invalid authentication marker/);
    assert.equal(await fs.readFile(f.marker, "utf8"), "unknown-marker");
    await fs.writeFile(f.auth, '{"version":');
    await assert.rejects(verifyAdminAtRoot(f.root));
    assert.equal(await fs.readFile(f.auth, "utf8"), '{"version":');
    assert.deepEqual(await fs.readFile(f.env), environment);
  } finally { await f.close(); }
});

test("verification refuses a mismatched master before repairing a partial marker", async () => {
  const f = await fixture();
  try {
    await initializeAdminAtRoot(firstPassword, f.root);
    const auth = await fs.readFile(f.auth);
    const config = (await fs.readFile(f.env, "utf8")).replace(/^ABILOCK_MASTER_KEY=.*$/m, "ABILOCK_MASTER_KEY=" + "a".repeat(64));
    await fs.writeFile(f.env, config);
    await fs.writeFile(f.marker, "pass");
    await assert.rejects(verifyAdminAtRoot(f.root));
    assert.equal(await fs.readFile(f.marker, "utf8"), "pass");
    assert.equal(await fs.readFile(f.env, "utf8"), config);
    assert.deepEqual(await fs.readFile(f.auth), auth);
  } finally { await f.close(); }
});

test("read-only initialization status does not create an absent data directory", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-bootstrap-status-"));
  const root = path.join(parent, "absent");
  try {
    assert.equal(await verifyAdminAtRoot(root), "setup-required");
    await assert.rejects(fs.access(root), { code: "ENOENT" });
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
