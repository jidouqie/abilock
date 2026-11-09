import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import type { Client as SshClient } from "ssh2";
import { z } from "zod";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Operation,
} from "../connections.js";
import { AppError } from "../schema.js";
import { redact, redactBytes } from "../security.js";
import { assertResolvedTargetBoundary } from "../protocol-boundary.js";
import { awaitWithSignal } from "../async-boundary.js";
import { acquireProcessLock } from "../process-lock.js";
import { prepareGitDeletions, applyGitDeletions } from "./git-delete-policy.js";
import {
  gitBridgeRequestAuthorized,
  type GitBridgeService,
} from "./git-bridge-policy.js";
import {
  gitManifestPathAllowed,
  gitManifestPathsAllowed,
} from "./git-manifest-policy.js";
import { productionGitRuntime, type GitRuntime } from "./git-runtime.js";
import { testPinnedSSHConnection } from "./ssh.js";
import { readBounded } from "../transport.js";
const { Client } = ssh2;

const MAX_OUTPUT = 20 * 1024 * 1024;
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:-]+$/);
const httpsConfig = z
  .object({
    transport: z.literal("https"),
    url: z.string().max(2000),
    authType: z.enum(["none", "basic", "bearer"]).default("basic"),
    ca: z.string().max(200000).optional(),
    identity: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9@._:/-]+$/)
      .optional(),
    authorName: z.string().min(1).max(100).default("Abilock"),
    authorEmail: z
      .string()
      .email()
      .max(200)
      .default("abilock@localhost.invalid"),
  })
  .strict();
const sshConfig = z
  .object({
    transport: z.literal("ssh"),
    host,
    port: z.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/),
    path: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^\/?[A-Za-z0-9._/-]+$/),
    hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
    authorName: z.string().min(1).max(100).default("Abilock"),
    authorEmail: z
      .string()
      .email()
      .max(200)
      .default("abilock@localhost.invalid"),
  })
  .strict();
const configSchema = z.discriminatedUnion("transport", [
  httpsConfig,
  sshConfig,
]);
type GitConfig = z.infer<typeof configSchema>;

function fail(code: string, message: string, status = 400): never {
  throw new AppError(status, code, message);
}
function configuration(context: Pick<AdapterContext, "connection">): GitConfig {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(context.connection.alias))
    fail("GIT_ALIAS", "Git 别名无效");
  const parsed = configSchema.safeParse(context.connection.config);
  if (!parsed.success) fail("GIT_CONFIG", "Git 配置不完整或包含不支持字段");
  const config = parsed.data;
  if (
    config.transport === "https" &&
    config.authType === "bearer" &&
    !config.identity
  )
    fail("GIT_IDENTITY", "Bearer Git 需要管理配置 identity 标记固定账户主体");
  if (/[\r\n\x00]/.test(config.authorName + config.authorEmail))
    fail("GIT_CONFIG", "Git 作者字段含控制字符");
  if (config.transport === "https") {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      fail("GIT_URL", "Git HTTPS URL 无效");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[%\\\s]/.test(config.url) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(config.url) ||
      !/^\/[A-Za-z0-9._/-]+$/.test(url.pathname) ||
      url.pathname.split("/").some((part) => part === ".." || part === ".")
    )
      fail("GIT_URL", "Git 目标必须是无凭据、查询和编码的固定 HTTPS 仓库 URL");
  } else if (
    config.path.split("/").some((part) => part === ".." || part === ".")
  ) {
    fail("GIT_PATH", "Git 仓库路径不允许穿越");
  }
  return config;
}
function checkSecret(config: GitConfig, secret: Record<string, string>) {
  const allowed =
    config.transport === "ssh"
      ? ["privateKey", "passphrase", "password"]
      : ["username", "password", "token"];
  if (Object.keys(secret).some((key) => !allowed.includes(key)))
    fail("GIT_SECRET", "Git 凭据字段不支持");
  if (config.transport === "ssh" && !secret.privateKey && !secret.password)
    fail("GIT_SECRET", "SSH Git 需要私钥或密码");
  if (
    config.transport === "https" &&
    config.authType === "bearer" &&
    !secret.token
  )
    fail("GIT_SECRET", "HTTPS Bearer 需要 token");
  if (
    config.transport === "https" &&
    config.authType === "basic" &&
    (!secret.username || !(secret.password || secret.token))
  )
    fail("GIT_SECRET", "HTTPS Basic 需要 username 和 password 或 token");
  if (
    config.transport === "https" &&
    config.authType === "bearer" &&
    /[^\x21-\x7e]/.test(secret.token)
  )
    fail("GIT_SECRET", "HTTPS Bearer token 必须是不含空白或控制字符的 ASCII");
}
function secretValues(context: AdapterContext, config: GitConfig) {
  const values = Object.values(context.secret);
  if (config.transport === "https" && config.authType === "basic") {
    const basic = `${context.secret.username}:${context.secret.password || context.secret.token}`;
    values.push(basic, `Basic ${Buffer.from(basic).toString("base64")}`);
  }
  return values;
}

// Only server-owned code, paths and a socket address enter the Git child environment.
// Credentials stay in the broker and never reach Git, the helper, argv, URLs or env.
const sshHelper = `#!/usr/bin/env node
import net from 'node:net';
const command=process.argv.at(-1);
const socket=net.createConnection({path:process.env.ABILOCK_GIT_SOCKET,allowHalfOpen:true});
socket.once('connect',()=>{socket.write(JSON.stringify({command})+'\\n');process.stdin.pipe(socket);});
socket.pipe(process.stdout);
socket.once('end',()=>socket.end());
socket.on('error',()=>{process.stderr.write('Abilock SSH transport failed\\n');process.exitCode=1;});
socket.on('close',()=>{process.stdin.unpipe(socket);process.stdin.pause();});
`;

