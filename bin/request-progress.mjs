import requestLimits from "../request-limits.json" with { type: "json" };
import { TransformStream } from "node:stream/web";

// This reports only what this client has observed. A waiting process cannot
// tell whether an upstream model is thinking, queued, or stuck.
export function requestProgress({
  enabled = false,
  write = (text) => process.stderr.write(text),
  now = Date.now,
  intervalMs = requestLimits.progressIntervalMs,
} = {}) {
  const started = now();
  let lastData, headers = false, bytes = 0, timer;
  const report = () => {
    const elapsed = Math.max(0, Math.floor((now() - started) / 1000));
    let state = headers ? "已收到响应头，等待正文" : "尚未收到响应";
    if (lastData !== undefined) {
      const quiet = Math.max(0, Math.floor((now() - lastData) / 1000));
      state = `已接收 ${bytes} 字节，距最近数据 ${quiet} 秒`;
    }
    write(`[Abilock] 已等待 ${elapsed} 秒；${state}。仍在等待，可按 Ctrl+C 取消。\n`);
  };
  if (enabled) {
    timer = setInterval(report, intervalMs);
    timer.unref?.();
  }
  return {
    wrap(response) {
      if (!enabled) return response;
      headers = true;
      if (!response.body) return response;
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          lastData = now();
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    stop() {
      clearInterval(timer);
    },
  };
}
