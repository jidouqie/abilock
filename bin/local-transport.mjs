import { fork, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import * as isolated from "./isolated-transport.mjs";
import * as windowsIsolated from "./windows-transport.mjs";
import { remoteFetch } from "./remote-fetch.mjs";

export const localBase = "http://abilock.local/";
/**
 * A WebSocket-shaped terminal channel: `ws` remotely, IPC frames locally.
 * @typedef {import("node:events").EventEmitter & {
 *   readyState: number,
 *   bufferedAmount: number,
 *   send(raw: string): void,
 *   close(): void,
 * }} TerminalSocket
 */
/**
 * Messages the one-shot worker sends over IPC.
 * @typedef {{ type?: unknown, headers?: Record<string, string>, status?: unknown,
 *   failed?: unknown, frame?: unknown }} WorkerMessage
 */
const root = fileURLToPath(new URL("../", import.meta.url));
export function remoteExecution() {
  return ["ABILOCK_", "PERMIVELO_", "COI_"].some((prefix) =>
    ["ENDPOINT", "EXEC_TOKEN"].some(
      (key) => process.env[prefix + key] !== undefined,
    ),
  );
}
function localEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(ABILOCK_|PERMIVELO_|COI_|NODE_OPTIONS$|NODE_PATH$)/.test(key),
    ),
  );
}
function localError(message = "本地执行程序异常退出；不会自动重试") {
  return Object.assign(new Error(message), {
    code: "LOCAL_EXECUTION",
    exit: 3,
  });
}
function executionHeaders(headers) {
  return Object.fromEntries(
    [...new Headers(headers)].filter(([key]) =>
      ["content-type", "x-abilock-invocation-id"].includes(key),
    ),
  );
}
async function entry(name) {
  const file = path.join(root, "dist", "src", name + ".js");
  try {
    await fs.access(file);
  } catch {
    throw Object.assign(
      new Error("本地模式需要完整 Abilock Node 运行包；源码请先完成构建"),
      {
        code: "LOCAL_RUNTIME_REQUIRED",
        exit: 3,
      },
    );
  }
  return file;
}
async function worker() {
  return fork(await entry("local-worker"), [], {
    cwd: root,
    env: localEnvironment(),
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
}
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: "cancel" }, () => {});
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 1500);
  force.unref();
  child.once("close", () => clearTimeout(force));
}
async function developmentFetch(url, options = {}) {
  if (new URL(url).origin !== new URL(localBase).origin)
    return remoteFetch(url, options);
  const child = await worker();
  const output = new PassThrough();
  let settled = false,
    done = false,
    failed = false,
    completed = false;
  // Never forward runtime diagnostics: an unexpected stack can contain credentials.
  child.stderr.resume();
  const abort = () => {
    output.destroy(
      Object.assign(new Error("请求已取消"), { name: "AbortError" }),
    );
    stop(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  output.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    if (!output.write(chunk)) child.stdout.pause();
  });
  output.on("drain", () => child.stdout.resume());
  output.once("close", () => {
    if (!completed) stop(child);
  });
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      output.destroy(error);
    };
    output.once("error", fail);
    child.on("message", (/** @type {WorkerMessage} */ message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "headers" && !settled) {
        try {
          const headers = new Headers(message.headers);
          const status = /** @type {number} */ (message.status);
          if (!Number.isInteger(status) || status < 200 || status > 599)
            throw localError();
          const response = new Response(
            [204, 205, 304].includes(status) ? null : Readable.toWeb(output),
            { status, headers },
          );
          settled = true;
          resolve(response);
        } catch {
          fail(localError());
          stop(child);
        }
      } else if (message.type === "done") {
        done = true;
        failed = message.failed === true;
      }
    });
    child.once("error", () => fail(localError()));
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      completed = true;
      if (!done || failed || code !== 0) fail(localError());
      else if (!settled) fail(localError());
      else output.end();
    });
    if (options.signal?.aborted) {
      fail(Object.assign(new Error("请求已取消"), { name: "AbortError" }));
      stop(child);
      return;
    }
    child.send(
      {
        type: "request",
        url: new URL(url).pathname,
        method: options.method ?? "GET",
        headers: executionHeaders(options.headers),
        ...(options.body !== undefined ? { body: options.body } : {}),
      },
      (error) => {
        if (error) {
          fail(localError());
          stop(child);
        }
      },
    );
  });
}
async function developmentConfiguration({ json = false } = {}) {
  const child = spawn(
    process.execPath,
    [await entry("local-config"), ...(json ? ["--json"] : [])],
    {
      cwd: root,
      env: localEnvironment(),
      stdio: "inherit",
    },
  );
  const cancel = () => child.kill("SIGINT");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", () => reject(localError("无法启动临时配置页面")));
      child.once("close", (code, signal) =>
        resolve(signal ? 130 : (code ?? 3)),
      );
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
/** @returns {Promise<TerminalSocket>} */
async function developmentTerminal(selector, headers) {
  const child = await worker();
  const socket = /** @type {TerminalSocket} */ (new EventEmitter());
  socket.readyState = 0;
  socket.bufferedAmount = 0;
  child.stderr.resume();
  child.stdout.resume();
  socket.send = (raw) => {
    if (socket.readyState !== 1) return;
    const size = Buffer.byteLength(raw);
    socket.bufferedAmount += size;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close();
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      socket.close();
      return;
    }
    child.send({ type: "frame", frame }, (error) => {
      socket.bufferedAmount -= size;
      if (error && socket.readyState === 1) socket.emit("error", localError());
    });
  };
  socket.close = () => {
    socket.readyState = 3;
    stop(child);
  };
  child.on("message", (/** @type {WorkerMessage} */ message) => {
    if (message?.type === "frame")
      socket.emit("message", Buffer.from(JSON.stringify(message.frame)));
  });
  child.once("error", () => socket.emit("error", localError()));
  child.once("close", () => {
    socket.readyState = 3;
    socket.emit("close");
  });
  // Register CLI event handlers before emitting open and sending its init frame.
  setTimeout(() => {
    child.send(
      { type: "terminal", selector, headers: executionHeaders(headers) },
      (error) => {
        if (error) {
          socket.emit("error", localError());
          return;
        }
        socket.readyState = 1;
        socket.emit("open");
      },
    );
  }, 0);
  return socket;
}

// Deliberate same-user development mode only. Missing or broken isolation never
// enables it, and the protected dedicated-user files remain OS-inaccessible.
function development() {
  return process.env.ABILOCK_DEVELOPMENT === "1";
}
function nativeTransport() { return process.platform === "win32" ? windowsIsolated : isolated; }
export function brokerFetch(url, options = {}) {
  return development()
    ? developmentFetch(url, options)
    : nativeTransport().brokerFetch(url, options);
}
export async function localConfiguration(options = {}) {
  if (development()) return developmentConfiguration(options);
  // Remote-only clients (including the Python distribution) do not ship the
  // installer. Load it only for a complete local configuration request.
  await entry("local-config");
  const { ensureIsolatedInstallation } = await import("./install-isolation.mjs");
  await ensureIsolatedInstallation();
  return nativeTransport().localConfiguration(options);
}
/** @returns {Promise<TerminalSocket>} */
export function localTerminal(selector, headers) {
  return development()
    ? developmentTerminal(selector, headers)
    : nativeTransport().localTerminal(selector, headers);
}
