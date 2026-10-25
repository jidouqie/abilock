import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  connectionKinds,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type Connection,
  type Operation,
} from "../src/connections.js";
import { AppError } from "../src/schema.js";
import {
  traceInputSchema,
  operationTraceSchema,
  type Trace,
} from "../src/trace-schema.js";
import {
  createOperationTrace,
  resolveOperationTrace,
  runtimeInvocationId,
  type TracedOperationError,
} from "../src/operation-trace.js";
import {
  runProtocolOperation,
  operationTraceForError,
  type TracedAdapterContext,
  type OperationEvent,
} from "../src/operation-runner.js";

// Pure adapters never access their synthetic paths, credentials or targets.
const secret = "synthetic-operation-private-key-68413";
const input = "synthetic-operation-body-68414";
const target = "https://synthetic.invalid/private-target";
function context(
  kind: Connection["kind"] = "ssh",
  trace?: Trace,
): TracedAdapterContext {
  return {
    connection: {
      alias: "SYNTHETIC",
      name: "合成能力",
      description: "",
      kind,
      enabled: true,
      config: { endpoint: target },
    },
    secret: { value: secret },
    signal: new AbortController().signal,
    allowLocal: false,
    dataDir: "/synthetic-unused-directory",
    ...(trace ? { trace } : {}),
  };
}
function operation(): Operation {
  return { args: ["synthetic-business-operation"], input, timeoutMs: 30000 };
}
function stub(
  run: (ctx: TracedAdapterContext, op: Operation) => Promise<AdapterResult>,
): Adapter {
  return { validate: () => {}, run };
}
function traceFrom(ctx: AdapterContext) {
  const trace = (ctx as TracedAdapterContext).trace;
  assert(trace);
  assert(operationTraceSchema.safeParse(trace).success);
  return trace;
}
function tracedAppError(error: AppError): AppError & TracedOperationError {
  assert(
    operationTraceSchema.safeParse({
      invocationId: Reflect.get(error, "invocationId"),
      operationId: Reflect.get(error, "operationId"),
    }).success,
  );
  assert(operationTraceSchema.safeParse(Reflect.get(error, "trace")).success);
  return error as AppError & TracedOperationError;
}
function assertSafeEvents(events: OperationEvent[]) {
  const keys = [
    "invocationId",
    "operationId",
    "event",
    "protocol",
    "alias",
    "status",
    "durationMs",
  ].sort();
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), keys);
    assert(
      operationTraceSchema.safeParse({
        invocationId: event.invocationId,
        operationId: event.operationId,
      }).success,
    );
    assert(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    for (const privateValue of [secret, input, target])
      assert(!JSON.stringify(event).includes(privateValue));
  }
}

test("追踪输入仅接受UUID invocationId，调用内解析保留服务operationId且不回显非法值", () => {
  assert(
    traceInputSchema.safeParse({ invocationId: runtimeInvocationId }).success,
  );
  const other = crypto.randomUUID();
  for (const value of [
    { invocationId: other, operationId: crypto.randomUUID() },
    { invocationId: other, caller: "synthetic-caller" },
    { invocationId: other, target },
    { invocationId: secret },
    null,
    [],
  ])
    assert(!traceInputSchema.safeParse(value).success);
  const initial = createOperationTrace();
  assert.equal(initial.invocationId, runtimeInvocationId);
  assert.notEqual(initial.operationId, createOperationTrace().operationId);
  assert.deepEqual(resolveOperationTrace(initial), initial);
  assert.deepEqual(
    resolveOperationTrace(initial, other, { invocationId: other }),
    { ...initial, invocationId: other },
  );
  assert.deepEqual(resolveOperationTrace(initial, { invocationId: other }), {
    ...initial,
    invocationId: other,
  });
  const snapshot = structuredClone(initial);
  for (const [header, payload, code] of [
    [secret, undefined, "TRACE_INVALID"],
    [[], undefined, "TRACE_INVALID"],
    [
      undefined,
      { invocationId: other, operationId: initial.operationId },
      "TRACE_INVALID",
    ],
    [undefined, { invocationId: other, caller: secret }, "TRACE_INVALID"],
    [other, { invocationId: crypto.randomUUID() }, "TRACE_CONFLICT"],
  ] as const) {
    assert.throws(
      () => resolveOperationTrace(initial, header, payload),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.status, 400);
        assert.equal(error.code, code);
        assert(!error.message.includes(secret));
        assert(!error.message.includes(other));
        return true;
      },
    );
  }
  assert.deepEqual(initial, snapshot);
});

