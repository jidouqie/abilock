import assert from "node:assert/strict";
import test from "node:test";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once, getEventListeners } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { remoteFetch } from "../bin/remote-fetch.mjs";
import limits from "../request-limits.json" with { type: "json" };

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    async idle() {
      for (let i = 0; i < 100 && sockets.size; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(sockets.size, 0, "request sockets must close");
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("remote transport keeps streamed bytes and request headers/body", async () => {
  let recorded: unknown;
  const f = await fixture((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      recorded = {
        method: request.method,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      };
      response.setHeader("x-test", "present");
      response.write(Buffer.from([0, 255]));
      setTimeout(() => response.end(Buffer.from([10, 13])), 25);
    });
  });
  const controller = new AbortController();
  try {
    const response = await remoteFetch(f.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-key" },
      body: Buffer.from('{"task":"mock"}'),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-test"), "present");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 10, 13]);
    assert.deepEqual(recorded, {
      method: "POST", contentType: "application/json", authorization: "Bearer fake-key",
      body: '{"task":"mock"}',
    });
    await f.idle();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { await f.close(); }
});

test("delayed headers and delayed body only use the caller's deadline", async () => {
  // A short simulated wait exercises both phases without waiting seven minutes.
  // The global pooled agent has a 10 ms timeout; agent:false must not inherit it.
  const agentOptions = (http.globalAgent as http.Agent & {
    options: { timeout?: number };
  }).options;
  const oldTimeout = agentOptions.timeout;
  agentOptions.timeout = 10;
  const f = await fixture((_request, response) => {
    setTimeout(() => {
      response.write("first");
      setTimeout(() => response.end("last"), 80);
    }, 80);
  });
  try {
    const started = Date.now();
    const response = await remoteFetch(f.url, { signal: AbortSignal.timeout(2000) });
    assert.ok(Date.now() - started >= 50);
    assert.equal(await response.text(), "firstlast");
    await f.idle();
  } finally {
    if (oldTimeout === undefined) delete agentOptions.timeout;
    else agentOptions.timeout = oldTimeout;
    await f.close();
  }
});

test("cancellation before headers is fixed and releases the socket and listener", async () => {
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(() => started());
  const controller = new AbortController();
  try {
    const pending = remoteFetch(f.url, { signal: controller.signal });
    const checked = assert.rejects(pending, {
      name: "AbortError", code: "REMOTE_CANCELLED", message: "远程执行请求已取消或超时",
    });
    await active;
    controller.abort(new Error("fake-sensitive-cancel-reason"));
    await checked;
    await f.idle();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(remoteFetch(f.url, { signal: controller.signal }), { name: "AbortError" });
  } finally { await f.close(); }
});

test("abort after headers and cancelling an unread body close both sockets", async () => {
  const f = await fixture((_request, response) => response.write("partial"));
  const controller = new AbortController();
  try {
    const response = await remoteFetch(f.url, { signal: controller.signal });
    const reading = assert.rejects(response.text(), { name: "AbortError", code: "REMOTE_CANCELLED" });
    controller.abort();
    await reading;
    await f.idle();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    const unused = await remoteFetch(f.url);
    await unused.body!.cancel();
    await f.idle();
  } finally { await f.close(); }
});

test("a severed response body cannot become a successful partial answer", async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.write("partial");
    setTimeout(() => response.socket?.destroy(), 25);
  });
  try {
    const response = await remoteFetch(f.url);
    await assert.rejects(response.text(), {
      code: "REMOTE_CONNECTION", message: "远程执行连接失败或响应不完整；不会自动重试",
    });
    await f.idle();
  } finally { await f.close(); }
});

test("redirects are rejected without following or replaying credentials", async () => {
  const calls: string[] = [];
  const f = await fixture((request, response) => {
    calls.push(request.url!);
    response.writeHead(302, { location: "/do-not-follow" });
    response.end();
  });
  try {
    await assert.rejects(remoteFetch(f.url + "/first", {
      headers: { authorization: "Bearer fake-key" }, redirect: "error",
    }), { code: "REMOTE_REDIRECT" });
    assert.deepEqual(calls, ["/first"]);
    await f.idle();
  } finally { await f.close(); }
});

test("concurrent requests have independent cancellation and preserve empty responses", async () => {
  const f = await fixture((request, response) => {
    if (request.url === "/wait") response.write("waiting");
    else if (request.url === "/empty") { response.writeHead(204); response.end(); }
    else response.end("complete");
  });
  const controller = new AbortController();
  try {
    const [waiting, completed, empty] = await Promise.all([
      remoteFetch(f.url + "/wait", { signal: controller.signal }),
      remoteFetch(f.url + "/done"), remoteFetch(f.url + "/empty"),
    ]);
    const stopped = assert.rejects(waiting.text(), { name: "AbortError" });
    controller.abort();
    await stopped;
    assert.equal(await completed.text(), "complete");
    assert.equal(empty.body, null);
    assert.equal(await empty.text(), "");
    await f.idle();
  } finally { await f.close(); }
});

test("callers without a signal get the configured finite fallback", async (t) => {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    return original(callback, delay === limits.httpClientTimeoutMs ? 30 : delay, ...args);
  });
  const f = await fixture(() => {});
  try {
    await assert.rejects(remoteFetch(f.url), { name: "AbortError", code: "REMOTE_CANCELLED" });
    assert.ok(delays.includes(limits.httpClientTimeoutMs));
    await f.idle();
  } finally { await f.close(); }
});

test("invalid requests and raw server errors cannot echo supplied secrets", async () => {
  await assert.rejects(remoteFetch("http://user:fake-secret@127.0.0.1/"), {
    code: "REMOTE_INPUT", message: "远程执行请求参数无效",
  });
  const f = await fixture((request) => request.socket.destroy());
  try {
    await assert.rejects(remoteFetch(f.url + "/fake-secret", {
      headers: { authorization: "Bearer fake-key" },
    }), { code: "REMOTE_CONNECTION", message: "远程执行连接失败或响应不完整；不会自动重试" });
    await f.idle();
  } finally { await f.close(); }
});
