import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { gitAdapter } from "../src/protocols/git.js";
import { acquireProcessLock } from "../src/process-lock.js";
import type {
  AdapterContext,
  Connection,
  Operation,
} from "../src/connections.js";
const { Server, utils } = ssh2;

const cleanEnvironment = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  HOME: "/nonexistent",
  LANG: "C",
};
async function command(binary: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: cleanEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code
        ? reject(new Error(`Fixture command failed (${code}): ${stderr}`))
        : resolve(stdout),
    );
  });
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-git-test-"));
  await command("/usr/bin/git", ["init", "-b", "main", "source"], root);
  const source = path.join(root, "source"),
    bare = path.join(root, "remote.git");
  await fs.writeFile(
    path.join(source, "README.md"),
    "Real Git wire protocol fixture\n",
  );
  await command("/usr/bin/git", ["add", "README.md"], source);
  await command(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "commit",
      "-m",
      "initial",
    ],
    source,
  );
  await command("/usr/bin/git", ["clone", "--bare", source, bare], root);
  await command("/usr/bin/git", ["config", "http.receivepack", "true"], bare);
  const dataDir = path.join(root, "broker");
  await fs.mkdir(dataDir, { mode: 0o700 });
  return {
    root,
    source,
    bare,
    dataDir,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}