test("所有协议适配器共用纯运行器，trace进入context且调用正文不含trace", async () => {
  const invocationId = crypto.randomUUID();
  const events: OperationEvent[] = [];
  const ids = new Set<string>();
  const adapter = stub(async (ctx, op) => {
    const trace = traceFrom(ctx);
    assert.equal(trace.invocationId, invocationId);
    assert(Object.isFrozen(trace));
    assert(!("trace" in op));
    assert.deepEqual(op, operation());
    return { exitCode: 0, data: { protocol: ctx.connection.kind } };
  });
  for (const kind of connectionKinds) {
    const result = await runProtocolOperation(
      adapter,
      context(kind),
      { ...operation(), trace: { invocationId } },
      undefined,
      (event) => {
        events.push(event);
      },
    );
    assert.equal(result.invocationId, invocationId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.data, { protocol: kind });
    assert(!ids.has(result.operationId));
    ids.add(result.operationId);
  }
  assert.equal(ids.size, connectionKinds.length);
  assert.equal(events.length, connectionKinds.length * 2);
  assert.deepEqual(
    [...new Set(events.map((event) => event.protocol))].sort(),
    [...connectionKinds].sort(),
  );
  for (let i = 0; i < events.length; i += 2) {
    assert.equal(events[i].event, "start");
    assert.equal(events[i + 1].event, "completed");
    assert.equal(events[i].operationId, events[i + 1].operationId);
  }
  assertSafeEvents(events);
});

test("直接调用默认属于当前进程，适配器返回值不能覆盖服务追踪ID", async () => {
  let received: Trace | undefined;
  const events: OperationEvent[] = [];
  const adapter = stub(async (ctx) => {
    received = traceFrom(ctx);
    return {
      exitCode: 7,
      invocationId: "synthetic-forged-invocation",
      operationId: "synthetic-forged-operation",
    };
  });
  const result = await runProtocolOperation(
    adapter,
    context(),
    operation(),
    undefined,
    (event) => {
      events.push(event);
    },
  );
  assert.equal(result.invocationId, runtimeInvocationId);
  assert.deepEqual(
    { invocationId: result.invocationId, operationId: result.operationId },
    received,
  );
  assert.equal(result.exitCode, 7, "nonzero native exit codes are preserved");
  assert.deepEqual(
    events.map((event) => event.event),
    ["start", "failed"],
  );
  assertSafeEvents(events);
});

test("复用同context/trace并发与跨invocation调用均获得独立operationId", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: Trace[] = [];
  const events: OperationEvent[] = [];
  const adapter = stub(async (ctx) => {
    const trace = traceFrom(ctx);
    seen.push(trace);
    await hold;
    return { exitCode: 0, data: { trace } };
  });
  const firstTrace = createOperationTrace(crypto.randomUUID());
  const secondTrace = createOperationTrace(crypto.randomUUID());
  const first = context("ssh", firstTrace);
  const second = context("postgres", secondTrace);
  const snapshot = structuredClone([firstTrace, secondTrace]);
  const pending = [first, first, second, second].map((ctx) =>
    runProtocolOperation(adapter, ctx, operation(), ctx.trace, (event) => {
      events.push(event);
    }),
  );
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen.map((trace) => trace.operationId)).size, 4);
  assert(
    seen
      .slice(0, 2)
      .every((trace) => trace.invocationId === firstTrace.invocationId),
  );
  assert(
    seen
      .slice(2)
      .every((trace) => trace.invocationId === secondTrace.invocationId),
  );
  assert(
    seen.every(
      (trace) => !snapshot.some((old) => old.operationId === trace.operationId),
    ),
  );
  release();
  const results = await Promise.all(pending);
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].operationId, seen[i].operationId);
    assert.equal(results[i].invocationId, seen[i].invocationId);
    assert.equal(
      events.filter((event) => event.operationId === results[i].operationId)
        .length,
      2,
    );
  }
  assert.deepEqual([first.trace, second.trace], snapshot);
  assertSafeEvents(events);
});

