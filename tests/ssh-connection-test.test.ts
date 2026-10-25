import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { getEventListeners } from "node:events";
import net from "node:net";
import test from "node:test";
import ssh2, { type Connection as SSHConnection } from "ssh2";
import type { AdapterContext, Credentials } from "../src/connections.js";
import { sshAdapter, sshConnectionTestHostKey, testSSHConnection } from "../src/protocols/ssh.js";
import { AppError } from "../src/schema.js";

const { Server, utils } = ssh2;
const password = "synthetic-ssh-connection-test-password";
const passphrase = "synthetic-ssh-connection-test-passphrase";
const host = utils.generateKeyPairSync("ecdsa", { bits: 256 });
const identity = utils.generateKeyPairSync("ecdsa", {
  bits: 256,
  cipher: "aes256-ctr",
  passphrase,
  rounds: 16,
});
function parsedKey(value: string) {
  const parsed = utils.parseKey(value);
  assert(!(parsed instanceof Error));
  return parsed;
}
const publicKey = parsedKey(identity.public);
const hostKeySHA256 = "SHA256:" + crypto.createHash("sha256")
  .update(parsedKey(host.public).getPublicSSH()).digest("base64").replace(/=+$/, "");

function context(port: number, signal = new AbortController().signal): AdapterContext {
  return {
    connection: {
      alias: "SSH_TEST_FIXTURE",
      name: "synthetic SSH connection test",
      kind: "ssh",
      description: "",
      enabled: true,
      config: {
        host: "127.0.0.1",
        port,
        username: "fixture",
        hostKeySHA256,
        // Authentication tests do not require shell or file permissions.
        remoteRoot: "/never-read",
        allowShell: false,
        fileAccess: "read",
      },
    },
    secret: { password },
    signal,
    allowLocal: true,
    dataDir: "/unused",
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert(Date.now() < deadline, "synthetic SSH connection did not close");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const clients = new Set<SSHConnection>();
  let authenticationRequests = 0;
  let channelRequests = 0;
  const server = new Server({ hostKeys: [host.private] }, (client) => {
    clients.add(client);
    client.on("error", () => undefined);
    client.once("close", () => clients.delete(client));
    client.on("authentication", (auth) => {
      authenticationRequests++;
      if (auth.username !== "fixture") return auth.reject();
      if (auth.method === "password" && auth.password === password) return auth.accept();
      if (
        auth.method === "publickey" &&
        auth.key.data.equals(publicKey.getPublicSSH()) &&
        (!auth.signature || (auth.blob && publicKey.verify(auth.blob, auth.signature, auth.hashAlgo)))
      ) return auth.accept();
      auth.reject();
    });
    client.on("session", (_accept, reject) => { channelRequests++; reject(); });
    client.on("tcpip", (_accept, reject) => { channelRequests++; reject(); });
    client.on("openssh.streamlocal", (_accept, reject) => { channelRequests++; reject(); });
    client.on("request", (_accept, reject) => { channelRequests++; reject?.(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    context: context(port),
    get authenticationRequests() { return authenticationRequests; },
    async idle() {
      await waitFor(() => clients.size === 0);
      assert.equal(channelRequests, 0, "connection test opened a channel or forwarding request");
    },
    async close() {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("SSH连接测试先核对保存的主机指纹，再以密码或加密私钥鉴权且连接完全退出", async () => {
  const f = await fixture();
  try {
    const credentials: Credentials[] = [{ password }, { privateKey: identity.private, passphrase }];
    for (const secret of credentials) {
      const signal = new AbortController().signal;
      assert.deepEqual(await testSSHConnection({ ...f.context, secret, signal }), {
        connected: true,
        authenticated: true,
        hostVerified: true,
      });
      await f.idle();
      assert.equal(getEventListeners(signal, "abort").length, 0);
    }
    assert(f.authenticationRequests > 0);
  } finally { await f.close(); }
});

test("SSH连接测试拒绝变化的主机指纹，鉴权前停止且不修改记录", async () => {
  const f = await fixture();
  try {
    const legacy = {
      ...f.context,
      connection: {
        ...f.context.connection,
        config: { ...f.context.connection.config, hostKeySHA256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      },
    };
    await assert.rejects(testSSHConnection(legacy), {
      code: "SSH_TEST_HOST_KEY_MISMATCH", message: "SSH主机指纹不匹配，已停止连接",
    });
    await f.idle();
    assert.equal(f.authenticationRequests, 0, "credentials must not be sent to a changed host");
    assert.equal(legacy.connection.config.hostKeySHA256, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.deepEqual(legacy.secret, { password });
    assert.throws(() => sshAdapter.validate({
      ...legacy.connection,
      config: { ...legacy.connection.config, localCommand: "must-not-run" },
    }, legacy.secret), { code: "SSH_CONFIG" });
  } finally { await f.close(); }
});

test("SSH连接测试缺失或无效主机指纹时不解析地址、不建socket、不自动信任", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => { throw new Error("unexpected DNS"); });
  const sockets = t.mock.method(net, "connect", () => { throw new Error("unexpected transport"); });
  for (const pin of [undefined, "", "SHA256:malformed", "SHA256:" + "A".repeat(42) + "B", 42]) {
    const ctx = context(22);
    ctx.connection.config.hostKeySHA256 = pin;
    await assert.rejects(testSSHConnection(ctx), {
      code: "SSH_TEST_HOST_KEY_REQUIRED", message: "请先保存通过可信渠道核对的SSH主机指纹",
    });
    assert.equal(ctx.connection.config.hostKeySHA256, pin);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(sockets.mock.callCount(), 0);
  assert.equal(sshConnectionTestHostKey({ hostKeySHA256 }).length, 64);
});

test("SSH连接测试鉴权失败仅返回固定诊断，不回显凭据", async () => {
  const f = await fixture();
  try {
    await assert.rejects(testSSHConnection({ ...f.context, secret: { password: "synthetic-wrong-password" } }), {
      code: "SSH_TEST_AUTH", message: "SSH鉴权失败，请检查用户名和凭据",
    });
    await f.idle();
  } finally { await f.close(); }
});

test("SSH连接测试私钥格式或口令错误只返回鉴权诊断并退出", async () => {
  const f = await fixture();
  try {
    const credentials: Credentials[] = [
      { privateKey: "synthetic-invalid-private-key-never-echo" },
      { privateKey: identity.private, passphrase: "synthetic-wrong-passphrase" },
    ];
    for (const secret of credentials) {
      await assert.rejects(testSSHConnection({ ...f.context, secret }), {
        code: "SSH_TEST_AUTH", message: "SSH鉴权失败，请检查用户名和凭据",
      });
      await f.idle();
    }
    assert.equal(f.authenticationRequests, 0);
  } finally { await f.close(); }
});

test("SSH连接测试拒绝连接使用固定诊断", async () => {
  const reserving = net.createServer();
  await new Promise<void>((resolve) => reserving.listen(0, "127.0.0.1", resolve));
  const port = (reserving.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserving.close(() => resolve()));
  await assert.rejects(testSSHConnection(context(port)), {
    code: "SSH_TEST_CONNECT", message: "无法连接SSH服务器",
  });
});

test("SSH连接测试复用目标边界，禁止本机目标且不建socket", async (t) => {
  const sockets = t.mock.method(net, "connect", () => { throw new Error("unexpected transport"); });
  await assert.rejects(testSSHConnection({ ...context(22), allowLocal: false }), { code: "SSH_TARGET" });
  assert.equal(sockets.mock.callCount(), 0);
});

test("SSH连接测试DNS错误仅返回固定诊断，取消DNS不产生迟到socket", async (t) => {
  const ctx = context(22);
  ctx.connection.config.host = "synthetic.abilock.invalid";
  let failDns = true;
  let resolveDns!: (rows: { address: string; family: number }[]) => void;
  t.mock.method(dns, "lookup", () => new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    if (failDns) reject(new Error(`${password}: DNS vendor text`));
    else resolveDns = resolve;
  }));
  const sockets = t.mock.method(net, "connect", () => { throw new Error("unexpected transport"); });
  await assert.rejects(testSSHConnection(ctx), { code: "SSH_TEST_DNS", message: "SSH主机解析失败" });
  failDns = false;
  const controller = new AbortController();
  const waiting = testSSHConnection({ ...ctx, signal: controller.signal });
  controller.abort(new AppError(499, "SECRET_ABORT", password));
  await assert.rejects(waiting, { code: "SSH_TEST_CANCELLED", message: "SSH连接测试已取消" });
  resolveDns([{ address: "127.0.0.1", family: 4 }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sockets.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("SSH连接测试在停滞握手时可取消或超时，socket退出且无通道请求", async (t) => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    for (const timeout of [false, true]) {
      const controller = new AbortController();
      const waiting = testSSHConnection(context(port, controller.signal));
      await waitFor(() => sockets.size === 1);
      controller.abort(timeout ? new AppError(504, "OPERATION_TIMEOUT", password) : undefined);
      await assert.rejects(waiting, timeout
        ? { code: "SSH_TEST_TIMEOUT", message: "SSH连接测试超时" }
        : { code: "SSH_TEST_CANCELLED", message: "SSH连接测试已取消" });
      await waitFor(() => sockets.size === 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      delays.push(delay ?? 0);
      return original(callback, delay === 15000 ? 50 : delay, ...args);
    });
    await assert.rejects(testSSHConnection(context(port)), {
      code: "SSH_TEST_TIMEOUT", message: "SSH连接测试超时",
    });
    assert(delays.includes(15000), "preserves the existing bounded DNS/handshake deadline");
    await waitFor(() => sockets.size === 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
