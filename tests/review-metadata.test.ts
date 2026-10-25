import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { runtimeInvocationId } from "../src/operation-trace.js";
import { operationTraceSchema } from "../src/trace-schema.js";
import { protocolAdapters } from "../src/protocols/index.js";
import { redact } from "../src/security.js";

// Dedicated loopback fixtures, synthetic credentials and temporary FS only.
// The protocol result uses a pure adapter stub: no SSH or native Git is run.
const execToken = "synthetic-review-metadata-execution-only-2026";
const publicId = "44444444-4444-4444-8444-444444444444";
const vendorPayload = {
  invocationId: publicId,
  operationId: publicId,
  requestId: publicId,
  ordinary: "value4",
};
before(() => {
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
});
after(() => {
  delete process.env.ABILOCK_MOCK;
  delete process.env.ABILOCK_ALLOW_LOCAL;
});
type Fixture = {
  store: Store;
  servers: Awaited<ReturnType<typeof startServers>>;
  records: Record<string, unknown>[];
};
async function withCore(
  secret: string,
  work: (fixture: Fixture) => Promise<void>,
) {
  const dir = await fs.mkdtemp("/private/tmp/abilock-review-metadata-");
  const store = new Store(dir, "d".repeat(64));
  const records: Record<string, unknown>[] = [];
  let servers: Fixture["servers"] | undefined;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(vendorPayload));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as AddressInfo).port;
    await store.init();
    await store.save(
      {
        alias: "REVIEW_HTTP",
        name: "Fixture",
        baseUrl: `http://127.0.0.1:${port}`,
        auth: { type: "bearer" },
        enabled: true,
        description: "",
        allowInsecureLocal: true,
        rules: [{ method: "GET", path: "/echo" }],
      },
      { value: secret },
      false,
      0,
    );
    await store.saveConnection(
      {
        alias: "REVIEW_SSH",
        name: "Fixture",
        kind: "ssh",
        enabled: true,
        description: "",
        trustBoundary: "development-fixture",
        config: {
          host: "127.0.0.1",
          port: 1,
          username: "synthetic-user",
          hostKeySHA256: "SHA256:" + Buffer.alloc(32).toString("base64"),
          remoteRoot: "/synthetic",
          allowShell: true,
        },
      },
      { password: secret },
      false,
      0,
    );
    servers = await startServers({
      store,
      execToken,
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      execPort: 0,
      log: (record) => {
        records.push(record);
      },
    });
    await work({ store, servers, records });
  } finally {
    await servers?.close();
    assert.equal(servers?.admin.listening ?? false, false);
    assert.equal(servers?.executor.listening ?? false, false);
    upstream.closeAllConnections();
    if (upstream.listening)
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    assert.equal(upstream.listening, false);
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
    assert.equal(
      await fs.access(dir).then(
        () => true,
        () => false,
      ),
      false,
    );
  }
}
function assertHeaderTrace(response: Response) {
  const trace = {
    invocationId: response.headers.get("x-abilock-invocation-id"),
    operationId: response.headers.get("x-abilock-operation-id"),
  };
  return operationTraceSchema.parse(trace);
}
function assertEnvelopeTrace(
  value: Record<string, unknown>,
  response: Response,
) {
  const trace = assertHeaderTrace(response);
  assert.equal(value.invocationId, trace.invocationId);
  assert.equal(value.operationId, trace.operationId);
  if ("requestId" in value)
    assert.equal(value.requestId, response.headers.get("x-abilock-request-id"));
}

test("core unauthenticated runtime credential collision is absent from health/error headers, JSON and logs", async () => {
  await withCore(runtimeInvocationId, async ({ servers, records }) => {
    for (const route of ["/health", "/v1/platforms"]) {
      const response = await fetch(servers.execUrl + route, {
        headers: { "x-abilock-invocation-id": runtimeInvocationId },
      });
      assert.equal(response.status, route === "/health" ? 200 : 401);
      const trace = assertHeaderTrace(response);
      assert.notEqual(trace.invocationId, runtimeInvocationId);
      assert.notEqual(trace.operationId, runtimeInvocationId);
      const value = (await response.json()) as Record<string, unknown>;
      assert(!JSON.stringify(value).includes(runtimeInvocationId));
      if (route !== "/health") assertEnvelopeTrace(value, response);
    }
    assert.equal(records.length, 2);
    assert(!JSON.stringify(records).includes(runtimeInvocationId));
    for (const record of records)
      operationTraceSchema.parse({
        invocationId: record.invocationId,
        operationId: record.operationId,
      });
  });
});

test("short credentials preserve trusted HTTP error UUIDs and never exempt same-name vendor payload fields", async () => {
  await withCore("4", async ({ servers, records }) => {
    const denied = await fetch(servers.execUrl + "/not-a-route", {
      headers: {
        authorization: `Bearer ${execToken}`,
        "x-abilock-invocation-id": publicId,
      },
    });
    assert.equal(denied.status, 404);
    const error = (await denied.json()) as Record<string, unknown>;
    assertEnvelopeTrace(error, denied);
    assert.equal(error.invocationId, publicId);
    const response = await fetch(servers.execUrl + "/v1/call/REVIEW_HTTP", {
      method: "POST",
      headers: {
        authorization: `Bearer ${execToken}`,
        "content-type": "application/json",
        "x-abilock-invocation-id": publicId,
      },
      body: JSON.stringify({ method: "GET", path: "/echo" }),
    });
    assert.equal(response.status, 200);
    assert.equal(assertHeaderTrace(response).invocationId, publicId);
    const vendor = (await response.json()) as Record<string, unknown>;
    for (const key of ["invocationId", "operationId", "requestId"])
      assert.equal(
        vendor[key],
        redact(publicId, ["4"]),
        "raw vendor fields are business output even if their value equals a trusted header",
      );
    assert.equal(vendor.ordinary, "value[REDACTED]");
    for (const record of records)
      operationTraceSchema.parse({
        invocationId: record.invocationId,
        operationId: record.operationId,
      });
  });
});

test("short credentials preserve trusted protocol result UUIDs while filtering nested business metadata", async (t) => {
  t.mock.method(protocolAdapters.ssh, "run", async () => ({
    exitCode: 0,
    data: vendorPayload,
    stdout: "ordinary4",
  }));
  await withCore("4", async ({ servers, records }) => {
    const response = await fetch(servers.execUrl + "/v2/run/ssh/REVIEW_SSH", {
      method: "POST",
      headers: {
        authorization: `Bearer ${execToken}`,
        "content-type": "application/json",
        "x-abilock-invocation-id": publicId,
      },
      body: JSON.stringify({ args: ["synthetic"], timeoutMs: 1000 }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as Record<string, unknown>;
    assertEnvelopeTrace(result, response);
    assert.equal(result.invocationId, publicId);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ordinary[REDACTED]");
    const data = result.data as Record<string, unknown>;
    for (const key of ["invocationId", "operationId", "requestId"])
      assert.equal(data[key], redact(publicId, ["4"]));
    assert.equal(records.length, 1);
    operationTraceSchema.parse({
      invocationId: records[0].invocationId,
      operationId: records[0].operationId,
    });
  });
});
