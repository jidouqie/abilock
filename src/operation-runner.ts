import { performance } from "node:perf_hooks";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Operation,
} from "./connections.js";
import { AppError } from "./schema.js";
import {
  attachOperationTrace,
  createOperationTrace,
  resolveOperationTrace,
  runtimeInvocationId,
  safeOperationTrace,
  traceContainsCredential,
  validateOperationTrace,
  type Trace,
} from "./operation-trace.js";
export { operationTraceForError } from "./operation-trace.js";

export type TracedAdapterContext = AdapterContext & { trace?: Trace };
export type TracedOperationInput = Operation & { trace?: unknown };
export type TracedAdapterResult = AdapterResult & Trace;
export type OperationEvent = Trace & {
  event: "start" | "completed" | "failed" | "cancelled";
  protocol: AdapterContext["connection"]["kind"];
  alias: string;
  status: "running" | "completed" | "failed" | "cancelled";
  durationMs: number;
};
export type OperationEventHandler = (
  event: OperationEvent,
) => void | Promise<void>;

function cancelled(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof AppError &&
      (error.status === 499 || /CANCELLED$/.test(error.code)))
  );
}

export async function runProtocolOperation(
  adapter: Adapter,
  context: TracedAdapterContext,
  operation: TracedOperationInput,
  trace?: Trace,
  onEvent?: OperationEventHandler,
): Promise<TracedAdapterResult> {
  const startedAt = performance.now();
  // Every actual execution gets a fresh service-generated operation ID, even
  // when worker code reuses a context or an earlier trace for correlation.
  const secretValues = Object.values(context.secret).filter(Boolean);
  let resolved = safeOperationTrace(createOperationTrace(), secretValues);
  const containsSecret = (value: string) =>
    secretValues.some((secret) => value.includes(secret));
  const safeIds = () =>
    !traceContainsCredential(resolved.invocationId, secretValues) &&
    !traceContainsCredential(resolved.operationId, secretValues);
  const emit = (event: OperationEvent["event"]) => {
    if (!safeIds()) return;
    const record: OperationEvent = {
      ...resolved,
      event,
      protocol: context.connection.kind,
      alias: containsSecret(context.connection.alias)
        ? "[REDACTED]"
        : context.connection.alias,
      status: event === "start" ? "running" : event,
      durationMs: Math.max(0, performance.now() - startedAt),
    };
    // Logging failures must not turn completed business effects into failures
    // that a caller could mistakenly retry. Async handlers are also bounded to
    // observation: they do not block the actual operation or leak rejections.
    try {
      const pending = onEvent?.(record);
      if (pending) void pending.catch(() => {});
    } catch {
      /* Logging is optional and cannot change execution semantics. */
    }
  };
  try {
    const supplied = trace ? validateOperationTrace(trace) : undefined;
    const existing = context.trace
      ? validateOperationTrace(context.trace)
      : undefined;
    resolved = {
      ...resolved,
      invocationId:
        supplied?.invocationId ??
        existing?.invocationId ??
        resolved.invocationId,
    };
    if (trace && context.trace) {
      if (existing?.invocationId !== resolved.invocationId)
        throw new AppError(400, "TRACE_CONFLICT", "操作追踪信息不一致");
    }
    const candidate = resolveOperationTrace(
      resolved,
      undefined,
      operation.trace,
    );
    if (
      traceContainsCredential(candidate.invocationId, secretValues) ||
      traceContainsCredential(candidate.operationId, secretValues)
    ) {
      resolved = safeOperationTrace(
        { ...resolved, invocationId: runtimeInvocationId },
        secretValues,
      );
      throw new AppError(400, "TRACE_INVALID", "操作追踪信息无效");
    }
    if (
      (trace || context.trace) &&
      candidate.invocationId !== resolved.invocationId
    )
      throw new AppError(400, "TRACE_CONFLICT", "操作追踪信息不一致");
    resolved = candidate;
    const { trace: _callerTrace, ...input } = operation;
    void _callerTrace;
    const adapterContext: TracedAdapterContext = {
      ...context,
      trace: Object.freeze({ ...resolved }),
    };
    emit("start");
    context.signal.throwIfAborted();
    if (context.connection.kind !== "git" && input.deletions !== undefined)
      throw new AppError(
        400,
        "OPERATION_DELETIONS",
        "删除清单仅适用于 Git 提交",
      );
    const result = await adapter.run(adapterContext, input);
    if (context.signal.aborted && result.batch) {
      // A cancelled batch may already have changed upstream resources. Keep
      // the completed/unknown/not-started ledger instead of losing it to an
      // exception that could prompt the caller to replay the whole batch.
      emit("cancelled");
      return {
        ...result,
        exitCode: result.exitCode || 1,
        batch: { ...result.batch, status: "cancelled" },
        ...resolved,
      };
    }
    context.signal.throwIfAborted();
    emit(result.exitCode === 0 ? "completed" : "failed");
    return { ...result, ...resolved };
  } catch (error) {
    resolved = safeOperationTrace(resolved, secretValues);
    emit(cancelled(error, context.signal) ? "cancelled" : "failed");
    throw attachOperationTrace(error, resolved);
  }
}
