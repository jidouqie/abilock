import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { awaitWithSignal } from "../async-boundary.js";
import { assertResolvedTargetBoundary } from "../protocol-boundary.js";
import ssh2, { type ClientChannel, type SFTPWrapper, type Stats } from "ssh2";
import { z } from "zod";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Connection,
  Credentials,
  Operation,
} from "../connections.js";
import { AppError } from "../schema.js";
import { redact, Redactor } from "../security.js";

const sshConfig = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .refine(
        (v) => !/[\s/@\\?#:]/.test(v) || net.isIP(v) === 6,
        "host必须为纯主机名或IP",
      ),
    port: z.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (v) => ![...v].some((c) => c.charCodeAt(0) < 32),
        "username含控制字符",
      ),
    remoteRoot: z.string().min(1).max(1000).default("/"),
    fileAccess: z.enum(["read", "readwrite"]).default("read"),
    allowShell: z.boolean().default(true),
  })
  .strict();
type SSHConfig = z.infer<typeof sshConfig>;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT = 20 * 1024 * 1024;
const { Client } = ssh2;

function problem(code: string, message: string, status = 400): never {
  throw new AppError(status, code, message);
}
function safePath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    [...value].some((c) => c.charCodeAt(0) < 32) ||
    value.split("/").includes("..")
  )
    problem("SSH_PATH", "远程路径不得含控制字符、反斜线或父目录跳转");
  return path.posix.normalize(value);
}
function config(connection: Connection): SSHConfig {
  // Ignore only the retired direct-SSH pin. Existing records and their secrets
  // remain untouched; every other configuration field still parses strictly.
  const current = { ...connection.config };
  delete current.hostKeySHA256;
  const parsed = sshConfig.safeParse(current);
  if (!parsed.success)
    problem(
      "SSH_CONFIG",
      "SSH配置无效：需固定host/port/username",
    );
  const c = parsed.data;
  if (!c.remoteRoot.startsWith("/"))
    problem("SSH_CONFIG", "remoteRoot必须为远程绝对路径");
  c.remoteRoot = safePath(c.remoteRoot);
  return c;
}
function secrets(secret: Credentials) {
  const keys = Object.keys(secret);
  if (keys.some((k) => !["password", "privateKey", "passphrase"].includes(k)))
    problem("SSH_SECRET", "SSH秘密仅支持password/privateKey/passphrase");
  if (
    (!secret.password && !secret.privateKey) ||
    (secret.password && secret.privateKey)
  )
    problem("SSH_SECRET", "请通过管理页面选择一种SSH身份：密码或私钥");
  if (secret.passphrase && !secret.privateKey)
    problem("SSH_SECRET", "passphrase仅用于私钥");
}
function within(root: string, candidate: string) {
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}
function resolvePath(c: SSHConfig, value: string) {
  const clean = safePath(value);
  const result = clean.startsWith("/")
    ? clean
    : path.posix.join(c.remoteRoot, clean);
  if (!within(c.remoteRoot, result))
    problem("SSH_PATH", "远程路径超出配置的remoteRoot");
  return result;
}
async function address(host: string, allowLocal: boolean, signal: AbortSignal) {
  aborted(signal);
  let rows: { address: string; family: number }[];
  try {
    rows = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await awaitWithSignal(dns.lookup(host, { all: true }), signal);
  } catch (error) {
    // Keep SSH's cancellation code while preserving explicit broker timeout
    // reasons. The resolver may finish later, but its wait has been rejected.
    aborted(signal);
    throw error;
  }
  aborted(signal);
  try {
    assertResolvedTargetBoundary(rows, { allowLocalFixture: allowLocal });
  } catch {
    problem(
      "SSH_TARGET",
      "SSH目标解析包含loopback、link-local、metadata或不可用地址",
    );
  }
  return rows[0].address;
}
function aborted(signal: AbortSignal) {
  if (signal.aborted) {
    if (signal.reason instanceof AppError) throw signal.reason;
    problem("SSH_CANCELLED", "SSH操作已取消", 499);
  }
}
async function sshWait<T>(promise: Promise<T>, signal: AbortSignal) {
  try {
    const result = await awaitWithSignal(promise, signal);
    aborted(signal);
    return result;
  } catch (error) {
    aborted(signal);
    throw error;
  }
}

