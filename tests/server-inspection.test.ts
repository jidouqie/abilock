import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import type { Connection } from "../src/connections.js";
import type { DiscoveryCatalog } from "../src/discovery.js";
import {
  parseServerInventory,
  serverInspectionCommand,
} from "../src/server-inspection.js";

// Disposable stores, identities and a synthetic SSH protocol responder only.
// The fixture never starts a shell, runs the command or probes the host OS.
const sshPassword = "synthetic-inspection-ssh-password-94301";
const adminPassword = "synthetic-inspection-admin-password-94302";
const execToken = "synthetic-inspection-exec-capability-94303";
const successOutput =
  "abl-os:Linux\nabl-arch:x86_64\nabl-tool:python3\nabl-tool:ffmpeg\nabl-tool:docker\n";
type Reply = {
  stdout: string;
  exitCode: number;
  stderr?: string;
  entered?: () => void;
  hold?: Promise<void>;
};
type Session = { cookie: string; csrfToken: string };

function hostIdentity() {
  const { utils } = ssh2;
  for (let attempt = 0; attempt < 16; attempt++) {
    const keys = utils.generateKeyPairSync("ed25519");
    const publicKey = utils.parseKey(keys.public);
    if (publicKey instanceof Error) {
      // ssh2's synthetic generator can strip leading zero bytes from a public
      // key. Regenerate only this documented generator bug, never bad real keys.
      const [kind, encoded] = keys.public.trim().split(/\s+/);
      const blob = Buffer.from(encoded ?? "", "base64");
      assert(
        publicKey.message === "Malformed OpenSSH public key" &&
          kind === "ssh-ed25519" &&
          blob.length >= 19 &&
          blob.readUInt32BE(0) === 11 &&
          blob.subarray(4, 15).toString() === "ssh-ed25519" &&
          blob.readUInt32BE(15) > 0 &&
          blob.readUInt32BE(15) < 32 &&
          blob.length === 19 + blob.readUInt32BE(15),
        "unexpected synthetic host-key generation failure",
      );
      continue;
    }
    const privateKey = utils.parseKey(keys.private);
    assert(!(privateKey instanceof Error) && !Array.isArray(privateKey));
    return {
      privateKey: keys.private,
      fingerprint: `SHA256:${crypto.createHash("sha256").update(privateKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
    };
  }
  throw new Error("synthetic host-key generation remained truncated");
}

async function sshFixture() {
  const keys = hostIdentity();
  const clients = new Set<ssh2.Connection>();
  const commands: string[] = [];
  let opened = 0;
  let reply: Reply = { stdout: successOutput, exitCode: 0 };
  const server = new ssh2.Server({ hostKeys: [keys.privateKey] }, (client) => {
    opened++;
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === "synthetic-fixture" &&
        ctx.password === sshPassword
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, reject, info) => {
          commands.push(info.command);
          if (info.command !== serverInspectionCommand) return reject();
          const channel = accept();
          channel.on("error", () => {});
          const response = reply;
          reply = { stdout: successOutput, exitCode: 0 };
          response.entered?.();
          void Promise.resolve(response.hold).then(() => {
            if (channel.destroyed) return;
            if (response.stderr) channel.stderr.write(response.stderr);
            channel.write(response.stdout);
            channel.exit(response.exitCode);
            channel.end();
          });
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint: keys.fingerprint,
    commands,
    opened: () => opened,
    respond: (next: Reply) => {
      reply = next;
    },
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(clients.size, 0);
    },
  };
}

async function environment() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-inspection-test-"));
  const store = new Store(dir, "6".repeat(64));
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    await store.init();
    server = await startServers({
      store,
      execToken,
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      execPort: 0,
      log: () => {},
    });
    const response = await fetch(server.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: {
        origin: server.adminUrl,
        "x-abilock-ui": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: adminPassword,
        confirmPassword: adminPassword,
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const { csrfToken } = (await response.json()) as { csrfToken: string };
    assert(csrfToken);
    return {
      dir,
      store,
      server,
      session: { cookie, csrfToken } satisfies Session,
      close: async () => {
        try {
          await server?.close();
        } finally {
          try {
            await store.close();
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    try {
      await server?.close();
    } finally {
      try {
        await store.close();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function request(
  url: string,
  route: string,
  value?: unknown,
  session?: Session,
  token?: string,
) {
  return fetch(url + route, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      ...(value === undefined ? {} : { "content-type": "application/json" }),
      ...(session
        ? { cookie: session.cookie, "x-abilock-csrf": session.csrfToken }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
}

function sshConnection(
  alias: string,
  wire: Awaited<ReturnType<typeof sshFixture>>,
): Connection {
  return {
    alias,
    name: "合成服务器",
    kind: "ssh",
    description: "仅用于概况读取回归",
    enabled: true,
    trustBoundary: "development-fixture",
    config: {
      host: "127.0.0.1",
      port: wire.port,
      username: "synthetic-fixture",
      hostKeySHA256: wire.fingerprint,
      remoteRoot: "/srv/synthetic",
      fileAccess: "read",
      allowShell: true,
    },
  };
}

test("服务器概况解析仅收录固定工具并限制输出与架构格式", () => {
  const inspectedAt = "2026-10-08T00:00:00.000Z";
  const parsed = parseServerInventory(
    successOutput +
      "abl-tool:arbitrary-helper\nabl-tool:ffmpeg\nabl-tool:node --export-secrets\n",
    inspectedAt,
  );
  assert.deepEqual(parsed, {
    inspectedAt,
    os: "Linux",
    architecture: "x86_64",
    tools: ["python3", "ffmpeg", "docker"],
  });
  assert.equal(
    parseServerInventory("abl-os:Injected OS\nabl-arch:arm64\n", inspectedAt)
      .os,
    "unknown",
  );
  for (const output of [
    "abl-tool:node\n",
    "abl-os:Linux\nabl-arch:x86_64;injected-command\n",
    successOutput + "x".repeat(16385),
    successOutput + "图".repeat(6000),
  ])
    assert.throws(
      () => parseServerInventory(output, inspectedAt),
      /服务器概况响应无效/,
    );
});

test(
  "服务器概况管理探测固定命令、目录只读、失败与并发冲突保留旧概况",
  { timeout: 20000 },
  async () => {
    const oldMock = process.env.ABILOCK_MOCK;
    const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
    let wire: Awaited<ReturnType<typeof sshFixture>> | undefined;
    let f: Awaited<ReturnType<typeof environment>> | undefined;
    let release: (() => void) | undefined;
    let pending: Promise<Response> | undefined;
    try {
      process.env.ABILOCK_MOCK = "1";
      process.env.ABILOCK_ALLOW_LOCAL = "1";
      wire = await sshFixture();
      f = await environment();
      const connection = sshConnection("INSPECT", wire);
      const saved = await f.store.saveConnection(
        connection,
        { password: sshPassword },
        false,
        0,
      );
      const route = "/admin/connections/INSPECT/inspect";
      const before = f.store.discovery();
      for (const [base, auth, token] of [
        [f.server.execUrl, undefined, execToken],
        [f.server.adminUrl, f.session, undefined],
      ] as const) {
        const read = await request(
          base,
          base === f.server.execUrl ? "/v2/discovery" : "/admin/discovery",
          undefined,
          auth,
          token,
        );
        assert.equal(read.status, 200);
        const catalog = (await read.json()) as DiscoveryCatalog;
        assert(
          catalog.capabilities.every(
            (card) => card.verification === "not-probed",
          ),
        );
      }
      assert.equal(
        wire.opened(),
        0,
        "discovery must not establish SSH sessions",
      );
      assert.equal(
        (
          await request(
            f.server.adminUrl,
            route,
            { expectedRevision: saved.revision },
            undefined,
            execToken,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request(
            f.server.execUrl,
            route,
            { expectedRevision: saved.revision },
            undefined,
            execToken,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            f.server.adminUrl,
            route,
            { expectedRevision: saved.revision },
            { ...f.session, csrfToken: "" },
          )
        ).status,
        403,
      );
      for (const extra of [
        { command: "arbitrary-command" },
        { target: "https://outside.example" },
      ]) {
        assert.equal(
          (
            await request(
              f.server.adminUrl,
              route,
              { expectedRevision: saved.revision, ...extra },
              f.session,
            )
          ).status,
          400,
        );
      }
      assert.equal(
        wire.opened(),
        0,
        "role, CSRF and strict-body denials must occur before SSH",
      );

      const success = await request(
        f.server.adminUrl,
        route,
        { expectedRevision: saved.revision },
        f.session,
      );
      assert.equal(success.status, 200);
      const updated = (await success.json()) as {
        revision: number;
        inventory: ReturnType<typeof parseServerInventory>;
      };
      assert.equal(updated.revision, saved.revision + 1);
      assert.equal(updated.inventory.os, "Linux");
      assert.deepEqual(updated.inventory.tools, [
        "python3",
        "ffmpeg",
        "docker",
      ]);
      assert.deepEqual(wire.commands, [serverInspectionCommand]);
      const oldInventory = structuredClone(updated.inventory);
      const openedBeforeRefresh = wire.opened();
      const discovered = await request(
        f.server.execUrl,
        "/v2/discovery",
        undefined,
        undefined,
        execToken,
      );
      const discoveryText = await discovered.text();
      assert.equal(discovered.status, 200);
      const after = JSON.parse(discoveryText) as DiscoveryCatalog;
      assert.notEqual(after.revision, before.revision);
      assert(
        after.capabilities.every(
          (card) => card.verification === "inventory-only",
        ),
      );
      assert(
        after.capabilities.every((card) =>
          card.limitations.some((line) =>
            line.includes("工具存在不表示服务已启动"),
          ),
        ),
      );
      assert(
        after.capabilities.every(
          (card) =>
            !card.tags.some((tag) => ["生图", "视频", "音乐"].includes(tag)),
        ),
      );
      for (const secret of [sshPassword, adminPassword, execToken, "sealed"])
        assert(!discoveryText.includes(secret));
      assert.equal(
        wire.commands.length,
        1,
        "a refreshed directory must use cached inventory",
      );
      assert.equal(wire.opened(), openedBeforeRefresh);
      const persisted = JSON.parse(
        await fs.readFile(path.join(f.dir, "state.json"), "utf8"),
      );
      assert.deepEqual(persisted.connections[0].inventory, oldInventory);
      assert.equal(persisted.discovery.revision, after.revision);

      for (const reply of [
        { stdout: successOutput, stderr: sshPassword, exitCode: 7 },
        { stdout: "unrecognized response\n", exitCode: 0 },
        { stdout: successOutput + "x".repeat(16385), exitCode: 0 },
      ]) {
        wire.respond(reply);
        const failed = await request(
          f.server.adminUrl,
          route,
          { expectedRevision: updated.revision },
          f.session,
        );
        assert.equal(failed.status, 502);
        assert(!(await failed.text()).includes(sshPassword));
        assert.deepEqual(
          f.store.connection("ssh", "INSPECT").inventory,
          oldInventory,
        );
        assert.equal(
          f.store.connection("ssh", "INSPECT").revision,
          updated.revision,
        );
        assert.equal(f.store.discovery().revision, after.revision);
      }
      const commandsBeforeStale = wire.commands.length;
      const openedBeforeStale = wire.opened();
      assert.equal(
        (
          await request(
            f.server.adminUrl,
            route,
            { expectedRevision: saved.revision },
            f.session,
          )
        ).status,
        409,
      );
      assert.equal(wire.commands.length, commandsBeforeStale);
      assert.equal(wire.opened(), openedBeforeStale);
      assert.deepEqual(
        f.store.connection("ssh", "INSPECT").inventory,
        oldInventory,
      );

      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      wire.respond({
        stdout: "abl-os:Darwin\nabl-arch:arm64\nabl-tool:node\n",
        exitCode: 0,
        entered,
        hold,
      });
      pending = request(
        f.server.adminUrl,
        route,
        { expectedRevision: updated.revision },
        f.session,
      );
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error("probe returned before the synthetic SSH command");
        }),
      ]);
      const changed = await f.store.saveConnection(
        { ...connection, description: "合成服务器说明已更新" },
        undefined,
        false,
        updated.revision,
      );
      assert(release);
      release();
      assert.equal(
        (await pending).status,
        409,
        "a stale in-flight probe must not overwrite current inventory",
      );
      assert.equal(
        f.store.connection("ssh", "INSPECT").revision,
        changed.revision,
      );
      assert.deepEqual(
        f.store.connection("ssh", "INSPECT").inventory,
        oldInventory,
      );

      const commandsBeforeDisabled = wire.commands.length;
      const openedBeforeDisabled = wire.opened();
      for (const [alias, enabled, allowShell, withSecret, expectedStatus] of [
        ["OFF", false, true, true, 403],
        ["NO_SHELL", true, false, true, 403],
        ["NO_SECRET", true, true, false, 400],
      ] as const) {
        const unavailable = await f.store.saveConnection(
          {
            ...sshConnection(alias, wire),
            enabled,
            config: { ...connection.config, allowShell },
          },
          withSecret ? { password: sshPassword } : undefined,
          false,
          0,
        );
        assert.equal(
          (
            await request(
              f.server.adminUrl,
              `/admin/connections/${alias}/inspect`,
              { expectedRevision: unavailable.revision },
              f.session,
            )
          ).status,
          expectedStatus,
        );
      }
      assert.equal(wire.commands.length, commandsBeforeDisabled);
      assert.equal(wire.opened(), openedBeforeDisabled);
      assert(
        wire.commands.every((command) => command === serverInspectionCommand),
      );
    } finally {
      release?.();
      await pending?.catch(() => undefined);
      try {
        await f?.close();
      } finally {
        try {
          await wire?.close();
        } finally {
          if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
          else process.env.ABILOCK_MOCK = oldMock;
          if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
          else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
        }
      }
    }
  },
);