type Bridge = {
  url: string;
  env: Record<string, string>;
  errors: string[];
  redactValues?: string[];
  close: () => Promise<void>;
};
async function address(hostname: string, context: AdapterContext) {
  context.signal.throwIfAborted();
  const raw = hostname.replace(/^\[|\]$/g, "");
  const found = net.isIP(raw)
    ? [{ address: raw, family: net.isIP(raw) }]
    : await awaitWithSignal(dns.lookup(raw, { all: true }), context.signal);
  context.signal.throwIfAborted();
  if (!found.length) fail("GIT_DNS", "Git 目标无法解析", 502);
  const localFixture =
    context.allowLocal &&
    context.connection.trustBoundary === "development-fixture";
  try {
    assertResolvedTargetBoundary(found, { allowLocalFixture: localFixture });
  } catch {
    fail(
      "GIT_SELF_TARGET",
      "Git解析包含broker自身、metadata或特殊网络目标",
      403,
    );
  }
  return found[0];
}

function httpsAuthorization(context: AdapterContext, config: z.infer<typeof httpsConfig>) {
  return config.authType === "basic"
    ? `Basic ${Buffer.from(`${context.secret.username}:${context.secret.password || context.secret.token}`).toString("base64")}`
    : config.authType === "bearer" ? `Bearer ${context.secret.token}` : undefined;
}

// Validate a complete v0/v1 smart discovery response. Only framing and the
// advertised-ref grammar are inspected; refs and object IDs never leave here.
function validAdvertisement(bytes: Buffer): boolean {
  const service = Buffer.from("001e# service=git-upload-pack\n0000");
  if (!bytes.subarray(0, service.length).equals(service)) return false;
  let offset = service.length;
  let first = true;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/.test(header)) return false;
    const length = parseInt(header, 16);
    if (length === 0) return offset + 4 === bytes.length;
    if (length < 5 || length > 65520 || offset + length > bytes.length) return false;
    const line = bytes.subarray(offset + 4, offset + length).toString("utf8").replace(/\n$/, "");
    if (first && line === "version 1") { offset += length; continue; }
    const parts = line.split("\0");
    if (parts.length > 2 || (!first && parts.length > 1)) return false;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}) (?:HEAD|refs\/[^\x00-\x20\x7f]+|capabilities\^\{\})$/.test(parts[0])) return false;
    if (parts[1] !== undefined && /[\x00-\x1f\x7f]/.test(parts[1])) return false;
    first = false;
    offset += length;
  }
  return false;
}

const probeErrors: Record<string, [number, string]> = {
  CONNECTION_TEST_AUTH: [401, "Git 鉴权未通过，请检查已保存的身份和凭据。"],
  CONNECTION_TEST_PERMISSION: [403, "Git 拒绝访问该仓库；未确认仓库读取权限。"],
  CONNECTION_TEST_RATE_LIMIT: [429, "Git 服务限流，请稍后手动重试。"],
  CONNECTION_TEST_PROTOCOL: [502, "响应不是有效的 Git 引用公告，未确认连接或凭据有效。"],
  CONNECTION_TEST_TLS: [502, "Git 服务器证书或 TLS 校验未通过。"],
  CONNECTION_TEST_CONNECT: [502, "无法建立 Git 连接，请检查地址和网络。"],
  CONNECTION_TEST_TIMEOUT: [504, "Git 连接测试超时，未自动重试。"],
  CONNECTION_TEST_CANCELLED: [499, "Git 连接测试已取消。"],
};
function probeError(code: keyof typeof probeErrors) {
  const [status, message] = probeErrors[code];
  return new AppError(status, code, message);
}

