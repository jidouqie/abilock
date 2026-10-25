import http from "node:http";
import https from "node:https";
import { AppError } from "./schema.js";
import { pinnedAddress } from "./security.js";
import { awaitWithSignal } from "./async-boundary.js";
const responseFailures = new WeakMap<http.IncomingMessage, AppError>();

// Node may report a body abort as AbortError/ECONNRESET after the request's
// response promise has resolved. Preserve the actual deadline/caller reason.
export function upstreamFailure(
  response: http.IncomingMessage,
  error: unknown,
) {
  return responseFailures.get(response) ?? error;
}
export async function upstream(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeout: number,
  signal: AbortSignal,
  allowLocal = false,
) {
  const controller = new AbortController();
  let response: http.IncomingMessage | undefined;
  const rememberFailure = () => {
    if (response && controller.signal.reason instanceof AppError)
      responseFailures.set(response, controller.signal.reason);
  };
  controller.signal.addEventListener("abort", rememberFailure, { once: true });
  const cancel = () =>
    controller.abort(
      signal.reason instanceof AppError
        ? signal.reason
        : new AppError(499, "CANCELLED", "请求已取消"),
    );
  const timer = setTimeout(
    () =>
      controller.abort(new AppError(504, "UPSTREAM_TIMEOUT", "上游请求超时")),
    timeout,
  );
  timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rememberFailure);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    // OS resolution may finish after cancellation. Only this raced, validated
    // result can proceed to a socket, and the original deadline covers both.
    const pinned = await awaitWithSignal(
      pinnedAddress(url, allowLocal),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    return await new Promise<http.IncomingMessage>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method,
          headers,
          signal: controller.signal,
          agent: false,
          lookup: (_hostname, options, cb) => {
            // Node's family selection requests the all-address callback shape.
            // Both forms use only the same previously validated, pinned result.
            if (options.all) cb(null, [pinned]);
            else cb(null, pinned.address, pinned.family);
          },
        },
        (received) => {
          if (settled) {
            received.destroy();
            return;
          }
          settled = true;
          response = received;
          resolve(received);
        },
      );
      req.once("upgrade", (_received, socket) => {
        socket.destroy();
        const error = new AppError(
          502,
          "UPGRADE_UNSUPPORTED",
          "普通 HTTP 调用不支持协议升级",
        );
        fail(error);
        req.destroy();
      });
      // Keep the deadline through the response body, then detach the caller's
      // cancellation listener together with the timer.
      req.on("close", () => {
        if (!settled)
          fail(
            controller.signal.aborted
              ? controller.signal.reason
              : new AppError(
                  502,
                  "UPSTREAM_CLOSED",
                  "上游在返回响应前关闭连接",
                ),
          );
        cleanup();
      });
      req.on("error", (error) =>
        fail(controller.signal.aborted ? controller.signal.reason : error),
      );
      if (body) req.write(body);
      req.end();
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
export async function readBounded(
  stream: AsyncIterable<Buffer | string>,
  limit: number,
) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    const b = Buffer.from(c);
    size += b.length;
    if (size > limit) throw new AppError(413, "TOO_LARGE", "内容超过大小限制");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