test("非法或冲突trace连接前拒绝，客户端不能指定或复用operationId", async () => {
  const fixed = createOperationTrace(crypto.randomUUID());
  let calls = 0;
  const adapter = stub(async () => {
    calls++;
    return { exitCode: 0 };
  });
  for (const trace of [
    { invocationId: fixed.invocationId, operationId: fixed.operationId },
    { invocationId: crypto.randomUUID() },
    { invocationId: fixed.invocationId, target },
    { invocationId: secret },
  ]) {
    await assert.rejects(
      runProtocolOperation(
        adapter,
        context("ssh", fixed),
        { ...operation(), trace },
        fixed,
      ),
      (error: unknown) => {
        assert(error instanceof AppError);
        const traced = tracedAppError(error);
        assert.equal(error.status, 400);
        assert(["TRACE_INVALID", "TRACE_CONFLICT"].includes(error.code));
        assert.equal(traced.invocationId, fixed.invocationId);
        assert.notEqual(traced.operationId, fixed.operationId);
        assert(!error.message.includes(secret));
        return true;
      },
    );
  }
  assert.equal(calls, 0);
});

test("异常保留AppError语义和独立trace，不改写共享或冻结的适配器错误", async () => {
  const original = Object.freeze(
    new AppError(409, "SYNTHETIC_CONFLICT", "合成冲突"),
  );
  const trace = createOperationTrace(crypto.randomUUID());
  const events: OperationEvent[] = [];
  const adapter = stub(async () => {
    throw original;
  });
  const errors = await Promise.all(
    [1, 2].map(async () => {
      try {
        await runProtocolOperation(
          adapter,
          context("redis", trace),
          operation(),
          trace,
          (event) => {
            events.push(event);
          },
        );
        assert.fail("adapter must fail");
      } catch (error) {
        assert(error instanceof AppError);
        assert.notEqual(error, original);
        assert.equal(error.status, original.status);
        assert.equal(error.code, original.code);
        assert.equal(error.message, original.message);
        const traced = tracedAppError(error);
        assert.equal(traced.cause, original);
        assert.equal(traced.invocationId, trace.invocationId);
        assert.deepEqual(traced.trace, {
          invocationId: traced.invocationId,
          operationId: traced.operationId,
        });
        assert.deepEqual(operationTraceForError(traced), traced.trace);
        return traced;
      }
    }),
  );
  assert.notEqual(errors[0].operationId, errors[1].operationId);
  assert(!("trace" in original));
  assert.equal(operationTraceForError(original), undefined);
  assert.equal(
    operationTraceForError(
      Object.assign(new Error("synthetic"), trace, { trace }),
    ),
    undefined,
  );
  const safeCopy = operationTraceForError(errors[0]);
  assert(safeCopy);
  safeCopy.operationId = crypto.randomUUID();
  assert.equal(
    operationTraceForError(errors[0])?.operationId,
    errors[0].operationId,
  );
  assert.deepEqual(events.map((event) => event.event).sort(), [
    "failed",
    "failed",
    "start",
    "start",
  ]);
  assertSafeEvents(events);
});

test("取消在运行前与返回后均带trace，保留原取消原因且不报告完成", async () => {
  const reason = new AppError(499, "SYNTHETIC_CANCELLED", "合成取消");
  let calls = 0;
  const before = new AbortController();
  before.abort(reason);
  const events: OperationEvent[] = [];
  await assert.rejects(
    runProtocolOperation(
      stub(async () => {
        calls++;
        return { exitCode: 0 };
      }),
      { ...context(), signal: before.signal },
      operation(),
      undefined,
      (event) => {
        events.push(event);
      },
    ),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, reason.code);
      assert.equal(tracedAppError(error).cause, reason);
      return true;
    },
  );
  assert.equal(calls, 0);
  const after = new AbortController();
  await assert.rejects(
    runProtocolOperation(
      stub(async () => {
        after.abort(reason);
        return { exitCode: 0 };
      }),
      { ...context("mysql"), signal: after.signal },
      operation(),
      undefined,
      (event) => {
        events.push(event);
      },
    ),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.status, 499);
      assert.equal(error.code, reason.code);
      assert(
        operationTraceSchema.safeParse(tracedAppError(error).trace).success,
      );
      return true;
    },
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ["start", "cancelled", "start", "cancelled"],
  );
  const during = new AbortController();
  const pending = runProtocolOperation(
    stub(
      async (ctx) =>
        new Promise<AdapterResult>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(ctx.signal.reason),
            { once: true },
          );
        }),
    ),
    { ...context("git"), signal: during.signal },
    operation(),
    undefined,
    (event) => {
      events.push(event);
    },
  );
  during.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert(
      operationTraceSchema.safeParse(operationTraceForError(error)).success,
    );
    return true;
  });
  assert.deepEqual(
    events.slice(-2).map((event) => event.event),
    ["start", "cancelled"],
  );
  assertSafeEvents(events);
});

