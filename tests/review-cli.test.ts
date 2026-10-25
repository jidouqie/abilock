import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { prepareOutput, saveOutput } from "../bin/client-output.mjs";
import { postgresAdapter, redisAdapter } from "../src/protocols/databases.js";
import type { AdapterContext } from "../src/connections.js";

// Only synthesized files, mock loopback HTTP/WS and network-free denied DB
// operations. No Git executable, Git CLI mock, browser or real account/config.
const cli = new URL("../bin/abl.mjs", import.meta.url).pathname;
const token = "synthetic-review-cli-execution-capability";
type Result = { code: number | null; stdout: string; stderr: string };
type Operation = {
  args: string[];
  input?: string;
  files?: { path: string; base64: string }[];
};
type Seen = { route: string; operation: Operation };

test("native CLI prints every partial-batch target in text mode and preserves JSON without extra stderr", async () => {
  await fixture(async ({ reply, invoke }) => {
    const batch = {
      status: "failed",
      items: [
        { index: 0, target: "one", status: "completed", exitCode: 0 },
        {
          index: 1,
          target: "two",
          status: "unknown",
          error: {
            code: "UPSTREAM_FAILURE",
            message: "synthetic raw exception must not be interpolated",
          },
        },
        { index: 2, target: "three", status: "not-started" },
      ],
    };
    reply({
      exitCode: 1,
      stdout: "completed response\n",
      stderr: "调用中断",
      data: [{ status: 204 }],
      batch,
    });
    const plain = await invoke([
      "docker",
      "DOCKER",
      "stop",
      "one",
      "two",
      "three",
    ]);
    assert.equal(plain.code, 4);
    assert.equal(plain.stdout, "completed response\n");
    assert.match(plain.stderr, /1\. "one"：已完成/);
    assert.match(plain.stderr, /2\. "two"：结果未知/);
    assert.match(plain.stderr, /3\. "three"：未开始/);
    assert.ok(!plain.stderr.includes("synthetic raw exception"));
    const structured = await invoke([
      "docker",
      "DOCKER",
      "stop",
      "one",
      "two",
      "three",
      "--abl-json",
    ]);
    assert.equal(structured.code, 4);
    assert.equal(structured.stderr, "");
    assert.deepEqual(JSON.parse(structured.stdout).data.batch, batch);
    reply({
      exitCode: 1,
      data: [],
      batch: {
        status: "cancelled",
        items: [{ index: 0, target: "safe\n[spoofed]", status: "unknown" }],
      },
    });
    const cancelled = await invoke(["docker", "DOCKER", "stop", "one", "two"]);
    assert.match(cancelled.stderr, /"safe\\n\[spoofed\]"：结果未知/);
    assert.ok(!cancelled.stderr.includes("\n[spoofed]"));
  });
});

