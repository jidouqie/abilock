import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type AddressInfo } from "node:net";
import dns from "node:dns/promises";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import type { AdapterContext } from "../src/connections.js";
import { testGitConnection } from "../src/protocols/git.js";

const token = "synthetic-git-probe-token-only";
const password = "synthetic-git-probe-password-only";
const packet = (text: string) => Buffer.byteLength(text).valueOf() + 4;
function pkt(text: string) { return packet(text).toString(16).padStart(4, "0") + text; }
const advertisement = "001e# service=git-upload-pack\n0000" + pkt("a".repeat(40) + " HEAD\0multi_ack\n") + "0000";

async function httpsFixture(certificates?: { key: Buffer; cert: Buffer }) {
  const key = certificates?.key ?? await fs.readFile(new URL("./fixtures/cloud-selfsigned-key.pem", import.meta.url));
  const cert = certificates?.cert ?? await fs.readFile(new URL("./fixtures/cloud-selfsigned-cert.pem", import.meta.url));
  let mode = "valid", count = 0;
  const paths: string[] = [], methods: string[] = [];
  let entered: (() => void) | undefined;
  const server = https.createServer({ key, cert }, (req, res) => {
    count++;
    paths.push(req.url!); methods.push(req.method!);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    entered?.();
    if (mode === "hold") return;
    if (/^\d{3}$/.test(mode)) {
      res.writeHead(Number(mode), { location: "/credential-trap" });
      res.end(token + " should never appear in a probe result");
      return;
    }
    res.writeHead(200, { "content-type": mode === "html" ? "text/html" : "application/x-git-upload-pack-advertisement" });
    res.end(mode === "valid" ? advertisement
      : mode === "empty" ? "001e# service=git-upload-pack\n00000000"
        : mode === "huge" ? Buffer.alloc(1024 * 1024 + 1, 97)
          : mode === "truncated" ? advertisement.slice(0, -2)
            : mode === "html" ? `<h1>${token}</h1>`
              : "001e# service=git-upload-pack\n00000008nope0000");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dataDir = path.join(os.tmpdir(), "abilock-git-probe-absent-" + crypto.randomUUID());
  const context: AdapterContext = {
    connection: {
      alias: "GIT_PROBE", name: "Synthetic Git", kind: "git", enabled: true, description: "",
      trustBoundary: "development-fixture",
      config: { transport: "https", url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/fixed/repo.git`, authType: "bearer", identity: "synthetic", ca: cert.toString() },
    },
    secret: { token }, signal: new AbortController().signal, allowLocal: true, dataDir,
  };
  return {
    context, paths, methods,
    count: () => count,
    mode: (value: string) => { mode = value; },
    held: () => new Promise<void>((resolve) => { entered = resolve; }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await assert.rejects(fs.access(dataDir), { code: "ENOENT" });
    },
  };
}

test("Git HTTPS probe validates smart discovery but does not claim public-repository credentials, create a workspace or run RPC", async () => {
  const f = await httpsFixture();
  try {
    for (const mode of ["valid", "empty"]) {
      f.mode(mode);
      const result = await testGitConnection(f.context);
      assert.equal(result.status, "reachable");
      assert.equal(result.level, "service");
      assert.match(result.message, /公开仓库可能不验证密钥/);
      assert(!JSON.stringify(result).includes(token));
      assert(!JSON.stringify(result).includes("a".repeat(40)));
    }
    assert.deepEqual(f.methods, ["GET", "GET"]);
    assert.deepEqual(f.paths, ["/fixed/repo.git/info/refs?service=git-upload-pack", "/fixed/repo.git/info/refs?service=git-upload-pack"]);
  } finally { await f.close(); }
});

test("Git HTTPS probe rejects HTML, malformed/truncated/large data and redirects without forwarding credentials or remote text", async () => {
  const f = await httpsFixture();
  try {
    for (const mode of ["html", "malformed", "truncated", "huge", "302", "401", "403", "404", "429"]) {
      f.mode(mode);
      const before = f.count();
      await assert.rejects(testGitConnection(f.context), (error: unknown) => {
        const code = mode === "401" ? "CONNECTION_TEST_AUTH"
          : mode === "403" || mode === "404" ? "CONNECTION_TEST_PERMISSION"
            : mode === "429" ? "CONNECTION_TEST_RATE_LIMIT" : "CONNECTION_TEST_PROTOCOL";
        assert.equal((error as { code: string }).code, code);
        assert(!String(error).includes(token));
        return true;
      });
      assert.equal(f.count(), before + 1, "test must neither retry nor follow redirects");
    }
  } finally { await f.close(); }
});

test("Git HTTPS probe enforces TLS verification and cancellation without retry", async () => {
  const f = await httpsFixture();
  try {
    const untrusted = structuredClone(f.context.connection);
    delete untrusted.config.ca;
    await assert.rejects(testGitConnection({ ...f.context, connection: untrusted }), { code: "CONNECTION_TEST_TLS" });
    assert.equal(f.count(), 0);
    f.mode("hold");
    const controller = new AbortController();
    const entered = f.held();
    const probing = testGitConnection({ ...f.context, signal: controller.signal });
    await entered;
    controller.abort(new Error(token));
    await assert.rejects(probing, { code: "CONNECTION_TEST_CANCELLED" });
    assert.equal(f.count(), 1);
  } finally { await f.close(); }
});

test("Git HTTPS domain probe preserves pinned lookup and TLS identity with automatic family selection on and off", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-git-probe-domain-"));
  const hostname = "git-probe.example.test";
  const priorFamilySelection = getDefaultAutoSelectFamily();
  let fixture: Awaited<ReturnType<typeof httpsFixture>> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"),
      "-days", "1", "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`],
    { stdio: "ignore" });
    fixture = await httpsFixture({
      key: await fs.readFile(path.join(directory, "key.pem")),
      cert: await fs.readFile(path.join(directory, "cert.pem")),
    });
    const url = new URL(fixture.context.connection.config.url as string);
    url.hostname = hostname;
    fixture.context.connection.config.url = url.toString();
    let resolutions = 0;
    t.mock.method(dns, "lookup", async (name: string, options: unknown) => {
      assert.equal(name, hostname);
      assert.deepEqual(options, { all: true });
      resolutions++;
      return [{ address: "127.0.0.1", family: 4 }];
    });
    const nativeRequest = https.request;
    const callbackShapes: boolean[] = [];
    t.mock.method(https, "request", (options: https.RequestOptions, receive: (response: IncomingMessage) => void) => {
      assert.equal(options.hostname, hostname, "TLS must retain the saved DNS identity");
      assert.equal(options.rejectUnauthorized, true);
      const pinnedLookup = options.lookup!;
      return nativeRequest({ ...options, lookup: (name, lookupOptions, callback) => {
        callbackShapes.push(lookupOptions.all === true);
        pinnedLookup(name, lookupOptions, callback);
      } }, receive);
    });
    for (const enabled of [true, false]) {
      setDefaultAutoSelectFamily(enabled);
      const result = await testGitConnection(fixture.context);
      assert.equal(result.status, "reachable");
      assert.equal(callbackShapes.at(-1), enabled);
    }
    assert.deepEqual(callbackShapes, [true, false]);
    assert.equal(resolutions, 2, "each test resolves once, with no fallback or replay");
    assert.equal(fixture.count(), 2);
  } finally {
    t.mock.restoreAll();
    setDefaultAutoSelectFamily(priorFamilySelection);
    await fixture?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Git SSH probe uses its saved pin, authenticates, and opens no command, file or forwarding channel", async () => {
  const host = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const parsed = ssh2.utils.parseKey(host.public);
  assert(!(parsed instanceof Error) && !Array.isArray(parsed));
  const pin = "SHA256:" + crypto.createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "");
  const clients = new Set<ssh2.Connection>();
  let authCount = 0, channels = 0;
  const server = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.on("authentication", (auth) => {
      if (auth.method === "password") authCount++;
      if (auth.method === "password" && auth.username === "fixture" && auth.password === password) auth.accept();
      else auth.reject();
    });
    client.on("session", (_accept, reject) => { channels++; reject(); });
    client.on("tcpip", (_accept, reject) => { channels++; reject(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context: AdapterContext = {
    connection: {
      alias: "GIT_SSH", name: "Synthetic Git SSH", kind: "git", description: "", enabled: true,
      trustBoundary: "development-fixture",
      config: { transport: "ssh", host: "127.0.0.1", port: (server.address() as AddressInfo).port, username: "fixture", path: "/repo.git", hostKeySha256: pin },
    }, secret: { password }, signal: new AbortController().signal, allowLocal: true, dataDir: "/unused",
  };
  try {
    const result = await testGitConnection(context);
    assert.equal(result.status, "verified");
    assert.equal(result.level, "authentication");
    assert.match(result.message, /仓库权限尚未验证/);
    assert.equal(channels, 0);
    assert.equal(authCount, 1);
    const changed = structuredClone(context.connection);
    changed.config.hostKeySha256 = "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=+$/, "");
    await assert.rejects(testGitConnection({ ...context, connection: changed }), { code: "SSH_TEST_HOST_KEY_MISMATCH" });
    assert.equal(authCount, 1, "changed host key must fail before credential authentication");
    assert.equal(channels, 0);
    for (const pin of [undefined, "", "SHA256:malformed"]) {
      const missing = structuredClone(context.connection);
      missing.config.hostKeySha256 = pin;
      await assert.rejects(testGitConnection({ ...context, connection: missing }), { code: "GIT_CONFIG" });
    }
    assert.equal(authCount, 1, "missing or malformed Git pins must fail before authentication");
  } finally {
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
