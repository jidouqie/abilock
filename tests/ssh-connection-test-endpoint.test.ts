import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import type { Connection } from "../src/connections.js";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";

// A disposable wire responder authenticates synthetic values only. No shell,
// exec, SFTP subsystem, host account or installed credential is used.
const password = "synthetic-ssh-probe-password-20261023";
const adminPassword = "synthetic-ssh-probe-admin-20261023";
const execToken = "synthetic-ssh-probe-execution-token-20261023";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Session = { cookie: string; csrfToken: string };
type ProbeResult = {
  connected?: boolean;
  authenticated?: boolean;
  status?: string;
  success?: boolean;
  message?: string;
  durationMs?: number;
  requestId: string;
  invocationId: string;
  operationId: string;
  operationIdSource: string;
  error?: { code: string; message: string };
};

function identity() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const keys = ssh2.utils.generateKeyPairSync("ed25519");
    const parsed = ssh2.utils.parseKey(keys.private);
    assert(!(parsed instanceof Error) && !Array.isArray(parsed));
    const publicKey = ssh2.utils.parseKey(keys.public);
    if (publicKey instanceof Error) {
      // ssh2 can truncate leading zero bytes in generated fixture public keys.
      // Retry that known generator failure only; real keys are never replaced.
      const [kind, encoded] = keys.public.trim().split(/\s+/);
      const blob = Buffer.from(encoded ?? "", "base64");
      assert(publicKey.message === "Malformed OpenSSH public key" &&
        kind === "ssh-ed25519" && blob.length >= 19 &&
        blob.readUInt32BE(0) === 11 &&
        blob.subarray(4, 15).toString() === "ssh-ed25519" &&
        blob.readUInt32BE(15) > 0 && blob.readUInt32BE(15) < 32 &&
        blob.length === 19 + blob.readUInt32BE(15));
      continue;
    }
    return {
      privateKey: keys.private,
    };
  }
  throw new Error("synthetic SSH host-key generation remained truncated");
}

async function wireFixture() {
  const host = identity();
  const clients = new Set<ssh2.Connection>();
  let attempts = 0;
  let channels = 0;
  let holdAuthentication = false;
  let authEntered: (() => void) | undefined;
  let releaseAuthentication: (() => void) | undefined;
  const server = new ssh2.Server({ hostKeys: [host.privateKey] }, (client) => {
    attempts++;
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "none") return context.reject(["password"]);
      authEntered?.();
      const respond = () => {
        if (context.method === "password" && context.username === "fixture" && context.password === password)
          context.accept();
        else context.reject();
      };
      if (holdAuthentication) releaseAuthentication = respond;
      else respond();
    });
    client.on("ready", () => client.on("session", (_accept, reject) => {
      channels++;
      reject();
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    attempts: () => attempts,
    channels: () => channels,
    clients: () => clients.size,
    hold: () => {
      holdAuthentication = true;
      return new Promise<void>((resolve) => { authEntered = resolve; });
    },
    release: () => releaseAuthentication?.(),
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(clients.size, 0);
    },
  };
}

async function environment() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-ssh-test-endpoint-"));
  const store = new Store(dir, "a".repeat(64));
  const logs: Record<string, unknown>[] = [];
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    await store.init();
    server = await startServers({
      store, execToken, webDir: path.resolve("dist/web"),
      adminPort: 0, execPort: 0, log: (record) => logs.push(record),
    });
    const response = await fetch(server.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: { origin: server.adminUrl, "x-abilock-ui": "1", "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, confirmPassword: adminPassword }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const { csrfToken } = await response.json() as { csrfToken: string };
    assert(csrfToken);
    return {
      dir, store, server, logs, session: { cookie, csrfToken } satisfies Session,
      close: async () => {
        try { await server?.close(); }
        finally {
          try { await store.close(); }
          finally { await fs.rm(dir, { recursive: true, force: true }); }
        }
      },
    };
  } catch (error) {
    try { await server?.close(); }
    finally {
      try { await store.close(); }
      finally { await fs.rm(dir, { recursive: true, force: true }); }
    }
    throw error;
  }
}

function sshConnection(alias: string, wire: Awaited<ReturnType<typeof wireFixture>>): Connection {
  return {
    alias, name: "合成 SSH 连接", kind: "ssh", enabled: true,
    description: "仅验证握手", trustBoundary: "development-fixture",
    config: {
      host: "127.0.0.1", port: wire.port, username: "fixture",
      remoteRoot: "/synthetic", fileAccess: "read",
      allowShell: false,
    },
  };
}

function request(url: string, route: string, value: unknown, session?: Session,
  headers: Record<string, string> = {}, signal = AbortSignal.timeout(5000)) {
  return fetch(url + route, {
    method: "POST", headers: {
      "content-type": "application/json",
      ...(session ? { cookie: session.cookie, "x-abilock-csrf": session.csrfToken } : {}),
      ...headers,
    }, body: JSON.stringify(value), redirect: "error", signal,
  });
}

