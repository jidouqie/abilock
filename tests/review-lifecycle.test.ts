import { assertLockReleased } from "./helpers/store-lock.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net, { type Socket } from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { AppError, type Platform, type State } from "../src/schema.js";
import { startServers, type ServerOptions } from "../src/server.js";
import { executionGateway } from "../src/execution-gateway.js";

// This test process owns only synthetic loopback fixtures; never inherit or
// inspect private service configuration to enable them.
process.env.ABILOCK_MOCK = "1";
process.env.ABILOCK_ALLOW_LOCAL = "1";
const execToken = "synthetic-lifecycle-execution-token-09032";
const sshPassword = "synthetic-lifecycle-ssh-password-09033";

function platform(alias: string): Platform {
  return {
    alias,
    name: alias,
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
    enabled: true,
    allowInsecureLocal: false,
    description: "synthetic lifecycle fixture",
    rules: [{ method: "GET", path: "/echo" }],
  };
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("lifecycle fixture timeout")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type ExportHook = { exportDocs(state: State): Promise<void> };

test(
  "Store close drains accepted writes before a replacement writer can open",
  { timeout: 10000 },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "abilock-review-drain-"),
    );
    const first = new Store(dir, "9".repeat(64));
    let replacement: Store | undefined;
    let release = () => {};
    const writes: Promise<unknown>[] = [];
    try {
      await first.init();
      await first.save(platform("BASE"), undefined, false, 0);
      let entered = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hooks = first as unknown as ExportHook;
      const original = hooks.exportDocs.bind(first);
      let holdFirst = true;
      t.mock.method(hooks, "exportDocs", async (state: State) => {
        if (holdFirst) {
          holdFirst = false;
          entered();
          await held;
        }
        await original(state);
      });
      const oldWrite = first.save(
        platform("OLD_INFLIGHT"),
        undefined,
        false,
        0,
      );
      writes.push(oldWrite);
      await bounded(entry);
      const queuedWrite = first.save(
        platform("OLD_QUEUED"),
        undefined,
        false,
        0,
      );
      writes.push(queuedWrite);
      const closing = first.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await delay(30);
      replacement = new Store(dir, "9".repeat(64));
      let opened = false;
      const opening = replacement.init().then(() => { opened = true; });
      await delay(40);
      assert.equal(opened, false, "an active transaction retains its lock");
      assert.equal(closed, false);
      assert.strictEqual(first.close(), closing);
      await assert.rejects(
        first.save(platform("TOO_LATE"), undefined, false, 0),
        (error: unknown) => error instanceof AppError && error.code === "STORE_CLOSED",
      );
      release();
      await bounded(Promise.all([...writes, closing, opening]));
      await replacement.save(platform("NEW_AFTER_RESTART"), undefined, false, 0);
      const state = JSON.parse(
        await fs.readFile(path.join(dir, "state.json"), "utf8"),
      ) as State;
      assert.deepEqual(state.platforms.map((p) => p.alias).sort(), [
        "BASE",
        "NEW_AFTER_RESTART",
        "OLD_INFLIGHT",
        "OLD_QUEUED",
      ]);
      assert.strictEqual(first.close(), closing);
      await assert.rejects(
        first.save(platform("CLOSED"), undefined, false, 0),
        (error: unknown) =>
          error instanceof AppError && error.code === "STORE_CLOSED",
      );
    } finally {
      release();
      await Promise.allSettled(writes);
      await replacement?.close();
      await first.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Store close drains past a failed queued transaction without dropping later accepted writes",
  { timeout: 10000 },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "abilock-review-drain-failure-"),
    );
    const store = new Store(dir, "9".repeat(64));
    let release = () => {};
    let pending: Promise<unknown>[] = [];
    try {
      await store.init();
      await store.save(platform("BASE"), undefined, false, 0);
      let entered = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hooks = store as unknown as ExportHook;
      const original = hooks.exportDocs.bind(store);
      t.mock.method(hooks, "exportDocs", async (state: State) => {
        entered();
        await held;
        await original(state);
      });
      const first = store.save(platform("FIRST"), undefined, false, 0);
      await bounded(entry);
      const failed = store.save(platform("BASE"), undefined, false, 0).then(
        () => undefined,
        (error: unknown) => error,
      );
      const last = store.save(platform("LAST"), undefined, false, 0);
      pending = [first, failed, last];
      const closing = store.close();
      release();
      const results = await bounded(Promise.all([...pending, closing]));
      assert(results[1] instanceof AppError);
      assert.equal(results[1].code, "REVISION_CONFLICT");
      const state = JSON.parse(
        await fs.readFile(path.join(dir, "state.json"), "utf8"),
      ) as State;
      assert.deepEqual(
        state.platforms.map((p) => p.alias),
        ["BASE", "FIRST", "LAST"],
      );
      await assertLockReleased(path.join(dir, "service.lock"));
    } finally {
      release();
      await Promise.allSettled(pending);
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Store initialization failure closes its lock without waiting on itself",
  { timeout: 10000 },
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "abilock-review-init-failure-"),
    );
    const store = new Store(dir, "9".repeat(64));
    try {
      await fs.writeFile(
        path.join(dir, "state.json"),
        '{"version":999,"platforms":[],"docs":[]}',
      );
      const initializing = store.init();
      const closing = store.close();
      await assert.rejects(bounded(initializing), /配置或主密钥无效/);
      await bounded(closing);
      assert.strictEqual(store.close(), closing);
      await assertLockReleased(path.join(dir, "service.lock"));
      await assert.rejects(
        store.save(platform("FAILED_INIT"), undefined, false, 0),
        (error: unknown) =>
          error instanceof AppError && error.code === "STORE_CLOSED",
      );
    } finally {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Store close waits for shared initialization before releasing its lock",
  { timeout: 10000 },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "abilock-review-init-drain-"),
    );
    const seed = new Store(dir, "9".repeat(64));
    const store = new Store(dir, "9".repeat(64));
    let release = () => {};
    try {
      await seed.init();
      await seed.save(platform("BASE"), undefined, false, 0);
      await seed.close();
      let entered = () => {};
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hooks = store as unknown as ExportHook;
      const original = hooks.exportDocs.bind(store);
      t.mock.method(hooks, "exportDocs", async (state: State) => {
        entered();
        await held;
        await original(state);
      });
      const initializing = store.init();
      assert.strictEqual(store.init(), initializing);
      await bounded(entry);
      const closing = store.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await delay(20);
      assert.equal(closed, false);
      await fs.access(path.join(dir, "service.lock"));
      release();
      await bounded(Promise.all([initializing, closing]));
      await assertLockReleased(path.join(dir, "service.lock"));
      await assert.rejects(
        store.init(),
        (error: unknown) =>
          error instanceof AppError && error.code === "STORE_CLOSED",
      );
    } finally {
      release();
      await store.close();
      await seed.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

async function coreFixture(log: ServerOptions["log"] = () => {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-review-server-lifecycle-"),
  );
  const store = new Store(dir, "9".repeat(64));
  let core: Awaited<ReturnType<typeof startServers>> | undefined;
  let gate: Awaited<ReturnType<typeof executionGateway>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([gate?.close(), core?.close()]);
    try {
      await store.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    await store.init();
    core = await startServers({
      store,
      execToken,
      adminPort: 0,
      execPort: 0,
      webDir: path.resolve("dist/web"),
      log,
    });
    gate = await executionGateway({
      coreUrl: core.execUrl,
      execToken,
      port: 0,
    });
    return { store, core, gate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
async function rejectedUpgrade(url: string): Promise<Socket> {
  const port = Number(new URL(url).port);
  const socket = net.createConnection({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  socket.on("error", () => {});
  try {
    await bounded(once(socket, "connect"));
    let response = "";
    socket.on("data", (bytes: Buffer) => {
      response += bytes.toString();
    });
    const ended = once(socket, "end");
    socket.write(
      `GET /invalid-upgrade HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await bounded(ended);
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

test(
  "core and gateway shutdown completes while rejected Upgrade peers keep their write halves open",
  { timeout: 10000 },
  async () => {
    const f = await coreFixture();
    const clients: Socket[] = [];
    try {
      clients.push(await rejectedUpgrade(f.core.execUrl));
      clients.push(await rejectedUpgrade(f.gate.url));
      await bounded(Promise.all([f.core.close(), f.gate.close()]));
      assert.equal(f.core.executor.listening, false);
      assert.equal(f.gate.server.listening, false);
    } finally {
      for (const client of clients) client.destroy();
      await f.close();
    }
  },
);

async function sshFixture() {
  const keys = ssh2.utils.generateKeyPairSync("ed25519");
  const key = ssh2.utils.parseKey(keys.private);
  assert(!(key instanceof Error) && !Array.isArray(key));
  const hostKeySHA256 =
    "SHA256:" +
    crypto
      .createHash("sha256")
      .update(key.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const clients = new Set<ssh2.Connection>();
  const ssh = new ssh2.Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === "fixture" &&
        ctx.password === sshPassword
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => {
          accept();
        });
        session.on("shell", (accept) => {
          const stream = accept();
          stream.on("error", () => {});
          stream.on("data", () => {
            stream.exit(0);
            stream.end("synthetic-terminal-finished\n");
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  return {
    port: (ssh.address() as net.AddressInfo).port,
    hostKeySHA256,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => ssh.close(() => resolve()));
    },
  };
}

test(
  "throwing and rejecting log sinks do not fail health or terminal completion",
  { timeout: 20000 },
  async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const kind of ["sync", "async"] as const) {
        const logs: Record<string, unknown>[] = [];
        const f = await coreFixture((record) => {
          logs.push(record);
          const error = new Error("synthetic lifecycle log failure");
          if (kind === "sync") throw error;
          return Promise.reject(error);
        });
        let ssh: Awaited<ReturnType<typeof sshFixture>> | undefined;
        let ws: WebSocket | undefined;
        try {
          const health = await fetch(f.gate.url + "/health");
          assert.equal(health.status, 200);
          await health.text();
          const coreHealth = await fetch(f.core.execUrl + "/health");
          assert.equal(coreHealth.status, 200);
          await coreHealth.text();
          ssh = await sshFixture();
          await f.store.saveConnection(
            {
              alias: "TERM",
              name: "synthetic lifecycle terminal",
              kind: "ssh",
              enabled: true,
              description: "",
              trustBoundary: "development-fixture",
              config: {
                host: "127.0.0.1",
                port: ssh.port,
                username: "fixture",
                hostKeySHA256: ssh.hostKeySHA256,
                remoteRoot: "/",
                allowShell: true,
              },
            },
            { password: sshPassword },
            false,
            0,
          );
          const invocationId = crypto.randomUUID();
          const frames: Record<string, unknown>[] = [];
          ws = new WebSocket(
            f.gate.url.replace("http:", "ws:") + "/v2/terminal/ssh/TERM",
            {
              headers: {
                authorization: `Bearer ${execToken}`,
                "x-abilock-invocation-id": invocationId,
              },
            },
          );
          ws.on("error", () => {});
          const terminal = ws;
          terminal.on("message", (bytes) => {
            const frame = JSON.parse(bytes.toString()) as Record<
              string,
              unknown
            >;
            frames.push(frame);
            if (frame.type === "ready")
              terminal.send(
                JSON.stringify({
                  type: "data",
                  data: Buffer.from("finish\n").toString("base64"),
                  invocationId,
                  operationId: frame.operationId,
                  sequence: 2,
                  direction: "client",
                }),
              );
          });
          terminal.once("open", () =>
            terminal.send(
              JSON.stringify({
                type: "init",
                trace: { invocationId },
                sequence: 1,
                direction: "client",
              }),
            ),
          );
          await bounded(once(terminal, "close"));
          assert.equal(frames[0]?.type, "ready");
          assert.equal(frames.at(-1)?.type, "exit");
          assert.equal(frames.at(-1)?.code, 0);
          assert(!frames.some((frame) => frame.type === "error"));
          const deadline = Date.now() + 2000;
          while (!logs.some((record) => record.event === "terminal")) {
            assert(
              Date.now() < deadline,
              "terminal cleanup must reach the log sink",
            );
            await delay(5);
          }
          assert(
            logs.some(
              (record) =>
                record.event === "request" && record.completed === true,
            ),
          );
          assert.equal(
            logs.find((record) => record.event === "terminal")?.status,
            0,
          );
          await delay(20);
          assert.deepEqual(unhandled, []);
        } finally {
          ws?.terminate();
          await f.close();
          await ssh?.close();
        }
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
);

test(
  "a 200 response truncated by timeout logs incomplete with its actual upstream timeout code",
  { timeout: 10000 },
  async () => {
    const logs: Record<string, unknown>[] = [];
    const f = await coreFixture((record) => logs.push(record));
    const sockets = new Set<Socket>();
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/slowbody") res.write("started\n");
      else res.end("finished\n");
    });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      await f.store.save(
        {
          ...platform("STREAM"),
          baseUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,
          allowInsecureLocal: true,
          rules: [
            { method: "GET", path: "/slowbody" },
            { method: "GET", path: "/complete" },
          ],
        },
        undefined,
        false,
        0,
      );
      const call = (requestPath: string) =>
        fetch(f.gate.url + "/v1/call/STREAM", {
          method: "POST",
          headers: {
            authorization: `Bearer ${execToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            method: "GET",
            path: requestPath,
            timeoutMs: 100,
          }),
        });
      const response = await call("/slowbody");
      assert.equal(response.status, 200);
      const requestId = response.headers.get("x-abilock-request-id");
      const operationId = response.headers.get("x-abilock-operation-id");
      await assert.rejects(response.text());
      const deadline = Date.now() + 2000;
      while (!logs.some((record) => record.requestId === requestId)) {
        assert(
          Date.now() < deadline,
          "failed response must finish its request log",
        );
        await delay(5);
      }
      const failed = logs.find((record) => record.requestId === requestId)!;
      assert.equal(failed.operationId, operationId);
      assert.equal(failed.status, 200);
      assert.equal(failed.completed, false);
      assert.equal(failed.errorCode, "UPSTREAM_TIMEOUT");
      const complete = await call("/complete");
      assert.equal(await complete.text(), "finished\n");
      const success = logs.find(
        (record) =>
          record.requestId === complete.headers.get("x-abilock-request-id"),
      )!;
      assert.equal(success.completed, true);
      assert.equal(success.errorCode, undefined);
    } finally {
      await f.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);
