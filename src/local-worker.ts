import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Writable } from "node:stream";
import type { Store } from "./store.js";
import { AppError } from "./schema.js";
import { LocalResponse, executeLocalRequest } from "./local-execution.js";
import {
  createLocalTerminalSession,
  localTerminalSchema,
} from "./local-terminal.js";
import {
  createOperationTrace,
  resolveOperationTrace,
  safeOperationTrace,
} from "./operation-trace.js";
import { loadLocalStore, localPackageRoot } from "./local-state.js";
import { learningWriteRequest } from "./local-learning.js";

const frameMessage = z
  .object({ type: z.literal("frame"), frame: z.unknown() })
  .strict();
const cancelMessage = z.object({ type: z.literal("cancel") }).strict();
export type WorkerMessage = { type: string; [key: string]: unknown };
export type LocalWorkerTransport = {
  output: Writable;
  send(message: WorkerMessage): Promise<void>;
  onMessage(receive: (raw: unknown) => void): void;
  onDisconnect(cancel: () => void): void;
  offDisconnect(cancel: () => void): void;
  close(): void;
};

function ipcTransport(): LocalWorkerTransport | undefined {
  if (!process.send) return;
  return {
    output: process.stdout,
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        if (!process.connected || !process.send) {
          reject(new Error("IPC closed"));
          return;
        }
        process.send(message, (error: Error | null) =>
          error ? reject(error) : resolve(),
        );
      }),
    onMessage: (receive) => process.on("message", receive),
    onDisconnect: (cancel) => process.once("disconnect", cancel),
    offDisconnect: (cancel) => process.off("disconnect", cancel),
    close: () => {
      if (process.connected) process.disconnect();
    },
  };
}

