import path from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { AppError } from "./schema.js";
import { traceInputSchema } from "./trace-schema.js";
import {
  createOperationTrace,
  resolveOperationTrace,
  safeOperationTrace,
  traceContainsCredential,
} from "./operation-trace.js";
import { Redactor } from "./security.js";
import { assertTargetBoundary } from "./protocol-boundary.js";
import { openTerminal } from "./protocols/ssh.js";

export const localTerminalSchema = z
  .object({
    type: z.literal("terminal"),
    selector: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
  })
  .strict();
const frameTrace = {
  invocationId: z.string().uuid().optional(),
  operationId: z.string().uuid().optional(),
  sequence: z.number().int().positive().optional(),
  direction: z.literal("client").optional(),
};
const frameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("init"),
      trace: traceInputSchema,
      sequence: frameTrace.sequence,
      direction: frameTrace.direction,
    })
    .strict(),
  z
    .object({
      type: z.literal("data"),
      data: z.string().max(1400000),
      ...frameTrace,
    })
    .strict(),
  z
    .object({
      type: z.literal("resize"),
      rows: z.number().int().min(1).max(500),
      cols: z.number().int().min(1).max(500),
      ...frameTrace,
    })
    .strict(),
  z.object({ type: z.literal("eof"), ...frameTrace }).strict(),
]);
export type LocalTerminalOptions = {
  signal: AbortSignal;
  send: (frame: Record<string, unknown>) => Promise<void>;
  allowLocalFixture?: boolean;
  // Internal dependency for synthetic tests; never read from IPC input.
  open?: typeof openTerminal;
};

