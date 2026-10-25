import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import { Store } from "../src/store.js";
import {
  LocalResponse,
  executeLocalRequest,
  type LocalResponseHeaders,
} from "../src/local-execution.js";
import { createLocalTerminalSession } from "../src/local-terminal.js";

// The only listener is this disposable ssh2 wire-protocol responder. It never
// starts a shell, launches OpenSSH, invokes Git, or reads a real home/config.
const password = "synthetic-local-wire-password-71951",
  execToken = "synthetic-local-wire-capability-71952",
  master = "b".repeat(64),
  uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function bounded<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("synthetic local SSH fixture timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hostIdentity() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const keys = ssh2.utils.generateKeyPairSync("ed25519");
    const publicKey = ssh2.utils.parseKey(keys.public);
    if (publicKey instanceof Error) {
      // Regenerate only the known ssh2 synthetic generator truncation. Real
      // target fingerprint checks continue through the production adapter.
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
      );
      continue;
    }
    const parsed = ssh2.utils.parseKey(keys.private);
    assert(!(parsed instanceof Error) && !Array.isArray(parsed));
    return {
      privateKey: keys.private,
      fingerprint:
        "SHA256:" +
        crypto
          .createHash("sha256")
          .update(parsed.getPublicSSH())
          .digest("base64")
          .replace(/=+$/, ""),
    };
  }
  throw new Error("synthetic SSH key fixture remained truncated");
}

async function fixture(immediate = true) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-ssh-fixture-"),
  );
  const identity = hostIdentity(),
    clients = new Set<ssh2.Connection>();
  const commands: string[] = [],
    windows: number[][] = [],
    inputs: string[] = [];
  const store = new Store(dir, master, [execToken]);
  const ssh = new ssh2.Server({ hostKeys: [identity.privateKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.on("authentication", (context) => {
      if (
        context.method === "password" &&
        context.username === "fixture" &&
        context.password === password
      )
        context.accept();
      else context.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept, _reject, info) => {
          windows.push([info.rows, info.cols]);
          accept();
        });
        session.on("window-change", (_accept, _reject, info) => {
          windows.push([info.rows, info.cols]);
        });
        session.on("exec", (accept, reject, info) => {
          commands.push(info.command);
          if (info.command !== "synthetic-copy") {
            reject();
            return;
          }
          const channel = accept();
          channel.on("error", () => {});
          channel.write("fixture-native\n" + password.slice(0, 13));
          channel.write(password.slice(13) + "\n" + execToken + "\n");
          channel.stderr.write("fixture-stderr " + password + "\n");
          channel.exit(7);
          channel.end();
        });
        session.on("shell", (accept) => {
          const channel = accept();
          channel.on("error", () => {});
          if (immediate) {
            // Acceptance, output, and exit status may arrive in one SSH packet.
            channel.exit(7);
            channel.end(
              "fixture-terminal-immediate\n" +
                password +
                "\n" +
                execToken +
                "\n",
            );
          } else {
            channel.write("fixture-terminal-interactive\n");
            let input = "";
            channel.on("data", (bytes: Buffer) => {
              inputs.push(bytes.toString());
              input += bytes.toString();
              if (!input.includes("finish\n")) return;
              channel.write(password.slice(0, 13));
              channel.write(password.slice(13) + "\n" + execToken + "\n");
              channel.exit(7);
              channel.end("fixture-input-accepted\n");
            });
          }
        });
      }),
    );
  });
  let listening = false;
  const close = async () => {
    for (const client of clients) client.end();
    if (listening)
      await new Promise<void>((resolve) => ssh.close(() => resolve()));
    await store.close();
    await delay(0);
    await fs.rm(dir, { recursive: true, force: true });
    assert.equal(
      clients.size,
      0,
      "synthetic SSH connections remained after fixture cleanup",
    );
    assert.equal(ssh.address(), null);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      ssh.once("error", reject);
      ssh.listen(0, "127.0.0.1", resolve);
    });
    listening = true;
    await store.init();
    await store.saveConnection(
      {
        alias: "TERM",
        name: "Synthetic local wire terminal",
        kind: "ssh",
        enabled: true,
        description: "Synthetic SSH responder",
        trustBoundary: "development-fixture",
        config: {
          host: "127.0.0.1",
          port: (ssh.address() as net.AddressInfo).port,
          username: "fixture",
          hostKeySHA256: identity.fingerprint,
          remoteRoot: "/",
          allowShell: true,
        },
      },
      { password },
      false,
      0,
    );
    const waitClosed = () =>
      bounded(
        (async () => {
          while (clients.size) await delay(5);
        })(),
      );
    return { store, clients, commands, windows, inputs, waitClosed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
function noSecrets(value: string) {
  for (const secret of [password, execToken, master]) {
    assert(!value.includes(secret));
    assert(!value.includes(encodeURIComponent(secret)));
    assert(!value.includes(Buffer.from(secret).toString("base64")));
  }
}

test(
  "本地native SSH通过真实适配器返回exit7、独立追踪和全库脱敏",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(),
      invocationId = crypto.randomUUID();
    try {
      t.mock.method(net.Server.prototype, "listen", () => {
        throw new Error("local execution must not listen");
      });
      const bytes: Buffer[] = [],
        headers: LocalResponseHeaders[] = [];
      const response = new LocalResponse(
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            bytes.push(Buffer.from(chunk));
            callback();
          },
        }),
        (message) => headers.push(message),
      );
      const outcome = await bounded(
        executeLocalRequest(
          f.store,
          {
            type: "request",
            url: "/v2/run/ssh/TERM",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-abilock-invocation-id": invocationId,
            },
            body: JSON.stringify({
              args: ["--", "synthetic-copy"],
              timeoutMs: 3000,
              trace: { invocationId },
            }),
          },
          response,
          {
            signal: new AbortController().signal,
            programRoot: path.resolve("."),
            allowLocalFixture: true,
          },
        ),
      );
      assert.equal(outcome.failed, false);
      assert.equal(headers.length, 1);
      assert.equal(headers[0].status, 200);
      const value = JSON.parse(Buffer.concat(bytes).toString());
      assert.equal(value.exitCode, 7);
      assert.equal(value.stdout, "fixture-native\n[REDACTED]\n[REDACTED]\n");
      assert.equal(value.stderr, "fixture-stderr [REDACTED]\n");
      assert.equal(value.invocationId, invocationId);
      assert.equal(
        value.operationId,
        headers[0].headers["x-abilock-operation-id"],
      );
      assert.match(value.operationId, uuid);
      assert.match(headers[0].headers["x-abilock-request-id"], uuid);
      assert.deepEqual(f.commands, ["synthetic-copy"]);
      noSecrets(Buffer.concat(bytes).toString());
      await f.waitClosed();
    } finally {
      await f.close();
    }
  },
);

