import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { managementUrl, openConfigPage } from "./open-config.mjs";
import requestLimits from "../request-limits.json" with { type: "json" };
import { remoteFetch } from "./remote-fetch.mjs";

export const isolatedLauncher = "/usr/local/libexec/abilock/launch";
const localOrigin = "http://abilock.local";
const frameLimit = 8 * 1024 * 1024;

function failure(message = "隔离执行程序异常退出；不会自动重试") {
  return Object.assign(new Error(message), {
    code: "ISOLATED_EXECUTION",
    exit: 3,
  });
}
function headersOnly(headers) {
  return Object.fromEntries(
    [...new Headers(headers)].filter(([key]) =>
      ["content-type", "x-abilock-invocation-id"].includes(key),
    ),
  );
}
async function launchIsolated(mode) {
  try {
    const stat = await fs.lstat(isolatedLauncher);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      !(stat.mode & 0o4000) ||
      stat.mode & 0o022
    )
      throw failure();
  } catch {
    throw Object.assign(
      new Error("请先在自己的终端运行 abl config 完成隔离安装"),
      {
        code: "ISOLATION_REQUIRED",
        exit: 3,
      },
    );
  }
  return spawn(isolatedLauncher, [mode], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
/** @param {(error?: Error | null) => void} [callback] */
function writeFrame(child, frame, callback = () => {}) {
  let text;
  try {
    text = JSON.stringify(frame) + "\n";
  } catch {
    callback(failure());
    return;
  }
  // Bound outgoing request JSON, including worst-case escaping of a 20 MiB body.
  if (Buffer.byteLength(text) > 128 * 1024 * 1024) {
    callback(failure("本地请求超过大小限制"));
    return;
  }
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    callback(failure());
    return;
  }
  child.stdin.write(text, callback);
}
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  writeFrame(child, { type: "cancel" });
  child.stdin.end();
  // The fixed worker also observes EOF. A caller is not given privileged kill.
  try {
    child.kill("SIGTERM");
  } catch {
    /* A different UID may deny signals. */
  }
  // The privileged supervisor needs five seconds to kill an unresponsive
  // worker. Killing its parent first would strand a worker of another UID.
  const force = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* EOF remains the cancellation path. */
    }
  }, requestLimits.isolatedShutdownGraceMs);
  force.unref();
  child.once("close", () => clearTimeout(force));
}
function frames(child, receive, invalid) {
  let pending = Buffer.alloc(0),
    failed = false;
  child.stderr.resume();
  child.stdin.on("error", () => invalid(failure()));
  child.stdout.on("data", (raw) => {
    if (failed) return;
    if (pending.length + raw.length > frameLimit) {
      failed = true;
      invalid(failure());
      stop(child);
      return;
    }
    pending = Buffer.concat([pending, raw]);
    while (pending.length) {
      const at = pending.indexOf(10);
      if (at < 0) break;
      const line = pending.subarray(0, at);
      pending = pending.subarray(at + 1);
      try {
        const frame = JSON.parse(line.toString("utf8"));
        if (!frame || typeof frame !== "object" || Array.isArray(frame))
          throw failure();
        receive(frame);
      } catch {
        failed = true;
        invalid(failure());
        stop(child);
        return;
      }
    }
  });
  child.stdout.once("end", () => {
    if (pending.length && !failed) {
      failed = true;
      invalid(failure());
    }
  });
}

