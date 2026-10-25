import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const entry = (name = "abl") =>
  new URL(`../bin/${name}.mjs`, import.meta.url).pathname;
const token = "synthetic-execution-only-capability";
function run(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
  name = "abl",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [entry(name), ...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}
async function fixture<T>(
  action: (
    env: Record<string, string>,
    dir: string,
    seen: { route: string; input: unknown }[],
    setReply: (reply: unknown, status?: number) => void,
  ) => Promise<T>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-cli-"));
  const seen: { route: string; input: unknown }[] = [];
  let reply: unknown = { exitCode: 0, stdout: "fixture result\n" },
    status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", () => {
      let input: unknown;
      if (raw) {
        const framed = JSON.parse(raw) as Record<string, unknown>;
        const trace = framed.trace as { invocationId: string };
        assert.match(trace.invocationId, /^[0-9a-f-]{36}$/i);
        assert.equal(
          trace.invocationId,
          req.headers["x-abilock-invocation-id"],
        );
        const business = { ...framed };
        delete business.trace;
        input = business;
      }
      seen.push({
        route: req.url ?? "",
        input,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/v2/connections"
            ? {
                connections: [
                  {
                    alias: "SSH_A",
                    kind: "ssh",
                    name: "fixture",
                    enabled: true,
                  },
                ],
              }
            : req.url?.startsWith("/v2/context/")
              ? {
                  connection: { alias: "SSH_A" },
                  documentation: "原生参数边界",
                  capabilities: ["commands"],
                }
              : req.url === "/v1/call/ds"
                ? { native: input }
                : reply,
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const env = {
    ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
    ABILOCK_EXEC_TOKEN: token,
  };
  try {
    return await action(env, dir, seen, (value, code = 200) => {
      reply = value;
      status = code;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("abl branding and API alias preserves native JSON", async () => {
  for (const command of ["abl"]) {
    const help = await run(["--help"], {}, os.tmpdir(), "", command);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Abilock/);
    assert.match(help.stdout, /吉豆茄 jidouqie/);
    assert.match(help.stdout, /abl ssh/);
  }
  await fixture(async (env, dir, seen) => {
    const input = {
      method: "POST",
      path: "/chat/completions",
      body: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "你好 $()" }],
      },
    };
    const result = await run(
      ["api", "ds", "--stdin", "--json"],
      env,
      dir,
      JSON.stringify(input),
    );
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).data, { native: input });
    assert.deepEqual(seen, [{ route: "/v1/call/ds", input }]);
    assert(!result.stdout.includes(token));
  });
});

test("native protocol selectors and argv are structured without local subprocesses", async () => {
  await fixture(async (env, dir, seen) => {
    const cases: [string, string, string[]][] = [
      ["ssh", "ssh", ["printf", "%s", "hello world"]],
      ["postgres", "postgres", ["-c", "SELECT 'hello world'", "-A"]],
      ["psql", "postgres", ["-c", "SELECT 1"]],
      ["mysql", "mysql", ["-e", "SELECT 1"]],
      ["redis", "redis", ["SET", "greeting", "hello world"]],
      ["git", "git", ["clone", "--depth", "1"]],
      ["s3", "s3", ["ls", "--prefix", "workspace/"]],
      ["aws", "aws", ["sts", "get-caller-identity"]],
      ["docker", "docker", ["ps", "-a"]],
      ["kubectl", "kubernetes", ["get", "pods", "-o", "json"]],
    ];
    for (const [command, kind, args] of cases) {
      const r = await run([command, "SSH_A", "--abl-json", ...args], env, dir);
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).data.stdout, "fixture result\n");
      assert.deepEqual(seen.at(-1), {
        route: `/v2/run/${kind}/SSH_A`,
        input: { args },
      });
      assert(!r.stdout.includes(token));
    }
    const contexts = await run(["docs", "ssh", "10.0.0.1", "--json"], env, dir);
    assert.equal(contexts.code, 0);
    assert.equal(seen.at(-1)?.route, "/v2/context/ssh/10.0.0.1");
    const list = await run(["connections", "--json"], env, dir);
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).data.connections[0].alias, "SSH_A");
    const operation = {
      args: ["-c", "SELECT $1"],
      input: "SELECT 2",
      timeoutMs: 2000,
    };
    const json = await run(
      ["postgres", "SSH_A", "--request-stdin", "--json"],
      env,
      dir,
      JSON.stringify(operation),
    );
    assert.equal(json.code, 0);
    assert.deepEqual(seen.at(-1)?.input, operation);
  });
});

