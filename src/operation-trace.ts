import crypto from "node:crypto";
import { AppError } from "./schema.js";
import {
  operationTraceSchema,
  traceInputSchema,
  type Trace,
  type TraceInput,
} from "./trace-schema.js";

export type { Trace, TraceInput } from "./trace-schema.js";
export type OperationTrace = Trace;
export const runtimeInvocationId = crypto.randomUUID();
let safeRuntimeInvocationId: string = runtimeInvocationId;
const errorTraces = new WeakMap<Error, Readonly<Trace>>();

function invalidTrace(): never {
  throw new AppError(400, "TRACE_INVALID", "操作追踪信息无效");
}
function conflict(): never {
  throw new AppError(400, "TRACE_CONFLICT", "操作追踪信息不一致");
}
export function validateOperationTrace(value: unknown): Trace {
  const parsed = operationTraceSchema.safeParse(value);
  if (!parsed.success) invalidTrace();
  return parsed.data;
}
export function createOperationTrace(
  invocationId: string = safeRuntimeInvocationId,
): Trace {
  const input = traceInputSchema.safeParse({ invocationId });
  if (!input.success) invalidTrace();
  return {
    invocationId: input.data.invocationId,
    operationId: crypto.randomUUID(),
  };
}
// UUID framing and coincidental short fragments are public metadata, rather
// than an echo of a short credential. Only a complete known UUID collides.
export function traceContainsCredential(
  value: string,
  secrets: readonly string[],
) {
  return secrets.some((secret) => secret === value);
}
function safeUuid(secrets: readonly string[]): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = crypto.randomUUID();
    if (!traceContainsCredential(candidate, secrets)) return candidate;
  }
  return invalidTrace();
}
export function safeOperationTrace(
  value: Trace,
  secrets: readonly string[],
): Trace {
  const trace = validateOperationTrace(value);
  if (traceContainsCredential(trace.invocationId, secrets)) {
    if (traceContainsCredential(safeRuntimeInvocationId, secrets))
      safeRuntimeInvocationId = safeUuid(secrets);
    trace.invocationId = safeRuntimeInvocationId;
  }
  if (traceContainsCredential(trace.operationId, secrets))
    trace.operationId = safeUuid(secrets);
  return trace;
}
function readInput(value: unknown, header: boolean): TraceInput | undefined {
  if (value === undefined) return undefined;
  const parsed = traceInputSchema.safeParse(
    header && typeof value === "string" ? { invocationId: value } : value,
  );
  if (!parsed.success) invalidTrace();
  return parsed.data;
}

// Resolve only the invocation metadata. The existing service-created operation
// ID survives every layer of a single call and is never taken from caller data.
export function resolveOperationTrace(
  defaultTrace: Trace,
  headerInput?: unknown,
  payloadTrace?: unknown,
): Trace {
  const base = validateOperationTrace(defaultTrace);
  const header = readInput(headerInput, true);
  const payload = readInput(payloadTrace, false);
  if (header && payload && header.invocationId !== payload.invocationId)
    conflict();
  return {
    invocationId:
      header?.invocationId ?? payload?.invocationId ?? base.invocationId,
    operationId: base.operationId,
  };
}

export type TracedOperationError = Error & Trace & { trace: Trace };
export function operationTraceForError(error: unknown): Trace | undefined {
  if (!(error instanceof Error)) return undefined;
  const trace = errorTraces.get(error);
  return trace ? { ...trace } : undefined;
}

// Copy errors rather than mutate an adapter-owned/shared error: simultaneous
// operations must not overwrite one another's trace or cancellation reason.
export function attachOperationTrace(
  error: unknown,
  trace: Trace,
): TracedOperationError {
  const copy =
    error instanceof AppError
      ? new AppError(error.status, error.code, error.message)
      : error instanceof Error
        ? new Error(error.message)
        : new AppError(500, "OPERATION_FAILED", "操作执行失败");
  if (error instanceof Error) {
    copy.name = error.name;
    copy.stack = error.stack;
  }
  Object.defineProperty(copy, "cause", { value: error, configurable: true });
  const resolved = validateOperationTrace(trace);
  const attached = Object.assign(copy, resolved, { trace: { ...resolved } });
  errorTraces.set(attached, Object.freeze({ ...resolved }));
  return attached;
}
