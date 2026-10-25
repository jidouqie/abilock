import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { ReadableStream } from "node:stream/web";
import limits from "../request-limits.json" with { type: "json" };

function failure(code = "REMOTE_CONNECTION") {
  const messages = {
    REMOTE_CONNECTION: "远程执行连接失败或响应不完整；不会自动重试",
    REMOTE_REDIRECT: "远程执行地址返回重定向，已拒绝跟随",
    REMOTE_ENCODING: "远程执行返回了不支持的压缩响应",
    REMOTE_INPUT: "远程执行请求参数无效",
    REMOTE_CANCELLED: "远程执行请求已取消或超时",
  };
  return Object.assign(new Error(messages[code]), {
    code,
    exit: 3,
    ...(code === "REMOTE_CANCELLED" ? { name: "AbortError" } : {}),
  });
}

// Narrow broker transport: no redirects/retries, proxy/credential discovery,
// or Undici's separate 300-second headers/body deadlines. The caller's signal
// owns the deadline through body consumption; direct callers get a finite cap.
export async function remoteFetch(input, options = {}) {
  let url, headers, method;
  try {
    url = new URL(input);
    method = (options.method ?? "GET").toUpperCase();
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ||
      (options.body !== undefined &&
        typeof options.body !== "string" && !Buffer.isBuffer(options.body)) ||
      (["GET", "HEAD"].includes(method) && options.body !== undefined)
    ) throw failure("REMOTE_INPUT");
    headers = new Headers(options.headers);
    headers.set("accept-encoding", "identity");
  } catch {
    throw failure("REMOTE_INPUT");
  }
  if (options.signal?.aborted) throw failure("REMOTE_CANCELLED");
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    let request, incoming, timer;
    let resolved = false, finished = false, received = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const stop = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!resolved) reject(error);
      output.destroy(error);
      incoming?.destroy();
      request?.destroy();
    };
    const abort = () => stop(failure("REMOTE_CANCELLED"));
    // Own errors even before a Response/web reader is attached. Never surface
    // Node's raw request errors: they may contain a URL or header value.
    output.on("error", () => {});
    output.once("end", () => {
      finished = true;
      cleanup();
    });
    output.once("close", () => {
      if (!finished) stop(failure("REMOTE_CANCELLED"));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (!options.signal) {
      timer = setTimeout(abort, limits.httpClientTimeoutMs);
      timer.unref();
    }
    try {
      request = (url.protocol === "https:" ? https : http).request(url, {
        method,
        headers: Object.fromEntries(headers),
        agent: false,
      }, (response) => {
        incoming = response;
        response.on("error", () => stop(failure()));
        response.once("aborted", () => stop(failure()));
        response.once("close", () => {
          if (!received) stop(failure());
        });
        if (finished) {
          response.destroy();
          return;
        }
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304) {
          stop(failure("REMOTE_REDIRECT"));
          return;
        }
        if (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity") {
          stop(failure("REMOTE_ENCODING"));
          return;
        }
        try {
          const replyHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            replyHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const empty = method === "HEAD" || [204, 205, 304].includes(status);
          let bodyEnded = false;
          const body = empty ? null : new ReadableStream({
            start(controller) {
              output.on("data", (chunk) => {
                if (bodyEnded) return;
                controller.enqueue(chunk);
                if (controller.desiredSize <= 0) output.pause();
              });
              output.once("end", () => {
                if (!bodyEnded) {
                  bodyEnded = true;
                  controller.close();
                }
              });
              output.once("error", (error) => {
                if (!bodyEnded) {
                  bodyEnded = true;
                  controller.error(error);
                }
              });
              output.pause();
            },
            pull() { output.resume(); },
            cancel() {
              bodyEnded = true;
              output.pause();
              abort();
            },
          });
          const reply = new Response(body, {
            status,
            headers: replyHeaders,
          });
          response.once("end", () => {
            if (!response.complete) return stop(failure());
            received = true;
            output.end();
            if (empty) output.resume();
          });
          if (empty) response.resume();
          else response.pipe(output, { end: false });
          resolved = true;
          resolve(reply);
        } catch {
          stop(failure());
        }
      });
      request.on("error", () => stop(failure()));
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        stop(failure());
      });
      if (options.signal?.aborted) abort();
      if (!finished) request.end(options.body);
    } catch {
      stop(failure("REMOTE_INPUT"));
    }
  });
}
