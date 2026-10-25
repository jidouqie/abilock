import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import os from "node:os";
import { EventEmitter, once, getEventListeners } from "node:events";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, platformSchema } from "../src/schema.js";
import { upstream, upstreamFailure } from "../src/transport.js";
import { execute } from "../src/proxy.js";
import type { Store } from "../src/store.js";
import { responseRedactor } from "../src/response-redaction.js";

async function filtered(
  type: string,
  raw: Buffer | string,
  secrets: string[],
  split = 1,
) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const source = function* () {
    for (let at = 0; at < bytes.length; at += split)
      yield bytes.subarray(at, at + split);
  };
  const result: Buffer[] = [];
  for await (const chunk of Readable.from(source()).pipe(
    responseRedactor(type, secrets),
  ))
    result.push(chunk);
  return Buffer.concat(result);
}
async function watchdog<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture did not finish")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("JSON scalar and key/string echoes stay valid across every byte split", async () => {
  const raw =
    '{"true":true,"n":1234,"negative":-123,"nullValue":null,"v":"true 123","other":8}';
  const result = await filtered("application/json", raw, [
    "true",
    "123",
    "null",
  ]);
  assert.deepEqual(JSON.parse(result.toString()), {
    "[REDACTED]": "[REDACTED]",
    n: "[REDACTED]",
    negative: "[REDACTED]",
    "[REDACTED]Value": "[REDACTED]",
    v: "[REDACTED] [REDACTED]",
    other: 8,
  });
});
test("JSON quotes, escapes, surrogate pairs and Unicode filter decoded content", async () => {
  const raw =
    '{"key":"a\\"b\\\\c\\tc","u":"\\uD83D\\uDE00猫","raw":"😀猫","other":"\\u0061\\/"}';
  const result = await filtered("application/problem+json", raw, [
    '"',
    "\\",
    "\t",
    "😀猫",
  ]);
  assert.deepEqual(JSON.parse(result.toString()), {
    key: "a[REDACTED]b[REDACTED]c[REDACTED]c",
    u: "[REDACTED]",
    raw: "[REDACTED]",
    other: "a/",
  });
  assert.ok(result.toString().includes('"other":"\\u0061\\/"'));
});
test("unmatched JSON is byte-identical, including original escaping and number spelling", async () => {
  const raw = Buffer.from(
    ' \r\n{ "\\u006B" : "\\/\\u0061😀", "n": -1.23e+4, "arr":[false,null] }\n',
  );
  assert.deepEqual(
    await filtered("application/json; charset=utf-8", raw, ["not-present"]),
    raw,
  );
  assert.equal((await filtered("application/json", "", ["true"])).length, 0);
});
test("JSON grammar delimiters are preserved even when they equal short credentials", async () => {
  const result = await filtered(
    "application/json",
    '{"v":"{","arr":["data"]}',
    ["{", "}", ":", '"', "data"],
  );
  assert.deepEqual(JSON.parse(result.toString()), {
    v: "[REDACTED]",
    arr: ["[REDACTED]"],
  });
});
test("JSON strings deliver bounded output before their token or connection ends", async () => {
  const filter = responseRedactor("application/json", ["not-present"]);
  const first = once(filter, "data");
  filter.write(Buffer.from('{"x":"' + "z".repeat(64 * 1024)));
  assert.ok((await watchdog(first))[0].length <= 16 * 1024);
  const ended = once(filter, "end");
  filter.resume();
  filter.end('"}');
  await watchdog(ended);
});
test("JSON and plain SSE data preserve framing and filter multiline semantic data", async () => {
  const raw =
    'data: {\r\ndata: "ok":true,\r\ndata: "echo":"data"\r\ndata: }\r\n\r\ndata: a\ndata: b\n\ndata: [DONE]\n\n';
  const result = (
    await filtered("text/event-stream", raw, ["true", "data", "a\nb"])
  ).toString();
  const events = result.split(/\r?\n\r?\n/).filter(Boolean);
  const payload = (event: string) =>
    event
      .split(/\r?\n/)
      .map((line) => line.slice(6))
      .join("\n");
  assert.deepEqual(JSON.parse(payload(events[0])), {
    ok: "[REDACTED]",
    echo: "[REDACTED]",
  });
  assert.equal(events[1], "data: [REDACTED]\ndata: ");
  assert.equal(events[2], "data: [DONE]");
  assert.ok(result.startsWith("data: {\r\ndata:"));
});
test("SSE non-JSON payloads that resemble JSON are filtered as text, not rejected", async () => {
  const result = await filtered(
    "text/event-stream",
    "data: {ordinary text data\n\n",
    ["{", "data"],
  );
  assert.equal(
    result.toString(),
    "data: [REDACTED]ordinary text [REDACTED]\n\n",
  );
});
test("multiline SSE data matching spans interleaved metadata without changing its fields", async () => {
  const result = await filtered(
    "text/event-stream",
    "data: a\nevent: 更新\nid: unchanged\ndata: b\n\n",
    ["a\nb"],
  );
  assert.equal(
    result.toString(),
    "data: [REDACTED]\nevent: 更新\nid: unchanged\ndata: \n\n",
  );
});
test("SSE metadata/comment values filter while field names and final data framing remain fixed", async () => {
  const raw = "event: event\nid: secret\nretry: 99\n: secret\ndata: data\n\n";
  const result = await filtered("text/event-stream", raw, [
    "event",
    "secret",
    "99",
    "data",
  ]);
  assert.equal(
    result.toString(),
    "event: [REDACTED]\nid: [REDACTED]\nretry: [REDACTED]\n: [REDACTED]\ndata: [REDACTED]\n\n",
  );
  assert.equal(
    (await filtered("text/event-stream", "data: a\n\n", ["a\n"])).toString(),
    "data: a\n\n",
  );
});
test("unmatched SSE is byte-identical through BOM, CRLF, CR, empty fields and EOF dispatch", async () => {
  const raw = Buffer.from(
    '\uFEFFdata: {"n":true}\r\n\r\n: comment\revent: update\rdata:  ordinary\r\rdata: {"end":"\\u0061"}',
  );
  assert.deepEqual(
    await filtered("text/event-stream", raw, ["not-present"]),
    raw,
  );
});
test("SSE dispatches each complete event without waiting for later events or EOF", async () => {
  const filter = responseRedactor("text/event-stream", ["true"]);
  const first = once(filter, "data");
  filter.write('data: {"ok":true}\n\n');
  assert.equal(
    (await watchdog(first))[0].toString(),
    'data: {"ok":"[REDACTED]"}\n\n',
  );
  const ended = once(filter, "end");
  filter.resume();
  filter.end("data: ordinary");
  await watchdog(ended);
});
test("JSON/SSE use shared standard URL/form matching with mixed percent hex case", async () => {
  const secret = "review/secret+ with:猫";
  const encoded = new URLSearchParams({ key: secret })
    .toString()
    .slice(4)
    .replace(/%[0-9A-F]{2}/g, (value, at) =>
      at % 2 ? value.toLowerCase() : value,
    );
  const json = await filtered(
    "application/json",
    JSON.stringify({ value: encoded }),
    [secret],
  );
  assert.equal(JSON.parse(json.toString()).value, "[REDACTED]");
  const sse = await filtered("text/event-stream", "data: " + encoded + "\n\n", [
    secret,
  ]);
  assert.equal(sse.toString(), "data: [REDACTED]\n\n");
});
test("binary stays byte-identical when unmatched and retains split credential redaction", async () => {
  const raw = Buffer.from([0, 1, 255, 8, 13]);
  assert.deepEqual(
    await filtered("application/octet-stream", raw, ["not-present"]),
    raw,
  );
  assert.equal(
    (
      await filtered("application/octet-stream", "prefix-secret-suffix", [
        "secret",
      ])
    ).toString(),
    "prefix-[REDACTED]-suffix",
  );
});
test("large chunk JSON/SSE output preserves backpressure and byte identity", async () => {
  for (const type of ["application/json", "text/event-stream"]) {
    const raw = Buffer.from(
      type === "application/json"
        ? JSON.stringify({ text: "z".repeat(256 * 1024) })
        : "data: " + "z".repeat(256 * 1024) + "\n\ndata: tail\n\n",
    );
    const output: Buffer[] = [];
    await pipeline(
      Readable.from([raw]),
      responseRedactor(type, ["not-present"]),
      new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          output.push(Buffer.from(chunk));
          setImmediate(callback);
        },
      }),
    );
    assert.deepEqual(Buffer.concat(output), raw);
    assert.ok(output.every((chunk) => chunk.length <= 16 * 1024));
  }
});
test("EOF scalar output fully drains through a slow sink without a trailing delimiter", async () => {
  const raw = Buffer.from("1".repeat(256 * 1024));
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([raw]),
    responseRedactor("application/json", ["not-present"]),
    new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    }),
  );
  assert.deepEqual(Buffer.concat(chunks), raw);
  assert.ok(chunks.every((chunk) => chunk.length <= 16 * 1024));
});
test("SSE unknown field names and colon-spanning echoes filter while remaining ignored fields", async () => {
  const cases = [
    [
      "synthetic-c05-secret: safe\n\n",
      "synthetic-c05-secret",
      "[REDACTED]: safe\n\n",
    ],
    ["synthetic-c05-secret\n\n", "synthetic-c05-secret", "[REDACTED]\n\n"],
    ["secret:key\n\n", "secret:key", "[REDACTED]\n\n"],
    ["data-secret: value\n\n", "-secret", "data[REDACTED]: value\n\n"],
  ];
  for (const [raw, secret, expected] of cases) {
    const result = (
      await filtered("text/event-stream", raw, [secret])
    ).toString();
    assert.equal(result, expected);
    assert.ok(!result.includes(secret));
    assert.ok(
      !result
        .split(/\r?\n/)
        .some((line) => /^(data|event|id|retry)(:|$)/.test(line)),
    );
  }
  const raw = Buffer.from(
    'vendor-field: ordinary\r\nUnknownWithoutColon\r\ndata: {"ok":true}\r\n\r\n',
  );
  assert.deepEqual(
    await filtered("text/event-stream", raw, ["not-present"]),
    raw,
  );
});
test("HTTP early close rejects once instead of abandoning its deadline", async () => {
  const lookup = mock.method(dns, "lookup", async () => [
    { address: "1.1.1.1", family: 4 },
  ]);
  const interfaces = mock.method(os, "networkInterfaces", () => ({}));
  const request = new EventEmitter();
  const secure = mock.method(https, "request", () =>
    Object.assign(request, {
      end: () =>
        queueMicrotask(() => {
          request.emit("close");
          request.emit("error", new Error("later"));
        }),
    }),
  );
  const controller = new AbortController();
  try {
    await assert.rejects(
      watchdog(
        upstream(
          new URL("https://synthetic.example.com"),
          "GET",
          {},
          undefined,
          1000,
          controller.signal,
        ),
      ),
      { code: "UPSTREAM_CLOSED" },
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    lookup.mock.restore();
    interfaces.mock.restore();
    secure.mock.restore();
  }
});

// These fixtures bind only owned random loopback ports and use no Store/files,
// real upstream credentials, production services or external network targets.
async function fixture(handler: http.RequestListener) {
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  process.env.ABILOCK_MOCK = "1";
  const server = http.createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(server.listening, false);
    },
  };
}
test("ordinary HTTP rejects unsolicited 101 and closes the upgraded socket", async () => {
  let outgoingUpgrade: string | undefined;
  const f = await fixture((req, res) => {
    outgoingUpgrade = req.headers.upgrade;
    res.writeHead(101, { connection: "Upgrade", upgrade: "synthetic" });
    res.end();
  });
  const controller = new AbortController();
  try {
    await assert.rejects(
      watchdog(
        upstream(
          new URL(f.url),
          "GET",
          {},
          undefined,
          1000,
          controller.signal,
          true,
        ),
      ),
      { status: 502, code: "UPGRADE_UNSUPPORTED" },
    );
    assert.equal(outgoingUpgrade, undefined);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    controller.abort();
    await f.close();
  }
});
test("HTTP body deadline retains AppError after headers and through proxy pipeline", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("started\n");
  });
  const controller = new AbortController();
  let proxy: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const response = await upstream(
      new URL(f.url),
      "GET",
      {},
      undefined,
      100,
      controller.signal,
      true,
    );
    await assert.rejects(
      pipeline(
        response,
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      ).catch((error) => {
        throw upstreamFailure(response, error);
      }),
      { status: 504, code: "UPSTREAM_TIMEOUT" },
    );
    let failure: unknown;
    const store = { secrets: () => [] } as unknown as Store;
    const platform = {
      ...platformSchema.parse({
        alias: "HTTP",
        name: "synthetic",
        baseUrl: f.url,
        allowInsecureLocal: true,
        auth: { type: "none" },
        rules: [{ method: "GET", path: "/" }],
      }),
      revision: 1,
      updatedAt: "synthetic",
    };
    proxy = await fixture(async (_req, res) => {
      try {
        await execute(
          store,
          platform,
          { method: "GET", path: "/", timeoutMs: 100 },
          res,
          new AbortController().signal,
          [],
          "synthetic-request",
        );
      } catch (error) {
        failure = error;
        res.destroy();
      }
    });
    const result = await fetch(proxy.url);
    assert.equal(result.status, 200);
    await assert.rejects(result.text());
    await delay(10);
    assert.ok(failure instanceof AppError);
    assert.equal(failure.code, "UPSTREAM_TIMEOUT");
  } finally {
    controller.abort();
    await proxy?.close();
    await f.close();
  }
});
test("HTTP response-body caller cancellation preserves the caller's frozen AppError", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200);
    res.write("started");
  });
  const controller = new AbortController();
  try {
    const response = await upstream(
      new URL(f.url),
      "GET",
      {},
      undefined,
      1000,
      controller.signal,
      true,
    );
    const reason = Object.freeze(
      new AppError(499, "SYNTHETIC_CANCELLED", "synthetic cancellation"),
    );
    const waiting = pipeline(
      response,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    controller.abort(reason);
    await assert.rejects(
      waiting.catch((error) => {
        throw upstreamFailure(response, error);
      }),
      (error) => error === reason,
    );
  } finally {
    controller.abort();
    await f.close();
  }
});
