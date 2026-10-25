import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const cli = new URL("../bin/abl.mjs", import.meta.url).pathname;
const token = "synthetic-abilock-execution-only";
type RunResult = { code: number | null; stdout: string; stderr: string };
function clientTrace(stdout: string) {
  const value = JSON.parse(stdout);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(value.invocationId, uuid);
  assert.match(value.operationId, uuid);
  assert.notEqual(value.operationId, value.invocationId);
  assert.equal(value.operationIdSource, "client");
  return value;
}
function start(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
) {
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = new Promise<RunResult>((resolve, reject) => {
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
function run(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
) {
  return start(args, env, cwd, input).result;
}
type Seen = {
  method: string;
  route: string;
  body: unknown;
  authorization: string;
  invocationId: string;
};
type Reply = {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
};
async function fixture(
  action: (ctx: {
    dir: string;
    env: Record<string, string>;
    seen: Seen[];
    platform: (value: unknown) => void;
    reply: (value: ((request: Seen) => Reply | undefined) | undefined) => void;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-cli-"));
  const seen: Seen[] = [];
  let platform: unknown = {
    alias: "API_A",
    name: "synthetic API",
    enabled: true,
    rules: [{ method: "POST", path: "/chat/completions" }],
    chat: {
      method: "POST",
      path: "/chat/completions",
      model: "explicit-synthetic-model",
    },
  };
  let custom: ((request: Seen) => Reply | undefined) | undefined;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (value) => (raw += value));
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        route: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
        authorization: req.headers.authorization ?? "",
        invocationId: req.headers["x-abilock-invocation-id"] as string,
      };
      seen.push(request);
      const selected = custom?.(request);
      res.writeHead(selected?.status ?? 200, {
        "content-type": "application/json",
        "x-abilock-request-id": "new-request-id",
        "x-coi-request-id": "old-request-id",
        ...selected?.headers,
      });
      res.end(
        JSON.stringify(
          selected?.body ??
            (request.route === "/v2/discovery"
              ? { version: 1, revision: "fixture-catalog", capabilities: [] }
              : request.route === "/v1/platforms"
                ? { platforms: [{ alias: "API_A", name: "synthetic API" }] }
                : request.route === "/v1/context/API_A"
                  ? {
                      platform,
                      docs: [
                        {
                          title: "Synthetic API",
                          sourceUrl: "https://example.invalid/docs",
                          markdown:
                            "# Fixture business description\n\nBusiness data only.",
                        },
                      ],
                    }
                  : request.route === "/v2/context/ssh/SSH_A"
                    ? {
                        connection: {
                          alias: "SSH_A",
                          kind: "ssh",
                          name: "synthetic SSH",
                          config: { remoteRoot: "/owned", fileAccess: "read" },
                        },
                        documentation:
                          "# SSH protocol description\n\nOnly the configured target.",
                        docs: [],
                      }
                    : request.route.startsWith("/v2/run/")
                      ? { exitCode: 0, data: { operation: request.body } }
                      : { native: request.body }),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await action({
      dir,
      seen,
      env: {
        ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
        ABILOCK_EXEC_TOKEN: token,
      },
      platform: (value) => (platform = value),
      reply: (value) => (custom = value),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Abilock advertises only abl and removes old executable entry points", async () => {
  const result = await run(["--help"], {}, os.tmpdir());
  assert.equal(result.code, 0);
  for (const text of [
    "Abilock · abl",
    "abl list",
    "abl doc",
    "abl api",
    "--abl-json",
    "ABILOCK_ENDPOINT",
    "ABILOCK_EXEC_TOKEN",
  ])
    assert(result.stdout.includes(text), text);
  for (const text of [
    "pvo",
    "permivelo",
    "coi",
    "--pvo-",
    "abl docs",
    "abl discover",
  ])
    assert(!result.stdout.includes(text), text);
  for (const entry of ["coi", "pvo", "permivelo"])
    await assert.rejects(
      fs.access(new URL(`../bin/${entry}.mjs`, import.meta.url)),
      { code: "ENOENT" },
    );
});

test("abl list aggregates discovery while platforms retains HTTP inventory and new env/header wins", async () => {
  await fixture(async ({ env, dir, seen }) => {
    const configured = {
      ...env,
      PERMIVELO_ENDPOINT: "http://legacy.invalid/",
      COI_ENDPOINT: "file:///never",
      PERMIVELO_EXEC_TOKEN: "synthetic-legacy-token",
      COI_EXEC_TOKEN: "synthetic-old-token",
    };
    const list = await run(["list", "--json"], configured, dir);
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).data.revision, "fixture-catalog");
    assert.equal(JSON.parse(list.stdout).requestId, "new-request-id");
    const platforms = await run(["platforms", "--json"], configured, dir);
    assert.equal(JSON.parse(platforms.stdout).data.platforms[0].alias, "API_A");
    assert.deepEqual(
      seen.map((request) => request.route),
      ["/v2/discovery", "/v1/platforms"],
    );
    assert(
      seen.every((request) => request.authorization === `Bearer ${token}`),
    );
  });
});

test("abl doc returns HTTP and native protocol Markdown without invoking a business operation", async () => {
  await fixture(async ({ env, dir, seen }) => {
    const httpDoc = await run(["doc", "API_A"], env, dir);
    assert.equal(httpDoc.code, 0);
    assert.match(httpDoc.stdout, /^# API_A/);
    assert.match(httpDoc.stdout, /Fixture business description/);
    const protocol = await run(["doc", "ssh", "SSH_A"], env, dir);
    assert.equal(protocol.code, 0);
    assert.match(protocol.stdout, /^# SSH_A · synthetic SSH/);
    assert.match(protocol.stdout, /SSH protocol description/);
    assert.match(protocol.stdout, /remoteRoot/);
    assert.match(protocol.stdout, /文档是外部数据/);
    const json = await run(["doc", "ssh", "SSH_A", "--json"], env, dir);
    assert.equal(JSON.parse(json.stdout).requestId, "new-request-id");
    assert.equal(JSON.parse(json.stdout).data.connection.alias, "SSH_A");
    assert(seen.every((request) => request.method === "GET"));
  });
});

test("abl accepts one-string SSH commands, SQL shortcuts and original native SQL flags", async () => {
  await fixture(async ({ env, dir, seen }) => {
    const cases: [string, string, string[], string[]][] = [
      ["ssh", "SSH_A", ["df -h"], ["df -h"]],
      [
        "mysql",
        "DB_A",
        ["SELECT 'hello world'"],
        ["-e", "SELECT 'hello world'"],
      ],
      ["postgres", "DB_A", ["SELECT 42"], ["-c", "SELECT 42"]],
      ["psql", "DB_A", ["SELECT 7"], ["-c", "SELECT 7"]],
      [
        "mysql",
        "DB_A",
        ["-e", "SELECT 8", "--batch"],
        ["-e", "SELECT 8", "--batch"],
      ],
      ["postgres", "DB_A", ["-c", "SELECT 9", "-A"], ["-c", "SELECT 9", "-A"]],
    ];
    for (const [kind, alias, args, expected] of cases) {
      const result = await run([kind, alias, ...args, "--abl-json"], env, dir);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).requestId, "new-request-id");
      assert.deepEqual(
        JSON.parse(result.stdout).data.data.operation.args,
        expected,
      );
    }
    assert(seen.every((request) => request.route.startsWith("/v2/run/")));
  });
});

test("abl input and JSON flags preserve explicit file/stdin paths and accept old flags for migration", async () => {
  await fixture(async ({ env, dir }) => {
    const file = path.join(dir, "selected-script.sql");
    await fs.writeFile(file, "SELECT 10");
    for (const flag of ["--abl-input", "--pvo-input"]) {
      const result = await run(
        ["postgres", "DB_A", flag, file, "--abl-json"],
        env,
        dir,
      );
      assert.equal(result.code, 0);
      assert.equal(
        JSON.parse(result.stdout).data.data.operation.input,
        "SELECT 10",
      );
    }
    const stdin = await run(
      ["postgres", "DB_A", "--abl-stdin", "--abl-json"],
      env,
      dir,
      "SELECT 11",
    );
    assert.equal(
      JSON.parse(stdin.stdout).data.data.operation.input,
      "SELECT 11",
    );
    const legacy = await run(
      ["redis", "CACHE_A", "GET", "owned:key", "--pvo-json"],
      env,
      dir,
    );
    assert.equal(legacy.code, 0);
    assert.deepEqual(JSON.parse(legacy.stdout).data.data.operation.args, [
      "GET",
      "owned:key",
    ]);
  });
});

test("abl api chat uses only configured allowed POST path and explicit model", async () => {
  await fixture(async ({ env, dir, seen }) => {
    const result = await run(
      ["api", "API_A", "chat", "你好；$(never execute)", "--json"],
      env,
      dir,
    );
    assert.equal(result.code, 0);
    const expected = {
      method: "POST",
      path: "/chat/completions",
      body: {
        model: "explicit-synthetic-model",
        messages: [{ role: "user", content: "你好；$(never execute)" }],
      },
    };
    const value = clientTrace(result.stdout);
    const framed = { ...expected, trace: { invocationId: value.invocationId } };
    assert.deepEqual(value.data.native, framed);
    assert.deepEqual(
      seen.map((request) => [request.method, request.route]),
      [
        ["GET", "/v1/context/API_A"],
        ["POST", "/v1/call/API_A"],
      ],
    );
    assert.deepEqual(seen[1].body, framed);
    assert.equal(seen[0].invocationId, value.invocationId);
    assert.equal(seen[1].invocationId, value.invocationId);
    assert(!result.stdout.includes(token));
  });
});

test("abl api chat rejects absent, disabled, unsafe and out-of-scope metadata without guessing from documents", async () => {
  await fixture(async ({ env, dir, seen, platform }) => {
    const base = {
      alias: "API_A",
      enabled: true,
      rules: [{ method: "POST", path: "/chat/completions" }],
    };
    for (const value of [
      base,
      { ...base, chat: { method: "POST", path: "/chat/completions" } },
      {
        ...base,
        chat: { method: "GET", path: "/chat/completions", model: "fixed" },
      },
      { ...base, chat: { method: "POST", path: "/other", model: "fixed" } },
      {
        ...base,
        rules: [{ method: "POST", path: "/chat/*" }],
        chat: { method: "POST", path: "/chat/completions", model: "fixed" },
      },
      {
        ...base,
        chat: {
          method: "POST",
          path: "/chat/completions",
          model: "x".repeat(257),
        },
      },
      {
        ...base,
        chat: {
          method: "POST",
          path: "https://outside.invalid/",
          model: "fixed",
        },
      },
      {
        ...base,
        chat: { method: "POST", path: "/chat/../completions", model: "fixed" },
      },
      {
        ...base,
        chat: { method: "POST", path: "/chat/%2fcompletions", model: "fixed" },
      },
      {
        ...base,
        enabled: false,
        chat: { method: "POST", path: "/chat/completions", model: "fixed" },
      },
    ]) {
      platform(value);
      const result = await run(
        ["api", "API_A", "chat", "hello", "--json"],
        env,
        dir,
      );
      assert.equal(result.code, 2);
      assert.equal(JSON.parse(result.stdout).error.code, "CONFIG_REQUIRED");
      assert(!result.stdout.includes("fixed"));
    }
    assert.equal(seen.length, 10);
    assert(
      seen.every(
        (request) =>
          request.method === "GET" && request.route === "/v1/context/API_A",
      ),
    );
    for (const flags of [
      ["--model", "guess"],
      ["--file", "secret.json"],
      ["--password", "synthetic-password"],
      ["--json", "--json"],
    ]) {
      const result = await run(
        ["api", "API_A", "chat", "hello", ...flags],
        env,
        dir,
      );
      assert.equal(result.code, 2);
    }
    assert.equal(seen.length, 10);
  });
});

test("abl api chat context redirects never reach another route and new response-kind preserves upstream exit code", async () => {
  await fixture(async ({ env, dir, seen, reply }) => {
    reply((request) =>
      request.method === "GET"
        ? { status: 302, headers: { location: "/another-route" }, body: {} }
        : undefined,
    );
    const redirect = await run(
      ["api", "API_A", "chat", "hello", "--json"],
      env,
      dir,
    );
    assert.equal(redirect.code, 3);
    assert.equal(JSON.parse(redirect.stdout).error.code, "CONNECTION");
    assert.equal(seen.length, 1);
    reply(() => ({
      status: 500,
      headers: {
        "x-abilock-response-kind": "upstream",
        "x-coi-response-kind": "service",
      },
      body: { error: "synthetic-upstream-error" },
    }));
    const upstream = await run(
      ["api", "API_A", "--stdin", "--json"],
      env,
      dir,
      JSON.stringify({
        method: "POST",
        path: "/chat/completions",
        body: { data: "owned" },
      }),
    );
    assert.equal(upstream.code, 4);
    assert.equal(JSON.parse(upstream.stdout).requestId, "new-request-id");
  });
});

const binaryPrefix = Buffer.from([0, 1, 255, 128]);
const binaryTail = Buffer.from([13, 10, 42, 0]);
const outputRequest = JSON.stringify({ method: "GET", path: "/binary" });
async function binaryFixture(
  action: (ctx: {
    dir: string;
    env: Record<string, string>;
    seen: string[];
    response: Promise<http.ServerResponse>;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-output-cli-"));
  const seen: string[] = [];
  let ready!: (value: http.ServerResponse) => void;
  const response = new Promise<http.ServerResponse>(
    (resolve) => (ready = resolve),
  );
  const server = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(binaryPrefix);
      ready(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await action({
      dir,
      seen,
      response,
      env: {
        ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
        ABILOCK_EXEC_TOKEN: token,
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function outputPart(directory: string, minimumBytes = 0) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const entry = (await fs.readdir(directory)).find((name) =>
      name.endsWith(".part"),
    );
    if (entry) {
      const file = path.join(directory, entry);
      if ((await fs.stat(file)).size >= minimumBytes) return file;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("owned output part was not created");
}
const outputArgs = (destination: string) => [
  "api",
  "API_A",
  "--stdin",
  "--output",
  destination,
];

test("HTTP output rejects default credential directory and symlink paths before any upstream request", async () => {
  await binaryFixture(async ({ env, dir, seen }) => {
    const protectedDir = path.join(dir, "synthetic-home", ".abilock");
    await fs.mkdir(protectedDir, { recursive: true });
    const protectedFile = path.join(protectedDir, "state.json");
    await fs.writeFile(protectedFile, "synthetic-owned-state");
    const regular = path.join(dir, "regular.bin");
    await fs.writeFile(regular, "synthetic-business-file");
    const leafLink = path.join(dir, "leaf-link.bin");
    await fs.symlink(regular, leafLink);
    const targetDir = path.join(dir, "real-directory");
    await fs.mkdir(targetDir);
    const parentLink = path.join(dir, "parent-link");
    await fs.symlink(targetDir, parentLink);
    for (const destination of [
      protectedFile,
      leafLink,
      path.join(parentLink, "result.bin"),
    ]) {
      const result = await run(
        outputArgs(destination),
        env,
        dir,
        outputRequest,
      );
      assert.equal(result.code, 2);
      assert.match(result.stderr, /FILE_OUTPUT/);
    }
    assert.equal(seen.length, 0);
    assert.equal(
      await fs.readFile(protectedFile, "utf8"),
      "synthetic-owned-state",
    );
    assert.equal(await fs.readFile(regular, "utf8"), "synthetic-business-file");
    assert.deepEqual(await fs.readdir(targetDir), []);
  });
});

test("HTTP output saves exact binary bytes to a new or unchanged ordinary file and cleans its part", async () => {
  for (const existing of [false, true])
    await binaryFixture(async ({ env, dir, response, seen }) => {
      const destination = path.join(dir, "business-result.bin");
      if (existing) await fs.writeFile(destination, "previous-business-result");
      const running = start(outputArgs(destination), env, dir, outputRequest);
      (await response).end(binaryTail);
      const result = await running.result;
      assert.equal(result.code, 0);
      assert.deepEqual(
        await fs.readFile(destination),
        Buffer.concat([binaryPrefix, binaryTail]),
      );
      assert(!result.stdout.includes(token));
      assert.equal(result.stdout, "");
      assert.deepEqual(seen, ["/v1/call/API_A"]);
      assert.deepEqual(await fs.readdir(dir), ["business-result.bin"]);
    });
});

test("HTTP output never overwrites an existing leaf changed or a new leaf created during streaming", async () => {
  for (const existing of [false, true])
    await binaryFixture(async ({ env, dir, response }) => {
      const destination = path.join(dir, "business-result.bin");
      if (existing) await fs.writeFile(destination, "initial-business-result");
      const running = start(outputArgs(destination), env, dir, outputRequest);
      const res = await response;
      await outputPart(dir);
      await fs.writeFile(destination, "foreign-business-result-keep");
      res.end(binaryTail);
      const result = await running.result;
      assert.equal(result.code, 3);
      assert.match(result.stderr, /FILE_OUTPUT/);
      assert.equal(
        await fs.readFile(destination, "utf8"),
        "foreign-business-result-keep",
      );
      assert.deepEqual(await fs.readdir(dir), ["business-result.bin"]);
    });
});

test("HTTP output refuses an ancestor replaced by a link during streaming", async () => {
  await binaryFixture(async ({ env, dir, response }) => {
    const selected = path.join(dir, "selected");
    const moved = path.join(dir, "selected-moved");
    const foreign = path.join(dir, "foreign");
    await fs.mkdir(selected);
    await fs.mkdir(foreign);
    const destination = path.join(selected, "result.bin");
    await fs.writeFile(destination, "initial-business-result");
    const running = start(outputArgs(destination), env, dir, outputRequest);
    const res = await response;
    await outputPart(selected);
    await fs.rename(selected, moved);
    await fs.symlink(foreign, selected);
    res.end(binaryTail);
    const result = await running.result;
    assert.equal(result.code, 3);
    assert.match(result.stderr, /FILE_OUTPUT/);
    assert.deepEqual(await fs.readdir(foreign), []);
    assert.equal(
      await fs.readFile(path.join(moved, "result.bin"), "utf8"),
      "initial-business-result",
    );
  });
});

test("HTTP cancellation preserves the old destination and removes only its owned part", async () => {
  await binaryFixture(async ({ env, dir, response, seen }) => {
    const destination = path.join(dir, "business-result.bin");
    await fs.writeFile(destination, "initial-business-result");
    const running = start(outputArgs(destination), env, dir, outputRequest);
    await response;
    await outputPart(dir);
    running.child.kill("SIGINT");
    const result = await running.result;
    assert.equal(result.code, 130);
    assert.match(result.stderr, /CANCELLED/);
    assert.equal(
      await fs.readFile(destination, "utf8"),
      "initial-business-result",
    );
    assert.deepEqual(await fs.readdir(dir), ["business-result.bin"]);
    assert.equal(seen.length, 1);
  });
});

test("HTTP cancellation never deletes a foreign replacement of its owned part", async () => {
  await binaryFixture(async ({ env, dir, response }) => {
    const destination = path.join(dir, "business-result.bin");
    await fs.writeFile(destination, "initial-business-result");
    const running = start(outputArgs(destination), env, dir, outputRequest);
    await response;
    // Wait for the writer to start; mere creation races the initial identity
    // check and tests a different failure (FILE_OUTPUT) before cancellation.
    const part = await outputPart(dir, binaryPrefix.length);
    await fs.rename(part, path.join(dir, "moved-owned-part"));
    await fs.writeFile(part, "foreign-staging-replacement-keep");
    running.child.kill("SIGINT");
    const result = await running.result;
    assert.equal(result.code, 130);
    assert.equal(
      await fs.readFile(part, "utf8"),
      "foreign-staging-replacement-keep",
    );
    assert.equal(
      await fs.readFile(destination, "utf8"),
      "initial-business-result",
    );
  });
});