async function temporary(action: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-review-cli-"));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function run(
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
  child.stdin.end(input);
  const result = new Promise<Result>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

async function fixture(
  action: (ctx: {
    root: string;
    env: Record<string, string>;
    seen: Seen[];
    reply(value: unknown): void;
    invoke(args: string[], input?: string): Promise<Result>;
  }) => Promise<void>,
) {
  await temporary(async (root) => {
    const seen: Seen[] = [],
      children = new Set<ReturnType<typeof spawn>>();
    let reply: unknown = { exitCode: 0, stdout: "mock-output\n" };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        const invocationId = req.headers["x-abilock-invocation-id"];
        const operationId = crypto.randomUUID();
        const operation = JSON.parse(raw);
        seen.push({ route: req.url ?? "", operation });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-abilock-invocation-id": String(invocationId),
          "x-abilock-operation-id": operationId,
        });
        res.end(JSON.stringify(reply));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      const env = {
        ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
        ABILOCK_EXEC_TOKEN: token,
      };
      await action({
        root,
        env,
        seen,
        reply: (value) => (reply = value),
        invoke: async (args, input = "") => {
          const started = run(args, env, root, input);
          children.add(started.child);
          try {
            return await started.result;
          } finally {
            children.delete(started.child);
          }
        },
      });
    } finally {
      for (const child of children) child.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("review CLI help supplies a usable minimal HTTP envelope", async () => {
  const help = await run(["--help"], {}, os.tmpdir()).result;
  assert.equal(help.code, 0);
  const example = help.stdout
    .split("\n")
    .find((line) => line.startsWith('{"method":'));
  assert(example);
  const request = JSON.parse(example);
  assert.deepEqual(Object.keys(request), ["method", "path", "body"]);
  await fixture(async ({ invoke, seen }) => {
    const result = await invoke(["api", "API", "--stdin", "--json"], example);
    assert.equal(result.code, 0, result.stderr);
    const { trace, ...actual } = seen[0].operation as Operation & {
      trace: unknown;
    };
    assert(trace);
    assert.deepEqual(actual, request);
  });
});

test("review CLI separator preserves wrapper-like business values and legacy spellings", async () => {
  await fixture(async ({ invoke, seen }) => {
    const values = [
      "--abl-json",
      "--abl-trace",
      "--abl-input",
      "--abl-stdin",
      "--request-json",
      "--request-stdin",
      "--pvo-json",
      "--pvo-input",
      "--password",
      "--token",
      "redis://business-value",
    ];
    for (const value of values) {
      const result = await invoke([
        "redis",
        "CACHE",
        "--abl-json",
        "--",
        "SET",
        "record",
        value,
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true);
      assert.deepEqual(seen.at(-1)!.operation.args, ["SET", "record", value]);
      assert.equal(seen.at(-1)!.operation.input, undefined);
      assert.equal(result.stderr, "");
    }
    const ssh = await invoke([
      "ssh",
      "REMOTE",
      "--",
      "printf",
      "%s",
      "--abl-trace",
      "--abl-input",
      "business-name",
    ]);
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.equal(ssh.stdout, "mock-output\n");
    assert.equal(ssh.stderr, "");
    assert.deepEqual(seen.at(-1)!.operation.args, [
      "printf",
      "%s",
      "--abl-trace",
      "--abl-input",
      "business-name",
    ]);
    const legacy = await invoke([
      "redis",
      "CACHE",
      "--pvo-json",
      "--",
      "ECHO",
      "--pvo-json",
    ]);
    assert.equal(legacy.code, 0);
    assert.deepEqual(seen.at(-1)!.operation.args, ["ECHO", "--pvo-json"]);
    const count = seen.length;
    for (const args of [
      ["redis", "CACHE", "--abl-json", "--abl-json", "--", "PING"],
      ["redis", "CACHE", "--abl-trace", "--abl-trace", "--", "PING"],
      ["redis", "CACHE", "--abl-input", "--", "business-name"],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 2);
    }
    assert.equal(seen.length, count);
  });
});

test("review CLI wrapper input before separator retains binary Redis and text SQL input", async () => {
  await fixture(async ({ invoke, seen, root }) => {
    const binary = path.join(root, "business.bin"),
      bytes = Buffer.from([0, 255, 128, 13, 10]);
    await fs.writeFile(binary, bytes);
    const redis = await invoke([
      "redis",
      "CACHE",
      "--abl-json",
      "--abl-input",
      binary,
      "--",
      "-x",
      "SET",
      "binary",
    ]);
    assert.equal(redis.code, 0, redis.stdout + redis.stderr);
    assert.deepEqual(seen.at(-1)!.operation.args, ["-x", "SET", "binary"]);
    assert.deepEqual(seen.at(-1)!.operation.files, [
      { path: "-", base64: bytes.toString("base64") },
    ]);
    const sql = await invoke(
      ["psql", "DB", "--abl-json", "--abl-stdin", "--", "--file=-"],
      "SELECT 42;",
    );
    assert.equal(sql.code, 0, sql.stdout + sql.stderr);
    assert.equal(seen.at(-1)!.operation.input, "SELECT 42;");
  });
});

test("review CLI delimiter cannot exempt actual credentials or backend command restrictions", async () => {
  await fixture(async ({ invoke, seen }) => {
    for (const args of [
      [
        "redis",
        "CACHE",
        "--abl-json",
        "--",
        "-a",
        "synthetic-password",
        "PING",
      ],
      ["mysql", "DB", "--abl-json", "--", "--password", "synthetic-password"],
      [
        "aws",
        "CLOUD",
        "--abl-json",
        "--",
        "--secret-access-key",
        "synthetic-key",
      ],
      ["kubectl", "KUBE", "--abl-json", "--", "--kubeconfig", "synthetic-file"],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 2);
      assert.equal(JSON.parse(result.stdout).error.code, "CREDENTIAL_ARGUMENT");
    }
    assert.equal(seen.length, 0);
  });
  const ctx = (kind: "postgres" | "redis"): AdapterContext => ({
    connection: {
      alias: "SYNTHETIC",
      kind,
      name: "Denied operation fixture",
      description: "",
      enabled: true,
      config: {
        host: "127.0.0.1",
        tls: false,
        ...(kind === "postgres"
          ? { user: "synthetic-user", database: "synthetic-db" }
          : {}),
      },
    },
    secret: { password: "synthetic-password" },
    signal: new AbortController().signal,
    allowLocal: false,
    dataDir: "unused-by-denied-operation",
  });
  // Actual adapter semantic rejection happens before DNS or any socket creation.
  for (const args of [
    ["AUTH", "synthetic-password"],
    ["CONFIG", "GET", "*"],
    ["-h", "127.0.0.1", "PING"],
  ]) {
    const result = await redisAdapter.run(ctx("redis"), {
      args,
      timeoutMs: 1000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr!, /DB_(?:COMMAND|ARGUMENT)_DENIED/);
  }
  for (const args of [
    ["--host", "127.0.0.1"],
    ["--username", "synthetic-user"],
    ["-c", "\\! synthetic-helper"],
  ]) {
    const result = await postgresAdapter.run(ctx("postgres"), {
      args,
      timeoutMs: 1000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr!,
      /DB_(?:ARGUMENT_DENIED|CLIENT_META_COMMAND_DENIED)/,
    );
  }
});

test("review CLI safely uploads equal-form SQL and Kubernetes file options", async () => {
  await fixture(async ({ invoke, seen, root }) => {
    const sql = path.join(root, "业务.sql"),
      manifest = path.join(root, "pod.json");
    await fs.writeFile(sql, "SELECT '正常';");
    await fs.writeFile(manifest, '{"apiVersion":"v1","kind":"Pod"}');
    for (const command of ["postgres", "psql", "mysql"]) {
      const result = await invoke([
        command,
        "DB",
        "--abl-json",
        "--",
        `--file=${sql}`,
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(seen.at(-1)!.operation.args, ["--file=-"]);
      assert.equal(seen.at(-1)!.operation.input, "SELECT '正常';");
    }
    const kube = await invoke([
      "kubectl",
      "KUBE",
      "--abl-json",
      "--",
      "apply",
      `--filename=${manifest}`,
      "--server-side",
    ]);
    assert.equal(kube.code, 0);
    assert.deepEqual(seen.at(-1)!.operation.args, [
      "apply",
      "--filename=-",
      "--server-side",
    ]);
    assert.equal(
      seen.at(-1)!.operation.input,
      '{"apiVersion":"v1","kind":"Pod"}',
    );
    const literal = await invoke([
      "psql",
      "DB",
      "--abl-json",
      "--",
      "-c",
      "--file=not-a-local-selection",
    ]);
    assert.equal(literal.code, 0);
    assert.deepEqual(seen.at(-1)!.operation.args, [
      "-c",
      "--file=not-a-local-selection",
    ]);
    assert.equal(seen.at(-1)!.operation.input, undefined);
    const count = seen.length;
    const credentials = path.join(root, ".ssh", "synthetic.sql");
    await fs.mkdir(path.dirname(credentials));
    await fs.writeFile(credentials, "synthetic only");
    const link = path.join(root, "linked.sql");
    await fs.symlink(sql, link);
    for (const args of [
      [`--file=${credentials}`],
      [`--file=${link}`],
      ["--file="],
      ["-f", sql, `--file=${sql}`],
      ["--abl-input", sql, `--file=${sql}`],
    ]) {
      const result = await invoke(["psql", "DB", "--abl-json", ...args]);
      assert.equal(result.code, 2);
    }
    assert.equal(seen.length, count);
  });
});

test("review native downloads use guarded output for exact bytes and nested manifests", async () => {
  await fixture(async ({ invoke, root, reply }) => {
    const bytes = Buffer.from([0, 255, 128, 13, 10]),
      target = path.join(root, "new", "received.bin");
    reply({
      exitCode: 0,
      files: [{ path: "received.bin", base64: bytes.toString("base64") }],
    });
    const get = await invoke([
      "sftp",
      "REMOTE",
      "get",
      "reports/received.bin",
      target,
      "--abl-json",
    ]);
    assert.equal(get.code, 0, get.stdout + get.stderr);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal(
      (await fs.readdir(path.dirname(target))).some((name) =>
        name.endsWith(".part"),
      ),
      false,
    );
    const bundle = path.join(root, "bundle");
    reply({
      exitCode: 0,
      files: [
        { path: "bundle/a.bin", base64: bytes.toString("base64") },
        { path: "bundle/nested/b.bin", base64: "Yg==" },
      ],
    });
    const recursive = await invoke([
      "rsync",
      "REMOTE",
      "-r",
      ":reports",
      bundle,
      "--abl-json",
    ]);
    assert.equal(recursive.code, 0, recursive.stdout + recursive.stderr);
    assert.deepEqual(await fs.readFile(path.join(bundle, "a.bin")), bytes);
    assert.equal(
      await fs.readFile(path.join(bundle, "nested", "b.bin"), "utf8"),
      "b",
    );
    const untouched = path.join(root, "invalid-batch");
    reply({
      exitCode: 0,
      files: [
        { path: "a", base64: "YQ==" },
        { path: "../escape", base64: "Yg==" },
      ],
    });
    const invalid = await invoke([
      "rsync",
      "REMOTE",
      "-r",
      ":reports",
      untouched,
      "--abl-json",
    ]);
    assert.equal(invalid.code, 3);
    await assert.rejects(fs.stat(untouched), { code: "ENOENT" });
  });
});

test("review output rejects observed parent replacement and concurrent destination changes", async () => {
  await temporary(async (root) => {
    const selected = path.join(root, "selected"),
      parked = path.join(root, "parked"),
      foreign = path.join(root, "synthetic", ".ssh");
    await fs.mkdir(selected);
    await fs.mkdir(foreign, { recursive: true });
    const destination = path.join(selected, "result.bin");
    await fs.writeFile(path.join(foreign, "result.bin"), "foreign-business");
    const plan = await prepareOutput(destination);
    await assert.rejects(
      saveOutput(
        plan,
        Readable.from([Buffer.from("broker-result")]),
        new AbortController().signal,
        {
          audit: async (phase) => {
            if (phase !== "opened") return;
            await fs.rename(selected, parked);
            await fs.symlink(foreign, selected, "dir");
          },
        },
      ),
      { code: "FILE_OUTPUT" },
    );
    assert.equal(
      await fs.readFile(path.join(foreign, "result.bin"), "utf8"),
      "foreign-business",
    );
    assert.equal(
      await fs.readFile(path.join(parked, path.basename(plan.temp)), "utf8"),
      "",
    );
    await fs.unlink(selected);
    await fs.rename(parked, selected);
    await fs.rm(plan.temp);
    for (const existed of [false, true]) {
      if (existed) await fs.writeFile(destination, "old-business");
      const next = await prepareOutput(destination);
      await assert.rejects(
        saveOutput(
          next,
          Readable.from([Buffer.from("broker-result")]),
          new AbortController().signal,
          {
            audit: async (phase) => {
              if (phase === "written")
                await fs.writeFile(destination, "concurrent-user-edit");
            },
          },
        ),
        { code: "FILE_OUTPUT" },
      );
      assert.equal(
        await fs.readFile(destination, "utf8"),
        "concurrent-user-edit",
      );
      await assert.rejects(fs.stat(next.temp), { code: "ENOENT" });
      await fs.unlink(destination);
    }
  });
});

test("review output cancellation cleans only the pinned owned staging file", async () => {
  await temporary(async (root) => {
    const target = path.join(root, "business.bin");
    await fs.writeFile(target, "old-business");
    const plan = await prepareOutput(target),
      controller = new AbortController();
    await assert.rejects(
      saveOutput(
        plan,
        Readable.from([Buffer.from("result")]),
        controller.signal,
        {
          audit: (phase) => {
            if (phase === "opened") controller.abort();
          },
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(await fs.readFile(target, "utf8"), "old-business");
    await assert.rejects(fs.stat(plan.temp), { code: "ENOENT" });
    const replacement = await prepareOutput(target),
      parked = path.join(root, "owned-parked.part");
    await assert.rejects(
      saveOutput(
        replacement,
        Readable.from([Buffer.from("result")]),
        new AbortController().signal,
        {
          audit: async (phase) => {
            if (phase !== "written") return;
            await fs.rename(replacement.temp, parked);
            await fs.writeFile(replacement.temp, "foreign-part");
          },
        },
      ),
      { code: "FILE_OUTPUT" },
    );
    assert.equal(await fs.readFile(replacement.temp, "utf8"), "foreign-part");
    assert.equal(await fs.readFile(parked, "utf8"), "result");
    assert.equal(await fs.readFile(target, "utf8"), "old-business");
  });
});

test(
  "review actual PTY CLI init matches strict fields and resizes only after ready",
  { skip: process.platform === "win32", timeout: 15000 },
  async () => {
    const server = http.createServer(),
      sockets = new WebSocketServer({ server });
    let child: ReturnType<typeof spawn> | undefined;
    const frames: Record<string, unknown>[] = [],
      failures: unknown[] = [];
    sockets.on("connection", (socket, request) => {
      const invocationId = request.headers["x-abilock-invocation-id"],
        operationId = crypto.randomUUID();
      let sequence = 0;
      const send = (value: Record<string, unknown>) =>
        socket.send(
          JSON.stringify({
            ...value,
            invocationId,
            operationId,
            direction: "server",
            sequence: ++sequence,
          }),
        );
      socket.on("message", (bytes) => {
        try {
          const frame = JSON.parse(bytes.toString());
          frames.push(frame);
          if (frame.type === "init") {
            assert.deepEqual(Object.keys(frame).sort(), [
              "direction",
              "sequence",
              "trace",
              "type",
            ]);
            assert.equal(frame.sequence, 1);
            assert.equal(frame.trace.invocationId, invocationId);
            send({ type: "ready" });
          } else if (frame.type === "resize") {
            assert.equal(frames[0].type, "init");
            assert.equal(frame.sequence, 2);
            assert(
              Number.isInteger(frame.rows) && Number.isInteger(frame.cols),
            );
            send({
              type: "data",
              data: Buffer.from("strict-init-ready\n").toString("base64"),
            });
            send({ type: "exit", code: 7 });
          }
        } catch (error) {
          failures.push(error);
          socket.terminate();
        }
      });
    });
    const harness = `import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
status = None
try:
    while True:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        ended, value = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = value
            break
    if status is None: _, status = os.waitpid(pid, 0)
finally:
    os.close(fd)
    if status is None:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      child = spawn(
        "/usr/bin/python3",
        ["-c", harness, process.execPath, cli, "ssh", "REMOTE"],
        {
          env: {
            ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
            ABILOCK_EXEC_TOKEN: token,
          },
          cwd: os.tmpdir(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin!.end();
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (chunk) => (stdout += chunk));
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      });
      assert.deepEqual(failures, []);
      assert.equal(code, 7, stdout + stderr);
      assert.match(stdout, /strict-init-ready/);
      assert.equal(stderr, "");
      assert.deepEqual(
        frames.map((frame) => frame.type),
        ["init", "resize"],
      );
    } finally {
      child?.kill("SIGTERM");
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