async function checkResponse(response: Response, status: number) {
  assert.equal(response.status, status);
  const raw = await response.text();
  for (const value of [password, adminPassword, execToken, "sealed"])
    assert(!raw.includes(value), "response must not expose credentials or sealed state");
  const value = JSON.parse(raw) as ProbeResult;
  for (const [key, header] of [
    ["requestId", "x-abilock-request-id"],
    ["invocationId", "x-abilock-invocation-id"],
    ["operationId", "x-abilock-operation-id"],
  ] as const) {
    assert.match(value[key], uuid);
    assert.equal(value[key], response.headers.get(header));
  }
  assert.equal(value.operationIdSource, "server");
  return value;
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert(predicate(), "synthetic SSH session did not finish");
}

async function bounded<T>(pending: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function localFixture<T>(run: (wire: Awaited<ReturnType<typeof wireFixture>>, f: Awaited<ReturnType<typeof environment>>) => Promise<T>) {
  const oldMock = process.env.ABILOCK_MOCK;
  const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  let wire: Awaited<ReturnType<typeof wireFixture>> | undefined;
  let f: Awaited<ReturnType<typeof environment>> | undefined;
  try {
    process.env.ABILOCK_MOCK = "1";
    process.env.ABILOCK_ALLOW_LOCAL = "1";
    wire = await wireFixture();
    f = await environment();
    return await run(wire, f);
  } finally {
    try { await f?.close(); }
    finally {
      try { await wire?.close(); }
      finally {
        if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
        else process.env.ABILOCK_MOCK = oldMock;
        if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
        else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
      }
    }
  }
}

test("SSH 连接测试只允许管理会话和 CSRF，拒绝覆盖并保留状态", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    const saved = await f.store.saveConnection(sshConnection("FIXTURE", wire), { password }, false, 0);
    const route = "/admin/connections/FIXTURE/test";
    const before = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    const catalog = f.store.discovery();
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision }), 401);
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision }, undefined,
      { authorization: `Bearer ${execToken}` }), 401);
    await checkResponse(await request(f.server.execUrl, route, { expectedRevision: saved.revision }, undefined,
      { authorization: `Bearer ${execToken}` }), 404);
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision },
      { ...f.session, csrfToken: "" }), 403);
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision }, f.session,
      { origin: "https://cross-site.example" }), 403);
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision }, f.session,
      { "sec-fetch-site": "cross-site" }), 403);
    for (const extra of [
      { target: "elsewhere.example" }, { secret: { password: "override" } },
      { config: { username: "root" } }, { command: "uname -a" },
      { timeoutMs: 999999 }, { trace: { operationId: crypto.randomUUID() } },
    ]) await checkResponse(await request(f.server.adminUrl, route,
      { expectedRevision: saved.revision, ...extra }, f.session), 400);
    await checkResponse(await request(f.server.adminUrl, route, { expectedRevision: saved.revision + 1 }, f.session), 409);
    assert.equal(wire.attempts(), 0, "all validation and role denials must precede SSH");

    const first = await checkResponse(await request(f.server.adminUrl, route,
      { expectedRevision: saved.revision }, f.session), 200);
    assert.equal(first.connected, true);
    assert.equal(Object.hasOwn(first, "hostVerified"), false);
    assert.equal(first.authenticated, true);
    assert(Number.isFinite(first.durationMs) && first.durationMs! >= 0);
    const second = await checkResponse(await request(f.server.adminUrl, route,
      { expectedRevision: saved.revision }, f.session,
      { "x-abilock-invocation-id": first.invocationId }), 200);
    assert.equal(second.invocationId, first.invocationId);
    assert.notEqual(second.requestId, first.requestId);
    assert.notEqual(second.operationId, first.operationId);
    assert.equal(wire.attempts(), 2);
    await eventually(() => wire.clients() === 0);
    assert.equal(wire.channels(), 0, "connection test must not open exec, shell or SFTP channels");
    assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), before);
    assert.deepEqual(f.store.discovery(), catalog);
    assert.equal(f.store.connection("ssh", "FIXTURE").revision, saved.revision);
    assert.equal(f.store.connection("ssh", "FIXTURE").inventory, undefined);
    for (const value of [password, adminPassword, execToken])
      assert(!JSON.stringify(f.logs).includes(value));
  });
});