// Each remote request has its own abort-aware callback. Cancellation prevents
// a delayed callback from resuming a transfer and starting another operation.
const sftpSignals = new WeakMap<SFTPWrapper, AbortSignal>();
function guardedSftp(sftp: SFTPWrapper, signal: AbortSignal): SFTPWrapper {
  const requests = new Set([
    "lstat",
    "stat",
    "realpath",
    "readdir",
    "mkdir",
    "rmdir",
    "unlink",
    "rename",
    "ext_openssh_rename",
    "createReadStream",
    "createWriteStream",
  ]);
  const proxy = new Proxy(sftp, {
    get(target, key) {
      const method: unknown = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (!requests.has(String(key))) return method.bind(target);
      return (...args: unknown[]) => {
        aborted(signal);
        const callback = args.at(-1);
        if (typeof callback === "function") {
          let settled = false;
          const finish = (...result: unknown[]) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", cancel);
            callback(...result);
          };
          const cancel = () => {
            try {
              aborted(signal);
            } catch (error) {
              finish(error);
            }
          };
          args[args.length - 1] = finish;
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return Reflect.apply(method, target, args);
          } catch (error) {
            signal.removeEventListener("abort", cancel);
            throw error;
          }
        }
        const result: unknown = Reflect.apply(method, target, args);
        if (result instanceof Readable || result instanceof Writable) {
          const cancel = () => {
            try {
              aborted(signal);
            } catch (error) {
              result.destroy(error as Error);
            }
          };
          const cleanup = () => signal.removeEventListener("abort", cancel);
          signal.addEventListener("abort", cancel, { once: true });
          result.once("close", cleanup);
        }
        return result;
      };
    },
  });
  sftpSignals.set(proxy, signal);
  return proxy;
}
function safeError(error: unknown, secret: Credentials) {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "SSH操作失败";
  return new AppError(
    502,
    "SSH_FAILURE",
    redact(message, Object.values(secret)),
  );
}

type ConnectionTestState = {
  phase: "dns" | "credentials" | "connect";
  hostKeyRejected?: boolean;
};
const connectionTestErrors = {
  SSH_TEST_DNS: [502, "SSH主机解析失败"],
  SSH_TEST_CONNECT: [502, "无法连接SSH服务器"],
  SSH_TEST_AUTH: [502, "SSH鉴权失败，请检查用户名和凭据"],
  SSH_TEST_TIMEOUT: [504, "SSH连接测试超时"],
  SSH_TEST_CANCELLED: [499, "SSH连接测试已取消"],
  SSH_TEST_HOST_KEY_REQUIRED: [400, "请先保存通过可信渠道核对的SSH主机指纹"],
  SSH_TEST_HOST_KEY_MISMATCH: [502, "SSH主机指纹不匹配，已停止连接"],
  SSH_CONFIG: [400, "SSH配置无效：需固定host/port/username"],
  SSH_SECRET: [400, "SSH凭据无效，请通过管理页面检查密码或私钥"],
  SSH_TARGET: [400, "SSH目标解析包含loopback、link-local、metadata或不可用地址"],
} as const;
function connectionTestError(
  error: unknown,
  state: ConnectionTestState,
  signal: AbortSignal,
) {
  let code: keyof typeof connectionTestErrors;
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    code =
      (reason instanceof AppError && reason.status === 504) ||
      (reason instanceof Error && reason.name === "TimeoutError")
        ? "SSH_TEST_TIMEOUT"
        : "SSH_TEST_CANCELLED";
  } else if (
    error instanceof AppError &&
    Object.hasOwn(connectionTestErrors, error.code)
  ) {
    code = error.code as keyof typeof connectionTestErrors;
  } else if (state.hostKeyRejected) {
    code = "SSH_TEST_HOST_KEY_MISMATCH";
  } else if (
    (error instanceof AppError && error.code === "SSH_CONNECT_TIMEOUT") ||
    (error instanceof Error &&
      "level" in error &&
      error.level === "client-timeout")
  ) {
    code = "SSH_TEST_TIMEOUT";
  } else if (
    state.phase === "credentials" ||
    (error instanceof Error &&
      "level" in error &&
      error.level === "client-authentication")
  ) {
    code = "SSH_TEST_AUTH";
  } else {
    code = state.phase === "dns" ? "SSH_TEST_DNS" : "SSH_TEST_CONNECT";
  }
  const [status, message] = connectionTestErrors[code];
  // Never include ssh2, DNS, socket or cancellation text in this diagnostic.
  return new AppError(status, code, message);
}

/** Tests never discover, accept or update a host identity on the caller's behalf. */
export function sshConnectionTestHostKey(config: Record<string, unknown>): string {
  const pin = config.hostKeySHA256;
  if (typeof pin !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pin))
    problem("SSH_TEST_HOST_KEY_REQUIRED", connectionTestErrors.SSH_TEST_HOST_KEY_REQUIRED[1]);
  const digest = Buffer.from(pin.slice(7), "base64");
  if (digest.length !== 32 || digest.toString("base64").replace(/=+$/, "") !== pin.slice(7))
    problem("SSH_TEST_HOST_KEY_REQUIRED", connectionTestErrors.SSH_TEST_HOST_KEY_REQUIRED[1]);
  return digest.toString("hex");
}

