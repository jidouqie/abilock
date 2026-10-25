import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { Duplex, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { AppError, platformSchema } from "../src/schema.js";
import { protocolAdapters } from "../src/protocols/index.js";
import type { AdapterContext, Operation } from "../src/connections.js";
import {
  LocalResponse,
  executeLocalRequest,
  type LocalRequest,
  type LocalResponseHeaders,
} from "../src/local-execution.js";
import { createLocalTerminalSession } from "../src/local-terminal.js";
import { mockUpstream, MOCK_BEARER } from "../scripts/mock-upstream.js";

const master = "9".repeat(64),
  execToken = "synthetic-local-exec-capability-84509",
  otherSecret = "synthetic-other-protocol-secret-84510";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const previousMock = process.env.ABILOCK_MOCK,
  previousLocal = process.env.ABILOCK_ALLOW_LOCAL;
before(() => {
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
});
after(() => {
  if (previousMock === undefined) delete process.env.ABILOCK_MOCK;
  else process.env.ABILOCK_MOCK = previousMock;
  if (previousLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
  else process.env.ABILOCK_ALLOW_LOCAL = previousLocal;
});

async function fixture() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-execution-"),
  );
  const store = new Store(dir, master, [execToken]);
  let upstream: Awaited<ReturnType<typeof mockUpstream>> | undefined;
  try {
    await store.init();
    upstream = await mockUpstream();
    await store.save(
      platformSchema.parse({
        alias: "TEXT",
        name: "Synthetic copywriter",
        baseUrl: upstream.url,
        auth: { type: "bearer" },
        enabled: true,
        allowInsecureLocal: true,
        rules: [
          { method: "POST", path: "/echo" },
          { method: "GET", path: "/stream" },
          { method: "GET", path: "/binary" },
          { method: "GET", path: "/slow" },
          { method: "GET", path: "/redirect" },
          { method: "GET", path: "/header-leak" },
        ],
        chat: { method: "POST", path: "/echo", model: "synthetic-model" },
      }),
      { value: MOCK_BEARER },
      false,
      0,
    );
    await store.saveConnection(
      {
        alias: "CACHE",
        name: "Synthetic redis",
        kind: "redis",
        enabled: true,
        description: "",
        trustBoundary: "development-fixture",
        config: { host: "127.0.0.1", port: 6379, database: 0, tls: false },
      },
      { password: otherSecret },
      false,
      0,
    );
    await store.saveConnection(
      {
        alias: "SHELL",
        name: "Synthetic ssh",
        kind: "ssh",
        enabled: true,
        description: "",
        trustBoundary: "development-fixture",
        config: {
          host: "127.0.0.1",
          port: 2222,
          username: "synthetic",
          hostKeySHA256: "SHA256:" + "A".repeat(43),
          remoteRoot: "/synthetic",
          fileAccess: "read",
          allowShell: true,
        },
      },
      { password: otherSecret },
      false,
      0,
    );
    return {
      dir,
      store,
      upstream,
      async close() {
        await upstream!.close();
        await store.close();
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await upstream?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
async function request(
  store: Store,
  input: LocalRequest,
  options: { signal?: AbortSignal; fixture?: boolean; output?: Writable } = {},
) {
  const bytes: Buffer[] = [],
    headers: LocalResponseHeaders[] = [];
  const output =
    options.output ??
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes.push(Buffer.from(chunk));
        callback();
      },
    });
  const response = new LocalResponse(output, (message) =>
    headers.push(message),
  );
  const result = await executeLocalRequest(store, input, response, {
    signal: options.signal ?? new AbortController().signal,
    programRoot: path.resolve("."),
    allowLocalFixture: options.fixture,
  });
  assert.equal(headers.length, 1);
  return { ...headers[0], bytes: Buffer.concat(bytes), result, response };
}
function get(url: string, invocationId = crypto.randomUUID()): LocalRequest {
  return {
    type: "request",
    url,
    method: "GET",
    headers: { "x-abilock-invocation-id": invocationId },
  };
}
function post(
  url: string,
  body: unknown,
  invocationId = crypto.randomUUID(),
): LocalRequest {
  return {
    type: "request",
    url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-abilock-invocation-id": invocationId,
    },
    body: JSON.stringify(body),
  };
}
function safe(raw: string) {
  for (const value of [master, execToken, otherSecret, MOCK_BEARER]) {
    assert(!raw.includes(value));
    assert(!raw.includes(encodeURIComponent(value)));
    assert(!raw.includes(Buffer.from(value).toString("base64")));
  }
}