test("credentials, target URLs, malformed envelopes and non-TTY SSH fail before request", async () => {
  await fixture(async (env, dir, seen) => {
    const password = "synthetic-upstream-secret-never-output";
    for (const args of [
      ["mysql", "SSH_A", "--password", password, "--abl-json"],
      ["aws", "SSH_A", "--secret-access-key", password, "--abl-json"],
      ["kubectl", "SSH_A", "--token", password, "--abl-json"],
      ["redis", "SSH_A", "-a", password, "--abl-json"],
      ["ssh", `root:${password}@10.0.0.1`, "uname", "--abl-json"],
    ]) {
      const r = await run(args, env, dir);
      assert.equal(r.code, 2);
      assert(!r.stdout.includes(password));
      assert(!r.stderr.includes(password));
    }
    for (const value of [
      { args: [], secret: password },
      { args: "bad" },
      { args: [], files: [{ path: "../escape", base64: "YQ==" }] },
      { args: [], timeoutMs: 1 },
    ]) {
      const r = await run(
        ["ssh", "SSH_A", "--request-stdin", "--json"],
        env,
        dir,
        JSON.stringify(value),
      );
      assert.equal(r.code, 2);
      assert(!r.stdout.includes(password));
    }
    const tty = await run(["ssh", "SSH_A"], env, dir);
    assert.equal(tty.code, 2);
    assert.match(tty.stderr, /TTY_REQUIRED/);
    const bad = await run(
      ["redis", "SSH_A", "PING", "--abl-json"],
      { ...env, ABILOCK_ENDPOINT: `https://user:${password}@example.com/` },
      dir,
    );
    assert.equal(bad.code, 2);
    assert(!bad.stdout.includes(password));
    assert.equal(seen.length, 0);
  });
});

