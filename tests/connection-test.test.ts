import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext, Connection, Operation } from "../src/connections.js";
import { connectionKinds } from "../src/protocol-kinds.js";
import { planProtocolConnectionTest, testProtocolConnection } from "../src/connection-test.js";
import { protocolAdapters } from "../src/protocols/index.js";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";

const syntheticSecret = "synthetic-probe-password-not-real";
const initialLocal = process.env.ABILOCK_ALLOW_LOCAL;
before(() => { process.env.ABILOCK_ALLOW_LOCAL = "1"; });
after(() => { if (initialLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL; else process.env.ABILOCK_ALLOW_LOCAL = initialLocal; });
function connection(kind: Connection["kind"], config: Record<string, unknown> = {}): Connection {
  return { alias: "PROBE", name: "Synthetic probe", kind, enabled: true, description: "", trustBoundary: "development-fixture", config };
}
function context(value: Connection, signal = new AbortController().signal): AdapterContext {
  return { connection: value, secret: { username: "fixture", password: syntheticSecret }, signal, allowLocal: true, dataDir: "/tmp/unused-connection-test-workspaces" };
}
async function wire() {
  let respond = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Version: "27.0.0", ApiVersion: "1.47", ignoredSecret: syntheticSecret }));
  };
  const requests: { method: string; url: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    respond: (next: typeof respond) => { respond = next; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
function docker(url: string) { return connection("docker", { endpoint: url, auth: "basic", apiVersion: "v1.47" }); }
function safe(value: unknown) { assert(!JSON.stringify(value).includes(syntheticSecret)); }

test("every saved protocol kind has a bounded explicit plan, with no implicit paid or secret-resource probe", () => {
  for (const kind of connectionKinds) {
    const config = kind === "kubernetes" ? { endpoint: "https://cluster.example", namespace: "team" }
      : kind === "aws" ? { region: "us-east-1", allowedServices: ["sts"] }
        : {};
    const plan = planProtocolConnectionTest(connection(kind, config));
    assert.equal(typeof plan.supported, "boolean");
    assert(plan.provider && plan.message);
  }
  const ssh = planProtocolConnectionTest(connection("ssh"));
  assert.equal(ssh.supported, true);
  assert.equal(ssh.level, "authentication");
  assert.doesNotMatch(ssh.message, /指纹/);
  assert.equal(planProtocolConnectionTest(connection("s3")).billing, "possible");
  assert.equal(planProtocolConnectionTest(connection("aws", { region: "us-east-1", allowedServices: ["ec2"] })).supported, false);
  assert.equal(planProtocolConnectionTest(connection("kubernetes", { endpoint: "https://cluster.example", resources: ["secrets"] })).supported, false);
  assert.equal(planProtocolConnectionTest(connection("registry", { allowedCommands: ["tags"] })).supported, false);
});

test("database probes send only a constant query/PING and reject unexpected success payloads", async () => {
  for (const kind of ["postgres", "mysql", "redis"] as const) {
    const config = kind === "redis" ? { host: "127.0.0.1", tls: false } : { host: "127.0.0.1", user: "fixture", database: "fixture", tls: false };
    const c = context(connection(kind, config));
    const response = kind === "postgres" ? [{ rows: [{ abilock_probe: 1 }] }]
      : kind === "mysql" ? { rows: [{ abilock_probe: 1 }] } : { command: "PING", result: "PONG" };
    const stub = mock.method(protocolAdapters[kind], "run", async (_ctx: AdapterContext, op: Operation) => {
      assert.deepEqual(op.args, kind === "redis" ? ["PING"] : [kind === "postgres" ? "-c" : "-e", "SELECT 1 AS abilock_probe"]);
      return { exitCode: 0, data: response, stdout: syntheticSecret };
    });
    try {
      const result = await testProtocolConnection(c);
      assert.equal(result.level, "service");
      assert.equal(result.status, "reachable");
      safe(result);
      stub.mock.mockImplementation(async () => ({ exitCode: 0, data: { ok: true } }));
      await assert.rejects(testProtocolConnection(c), { code: "CONNECTION_TEST_PROTOCOL" });
      stub.mock.mockImplementation(async () => ({ exitCode: 1, data: { category: "auth" }, stderr: syntheticSecret }));
      await assert.rejects(testProtocolConnection(c), (error: unknown) => { safe(error); return (error as { code: string }).code === "CONNECTION_TEST_AUTH"; });
    } finally { stub.mock.restore(); }
  }
});

test("Docker wire probe validates protocol, preserves status categories and never returns upstream bodies", async () => {
  const fixture = await wire();
  try {
    const c = context(docker(fixture.url));
    const valid = await testProtocolConnection(c);
    assert.equal(valid.status, "reachable");
    safe(valid);
    assert.deepEqual(fixture.requests, [{ method: "GET", url: "/v1.47/version" }]);
    for (const [status, code] of [[401, "AUTH"], [403, "PERMISSION"], [429, "RATE_LIMIT"]] as const) {
      fixture.respond((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ message: syntheticSecret })); });
      await assert.rejects(testProtocolConnection(c), (error: unknown) => { safe(error); return (error as { code: string }).code === `CONNECTION_TEST_${code}`; });
    }
    fixture.respond((_req, res) => { res.end(JSON.stringify({ ok: true, message: syntheticSecret })); });
    await assert.rejects(testProtocolConnection(c), { code: "CONNECTION_TEST_PROTOCOL" });
    fixture.respond((_req, res) => { res.writeHead(302, { location: "https://must-not-follow.example" }); res.end(); });
    await assert.rejects(testProtocolConnection(c));
    assert.equal(fixture.requests.length, 6);
  } finally { await fixture.close(); }
});