test("同步或异步日志失败不改变业务结果且不会泄露输入", async () => {
  const adapter = stub(async () => ({ exitCode: 0, data: "synthetic-result" }));
  for (const logger of [
    () => {
      throw new Error(secret);
    },
    async () => {
      throw new Error(input);
    },
  ]) {
    const result = await runProtocolOperation(
      adapter,
      context("s3"),
      operation(),
      undefined,
      logger,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.data, "synthetic-result");
    assert(
      operationTraceSchema.safeParse({
        invocationId: result.invocationId,
        operationId: result.operationId,
      }).success,
    );
  }
});

test("取消后保留已执行批次结果并记录cancelled，避免调用方重放成功项目", async () => {
  const controller = new AbortController();
  const events: OperationEvent[] = [];
  const batch: NonNullable<AdapterResult["batch"]> = {
    status: "failed",
    items: [
      { index: 0, target: "one", status: "completed", exitCode: 0 },
      { index: 1, target: "two", status: "unknown" },
      { index: 2, target: "three", status: "not-started" },
    ],
  };
  const result = await runProtocolOperation(
    stub(async () => {
      controller.abort(new Error(secret));
      return { exitCode: 1, data: [{ status: 204 }], batch };
    }),
    { ...context("docker"), signal: controller.signal },
    operation(),
    undefined,
    (event) => {
      events.push(event);
    },
  );
  assert.deepEqual(result.data, [{ status: 204 }]);
  assert.equal(result.batch?.status, "cancelled");
  assert.deepEqual(result.batch?.items, batch.items);
  assert.equal(
    batch.status,
    "failed",
    "the adapter's original ledger is not mutated",
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ["start", "cancelled"],
  );
  assertSafeEvents(events);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("非Git协议拒绝deletions，包括空清单，且不会调用适配器", async () => {
  let calls = 0;
  const adapter = stub(async () => {
    calls++;
    return { exitCode: 0 };
  });
  for (const kind of connectionKinds.filter((kind) => kind !== "git")) {
    for (const deletions of [
      [],
      [{ path: "synthetic.txt", sha256: "a".repeat(64) }],
    ]) {
      await assert.rejects(
        runProtocolOperation(adapter, context(kind), {
          ...operation(),
          deletions,
        }),
        { code: "OPERATION_DELETIONS" },
      );
    }
  }
  assert.equal(calls, 0);
  await runProtocolOperation(adapter, context("git"), {
    ...operation(),
    deletions: [],
  });
  assert.equal(calls, 1);
});

test("已知合成凭据不能作为invocationId回显，日志alias同样过滤已知凭据", async () => {
  const credential = crypto.randomUUID();
  let calls = 0;
  const events: OperationEvent[] = [];
  const adapter = stub(async () => {
    calls++;
    return { exitCode: 0 };
  });
  await assert.rejects(
    runProtocolOperation(
      adapter,
      {
        ...context(),
        secret: { password: credential },
      },
      { ...operation(), trace: { invocationId: credential } },
      undefined,
      (event) => {
        events.push(event);
      },
    ),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, "TRACE_INVALID");
      assert(!JSON.stringify(error).includes(credential));
      return true;
    },
  );
  assert.equal(calls, 0);
  assert(!JSON.stringify(events).includes(credential));
  const privateAlias = "SYNTHETIC";
  const result = await runProtocolOperation(
    adapter,
    {
      ...context("docker"),
      secret: { password: privateAlias },
    },
    operation(),
    undefined,
    (event) => {
      events.push(event);
    },
  );
  assert.equal(result.exitCode, 0);
  assert(events.slice(-2).every((event) => event.alias === "[REDACTED]"));
  assert(!JSON.stringify(events.slice(-2)).includes(privateAlias));
});
