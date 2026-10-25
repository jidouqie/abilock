import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer } from "ws";

const cli = new URL("../bin/abl.mjs", import.meta.url).pathname;
const token = "synthetic-operation-execution-token";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Result = { code: number | null; stdout: string; stderr: string };
function start(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = new Promise<Result>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(input);
  return { child, result };
}
type Seen = {
  route: string;
  method: string;
  invocationId: string;
  operationId: string;
  input: Record<string, unknown> | undefined;
};
type Options = {
  mismatch?: "header-invocation" | "body-operation";
  reject?: boolean;
  raw?: "sse" | "binary";
  legacy?: boolean;
};
async function fixture(
  action: (ctx: {
    dir: string;
    env: Record<string, string>;
    seen: Seen[];
    options: (value: Options) => void;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-operation-cli-"),
  );
  const seen: Seen[] = [];
  let options: Options = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (value) => (raw += value));
    req.once("end", () => {
      const invocationId = req.headers["x-abilock-invocation-id"] as string;
      const operationId = crypto.randomUUID();
      const input = raw ? JSON.parse(raw) : undefined;
      seen.push({
        route: req.url ?? "",
        method: req.method ?? "",
        invocationId,
        operationId,
        input,
      });
      assert.match(invocationId, uuid);
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (input) assert.deepEqual(input.trace, { invocationId });
      const ids = { invocationId, operationId };
      res.writeHead(options.reject ? 403 : 200, {
        "content-type":
          options.raw === "binary"
            ? "application/octet-stream"
            : options.raw === "sse"
              ? "text/event-stream"
              : "application/json",
        "x-abilock-request-id": "synthetic-request",
        ...(options.legacy
          ? {}
          : {
              "x-abilock-operation-id": operationId,
              "x-abilock-invocation-id":
                options.mismatch === "header-invocation"
                  ? crypto.randomUUID()
                  : invocationId,
            }),
      });
      if (options.raw) {
        res.end(
          options.raw === "binary"
            ? Buffer.from([0, 255, 13, 10, 128])
            : "event: owned\ndata: synthetic SSE\n\n",
        );
        return;
      }
      const metadata = options.legacy
        ? {}
        : {
            ...ids,
            ...(options.mismatch === "body-operation"
              ? { operationId: crypto.randomUUID() }
              : {}),
          };
      const reply = options.reject
        ? {
            ...metadata,
            error: { code: "SYNTHETIC_POLICY", message: "synthetic rejection" },
          }
        : req.url === "/v2/discovery"
          ? {
              ...metadata,
              version: 1,
              revision: "synthetic-catalog",
              capabilities: [],
            }
          : req.url === "/v1/context/API_A"
            ? {
                ...metadata,
                platform: {
                  alias: "API_A",
                  name: "synthetic chat",
                  enabled: true,
                  rules: [{ method: "POST", path: "/chat" }],
                  chat: {
                    method: "POST",
                    path: "/chat",
                    model: "explicit-model",
                  },
                },
                docs: [],
              }
            : req.url?.startsWith("/v2/context/")
              ? {
                  ...metadata,
                  connection: {
                    alias: "DB_A",
                    kind: "postgres",
                    config: { database: "owned" },
                  },
                  documentation: "# Synthetic protocol",
                  docs: [],
                }
              : req.url?.startsWith("/v2/run/")
                ? {
                    ...metadata,
                    exitCode: 0,
                    stdout: "synthetic native stdout\n",
                    data: { args: input?.args },
                  }
                : { data: { body: input?.body, path: input?.path } };
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await action({
      dir,
      env: {
        ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
        ABILOCK_EXEC_TOKEN: token,
      },
      seen,
      options: (value) => (options = value),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function ids(result: Result, source = "server") {
  const value = JSON.parse(result.stdout);
  assert.match(value.invocationId, uuid);
  assert.match(value.operationId, uuid);
  assert.notEqual(value.invocationId, value.operationId);
  assert.equal(value.operationIdSource, source);
  return value;
}

test("CLI GET and protocol/HTTP POST operations correlate headers and envelopes without changing business bodies", async () => {
  await fixture(async ({ dir, env, seen }) => {
    const cases: [string[], string][] = [
      [["list", "--json"], ""],
      [["doc", "postgres", "DB_A", "--json"], ""],
      [["postgres", "DB_A", "SELECT 1", "--abl-json"], ""],
      [["ssh", "SSH_A", "df -h", "--abl-json"], ""],
      [
        ["api", "API_A", "--stdin", "--json"],
        JSON.stringify({
          method: "POST",
          path: "/chat",
          body: { operationId: "business-value-kept", nested: [1, 2] },
        }),
      ],
    ];
    const invocations: string[] = [];
    for (const [args, input] of cases) {
      const result = await start(args, env, dir, input).result;
      assert.equal(result.code, 0);
      const value = ids(result);
      const request = seen.at(-1)!;
      assert.equal(value.operationId, request.operationId);
      assert.equal(value.invocationId, request.invocationId);
      assert.equal(result.stderr, "");
      invocations.push(value.invocationId);
    }
    assert.equal(new Set(invocations).size, cases.length);
    assert.deepEqual(seen.at(-1)!.input?.body, {
      operationId: "business-value-kept",
      nested: [1, 2],
    });
  });
});

test("chat context and call share one invocation and keep distinct authoritative operations", async () => {
  await fixture(async ({ dir, env, seen }) => {
    const result = await start(
      ["api", "API_A", "chat", "hello", "--json", "--abl-trace"],
      env,
      dir,
    ).result;
    assert.equal(result.code, 0);
    const value = ids(result);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].invocationId, seen[1].invocationId);
    assert.notEqual(seen[0].operationId, seen[1].operationId);
    assert.equal(value.operationId, seen[1].operationId);
    assert(result.stderr.includes(seen[0].operationId));
    assert(result.stderr.includes(seen[1].operationId));
    assert.deepEqual(seen[1].input?.body, {
      model: "explicit-model",
      messages: [{ role: "user", content: "hello" }],
    });
  });
});

test("parallel CLI processes invoking one alias never share invocation or operation identifiers", async () => {
  await fixture(async ({ dir, env, seen }) => {
    const results = await Promise.all(
      Array.from(
        { length: 6 },
        (_, index) =>
          start(
            ["api", "API_A", "--stdin", "--json"],
            env,
            dir,
            JSON.stringify({ method: "POST", path: "/chat", body: { index } }),
          ).result,
      ),
    );
    const values = results.map((result) => ids(result));
    assert.equal(new Set(values.map((value) => value.operationId)).size, 6);
    assert.equal(new Set(values.map((value) => value.invocationId)).size, 6);
    for (const value of values) {
      const request = seen.find(
        (entry) => entry.operationId === value.operationId,
      )!;
      assert.equal(request.invocationId, value.invocationId);
      assert.deepEqual(value.data.data.body, request.input?.body);
    }
  });
});

test("local input failures and missing server metadata have explicit client-source IDs; forged trace never reaches service", async () => {
  await fixture(async ({ dir, env, seen, options }) => {
    for (const args of [
      ["list", "--unknown", "--json"],
      ["list", "--abl-trace", "--abl-trace", "--json"],
    ]) {
      const result = await start(args, env, dir).result;
      assert.equal(result.code, 2);
      assert.equal(ids(result, "client").ok, false);
    }
    const forged = {
      method: "POST",
      path: "/chat",
      body: { owned: true },
      trace: {
        invocationId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
      },
    };
    const rejected = await start(
      ["api", "API_A", "--stdin", "--json"],
      env,
      dir,
      JSON.stringify(forged),
    ).result;
    assert.equal(rejected.code, 2);
    assert.equal(ids(rejected, "client").error.code, "TRACE_INPUT");
    const native = await start(
      ["redis", "CACHE_A", "--request-stdin", "--json"],
      env,
      dir,
      JSON.stringify({ args: ["GET", "owned"], trace: forged.trace }),
    ).result;
    assert.equal(native.code, 2);
    assert.equal(ids(native, "client").error.code, "TRACE_INPUT");
    assert.equal(seen.length, 0);
    options({ legacy: true });
    const legacy = await start(["list", "--json"], env, dir).result;
    assert.equal(ids(legacy, "client").ok, true);
  });
});

test("service failures retain server IDs and mismatched headers or protocol bodies are rejected", async () => {
  await fixture(async ({ dir, env, seen, options }) => {
    options({ reject: true });
    const denied = await start(["list", "--json"], env, dir).result;
    assert.equal(denied.code, 3);
    assert.equal(ids(denied).operationId, seen[0].operationId);
    for (const mismatch of ["header-invocation", "body-operation"] as const) {
      options({ mismatch });
      const result = await start(
        ["postgres", "DB_A", "SELECT 1", "--abl-json"],
        env,
        dir,
      ).result;
      assert.equal(result.code, 3);
      assert.equal(ids(result, "client").error.code, "TRACE_CONTEXT");
      assert(!result.stdout.includes("synthetic native stdout"));
    }
  });
});

test("raw native, SSE, binary stdout and files contain no added trace text", async () => {
  await fixture(async ({ dir, env, seen, options }) => {
    const native = await start(
      ["postgres", "DB_A", "SELECT 1", "--abl-trace"],
      env,
      dir,
    ).result;
    assert.equal(native.stdout, "synthetic native stdout\n");
    assert(native.stderr.includes(seen.at(-1)!.operationId));
    options({ raw: "sse" });
    const sse = await start(
      ["api", "API_A", "--stdin", "--abl-trace"],
      env,
      dir,
      JSON.stringify({ method: "GET", path: "/stream" }),
    ).result;
    assert.equal(sse.stdout, "event: owned\ndata: synthetic SSE\n\n");
    assert(sse.stderr.includes(seen.at(-1)!.operationId));
    options({ raw: "binary" });
    const raw = await start(
      ["api", "API_A", "--stdin", "--abl-trace"],
      env,
      dir,
      JSON.stringify({ method: "GET", path: "/binary" }),
    ).result;
    assert.equal(raw.stdout, Buffer.from([0, 255, 13, 10, 128]).toString());
    assert(raw.stderr.includes(seen.at(-1)!.operationId));
    const destination = path.join(dir, "owned-binary.bin");
    const file = await start(
      ["api", "API_A", "--stdin", "--output", destination, "--abl-trace"],
      env,
      dir,
      JSON.stringify({ method: "GET", path: "/binary" }),
    ).result;
    assert.equal(file.code, 0);
    assert.equal(file.stdout, "");
    assert.deepEqual(
      await fs.readFile(destination),
      Buffer.from([0, 255, 13, 10, 128]),
    );
    assert(file.stderr.includes(seen.at(-1)!.operationId));
  });
});

test("connection errors use fresh client-source IDs without copying prior service operations", async () => {
  const result = await start(
    ["list", "--json"],
    { ABILOCK_ENDPOINT: "http://127.0.0.1:1", ABILOCK_EXEC_TOKEN: token },
    os.tmpdir(),
  ).result;
  assert.equal(result.code, 3);
  assert.equal(ids(result, "client").error.code, "CONNECTION");
});

const ptyHarness = `import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
status = None
try:
    inputs = [fd, 0]
    while True:
        ready, _, _ = select.select(inputs, [], [], 0.1)
        stopped = False
        for source in ready:
            try:
                data = os.read(source, 65536)
            except OSError:
                stopped = True
                break
            if not data:
                if source == 0:
                    inputs.remove(0)
                else:
                    stopped = True
                continue
            if source == fd:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                os.write(fd, data)
        if stopped:
            break
        ended, value = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = value
            break
    if status is None:
        _, status = os.waitpid(pid, 0)
finally:
    os.close(fd)
    if status is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

test(
  "interactive SSH init correlates its invocation and rejects alien IDs, direction or frame order",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    for (const mismatch of [
      "none",
      "invocation",
      "operation",
      "sequence",
      "direction",
      "after-exit",
    ]) {
      const server = http.createServer();
      const sockets = new WebSocketServer({ server });
      const operationId = crypto.randomUUID();
      const clientFrames: Record<string, unknown>[] = [];
      let invocationId = "",
        child: ChildProcess | undefined;
      sockets.on("connection", (socket, request) => {
        invocationId = request.headers["x-abilock-invocation-id"] as string;
        socket.on("message", (bytes) => {
          const frame = JSON.parse(bytes.toString());
          clientFrames.push(frame);
          if (frame.type === "init") {
            assert.deepEqual(frame.trace, { invocationId });
            assert.equal(frame.direction, "client");
            assert.equal(frame.sequence, 1);
            socket.send(
              JSON.stringify({
                type: "ready",
                invocationId,
                operationId,
                direction: "server",
                sequence: 1,
              }),
            );
          } else if (frame.type === "resize") {
            assert.equal(frame.direction, "client");
            assert.equal(frame.sequence, 2);
            socket.send(
              JSON.stringify({
                type: "data",
                data: Buffer.from(
                  ["none", "after-exit"].includes(mismatch)
                    ? "owned WS data"
                    : "foreign WS data",
                ).toString("base64"),
                invocationId:
                  mismatch === "invocation"
                    ? crypto.randomUUID()
                    : invocationId,
                operationId:
                  mismatch === "operation" ? crypto.randomUUID() : operationId,
                direction: mismatch === "direction" ? "client" : "server",
                sequence: mismatch === "sequence" ? 1 : 2,
              }),
            );
            if (["none", "after-exit"].includes(mismatch))
              socket.send(
                JSON.stringify({
                  type: "exit",
                  code: 7,
                  invocationId,
                  operationId,
                  direction: "server",
                  sequence: 3,
                }),
              );
            if (mismatch === "after-exit")
              socket.send(
                JSON.stringify({
                  type: "data",
                  data: Buffer.from("foreign WS data").toString("base64"),
                  invocationId,
                  operationId,
                  direction: "server",
                  sequence: 4,
                }),
              );
          }
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert(address && typeof address !== "string");
      let stdout = "",
        stderr = "";
      try {
        child = spawn(
          "/usr/bin/python3",
          ["-c", ptyHarness, process.execPath, cli, "ssh", "SSH_A"],
          {
            env: {
              ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
              ABILOCK_EXEC_TOKEN: token,
              PATH: path.dirname(process.execPath),
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        child.stdout?.on("data", (bytes) => (stdout += bytes));
        child.stderr?.on("data", (bytes) => (stderr += bytes));
        const code = await new Promise<number | null>((resolve, reject) => {
          child!.once("error", reject);
          child!.once("close", resolve);
        });
        assert.equal(
          code,
          ["none", "after-exit"].includes(mismatch) ? 7 : 3,
          stdout + stderr,
        );
        assert.match(invocationId, uuid);
        assert.equal(clientFrames[0].type, "init");
        if (["none", "after-exit"].includes(mismatch))
          assert.match(stdout, /owned WS data/);
        assert(!stdout.includes("foreign WS data"));
        assert(!stdout.includes(operationId));
        assert(!stdout.includes(token));
      } finally {
        child?.kill();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);