test("SSH 连接测试拒绝禁用、缺凭据和非 SSH 连接，失败有独立追踪且不写状态", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    const cases = [
      { alias: "OFF", connection: { ...sshConnection("OFF", wire), enabled: false }, secret: { password }, status: 403, code: "CONNECTION_DISABLED" },
      { alias: "EMPTY", connection: sshConnection("EMPTY", wire), secret: undefined, status: 400, code: "SECRET_REQUIRED" },
      { alias: "AUTH", connection: sshConnection("AUTH", wire), secret: { password: "synthetic-wrong-auth-password" }, status: 502, code: "SSH_TEST_AUTH" },
    ];
    const traces = new Set<string>();
    for (const item of cases) {
      const saved = await f.store.saveConnection(item.connection, item.secret, false, 0);
      const before = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
      const result = await checkResponse(await request(f.server.adminUrl,
        `/admin/connections/${item.alias}/test`, { expectedRevision: saved.revision }, f.session), item.status);
      assert.equal(result.error?.code, item.code);
      assert(!traces.has(result.operationId));
      traces.add(result.operationId);
      assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), before);
    }
    const database = await f.store.saveConnection({
      alias: "DB", name: "合成数据库", kind: "postgres", enabled: true,
      description: "仅用于类型检查", trustBoundary: "development-fixture",
      config: { host: "127.0.0.1", port: 5432, database: "fixture", user: "fixture", tls: false },
    }, { password: "synthetic-database-password" }, false, 0);
    const unsupported = await checkResponse(await request(f.server.adminUrl,
      "/admin/connections/DB/test", { expectedRevision: database.revision }, f.session), 400);
    assert.equal(unsupported.error?.code, "CONNECTION_TEST_UNSUPPORTED");
    const target = await f.store.saveConnection(sshConnection("TARGET", wire), { password }, false, 0);
    const before = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    const attempts = wire.attempts();
    process.env.ABILOCK_ALLOW_LOCAL = "0";
    const boundary = await checkResponse(await request(f.server.adminUrl,
      "/admin/connections/TARGET/test", { expectedRevision: target.revision }, f.session), 403);
    assert.equal(boundary.error?.code, "TARGET_TRUST_REQUIRED");
    assert.equal(wire.attempts(), attempts);
    assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), before);
    assert.equal(wire.channels(), 0);
    await eventually(() => wire.clients() === 0);
    for (const value of [password, "synthetic-wrong-auth-password", adminPassword, execToken])
      assert(!JSON.stringify(f.logs).includes(value));
  });
});

test("SSH 连接测试无需指纹且兼容旧错误指纹，保留保存状态", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    for (const [alias, legacy] of [["NO_PIN", false], ["LEGACY_PIN", true]] as const) {
      const connection = sshConnection(alias, wire);
      if (legacy) connection.config.hostKeySHA256 = `SHA256:${"A".repeat(43)}`;
      else delete connection.config.hostKeySHA256;
      const saved = await f.store.saveConnection(connection, { password }, false, 0);
      const before = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
      const result = await checkResponse(await request(f.server.adminUrl,
        `/admin/connections/${alias}/test`, { expectedRevision: saved.revision }, f.session), 200);
      assert.equal(result.connected, true);
      assert.equal(result.authenticated, true);
      assert.equal(Object.hasOwn(result, "hostVerified"), false);
      const planResponse = await fetch(f.server.adminUrl + `/admin/connections/${alias}/test-plan`, {
        headers: { cookie: f.session.cookie },
      });
      assert.equal(planResponse.status, 200);
      const plan = await planResponse.json() as { supported: boolean; level: string; message: string };
      assert.equal(plan.supported, true);
      assert.equal(plan.level, "authentication");
      assert.doesNotMatch(plan.message, /指纹/);
      const unified = await checkResponse(await request(f.server.adminUrl,
        `/admin/connections/${alias}/connection-test`, { expectedRevision: saved.revision }, f.session), 200);
      assert.equal(unified.status, "verified");
      assert.equal(unified.success, true);
      assert.doesNotMatch(unified.message!, /指纹/);
      assert.equal(Object.hasOwn(unified, "hostVerified"), false);
      assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), before);
    }
    await eventually(() => wire.clients() === 0);
    assert.equal(wire.attempts(), 4);
    assert.equal(wire.channels(), 0);
  });
});

