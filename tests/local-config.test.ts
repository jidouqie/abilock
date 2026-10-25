import { assertLockReleased } from "./helpers/store-lock.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { platformSchema } from "../src/schema.js";
import { bootLocalConfig } from "../src/local-config.js";
import {
  loadLocalRuntime,
  loadLocalStore,
  localPackageRoot,
} from "../src/local-state.js";

test("temporary configuration starts only management and closes its listener and writer lock", async () => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-config-"),
  );
  const dir = path.join(parent, "private");
  const server = await bootLocalConfig({
    dir,
    adminPort: 0,
    registerSignals: false,
  });
  try {
    assert.ok(server.admin.listening);
    assert.equal(server.executor.listening, false);
    assert.equal(server.executor.address(), null);
    assert.equal(server.execUrl, "");
    assert.deepEqual(await (await fetch(server.adminUrl + "/health")).json(), {
      ok: true,
      role: "management",
    });
    const status = await fetch(server.adminUrl + "/admin/auth/status", {
      headers: { origin: server.adminUrl, "x-abilock-ui": "1" },
    });
    assert.equal(status.status, 200);
    const denied = await fetch(server.adminUrl + "/v1/platforms");
    assert.equal(denied.status, 404);
    const setup = await fetch(server.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: {
        origin: server.adminUrl,
        "x-abilock-ui": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "synthetic-temporary-admin-only",
        confirmPassword: "synthetic-temporary-admin-only",
      }),
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const external = await loadLocalStore({ dir, requireExisting: true });
    try {
      await external.save(platformSchema.parse({ alias: "EXTERNAL", name: "Synthetic external writer",
        baseUrl: "https://example.test", auth: { type: "none" }, rules: [] }), undefined, false, 0);
      const fresh = await fetch(server.adminUrl + "/admin/platforms", {
        headers: { cookie, origin: server.adminUrl, "x-abilock-ui": "1" },
      });
      assert.equal(fresh.status, 200);
      assert.equal((await fresh.json()).platforms[0].alias, "EXTERNAL");
      await external.applyLearnedPlatform("EXTERNAL", {
        expectedRevision: 1, title: "Public usage", sourceUrl: "https://example.test/docs",
        markdown: "GET /status", rules: [{ method: "GET", path: "/status" }], capabilityNotes: [],
      });
      const docs = await fetch(server.adminUrl + "/admin/docs", {
        headers: { cookie, origin: server.adminUrl, "x-abilock-ui": "1" },
      });
      assert.equal(docs.status, 200);
      assert.equal((await docs.json()).docs[0].markdown, "GET /status");
      await assertLockReleased(path.join(dir, "data/service.lock"));
    } finally { await external.close(); }
    const rejectedOrigin = await fetch(server.adminUrl + "/admin/auth/login", {
      method: "POST",
      headers: {
        origin: "https://other.example",
        "x-abilock-ui": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "synthetic-temporary-admin-only" }),
    });
    assert.equal(rejectedOrigin.status, 403);
    const reader = await loadLocalStore({ dir, readOnly: true });
    try {
      assert.equal(reader.list()[0].alias, "EXTERNAL");
    } finally {
      await reader.close();
    }
  } finally {
    await Promise.all([server.close(), server.close()]);
    assert.equal(server.admin.listening, false);
    assert.equal(server.executor.listening, false);
    await assertLockReleased(path.join(dir, "data/service.lock"));
    await assert.rejects(fetch(server.adminUrl + "/health"));
    await fs.rm(parent, { recursive: true, force: true });
  }
});

function childMessage(child: ChildProcess, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error(`Synthetic child did not send ${type}`));
    }, 10000);
    const onClose = () => {
      dispose();
      reject(new Error(`Synthetic child closed before ${type}`));
    };
    const onMessage = (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        Reflect.get(value, "type") === type
      ) {
        dispose();
        resolve(value as Record<string, unknown>);
      }
    };
    function dispose() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("close", onClose);
    }
    child.on("message", onMessage);
    child.once("close", onClose);
  });
}