/** A read-only probe: no native Git, helper, workspace, RPC, shell or file write. */
export async function testGitConnection(context: AdapterContext): Promise<{
  status: "verified" | "reachable";
  level: "authentication" | "service";
  message: string;
}> {
  const config = configuration(context);
  checkSecret(config, context.secret);
  if (config.transport === "ssh") {
    // Reuse the strict handshake-only probe, retaining Git's independent saved
    // pin and identity. No git-upload-pack or other remote channel is opened.
    await testPinnedSSHConnection({
      ...context,
      connection: {
        ...context.connection, kind: "ssh",
        config: {
          host: config.host, port: config.port, username: config.username,
          remoteRoot: "/", fileAccess: "read", allowShell: false,
        },
      },
    }, config.hostKeySha256.replace(/=+$/, ""));
    return {
      status: "verified", level: "authentication",
      message: "Git SSH 主机指纹与登录鉴权通过；未运行远端命令，仓库权限尚未验证。",
    };
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(probeError("CONNECTION_TEST_TIMEOUT")), 30000);
  timer.unref();
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  try {
    signal.throwIfAborted();
    const target = new URL(config.url.replace(/\/$/, ""));
    const pinned = await address(target.hostname, { ...context, signal });
    const authorization = httpsAuthorization(context, config);
    await new Promise<void>((resolve, reject) => {
      const request = https.request({
        protocol: "https:", hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || 443, path: target.pathname + "/info/refs?service=git-upload-pack",
        method: "GET", ca: config.ca, rejectUnauthorized: true, agent: false, signal,
        lookup: (_host, options, callback) => {
          // Node family selection requests an address array. Both callback
          // shapes retain the same previously validated, pinned DNS result.
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        headers: {
          "user-agent": "Abilock Git connection test", "accept-encoding": "identity",
          accept: "application/x-git-upload-pack-advertisement",
          ...(authorization ? { authorization } : {}),
        },
      }, (response) => {
        const status = response.statusCode ?? 502;
        const error = status === 401 ? "CONNECTION_TEST_AUTH"
          : status === 403 || status === 404 ? "CONNECTION_TEST_PERMISSION"
            : status === 429 ? "CONNECTION_TEST_RATE_LIMIT"
              : status !== 200 || response.headers["content-type"]?.split(";", 1)[0].trim() !== "application/x-git-upload-pack-advertisement" ||
                (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
                ? "CONNECTION_TEST_PROTOCOL" : null;
        if (error) {
          response.destroy();
          reject(probeError(error));
          return;
        }
        void readBounded(response, 1024 * 1024).then((bytes) => {
          if (!validAdvertisement(bytes)) throw probeError("CONNECTION_TEST_PROTOCOL");
          resolve();
        }).catch((error: unknown) => {
          response.destroy();
          reject(error instanceof AppError && Object.hasOwn(probeErrors, error.code)
            ? error : probeError("CONNECTION_TEST_PROTOCOL"));
        });
      });
      request.once("error", reject);
      request.end();
    });
    signal.throwIfAborted();
    return {
      status: "reachable", level: "service",
      message: "Git HTTPS 引用公告读取通过；公开仓库可能不验证密钥，未确认写权限。未创建工作区。",
    };
  } catch (error) {
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      throw probeError(reason instanceof AppError && reason.code === "CONNECTION_TEST_TIMEOUT"
        ? "CONNECTION_TEST_TIMEOUT" : "CONNECTION_TEST_CANCELLED");
    }
    if (error instanceof AppError && Object.hasOwn(probeErrors, error.code)) throw error;
    const code: unknown = error && typeof error === "object" && "code" in error ? error.code : "";
    throw probeError(typeof code === "string" && /CERT|TLS|SSL/.test(code)
      ? "CONNECTION_TEST_TLS" : "CONNECTION_TEST_CONNECT");
  } finally {
    clearTimeout(timer);
  }
}

async function httpsBridge(
  context: AdapterContext,
  config: z.infer<typeof httpsConfig>,
  temporary: string,
  service: GitBridgeService,
): Promise<Bridge> {
  const target = new URL(config.url.replace(/\/$/, ""));
  const pinned = await address(target.hostname, context);
  const authorization = httpsAuthorization(context, config);
  const errors: string[] = [];
  const capability = crypto.randomBytes(32).toString("hex");
  const localConfig = path.join(temporary, "loopback-http.gitconfig");
  const outgoing = new Set<http.ClientRequest>();
  const server = http.createServer((req, res) => {
    const route = req.url;
    if (
      !gitBridgeRequestAuthorized(
        {
          method: req.method,
          url: route,
          capability: req.headers["x-abilock-git-bridge"],
        },
        capability,
        service,
      )
    ) {
      res.writeHead(403).end("Git bridge access denied");
      req.resume();
      return;
    }
    if (context.signal.aborted) {
      res.writeHead(499).end("Cancelled");
      req.resume();
      return;
    }
    const suffix = route!.slice("/repo.git".length);
    const upload = service === "upload";
    const rpc = req.method === "POST";
    const upstream = https.request(
      {
        protocol: "https:",
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || 443,
        path: target.pathname + suffix,
        method: req.method,
        ca: config.ca,
        rejectUnauthorized: true,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        headers: {
          "user-agent": "Abilock Git",
          "accept-encoding": "identity",
          ...(authorization ? { authorization } : {}),
          ...(rpc
            ? {
                "content-type": `application/x-git-${upload ? "upload" : "receive"}-pack-request`,
              }
            : {}),
        },
      },
      (response) => {
        if (
          (response.statusCode || 500) >= 300 &&
          (response.statusCode || 500) < 400
        ) {
          errors.push("Git HTTPS 拒绝目标重定向");
          response.resume();
          res.writeHead(502).end("Redirect denied");
          return;
        }
        res.writeHead(response.statusCode || 502, {
          "content-type":
            response.headers["content-type"] || "application/octet-stream",
          "cache-control": "no-store",
        });
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 64 * 1024 * 1024) {
            errors.push("Git HTTPS 响应超过 64 MiB");
            response.destroy();
            res.destroy();
          }
        });
        response.pipe(res);
        response.once("error", () => res.destroy());
      },
    );
    outgoing.add(upstream);
    upstream.once("close", () => outgoing.delete(upstream));
    upstream.once("error", () => {
      errors.push("Git HTTPS 连接或 TLS 验证失败");
      if (!res.headersSent) res.writeHead(502).end("TLS or connection failed");
      else res.destroy();
    });
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        upstream.destroy();
        req.destroy();
      }
    });
    req.pipe(upstream);
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  const url = `http://127.0.0.1:${port}/repo.git`;
  try {
    // The temporary capability is local operation authority, not an upstream
    // credential. Keep it out of argv, URL and env values. Only this broker-owned
    // config is read, and Git URL matching scopes the header to this exact bridge.
    await fs.writeFile(
      localConfig,
      `[http "${url}"]\nextraHeader = X-Abilock-Git-Bridge: ${capability}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const stop = () => {
    for (const item of outgoing) item.destroy();
    server.closeAllConnections();
  };
  context.signal.addEventListener("abort", stop, { once: true });
  return {
    url,
    env: { GIT_CONFIG_GLOBAL: localConfig },
    errors,
    redactValues: [capability],
    close: async () => {
      context.signal.removeEventListener("abort", stop);
      stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(localConfig, { force: true });
    },
  };
}

async function sshBridge(
  context: AdapterContext,
  config: z.infer<typeof sshConfig>,
  directory: string,
  runtime: GitRuntime,
  service: GitBridgeService,
): Promise<Bridge> {
  const pinned = await address(config.host, context);
  const helper = runtime.windows ? runtime.sshHelper! : path.join(directory, "git-ssh.mjs");
  const socketPath = path.join(directory, "s");
  if (!runtime.windows) await fs.writeFile(helper, sshHelper, { mode: 0o700, flag: "wx" });
  const capability = runtime.windows ? crypto.randomBytes(32).toString("hex") : undefined;
  const bridgeFile = path.join(directory, "ssh-bridge.json");
  const remotePath = config.path.startsWith("/")
    ? config.path
    : `/${config.path}`;
  const commands = new Map([
    [`git-upload-pack '${remotePath}'`, `git-upload-pack '${config.path}'`],
    [`git-receive-pack '${remotePath}'`, `git-receive-pack '${config.path}'`],
  ]);
  if (runtime.windows) for (const command of commands.keys()) {
    if (!command.startsWith(service === "upload" ? "git-upload-pack " : "git-receive-pack ")) commands.delete(command);
  }
  const errors: string[] = [];
  const connections = new Set<SshClient>();
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if ((!runtime.windows && ++accepted > 4) || sockets.size > 16 || context.signal.aborted) {
      socket.destroy();
      return;
    }
    let initial = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      initial = Buffer.concat([initial, chunk]);
      const end = initial.indexOf(10);
      if (end < 0) {
        if (initial.length > 4096) socket.destroy();
        return;
      }
      if (end > 4096) { socket.destroy(); return; }
      socket.pause();
      socket.off("data", read);
      let command: string;
      try {
        const parsed = JSON.parse(initial.subarray(0, end).toString()) as {
          command?: unknown;
          capability?: unknown;
        };
        if (typeof parsed.command !== "string" || !commands.has(parsed.command) ||
            (runtime.windows && (typeof parsed.capability !== "string" || parsed.capability.length !== capability!.length ||
              !crypto.timingSafeEqual(Buffer.from(parsed.capability), Buffer.from(capability!)))))
          throw new Error();
        command = commands.get(parsed.command)!;
        if (runtime.windows && ++accepted > 4) throw new Error();
      } catch {
        errors.push("Git SSH 服务命令被拒绝");
        socket.destroy();
        return;
      }
      const pending = initial.subarray(end + 1);
      socket.setTimeout(30000, () => socket.destroy());
      const client = new Client();
      connections.add(client);
      client.once("close", () => connections.delete(client));
      client.once("error", () => {
        errors.push("Git SSH 鉴权、主机密钥或连接失败");
        socket.destroy();
      });
      socket.once("close", () => client.end());
      client.once("ready", () =>
        client.exec(command, (error, channel) => {
          if (error) {
            errors.push("Git SSH 仓库服务不可用");
            socket.destroy();
            client.end();
            return;
          }
          let received = 0,
            sent = pending.length;
          const excessive = () => {
            errors.push("Git SSH 数据流超过 64 MiB");
            socket.destroy();
            channel.destroy();
            client.end();
          };
          channel.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > 64 * 1024 * 1024) excessive();
          });
          socket.on("data", (chunk: Buffer) => {
            sent += chunk.length;
            if (sent > 64 * 1024 * 1024) excessive();
          });
          if (pending.length) channel.write(pending);
          socket.pipe(channel);
          channel.pipe(socket);
          socket.resume();
          channel.stderr.on("data", (chunk: Buffer) => {
            if (errors.join("").length < 65536) errors.push(chunk.toString());
          });
          channel.once("close", () => {
            socket.end();
            client.end();
          });
        }),
      );
      client.connect({
        host: pinned.address,
        port: config.port,
        username: config.username,
        password: context.secret.password,
        privateKey: context.secret.privateKey,
        passphrase: context.secret.passphrase,
        readyTimeout: 15000,
        hostHash: "sha256",
        hostVerifier: (hex: string) => {
          const expected = config.hostKeySha256.slice(7).replace(/=+$/, "");
          const actual = Buffer.from(hex, "hex")
            .toString("base64")
            .replace(/=+$/, "");
          return (
            expected.length === actual.length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
          );
        },
      });
    };
    socket.on("data", read);
    socket.setTimeout(runtime.windows ? 5000 : 30000, () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (runtime.windows) server.listen(0, "127.0.0.1", resolve);
    else server.listen(socketPath, resolve);
  });
  if (runtime.windows) {
    try {
      await fs.writeFile(bridgeFile, JSON.stringify({ port: (server.address() as net.AddressInfo).port, capability }),
        { mode: 0o600, flag: "wx" });
    } catch (error) { server.close(); throw error; }
  } else await fs.chmod(socketPath, 0o600);
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    for (const client of connections) client.end();
  };
  context.signal.addEventListener("abort", stop, { once: true });
  // Dummy host deliberately cannot resolve. Only the broker-owned helper handles this URL.
  return {
    url: `ssh://git@abilock.invalid${remotePath}`,
    env: {
      GIT_SSH: helper,
      GIT_SSH_VARIANT: "ssh",
      ...(runtime.windows ? { ABILOCK_GIT_BRIDGE_FILE: bridgeFile } : { ABILOCK_GIT_SOCKET: socketPath }),
    },
    errors,
    ...(capability ? { redactValues: [capability] } : {}),
    close: async () => {
      context.signal.removeEventListener("abort", stop);
      stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function safeRef(value: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))
  )
    fail("GIT_REF", "Git 分支或 ref 无效");
  return value;
}
type Parsed = {
  command: string;
  repoId?: string;
  flags: string[];
  message?: string;
};
function parse(args: string[]): Parsed {
  const [command, ...tail] = args;
  if (
    ![
      "clone",
      "fetch",
      "pull",
      "push",
      "commit",
      "status",
      "log",
      "workspaces",
      "drop",
    ].includes(command)
  )
    fail(
      "GIT_COMMAND",
      "允许 Git clone/fetch/pull/push/commit/status/log 及 workspaces/drop",
    );
  const rest = [...tail];
  const repoId =
    command === "clone" || command === "workspaces" ? undefined : rest.shift();
  if (
    command !== "clone" &&
    command !== "workspaces" &&
    !/^[a-f0-9]{32}$/.test(repoId || "")
  )
    fail("GIT_REPO", "需要 clone 返回的 repoId");
  // Workspace management only names broker state; it takes no Git options.
  if ((command === "workspaces" || command === "drop") && rest.length)
    fail("GIT_OPTION", `${command} 不接受其他参数`);
  const flags: string[] = [];
  let message: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (command === "commit") {
      if ((item === "-m" || item === "--message") && message === undefined) {
        message = rest[++i];
        if (!message || message.length > 4000 || message.includes("\x00"))
          fail("GIT_MESSAGE", "commit 需要有效 -m 消息");
      } else
        fail("GIT_OPTION", "commit 仅接受 -m 消息；文件由结构化 files 提供");
      continue;
    }
    const allowed: Record<string, string[]> = {
      clone: ["--single-branch", "--no-tags", "--quiet", "-q", "--no-checkout"],
      fetch: ["--prune", "--tags", "--no-tags", "--quiet", "-q"],
      pull: ["--ff-only", "--quiet", "-q"],
      push: [
        "--dry-run",
        "-n",
        "--force-with-lease",
        "--set-upstream",
        "-u",
        "--quiet",
        "-q",
      ],
      status: ["--short", "-s", "--porcelain"],
      log: ["--oneline", "--no-decorate"],
    };
    if (allowed[command]?.includes(item)) {
      flags.push(item);
      continue;
    }
    if (
      ["clone", "fetch"].includes(command) &&
      (item === "--depth" || item.startsWith("--depth="))
    ) {
      const depth = item === "--depth" ? rest[++i] : item.slice(8);
      if (
        !/^\d{1,5}$/.test(depth || "") ||
        Number(depth) < 1 ||
        Number(depth) > 10000
      )
        fail("GIT_OPTION", "depth 必须为 1–10000");
      flags.push(`--depth=${depth}`);
      continue;
    }
    if (command === "clone" && ["--branch", "-b"].includes(item)) {
      flags.push("--branch", safeRef(rest[++i] || ""));
      continue;
    }
    if (command === "clone" && item.startsWith("--branch=")) {
      flags.push("--branch", safeRef(item.slice(9)));
      continue;
    }
    if (command === "log" && ["-n", "--max-count"].includes(item)) {
      const count = rest[++i];
      if (
        !/^\d{1,3}$/.test(count || "") ||
        Number(count) < 1 ||
        Number(count) > 100
      )
        fail("GIT_OPTION", "log 最多 100 条");
      flags.push("-n", count);
      continue;
    }
    if (
      ["fetch", "pull"].includes(command) &&
      !item.startsWith("-") &&
      flags.filter((f) => !f.startsWith("-")).length === 0
    ) {
      flags.push(safeRef(item));
      continue;
    }
    if (
      command === "push" &&
      !item.startsWith("-") &&
      item.split(":").length <= 2
    ) {
      item.split(":").forEach(safeRef);
      flags.push(item);
      continue;
    }
    fail(
      "GIT_OPTION",
      "Git 参数不在受控允许列表；不能覆盖 target、config、helper 或 SSH",
    );
  }
  if (command === "commit" && !message)
    fail("GIT_MESSAGE", "commit 需要 -m 消息");
  return { command, repoId, flags, message };
}

