import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { EventEmitter, getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import os from "node:os";
import { pinnedAddress } from "../src/security.js";
import { AppError } from "../src/schema.js";
import { upstream } from "../src/transport.js";

async function watchdog<T>(pending: Promise<T>) {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS wait did not stop")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function socketGuards() {
  const forbidden = () => {
    throw new Error("Cancelled DNS must not start an HTTP socket");
  };
  const plain = mock.method(http, "request", forbidden);
  const secure = mock.method(https, "request", forbidden);
  return {
    assertUnused() {
      assert.equal(plain.mock.callCount(), 0);
      assert.equal(secure.mock.callCount(), 0);
    },
    restore() {
      plain.mock.restore();
      secure.mock.restore();
    },
  };
}

test("HTTP final DNS rejects broker public address and mixed metadata results before any socket", async () => {
  const own = "8.8.8.8";
  const interfaces = mock.method(os, "networkInterfaces", () => ({
    synthetic: [
      {
        address: own,
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${own}/24`,
      },
    ],
  }));
  try {
    for (const rows of [
      [{ address: own, family: 4 }],
      [
        { address: "1.1.1.1", family: 4 },
        { address: own, family: 4 },
      ],
      [
        { address: "1.1.1.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ]) {
      const lookup = mock.method(dns, "lookup", async () => rows);
      try {
        await assert.rejects(
          pinnedAddress(new URL("https://synthetic.example.com")),
          (error: unknown) => error instanceof AppError,
        );
      } finally {
        lookup.mock.restore();
      }
    }
    const lookup = mock.method(dns, "lookup", async () => [
      { address: "1.1.1.1", family: 4 },
    ]);
    try {
      assert.deepEqual(
        await pinnedAddress(new URL("https://synthetic.example.com")),
        { address: "1.1.1.1", family: 4 },
      );
    } finally {
      lookup.mock.restore();
    }
    await assert.rejects(
      pinnedAddress(new URL(`https://${own}`)),
      (error: unknown) =>
        error instanceof AppError && error.code === "BROKER_TARGET_REJECTED",
    );
  } finally {
    interfaces.mock.restore();
  }
});

test("HTTP deadline includes pending final DNS; its late result cannot open a socket", async () => {
  let release!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise<{ address: string; family: number }[]>((resolve) => {
        release = resolve;
      }),
  );
  const guards = socketGuards();
  const controller = new AbortController();
  try {
    const started = performance.now();
    await watchdog(
      assert.rejects(
        upstream(
          new URL("https://synthetic.example.com"),
          "GET",
          {},
          undefined,
          100,
          controller.signal,
        ),
        { code: "UPSTREAM_TIMEOUT", status: 504 },
      ),
    );
    assert.ok(performance.now() - started < 1000);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    guards.assertUnused();
    release([{ address: "1.1.1.1", family: 4 }]);
    await nextTurn();
    guards.assertUnused();
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    lookup.mock.restore();
    guards.restore();
  }
});

test("HTTP cancellation interrupts pending final DNS and ignores a late denied result", async () => {
  let release!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise<{ address: string; family: number }[]>((resolve) => {
        release = resolve;
      }),
  );
  const guards = socketGuards();
  const controller = new AbortController();
  try {
    const pending = upstream(
      new URL("https://synthetic.example.com"),
      "GET",
      {},
      undefined,
      10000,
      controller.signal,
    );
    const rejected = assert.rejects(pending, {
      code: "CANCELLED",
      status: 499,
    });
    controller.abort();
    await watchdog(rejected);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    guards.assertUnused();
    release([{ address: "169.254.169.254", family: 4 }]);
    await nextTurn();
    guards.assertUnused();
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    lookup.mock.restore();
    guards.restore();
  }
});

test("HTTP already-cancelled calls perform neither DNS nor request construction", async () => {
  const lookup = mock.method(dns, "lookup", () => {
    throw new Error("Already-cancelled calls must not resolve DNS");
  });
  const guards = socketGuards();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      upstream(
        new URL("https://synthetic.example.com"),
        "GET",
        {},
        undefined,
        10000,
        controller.signal,
      ),
      { code: "CANCELLED", status: 499 },
    );
    assert.equal(lookup.mock.callCount(), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    guards.assertUnused();
  } finally {
    lookup.mock.restore();
    guards.restore();
  }
});

test("HTTP uses its single validated DNS result and detaches cancellation when the request closes", async () => {
  const lookup = mock.method(dns, "lookup", async () => [
    { address: "1.1.1.1", family: 4 },
  ]);
  const response = new EventEmitter() as http.IncomingMessage;
  const request = new EventEmitter();
  let requestSignal: AbortSignal | undefined;
  const secure = mock.method(
    https,
    "request",
    (
      _url: URL,
      options: https.RequestOptions,
      onResponse: (response: http.IncomingMessage) => void,
    ) => {
      assert.equal(options.agent, false);
      requestSignal = options.signal;
      const pinLookup = options.lookup as (
        hostname: string,
        options: unknown,
        callback: (
          error: Error | null,
          address: string,
          family: number,
        ) => void,
      ) => void;
      pinLookup("synthetic.example.com", {}, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, "1.1.1.1");
        assert.equal(family, 4);
      });
      return Object.assign(request, {
        write: () => true,
        end: () => queueMicrotask(() => onResponse(response)),
      }) as unknown as http.ClientRequest;
    },
  );
  const controller = new AbortController();
  try {
    assert.equal(
      await upstream(
        new URL("https://synthetic.example.com"),
        "GET",
        {},
        undefined,
        100,
        controller.signal,
      ),
      response,
    );
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(secure.mock.callCount(), 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    request.emit("close");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    assert.equal(requestSignal?.aborted, false);
  } finally {
    request.emit("close");
    lookup.mock.restore();
    secure.mock.restore();
  }
});
