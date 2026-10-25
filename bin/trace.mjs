import crypto from "node:crypto";

const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const failure = (code, message) =>
  Object.assign(new Error(message), { code, exit: 3 });

export function createCliTrace() {
  const invocationId = crypto.randomUUID();
  let operationId = crypto.randomUUID(),
    operationIdSource = "client",
    show = false,
    shown,
    frameSequence = 0;
  const metadata = () => ({ invocationId, operationId, operationIdSource });
  const reset = () => {
    operationId = crypto.randomUUID();
    operationIdSource = "client";
    frameSequence = 0;
  };
  function contextError() {
    reset();
    return failure(
      "TRACE_CONTEXT",
      "服务操作编号无效或响应上下文不一致；不会合并其他操作的结果",
    );
  }
  function notice() {
    if (show && shown !== operationId) {
      shown = operationId;
      process.stderr.write(
        `[Abilock] invocationId=${invocationId} operationId=${operationId} source=${operationIdSource}\n`,
      );
    }
  }
  function response(res) {
    const receivedInvocation = res.headers.get("x-abilock-invocation-id");
    const receivedOperation = res.headers.get("x-abilock-operation-id");
    if (
      (receivedInvocation !== null && receivedInvocation !== invocationId) ||
      (receivedOperation !== null && !uuid(receivedOperation)) ||
      (receivedOperation !== null && receivedInvocation === null)
    )
      throw contextError();
    if (receivedOperation) {
      operationId = receivedOperation;
      operationIdSource = "server";
    }
    notice();
    return metadata();
  }
  function verifyBody(body) {
    if (!body || typeof body !== "object") return;
    if (body.invocationId !== undefined && body.invocationId !== invocationId)
      throw contextError();
    if (body.operationId !== undefined) {
      if (
        !uuid(body.operationId) ||
        body.invocationId !== invocationId ||
        (operationIdSource === "server" && body.operationId !== operationId)
      )
        throw contextError();
      operationId = body.operationId;
      operationIdSource = "server";
      notice();
    }
  }
  function frame(value) {
    if (
      !value ||
      value.direction !== "server" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== frameSequence + 1 ||
      !uuid(value.operationId) ||
      value.invocationId !== invocationId ||
      (operationIdSource === "server" && value.operationId !== operationId)
    )
      throw contextError();
    operationId = value.operationId;
    operationIdSource = "server";
    frameSequence = value.sequence;
    notice();
  }
  function assertInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw failure("INVALID_INPUT", "操作封装必须是 JSON 对象");
    if (
      ["trace", "operationId", "invocationId"].some((key) =>
        Object.hasOwn(value, key),
      )
    )
      throw failure(
        "TRACE_INPUT",
        "操作编号由客户端与服务生成，不接受手写 trace 或 operationId",
      );
    return value;
  }
  return {
    invocationId,
    metadata,
    reset,
    notice,
    show(value) {
      show = value;
    },
    response,
    verifyBody,
    frame,
    assertInput,
    headers(value = {}) {
      return { ...value, "x-abilock-invocation-id": invocationId };
    },
    envelope(value) {
      return { ...assertInput(value), trace: { invocationId } };
    },
    json(value) {
      process.stdout.write(JSON.stringify({ ...value, ...metadata() }) + "\n");
    },
  };
}