test("Kubernetes probes one allowed nonsecret resource page and never follows continuation", async () => {
  const fixture = await wire();
  try {
    fixture.respond((_req, res) => res.end(JSON.stringify({ kind: "PodList", apiVersion: "v1", metadata: { continue: "must-not-follow" }, items: [{ metadata: { name: "fixture" } }] })));
    const c = context(connection("kubernetes", { endpoint: fixture.url, auth: "bearer", namespace: "fixture", resources: ["secrets", "pods"] }));
    c.secret = { token: syntheticSecret };
    const result = await testProtocolConnection(c);
    assert.equal(result.level, "service");
    assert.equal(result.status, "reachable");
    assert.deepEqual(fixture.requests, [{ method: "GET", url: "/api/v1/namespaces/fixture/pods?limit=1" }]);
    safe(result);
    fixture.respond((_req, res) => { res.writeHead(403); res.end(JSON.stringify({ kind: "Status", code: 403, message: syntheticSecret })); });
    await assert.rejects(testProtocolConnection(c), { code: "CONNECTION_TEST_PERMISSION" });
  } finally { await fixture.close(); }
});

test("S3 requires explicit paid-request consent and sends one prefix-bound list of at most one item", async () => {
  const fixture = await wire();
  try {
    fixture.respond((_req, res) => { res.setHeader("content-type", "application/xml"); res.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture-bucket</Name><Prefix>allowed/</Prefix><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'); });
    const c = context(connection("s3", { endpoint: fixture.url, region: "us-east-1", bucket: "fixture-bucket", prefix: "allowed/", allowInsecureLocal: true, allowedCommands: ["list-objects-v2"] }));
    c.secret = { accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: syntheticSecret };
    assert.equal((await testProtocolConnection(c)).status, "unsupported");
    assert.equal(fixture.requests.length, 0);
    const result = await testProtocolConnection(c, { allowBillable: true });
    assert.equal(result.status, "reachable");
    assert.equal(fixture.requests.length, 1);
    const request = new URL(fixture.requests[0].url, fixture.url);
    assert.equal(request.searchParams.get("max-keys"), "1");
    assert.equal(request.searchParams.get("prefix"), "allowed/");
    assert.equal(request.pathname, "/fixture-bucket/");
    safe(result);
  } finally { await fixture.close(); }
});

test("AWS custom STS response is service-only and actual SDK errors retain safe auth/permission/rate classification", async () => {
  const fixture = await wire();
  try {
    const c = context(connection("aws", { region: "us-east-1", allowedServices: ["sts"], endpoints: { sts: fixture.url }, allowInsecureLocal: true }));
    c.secret = { accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: syntheticSecret };
    fixture.respond((_req, res) => { res.setHeader("content-type", "text/xml"); res.end('<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/fixture</Arn><UserId>fixture</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>'); });
    const result = await testProtocolConnection(c);
    assert.equal(result.level, "service");
    assert.equal(result.status, "reachable");
    assert(!JSON.stringify(result).includes("123456789012"));
    for (const [upstream, status, expected] of [["InvalidClientTokenId", 403, "AUTH"], ["AccessDenied", 403, "PERMISSION"], ["Throttling", 400, "RATE_LIMIT"]] as const) {
      fixture.respond((_req, res) => { res.writeHead(status, { "content-type": "text/xml" }); res.end(`<ErrorResponse><Error><Code>${upstream}</Code><Message>${syntheticSecret}</Message></Error></ErrorResponse>`); });
      await assert.rejects(testProtocolConnection(c), (error: unknown) => { safe(error); return (error as { code: string }).code === `CONNECTION_TEST_${expected}`; });
    }
    assert.equal(fixture.requests.length, 4, "SDK must not retry rejected probes");
  } finally { await fixture.close(); }
});

async function environment(upstream: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-probe-endpoint-"));
  const store = new Store(dir, "a".repeat(64));
  await store.init();
  await store.saveConnection(docker(upstream), { username: "fixture", password: syntheticSecret }, false, 0);
  const logs: unknown[] = [];
  const server = await startServers({ store, execToken: "synthetic-probe-execution-token-only", webDir: path.resolve("dist/web"), adminPort: 0, execPort: 0, log: (row) => logs.push(row) });
  const initialized = await fetch(server.adminUrl + "/admin/auth/setup", { method: "POST", headers: { "content-type": "application/json", origin: server.adminUrl, "x-abilock-ui": "1" }, body: JSON.stringify({ password: "synthetic-admin-password-for-probe", confirmPassword: "synthetic-admin-password-for-probe" }) });
  assert.equal(initialized.status, 201);
  const cookie = initialized.headers.get("set-cookie")!.split(";")[0];
  const { csrfToken } = await initialized.json() as { csrfToken: string };
  const headers = { cookie, "x-abilock-csrf": csrfToken, "content-type": "application/json" };
  return { store, server, headers, logs, close: async () => { await server.close(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
test("management probe enforces role, exact revision, strict request fields and safe plan", async () => {
  const oldMock = process.env.ABILOCK_MOCK, oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_MOCK = "1"; process.env.ABILOCK_ALLOW_LOCAL = "1";
  const fixture = await wire();
  const env = await environment(fixture.url);
  const route = "/admin/connections/PROBE/connection-test";
  const post = (value: unknown) => fetch(env.server.adminUrl + route, { method: "POST", headers: env.headers, body: JSON.stringify(value) });
  try {
    const plan = await fetch(env.server.adminUrl + "/admin/connections/PROBE/test-plan", { headers: env.headers });
    assert.equal(plan.status, 200); safe(await plan.json());
    assert.equal(fixture.requests.length, 0);
    assert.equal((await post({ expectedRevision: 2 })).status, 409);
    assert.equal((await post({ expectedRevision: 1, target: "https://other.example" })).status, 400);
    assert.equal((await fetch(env.server.execUrl + route, { method: "POST", headers: { authorization: "Bearer synthetic-probe-execution-token-only", "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }) })).status, 404);
    assert.equal(fixture.requests.length, 0);
    const good = await post({ expectedRevision: 1 });
    assert.equal(good.status, 200);
    const result = await good.json() as { alias: string; revision: number; status: string };
    assert.deepEqual([result.alias, result.revision, result.status], ["PROBE", 1, "reachable"]);
    safe(result); safe(env.logs);
  } finally {
    await env.close(); await fixture.close();
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK; else process.env.ABILOCK_MOCK = oldMock;
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL; else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
  }
});

test("management probe rejects duplicates, cancels transport, invalidates rotated state, and reselects after slow input", async () => {
  const oldMock = process.env.ABILOCK_MOCK, oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_MOCK = "1"; process.env.ABILOCK_ALLOW_LOCAL = "1";
  const fixture = await wire();
  const env = await environment(fixture.url);
  const route = "/admin/connections/PROBE/connection-test";
  const post = (revision: number, signal?: AbortSignal) => fetch(env.server.adminUrl + route, { method: "POST", headers: env.headers, body: JSON.stringify({ expectedRevision: revision }), signal });
  try {
    let entered: () => void = () => {};
    let release: () => void = () => {};
    let arrived = new Promise<void>((resolve) => { entered = resolve; });
    fixture.respond((_req, res) => { release = () => res.end(JSON.stringify({ Version: "27", ApiVersion: "1.47" })); entered(); });
    const pending = post(1);
    await arrived;
    assert.equal((await post(1)).status, 409);
    await env.store.saveConnection({ ...docker(fixture.url), note: "changed" }, undefined, false, 1);
    release();
    assert.equal((await pending).status, 409);
    assert.equal(fixture.requests.length, 1);

    arrived = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new AbortController();
    const cancelled = post(2, controller.signal);
    await arrived;
    controller.abort();
    await assert.rejects(cancelled);
    await delay(30);
    fixture.respond((_req, res) => res.end(JSON.stringify({ Version: "27", ApiVersion: "1.47" })));
    assert.equal((await post(2)).status, 200, "cancellation must release the alias lock");

    const count = fixture.requests.length;
    let finishBody: (() => void) | undefined;
    let headersFlushed: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => { headersFlushed = resolve; });
    const slow = new Promise<number>((resolve, reject) => {
      const request = http.request(env.server.adminUrl + route, { method: "POST", headers: { ...env.headers, "content-length": Buffer.byteLength('{"expectedRevision":2}') } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      request.once("error", reject);
      request.flushHeaders();
      request.write('{"expectedRevision":');
      finishBody = () => request.end("2}");
      headersFlushed!();
    });
    await sent; await delay(30);
    await env.store.saveConnection({ ...docker(fixture.url), note: "changed again" }, undefined, false, 2);
    finishBody!();
    assert.equal(await slow, 409);
    assert.equal(fixture.requests.length, count, "old state must not be contacted after request input was delayed");
    safe(env.logs);
  } finally {
    await env.close(); await fixture.close();
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK; else process.env.ABILOCK_MOCK = oldMock;
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL; else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
  }
});

test("Doubao management plan requires consent and an allowed model before transport, with no target or body overrides", async () => {
  const fixture = await wire();
  const env = await environment(fixture.url);
  try {
    await env.store.save({ alias: "ARK", name: "Synthetic Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      auth: { type: "bearer" }, enabled: true, allowInsecureLocal: false, description: "", rules: [],
    }, { value: syntheticSecret }, false, 0);
    const get = await fetch(env.server.adminUrl + "/admin/platforms/ARK/test-plan", { headers: env.headers });
    const plan = await get.json() as { level: string; billing: string; model: null };
    assert.equal(plan.level, "generation");
    assert.equal(plan.billing, "possible");
    assert.equal(plan.model, null);
    safe(plan);
    const post = (value: unknown) => fetch(env.server.adminUrl + "/admin/platforms/ARK/connection-test", {
      method: "POST", headers: env.headers, body: JSON.stringify(value),
    });
    for (const value of [{ expectedRevision: 1 }, { expectedRevision: 1, model: "doubao-seed-2-0-mini-260428" }]) {
      const response = await post(value);
      assert.equal(response.status, 200);
      const result = await response.json() as { status: string; success: boolean };
      assert.equal(result.status, "unsupported");
      assert.equal(result.success, false);
    }
    for (const value of [{ expectedRevision: 1, allowBillable: true },
      { expectedRevision: 1, allowBillable: true, model: "unverified-model" },
      { expectedRevision: 1, allowBillable: true, model: "ep-custom-endpoint" },
      { expectedRevision: 1, allowBillable: true, model: "doubao-seed-2-0-mini-260428", body: { max_completion_tokens: 9999 } },
      { expectedRevision: 1, allowBillable: true, model: "doubao-seed-2-0-mini-260428", target: "https://other.invalid" }]) {
      const response = await post(value);
      assert.equal(response.status, 400);
      safe(await response.json());
    }
    assert.equal((await post({ expectedRevision: 2, allowBillable: true, model: "doubao-seed-2-0-mini-260428" })).status, 409);
    assert.equal(env.store.platform("ARK").revision, 1);
    assert.equal(fixture.requests.length, 0);
    safe(env.logs);
  } finally { await env.close(); await fixture.close(); }
});
