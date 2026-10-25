import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { executionGateway } from "../src/execution-gateway.js";
import { assertTargetBoundary } from "../src/protocol-boundary.js";
import type { Connection } from "../src/connections.js";
import { AppError } from "../src/schema.js";
import { postgresFixture, FIXTURE_PASSWORD } from "./db-wire-fixtures.js";
const execToken = "synthetic-broker-exec-capability-97159";
const adminToken = "synthetic-broker-admin-capability-98160";
async function environment(
  log: (record: Record<string, unknown>) => void = () => {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-broker-test-"));
  const store = new Store(dir, "9".repeat(64));
  await store.init();
  const server = await startServers({
    store,
    adminToken,
    execToken,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log,
  });
  return {
    dir,
    store,
    server,
    close: async () => {
      await server.close();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
function req(base: string, route: string, value?: unknown, admin = false) {
  return fetch(base + route, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${admin ? adminToken : execToken}`,
      ...(value ? { "content-type": "application/json" } : {}),
    },
    body: value ? JSON.stringify(value) : undefined,
  });
}
function db(alias: string, port: number): Connection {
  return {
    alias,
    name: alias,
    kind: "postgres",
    enabled: true,
    description: "protocol test",
    trustBoundary: "independent-target",
    config: {
      host: "127.0.0.1",
      port,
      user: "fixture-user",
      database: "fixture-db",
      tls: false,
    },
  };
}
test("统一连接加密、版本冲突、别名与IP身份拒猜、文档和旧state兼容", async () => {
  const f = await environment();
  const wire = await postgresFixture();
  try {
    const first = await f.store.saveConnection(
      db("PG_A", wire.port),
      { password: FIXTURE_PASSWORD },
      false,
      0,
    );
    await f.store.saveConnection(
      db("PG_B", wire.port),
      { password: FIXTURE_PASSWORD },
      false,
      0,
    );
    assert.throws(
      () => f.store.connection("postgres", "127.0.0.1"),
      /多个身份/,
    );
    assert.equal(f.store.connection("postgres", "pg_a").alias, "PG_A");
    await assert.rejects(
      f.store.saveConnection(db("PG_A", wire.port), undefined, false, 0),
      /连接已变化/,
    );
    await assert.rejects(
      f.store.save(
        {
          ...{
            alias: "pg_a",
            name: "conflict",
            baseUrl: "https://example.com",
            enabled: true,
            description: "",
            allowInsecureLocal: false,
          },
          auth: { type: "none" },
          rules: [{ method: "GET", path: "/" }],
        },
        undefined,
        false,
        0,
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "ALIAS_CONFLICT" &&
        error.status === 409,
    );
    const doc = await f.store.saveDoc(
      "PG_A",
      {
        title: "SQL",
        sourceUrl: "https://www.postgresql.org/docs/current/sql.html",
        markdown: "# SELECT\nUse native SQL.",
      },
      "manual",
    );
    const before = structuredClone(f.store.connection("postgres", "PG_A"));
    await f.store.saveDoc(
      "PG_A",
      {
        title: "Updated",
        sourceUrl: doc.sourceUrl,
        markdown: "# Native SQL updated",
      },
      "manual",
      doc.id,
      doc.revision,
    );
    assert.deepEqual(f.store.connection("postgres", "PG_A"), before);
    const publicRead = await req(f.server.execUrl, "/v2/connections").then(
      (r) => r.text(),
    );
    assert(!publicRead.includes(FIXTURE_PASSWORD));
    assert(!publicRead.includes("sealed"));
    const raw = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    assert(!raw.includes(FIXTURE_PASSWORD));
    const context = await req(
      f.server.execUrl,
      "/v2/context/postgres/PG_A",
    ).then((r) => r.json());
    assert.equal(context.docs[0].title, "Updated");
    await f.store.removeConnection("PG_A", first.revision);
    assert(!f.store.state.docs.some((d) => d.alias === "PG_A"));
    const old = await req(f.server.execUrl, "/v1/platforms");
    assert.equal(old.status, 200);
    await f.store.close();
    const restored = new Store(f.dir, "9".repeat(64));
    await restored.init();
    assert.equal(restored.listConnections().length, 1);
    await restored.close();
  } finally {
    await wire.close();
    await f.close();
  }
});
test("新执行路由与网关拒绝管理、任意目标、秘密字段和broker自管理；标准PG wire可通过受控路径", async () => {
  const f = await environment(),
    wire = await postgresFixture();
  const gate = await executionGateway({
    coreUrl: f.server.execUrl,
    execToken,
    port: 0,
  });
  const oldMock = process.env.ABILOCK_MOCK,
    oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  try {
    await f.store.saveConnection(
      db("PG", wire.port),
      { password: FIXTURE_PASSWORD },
      false,
      0,
    );
    assert.equal(
      (
        await req(f.server.execUrl, "/v2/run/postgres/PG", {
          args: ["-c", "SELECT 42"],
        })
      ).status,
      403,
    );
    process.env.ABILOCK_MOCK = "1";
    process.env.ABILOCK_ALLOW_LOCAL = "1";
    const r = await req(gate.url, "/v2/run/postgres/PG", {
      args: ["-c", "SELECT 42"],
    });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /"answer":42/);
    for (const operation of [
      { args: [], secret: { password: "x" } },
      { args: [], endpoint: "http://evil" },
      { args: [], host: "evil" },
    ])
      assert.equal(
        (await req(gate.url, "/v2/run/postgres/PG", operation)).status,
        400,
      );
    for (const route of [
      "/admin/connections",
      "/v2/secrets",
      "/v2/connections?target=/admin",
      "/%2e%2e/admin/connections",
    ])
      assert.equal((await req(gate.url, route)).status, 404);
    assert.equal(
      (await req(f.server.adminUrl, "/admin/connections")).status,
      401,
    );
    assert(!JSON.stringify(out).includes(FIXTURE_PASSWORD));
  } finally {
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = oldMock;
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
    await gate.close();
    await wire.close();
    await f.close();
  }
});
test("独立目标声明不豁免本机/metadata地址，IP别名不能覆盖身份", async () => {
  for (const address of ["127.0.0.1", "::1", "169.254.169.254", "0.0.0.0"])
    await assert.rejects(
      assertTargetBoundary(
        { ...db("PG", 5432), config: { host: address } },
        false,
      ),
    );
  await assert.rejects(
    assertTargetBoundary(
      {
        ...db("PG", 5432),
        trustBoundary: undefined,
        config: { host: "10.1.2.3" },
      },
      false,
    ),
    /确认远端权限/,
  );
  await assertTargetBoundary(
    { ...db("PG", 5432), config: { host: "10.1.2.3" } },
    false,
  );
});
test("SSH WebSocket经过执行网关：鉴权、PTY resize、输入、EOF、跨chunk脱敏和真实退出码", async () => {
  const { Server, utils } = ssh2,
    keys = utils.generateKeyPairSync("ed25519");
  const parsed = utils.parseKey(keys.private);
  assert(!(parsed instanceof Error) && !Array.isArray(parsed));
  const fingerprint =
    "SHA256:" +
    crypto
      .createHash("sha256")
      .update(parsed.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const secret = "synthetic-websocket-ssh-password-96303";
  const clients = new Set<ssh2.Connection>();
  const windows: number[][] = [];
  const ssh = new Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" &&
      ctx.password === secret &&
      ctx.username === "fixture"
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept, _reject, info) => {
          windows.push([info.rows, info.cols]);
          accept();
        });
        session.on("window-change", (_accept, _reject, info) =>
          windows.push([info.rows, info.cols]),
        );
        session.on("shell", (accept) => {
          const stream = accept();
          stream.on("error", () => {});
          stream.write("ready\n");
          stream.on("data", (data: Buffer) => {
            stream.write(secret.slice(0, 10));
            stream.write(secret.slice(10) + "\n");
            stream.write(data);
          });
          stream.on("end", () => {
            stream.exit(7);
            stream.end("done\n");
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  const logs: Record<string, unknown>[] = [];
  const f = await environment((record) => logs.push(record));
  const gate = await executionGateway({
    coreUrl: f.server.execUrl,
    execToken,
    port: 0,
  });
  const oldMock = process.env.ABILOCK_MOCK,
    oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  try {
    process.env.ABILOCK_MOCK = "1";
    process.env.ABILOCK_ALLOW_LOCAL = "1";
    await f.store.saveConnection(
      {
        alias: "TERM",
        name: "Terminal",
        kind: "ssh",
        enabled: true,
        description: "protocol fixture",
        trustBoundary: "development-fixture",
        config: {
          host: "127.0.0.1",
          port: (ssh.address() as import("node:net").AddressInfo).port,
          username: "fixture",
          hostKeySHA256: fingerprint,
          remoteRoot: "/",
          allowShell: true,
        },
      },
      { password: secret },
      false,
      0,
    );
    const sharedInvocation = crypto.randomUUID();
    // Rejected upgrades never create a terminal operation or consume its slot.
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise<void>((resolve, reject) => {
        const request = http.get(
          f.server.execUrl + "/v2/terminal/ssh/TERM",
          {
            headers: {
              authorization: `Bearer ${execToken}`,
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "invalid",
            },
          },
          (response) => {
            assert.equal(response.statusCode, 400);
            response.resume();
            response.once("end", resolve);
          },
        );
        request.once("error", reject);
      });
    }
    const afterRejectedUpgrades = await req(f.server.execUrl, "/v1/platforms");
    assert.equal(afterRejectedUpgrades.status, 200);
    await afterRejectedUpgrades.text();
    async function session(invocationId?: string, badInit = false) {
      const ws = new WebSocket(
        gate.url.replace("http:", "ws:") + "/v2/terminal/ssh/TERM",
        {
          headers: {
            authorization: `Bearer ${execToken}`,
            ...(invocationId
              ? { "x-abilock-invocation-id": invocationId }
              : {}),
          },
        },
      );
      let sequence = 0;
      const frames: Record<string, unknown>[] = [];
      if (invocationId)
        ws.once("open", () => {
          // Send immediately: the gateway's core connection may still be opening.
          if (badInit)
            ws.send(
              JSON.stringify({
                type: "init",
                trace: { invocationId: crypto.randomUUID() },
                sequence: ++sequence,
                direction: "client",
              }),
            );
          ws.send(
            JSON.stringify({
              type: "init",
              trace: { invocationId },
              sequence: ++sequence,
              direction: "client",
            }),
          );
        });
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("WS test timeout")),
          10000,
        );
        ws.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString());
          frames.push(frame);
          const send = (value: Record<string, unknown>) =>
            ws.send(
              JSON.stringify({
                ...value,
                ...(invocationId
                  ? {
                      invocationId,
                      operationId: frame.operationId,
                      sequence: ++sequence,
                      direction: "client",
                    }
                  : {}),
              }),
            );
          if (frame.type === "ready") {
            send({ type: "resize", rows: 40, cols: 120 });
            send({
              type: "data",
              data: Buffer.from("hello\n").toString("base64"),
            });
            setTimeout(() => send({ type: "eof" }), 20);
          }
          if (frame.type === "exit") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      await completed;
      if (ws.readyState !== WebSocket.CLOSED) await once(ws, "close");
      const first = frames[0];
      assert.match(
        String(first.operationId),
        /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i,
      );
      assert.match(
        String(first.invocationId),
        /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i,
      );
      if (invocationId) assert.equal(first.invocationId, invocationId);
      frames.forEach((frame, index) => {
        assert.equal(frame.invocationId, first.invocationId);
        assert.equal(frame.operationId, first.operationId);
        assert.equal(frame.requestId, first.requestId);
        assert.equal(frame.operationIdSource, "server");
        assert.equal(frame.direction, "server");
        assert.equal(frame.sequence, index + 1);
      });
      assert.equal(
        frames.filter((frame) => frame.type === "error").length,
        badInit ? 1 : 0,
      );
      assert.equal(frames.find((x) => x.type === "exit")?.code, 7);
      const text = frames
        .filter((x) => x.type === "data")
        .map((x) => Buffer.from(x.data as string, "base64").toString())
        .join("");
      assert(text.includes("hello"));
      assert(!text.includes(secret));
      return first;
    }
    const sessions = await Promise.all([
      session(),
      session(sharedInvocation),
      session(sharedInvocation),
      session(sharedInvocation, true),
    ]);
    assert.equal(new Set(sessions.map((frame) => frame.operationId)).size, 4);
    assert.equal(new Set(sessions.map((frame) => frame.requestId)).size, 4);
    assert(windows.some((x) => x[0] === 40 && x[1] === 120));
    const terminalLogs = logs.filter((record) => record.event === "terminal");
    assert.equal(terminalLogs.length, 4);
    for (const frame of sessions) {
      const record = terminalLogs.find(
        (record) => record.operationId === frame.operationId,
      );
      assert(record);
      assert.equal(record.invocationId, frame.invocationId);
      assert.equal(record.requestId, frame.requestId);
      assert.equal(record.status, 7);
    }
    const bad = new WebSocket(
      gate.url.replace("http:", "ws:") + "/v2/terminal/ssh/TERM",
      { headers: { authorization: "Bearer invalid" } },
    );
    await new Promise<void>((resolve) => {
      bad.on("error", () => resolve());
    });
  } finally {
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = oldMock;
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
    await gate.close();
    await f.close();
    for (const c of clients) c.end();
    await new Promise<void>((resolve) => ssh.close(() => resolve()));
  }
});

// A short upstream credential containing JSON syntax must not corrupt the service envelope.
test("秘密包含JSON符号或协议字段名时响应仍是有效固定封装", async () => {
  const e = await environment();
  try {
    await e.store.save(
      {
        alias: "SHORT",
        name: 'value " echoed',
        baseUrl: "https://example.com",
        enabled: true,
        description: "syntax fixture",
        allowInsecureLocal: false,
        auth: { type: "basic" },
        rules: [{ method: "GET", path: "/" }],
      },
      { username: "platforms", password: '"' },
      false,
      0,
    );
    const response = await req(e.server.execUrl, "/v1/platforms");
    assert.equal(response.status, 200);
    const data = (await response.json()) as { platforms: unknown[] };
    assert.ok(Array.isArray(data.platforms));
    assert.match(JSON.stringify(data.platforms), /REDACTED/);
  } finally {
    await e.close();
  }
});
