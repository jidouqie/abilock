import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { AppError } from "./schema.js";
import type { Store } from "./store.js";
import { operationTraceForError } from "./operation-runner.js";
import {
  createOperationTrace,
  resolveOperationTrace,
  safeOperationTrace,
  type OperationTrace,
} from "./operation-trace.js";
import { cleanJson } from "./result-redaction.js";
import {
  publicError,
  routeExecution,
  writePublicJson,
} from "./execution-routes.js";
import {
  LOCAL_REQUEST_MAX_BODY,
  localRequestSchema,
  type LocalRequest,
} from "./local-request.js";

export { localRequestSchema, type LocalRequest };
export type LocalResponseHeaders = {
  type: "headers";
  status: number;
  headers: Record<string, string>;
};

// A Writable response without a socket or listening server. The same HTTP
// execution boundary streams into this sink, including SSE and binary data.
export class LocalResponse extends Writable {
  statusCode = 200;
  private sent = false;
  private readonly values = new Map<string, string>();
  constructor(
    private readonly output: Writable,
    private readonly sendHeaders: (message: LocalResponseHeaders) => void,
  ) {
    super();
  }
  get headersSent() {
    return this.sent;
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    if (this.sent) throw new Error("Headers already sent");
    this.values.set(name.toLowerCase(), String(value));
    return this;
  }
  getHeader(name: string) {
    return this.values.get(name.toLowerCase());
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers))
      this.setHeader(name, value);
    this.flushHeaders();
    return this;
  }
  flushHeaders() {
    if (this.sent) return;
    this.sent = true;
    this.sendHeaders({
      type: "headers",
      status: this.statusCode,
      headers: Object.fromEntries(this.values),
    });
  }
  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.flushHeaders();
    this.output.write(chunk, encoding, callback);
  }
  override _final(callback: (error?: Error | null) => void) {
    this.flushHeaders();
    callback();
  }
}

export type LocalExecutionOptions = {
  signal: AbortSignal;
  programRoot: string;
  // Internal synthetic fixture option; the IPC protocol cannot set it.
  allowLocalFixture?: boolean;
};
export type LocalExecutionOutcome = {
  failed: boolean;
  error?: { code: string; message: string };
};

function requestBody(raw: string | undefined, limit = LOCAL_REQUEST_MAX_BODY) {
  if (raw === undefined)
    throw new AppError(400, "INVALID_JSON", "请求 JSON 无效");
  if (Buffer.byteLength(raw) > limit)
    throw new AppError(413, "TOO_LARGE", "请求内容超过大小限制");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(400, "INVALID_JSON", "请求 JSON 无效");
  }
}
export const localError = publicError;

export async function executeLocalRequest(
  store: Store,
  raw: unknown,
  res: LocalResponse,
  options: LocalExecutionOptions,
): Promise<LocalExecutionOutcome> {
  let secrets = store.secrets();
  const requestId = safeOperationTrace(
    createOperationTrace(),
    secrets,
  ).operationId;
  let trace: OperationTrace = safeOperationTrace(
    createOperationTrace(),
    secrets,
  );
  const updateTrace = (next: OperationTrace) => {
    trace = safeOperationTrace(next, secrets);
    res.setHeader("x-abilock-invocation-id", trace.invocationId);
    res.setHeader("x-abilock-operation-id", trace.operationId);
  };
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-abilock-request-id", requestId);
  updateTrace(trace);
  // Attach before pipeline starts: a failed upstream can destroy the sink.
  let responseError: unknown;
  const completion = finished(res).catch((error: unknown) => {
    responseError = error;
  });
  try {
    options.signal.throwIfAborted();
    await store.refresh();
    secrets = store.secrets();
    const input = localRequestSchema.parse(raw);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (
        !["content-type", "x-abilock-invocation-id"].includes(lower) ||
        lower in headers
      )
        throw new AppError(
          400,
          "HEADER_NOT_ALLOWED",
          "本地执行请求 Header 无效",
        );
      headers[lower] = value;
    }
    updateTrace(
      resolveOperationTrace(trace, headers["x-abilock-invocation-id"]),
    );
    const route = input.url,
      method = input.method;
    if (
      !route.startsWith("/") ||
      route.includes("\\") ||
      route.includes("%") ||
      route.includes("?") ||
      route.includes("#") ||
      route.startsWith("//")
    )
      throw new AppError(400, "INVALID_ROUTE", "路由无效");
    if (method === "GET" && input.body !== undefined)
      throw new AppError(400, "BODY_NOT_ALLOWED", "GET 不支持请求体");
    if (
      method === "POST" &&
      !headers["content-type"]?.startsWith("application/json")
    )
      throw new AppError(415, "CONTENT_TYPE", "需要 application/json");
    const handled = await routeExecution({
      store,
      route,
      method,
      readJson: async () =>
        requestBody(
          input.body,
          input.url.startsWith("/v2/experience/")
            ? 16384
            : LOCAL_REQUEST_MAX_BODY,
        ),
      res,
      signal: options.signal,
      secrets: () => secrets,
      requestId,
      trace: () => trace,
      updateTrace,
      invocationHeader: headers["x-abilock-invocation-id"],
      programRoot: options.programRoot,
      allowLocal: options.allowLocalFixture === true,
      allowLocalDocuments: options.allowLocalFixture === true,
      learning: true,
    });
    if (!handled)
      throw new AppError(404, "NOT_FOUND", "接口不存在或不属于执行角色");
    await completion;
    if (responseError) throw responseError;
    return { failed: false };
  } catch (error) {
    const executionTrace = operationTraceForError(error);
    if (executionTrace && !res.headersSent && !res.destroyed)
      updateTrace(executionTrace);
    const failure = publicError(error);
    const output = cleanJson(
      { code: failure.code, message: failure.message },
      secrets,
    ) as {
      code: string;
      message: string;
    };
    if (!res.headersSent && !res.destroyed) {
      writePublicJson(
        res,
        failure.status,
        { error: output, requestId, ...trace, operationIdSource: "server" },
        secrets,
        store,
      );
      await completion;
    } else if (!res.destroyed) res.destroy();
    return { failed: true, error: output };
  }
}