test(
  "本地PTY通过真实openTerminal保持ready/data/exit7和帧追踪",
  { timeout: 20000 },
  async (t) => {
    for (const immediate of [true, false]) {
      const f = await fixture(immediate),
        invocationId = crypto.randomUUID();
      const controller = new AbortController();
      let terminal: ReturnType<typeof createLocalTerminalSession> | undefined;
      try {
        // No product, broker or gateway listener is permitted during execution.
        const noListen = t.mock.method(net.Server.prototype, "listen", () => {
          throw new Error("local execution must not listen");
        });
        const frames: Record<string, unknown>[] = [];
        let ready!: () => void;
        const readyPromise = new Promise<void>((resolve) => {
          ready = resolve;
        });
        terminal = createLocalTerminalSession(
          f.store,
          {
            type: "terminal",
            selector: "TERM",
            headers: { "x-abilock-invocation-id": invocationId },
          },
          {
            signal: controller.signal,
            allowLocalFixture: true,
            send: async (frame) => {
              frames.push(frame);
              if (frame.type === "ready") ready();
            },
          },
        );
        terminal.receive({
          type: "init",
          trace: { invocationId },
          sequence: 1,
          direction: "client",
        });
        await bounded(readyPromise);
        if (!immediate) {
          terminal.receive({
            type: "resize",
            rows: 30,
            cols: 90,
            sequence: 2,
            direction: "client",
            ...terminal.trace,
          });
          terminal.receive({
            type: "data",
            data: Buffer.from("finish\n").toString("base64"),
            sequence: 3,
            direction: "client",
            ...terminal.trace,
          });
        }
        await bounded(terminal.done);
        assert.equal(frames[0].type, "ready");
        assert.equal(frames.at(-1)?.type, "exit");
        assert.equal(frames.at(-1)?.code, 7);
        let output = "";
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index];
          assert.equal(frame.sequence, index + 1);
          assert.equal(frame.invocationId, invocationId);
          assert.equal(frame.operationId, terminal.trace.operationId);
          assert.equal(frame.direction, "server");
          assert.match(String(frame.requestId), uuid);
          if (frame.type === "data")
            output += Buffer.from(String(frame.data), "base64").toString();
        }
        assert(
          output.includes(
            immediate
              ? "fixture-terminal-immediate"
              : "fixture-terminal-interactive",
          ),
        );
        assert(output.includes("[REDACTED]"));
        if (!immediate) {
          assert(output.includes("fixture-input-accepted"));
          assert(f.inputs.join("").includes("finish\n"));
          assert(f.windows.some(([rows, cols]) => rows === 30 && cols === 90));
        }
        noSecrets(output);
        noSecrets(JSON.stringify(frames));
        await f.waitClosed();
        noListen.mock.restore();
      } finally {
        terminal?.cancel();
        controller.abort();
        await f.close();
      }
    }
  },
);

test(
  "真实本地PTY取消关闭SSH连接和会话，不留产品监听",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(false),
      controller = new AbortController();
    let terminal: ReturnType<typeof createLocalTerminalSession> | undefined;
    try {
      t.mock.method(net.Server.prototype, "listen", () => {
        throw new Error("local execution must not listen");
      });
      const frames: Record<string, unknown>[] = [];
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      terminal = createLocalTerminalSession(
        f.store,
        {
          type: "terminal",
          selector: "TERM",
          headers: { "x-abilock-invocation-id": crypto.randomUUID() },
        },
        {
          signal: controller.signal,
          allowLocalFixture: true,
          send: async (frame) => {
            frames.push(frame);
            if (frame.type === "ready") ready();
          },
        },
      );
      await bounded(readyPromise);
      assert.equal(f.clients.size, 1);
      controller.abort();
      await bounded(terminal.done);
      await f.waitClosed();
      assert.equal(f.inputs.length, 0);
      noSecrets(JSON.stringify(frames));
    } finally {
      terminal?.cancel();
      controller.abort();
      await f.close();
    }
  },
);
