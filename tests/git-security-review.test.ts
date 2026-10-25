import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { gitAdapter } from "../src/protocols/git.js";
import type { AdapterContext, Operation } from "../src/connections.js";

const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  LANG: "C",
};
async function git(args: string[], cwd: string) {
  const child = spawn("/usr/bin/git", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "abl-git-independent-review-"),
  );
  await git(["init", "--bare", "--initial-branch=main", "remote.git"], root);
  const remote = path.join(root, "remote.git"),
    dataDir = path.join(root, "broker");
  const key = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const parsed = ssh2.utils.parseKey(key);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const fingerprint = `SHA256:${crypto.createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  const clients = new Set<import("ssh2").Connection>();
  const processes = new Set<ReturnType<typeof spawn>>();
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (auth) =>
      auth.method === "password" &&
      auth.username === "review" &&
      auth.password === "synthetic-review-only"
        ? auth.accept()
        : auth.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) =>
        accept().on("exec", (acceptExec, reject, info) => {
          if (info.command !== `git-upload-pack '${remote}'`) {
            reject();
            return;
          }
          const channel = acceptExec();
          const child = spawn("/usr/bin/git", ["upload-pack", remote], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          processes.add(child);
          channel.pipe(child.stdin!);
          child.stdout!.pipe(channel);
          child.stderr!.pipe(channel.stderr);
          child.once("close", (code) => {
            processes.delete(child);
            channel.exit(code ?? 1);
            channel.end();
          });
          channel.once("close", () => child.kill("SIGTERM"));
        }),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const context: AdapterContext = {
    connection: {
      alias: "REVIEW",
      name: "Independent Git security fixture",
      description: "",
      enabled: true,
      kind: "git",
      trustBoundary: "development-fixture",
      config: {
        transport: "ssh",
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        username: "review",
        path: remote,
        hostKeySha256: fingerprint,
      },
    },
    secret: { password: "synthetic-review-only" },
    allowLocal: true,
    signal: AbortSignal.timeout(20000),
    dataDir,
  };
  const clone = async () => {
    const result = await gitAdapter.run(context, {
      args: ["clone"],
      timeoutMs: 10000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const id = (result.data as { repoId: string }).repoId;
    return {
      id,
      repository: path.join(dataDir, "git-repositories", "REVIEW", id),
      tree: path.join(dataDir, "git-repositories", "REVIEW", id, "tree"),
    };
  };
  const close = async () => {
    for (const client of clients) client.end();
    for (const child of processes) child.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, context, clone, close };
}
test(
  "Git metadata links and FIFOs fail closed without outside writes or blocking reads",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      for (const [name, kind] of ["config", "HEAD", "binding.json"].flatMap(
        (name) => [
          [name, "symlink"],
          [name, "hardlink"],
          [name, "fifo"],
        ],
      )) {
        const repo = await f.clone();
        const original =
          name === "binding.json"
            ? path.join(repo.repository, name)
            : path.join(repo.tree, ".git", name);
        const sentinel = path.join(
            f.root,
            `outside-${name.replace(".", "-")}-${kind}`,
          ),
          contents = await fs.readFile(original);
        await fs.writeFile(sentinel, contents);
        await fs.unlink(original);
        if (kind === "symlink") await fs.symlink(sentinel, original);
        else if (kind === "hardlink") await fs.link(sentinel, original);
        else
          execFileSync("/usr/bin/mkfifo", [original], { env, stdio: "ignore" });
        const rejected = await gitAdapter
          .run(f.context, { args: ["status", repo.id], timeoutMs: 5000 })
          .then(
            () => false,
            () => true,
          );
        assert.deepEqual(
          await fs.readFile(sentinel),
          contents,
          `${name} ${kind} caused an outside write`,
        );
        assert.equal(rejected, true, `${name} ${kind} must fail closed`);
      }
    } finally {
      await f.close();
    }
  },
);
test(
  "Git alternate commondir cannot load external filters through business .gitattributes",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const repo = await f.clone();
      const outside = path.join(f.root, "outside-common"),
        marker = path.join(f.root, "local-command-executed");
      await git(["init", "--bare", outside], f.root);
      await fs.appendFile(
        path.join(outside, "config"),
        `\n[filter "unsafe"]\nclean = touch '${marker}'; cat\nrequired = true\n`,
      );
      await fs.writeFile(
        path.join(repo.tree, ".git", "commondir"),
        `${outside}\n`,
      );
      const operation: Operation = {
        args: ["commit", repo.id, "-m", "synthetic business input"],
        files: [
          {
            path: ".gitattributes",
            base64: Buffer.from("*.txt filter=unsafe\n").toString("base64"),
          },
          {
            path: "business.txt",
            base64: Buffer.from("normal business data\n").toString("base64"),
          },
        ],
        timeoutMs: 5000,
      };
      const rejected = await gitAdapter.run(f.context, operation).then(
        () => false,
        () => true,
      );
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
      assert.equal(
        rejected,
        true,
        "alternate Git common directory must fail closed",
      );
    } finally {
      await f.close();
    }
  },
);
