import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { executionGateway } from "../src/execution-gateway.js";
import { mockUpstream, MOCK_BEARER } from "../scripts/mock-upstream.js";
import { postgresFixture, FIXTURE_PASSWORD } from "./db-wire-fixtures.js";

const token = "synthetic-operation-exec-capability-80214";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function environment() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-operation-test-"),
  );
  const store = new Store(dir, "3".repeat(64));
  await store.init();
  const logs: Record<string, unknown>[] = [];
  const service = await startServers({
    store,
    execToken: token,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: (event) => logs.push(event),
  });
  const gate = await executionGateway({
    coreUrl: service.execUrl,
    execToken: token,
    port: 0,
  });
  const upstream = await mockUpstream();
  const oldLocal = process.env.ABILOCK_ALLOW_LOCAL,
    oldMock = process.env.ABILOCK_MOCK;
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  process.env.ABILOCK_MOCK = "1";
  await store.save(
    {
      alias: "MEDIA",
      name: "synthetic media",
      baseUrl: upstream.url,
      auth: { type: "bearer" },
      enabled: true,
      allowInsecureLocal: true,
      description: "",
      rules: [
        { method: "POST", path: "/echo" },
        { method: "POST", path: "/error500" },
        { method: "GET", path: "/stream" },
        { method: "GET", path: "/binary" },
      ],
    },
    { value: MOCK_BEARER },
    false,
    0,
  );
  return {
    dir,
    store,
    logs,
    service,
    gate,
    upstream,
    close: async () => {
      await gate.close();
      await service.close();
      await upstream.close();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
      if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
      else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
      if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
      else process.env.ABILOCK_MOCK = oldMock;
    },
  };
}
function call(
  base: string,
  input: unknown,
  invocationId?: string,
  route = "/v1/call/MEDIA",
) {
  return fetch(base + route, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(invocationId ? { "x-abilock-invocation-id": invocationId } : {}),
    },
    body: JSON.stringify(input),
  });
}

test("concurrent calls to the same API share a program ID but receive different operation IDs and correctly bound payloads/logs", async () => {
  const f = await environment();
  const invocationId = crypto.randomUUID();
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const response = await call(
          f.gate.url,
          {
            method: "POST",
            path: "/echo",
            body: { index, untouched: "native-business-data" },
            trace: { invocationId },
          },
          invocationId,
        );
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.body.index, index);
        assert.equal(result.body.untouched, "native-business-data");
        const operationId = response.headers.get("x-abilock-operation-id")!;
        const requestId = response.headers.get("x-abilock-request-id")!;
        assert.match(operationId, uuid);
        assert.match(requestId, uuid);
        assert.notEqual(operationId, requestId);
        assert.equal(
          response.headers.get("x-abilock-invocation-id"),
          invocationId,
        );
        return { operationId, requestId };
      }),
    );
    assert.equal(new Set(results.map((r) => r.operationId)).size, 10);
    assert.equal(new Set(results.map((r) => r.requestId)).size, 10);
    for (const result of results) {
      const record = f.logs.find(
        (log) => log.operationId === result.operationId,
      );
      assert(record);
      assert.equal(record.requestId, result.requestId);
      assert.equal(record.invocationId, invocationId);
    }
    assert.equal(f.upstream.calls.length, 10);
    for (const upstream of f.upstream.calls) {
      assert.equal(upstream.headers["x-abilock-invocation-id"], undefined);
      assert.equal(upstream.headers["x-abilock-operation-id"], undefined);
      assert.equal(JSON.parse(upstream.body).trace, undefined);
    }
    const logText = JSON.stringify(f.logs);
    assert(
      !logText.includes(MOCK_BEARER) &&
        !logText.includes("native-business-data"),
    );
  } finally {
    await f.close();
  }
});