export function runLocalWorker(
  transport = ipcTransport(),
  options: { dir?: string; programRoot?: string } = {},
) {
  if (!transport) {
    process.stderr.write("请通过 abl 的本地执行入口使用此组件。\n");
    process.exitCode = 2;
    return;
  }
  const programRoot = options.programRoot ?? localPackageRoot;
  const controller = new AbortController();
  let store: Store | undefined;
  let terminal: ReturnType<typeof createLocalTerminalSession> | undefined;
  let busy = false,
    terminalMode = false,
    ended = false;
  let queued: unknown[] = [],
    queuedBytes = 0;
  const send = (message: WorkerMessage) => transport.send(message);
  const cancel = () => {
    controller.abort(new AppError(499, "CANCELLED", "请求已取消"));
    terminal?.cancel();
    queued = [];
    queuedBytes = 0;
    if (!busy) void finish();
  };
  const finish = async (failure?: { code: string; message: string }) => {
    if (ended) return;
    ended = true;
    queued = [];
    queuedBytes = 0;
    await store?.close().catch(() => {});
    await send({
      type: "done",
      ...(failure ? { failed: true, error: failure } : {}),
    }).catch(() => {});
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    transport.offDisconnect(cancel);
    transport.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  transport.onDisconnect(cancel);
  transport.output.once("error", cancel);
  const setupError = async (raw: unknown, error: unknown) => {
    // Configuration and native exception text is never emitted. State loading
    // failures can refer to a secret, so this envelope is entirely constant.
    let trace = createOperationTrace();
    try {
      const headers =
        raw && typeof raw === "object"
          ? Reflect.get(raw, "headers")
          : undefined;
      const invocationId =
        headers && typeof headers === "object"
          ? Reflect.get(headers, "x-abilock-invocation-id")
          : undefined;
      trace = resolveOperationTrace(trace, invocationId);
    } catch {
      /* An invalid caller trace is never echoed. */
    }
    if (store) trace = safeOperationTrace(trace, store.secrets());
    const requestId = (
      store
        ? safeOperationTrace(createOperationTrace(), store.secrets())
        : createOperationTrace()
    ).operationId;
    const configMessages: Record<string, string> = {
      CONFIG_REQUIRED: "请先运行 abl config 完成本机配置",
      LOCAL_CONFIG_INVALID:
        "本机配置无效；不会覆盖或重新生成，请在可信环境检查配置",
      LOCAL_ENV_CONFLICT: "本机执行环境与服务环境混用，请通过 abl 本机命令启动",
      CONFIG_BUSY: "另一项配置保存尚未完成，请稍后重读最新内容再重试；无需关闭应用或配置页",
    };
    const code =
      error instanceof AppError && Object.hasOwn(configMessages, error.code)
        ? error.code
        : "LOCAL_CONFIG";
    const failure = {
      code,
      message:
        configMessages[code] ??
        "本地执行配置不可用；请由用户运行 abl config 完成配置，不会覆盖现有数据",
    };
    if (terminalMode) {
      await send({
        type: "frame",
        frame: {
          type: "error",
          ...failure,
          requestId,
          ...trace,
          operationIdSource: "server",
          sequence: 1,
          direction: "server",
        },
      }).catch(() => {});
    } else {
      const response = new LocalResponse(transport.output, (headers) => {
        void send(headers).catch(cancel);
      });
      response.setHeader("x-abilock-invocation-id", trace.invocationId);
      response.setHeader("x-abilock-operation-id", trace.operationId);
      response.setHeader("x-abilock-request-id", requestId);
      response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
      });
      await new Promise<void>((resolve) => {
        response.once("error", () => resolve());
        response.end(
          JSON.stringify({
            error: failure,
            requestId,
            ...trace,
            operationIdSource: "server",
          }),
          resolve,
        );
      });
    }
    await finish();
  };
  transport.onMessage((raw: unknown) => {
    if (ended) return;
    if (cancelMessage.safeParse(raw).success) {
      cancel();
      if (!busy) void finish();
      return;
    }
    const frame = frameMessage.safeParse(raw);
    if (frame.success) {
      if (!terminalMode) {
        cancel();
        return;
      }
      if (terminal) terminal.receive(frame.data.frame);
      else {
        try {
          const size = Buffer.byteLength(JSON.stringify(frame.data.frame));
          if (queued.length >= 16 || queuedBytes + size > 4 * 1024 * 1024) {
            cancel();
            return;
          }
          queued.push(frame.data.frame);
          queuedBytes += size;
        } catch {
          cancel();
        }
      }
      return;
    }
    if (busy) {
      cancel();
      return;
    }
    busy = true;
    terminalMode =
      !!raw &&
      typeof raw === "object" &&
      Reflect.get(raw, "type") === "terminal";
    void (async () => {
      try {
        if (terminalMode) localTerminalSchema.parse(raw);
        const learningWrite = learningWriteRequest(raw);
        store = await loadLocalStore({
          dir: options.dir,
          readOnly: !learningWrite,
          requireExisting: true,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
      } catch (error) {
        await setupError(raw, error);
        return;
      }
      if (terminalMode) {
        try {
          terminal = createLocalTerminalSession(store, raw, {
            signal: controller.signal,
            send: (frame) => send({ type: "frame", frame }),
          });
          for (const frame of queued) terminal.receive(frame);
          queued = [];
          queuedBytes = 0;
          await terminal.done;
          await finish();
        } catch (error) {
          await setupError(raw, error);
        }
      } else {
        const response = new LocalResponse(transport.output, (headers) => {
          void send(headers).catch(cancel);
        });
        const result = await executeLocalRequest(store, raw, response, {
          signal: controller.signal,
          programRoot,
        });
        // A normal 4xx/5xx response has its complete safe JSON envelope. Only
        // a truncated response must reject the parent-side business stream.
        await finish(
          result.failed && !response.writableFinished
            ? result.error
            : undefined,
        );
      }
    })().catch(async () => {
      cancel();
      await finish({
        code: "LOCAL_EXECUTION",
        message: "本地执行已中断；不会自动重试",
      });
    });
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  runLocalWorker();