test("SSH 连接测试请求断开取消握手，网络等待不持有配置写锁", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    const connection = sshConnection("PENDING", wire);
    const saved = await f.store.saveConnection(connection, { password }, false, 0);
    const entered = wire.hold();
    const controller = new AbortController();
    const pending = request(f.server.adminUrl, "/admin/connections/PENDING/test",
      { expectedRevision: saved.revision }, f.session, {}, controller.signal);
    const rejection = assert.rejects(pending, (error: Error) => error.name === "AbortError");
    await bounded(entered, 5000, "authentication was not reached");
    // This ordinary revision-checked edit must complete while authentication
    // remains pending. The probe never takes or later commits a Store write.
    const changed = await bounded(
      f.store.saveConnection({ ...connection, note: "测试期间人工更新" }, undefined, false, saved.revision),
      1000, "probe held a configuration write lock");
    const beforeCancel = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    controller.abort();
    await rejection;
    await eventually(() => wire.clients() === 0 && f.logs.some((entry) => entry.alias === "PENDING"));
    const logged = [...f.logs].reverse().find((entry) => entry.alias === "PENDING");
    assert(logged);
    assert.equal(logged.completed, false);
    assert.equal(logged.errorCode, "SSH_TEST_CANCELLED");
    assert.match(logged.requestId as string, uuid);
    assert.match(logged.operationId as string, uuid);
    assert.equal(f.store.connection("ssh", "PENDING").revision, changed.revision);
    assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), beforeCancel);
    assert.equal(wire.attempts(), 1, "cancelled connection tests must never retry");
    assert.equal(wire.channels(), 0);
  });
});

test("SSH 连接测试完成后复核 revision，不把旧身份握手结果用于已变更连接", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    const connection = sshConnection("ROTATED", wire);
    const saved = await f.store.saveConnection(connection, { password }, false, 0);
    const entered = wire.hold();
    const pending = request(f.server.adminUrl, "/admin/connections/ROTATED/test",
      { expectedRevision: saved.revision }, f.session);
    await bounded(entered, 5000, "authentication was not reached");
    const changed = await bounded(
      f.store.saveConnection({ ...connection, note: "并发轮换身份" },
        { password: "synthetic-rotated-password" }, false, saved.revision),
      1000, "probe held a configuration write lock");
    const beforeCompletion = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    wire.release();
    const stale = await checkResponse(await pending, 409);
    assert.equal(stale.error?.code, "REVISION_CONFLICT");
    assert.equal(f.store.connection("ssh", "ROTATED").revision, changed.revision);
    assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), beforeCompletion);
    await eventually(() => wire.clients() === 0);
    assert.equal(wire.attempts(), 1);
    assert.equal(wire.channels(), 0);
  });
});

test("SSH 连接测试拒绝删除后同名同 revision 重建的替代身份", { timeout: 15000 }, async () => {
  await localFixture(async (wire, f) => {
    const connection = sshConnection("RECREATED", wire);
    const saved = await f.store.saveConnection(connection, { password }, false, 0);
    const entered = wire.hold();
    const pending = request(f.server.adminUrl, "/admin/connections/RECREATED/test",
      { expectedRevision: saved.revision }, f.session);
    await bounded(entered, 5000, "authentication was not reached");
    await bounded(f.store.removeConnection(connection.alias, saved.revision),
      1000, "probe held a configuration write lock");
    const replacement = await f.store.saveConnection(connection,
      { password: "synthetic-recreated-different-password" }, false, 0);
    assert.equal(replacement.revision, saved.revision,
      "fixture must reproduce an alias/revision ABA replacement");
    const beforeCompletion = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    wire.release();
    const stale = await checkResponse(await pending, 409);
    assert.equal(stale.error?.code, "REVISION_CONFLICT");
    assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), beforeCompletion,
      "stale connection tests must not mutate a replacement identity");
    assert.equal(f.store.connection("ssh", connection.alias).revision, replacement.revision);
    await eventually(() => wire.clients() === 0);
    assert.equal(wire.attempts(), 1);
    assert.equal(wire.channels(), 0);
  });
});

test("SSH 连接测试的 30 秒总期限覆盖前置 DNS，超时不建立连接或写状态", { timeout: 10000 }, async (t) => {
  await localFixture(async (wire, f) => {
    const connection = sshConnection("DNS_WAIT", wire);
    connection.trustBoundary = "independent-target";
    connection.config.host = "synthetic-timeout.example.test";
    const saved = await f.store.saveConnection(connection, { password }, false, 0);
    const before = await fs.readFile(path.join(f.dir, "state.json"), "utf8");
    process.env.ABILOCK_ALLOW_LOCAL = "0";
    let entered!: () => void;
    const dnsEntered = new Promise<void>((resolve) => { entered = resolve; });
    t.mock.method(dns, "lookup", () => {
      entered();
      return new Promise<never>(() => {});
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = request(f.server.adminUrl, "/admin/connections/DNS_WAIT/test",
        { expectedRevision: saved.revision }, f.session);
      await dnsEntered;
      t.mock.timers.tick(30000);
      const timeout = await checkResponse(await pending, 504);
      assert.equal(timeout.error?.code, "SSH_TEST_TIMEOUT");
      assert.equal(wire.attempts(), 0);
      assert.equal(await fs.readFile(path.join(f.dir, "state.json"), "utf8"), before);
    } finally {
      t.mock.timers.reset();
      t.mock.restoreAll();
    }
  });
});