function runNativeGit(
  args: string[],
  cwd: string,
  temporary: string,
  bridge: Bridge | undefined,
  context: AdapterContext,
  runtime: GitRuntime,
): Promise<AdapterResult> {
  const empty = path.join(temporary, "empty");
  const safe = [
    "--no-pager",
    "--no-replace-objects",
    "--literal-pathspecs",
    "-c",
    `core.hooksPath=${empty}`,
    "-c",
    `init.templateDir=${empty}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.attributesFile=${runtime.windows ? path.join(temporary, "empty.gitconfig").replace(/\\/g, "/") : "/dev/null"}`,
    "-c",
    "core.symlinks=false",
    "-c",
    "core.protectHFS=true",
    "-c",
    "core.protectNTFS=true",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.http.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "protocol.version=0",
  ];
  const env: NodeJS.ProcessEnv = {
    ...runtime.environment,
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: runtime.windows ? path.join(temporary, "empty.gitconfig") : "/dev/null",
    GIT_CONFIG_GLOBAL: runtime.windows ? path.join(temporary, "empty.gitconfig") : "/dev/null",
    ...(runtime.windows ? { USERPROFILE: temporary, TEMP: temporary, TMP: temporary } : {}),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    LANG: "C",
    LC_ALL: "C",
    ...bridge?.env,
  };
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) {
      reject(new AppError(499, "CANCELLED", "Git 已取消"));
      return;
    }
    const child = spawn(runtime.binary, [...safe, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: context.signal,
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      excessive = false;
    let spawnError: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      forceKill.unref();
    };
    context.signal.addEventListener("abort", terminate, { once: true });
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > MAX_OUTPUT) {
        if (!excessive) {
          excessive = true;
          child.kill("SIGTERM");
          terminate();
        }
        return;
      }
      if (kind === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      context.signal.removeEventListener("abort", terminate);
      if (forceKill) clearTimeout(forceKill);
      if (context.signal.aborted) {
        reject(new AppError(499, "CANCELLED", "Git 已取消"));
        return;
      }
      if (spawnError) {
        reject(new AppError(502, "GIT_BINARY", "The protected Git executable could not be started"));
        return;
      }
      resolve({
        exitCode: excessive ? 1 : (code ?? 1),
        stdout: stdout.toString(),
        stderr: stderr.toString() + (excessive ? "\nGit 输出超过限制" : ""),
      });
    });
  });
}