/** No OpenSSH process, config, agent, local hook or local key file is consulted. */
async function connect(
  context: AdapterContext,
  signal: AbortSignal,
  diagnostic?: ConnectionTestState,
) {
  // Ordinary execution retains its existing compatibility policy. A connection
  // test uses the explicitly saved pin and must fail before DNS if it is absent.
  const expectedHostKey = diagnostic
    ? sshConnectionTestHostKey(context.connection.config)
    : undefined;
  const c = config(context.connection);
  secrets(context.secret);
  aborted(signal);
  // DNS and handshake share this deadline. Clear it after ready so a healthy
  // long-running command or PTY keeps only its caller's operation/session limit.
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new AppError(504, "SSH_CONNECT_TIMEOUT", "SSH目标解析或握手超过15秒"),
      ),
    15000,
  );
  timer.unref();
  const connectingSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const pinned = await address(c.host, context.allowLocal, connectingSignal);
    aborted(connectingSignal);
    if (diagnostic) diagnostic.phase = "connect";
    const client = new Client();
    const socket = net.connect({ host: pinned, port: c.port });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const stop = () => {
      socket.destroy();
      client.destroy();
    };
    connectingSignal.addEventListener("abort", stop, { once: true });
    try {
      await awaitWithSignal(
        new Promise<void>((resolve, reject) => {
          const onError = (err: Error) =>
            reject(diagnostic
              ? connectionTestError(err, diagnostic, connectingSignal)
              : safeError(err, context.secret));
          socket.once("error", onError);
          // ssh2 can emit a second transport error while a failed handshake is
          // being destroyed. Keep diagnostics bounded until the client is gone.
          if (diagnostic) client.on("error", onError);
          else client.once("error", onError);
          client.once("close", () =>
            reject(new AppError(502, "SSH_CLOSED", "SSH连接提前关闭")),
          );
          client.once("ready", resolve);
          // ssh2 parses a supplied private key synchronously. Classify a local
          // key/passphrase rejection without inspecting or returning its text.
          if (diagnostic && context.secret.privateKey) diagnostic.phase = "credentials";
          client.connect({
            sock: socket,
            username: c.username,
            password: context.secret.password,
            privateKey: context.secret.privateKey,
            passphrase: context.secret.passphrase,
            agentForward: false,
            tryKeyboard: false,
            readyTimeout: 15000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
            ...(expectedHostKey ? {
              hostHash: "sha256",
              hostVerifier: (hash: string) => {
                const matches = hash === expectedHostKey;
                if (diagnostic && !matches) diagnostic.hostKeyRejected = true;
                return matches;
              },
            } : {}),
          });
          if (diagnostic) diagnostic.phase = "connect";
        }),
        connectingSignal,
      );
      aborted(connectingSignal);
      connectingSignal.removeEventListener("abort", stop);
      signal.addEventListener("abort", stop, { once: true });
      return {
        client,
        c,
        closed,
        close: () => {
          signal.removeEventListener("abort", stop);
          client.end();
          socket.destroy();
        },
      };
    } catch (error) {
      stop();
      await closed;
      aborted(connectingSignal);
      throw error;
    } finally {
      connectingSignal.removeEventListener("abort", stop);
    }
  } catch (e) {
    throw diagnostic
      ? connectionTestError(e, diagnostic, connectingSignal)
      : safeError(e, context.secret);
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the saved host pin, then authenticate without opening any channel. */
export async function testSSHConnection(context: AdapterContext): Promise<{
  connected: true;
  authenticated: true;
  hostVerified: true;
}> {
  const diagnostic: ConnectionTestState = { phase: "dns" };
  try {
    const session = await connect(context, context.signal, diagnostic);
    try {
      aborted(context.signal);
      return { connected: true, authenticated: true, hostVerified: true };
    } finally {
      session.close();
      await session.closed;
    }
  } catch (error) {
    throw connectionTestError(error, diagnostic, context.signal);
  }
}

const localFlags =
  /^(?:-(?:A|a|F|i|I|J|L|R|D|o|p|l|S|s|W|w|E|Q|V|G|M|O|N|f)|--(?:host|port|username|password|private-key|identity|config|proxy|agent|local-command|exec))$/;
function command(args: string[]) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (
    !values.length ||
    values[0].startsWith("-") ||
    values.some((v) => v.includes("\0"))
  )
    problem(
      "SSH_ARGUMENT",
      "远程命令必须放在选择器后的 -- 后，不接受本机SSH选项",
    );
  if (localFlags.test(values[0]))
    problem("SSH_ARGUMENT", "不可覆盖SSH目标、身份或启用本机执行扩展");
  // OpenSSH joins remote command operands with spaces; shell interpretation occurs only on the configured remote.
  return values.join(" ");
}
async function execute(
  context: AdapterContext,
  op: Operation,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const text = command(op.args);
  const { client, c, close } = await connect(context, signal);
  try {
    if (!c.allowShell) problem("SSH_SHELL", "该连接未启用远程命令/终端");
    aborted(signal);
    return await sshWait(
      new Promise<AdapterResult>((resolve, reject) => {
        client.exec(text, { env: {}, pty: false }, (err, channel) => {
          if (signal.aborted) {
            channel?.destroy();
            try {
              aborted(signal);
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (err) return reject(safeError(err, context.secret));
          const out: Buffer[] = [],
            errors: Buffer[] = [];
          let size = 0,
            exitCode = 255;
          let receivedExitStatus = false;
          const collect = (list: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_OUTPUT) {
              channel.destroy();
              reject(new AppError(413, "SSH_OUTPUT_LIMIT", "SSH输出超过20MiB"));
            } else list.push(chunk);
          };
          channel.on("data", collect(out));
          channel.stderr.on("data", collect(errors));
          channel.on("exit", (code: number | null) => {
            if (
              Number.isInteger(code) &&
              code !== null &&
              code >= 0 &&
              code <= 255
            ) {
              exitCode = code;
              receivedExitStatus = true;
            }
          });
          channel.once("error", (e: Error) =>
            reject(safeError(e, context.secret)),
          );
          channel.once("close", () => {
            if (signal.aborted)
              return reject(
                new AppError(499, "SSH_CANCELLED", "SSH操作已取消"),
              );
            const values = Object.values(context.secret);
            resolve({
              exitCode,
              stdout: redact(Buffer.concat(out).toString(), values),
              stderr: redact(
                Buffer.concat(errors).toString() +
                  (receivedExitStatus ? "" : "\n远端未报告有效的SSH退出状态"),
                values,
              ),
            });
          });
          if (op.input !== undefined) channel.end(op.input);
          else channel.end();
        });
      }),
      signal,
    );
  } finally {
    close();
  }
}
function invoke<T>(
  call: (cb: (err: Error | undefined | null, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) =>
    call((err, value) => (err ? reject(err) : resolve(value))),
  );
}
function done(call: (cb: (err?: Error | null) => void) => void) {
  return new Promise<void>((resolve, reject) =>
    call((err) => (err ? reject(err) : resolve())),
  );
}
function absent(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 2
  );
}
async function checked(
  sftp: SFTPWrapper,
  c: SSHConfig,
  value: string,
  missing = false,
) {
  const destination = resolvePath(c, value);
  // Check every component, including ancestors of remoteRoot: lstat on the leaf
  // alone still follows links in its parents. SFTP v3 has no openat/O_NOFOLLOW
  // directory handles, so these checks cannot eliminate hostile rename races.
  const parts = destination.split("/").filter(Boolean);
  const components = [
    "/",
    ...parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`),
  ];
  for (const current of components) {
    try {
      const info = await invoke<Stats>((cb) => sftp.lstat(current, cb));
      if (info.isSymbolicLink()) problem("SSH_PATH", "文件传输不跟随符号链接");
      if (
        (current !== destination || current === c.remoteRoot) &&
        !info.isDirectory()
      )
        problem("SSH_PATH", "文件传输路径祖先必须为目录");
      const canonical = await invoke<string>((cb) =>
        sftp.realpath(current, cb),
      );
      if (canonical !== current)
        problem("SSH_PATH", "文件传输路径必须规范，不得含符号链接祖先");
      const after = await invoke<Stats>((cb) => sftp.lstat(current, cb));
      if (
        after.isSymbolicLink() ||
        after.isDirectory() !== info.isDirectory() ||
        after.isFile() !== info.isFile()
      )
        problem("SSH_PATH", "文件传输路径检查时发生类型变化");
    } catch (e) {
      // Missing children may be created, but the root and all its own parents
      // must already exist and have passed the checks above.
      if (
        !missing ||
        !absent(e) ||
        current === c.remoteRoot ||
        !within(c.remoteRoot, current)
      )
        throw e;
      return destination;
    }
  }
  return destination;
}
function writeAllowed(c: SSHConfig) {
  if (c.fileAccess !== "readwrite")
    problem("SSH_FILE_READONLY", "该连接文件策略只允许读取");
}
async function readFile(sftp: SFTPWrapper, c: SSHConfig, target: string) {
  const file = await checked(sftp, c, target);
  const stats = await invoke<Stats>((cb) => sftp.lstat(file, cb));
  if (!stats.isFile()) problem("SSH_FILE_TYPE", "只允许传输普通文件");
  if (stats.size > MAX_BYTES) problem("SSH_FILE_LIMIT", "单文件超过12MiB", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  await sshWait(
    new Promise<void>((resolve, reject) => {
      const stream = sftp.createReadStream(file);
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          stream.destroy();
          reject(new AppError(413, "SSH_FILE_LIMIT", "单文件超过12MiB"));
        } else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", resolve);
    }),
    sftpSignals.get(sftp)!,
  );
  await checked(sftp, c, file);
  return Buffer.concat(chunks);
}
function inputFile(op: Operation, label: string) {
  const file = op.files?.find((f) => f.path === label);
  if (
    !file ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      file.base64,
    )
  )
    problem(
      "SSH_FILE_INPUT",
      "CLI需将本地文件内容封装为files，broker不会读取本机文件路径",
    );
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.length > MAX_BYTES)
    problem("SSH_FILE_LIMIT", "单文件超过12MiB", 413);
  return bytes;
}
async function writeFile(
  sftp: SFTPWrapper,
  c: SSHConfig,
  target: string,
  bytes: Buffer,
) {
  writeAllowed(c);
  const file = await checked(sftp, c, target, true);
  const temporary = `${file}.abl-${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await checked(sftp, c, temporary, true);
    await sshWait(
      new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(temporary, {
          flags: "wx",
          mode: 0o600,
        });
        stream.once("error", reject);
        stream.once("close", resolve);
        stream.end(bytes);
      }),
      sftpSignals.get(sftp)!,
    );
    await checked(sftp, c, temporary);
    await checked(sftp, c, file, true);
    // Standard SFTP rename does not replace on all servers. The OpenSSH extension gives atomic replacement.
    try {
      await done((cb) => sftp.ext_openssh_rename(temporary, file, cb));
    } catch (e) {
      if (
        !(e instanceof Error) ||
        !/unsupported|not supported|does not support/i.test(e.message)
      )
        throw e;
      // Standard SFTP rename cannot atomically replace an existing target.
      // Never unlink it first: a failed rename would lose both copies.
      let exists = true;
      try { await done((cb) => sftp.lstat(file, cb)); }
      catch (lookupError) { if (absent(lookupError)) exists = false; else throw lookupError; }
      if (exists)
        problem("SSH_ATOMIC_OVERWRITE_REQUIRED", "服务器不支持原子覆盖；原文件已保留，请使用新文件名", 409);
      await checked(sftp, c, temporary);
      await checked(sftp, c, file, true);
      await done((cb) => sftp.rename(temporary, file, cb));
    }
    await checked(sftp, c, file);
  } finally {
    try {
      await checked(sftp, c, temporary);
      await done((cb) => sftp.unlink(temporary, cb));
    } catch {
      /* best effort remote temporary cleanup */
    }
  }
}
function attributes(s: Stats) {
  return {
    size: s.size,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    atime: s.atime,
    mtime: s.mtime,
    type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
  };
}
async function mkdir(sftp: SFTPWrapper, c: SSHConfig, target: string) {
  writeAllowed(c);
  const directory = await checked(sftp, c, target, true);
  try {
    await done((cb) => sftp.mkdir(directory, { mode: 0o700 }, cb));
  } catch (e) {
    await checked(sftp, c, directory);
    const info = await invoke<Stats>((cb) => sftp.lstat(directory, cb));
    if (!info.isDirectory()) throw e;
  }
  await checked(sftp, c, directory);
}
async function parents(sftp: SFTPWrapper, c: SSHConfig, target: string) {
  const directory = path.posix.dirname(resolvePath(c, target));
  const parts = path.posix
    .relative(c.remoteRoot, directory)
    .split("/")
    .filter(Boolean);
  let current = c.remoteRoot;
  for (const part of parts) {
    current = path.posix.join(current, part);
    await mkdir(sftp, c, current);
  }
}
async function tree(
  sftp: SFTPWrapper,
  c: SSHConfig,
  directory: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 16) problem("SSH_DEPTH", "传输目录超过16层");
  const base = await checked(sftp, c, directory);
  const entries = await invoke<Awaited<ReturnType<typeof list>>>((cb) =>
    sftp.readdir(base, cb),
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") continue;
    if (entry.filename.includes("/") || entry.filename.includes("\\"))
      problem("SSH_PATH", "远端目录项名称无效");
    const item = path.posix.join(base, entry.filename);
    if (entry.attrs.isSymbolicLink())
      problem("SSH_PATH", "目录传输不跟随符号链接");
    if (entry.attrs.isDirectory())
      files.push(...(await tree(sftp, c, item, depth + 1)));
    else if (entry.attrs.isFile()) files.push(item);
    if (files.length > 100)
      problem("SSH_FILE_COUNT", "一次目录传输最多100个文件");
  }
  return files;
}
function list(sftp: SFTPWrapper, value: string) {
  return invoke<import("ssh2").FileEntryWithStats[]>((cb) =>
    sftp.readdir(value, cb),
  );
}
function outputFile(label: string, bytes: Buffer, secret: Credentials) {
  const filter = new Redactor(Object.values(secret));
  return new Promise<{ path: string; base64: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    filter.on("data", (b: Buffer) => chunks.push(b));
    filter.once("error", reject);
    filter.once("end", () =>
      resolve({
        path: label,
        base64: Buffer.concat(chunks).toString("base64"),
      }),
    );
    filter.end(bytes);
  });
}
function excludeMatcher(pattern: string) {
  if (
    !pattern ||
    pattern.length > 1000 ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    [..."[]{}"].some((character) => pattern.includes(character))
  )
    problem(
      "SSH_EXCLUDE",
      "exclude支持*、**、?和目录后缀/，不支持字符类/花括号/转义",
    );
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (normalized.split("/").includes(".."))
    problem("SSH_EXCLUDE", "exclude不能含父目录跳转");
  let expression = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        expression += "(?:.*/)?";
        i += 2;
      } else {
        expression += ".*";
        i++;
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|\\]/g, "\\$&");
  }
  const start = anchored || normalized.includes("/") ? "^" : "(?:^|/)";
  return new RegExp(`${start}${expression}${directory ? "(?:/|$)" : "$"}`);
}
async function transfer(
  context: AdapterContext,
  op: Operation,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const { client, c, close } = await connect(context, signal);
  try {
    aborted(signal);
    const rawSftp = await sshWait(
      invoke<SFTPWrapper>((cb) =>
        client.sftp((error, value) => {
          if (signal.aborted) value?.destroy();
          cb(error, value);
        }),
      ),
      signal,
    );
    const sftp = guardedSftp(rawSftp, signal);
    if (op.args[0] === "sftp") {
      const [, verb, a, b, ...extra] = op.args;
      if (extra.length || !a)
        problem(
          "SSH_ARGUMENT",
          "sftp支持ls/stat/mkdir/rm/rmdir/put/get与明确路径",
        );
      const target = ["put"].includes(verb) ? b : a;
      if (!target) problem("SSH_ARGUMENT", "缺少远程目标路径");
      if (verb === "ls") {
        if (b) problem("SSH_ARGUMENT", "ls仅接受一个路径");
        const entries = await list(sftp, await checked(sftp, c, target));
        return {
          exitCode: 0,
          data: entries.map((e) => ({
            name: e.filename,
            ...attributes(e.attrs),
          })),
        };
      }
      if (verb === "stat") {
        if (b) problem("SSH_ARGUMENT", "stat仅接受一个路径");
        const item = await checked(sftp, c, target);
        return {
          exitCode: 0,
          data: attributes(await invoke<Stats>((cb) => sftp.stat(item, cb))),
        };
      }
      if (verb === "mkdir") {
        if (b) problem("SSH_ARGUMENT", "mkdir仅接受一个路径");
        await mkdir(sftp, c, target);
        return { exitCode: 0 };
      }
      if (verb === "rm" || verb === "rmdir") {
        if (b) problem("SSH_ARGUMENT", "删除仅接受一个路径");
        writeAllowed(c);
        const item = await checked(sftp, c, target);
        if (item === c.remoteRoot) problem("SSH_ROOT", "不能删除remoteRoot");
        await done((cb) =>
          verb === "rm" ? sftp.unlink(item, cb) : sftp.rmdir(item, cb),
        );
        return { exitCode: 0 };
      }
      if (verb === "put") {
        await writeFile(sftp, c, target, inputFile(op, a));
        return { exitCode: 0, data: { uploaded: target } };
      }
      if (verb === "get")
        return {
          exitCode: 0,
          files: [
            await outputFile(
              b ?? path.posix.basename(target),
              await readFile(sftp, c, target),
              context.secret,
            ),
          ],
        };
      problem("SSH_ARGUMENT", "未知sftp操作；不执行batch本机命令");
    }
    const family = op.args[0];
    const flags: string[] = [];
    const operands: string[] = [];
    const excludes: RegExp[] = [];
    for (let index = 1; index < op.args.length; index++) {
      const a = op.args[index];
      if (family === "rsync" && a === "--exclude") {
        if (!op.args[index + 1]) problem("SSH_EXCLUDE", "--exclude需要模式");
        excludes.push(excludeMatcher(op.args[++index]));
        continue;
      }
      if (family === "rsync" && a.startsWith("--exclude=")) {
        excludes.push(excludeMatcher(a.slice(10)));
        continue;
      }
      if (a.startsWith("-")) flags.push(a);
      else operands.push(a);
    }
    const supported =
      family === "scp"
        ? ["-r"]
        : ["-r", "--recursive", "--checksum", "--dry-run", "--delete", "-n"];
    if (flags.some((f) => !supported.includes(f)) || operands.length !== 2)
      problem(
        "SSH_ARGUMENT",
        `${family}仅支持受控文件操作参数，禁止-e/-S/-F/-o/目标或身份覆盖`,
      );
    const [source, destination] = operands;
    const upload = destination.startsWith(":") && !source.startsWith(":");
    const download = source.startsWith(":") && !destination.startsWith(":");
    if (!upload && !download)
      problem(
        "SSH_ARGUMENT",
        "文件传输需一端为:remotePath；host/身份只能使用连接配置",
      );
    const recursive =
      flags.includes("-r") ||
      flags.includes("--recursive") ||
      family === "rsync";
    const dry = flags.includes("--dry-run") || flags.includes("-n");
    const changed: string[] = [],
      skipped: string[] = [],
      removed: string[] = [],
      excluded: string[] = [];
    const matchesExclude = (relative: string) =>
      excludes.some((pattern) => pattern.test(relative));
    if (upload) {
      writeAllowed(c);
      const remote = resolvePath(c, destination.slice(1));
      const supplied = recursive
        ? (op.files ?? []).map((f) => ({
            label: f.path,
            relative: f.path.startsWith(`${source.replace(/\/$/, "")}/`)
              ? f.path.slice(source.replace(/\/$/, "").length + 1)
              : f.path,
          }))
        : [{ label: source, relative: "" }];
      if (!supplied.length || supplied.length > 100)
        problem("SSH_FILE_INPUT", "上传需要1到100个封装文件");
      // Validate the whole manifest before the first remote write. A download
      // tree permits 16 child directory levels; upload must use the same bound.
      if (recursive)
        for (const file of supplied) {
          if (
            path.posix.isAbsolute(file.relative) ||
            file.relative.includes(":")
          )
            problem("SSH_PATH", "目录manifest必须使用安全相对路径");
          const relative = safePath(file.relative);
          if (relative.split("/").length - 1 > 16)
            problem("SSH_DEPTH", "传输目录超过16层");
        }
      const expected = new Set<string>();
      let total = 0;
      for (const file of supplied) {
        if (
          recursive &&
          (path.posix.isAbsolute(file.relative) || file.relative.includes(":"))
        )
          problem("SSH_PATH", "目录manifest必须使用安全相对路径");
        const target = recursive
          ? resolvePath(c, path.posix.join(remote, safePath(file.relative)))
          : remote;
        if (matchesExclude(file.relative)) {
          excluded.push(target);
          continue;
        }
        expected.add(target);
        const bytes = inputFile(op, file.label);
        total += bytes.length;
        if (total > MAX_BYTES)
          problem("SSH_FILE_LIMIT", "一次文件传输总量超过12MiB", 413);
        let same = false;
        if (family === "rsync") {
          try {
            same = (await readFile(sftp, c, target)).equals(bytes);
          } catch (e) {
            if (!absent(e)) throw e;
          }
        }
        if (same) {
          skipped.push(target);
          continue;
        }
        changed.push(target);
        if (!dry) {
          if (recursive) await parents(sftp, c, target);
          await writeFile(sftp, c, target, bytes);
        }
      }
      if (family === "rsync" && flags.includes("--delete")) {
        let existing: string[] = [];
        try {
          existing = await tree(sftp, c, remote);
        } catch (e) {
          if (!absent(e)) throw e;
        }
        for (const file of existing)
          if (
            !expected.has(file) &&
            !matchesExclude(path.posix.relative(remote, file))
          ) {
            removed.push(file);
            if (!dry) await done((cb) => sftp.unlink(file, cb));
          }
      }
      return {
        exitCode: 0,
        data: {
          protocol: "sftp",
          changed,
          skipped,
          removed,
          excluded,
          dryRun: dry,
          ...(family === "rsync"
            ? { comparison: "full-file-content", nativeRsyncProtocol: false }
            : {}),
        },
      };
    }
    if (flags.includes("--delete"))
      problem("SSH_ARGUMENT", "--delete仅用于上传；broker不会删除CLI本地文件");
    const remote = resolvePath(c, source.slice(1));
    const targets = recursive ? await tree(sftp, c, remote) : [remote];
    const files: { path: string; base64: string }[] = [];
    let total = 0;
    for (const target of targets) {
      if (matchesExclude(path.posix.relative(remote, target))) {
        excluded.push(target);
        continue;
      }
      const bytes = await readFile(sftp, c, target);
      total += bytes.length;
      if (total > MAX_BYTES)
        problem("SSH_FILE_LIMIT", "一次文件传输总量超过12MiB", 413);
      const label = recursive
        ? path.posix.join(destination, path.posix.relative(remote, target))
        : destination;
      files.push(await outputFile(label, bytes, context.secret));
    }
    return {
      exitCode: 0,
      files: dry ? [] : files,
      data: {
        protocol: "sftp",
        downloaded: files.map((f) => f.path),
        excluded,
        dryRun: dry,
        nativeRsyncProtocol: false,
      },
    };
  } catch (e) {
    aborted(signal);
    throw safeError(e, context.secret);
  } finally {
    close();
  }
}