test("本地能力目录和说明书不监听、不读取上游、不返回凭据", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(net.Server.prototype, "listen", () => {
      throw new Error("execution must not listen");
    });
    for (const url of [
      "/v2/discovery",
      "/v1/platforms",
      "/v1/context/TEXT",
      "/v2/connections",
      "/v2/context/redis/CACHE",
    ]) {
      const result = await request(f.store, get(url));
      assert.equal(result.status, 200);
      assert.equal(result.result.failed, false);
      assert.match(result.headers["x-abilock-operation-id"], uuid);
      safe(result.bytes.toString());
      assert(!result.bytes.toString().includes('"sealed"'));
    }
    const context = JSON.parse(
      (await request(f.store, get("/v1/context/TEXT"))).bytes.toString(),
    );
    assert.equal(context.platform.chat.model, "synthetic-model");
    assert.equal(f.upstream.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("本地HTTP复用固定目标鉴权注入及完整输出脱敏，并发操作编号各不相同", async (t) => {
  const f = await fixture(),
    invocationId = crypto.randomUUID();
  try {
    t.mock.method(net.Server.prototype, "listen", () => {
      throw new Error("execution must not listen");
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(
          f.store,
          post(
            "/v1/call/TEXT",
            {
              method: "POST",
              path: "/echo",
              body: { index, text: "自然中文" },
            },
            invocationId,
          ),
        ),
      ),
    );
    for (let index = 0; index < results.length; index++) {
      const response = results[index];
      assert.equal(response.status, 200);
      assert.equal(response.headers["x-abilock-invocation-id"], invocationId);
      assert.match(response.headers["x-abilock-operation-id"], uuid);
      assert.match(response.headers["x-abilock-request-id"], uuid);
      const value = JSON.parse(response.bytes.toString());
      assert.equal(value.body.index, index);
      assert.equal(value.body.text, "自然中文");
      assert.equal(value.reflectedAuth, "[REDACTED]");
      safe(response.bytes.toString());
    }
    assert.equal(
      new Set(results.map((r) => r.headers["x-abilock-operation-id"])).size,
      10,
    );
    assert.equal(
      new Set(results.map((r) => r.headers["x-abilock-request-id"])).size,
      10,
    );
    assert.equal(f.upstream.calls.length, 10);
    for (const call of f.upstream.calls) {
      assert.equal(call.headers.authorization, `Bearer ${MOCK_BEARER}`);
      assert.equal(call.headers["x-abilock-invocation-id"], undefined);
      assert.equal(call.headers["x-abilock-operation-id"], undefined);
    }
  } finally {
    await f.close();
  }
});

test("本地HTTP拒绝鉴权/目标覆盖、未允许路径、重定向和管理操作", async () => {
  const f = await fixture();
  try {
    for (const [input, code] of [
      [
        post("/v1/call/TEXT", {
          method: "POST",
          path: "/echo",
          headers: { authorization: "synthetic-forbidden" },
        }),
        "HEADER_NOT_ALLOWED",
      ],
      [
        post("/v1/call/TEXT", {
          method: "POST",
          path: "/echo",
          target: "https://synthetic.invalid",
        }),
        "VALIDATION",
      ],
      [
        post("/v1/call/TEXT", { method: "POST", path: "/not-allowed" }),
        "PATH_NOT_ALLOWED",
      ],
      [post("/admin/platforms/TEXT", {}), "NOT_FOUND"],
      [get("/v1/context/%54EXT"), "INVALID_ROUTE"],
      [
        {
          ...get("/v1/platforms"),
          headers: { authorization: `Bearer ${MOCK_BEARER}` },
        },
        "HEADER_NOT_ALLOWED",
      ],
    ] as const) {
      const response = await request(f.store, input);
      assert(response.status >= 400);
      assert.equal(JSON.parse(response.bytes.toString()).error.code, code);
      safe(response.bytes.toString());
    }
    assert.equal(f.upstream.calls.length, 0);
    const response = await request(
      f.store,
      post("/v1/call/TEXT", { method: "GET", path: "/redirect" }),
    );
    assert.equal(response.status, 502);
    assert.equal(
      JSON.parse(response.bytes.toString()).error.code,
      "REDIRECT_BLOCKED",
    );
    assert.equal(f.upstream.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("本地HTTP保留SSE语义与二进制字节并过滤公共头中的秘密", async () => {
  const f = await fixture();
  try {
    const stream = await request(
      f.store,
      post("/v1/call/TEXT", { method: "GET", path: "/stream" }),
    );
    assert.equal(stream.headers["content-type"], "text/event-stream");
    assert.equal(
      stream.bytes.toString(),
      'data: {"text":"hello"}\n\ndata: [REDACTED]\n\ndata: [DONE]\n\n',
    );
    const binary = await request(
      f.store,
      post("/v1/call/TEXT", { method: "GET", path: "/binary" }),
    );
    assert.deepEqual(binary.bytes, Buffer.from([0, 1, 2, 255, 8, 13]));
    const header = await request(
      f.store,
      post("/v1/call/TEXT", { method: "GET", path: "/header-leak" }),
    );
    assert.equal(
      header.headers["content-type"],
      "text/plain; secret=[REDACTED]",
    );
    assert.equal(header.bytes.toString(), "safe");
    safe(JSON.stringify(header.headers));
  } finally {
    await f.close();
  }
});

test("native执行保留统一追踪、受控输入和全库JSON/文件脱敏", async (t) => {
  const f = await fixture(),
    invocationId = crypto.randomUUID();
  try {
    let called = 0;
    t.mock.method(
      protocolAdapters.redis,
      "run",
      async (context: AdapterContext, operation: Operation) => {
        called++;
        assert.equal(context.secret.password, otherSecret);
        assert.equal(context.trace?.invocationId, invocationId);
        assert.equal(Object.isFrozen(context.trace), true);
        assert.equal("trace" in operation, false);
        assert.deepEqual(operation.args, ["GET", "synthetic-key"]);
        return {
          exitCode: 0,
          stdout: `safe ${otherSecret} ${MOCK_BEARER}`,
          data: { nested: { [otherSecret]: execToken } },
          files: [
            {
              path: "business.bin",
              base64: Buffer.from(`prefix ${MOCK_BEARER} suffix`).toString(
                "base64",
              ),
            },
          ],
        };
      },
    );
    t.mock.method(net.Server.prototype, "listen", () => {
      throw new Error("execution must not listen");
    });
    const input = post(
      "/v2/run/redis/CACHE",
      { args: ["GET", "synthetic-key"], trace: { invocationId } },
      invocationId,
    );
    const first = await request(f.store, input, { fixture: true }),
      second = await request(f.store, input, { fixture: true });
    assert.equal(called, 2);
    for (const response of [first, second]) {
      assert.equal(response.status, 200);
      const value = JSON.parse(response.bytes.toString());
      assert.equal(value.invocationId, invocationId);
      assert.equal(
        value.operationId,
        response.headers["x-abilock-operation-id"],
      );
      assert.equal(value.stdout, "safe [REDACTED] [REDACTED]");
      assert.deepEqual(value.data, { nested: { "[REDACTED]": "[REDACTED]" } });
      assert.equal(
        Buffer.from(value.files[0].base64, "base64").toString(),
        "prefix [REDACTED] suffix",
      );
      safe(response.bytes.toString());
    }
    assert.notEqual(
      first.headers["x-abilock-operation-id"],
      second.headers["x-abilock-operation-id"],
    );
  } finally {
    await f.close();
  }
});

test("本地native默认执行仍拒绝broker目标、停用连接和追踪冲突", async (t) => {
  const f = await fixture();
  try {
    let called = 0;
    t.mock.method(protocolAdapters.redis, "run", async () => {
      called++;
      return { exitCode: 0 };
    });
    const target = await request(
      f.store,
      post("/v2/run/redis/CACHE", { args: ["PING"] }),
    );
    assert.equal(
      JSON.parse(target.bytes.toString()).error.code,
      "TARGET_TRUST_REQUIRED",
    );
    const conflict = await request(
      f.store,
      post("/v2/run/redis/CACHE", {
        args: ["PING"],
        trace: { invocationId: crypto.randomUUID() },
      }),
      { fixture: true },
    );
    assert.equal(
      JSON.parse(conflict.bytes.toString()).error.code,
      "TRACE_CONFLICT",
    );
    const connection = f.store.connection("redis", "CACHE");
    await f.store.saveConnection(
      {
        alias: connection.alias,
        name: connection.name,
        kind: connection.kind,
        enabled: false,
        description: connection.description,
        trustBoundary: connection.trustBoundary,
        config: connection.config,
      },
      undefined,
      false,
      connection.revision,
    );
    const disabled = await request(
      f.store,
      post("/v2/run/redis/CACHE", { args: ["PING"] }),
      { fixture: true },
    );
    assert.equal(
      JSON.parse(disabled.bytes.toString()).error.code,
      "CONNECTION_DISABLED",
    );
    assert.equal(called, 0);
  } finally {
    await f.close();
  }
});

test("本地执行超时/取消不输出原生异常或凭据且不重试", async (t) => {
  const f = await fixture();
  try {
    let called = 0;
    t.mock.method(
      protocolAdapters.redis,
      "run",
      async (context: AdapterContext) => {
        called++;
        return new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    );
    const timed = await request(
      f.store,
      post("/v2/run/redis/CACHE", { args: ["PING"], timeoutMs: 100 }),
      { fixture: true },
    );
    assert.equal(timed.status, 504);
    assert.equal(
      JSON.parse(timed.bytes.toString()).error.code,
      "UPSTREAM_TIMEOUT",
    );
    assert.equal(called, 1);
    t.mock.method(protocolAdapters.redis, "run", async () => {
      throw new Error(`${otherSecret} ${master}`);
    });
    const failed = await request(
      f.store,
      post("/v2/run/redis/CACHE", { args: ["PING"] }),
      { fixture: true },
    );
    assert.equal(failed.status, 502);
    safe(failed.bytes.toString());
    const controller = new AbortController();
    const pending = request(
      f.store,
      post("/v1/call/TEXT", { method: "GET", path: "/slow" }),
      { signal: controller.signal },
    );
    await delay(20);
    controller.abort(new AppError(499, "CANCELLED", "请求已取消"));
    const cancelled = await pending;
    assert.equal(cancelled.status, 499);
    assert.equal(
      JSON.parse(cancelled.bytes.toString()).error.code,
      "CANCELLED",
    );
    assert.equal(f.upstream.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("流中途失败保持已输出业务字节并报告失败，不追加JSON成功或错误", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-partial-"),
  );
  const store = new Store(dir, master);
  await store.init();
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("accepted ".repeat(500));
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  try {
    await store.save(
      platformSchema.parse({
        alias: "PARTIAL",
        name: "Synthetic partial",
        auth: { type: "none" },
        baseUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,
        allowInsecureLocal: true,
        rules: [{ method: "GET", path: "/read" }],
      }),
      undefined,
      false,
      0,
    );
    const result = await request(
      store,
      post("/v1/call/PARTIAL", { method: "GET", path: "/read" }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.result.failed, true);
    assert.equal(result.response.writableFinished, false);
    assert(result.bytes.toString().startsWith("accepted "));
    assert(!result.bytes.toString().includes('"error"'));
    assert(!result.bytes.toString().includes('"ok"'));
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("响应sink遵守下游背压，写失败不会报告成功", async () => {
  const f = await fixture();
  try {
    let written = false;
    const slow = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          written = true;
          callback();
        }, 25);
      },
    });
    const complete = await request(f.store, get("/v1/platforms"), {
      output: slow,
    });
    assert.equal(written, true);
    assert.equal(complete.result.failed, false);
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("synthetic pipe closed"));
      },
    });
    broken.on("error", () => {});
    const failed = await request(f.store, get("/v1/platforms"), {
      output: broken,
    });
    assert.equal(failed.result.failed, true);
  } finally {
    await f.close();
  }
});

test("本地PTY保留固定编号/帧序号、resize与EOF，全库秘密不进入输出", async () => {
  const f = await fixture(),
    invocationId = crypto.randomUUID();
  try {
    const frames: Record<string, unknown>[] = [],
      writes: string[] = [],
      sizes: number[][] = [];
    let closed = 0,
      ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
      final(callback) {
        this.push(Buffer.from(`echo ${otherSecret.slice(0, 13)}`));
        this.push(Buffer.from(`${otherSecret.slice(13)} ${MOCK_BEARER}`));
        this.push(null);
        callback();
      },
    });
    const session = createLocalTerminalSession(
      f.store,
      {
        type: "terminal",
        selector: "SHELL",
        headers: { "x-abilock-invocation-id": invocationId },
      },
      {
        signal: new AbortController().signal,
        allowLocalFixture: true,
        send: async (frame) => {
          frames.push(frame);
          if (frame.type === "ready") ready();
        },
        open: async (context) => {
          assert.equal(context.secret.password, otherSecret);
          assert.equal(context.trace?.invocationId, invocationId);
          return {
            stream,
            exitCode: 7,
            close: () => {
              closed++;
              stream.destroy();
            },
            resize: (rows, cols) => {
              sizes.push([rows, cols]);
            },
          };
        },
      },
    );
    session.receive({
      type: "init",
      trace: { invocationId },
      sequence: 1,
      direction: "client",
    });
    await readyPromise;
    session.receive({
      type: "resize",
      rows: 30,
      cols: 90,
      sequence: 2,
      direction: "client",
      ...session.trace,
    });
    session.receive({
      type: "data",
      data: Buffer.from("business input").toString("base64"),
      sequence: 3,
      direction: "client",
      ...session.trace,
    });
    session.receive({
      type: "eof",
      sequence: 4,
      direction: "client",
      ...session.trace,
    });
    await session.done;
    assert.deepEqual(writes, ["business input"]);
    assert.deepEqual(sizes, [[30, 90]]);
    assert.equal(closed, 1);
    assert.equal(frames[0].type, "ready");
    assert.equal(frames.at(-1)?.type, "exit");
    assert.equal(frames.at(-1)?.code, 7);
    let decoded = "";
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      assert.equal(frame.sequence, index + 1);
      assert.equal(frame.direction, "server");
      assert.equal(frame.invocationId, invocationId);
      assert.equal(frame.operationId, session.trace.operationId);
      assert.match(String(frame.requestId), uuid);
      if (frame.type === "data")
        decoded += Buffer.from(String(frame.data), "base64").toString();
    }
    assert.equal(decoded, "echo [REDACTED] [REDACTED]");
    safe(JSON.stringify(frames));
    safe(decoded);
  } finally {
    await f.close();
  }
});

test("本地PTY拒绝冒用追踪帧并在取消时关闭会话", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const frames: Record<string, unknown>[] = [];
    let closed = 0,
      ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const session = createLocalTerminalSession(
      f.store,
      {
        type: "terminal",
        selector: "SHELL",
        headers: { "x-abilock-invocation-id": crypto.randomUUID() },
      },
      {
        signal: controller.signal,
        allowLocalFixture: true,
        send: async (frame) => {
          frames.push(frame);
          if (frame.type === "ready") ready();
        },
        open: async () => ({
          stream,
          exitCode: 1,
          close: () => {
            closed++;
            stream.destroy();
          },
          resize: () => {},
        }),
      },
    );
    await readyPromise;
    session.receive({
      type: "data",
      data: Buffer.from("forbidden").toString("base64"),
      operationId: crypto.randomUUID(),
    });
    await delay(0);
    assert.equal(frames.at(-1)?.code, "INVALID_TERMINAL_FRAME");
    controller.abort();
    await session.done;
    assert.equal(closed, 1);
    safe(JSON.stringify(frames));
  } finally {
    await f.close();
  }
});
