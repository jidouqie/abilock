import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { executionGateway } from "../src/execution-gateway.js";
import { openTerminal } from "../src/protocols/ssh.js";
import type { Connection } from "../src/connections.js";

const execToken = "synthetic-terminal-review-exec-05060";
const adminToken = "synthetic-terminal-review-admin-05061";
const password = "synthetic-terminal-review-password-05062";
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("terminal fixture timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  code: number,
  immediate = true,
  logFailure?: "sync" | "async",
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-review-terminal-"),
  );
  const keys = ssh2.utils.generateKeyPairSync("ed25519");
  const parsed = ssh2.utils.parseKey(keys.private);
  assert(!(parsed instanceof Error) && !Array.isArray(parsed));
  const hostKeySHA256 =
    "SHA256:" +
    crypto
      .createHash("sha256")
      .update(parsed.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const clients = new Set<ssh2.Connection>();
  const windows: number[][] = [];
  const inputs: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const marker = `fixture-terminal-${immediate ? "immediate" : "interactive"}-${code}`;
  const ssh = new ssh2.Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" &&
      ctx.username === "fixture" &&
      ctx.password === password
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept, _reject, info) => {
          windows.push([info.rows, info.cols]);
          accept();
        });
        session.on("window-change", (_accept, _reject, info) =>
          windows.push([info.rows, info.cols]),
        );
        session.on("shell", (accept) => {
          const stream = accept();
          stream.on("error", () => {});
          if (immediate) {
            // shell acceptance and exit-status can arrive in the same packet.
            stream.exit(code);
            stream.end(marker + "\n");
          } else {
            stream.write(marker + "\n");
            let input = "";
            stream.on("data", (bytes: Buffer) => {
              inputs.push(bytes.toString());
              input += bytes.toString();
              if (!input.includes("finish\n")) return;
              stream.write(password.slice(0, 12));
              stream.write(password.slice(12) + "\n");
              stream.exit(code);
              stream.end("fixture-input-accepted\n");
            });
          }
        });
      }),
    );
  });
  const store = new Store(dir, "6".repeat(64));
  let core: Awaited<ReturnType<typeof startServers>> | undefined;
  let gate: Awaited<ReturnType<typeof executionGateway>> | undefined;
  const oldMock = process.env.ABILOCK_MOCK;
  const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const close = async () => {
    try {
      const results = await Promise.allSettled([gate?.close(), core?.close()]);
      for (const client of clients) client.end();
      results.push(
        ...(await Promise.allSettled([
          new Promise<void>((resolve) => ssh.close(() => resolve())),
          store.close(),
        ])),
      );
      await fs.rm(dir, { recursive: true, force: true });
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
      else process.env.ABILOCK_MOCK = oldMock;
      if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
      else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
    }
  };
  try {
    await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
    await store.init();
    core = await startServers({
      store,
      webDir: path.resolve("dist/web"),
      execToken,
      adminToken,
      adminPort: 0,
      execPort: 0,
      log: (record) => {
        logs.push(record);
        if (record.event !== "terminal") return;
        if (logFailure === "sync")
          throw new Error("synthetic terminal log failure");
        if (logFailure === "async")
          return Promise.reject(new Error("synthetic terminal log failure"));
      },
    });
    const connection: Connection = {
      alias: "TERM",
      name: "Fixture terminal",
      kind: "ssh",
      enabled: true,
      description: "synthetic terminal fixture",
      trustBoundary: "development-fixture",
      config: {
        host: "127.0.0.1",
        port: (ssh.address() as import("node:net").AddressInfo).port,
        username: "fixture",
        hostKeySHA256,
        remoteRoot: "/",
        allowShell: true,
      },
    };
    await store.saveConnection(connection, { password }, false, 0);
    gate = await executionGateway({
      coreUrl: core.execUrl,
      execToken,
      port: 0,
    });
    return {
      dir,
      connection,
      core,
      gate,
      windows,
      inputs,
      logs,
      marker,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test(
  "SSH terminal saves immediately received exit status for late consumers",
  { timeout: 15000 },
  async () => {
    for (const code of [0, 7]) {
      const f = await fixture(code);
      const controller = new AbortController();
      let terminal: Awaited<ReturnType<typeof openTerminal>> | undefined;
      try {
        terminal = await openTerminal(
          {
            connection: f.connection,
            secret: { password },
            signal: controller.signal,
            allowLocal: true,
            dataDir: f.dir,
            trace: {
              invocationId: crypto.randomUUID(),
              operationId: crypto.randomUUID(),
            },
          },
          { rows: 24, cols: 80 },
        );
        const ended = once(terminal.stream, "end");
        let output = "";
        terminal.stream.on(
          "data",
          (bytes: Buffer) => (output += bytes.toString()),
        );
        await bounded(ended);
        assert.equal(terminal.exitCode, code);
        assert.match(output, new RegExp(f.marker));
      } finally {
        terminal?.close();
        controller.abort();
        await f.close();
      }
    }
  },
);

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
  "real CLI PTY SSH crosses gateway and broker with output, trace order and exit 0/7",
  {
    timeout: 30000,
    skip: !["darwin", "linux"].includes(process.platform),
  },
  async (t) => {
    const observed = new Map<WebSocket, Record<string, unknown>[]>();
    const originalSend = WebSocket.prototype.send;
    // Observe the real bridge without replacing any reply or frame behavior.
    t.mock.method(
      WebSocket.prototype,
      "send",
      function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
        const raw = args[0];
        if (typeof raw === "string" || Buffer.isBuffer(raw)) {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
          const frames = observed.get(this) ?? [];
          frames.push(frame);
          observed.set(this, frames);
        }
        originalSend.apply(this, args);
      },
    );
    for (const immediate of [false, true]) {
      for (const code of [0, 7]) {
        observed.clear();
        const f = await fixture(
          code,
          immediate,
          immediate ? (code === 0 ? "sync" : "async") : undefined,
        );
        let child: ChildProcess | undefined;
        let stdout = "",
          stderr = "",
          sent = false;
        try {
          child = spawn(
            "/usr/bin/python3",
            [
              "-c",
              ptyHarness,
              process.execPath,
              path.resolve("bin/abl.mjs"),
              "ssh",
              "TERM",
              "--abl-trace",
            ],
            {
              env: {
                ABILOCK_ENDPOINT: f.gate.url,
                ABILOCK_EXEC_TOKEN: execToken,
                PATH: path.dirname(process.execPath),
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          child.stdout?.on("data", (bytes: Buffer) => {
            stdout += bytes.toString();
            if (!immediate && !sent && stdout.includes(f.marker)) {
              sent = true;
              child?.stdin?.write("finish\n");
            }
          });
          child.stderr?.on(
            "data",
            (bytes: Buffer) => (stderr += bytes.toString()),
          );
          const exited = await bounded(once(child, "close"));
          assert.equal(exited[0], code, stdout + stderr);
          assert(stdout.includes(f.marker), stdout + stderr);
          assert(!stdout.includes(password));
          assert(!stdout.includes(execToken));
          assert(!stdout.includes("INVALID_TERMINAL_FRAME"));
          if (!immediate) {
            assert(f.inputs.join("").includes("finish\n"));
            assert(stdout.includes("fixture-input-accepted"));
            assert(stdout.includes("[REDACTED]"));
            assert(f.windows.length >= 2);
          }
          const serverFrames = [...observed.values()].filter(
            (frames) => frames[0]?.direction === "server",
          );
          assert.equal(serverFrames.length, 2); // Core and gateway forwarded frames.
          const first = serverFrames[0][0];
          assert.match(String(first.operationId), uuid);
          assert.match(String(first.invocationId), uuid);
          for (const frames of serverFrames) {
            assert.equal(frames[0].type, "ready");
            assert.equal(frames.at(-1)?.type, "exit");
            assert.equal(frames.at(-1)?.code, code);
            frames.forEach((frame, index) => {
              assert.equal(frame.direction, "server");
              assert.equal(frame.sequence, index + 1);
            assert.equal(frame.operationId, first.operationId);
            assert.equal(frame.invocationId, first.invocationId);
            assert.equal(frame.requestId, first.requestId);
            assert.equal(frame.operationIdSource, "server");
            });
          }
          const clientFrames = [...observed.values()].find(
            (frames) => frames[0]?.direction === "client",
          );
          assert(clientFrames);
          assert.equal(clientFrames[0].type, "init");
          assert.deepEqual(clientFrames[0].trace, {
            invocationId: first.invocationId,
          });
          assert(!Object.hasOwn(clientFrames[0], "rows"));
          assert(!Object.hasOwn(clientFrames[0], "cols"));
          clientFrames.forEach((frame, index) => {
            assert.equal(frame.direction, "client");
            assert.equal(frame.sequence, index + 1);
          });
          assert(
            stdout.includes(`operationId=${first.operationId} source=server`),
          );
          // Await core cleanup; the Python child closing precedes log completion.
          const logDeadline = Date.now() + 1000;
          while (!f.logs.some((record) => record.event === "terminal")) {
            if (Date.now() >= logDeadline)
              throw new Error("terminal log timeout");
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
          const terminalLogs = f.logs.filter(
            (record) => record.event === "terminal",
          );
          assert.equal(terminalLogs.length, 1);
          assert.equal(terminalLogs[0].status, code);
          assert.equal(terminalLogs[0].operationId, first.operationId);
          assert.equal(terminalLogs[0].invocationId, first.invocationId);
          assert.equal(terminalLogs[0].messagesOut, serverFrames[0].length);
          assert.equal(terminalLogs[0].messagesIn, clientFrames.length);
      } finally {
        try {
          if (child && child.exitCode === null) {
            const closed = once(child, "close");
            child.kill("SIGTERM");
            await bounded(closed);
          }
        } finally {
          await f.close();
        }
        }
      }
    }
  },
);
