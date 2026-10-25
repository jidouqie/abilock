import test, { mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { once } from "node:events";
import { WebSocket } from "ws";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { assertTargetBoundary } from "../src/protocol-boundary.js";
import { postgresAdapter } from "../src/protocols/databases.js";
import type { Connection } from "../src/connections.js";

const connection: Connection = {
  alias: "DNS_DEADLINE",
  kind: "postgres",
  name: "Synthetic DNS wait",
  description: "No sockets to target",
  enabled: true,
  trustBoundary: "independent-target",
  config: {
    host: "hanging.example.com",
    user: "fixture",
    database: "fixture",
    tls: true,
  },
};
test("target boundary abort rejects pending DNS and ignores a late resolution", async () => {
  let finish!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  try {
    const waiting = assertTargetBoundary(connection, false, controller.signal);
    controller.abort();
    await assert.rejects(waiting, { code: "REQUEST_CANCELLED" });
    finish([{ address: "1.1.1.1", family: 4 }]);
    await new Promise((r) => setImmediate(r));
  } finally {
    lookup.mock.restore();
  }
});

test("closing terminal during pending preflight DNS prevents late SSH connection", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-terminal-dns-"));
  const store = new Store(dir, "8".repeat(64)),
    exec = "synthetic-terminal-exec-capability-0000";
  await store.init();
  await store.saveConnection(
    {
      ...connection,
      kind: "ssh",
      config: {
        host: "hanging.example.com",
        port: 22,
        username: "fixture",
        hostKeySHA256:
          "SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=+$/, ""),
        remoteRoot: "/srv/business",
      },
    },
    { password: "synthetic-ssh-password" },
    false,
    0,
  );
  const server = await startServers({
    store,
    execToken: exec,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: () => {},
  });
  let finish!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ws = new WebSocket(
    server.execUrl.replace("http:", "ws:") + "/v2/terminal/ssh/DNS_DEADLINE",
    { headers: { authorization: `Bearer ${exec}` } },
  );
  try {
    await once(ws, "open");
    assert.equal(lookup.mock.callCount(), 1);
    const closed = once(ws, "close");
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 30));
    finish([{ address: "1.1.1.1", family: 4 }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    ws.terminate();
    lookup.mock.restore();
    await server.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("broker operation timeout covers preflight DNS; late lookup never starts adapter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-broker-dns-"));
  const store = new Store(dir, "7".repeat(64));
  const exec = "synthetic-dns-execution-capability-0000";
  await store.init();
  await store.saveConnection(
    connection,
    { password: "synthetic-dns-password" },
    false,
    0,
  );
  const server = await startServers({
    store,
    execToken: exec,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: () => {},
  });
  let finish!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const run = mock.method(postgresAdapter, "run", async () => ({
    exitCode: 0,
  }));
  try {
    const start = Date.now();
    const response = await fetch(
      server.execUrl + "/v2/run/postgres/DNS_DEADLINE",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${exec}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ args: ["-c", "SELECT 1"], timeoutMs: 100 }),
        signal: AbortSignal.timeout(1500),
      },
    );
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "UPSTREAM_TIMEOUT");
    assert.ok(Date.now() - start < 1000);
    assert.equal(run.mock.callCount(), 0);
    finish([{ address: "1.1.1.1", family: 4 }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(run.mock.callCount(), 0);
  } finally {
    lookup.mock.restore();
    run.mock.restore();
    await server.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
