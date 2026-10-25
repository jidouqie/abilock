import { assertLockReleased } from "./helpers/store-lock.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { loadLocalRuntime } from "../src/local-state.js";

const cli = new URL("../bin/abl.mjs", import.meta.url).pathname;
const synthetic = "synthetic-browser-diagnostic-never-output";
const browserSupported = ["darwin", "linux"].includes(process.platform);

async function listen() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

async function stopListener(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function freePort() {
  const { server, port } = await listen();
  await stopListener(server);
  return port;
}

async function portIsOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function bounded<T>(promise: Promise<T>, label: string, duration = 6000) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), duration);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function eventually<T>(
  check: () => Promise<T | undefined>,
  label: string,
) {
  const until = Date.now() + 6000;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < until);
  throw new Error(label);
}

type OpenCall = { args: string[]; pid: number; health?: unknown };

async function fixture(
  mode: "success" | "failure" | "hang" | "stubborn",
  port?: number,
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-config-open-"));
  const dir = path.join(home, ".abilock");
  const log = path.join(home, "opened.jsonl");
  const stopped = path.join(home, "opener-stopped");
  const adminPort = port ?? (await freePort());
  let execPort = await freePort();
  while (execPort === adminPort) execPort = await freePort();
  const runtime = await loadLocalRuntime({ dir });
  await runtime.store.close();
  const configPath = path.join(dir, "service.env");
  const config = (await fs.readFile(configPath, "utf8"))
    .replace(/^ABILOCK_ADMIN_PORT=\d+$/m, `ABILOCK_ADMIN_PORT=${adminPort}`)
    .replace(/^ABILOCK_EXEC_PORT=\d+$/m, `ABILOCK_EXEC_PORT=${execPort}`);
  await fs.writeFile(configPath, config, { mode: 0o600 });
  const opener = path.join(
    home,
    process.platform === "darwin" ? "open" : "xdg-open",
  );
  await fs.writeFile(
    opener,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const url = args.at(-1);
const mode = ${JSON.stringify(mode)};
const call = { args, pid: process.pid };
try { call.health = await (await fetch(url + "health")).json(); }
catch { call.health = "not-ready"; }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
if (mode === "failure") {
  console.error(${JSON.stringify(synthetic)});
  process.exitCode = 1;
} else if (mode === "hang" || mode === "stubborn") {
  process.once("SIGTERM", () => {
    fs.writeFileSync(${JSON.stringify(stopped)}, mode === "hang" ? "SIGTERM" : "SIGTERM-ignored");
    if (mode === "hang") process.exit(0);
  });
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o700 },
  );
  const readCalls = async (): Promise<OpenCall[]> => {
    try {
      return (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as OpenCall);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  let stdout = "",
    stderr = "";
  const child = spawn(process.execPath, [cli, "config", "--json"], {
    cwd: home,
    env: {
      ABILOCK_DEVELOPMENT: "1",
      HOME: home,
      USERPROFILE: home,
      PATH: [home, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
      LANG: "en_US.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = () =>
    eventually(async () => {
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.event === "configuration-ready") {
          assert.equal(value.ok, true);
          assert.equal(value.data.temporary, true);
          assert.equal(value.data.executionMode, "local-cli");
          assert.equal(value.data.url, `http://127.0.0.1:${adminPort}`);
          return value.data.url as string;
        }
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Synthetic configuration exited before ready");
    }, "Synthetic configuration never became ready");
  const cleanup = async () => {
    try {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGINT");
      await bounded(
        completion,
        "Synthetic configuration cleanup timed out",
      ).catch(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      });
      await completion.catch(() => {});
      if (mode === "hang" || mode === "stubborn") {
        for (const call of await readCalls()) {
          try {
            process.kill(call.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  };
  return {
    home,
    dir,
    adminPort,
    execPort,
    configPath,
    config,
    stopped,
    child,
    completion,
    ready,
    readCalls,
    cleanup,
    output: () => ({ stdout, stderr }),
  };
}

async function assertClosed(value: Awaited<ReturnType<typeof fixture>>) {
  value.child.kill("SIGINT");
  assert.deepEqual(
    await bounded(
      value.completion,
      "SIGINT did not close temporary configuration",
    ),
    { code: 0, signal: null },
  );
  await assertLockReleased(path.join(value.dir, "data/service.lock"));
  assert.equal(await portIsOpen(value.adminPort), false);
  assert.equal(await portIsOpen(value.execPort), false);
  assert.equal(await fs.readFile(value.configPath, "utf8"), value.config);
  for (const call of await value.readCalls()) {
    assert.throws(
      () => process.kill(call.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  }
}

test(
  "compiled local abl config opens Chrome once after management is ready and never starts execution listening",
  { skip: !browserSupported },
  async () => {
    const value = await fixture("success");
    try {
      const url = await value.ready();
      const calls = await eventually(async () => {
        const calls = await value.readCalls();
        return calls.length ? calls : undefined;
      }, "Synthetic opener was not invoked");
      assert.deepEqual(calls[0].health, { ok: true, role: "management" });
      assert.deepEqual(
        calls[0].args,
        process.platform === "darwin"
          ? ["-a", "Google Chrome", `${url}/`]
          : [`${url}/`],
      );
      assert.equal(calls.length, 1);
      assert.equal(await portIsOpen(value.execPort), false);
      assert.deepEqual(await (await fetch(url + "/health")).json(), {
        ok: true,
        role: "management",
      });
      await assertClosed(value);
      assert.equal(value.output().stderr, "");
      assert.equal((await value.readCalls()).length, 1);
    } finally {
      await value.cleanup();
    }
  },
);

test(
  "SIGINT force-stops an owned synthetic opener that ignores SIGTERM without leaving configuration resources",
  { skip: !browserSupported },
  async () => {
    const value = await fixture("stubborn");
    try {
      await value.ready();
      await eventually(
        async () => ((await value.readCalls()).length ? true : undefined),
        "Synthetic stubborn opener was not invoked",
      );
      await assertClosed(value);
      assert.equal(await fs.readFile(value.stopped, "utf8"), "SIGTERM-ignored");
      assert.equal(value.output().stderr, "");
      assert.equal((await value.readCalls()).length, 1);
    } finally {
      await value.cleanup();
    }
  },
);

test(
  "failed browser open preserves the ready local page and emits only a fixed public warning without retry",
  { skip: !browserSupported },
  async () => {
    const value = await fixture("failure");
    try {
      const url = await value.ready();
      await eventually(
        async () => (value.output().stderr ? true : undefined),
        "No warning after synthetic opener failed",
      );
      const output = value.output();
      assert(!output.stdout.includes(synthetic));
      assert(!output.stderr.includes(synthetic));
      assert.equal(output.stderr.trim().split("\n").length, 1);
      assert.match(output.stderr, /Chrome|手动|浏览器|打开/);
      assert.equal((await value.readCalls()).length, 1);
      assert.deepEqual(await (await fetch(url + "/health")).json(), {
        ok: true,
        role: "management",
      });
      assert.equal(value.child.exitCode, null);
      await assertClosed(value);
      assert.equal((await value.readCalls()).length, 1);
    } finally {
      await value.cleanup();
    }
  },
);

test(
  "an occupied synthetic management port does not invoke the browser or retain the writer lock",
  { skip: !browserSupported },
  async () => {
    const occupied = await listen();
    let value: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      value = await fixture("success", occupied.port);
      const completion = await bounded(
        value.completion,
        "Occupied-port startup failed to exit",
      );
      assert.equal(completion.code, 1);
      assert.equal(completion.signal, null);
      assert.equal(value.output().stdout, "");
      assert(!value.output().stderr.includes(synthetic));
      assert.equal((await value.readCalls()).length, 0);
      await assertLockReleased(path.join(value.dir, "data/service.lock"));
      assert.equal(await fs.readFile(value.configPath, "utf8"), value.config);
      assert.equal(await portIsOpen(value.execPort), false);
    } finally {
      await value?.cleanup();
      await stopListener(occupied.server);
    }
  },
);

test(
  "SIGINT while the browser opener hangs closes its subprocess, management listener and writer lock without a warning",
  { skip: !browserSupported },
  async () => {
    const value = await fixture("hang");
    try {
      await value.ready();
      await eventually(
        async () => ((await value.readCalls()).length ? true : undefined),
        "Synthetic hanging opener was not invoked",
      );
      await assertClosed(value);
      assert.equal(await fs.readFile(value.stopped, "utf8"), "SIGTERM");
      assert.equal(value.output().stderr, "");
      assert.equal((await value.readCalls()).length, 1);
    } finally {
      await value.cleanup();
    }
  },
);