export function createLocalTerminalSession(
  store: Store,
  raw: unknown,
  options: LocalTerminalOptions,
) {
  const request = localTerminalSchema.parse(raw);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (key !== "x-abilock-invocation-id" || key in headers)
      throw new AppError(400, "HEADER_NOT_ALLOWED", "本地终端 Header 无效");
    headers[key] = value;
  }
  const secrets = store.secrets();
  const trace = Object.freeze(
    safeOperationTrace(
      resolveOperationTrace(
        createOperationTrace(),
        headers["x-abilock-invocation-id"],
      ),
      secrets,
    ),
  );
  const requestId = safeOperationTrace(
    createOperationTrace(),
    secrets,
  ).operationId;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let terminal: Awaited<ReturnType<typeof openTerminal>> | undefined;
  let filter: Redactor | undefined;
  let ended = false,
    serverSequence = 0,
    clientSequence = 0;
  let frames = 0,
    frameBytes = 0,
    windowAt = Date.now(),
    queuedBytes = 0;
  let sendQueue: Promise<void> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const send = (frame: Record<string, unknown>) => {
    if (ended) return Promise.resolve();
    const output = {
      ...frame,
      requestId,
      ...trace,
      operationIdSource: "server",
      sequence: ++serverSequence,
      direction: "server",
    };
    const size = Buffer.byteLength(JSON.stringify(output));
    queuedBytes += size;
    if (queuedBytes > 4 * 1024 * 1024) {
      release();
      return Promise.reject(
        new AppError(413, "TERMINAL_BACKPRESSURE", "终端输出积压过多"),
      );
    }
    const current = sendQueue.then(() => options.send(output));
    sendQueue = current
      .catch(() => {
        release();
      })
      .finally(() => {
        queuedBytes -= size;
      });
    return current;
  };
  const handshake = setTimeout(
    () => controller.abort(new AppError(504, "SSH_TIMEOUT", "SSH连接超时")),
    15000,
  );
  handshake.unref();
  const maximum = setTimeout(() => {
    release();
  }, 3600000);
  maximum.unref();
  const release = () => {
    if (ended) return;
    ended = true;
    clearTimeout(handshake);
    clearTimeout(maximum);
    signal.removeEventListener("abort", release);
    controller.abort();
    terminal?.close();
    filter?.destroy();
    void sendQueue.finally(finish);
  };
  signal.addEventListener("abort", release, { once: true });
  const receive = (rawFrame: unknown) => {
    if (ended) return;
    try {
      if (Date.now() - windowAt > 1000) {
        frames = 0;
        frameBytes = 0;
        windowAt = Date.now();
      }
      frameBytes += Buffer.byteLength(JSON.stringify(rawFrame));
      if (++frames > 200 || frameBytes > 2 * 1024 * 1024) {
        release();
        return;
      }
      const frame = frameSchema.parse(rawFrame);
      if (frame.sequence !== undefined && frame.sequence !== clientSequence + 1)
        throw new Error("sequence");
      clientSequence++;
      if (frame.type === "init") {
        const resolved = resolveOperationTrace(
          trace,
          headers["x-abilock-invocation-id"],
          frame.trace,
        );
        if (
          resolved.invocationId !== trace.invocationId ||
          traceContainsCredential(resolved.invocationId, secrets)
        )
          throw new Error("trace context");
        return;
      }
      if (
        (frame.invocationId !== undefined &&
          frame.invocationId !== trace.invocationId) ||
        (frame.operationId !== undefined &&
          frame.operationId !== trace.operationId)
      )
        throw new Error("trace context");
      if (!terminal) throw new Error("not ready");
      if (frame.type === "data") {
        if (
          terminal.stream.writableLength > 2 * 1024 * 1024 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            frame.data,
          )
        ) {
          release();
          return;
        }
        terminal.stream.write(Buffer.from(frame.data, "base64"));
      } else if (frame.type === "resize")
        terminal.resize(frame.rows, frame.cols);
      else terminal.stream.end();
    } catch {
      void send({
        type: "error",
        code: "INVALID_TERMINAL_FRAME",
        message: "终端帧无效或尚未就绪",
      }).catch(() => {});
    }
  };
  void (async () => {
    signal.throwIfAborted();
    const connection = store.connection("ssh", request.selector);
    if (!connection.enabled)
      throw new AppError(403, "CONNECTION_DISABLED", "连接已停用");
    await assertTargetBoundary(
      connection,
      options.allowLocalFixture === true,
      signal,
    );
    signal.throwIfAborted();
    terminal = await (options.open ?? openTerminal)(
      {
        connection,
        secret: connection.sealed
          ? store.unsealCredentials(connection.sealed)
          : {},
        signal,
        allowLocal: options.allowLocalFixture === true,
        dataDir: path.join(store.dir, "workspaces"),
        trace,
      },
      { rows: 24, cols: 80 },
    );
    clearTimeout(handshake);
    if (ended) {
      terminal.close();
      return;
    }
    filter = new Redactor(secrets);
    terminal.stream.once("error", () => {
      void send({
        type: "error",
        code: "TERMINAL_STREAM_FAILED",
        message: "终端流已中断",
      })
        .catch(() => {})
        .finally(release);
    });
    // Early SSH close still flushes the final redaction tail.
    terminal.stream.once("close", () => {
      if (filter && !filter.writableEnded) filter.end();
    });
    await send({ type: "ready" });
    terminal.stream.pipe(filter);
    for await (const chunk of filter) {
      if (ended) break;
      await send({
        type: "data",
        data: Buffer.from(chunk as Buffer).toString("base64"),
      });
    }
    if (!ended) await send({ type: "exit", code: terminal.exitCode });
    release();
  })().catch(() => {
    if (ended) return;
    void send({
      type: "error",
      code: "TERMINAL_FAILED",
      message: "终端连接失败，请检查目标地址、账号与凭据",
    })
      .catch(() => {})
      .finally(release);
  });
  if (signal.aborted) release();
  return {
    receive,
    cancel: release,
    done,
    trace,
    requestId,
    summary: () => ({
      exitCode: terminal?.exitCode ?? 1,
      messagesIn: clientSequence,
      messagesOut: serverSequence,
    }),
  };
}
// The same session serves the local IPC worker and the explicit service's
// WebSocket endpoint; only the frame transport differs.
export const createTerminalSession = createLocalTerminalSession;