test("non-HTTP database operations carry the same IDs through runtime result, gateway and log", async () => {
  const f = await environment();
  const wire = await postgresFixture();
  const invocationId = crypto.randomUUID();
  try {
    await f.store.saveConnection(
      {
        alias: "DB",
        name: "synthetic pg",
        kind: "postgres",
        enabled: true,
        description: "",
        trustBoundary: "development-fixture",
        config: {
          host: "127.0.0.1",
          port: wire.port,
          user: "fixture-user",
          database: "fixture-db",
          tls: false,
        },
      },
      { password: FIXTURE_PASSWORD },
      false,
      0,
    );
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(
          f.gate.url,
          { args: ["-c", "SELECT 42"], trace: { invocationId } },
          invocationId,
          "/v2/run/postgres/DB",
        ),
      ),
    );
    const operationIds = [];
    for (const response of replies) {
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.exitCode, 0);
      assert.equal(result.invocationId, invocationId);
      assert.equal(
        result.operationId,
        response.headers.get("x-abilock-operation-id"),
      );
      operationIds.push(result.operationId);
      const record = f.logs.find(
        (log) => log.operationId === result.operationId,
      );
      assert(record);
      assert.equal(record.invocationId, invocationId);
      assert(!JSON.stringify(result).includes(FIXTURE_PASSWORD));
    }
    assert.equal(new Set(operationIds).size, 4);
  } finally {
    await wire.close();
    await f.close();
  }
});

test("trace metadata cannot replace operation IDs, authorize targets or leak credentials", async () => {
  const f = await environment();
  const invocationId = crypto.randomUUID();
  try {
    for (const input of [
      {
        method: "POST",
        path: "/echo",
        trace: { invocationId, operationId: crypto.randomUUID() },
      },
      {
        method: "POST",
        path: "/echo",
        trace: { invocationId, target: "https://other.example" },
      },
      {
        method: "POST",
        path: "/echo",
        trace: { invocationId: "invalid-not-returned" },
      },
      {
        method: "POST",
        path: "/echo",
        trace: { invocationId: crypto.randomUUID() },
      },
      {
        method: "POST",
        path: "/echo",
        headers: { "X-Abilock-Operation-Id": crypto.randomUUID() },
      },
    ]) {
      const response = await call(f.gate.url, input, invocationId);
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.match(result.operationId, uuid);
      assert.equal(
        result.operationId,
        response.headers.get("x-abilock-operation-id"),
      );
      assert(!JSON.stringify(result).includes("invalid-not-returned"));
    }
    assert.equal(f.upstream.calls.length, 0);
    const separate = await call(f.gate.url, {
      method: "POST",
      path: "/echo",
      trace: { invocationId },
    });
    assert.equal(separate.status, 200);
    assert.equal(separate.headers.get("x-abilock-invocation-id"), invocationId);
    const badHeader = await fetch(f.gate.url + "/v1/platforms", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-abilock-invocation-id": "bad",
      },
    });
    assert.equal(badHeader.status, 400);
    assert.match(badHeader.headers.get("x-abilock-invocation-id")!, uuid);
    assert.match(badHeader.headers.get("x-abilock-operation-id")!, uuid);
    assert.notEqual(badHeader.headers.get("x-abilock-invocation-id"), "bad");
    const rejected = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(f.gate.url + "/v1/platforms", {
          headers: {
            authorization: "Bearer invalid",
            "x-abilock-invocation-id": invocationId,
          },
        }),
      ),
    );
    const rejectedIds = new Set<string>();
    for (const response of rejected) {
      assert.equal(response.status, 401);
      assert.equal(
        response.headers.get("x-abilock-invocation-id"),
        invocationId,
      );
      assert.match(response.headers.get("x-abilock-operation-id")!, uuid);
      rejectedIds.add(response.headers.get("x-abilock-operation-id")!);
      await response.text();
    }
    assert.equal(rejectedIds.size, 3);
  } finally {
    await f.close();
  }
});

test("SSE and binary data stay native while execution IDs remain available in headers", async () => {
  const f = await environment();
  const invocationId = crypto.randomUUID();
  try {
    const stream = await call(
      f.gate.url,
      { method: "GET", path: "/stream", trace: { invocationId } },
      invocationId,
    );
    assert.match(stream.headers.get("x-abilock-operation-id")!, uuid);
    const text = await stream.text();
    assert.match(text, /data:/);
    assert(
      !text.includes("operationId") &&
        !text.includes(invocationId) &&
        !text.includes(MOCK_BEARER),
    );
    const binary = await call(
      f.gate.url,
      { method: "GET", path: "/binary", trace: { invocationId } },
      invocationId,
    );
    assert.match(binary.headers.get("x-abilock-operation-id")!, uuid);
    assert.deepEqual(
      Buffer.from(await binary.arrayBuffer()),
      Buffer.from([0, 1, 2, 255, 8, 13]),
    );
    assert.notEqual(
      binary.headers.get("x-abilock-operation-id"),
      stream.headers.get("x-abilock-operation-id"),
    );
  } finally {
    await f.close();
  }
});