async function directorySafe(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    fail("GIT_DIRECTORY", "Git 工作区目录不安全");
}
async function readRegular(filename: string) {
  const stats = await fs.lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
    fail("GIT_METADATA", "Git 元数据必须是无链接的普通文件");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1)
      fail("GIT_METADATA", "Git 元数据必须是普通文件");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function rewriteRegular(filename: string, content: string) {
  const stats = await fs.lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
    fail("GIT_METADATA", "Git config 必须是无链接的普通文件");
  const handle = await fs.open(
    filename,
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1)
      fail("GIT_METADATA", "Git config 必须是普通文件");
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
async function noAlternateMetadata(gitDirectory: string) {
  let count = 0;
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 20000)
        fail("GIT_METADATA", "Git 元数据文件超过 20000 项限制");
      const full = path.join(directory, entry.name),
        stats = await fs.lstat(full);
      if (
        stats.isSymbolicLink() ||
        (!stats.isFile() && !stats.isDirectory()) ||
        (stats.isFile() && stats.nlink !== 1)
      )
        fail("GIT_METADATA", "Git 元数据含符号链接、硬链接或特殊文件");
      if (stats.isDirectory()) await inspect(full);
    }
  };
  await inspect(gitDirectory);
  for (const relative of [
    "commondir",
    "gitdir",
    "config.worktree",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ]) {
    try {
      await fs.lstat(path.join(gitDirectory, relative));
      fail("GIT_METADATA", "Git 工作区不允许 alternate/worktree 元数据");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const relative of ["objects", "refs"]) {
    const stats = await fs.lstat(path.join(gitDirectory, relative));
    if (!stats.isDirectory() || stats.isSymbolicLink())
      fail("GIT_METADATA", "Git 对象和 refs 必须位于本工作区");
  }
}
async function exportParentSafe(tree: string, relative: string) {
  let current = tree;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      fail("GIT_FILE", "导出路径不得经过符号链接或非目录");
  }
}
function filePath(value: string) {
  if (!gitManifestPathAllowed(value))
    fail(
      "GIT_FILE",
      "文件路径仅支持 ASCII 安全相对路径，不能碰撞 .git 或 checkpoint 保留名",
    );
  return value;
}
function validateFilePaths(paths: string[]) {
  if (!gitManifestPathsAllowed(paths))
    fail("GIT_FILE", "文件清单含大小写、保留名或文件/目录路径冲突");
}