for (const phase of ["init"] as const) {
  test(`configuration startup SIGINT during ${phase} releases its acquired writer lock without reporting a running page`, async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "abilock-local-config-startup-"),
    );
    const dir = path.join(parent, ".abilock");
    const script = path.join(parent, "synthetic-startup-child.mjs");
    const configEntry = pathToFileURL(
      path.join(localPackageRoot, "dist/src/local-config.js"),
    ).href;
    const storeEntry = pathToFileURL(
      path.join(localPackageRoot, "dist/src/store.js"),
    ).href;
    await fs.writeFile(
      script,
      `
import { bootLocalConfig } from ${JSON.stringify(configEntry)};
import { Store } from ${JSON.stringify(storeEntry)};
let release;
const gate = new Promise((resolve) => { release = resolve; });
process.on("message", (message) => { if (message?.type === "release") release(); });
let blocked = false;
const method = "init";
const original = Store.prototype[method];
Store.prototype[method] = async function (...args) {
  const value = await original.apply(this,args);
  if (!blocked) {
    blocked = true;
    process.send({ type: "locked" });
    await gate;
  }
  return value;
};
try {
  const server = await bootLocalConfig({dir: process.argv[2], adminPort: 0});
  process.send({type: "started", url: server.adminUrl});
  await server.close();
} catch (error) {
  process.send({type: "canceled", code: error?.code});
  process.exitCode = error?.code === "CANCELLED" ? 130 : 1;
} finally { process.disconnect(); }
`,
      { mode: 0o600 },
    );
    const child = fork(script, [dir], {
      cwd: parent,
      env: { HOME: parent, USERPROFILE: parent, LANG: "en_US.UTF-8" },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "",
      stderr = "",
      started = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("message", (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        Reflect.get(value, "type") === "started"
      )
        started = true;
    });
    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await childMessage(child, "locked");
      await fs.access(path.join(dir, "data/service.lock"));
      const config = await fs.readFile(path.join(dir, "service.env"));
      child.kill("SIGINT");
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      child.kill("SIGINT");
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      assert.ok(child.connected);
      assert.equal(child.signalCode, null);
      const canceled = childMessage(child, "canceled");
      child.send({ type: "release" });
      assert.equal((await canceled).code, "CANCELLED");
      assert.deepEqual(await completion, { code: 130, signal: null });
      assert.equal(started, false);
      assert.equal(stdout, "");
      assert.equal(stderr, "");
      await assertLockReleased(path.join(dir, "data/service.lock"));
      assert.deepEqual(
        await fs.readFile(path.join(dir, "service.env")),
        config,
      );
      const reopened = await loadLocalRuntime({ dir });
      try {
        assert.equal(reopened.store.list().length, 0);
        assert.deepEqual(
          await fs.readFile(path.join(dir, "service.env")),
          config,
        );
      } finally {
        await reopened.store.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await completion.catch(() => {});
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
}

test("two foreground SIGINT signals cannot interrupt temporary configuration lock cleanup", async () => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-config-signals-"),
  );
  const dir = path.join(parent, ".abilock");
  const script = path.join(parent, "synthetic-child.mjs");
  const entry = pathToFileURL(
    path.join(localPackageRoot, "dist/src/local-config.js"),
  ).href;
  await fs.writeFile(
    script,
    `
import { bootLocalConfig } from ${JSON.stringify(entry)};
const server = await bootLocalConfig({ dir: process.argv[2], adminPort: 0 });
const originalClose = server.store.close.bind(server.store);
let release;
const released = new Promise((resolve) => { release = resolve; });
process.on("message", (message) => { if (message?.type === "release") release(); });
server.store.close = async () => {
  process.send({ type: "closing" });
  await released;
  await originalClose();
  process.disconnect();
};
process.send({ type: "ready", url: server.adminUrl });
`,
    { mode: 0o600 },
  );
  const child = fork(script, [dir], {
    cwd: parent,
    env: { HOME: parent, USERPROFILE: parent, LANG: "en_US.UTF-8" },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const message = (type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error(`Synthetic child did not send ${type}`));
      }, 10000);
      const onClose = () => {
        dispose();
        reject(new Error(`Synthetic child closed before ${type}`));
      };
      const onMessage = (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          Reflect.get(value, "type") === type
        ) {
          dispose();
          resolve(value as Record<string, unknown>);
        }
      };
      function dispose() {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("close", onClose);
      }
      child.on("message", onMessage);
      child.once("close", onClose);
    });
  try {
    const ready = await message("ready");
    const url = String(ready.url);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    await fs.access(path.join(dir, "data/service.lock"));
    const config = await fs.readFile(path.join(dir, "service.env"));
    const closing = message("closing");
    child.kill("SIGINT");
    await closing;
    // The first signal is deliberately held inside store.close(). A second
    // signal must be absorbed by production handlers, without adding a test
    // signal handler that could accidentally mask the original bug.
    child.kill("SIGINT");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(child.signalCode, null);
    assert.ok(child.connected);
    child.send({ type: "release" });
    const exit = await completion;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");
    await assertLockReleased(path.join(dir, "data/service.lock"));
    assert.deepEqual(await fs.readFile(path.join(dir, "service.env")), config);
    await assert.rejects(fetch(url + "/health"));
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await completion.catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  }
});
