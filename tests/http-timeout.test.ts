import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { requestSchema } from "../src/schema.js";
import { operationSchema } from "../src/connections.js";
import { upstream, upstreamFailure } from "../src/transport.js";
import limits from "../request-limits.json" with { type: "json" };
import { requestProgress } from "../bin/request-progress.mjs";

const previousLocal = process.env.ABILOCK_ALLOW_LOCAL;
before(() => { process.env.ABILOCK_ALLOW_LOCAL = "1"; });
after(() => {
  if (previousLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
  else process.env.ABILOCK_ALLOW_LOCAL = previousLocal;
});

test("HTTP default and explicit requests allow seven minutes without expanding protocol timeouts", () => {
  const call = { method: "POST", path: "/chat/completions" };
  assert.equal(requestSchema.parse(call).timeoutMs, 420000);
  assert.equal(requestSchema.parse({ ...call, timeoutMs: 420000 }).timeoutMs, 420000);
  assert.equal(requestSchema.parse({ ...call, timeoutMs: 100 }).timeoutMs, 100);
  assert.equal(requestSchema.safeParse({ ...call, timeoutMs: 420001 }).success, false);
  assert.equal(operationSchema.parse({ args: ["PING"] }).timeoutMs, 30000);
  assert.equal(operationSchema.safeParse({ args: [], timeoutMs: 120001 }).success, false);
  assert.ok(limits.httpClientTimeoutMs > limits.httpMaxTimeoutMs);
});

async function server(handler: http.RequestListener) {
  const listener = http.createServer(handler);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    url: new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`),
    async close() {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("headers arriving after two minutes and a body finishing before seven minutes stay readable", async (t) => {
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const f = await server((_req, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first-");
      setTimeout(() => response.end("last"), 180000);
    }, 180000);
    arrived();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = upstream(f.url, "GET", {}, undefined,
      requestSchema.parse({ method: "GET", path: "/" }).timeoutMs,
      new AbortController().signal, true);
    await Promise.race([arrival, pending]);
    t.mock.timers.tick(180000);
    const response = await pending;
    const first = new Promise<void>((resolve) => response.once("data", () => resolve()));
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    const end = once(response, "end");
    await first;
    t.mock.timers.tick(180000);
    await end;
    assert.equal(Buffer.concat(chunks).toString(), "first-last");
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("seven-minute deadline still terminates a streaming response which never finishes", async (t) => {
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) =>
    originalTimeout(callback, ms === limits.httpMaxTimeoutMs ? 100 : ms, ...args));
  let heartbeats = 0;
  const f = await server((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: still-working\n\n");
    const pulse = setInterval(() => {
      heartbeats++;
      response.write(": keep-alive\n\n");
    }, 10);
    response.once("close", () => clearInterval(pulse));
  });
  try {
    const response = await upstream(f.url, "GET", {}, undefined, limits.httpMaxTimeoutMs,
      new AbortController().signal, true);
    const error = new Promise<unknown>((resolve) => response.once("error", resolve));
    response.resume();
    const failure = upstreamFailure(response, await error);
    assert.equal((failure as { code: string }).code, "UPSTREAM_TIMEOUT");
    assert.ok(heartbeats > 0);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("progress uses stderr metadata and preserves streamed body bytes", async () => {
  const lines: string[] = [];
  let now = 0;
  const progress = requestProgress({ enabled: true, intervalMs: 10,
    now: () => now, write: (line) => lines.push(line) });
  try {
    now = 30000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(lines.some((line) => line.includes("尚未收到响应")));
    const response = progress.wrap(new Response("synthetic-content-not-for-progress"));
    assert.equal(await response.text(), "synthetic-content-not-for-progress");
    now = 60000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(lines.some((line) => line.includes("已接收")));
    assert.ok(lines.every((line) => !line.includes("synthetic-content")));
  } finally { progress.stop(); }
  const count = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, count);
});

test("actual API CLI waits beyond its former deadline and keeps progress outside JSON", async () => {
  // Scale only long application timers in the CLI; the real mock response
  // takes 220ms (220 logical seconds), beyond the former 135-second budget.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-http-deadline-"));
  const preload = path.join(dir, "clock.mjs");
  await fs.writeFile(preload, `
const originalTimeout=globalThis.setTimeout, originalInterval=globalThis.setInterval;
globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms>=30000?ms/1000:ms,...args);
globalThis.setInterval=(fn,ms,...args)=>originalInterval(fn,ms>=30000?ms/1000:ms,...args);
`);
  const f = await server((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"complete":');
        setTimeout(() => res.end('true}'), 80);
      }, 140);
    });
  });
  const child = spawn(process.execPath, ["--import", preload, path.resolve("bin/abl.mjs"),
    "api", "SYNTHETIC", "--stdin", "--json", "--abl-progress"], {
    env: { PATH: path.dirname(process.execPath), ABILOCK_ENDPOINT: f.url.href,
      ABILOCK_EXEC_TOKEN: "synthetic-only-execution-token-0001" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "close");
  child.stdin.end(JSON.stringify({ method: "POST", path: "/chat", body: { text: "synthetic" } }));
  try {
    const [code] = await exited;
    assert.equal(code, 0, stderr + stdout);
    assert.deepEqual(JSON.parse(stdout).data, { complete: true });
    assert.ok(stderr.includes("[Abilock]"));
    assert.ok(!stderr.includes("synthetic-only-execution-token"));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await f.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat metadata has its own deadline and cannot consume the API response budget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-chat-deadline-"));
  const preload = path.join(dir, "clock.mjs");
  await fs.writeFile(preload, `
const original=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms>=30000?ms/1000:ms,...args);
`);
  let calls = 0;
  const f = await server((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.startsWith("/v1/context/")) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ platform: { enabled: true,
            chat: { method: "POST", path: "/chat", model: "synthetic" },
            rules: [{ method: "POST", path: "/chat" }] } }));
        }, 80);
      } else {
        calls++;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"complete":true}');
        }, 380);
      }
    });
  });
  const child = spawn(process.execPath, ["--import", preload, path.resolve("bin/abl.mjs"),
    "api", "SYNTHETIC", "chat", "synthetic task", "--json"], {
    env: { PATH: path.dirname(process.execPath), ABILOCK_ENDPOINT: f.url.href,
      ABILOCK_EXEC_TOKEN: "synthetic-only-execution-token-0002" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr + stdout);
    assert.deepEqual(JSON.parse(stdout).data, { complete: true });
    assert.equal(calls, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await f.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