// Dependency injection is only a test seam. The exported production methods
// below always use the fixed root-owned native launcher.
export function createIsolatedTransport({
  launch = launchIsolated,
  open = openConfigPage,
} = {}) {
  async function brokerFetch(url, options = {}) {
    if (new URL(url).origin !== localOrigin) return remoteFetch(url, options);
    const child = await launch("execute");
    const output = new PassThrough();
    let settled = false,
      done = false,
      failed = false,
      completed = false;
    const abort = () => {
      output.destroy(
        Object.assign(new Error("请求已取消"), { name: "AbortError" }),
      );
      stop(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    output.on("error", () => {});
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
      frames(
        child,
        (message) => {
          if (done) throw failure();
          if (message.type === "headers") {
            if (
              settled ||
              !Number.isInteger(message.status) ||
              message.status < 200 ||
              message.status > 599
            )
              throw failure();
            const response = new Response(
              [204, 205, 304].includes(message.status)
                ? null
                : Readable.toWeb(output),
              { status: message.status, headers: new Headers(message.headers) },
            );
            settled = true;
            resolve(response);
          } else if (message.type === "body") {
            if (
              !settled ||
              typeof message.data !== "string" ||
              message.data.length > 128 * 1024 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                message.data,
              )
            )
              throw failure();
            if (!output.write(Buffer.from(message.data, "base64")))
              child.stdout.pause();
          } else if (message.type === "done") {
            done = true;
            failed = message.failed === true;
          } else throw failure();
        },
        fail,
      );
      child.once("error", () => fail(failure()));
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        completed = true;
        if (!done || failed || code !== 0 || !settled) fail(failure());
        else output.end();
      });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      writeFrame(
        child,
        {
          type: "request",
          url: new URL(url).pathname,
          method: options.method ?? "GET",
          headers: headersOnly(options.headers),
          ...(options.body !== undefined ? { body: options.body } : {}),
        },
        (error) => {
          if (error) {
            fail(failure());
            stop(child);
          }
        },
      );
    });
  }
  async function localConfiguration({ json = false } = {}) {
    const child = await launch("config");
    const controller = new AbortController();
    let ready = false,
      invalid = false;
    const cancel = () => {
      controller.abort();
      child.stdin.end();
      stop(child);
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      return await new Promise((resolve, reject) => {
        frames(
          child,
          (message) => {
            if (ready || message.type !== "configuration-ready")
              throw failure();
            const url = managementUrl(message.url);
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
              throw failure();
            ready = true;
            if (json)
              console.log(
                JSON.stringify({
                  ok: true,
                  event: "configuration-ready",
                  data: { url, temporary: true, executionMode: "isolated-cli" },
                }),
              );
            else
              console.log(
                `Abilock 临时配置页：${url}\n正在打开 Chrome。配置完成后按 Ctrl+C 关闭；日常调用无需保持此窗口。`,
              );
            void open(url, { signal: controller.signal }).catch(() => {
              if (!controller.signal.aborted)
                console.error(
                  "未能自动打开浏览器，请在 Chrome 手动打开上面的配置地址。配置页仍可用。",
                );
            });
          },
          () => {
            invalid = true;
            cancel();
          },
        );
        child.once("error", () => reject(failure("无法启动临时配置页面")));
        child.once("close", (code, signal) => {
          if (invalid || (!ready && !controller.signal.aborted))
            reject(failure("无法启动临时配置页面"));
          else resolve(signal ? 130 : (code ?? 3));
        });
      });
    } finally {
      controller.abort();
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
  async function localTerminal(selector, headers) {
    const child = await launch("execute");
    const socket = /** @type {import("./local-transport.mjs").TerminalSocket} */ (
      new EventEmitter()
    );
    socket.readyState = 0;
    socket.bufferedAmount = 0;
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
      writeFrame(child, { type: "frame", frame }, (error) => {
        socket.bufferedAmount -= size;
        if (error && socket.readyState === 1) socket.emit("error", failure());
      });
    };
    socket.close = () => {
      socket.readyState = 3;
      stop(child);
    };
    frames(
      child,
      (message) => {
        if (message.type === "frame")
          socket.emit("message", Buffer.from(JSON.stringify(message.frame)));
        else if (message.type !== "done") throw failure();
      },
      () => {
        socket.emit("error", failure());
        stop(child);
      },
    );
    child.once("error", () => socket.emit("error", failure()));
    child.once("close", () => {
      socket.readyState = 3;
      socket.emit("close");
    });
    setTimeout(
      () =>
        writeFrame(
          child,
          {
            type: "terminal",
            selector,
            headers: headersOnly(headers),
          },
          (error) => {
            if (error) {
              socket.emit("error", failure());
              return;
            }
            socket.readyState = 1;
            socket.emit("open");
          },
        ),
      0,
    );
    return socket;
  }
  return { brokerFetch, localConfiguration, localTerminal };
}

const production = createIsolatedTransport();
export const { brokerFetch, localConfiguration, localTerminal } = production;