function connection(config: Record<string, unknown>): Connection {
  return {
    alias: "GIT",
    name: "Synthetic Git fixture",
    kind: "git",
    enabled: true,
    description: "",
    trustBoundary: "development-fixture",
    config,
  };
}
function context(
  conn: Connection,
  secret: Record<string, string>,
  dataDir: string,
): AdapterContext {
  return {
    connection: conn,
    secret,
    allowLocal: true,
    dataDir,
    signal: AbortSignal.timeout(25000),
  };
}
function operation(
  args: string[],
  files?: Operation["files"],
  deletions?: Operation["deletions"],
): Operation {
  return { args, files, deletions, timeoutMs: 25000 };
}
async function workflow(ctx: AdapterContext, bare: string, source: string) {
  const clone = await gitAdapter.run(
    ctx,
    operation(["clone", "--branch", "main", "--depth=1"]),
  );
  assert.equal(clone.exitCode, 0, clone.stderr);
  const repoId = (clone.data as { repoId: string }).repoId;
  assert.match(repoId, /^[a-f0-9]{32}$/);
  const heldLock = await acquireProcessLock(
    path.join(
      ctx.dataDir,
      "git-repositories",
      ctx.connection.alias,
      `${repoId}.lock`,
    ),
  );
  try {
    await assert.rejects(gitAdapter.run(ctx, operation(["status", repoId])), {
      code: "GIT_BUSY",
    });
  } finally {
    await heldLock.release();
  }
  assert.equal(
    Buffer.from(
      clone.files!.find((file) => file.path === "README.md")!.base64,
      "base64",
    ).toString(),
    "Real Git wire protocol fixture\n",
  );
  for (const file of clone.files!) {
    const text = Buffer.from(file.base64, "base64").toString();
    for (const secret of Object.values(ctx.secret))
      assert.ok(!text.includes(secret));
    if (ctx.secret.username && ctx.secret.password)
      assert.ok(
        !text.includes(
          Buffer.from(`${ctx.secret.username}:${ctx.secret.password}`).toString(
            "base64",
          ),
        ),
      );
  }
  await fs.writeFile(path.join(source, "upstream.txt"), "upstream changed\n");
  await command("/usr/bin/git", ["add", "upstream.txt"], source);
  await command(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "commit",
      "-m",
      "upstream",
    ],
    source,
  );
  await command("/usr/bin/git", ["push", bare, "main"], source);
  const fetched = await gitAdapter.run(
    ctx,
    operation(["fetch", repoId, "--prune"]),
  );
  assert.equal(fetched.exitCode, 0, fetched.stderr);
  const pulled = await gitAdapter.run(
    ctx,
    operation(["pull", repoId, "--ff-only"]),
  );
  assert.equal(pulled.exitCode, 0, pulled.stderr);
  assert.equal(
    Buffer.from(
      pulled.files!.find((file) => file.path === "upstream.txt")!.base64,
      "base64",
    ).toString(),
    "upstream changed\n",
  );
  const ignoredBusiness = "ordinary ignored business retained locally\n";
  await assert.rejects(
    gitAdapter.run(
      ctx,
      operation(
        ["commit", repoId, "-m", "stale deletion must not upload"],
        [
          {
            path: "must-not-upload.txt",
            base64: Buffer.from("no write").toString("base64"),
          },
        ],
        [{ path: "upstream.txt", sha256: "0".repeat(64) }],
      ),
    ),
    { code: "GIT_DELETE_CONFLICT" },
  );
  await assert.rejects(
    fs.stat(
      path.join(
        ctx.dataDir,
        "git-repositories",
        ctx.connection.alias,
        repoId,
        "tree",
        "must-not-upload.txt",
      ),
    ),
    { code: "ENOENT" },
  );
  const commit = await gitAdapter.run(
    ctx,
    operation(
      ["commit", repoId, "-m", "broker commit"],
      [
        {
          path: ".gitignore",
          base64: Buffer.from("ignored-business.txt\n").toString("base64"),
        },
        {
          path: "ignored-business.txt",
          base64: Buffer.from(ignoredBusiness).toString("base64"),
        },
        {
          path: "pushed.txt",
          base64: Buffer.from("pushed through protected transport\n").toString(
            "base64",
          ),
        },
      ],
      [
        {
          path: "upstream.txt",
          sha256: crypto
            .createHash("sha256")
            .update("upstream changed\n")
            .digest("hex"),
        },
      ],
    ),
  );
  assert.equal(commit.exitCode, 0, commit.stderr);
  assert.equal(
    (commit.data as { filesAreFullManifest: boolean }).filesAreFullManifest,
    true,
  );
  const committedPaths = commit.files!.map((file) => file.path).sort();
  assert.deepEqual(
    committedPaths,
    [
      ...pulled
        .files!.map((file) => file.path)
        .filter((name) => name !== "upstream.txt"),
      ".gitignore",
      "pushed.txt",
    ].sort(),
  );
  assert.ok(!committedPaths.includes("ignored-business.txt"));
  const ignoredFile = path.join(
    ctx.dataDir,
    "git-repositories",
    ctx.connection.alias,
    repoId,
    "tree",
    "ignored-business.txt",
  );
  assert.equal(await fs.readFile(ignoredFile, "utf8"), ignoredBusiness);
  const pushed = await gitAdapter.run(
    ctx,
    operation(["push", repoId, "HEAD:main"]),
  );
  assert.equal(pushed.exitCode, 0, pushed.stderr);
  assert.equal(
    await command("/usr/bin/git", ["show", "main:pushed.txt"], bare),
    "pushed through protected transport\n",
  );
  const barePaths = (
    await command(
      "/usr/bin/git",
      ["ls-tree", "-r", "--name-only", "HEAD"],
      bare,
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(barePaths, committedPaths);
  assert.ok(!barePaths.includes("ignored-business.txt"));
  assert.equal(await fs.readFile(ignoredFile, "utf8"), ignoredBusiness);
  const status = await gitAdapter.run(
    ctx,
    operation(["status", repoId, "--short"]),
  );
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(status.stdout, "");
  const unknown = await gitAdapter.run(
    ctx,
    operation(["fetch", repoId, "nonexistent"]),
  );
  assert.notEqual(unknown.exitCode, 0);
  for (const secret of Object.values(ctx.secret))
    assert.ok(
      !JSON.stringify([
        clone,
        fetched,
        pulled,
        commit,
        pushed,
        status,
        unknown,
      ]).includes(secret),
    );
  return repoId;
}
async function seedEcho(
  data: Awaited<ReturnType<typeof fixture>>,
  value: string,
) {
  await fs.writeFile(path.join(data.source, "echo-credential.txt"), value);
  await command("/usr/bin/git", ["add", "echo-credential.txt"], data.source);
  await command(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "commit",
      "-m",
      "synthetic credential echo attack",
    ],
    data.source,
  );
  await command("/usr/bin/git", ["push", data.bare, "main"], data.source);
}