test("explicit transfer manifests, native input, atomic downloads and traversal/symlink denial", async () => {
  await fixture(async (env, dir, seen, setReply) => {
    const source = path.join(dir, "input.txt");
    await fs.writeFile(source, "business file $()\n");
    const put = await run(
      ["sftp", "SSH_A", "put", source, "/srv/input.txt", "--abl-json"],
      env,
      dir,
    );
    assert.equal(put.code, 0);
    assert.deepEqual(seen.at(-1)?.input, {
      args: ["sftp", "put", "input.txt", "/srv/input.txt"],
      files: [
        {
          path: "input.txt",
          base64: Buffer.from("business file $()\n").toString("base64"),
        },
      ],
    });
    const s3 = await run(
      [
        "s3",
        "SSH_A",
        "put-object",
        "--key",
        "workspace/input.txt",
        "--body",
        source,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(s3.code, 0);
    assert.deepEqual((seen.at(-1)?.input as { args: string[] }).args, [
      "put-object",
      "--key",
      "workspace/input.txt",
      "--body",
      "input.txt",
    ]);
    const input = await run(
      ["psql", "SSH_A", "-f", source, "--abl-json"],
      env,
      dir,
    );
    assert.equal(input.code, 0);
    assert.deepEqual(seen.at(-1)?.input, {
      args: ["-f", "-"],
      input: "business file $()\n",
    });
    const out = path.join(dir, "received.bin");
    setReply({
      exitCode: 0,
      files: [
        {
          path: "received.bin",
          base64: Buffer.from([0, 255, 10]).toString("base64"),
        },
      ],
    });
    const get = await run(
      ["sftp", "SSH_A", "get", "/srv/file", out, "--abl-json"],
      env,
      dir,
    );
    assert.equal(get.code, 0);
    assert.deepEqual(await fs.readFile(out), Buffer.from([0, 255, 10]));
    setReply({ exitCode: 0, files: [{ path: "../escape", base64: "YQ==" }] });
    const traversal = await run(
      ["sftp", "SSH_A", "get", "/srv/file", out, "--abl-json"],
      env,
      dir,
    );
    assert.equal(traversal.code, 3);
    assert.equal(JSON.parse(traversal.stdout).error.code, "FILE_OUTPUT");
    setReply({
      exitCode: 0,
      files: [{ path: "received.bin", base64: "YQ==" }],
    });
    const link = path.join(dir, "symlink");
    await fs.symlink(out, link);
    const symlink = await run(
      ["sftp", "SSH_A", "get", "/srv/file", link, "--abl-json"],
      env,
      dir,
    );
    assert.equal(symlink.code, 3);
    assert.deepEqual(await fs.readFile(out), Buffer.from([0, 255, 10]));
    const count = seen.length;
    const uplink = await run(
      ["sftp", "SSH_A", "put", link, "/srv/file", "--abl-json"],
      env,
      dir,
    );
    assert.equal(uplink.code, 2);
    assert.equal(seen.length, count);
  });
});

test("upstream exit and service errors have stable distinct client exit codes", async () => {
  await fixture(async (env, dir, _seen, setReply) => {
    setReply({ exitCode: 7, stdout: "", stderr: "remote failed" });
    const failed = await run(
      ["redis", "SSH_A", "PING", "--abl-json"],
      env,
      dir,
    );
    assert.equal(failed.code, 4);
    assert.equal(JSON.parse(failed.stdout).ok, false);
    setReply({ error: { code: "POLICY", message: "operation denied" } }, 403);
    const denied = await run(["git", "SSH_A", "push", "--abl-json"], env, dir);
    assert.equal(denied.code, 3);
    assert.equal(JSON.parse(denied.stdout).error.code, "POLICY");
  });
});

test("CLI worktree contract uses mock broker tracked manifests, refuses local edits and tracks safe deletions", async () => {
  await fixture(async (env, dir, seen, setReply) => {
    const repoId = "a".repeat(32),
      destination = path.join(dir, "checkout");
    const manifest = (text: string, extra = true) => ({
      exitCode: 0,
      data: { repoId, filesAreFullManifest: true },
      files: [
        { path: "note.txt", base64: Buffer.from(text).toString("base64") },
        ...(extra ? [{ path: "old.txt", base64: "b2xk" }] : []),
      ],
    });
    setReply(manifest("initial"));
    const cloned = await run(
      ["git", "GIT", "clone", destination, "--abl-json"],
      env,
      dir,
    );
    assert.equal(cloned.code, 0);
    assert.deepEqual(seen.at(-1)?.input, { args: ["clone"] });
    assert.equal(
      await fs.readFile(path.join(destination, "note.txt"), "utf8"),
      "initial",
    );
    const marker = JSON.parse(
      await fs.readFile(
        path.join(destination, ".abilock-worktree.json"),
        "utf8",
      ),
    );
    assert.equal(marker.repoId, repoId);
    assert(!JSON.stringify(marker).includes(token));
    await fs.writeFile(path.join(destination, "note.txt"), "local change");
    setReply(manifest("upstream", false));
    const dirty = await run(
      [
        "git",
        "GIT",
        "pull",
        repoId,
        "--abl-directory",
        destination,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(dirty.code, 3);
    assert.equal(
      await fs.readFile(path.join(destination, "note.txt"), "utf8"),
      "local change",
    );
    await fs.writeFile(path.join(destination, "note.txt"), "initial");
    await fs.writeFile(path.join(destination, "untouched.txt"), "untracked");
    const pulled = await run(
      [
        "git",
        "GIT",
        "pull",
        repoId,
        "--abl-directory",
        destination,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(pulled.code, 0);
    assert.equal(
      await fs.readFile(path.join(destination, "note.txt"), "utf8"),
      "upstream",
    );
    await assert.rejects(fs.stat(path.join(destination, "old.txt")));
    assert.equal(
      await fs.readFile(path.join(destination, "untouched.txt"), "utf8"),
      "untracked",
    );
    const count = seen.length;
    const exists = await run(
      ["git", "GIT", "clone", destination, "--abl-json"],
      env,
      dir,
    );
    assert.equal(exists.code, 2);
    assert.equal(seen.length, count);
    await fs.unlink(path.join(destination, "untouched.txt"));
    await fs.writeFile(path.join(destination, "note.txt"), "committed");
    setReply(manifest("committed", false));
    const committed = await run(
      [
        "git",
        "GIT",
        "commit",
        repoId,
        "-m",
        "business edit",
        "--abl-directory",
        destination,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(committed.code, 0);
    const upload = seen.at(-1)?.input as {
      files: { path: string; base64: string }[];
    };
    assert.deepEqual(
      upload.files.map((file) => file.path),
      ["note.txt"],
    );
    setReply(manifest("committed", false));
    const afterCommit = await run(
      [
        "git",
        "GIT",
        "pull",
        repoId,
        "--abl-directory",
        destination,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(afterCommit.code, 0);
  });
});

test("SSH pipe input/native exit, Redis binary RESP input and rsync excludes stay structured", async () => {
  await fixture(async (env, dir, seen, setReply) => {
    const text = "hello from a pipe\n";
    const ssh = await run(
      ["ssh", "SSH_A", "cat", "--abl-json"],
      env,
      dir,
      text,
    );
    assert.equal(ssh.code, 0);
    assert.deepEqual(seen.at(-1)?.input, { args: ["cat"], input: text });
    setReply({ exitCode: 7, stderr: "native SSH exit" });
    const exit = await run(
      ["ssh", "SSH_A", "exit", "7", "--abl-json"],
      env,
      dir,
    );
    assert.equal(exit.code, 7);
    setReply({ exitCode: 0 });
    const binary = path.join(dir, "binary.bin");
    const bytes = Buffer.from([0, 255, 13, 10]);
    await fs.writeFile(binary, bytes);
    const redis = await run(
      [
        "redis",
        "CACHE",
        "-x",
        "SET",
        "binary",
        "--abl-input",
        binary,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(redis.code, 0);
    assert.deepEqual(seen.at(-1)?.input, {
      args: ["-x", "SET", "binary"],
      files: [{ path: "-", base64: bytes.toString("base64") }],
    });
    const resp = "*1\r\n$4\r\nPING\r\n";
    const pipe = await run(
      ["redis", "CACHE", "--pipe", "--abl-json"],
      env,
      dir,
      resp,
    );
    assert.equal(pipe.code, 0);
    assert.deepEqual(seen.at(-1)?.input, {
      args: ["--pipe"],
      files: [{ path: "-", base64: Buffer.from(resp).toString("base64") }],
    });
    const source = path.join(dir, "folder");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "a.txt"), "a");
    await fs.writeFile(path.join(source, "skip.log"), "excluded");
    await fs.writeFile(path.join(source, ".env"), "synthetic-test-only-secret");
    const sync = await run(
      [
        "rsync",
        "SSH_A",
        "--exclude",
        "*.log",
        "--exclude=.env",
        source,
        ":/srv/files",
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(sync.code, 0);
    assert.deepEqual((seen.at(-1)?.input as { args: string[] }).args, [
      "rsync",
      "--exclude",
      "*.log",
      "--exclude=.env",
      "folder",
      ":/srv/files",
    ]);
    assert.deepEqual(
      (seen.at(-1)?.input as { files: { path: string }[] }).files.map(
        (file) => file.path,
      ),
      ["a.txt"],
    );
    const cp = await run(
      ["s3", "BUCKET", "cp", binary, "s3://fixed-bucket/item", "--abl-json"],
      env,
      dir,
    );
    assert.equal(cp.code, 0);
    assert.deepEqual((seen.at(-1)?.input as { args: string[] }).args, [
      "cp",
      "binary.bin",
      "s3://fixed-bucket/item",
    ]);
    setReply({
      exitCode: 0,
      files: [{ path: "got.bin", base64: bytes.toString("base64") }],
    });
    const got = path.join(dir, "got.bin");
    const download = await run(
      ["s3", "BUCKET", "cp", "s3://fixed-bucket/item", got, "--abl-json"],
      env,
      dir,
    );
    assert.equal(download.code, 0);
    assert.deepEqual(await fs.readFile(got), bytes);
  });
});

test(
  "interactive SSH client uses a real isolated PTY and WebSocket ready/resize/data/exit frames",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const frames: {
      type: string;
      data?: string;
      rows?: number;
      cols?: number;
    }[] = [];
    let child: ReturnType<typeof spawn> | undefined,
      stdout = "",
      stderr = "",
      input = "";
    wss.on("connection", (socket, request) => {
      assert.equal(request.url, "/v2/terminal/ssh/SSH_A");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const invocationId = request.headers["x-abilock-invocation-id"];
      const operationId = randomUUID(),
        requestId = randomUUID();
      let sequence = 0;
      const send = (frame: Record<string, unknown>) =>
        socket.send(
          JSON.stringify({
            ...frame,
            invocationId,
            operationId,
            requestId,
            operationIdSource: "server",
            direction: "server",
            sequence: ++sequence,
          }),
        );
      send({ type: "ready" });
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        frames.push(frame);
        if (frame.type === "resize") {
          send({
            type: "data",
            data: Buffer.from("fixture-ready\n").toString("base64"),
          });
          child?.stdin?.write("client-data\n");
        }
        if (frame.type === "data") {
          input += Buffer.from(frame.data, "base64").toString();
          if (input.includes("client-data")) send({ type: "exit", code: 7 });
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
      const ptyHarness = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
inputs = [fd, 0]
status = None
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
os.close(fd)
if status is None:
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
      child = spawn(
        "/usr/bin/python3",
        ["-c", ptyHarness, process.execPath, entry(), "ssh", "SSH_A"],
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
        child?.once("error", reject);
        child?.once("close", resolve);
      });
      assert.equal(code, 7, stdout + stderr);
      assert.equal(stderr, "");
      assert.match(stdout, /fixture-ready/);
      assert(!stdout.includes(token));
      assert(
        frames.some(
          (frame) =>
            frame.type === "resize" &&
            Number.isInteger(frame.rows) &&
            Number.isInteger(frame.cols),
        ),
      );
      assert.match(input, /client-data/);
    } finally {
      child?.kill();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "cancelled CLI HTTP operation aborts once with exit 130 and never retries",
  { timeout: 10000 },
  async () => {
    let requests = 0;
    let notify: () => void = () => {};
    const received = new Promise<void>((resolve) => (notify = resolve));
    const server = http.createServer(() => {
      requests++;
      notify();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const child = spawn(
      process.execPath,
      [entry(), "ssh", "SSH_A", "sleep", "60", "--abl-json"],
      {
        env: {
          ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
          ABILOCK_EXEC_TOKEN: token,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    let stdout = "";
    child.stdout.on("data", (bytes) => (stdout += bytes));
    try {
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await received;
      child.kill("SIGINT");
      assert.equal(await closed, 130);
      assert.equal(JSON.parse(stdout).error.code, "CANCELLED");
      assert.equal(requests, 1);
    } finally {
      child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("Registry manifest/blob client uses explicit upload files and safe local output", async () => {
  await fixture(async (env, dir, seen, setReply) => {
    const source = path.join(dir, "manifest.json");
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    });
    await fs.writeFile(source, body);
    const put = await run(
      [
        "registry",
        "REGISTRY",
        "manifest",
        "put",
        "team/app",
        "latest",
        "--body",
        source,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(put.code, 0);
    assert.deepEqual(seen.at(-1), {
      route: "/v2/run/registry/REGISTRY",
      input: {
        args: [
          "manifest",
          "put",
          "team/app",
          "latest",
          "--body",
          "manifest.json",
        ],
        files: [
          {
            path: "manifest.json",
            base64: Buffer.from(body).toString("base64"),
          },
        ],
      },
    });
    const output = path.join(dir, "layer.bin"),
      bytes = Buffer.from([0, 255, 42]);
    setReply({
      exitCode: 0,
      files: [{ path: "layer.bin", base64: bytes.toString("base64") }],
    });
    const get = await run(
      [
        "registry",
        "REGISTRY",
        "blob",
        "get",
        "team/app",
        `sha256:${"0".repeat(64)}`,
        output,
        "--abl-json",
      ],
      env,
      dir,
    );
    assert.equal(get.code, 0);
    assert.deepEqual(await fs.readFile(output), bytes);
    assert.equal(
      (seen.at(-1)?.input as { args: string[] }).args.at(-1),
      "layer.bin",
    );
  });
});
