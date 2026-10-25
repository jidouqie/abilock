import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { readBounded, upstream } from "../src/transport.js";

const hostname = "synthetic.example.test";
const addresses = [
  { address: "1.1.1.1", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];

for (const pinned of addresses) {
  test(`HTTP pinned IPv${pinned.family} lookup returns the required single/all shapes`, async () => {
    const resolved = mock.method(dns, "lookup", async () => [
      pinned,
      addresses.find((address) => address !== pinned)!,
    ]);
    const interfaces = mock.method(os, "networkInterfaces", () => ({}));
    const response = new EventEmitter() as http.IncomingMessage;
    const request = new EventEmitter();
    const secure = mock.method(
      https,
      "request",
      (
        url: URL,
        options: https.RequestOptions,
        onResponse: (response: http.IncomingMessage) => void,
      ) => {
        assert.equal(url.hostname, hostname);
        assert.equal(options.agent, false);
        assert.ok(options.lookup);
        for (const all of [false, true]) {
          let calls = 0;
          options.lookup(hostname, { all }, (error, address, family) => {
            calls++;
            assert.equal(error, null);
            if (all) {
              assert.deepEqual(address, [pinned]);
              assert.equal(family, undefined);
            } else {
              assert.equal(address, pinned.address);
              assert.equal(family, pinned.family);
            }
          });
          assert.equal(calls, 1);
        }
        return Object.assign(request, {
          end: () => queueMicrotask(() => onResponse(response)),
        }) as unknown as http.ClientRequest;
      },
    );
    try {
      assert.equal(
        await upstream(
          new URL(`https://${hostname}/`),
          "GET",
          {},
          undefined,
          1000,
          new AbortController().signal,
        ),
        response,
      );
      assert.equal(resolved.mock.callCount(), 1);
      assert.deepEqual(resolved.mock.calls[0].arguments, [
        hostname,
        { all: true },
      ]);
      assert.equal(secure.mock.callCount(), 1);
    } finally {
      request.emit("close");
      secure.mock.restore();
      interfaces.mock.restore();
      resolved.mock.restore();
    }
  });
}

// The production DNS boundary still validates public synthetic addresses. Only
// this test's final socket callback maps that validated pin to its owned server.
// No request can leave loopback, and no production private-address exception is added.
function ownedSocketLookup(
  options: http.RequestOptions,
  observeAll: (all: boolean) => void,
): NonNullable<http.RequestOptions["lookup"]> {
  const lookup = options.lookup;
  assert.ok(lookup);
  return (host, lookupOptions, callback) => {
    assert.equal(host, hostname);
    observeAll(lookupOptions.all === true);
    lookup(host, lookupOptions, (error, address, family) => {
      assert.equal(error, null);
      if (lookupOptions.all) {
        assert.deepEqual(address, [addresses[0]]);
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      } else {
        assert.equal(address, addresses[0].address);
        assert.equal(family, 4);
        callback(null, "127.0.0.1", 4);
      }
    });
  };
}

async function listen(server: http.Server | https.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server | https.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(server.listening, false);
}

for (const autoSelectFamily of [false, true]) {
  test(`Node hostname HTTP socket works with autoSelectFamily=${autoSelectFamily} and does not follow redirects`, async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url!);
      assert.equal(req.headers.host, `${hostname}:${port}`);
      assert.equal(req.headers.authorization, "Bearer synthetic-only");
      if (req.url === "/redirect") {
        res.writeHead(302, {
          location: `http://${hostname}:${port}/not-called`,
        });
        res.end("redirect");
      } else res.end("synthetic reply");
    });
    const port = await listen(server);
    const resolved = mock.method(dns, "lookup", async () => addresses);
    const interfaces = mock.method(os, "networkInterfaces", () => ({}));
    const allValues: boolean[] = [];
    const original = http.request;
    const outgoing = mock.method(
      http,
      "request",
      (
        url: URL,
        options: http.RequestOptions,
        callback: (response: http.IncomingMessage) => void,
      ) => {
        const socketOptions = {
          ...options,
          autoSelectFamily,
          lookup: ownedSocketLookup(options, (all) => allValues.push(all)),
        };
        return original(url, socketOptions, callback);
      },
    );
    try {
      for (const path of ["/reply", "/redirect"]) {
        const response = await upstream(
          new URL(`http://${hostname}:${port}${path}`),
          "GET",
          { authorization: "Bearer synthetic-only" },
          undefined,
          1000,
          new AbortController().signal,
        );
        assert.equal(response.statusCode, path === "/reply" ? 200 : 302);
        assert.equal(
          (await readBounded(response, 1024)).toString(),
          path === "/reply" ? "synthetic reply" : "redirect",
        );
      }
      assert.deepEqual(requests, ["/reply", "/redirect"]);
      assert.deepEqual(allValues, [autoSelectFamily, autoSelectFamily]);
      assert.equal(resolved.mock.callCount(), 2);
      assert.equal(outgoing.mock.callCount(), 2);
    } finally {
      outgoing.mock.restore();
      interfaces.mock.restore();
      resolved.mock.restore();
      await close(server);
    }
  });
}

test("Node HTTPS hostname reaches TLS with all-address lookup and keeps certificate verification", async () => {
  const [key, cert] = await Promise.all([
    fs.readFile(
      new URL("./fixtures/cloud-selfsigned-key.pem", import.meta.url),
    ),
    fs.readFile(
      new URL("./fixtures/cloud-selfsigned-cert.pem", import.meta.url),
    ),
  ]);
  let requests = 0;
  const server = https.createServer({ key, cert }, (_req, res) => {
    requests++;
    res.end("must not reach HTTP with an untrusted certificate");
  });
  const port = await listen(server);
  const resolved = mock.method(dns, "lookup", async () => addresses);
  const interfaces = mock.method(os, "networkInterfaces", () => ({}));
  const allValues: boolean[] = [];
  const original = https.request;
  const outgoing = mock.method(
    https,
    "request",
    (
      url: URL,
      options: https.RequestOptions,
      callback: (response: http.IncomingMessage) => void,
    ) => {
      const socketOptions = {
        ...options,
        autoSelectFamily: true,
        lookup: ownedSocketLookup(options, (all) => allValues.push(all)),
      };
      return original(url, socketOptions, callback);
    },
  );
  try {
    await assert.rejects(
      upstream(
        new URL(`https://${hostname}:${port}/`),
        "GET",
        {},
        undefined,
        1000,
        new AbortController().signal,
      ),
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    );
    assert.equal(requests, 0);
    assert.deepEqual(allValues, [true]);
    assert.equal(resolved.mock.callCount(), 1);
    assert.equal(outgoing.mock.callCount(), 1);
  } finally {
    outgoing.mock.restore();
    interfaces.mock.restore();
    resolved.mock.restore();
    await close(server);
  }
});