test(
  "Git HTTPS real native http-backend: clone/fetch/pull/commit/push, TLS, credentials and redirects",
  { timeout: 60000 },
  async () => {
    const data = await fixture();
    let server: https.Server | undefined;
    try {
      await command(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          "tls-key.pem",
          "-out",
          "tls-cert.pem",
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        data.root,
      );
      const key = await fs.readFile(path.join(data.root, "tls-key.pem")),
        cert = await fs.readFile(path.join(data.root, "tls-cert.pem"));
      const password = crypto.randomBytes(24).toString("base64url");
      const username = "synthetic-fixture-user";
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      let acceptedAuth = expected;
      let requests = 0,
        redirect = false,
        failedAuth = false,
        stall = false;
      server = https.createServer({ key, cert }, (req, res) => {
        requests++;
        if (stall) {
          req.resume();
          return;
        }
        if (redirect) {
          res
            .writeHead(302, { location: "https://example.invalid/leak" })
            .end();
          req.resume();
          return;
        }
        if (failedAuth || req.headers.authorization !== acceptedAuth) {
          res.writeHead(401).end("Authentication failed");
          req.resume();
          return;
        }
        const url = new URL(req.url!, "https://127.0.0.1");
        const child = spawn("/usr/bin/git", ["http-backend"], {
          cwd: data.root,
          env: {
            ...cleanEnvironment,
            GIT_PROJECT_ROOT: data.root,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: req.method!,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers["content-type"] || "",
            REMOTE_USER: "fixture",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        req.pipe(child.stdin);
        let initial = Buffer.alloc(0),
          headersSent = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (headersSent) {
            res.write(chunk);
            return;
          }
          initial = Buffer.concat([initial, chunk]);
          const end = initial.indexOf("\r\n\r\n");
          if (end < 0) return;
          const lines = initial.subarray(0, end).toString().split("\r\n");
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of lines) {
            const at = line.indexOf(":");
            const name = line.slice(0, at);
            const value = line.slice(at + 1).trim();
            if (name.toLowerCase() === "status")
              status = Number(value.slice(0, 3));
            else headers[name] = value;
          }
          res.writeHead(status, headers);
          headersSent = true;
          res.write(initial.subarray(end + 4));
        });
        child.once("close", () => {
          if (!headersSent) res.writeHead(502);
          res.end();
        });
        child.once("error", () => res.writeHead(502).end());
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as net.AddressInfo).port;
      const conn = connection({
        transport: "https",
        url: `https://127.0.0.1:${port}/remote.git`,
        authType: "basic",
        ca: cert.toString(),
      });
      const ctx = context(conn, { username, password }, data.dataDir);
      const bearer = crypto.randomBytes(24).toString("base64url");
      acceptedAuth = `Bearer ${bearer}`;
      const bearerResult = await gitAdapter.run(
        context(
          connection({
            ...conn.config,
            authType: "bearer",
            identity: "synthetic-fixture-account",
          }),
          { token: bearer },
          data.dataDir,
        ),
        operation(["clone"]),
      );
      assert.equal(bearerResult.exitCode, 0, bearerResult.stderr);
      assert.ok(!JSON.stringify(bearerResult).includes(bearer));
      acceptedAuth = expected;
      await seedEcho(
        data,
        `${password}\n${encodeURIComponent(password)}\n${expected}\n`,
      );
      const repoId = await workflow(ctx, data.bare, data.source);
      await assert.rejects(
        gitAdapter.run(
          {
            ...ctx,
            secret: { username: "different-synthetic-account", password },
          },
          operation(["status", repoId]),
        ),
        { code: "GIT_IDENTITY" },
      );
      assert.ok(requests >= 8);
      failedAuth = true;
      const denied = await gitAdapter.run(ctx, operation(["clone"]));
      assert.notEqual(denied.exitCode, 0);
      failedAuth = false;
      redirect = true;
      const redirected = await gitAdapter.run(ctx, operation(["clone"]));
      assert.notEqual(redirected.exitCode, 0);
      assert.match(redirected.stderr!, /重定向|Redirect/);
      redirect = false;
      const noCa = context(
        connection({
          transport: "https",
          url: `https://127.0.0.1:${port}/remote.git`,
          authType: "basic",
        }),
        { username, password },
        data.dataDir,
      );
      const untrusted = await gitAdapter.run(noCa, operation(["clone"]));
      assert.notEqual(untrusted.exitCode, 0);
      assert.match(untrusted.stderr!, /TLS/);
      assert.ok(
        !JSON.stringify([denied, redirected, untrusted]).includes(password),
      );
      stall = true;
      const abort = new AbortController();
      const cancel = setTimeout(() => abort.abort(), 200);
      await assert.rejects(
        gitAdapter.run({ ...ctx, signal: abort.signal }, operation(["clone"])),
        { code: "CANCELLED" },
      );
      clearTimeout(cancel);
      stall = false;
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await data.close();
    }
  },
);

test(
  "Git SSH real native pack protocol: host pin, clone/fetch/pull/commit/push, wrong credentials",
  { timeout: 60000 },
  async () => {
    const data = await fixture();
    const hostKey = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const parsedKey = utils.parseKey(hostKey);
    assert.ok(!(parsedKey instanceof Error));
    assert.ok(!Array.isArray(parsedKey));
    const fingerprint = `SHA256:${crypto.createHash("sha256").update(parsedKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
    const password = crypto.randomBytes(24).toString("base64url");
    const clientKey = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const publicKey = utils.parseKey(clientKey);
    assert.ok(!(publicKey instanceof Error) && !Array.isArray(publicKey));
    const clients = new Set<import("ssh2").Connection>();
    let executions = 0;
    let stallExec = false;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client);
      client.once("close", () => clients.delete(client));
      client.on("error", () => undefined);
      client.on("authentication", (auth) => {
        if (auth.username !== "fixture") {
          auth.reject();
          return;
        }
        if (auth.method === "password" && auth.password === password) {
          auth.accept();
          return;
        }
        if (
          auth.method === "publickey" &&
          auth.key.data.equals(publicKey.getPublicSSH()) &&
          (!auth.signature ||
            (auth.blob &&
              publicKey.verify(auth.blob, auth.signature, auth.hashAlgo) ===
                true))
        ) {
          auth.accept();
          return;
        }
        auth.reject();
      });
      client.on("ready", () =>
        client.on("session", (accept) =>
          accept().on("exec", (acceptExec, reject, info) => {
            const service = info.command.startsWith("git-upload-pack ")
              ? "upload-pack"
              : info.command.startsWith("git-receive-pack ")
                ? "receive-pack"
                : undefined;
            if (!service || info.command !== `git-${service} '${data.bare}'`) {
              reject();
              return;
            }
            executions++;
            const channel = acceptExec();
            if (stallExec) return;
            const child = spawn("/usr/bin/git", [service, data.bare], {
              env: cleanEnvironment,
              stdio: ["pipe", "pipe", "pipe"],
            });
            channel.pipe(child.stdin);
            child.stdout.pipe(channel);
            child.stderr.pipe(channel.stderr);
            child.once("close", (code) => {
              channel.exit(code || 0);
              channel.end();
            });
            channel.once("close", () => child.kill("SIGTERM"));
          }),
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as net.AddressInfo).port;
      const conn = connection({
        transport: "ssh",
        host: "127.0.0.1",
        port,
        username: "fixture",
        path: data.bare,
        hostKeySha256: fingerprint,
      });
      const ctx = context(conn, { password }, data.dataDir);
      await seedEcho(
        data,
        `${password}\n${Buffer.from(password).toString("base64")}\n`,
      );
      const repoId = await workflow(ctx, data.bare, data.source);
      const keyContext = context(conn, { privateKey: clientKey }, data.dataDir);
      const keyClone = await gitAdapter.run(keyContext, operation(["clone"]));
      assert.equal(keyClone.exitCode, 0, keyClone.stderr);
      assert.ok(!JSON.stringify(keyClone).includes(clientKey));
      await assert.rejects(
        gitAdapter.run(keyContext, operation(["status", repoId])),
        { code: "GIT_IDENTITY" },
      );
      assert.ok(executions >= 4);
      const wrong = await gitAdapter.run(
        context(conn, { password: "synthetic-wrong-password" }, data.dataDir),
        operation(["clone"]),
      );
      assert.notEqual(wrong.exitCode, 0);
      const badPin = connection({
        ...conn.config,
        hostKeySha256: `SHA256:${Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "")}`,
      });
      const changedKey = await gitAdapter.run(
        context(badPin, { password }, data.dataDir),
        operation(["clone"]),
      );
      assert.notEqual(changedKey.exitCode, 0);
      assert.ok(!JSON.stringify([wrong, changedKey]).includes(password));
      stallExec = true;
      const workspace = path.join(data.dataDir, "git-repositories", "GIT");
      const before = (await fs.readdir(workspace))
        .filter((name) => !name.endsWith(".lock"))
        .sort();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 200);
      await assert.rejects(
        gitAdapter.run({ ...ctx, signal: abort.signal }, operation(["clone"])),
        { code: "CANCELLED" },
      );
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(clients.size, 0);
      assert.deepEqual(
        (await fs.readdir(workspace))
          .filter((name) => !name.endsWith(".lock"))
          .sort(),
        before,
      );
      stallExec = false;
    } finally {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await data.close();
    }
  },
);

test("Git parser rejects configuration/helper/SSH hooks/targets and unsafe broker files", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "abl-git-security-"),
  );
  const ctx = context(
    connection({
      transport: "https",
      url: "https://example.com/repo.git",
      authType: "none",
    }),
    {},
    directory,
  );
  try {
    for (const args of [
      ["-c", "credential.helper=!echo leak"],
      ["config", "credential.helper"],
      ["clone", "https://evil.example/repo.git"],
      ["clone", "--config", "core.sshCommand=evil"],
      ["clone", "--upload-pack=evil"],
      ["clone", "--recurse-submodules"],
      ["clone", "--template=/tmp/hooks"],
      ["fetch", "../escaped"],
      ["push", "a".repeat(32), "--receive-pack=evil"],
    ])
      await assert.rejects(gitAdapter.run(ctx, operation(args)), {
        status: 400,
      });
    gitAdapter.validate(ctx.connection);
    for (const config of [
      {
        transport: "https",
        url: "https://secret:password@example.com/repo.git",
        authType: "none",
      },
      { ...ctx.connection.config, credentialHelper: "evil" },
      { ...ctx.connection.config, url: "http://example.com/repo.git" },
    ])
      assert.throws(() => gitAdapter.validate(connection(config)));
    // Native repository fixture; no network and no user repository/config read.
    const id = "b".repeat(32),
      repository = path.join(directory, "git-repositories", "GIT", id),
      tree = path.join(repository, "tree");
    await fs.mkdir(repository, { recursive: true });
    await command("/usr/bin/git", ["init", "-b", "main", "tree"], repository);
    const normalized = {
      transport: "https",
      url: "https://example.com/repo.git",
      authType: "none",
      authorName: "Abilock",
      authorEmail: "abilock@localhost.invalid",
    };
    await fs.writeFile(
      path.join(repository, "binding.json"),
      JSON.stringify({
        identity: crypto
          .createHash("sha256")
          .update(JSON.stringify(normalized))
          .digest("hex"),
      }),
    );
    for (const filename of [
      ".git/config",
      ".GiT/hooks/pre-commit",
      "../escaped",
      "foo/../../escaped",
      "/tmp/escaped",
      ".git /config",
    ])
      await assert.rejects(
        gitAdapter.run(
          ctx,
          operation(
            ["commit", id, "-m", "rejected"],
            [{ path: filename, base64: "eA==" }],
          ),
        ),
        { code: "GIT_FILE" },
      );
    const linked = path.join(tree, "linked");
    await fs.symlink(directory, linked);
    await assert.rejects(
      gitAdapter.run(
        ctx,
        operation(
          ["commit", id, "-m", "rejected"],
          [{ path: "linked/escaped", base64: "eA==" }],
        ),
      ),
      { code: "GIT_DIRECTORY" },
    );
    await assert.rejects(fs.lstat(path.join(directory, "escaped")), {
      code: "ENOENT",
    });
    assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(linked), directory);
    // Remove only this fixture's rejected attack before the independent hook case.
    await fs.unlink(linked);
    const changed = {
      ...ctx,
      connection: connection({
        ...ctx.connection.config,
        url: "https://changed.example/repo.git",
      }),
    };
    await assert.rejects(gitAdapter.run(changed, operation(["status", id])), {
      code: "GIT_IDENTITY",
    });
    // Malicious local hooks/config are overwritten or disabled, even for commit.
    const marker = path.join(directory, "hook-ran");
    await fs.mkdir(path.join(tree, ".git", "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(tree, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o700 },
    );
    await fs.appendFile(
      path.join(tree, ".git", "config"),
      `\n[core]\nhooksPath = ${path.join(tree, ".git", "hooks")}\nfsmonitor = touch ${marker}\n[filter "exfil"]\nclean = touch ${marker}\nrequired = true\n`,
    );
    const committed = await gitAdapter.run(
      ctx,
      operation(
        ["commit", id, "-m", "safe"],
        [{ path: "regular.txt", base64: "eA==" }],
      ),
    );
    assert.equal(committed.exitCode, 0, committed.stderr);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    const contents = await fs.readFile(
      path.join(tree, ".git", "config"),
      "utf8",
    );
    assert.ok(!contents.includes("exfil"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