async function existingPathSpelling(
  tree: string,
  relative: string,
  directoryLeaf = false,
  ancestorErrorCode: "GIT_FILE" | "GIT_DIRECTORY" = "GIT_FILE",
) {
  let parent = tree;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index],
      entries = await fs.readdir(parent);
    if (
      entries.some(
        (entry) => entry !== name && entry.toLowerCase() === name.toLowerCase(),
      )
    )
      fail("GIT_FILE", "本机路径大小写拼写冲突");
    const current = path.join(parent, name);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!entries.includes(name)) fail("GIT_FILE", "本机路径有等价拼写");
    if (
      index < parts.length - 1 &&
      (!stats.isDirectory() || stats.isSymbolicLink())
    )
      fail(ancestorErrorCode, "本机路径祖先有符号链接或不是目录");
    if (
      stats.isSymbolicLink() ||
      (index === parts.length - 1 &&
        !stats.isFile() &&
        !(directoryLeaf && stats.isDirectory()))
    )
      fail("GIT_FILE", "本机路径有符号链接或不是普通文件");
    parent = current;
  }
}

async function validateWriteFiles(
  tree: string,
  files: NonNullable<Operation["files"]>,
) {
  validateFilePaths(files.map((file) => file.path));
  let total = 0;
  // Check every payload before changing the private broker worktree.
  for (const file of files) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.base64,
      )
    )
      fail("GIT_FILE", "文件 base64 无效");
    total += Buffer.from(file.base64, "base64").length;
    if (total > MAX_OUTPUT) fail("GIT_FILE", "单次文件总量超过 20 MiB");
    await existingPathSpelling(tree, file.path, false, "GIT_DIRECTORY");
    try {
      const stats = await fs.lstat(path.join(tree, file.path));
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        fail("GIT_FILE", "禁止写入链接或非普通文件");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function writeFiles(
  tree: string,
  files: NonNullable<Operation["files"]>,
) {
  for (const file of files) {
    filePath(file.path);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.base64,
      )
    )
      fail("GIT_FILE", "文件 base64 无效");
    const buffer = Buffer.from(file.base64, "base64");
    const parts = file.path.split("/");
    let parent = tree;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      await directorySafe(parent);
    }
    const filename = path.join(tree, file.path);
    try {
      const stats = await fs.lstat(filename);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        fail("GIT_FILE", "禁止写入符号链接或非普通文件");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.writeFile(filename, buffer, { mode: 0o600 });
  }
}
function redactBuffer(buffer: Buffer, secrets: string[]) {
  return redactBytes(buffer, secrets);
}
async function exportFiles(
  tree: string,
  temporary: string,
  context: AdapterContext,
  runtime: GitRuntime,
  transientValues: string[] = [],
) {
  const result = await runNativeGit(
    ["ls-files", "-z"],
    tree,
    temporary,
    undefined,
    context,
    runtime,
  );
  if (result.exitCode) fail("GIT_EXPORT", "Git 文件清单读取失败", 502);
  const output: NonNullable<AdapterResult["files"]> = [];
  const values = [
    ...secretValues(context, configuration(context)),
    ...transientValues,
  ];
  let size = 0;
  const trackedPaths = (result.stdout || "").split("\x00").filter(Boolean);
  validateFilePaths(trackedPaths);
  for (const relative of trackedPaths) {
    filePath(relative);
    await existingPathSpelling(tree, relative, true);
    await exportParentSafe(tree, relative);
    const filename = path.join(tree, relative);
    let stats;
    try {
      stats = await fs.lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue; // Submodules are never traversed.
    size += stats.size;
    if (size > MAX_OUTPUT || output.length >= 1000)
      fail("GIT_EXPORT", "检出超过导出限制（1000 个文件或 20 MiB）", 413);
    output.push({
      path: redact(relative, values),
      base64: redactBuffer(await fs.readFile(filename), values).toString(
        "base64",
      ),
    });
  }
  validateFilePaths(output.map((file) => file.path));
  return output;
}
const repoIdPattern = /^[a-f0-9]{32}$/;
function gitAliasDirectory(dataDir: string, alias: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias))
    fail("GIT_ALIAS", "Git 别名无效");
  return path.join(dataDir, "git-repositories", alias);
}
async function listWorkspaces(
  aliasDirectory: string,
  identity: string,
): Promise<AdapterResult> {
  const workspaces: { repoId: string; current: boolean; updatedAt: string }[] =
    [];
  for (const entry of await fs.readdir(aliasDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !repoIdPattern.test(entry.name)) continue;
    const repository = path.join(aliasDirectory, entry.name);
    let current = false;
    try {
      const binding = JSON.parse(
        await readRegular(path.join(repository, "binding.json")),
      ) as { identity?: string };
      current = binding.identity === identity;
    } catch {
      /* Incomplete or old-identity workspaces are listed as not current. */
    }
    // Git rewrites .git/index through a rename on every checkout or commit.
    const stats = await fs
      .lstat(path.join(repository, "tree", ".git"))
      .catch(() => fs.lstat(repository));
    workspaces.push({
      repoId: entry.name,
      current,
      updatedAt: stats.mtime.toISOString(),
    });
  }
  workspaces.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    exitCode: 0,
    stdout: workspaces
      .map(
        (item) =>
          `${item.repoId}\t${item.current ? "current" : "stale"}\t${item.updatedAt}\n`,
      )
      .join(""),
    data: { workspaces },
  };
}
async function dropWorkspace(repository: string, repoId: string) {
  let stats;
  try {
    stats = await fs.lstat(repository);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      fail("GIT_REPO", "此连接没有该 broker 工作区", 404);
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink())
    fail("GIT_REPO", "此连接没有该 broker 工作区", 404);
  // The lock file stays: removing it could admit a second writer.
  await fs.rm(repository, { recursive: true, force: true });
  return {
    exitCode: 0,
    stdout: `已删除 broker 工作区 ${repoId}\n`,
    data: { repoId, removed: true },
  };
}
// Explicit test injection is code-only. CLI requests and environment variables
// can never select a different executable, lock provider or SSH bridge.
export function createGitAdapter(options: { runtime?: GitRuntime; acquireLock?: typeof acquireProcessLock } = {}): Adapter {
return {
  validate(connection, secret) {
    const config = configuration({ connection });
    if (secret) checkSecret(config, secret);
  },
  async removeState(dataDir, alias) {
    const aliasDirectory = gitAliasDirectory(dataDir, alias);
    let entries;
    try {
      entries = await fs.readdir(aliasDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Repository directories go with the connection. Lock files stay so a
    // concurrent holder is never joined by a second writer.
    for (const entry of entries)
      if (entry.isDirectory() && repoIdPattern.test(entry.name))
        await fs.rm(path.join(aliasDirectory, entry.name), {
          recursive: true,
          force: true,
        });
  },
  async renameState(dataDir, from, to) {
    const source = gitAliasDirectory(dataDir, from),
      target = gitAliasDirectory(dataDir, to);
    if (source === target) return;
    try {
      // A case-only rename is one directory on case-insensitive filesystems.
      if (from.toLowerCase() !== to.toLowerCase()) {
        await fs.lstat(target);
        return; // Never merge into or replace another alias's workspaces.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
  async run(context, operation) {
    const runtime = options.runtime ?? productionGitRuntime();
    await runtime.validate(context.signal);
    const nativeGit = (args: string[], cwd: string, temporary: string, bridge: Bridge | undefined, context: AdapterContext) =>
      runNativeGit(args, cwd, temporary, bridge, context, runtime);
    const config = configuration(context);
    checkSecret(config, context.secret);
    const parsed = parse(operation.args);
    if (operation.input !== undefined)
      fail("GIT_INPUT", "Git 不接受任意 stdin；commit 文件用 files 字段");
    if (
      (operation.files?.length || operation.deletions?.length) &&
      parsed.command !== "commit"
    )
      fail("GIT_FILE", "文件上传和删除仅允许 commit 操作");
    let identitySource = JSON.stringify(config);
    if (config.transport === "https" && config.authType === "basic")
      identitySource += `\x00account:${context.secret.username}`;
    if (config.transport === "ssh" && context.secret.privateKey) {
      const key = ssh2.utils.parseKey(
        context.secret.privateKey,
        context.secret.passphrase,
      );
      if (key instanceof Error || Array.isArray(key))
        fail("GIT_KEY", "SSH Git 私钥格式或口令错误");
      identitySource += `\x00public-key:${crypto.createHash("sha256").update(key.getPublicSSH()).digest("hex")}`;
    }
    const identity = crypto
      .createHash("sha256")
      .update(identitySource)
      .digest("hex");
    const aliasDirectory = gitAliasDirectory(
      context.dataDir,
      context.connection.alias,
    );
    await directorySafe(path.join(context.dataDir, "git-repositories"));
    await directorySafe(aliasDirectory);
    if (parsed.command === "workspaces")
      return listWorkspaces(aliasDirectory, identity);
    const repoId = parsed.repoId || crypto.randomBytes(16).toString("hex");
    const repository = path.join(aliasDirectory, repoId),
      tree = path.join(repository, "tree");
    // Keep the lock inode outside the repository: clone cleanup must never
    // unlink a lock another process is about to acquire.
    const repositoryLock = await (options.acquireLock ?? acquireProcessLock)(
      path.join(aliasDirectory, `${repoId}.lock`),
      {
        signal: context.signal,
        busyCode: "GIT_BUSY",
      },
    );
    if (parsed.command === "drop") {
      // Any workspace of this alias may be dropped, including ones bound to an
      // older target or identity, which can no longer be used otherwise.
      try {
        return await dropWorkspace(repository, repoId);
      } finally {
        await repositoryLock.release();
      }
    }
    let temporary: string | undefined;
    let bridge: Bridge | undefined;
    let result: AdapterResult;
    let createdRepository = false;
    try {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), "abl-git-"));
      await fs.chmod(temporary, 0o700);
      await fs.mkdir(path.join(temporary, "empty"), { mode: 0o700 });
      if (runtime.windows) await fs.writeFile(path.join(temporary, "empty.gitconfig"), "", { flag: "wx", mode: 0o600 });
      if (parsed.command === "clone") {
        await fs.mkdir(repository, { mode: 0o700 });
        createdRepository = true;
        await fs.writeFile(
          path.join(repository, "binding.json"),
          JSON.stringify({ identity }),
          { mode: 0o600, flag: "wx" },
        );
      } else {
        const bindingFile = path.join(repository, "binding.json");
        try {
          for (const directory of [repository, tree, path.join(tree, ".git")]) {
            const stats = await fs.lstat(directory);
            if (!stats.isDirectory() || stats.isSymbolicLink())
              throw new Error();
          }
          await noAlternateMetadata(path.join(tree, ".git"));
          const binding = JSON.parse(await readRegular(bindingFile)) as {
            identity?: string;
          };
          if (binding.identity !== identity)
            fail(
              "GIT_IDENTITY",
              "工作区绑定的目标或身份配置已改变，请重新 clone",
              409,
            );
        } catch (error) {
          if (error instanceof AppError) throw error;
          fail("GIT_REPO", "此连接没有该 broker 工作区", 404);
        }
      }
      const network = ["clone", "fetch", "pull", "push"].includes(
        parsed.command,
      );
      if (network)
        bridge =
          config.transport === "https"
            ? await httpsBridge(
                context,
                config,
                temporary,
                parsed.command === "push" ? "receive" : "upload",
              )
            : await sshBridge(context, config, temporary, runtime, parsed.command === "push" ? "receive" : "upload");
      const remote =
        bridge?.url ||
        (config.transport === "https"
          ? config.url
          : `ssh://${config.username}@${config.host}:${config.port}${config.path.startsWith("/") ? "" : "/"}${config.path}`);
      if (parsed.command !== "clone") {
        const head = (
          await readRegular(path.join(tree, ".git", "HEAD"))
        ).trim();
        if (
          !head.startsWith("ref: refs/heads/") &&
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)
        )
          fail("GIT_METADATA", "Git HEAD 元数据无效");
        const branch = head.startsWith("ref: refs/heads/")
          ? safeRef(head.slice(16))
          : undefined;
        await rewriteRegular(
          path.join(tree, ".git", "config"),
          `[core]\nrepositoryformatversion = 0\nfilemode = false\nbare = false\nsymlinks = false\n[remote "origin"]\nurl = ${remote}\nfetch = +refs/heads/*:refs/remotes/origin/*\n` +
            (branch
              ? `[branch "${branch}"]\nremote = origin\nmerge = refs/heads/${branch}\n`
              : ""),
        );
      }
      // Pull and commit change the broker tree before its manifest is exported.
      // Remember the prior commit so an unexportable result can be undone.
      let headBefore: string | undefined;
      if (parsed.command === "pull" || parsed.command === "commit") {
        const head = await nativeGit(
          ["rev-parse", "--verify", "--quiet", "HEAD"],
          tree,
          temporary,
          undefined,
          context,
        );
        const value = (head.stdout || "").trim();
        if (!head.exitCode && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
          headBefore = value;
      }
      if (parsed.command === "clone")
        result = await nativeGit(
          ["clone", ...parsed.flags, "--", remote, tree],
          repository,
          temporary,
          bridge,
          context,
        );
      else if (parsed.command === "commit") {
        const files = operation.files || [];
        const deletions = operation.deletions || [];
        validateFilePaths([...files, ...deletions].map((file) => file.path));
        await validateWriteFiles(tree, files);
        const tracked = deletions.length
          ? await nativeGit(
              ["ls-files", "-z"],
              tree,
              temporary,
              undefined,
              context,
            )
          : { exitCode: 0, stdout: "" };
        if (tracked.exitCode)
          fail("GIT_DELETE", "Git 已跟踪文件清单读取失败", 502);
        const deletePlan = await prepareGitDeletions(
          tree,
          deletions,
          (tracked.stdout || "").split("\x00").filter(Boolean),
          secretValues(context, config),
        );
        context.signal.throwIfAborted();
        await writeFiles(tree, files);
        await applyGitDeletions(deletePlan, context.signal);
        result = await nativeGit(
          ["add", "--all", "--", "."],
          tree,
          temporary,
          undefined,
          context,
        );
        if (!result.exitCode)
          result = await nativeGit(
            [
              "-c",
              `user.name=${config.authorName}`,
              "-c",
              `user.email=${config.authorEmail}`,
              "-c",
              "commit.gpgsign=false",
              "commit",
              "--no-verify",
              "-m",
              parsed.message!,
            ],
            tree,
            temporary,
            undefined,
            context,
          );
      } else if (parsed.command === "fetch")
        result = await nativeGit(
          [
            "fetch",
            ...parsed.flags.filter((p) => p.startsWith("-")),
            "origin",
            ...parsed.flags.filter((p) => !p.startsWith("-")),
          ],
          tree,
          temporary,
          bridge,
          context,
        );
      else if (parsed.command === "pull")
        result = await nativeGit(
          [
            "pull",
            "--ff-only",
            ...parsed.flags.filter((p) => p.startsWith("-")),
            "origin",
            ...parsed.flags.filter((p) => !p.startsWith("-")),
          ],
          tree,
          temporary,
          bridge,
          context,
        );
      else if (parsed.command === "push")
        result = await nativeGit(
          [
            "push",
            ...parsed.flags.filter((p) => p.startsWith("-")),
            "origin",
            ...(parsed.flags.filter((p) => !p.startsWith("-")).length
              ? parsed.flags.filter((p) => !p.startsWith("-"))
              : ["HEAD"]),
          ],
          tree,
          temporary,
          bridge,
          context,
        );
      else
        result = await nativeGit(
          [
            parsed.command,
            ...(parsed.command === "log" ? ["-n", "20"] : []),
            ...parsed.flags,
          ],
          tree,
          temporary,
          undefined,
          context,
        );
      result.stderr =
        (result.stderr || "") +
        (bridge?.errors.length ? "\n" + bridge.errors.join("\n") : "");
      // Commit uploads may include ignored/untracked business files. Return only
      // Git's actual tracked manifest so clients never checkpoint them for deletion.
      if (
        !result.exitCode &&
        ["clone", "pull", "commit"].includes(parsed.command)
      ) {
        try {
          result.files = await exportFiles(
            tree,
            temporary,
            context,
            runtime,
            bridge?.redactValues,
          );
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            error.code !== "GIT_EXPORT" ||
            error.status !== 413
          )
            throw error;
          // A failure must mean "not applied": otherwise the local directory
          // and broker tree diverge and a later commit could revert upstream.
          if (parsed.command === "clone")
            fail(
              "GIT_EXPORT",
              "仓库检出超过 1000 个文件或 20 MiB，超出 Abilock Git 子集的导出限制；本次 clone 未保留 broker 工作区",
              413,
            );
          const restored = headBefore
            ? await nativeGit(
                ["reset", "--hard", "--quiet", headBefore],
                tree,
                temporary,
                undefined,
                context,
              )
            : undefined;
          if (restored && !restored.exitCode)
            fail(
              "GIT_EXPORT",
              `${parsed.command} 后检出超过 1000 个文件或 20 MiB；broker 工作区已恢复到操作前的提交，本地目录未改变`,
              413,
            );
          fail(
            "GIT_EXPORT",
            "检出超过 1000 个文件或 20 MiB，且未能恢复 broker 工作区；不要从本地目录继续提交，请 drop 此工作区后改用较小的仓库",
            413,
          );
        }
      }
      result.data = {
        repoId,
        transport: config.transport,
        ...(result.files ? { filesAreFullManifest: true } : {}),
      };
      const values = [
        ...secretValues(context, config),
        ...(bridge?.redactValues || []),
      ];
      result.stdout = redact(result.stdout || "", values);
      result.stderr = redact(result.stderr || "", values);
      if (createdRepository && result.exitCode)
        await fs.rm(repository, { recursive: true, force: true });
      return result;
    } catch (error) {
      if (createdRepository)
        await fs.rm(repository, { recursive: true, force: true });
      throw error;
    } finally {
      try {
        await bridge?.close();
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      } finally {
        await repositoryLock.release();
      }
    }
  },
};
}
export const gitAdapter: Adapter = createGitAdapter();