export const sshAdapter: Adapter = {
  validate(connection, secret) {
    config(connection);
    if (secret) secrets(secret);
  },
  async run(context, operation) {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(operation.timeoutMs),
    ]);
    if (["sftp", "scp", "rsync"].includes(operation.args[0]))
      return transfer(context, operation, signal);
    return execute(context, operation, signal);
  },
};

export type TerminalSession = {
  stream: Duplex;
  readonly exitCode: number;
  close: () => void;
  resize: (rows: number, cols: number) => void;
};
export async function openTerminal(
  context: AdapterContext,
  dimensions: { rows: number; cols: number },
): Promise<TerminalSession> {
  const { client, c, close } = await connect(context, context.signal);
  if (!c.allowShell) {
    close();
    problem("SSH_SHELL", "该连接未启用远程终端");
  }
  const size = (v: number) => {
    if (!Number.isInteger(v) || v < 1 || v > 1000)
      problem("SSH_TERMINAL", "终端行列数必须为1到1000");
    return v;
  };
  let channel: ClientChannel;
  const completion: { exitCode: number; notifyExit?: (code: number) => void } = {
    exitCode: 1,
  };
  try {
    aborted(context.signal);
    channel = await sshWait(
      invoke<ClientChannel>((cb) =>
        client.shell(
          {
            term: "xterm-256color",
            rows: size(dimensions.rows),
            cols: size(dimensions.cols),
          },
          { env: {} },
          (error, value) => {
            // Exit may follow shell acceptance in the same incoming packet,
            // before the awaiting consumer can register a stream listener.
            if (!error && value)
              value.once("exit", (code: number | null) => {
                completion.exitCode =
                  code !== null && Number.isInteger(code)
                    ? code
                    : 1;
                completion.notifyExit?.(completion.exitCode);
              });
            if (context.signal.aborted) value?.destroy();
            cb(error, value);
          },
        ),
      ),
      context.signal,
    );
  } catch (e) {
    close();
    throw safeError(e, context.secret);
  }
  const filter = new Redactor(Object.values(context.secret));
  const onAbort = () =>
    stream.destroy(new AppError(499, "SSH_CANCELLED", "SSH终端已取消"));
  const stream = new Duplex({
    read() {
      filter.resume();
    },
    write(chunk, encoding, callback) {
      channel.write(chunk, encoding, callback);
    },
    final(callback) {
      channel.end();
      callback();
    },
    destroy(error, callback) {
      context.signal.removeEventListener("abort", onAbort);
      channel.destroy();
      filter.destroy();
      close();
      callback(error);
    },
  });
  completion.notifyExit = (code) => stream.emit("exit", code);
  filter.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) filter.pause();
  });
  filter.once("end", () => stream.push(null));
  filter.once("error", (e) => stream.destroy(e));
  channel.on("data", (chunk: Buffer) => {
    if (!filter.write(chunk)) channel.pause();
  });
  filter.on("drain", () => channel.resume());
  channel.stderr.on("data", (chunk: Buffer) => filter.write(chunk));
  channel.once("close", () => {
    context.signal.removeEventListener("abort", onAbort);
    filter.end();
    close();
  });
  channel.once("error", (e: Error) =>
    stream.destroy(safeError(e, context.secret)),
  );
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return {
    stream,
    get exitCode() {
      return completion.exitCode;
    },
    close: () => stream.destroy(),
    resize(rows, cols) {
      channel.setWindow(size(rows), size(cols), 0, 0);
    },
  };
}
