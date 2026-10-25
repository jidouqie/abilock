import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { AppError, type Call, type SavedPlatform } from "./schema.js";
import { cleanPath, safeUrl, redact, matchesHttpPath } from "./security.js";
import { responseRedactor } from "./response-redaction.js";
import { adapterFor, inject } from "./adapters.js";
import { upstream, upstreamFailure } from "./transport.js";
import type { Store } from "./store.js";
import { createExperienceObserver } from "./experience-evidence.js";
import { ExperienceStore } from "./experience-store.js";
import {
  createOperationTrace,
  safeOperationTrace,
  type OperationTrace,
} from "./operation-trace.js";
const forbidden =
  /^(authorization|proxy-authorization|cookie|host|connection|content-length|transfer-encoding|upgrade|te|trailer|accept-encoding|forwarded|x-forwarded-.*|proxy-.*|x-abilock-(?:invocation|operation|request)-id)$/i;
export type ExecutionResponse = Writable & {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
};
function validValue(v: string) {
  if (/[\r\n\x00]/.test(v))
    throw new AppError(400, "UNSAFE_HEADER", "Header 值含非法控制字符");
}
function decode64(raw: string) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw,
    )
  )
    throw new AppError(400, "INVALID_BASE64", "文件必须使用标准 Base64");
  return Buffer.from(raw, "base64");
}
export function prepare(p: SavedPlatform, call: Call) {
  if (!p.enabled) throw new AppError(403, "PLATFORM_DISABLED", "平台已停用");
  cleanPath(call.path);
  if (
    !p.rules.some(
      (r) => r.method === call.method && matchesHttpPath(r.path, call.path),
    )
  )
    throw new AppError(
      403,
      "PATH_NOT_ALLOWED",
      "此方法或路径未在管理配置中允许",
    );
  const base = safeUrl(p.baseUrl, p.allowInsecureLocal);
  const url = new URL(base);
  url.pathname = base.pathname.replace(/\/$/, "") + call.path;
  const a = adapterFor(p);
  const protectedHeaders = new Set([
    p.auth.type === "header" ? p.auth.name!.toLowerCase() : "",
    ...(a?.protectedHeaders ?? []).map((x) => x.toLowerCase()),
  ]);
  const protectedQuery = new Set([
    p.auth.type === "query" ? p.auth.name!.toLowerCase() : "",
    ...(a?.protectedQuery ?? []).map((x) => x.toLowerCase()),
  ]);
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-encoding": "identity",
  };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(call.headers ?? {})) {
    const k = key.toLowerCase();
    if (
      seen.has(k) ||
      forbidden.test(k) ||
      protectedHeaders.has(k) ||
      !/^[-A-Za-z0-9]+$/.test(k)
    )
      throw new AppError(
        400,
        "HEADER_NOT_ALLOWED",
        "不允许覆盖鉴权、路由、重复或逐跳 Header",
      );
    validValue(value);
    headers[k] = value;
    seen.add(k);
  }
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (protectedQuery.has(key.toLowerCase()) || /[\x00-\x1f]/.test(key))
      throw new AppError(400, "QUERY_NOT_ALLOWED", "不允许覆盖鉴权查询字段");
    for (const v of Array.isArray(value) ? value : [value])
      url.searchParams.append(key, String(v));
  }
  let body: Buffer | undefined;
  if (call.body !== undefined) {
    body = Buffer.from(JSON.stringify(call.body));
    headers["content-type"] = "application/json";
  }
  if (call.rawBody) {
    validValue(call.rawBody.contentType);
    body = decode64(call.rawBody.base64);
    headers["content-type"] = call.rawBody.contentType;
  }
  if (call.multipart) {
    const boundary = `abilock-${crypto.randomBytes(18).toString("hex")}`;
    const chunks: Buffer[] = [];
    const name = (s: string) => {
      if (!s || /[\r\n"\\\x00]/.test(s))
        throw new AppError(
          400,
          "INVALID_MULTIPART",
          "multipart 字段名和文件名包含非法字符",
        );
      return s;
    };
    for (const [k, v] of Object.entries(call.multipart.fields ?? {}))
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name(k)}"\r\n\r\n${v}\r\n`,
        ),
      );
    for (const f of call.multipart.files) {
      validValue(f.contentType);
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name(f.field)}"; filename="${name(f.filename)}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
        ),
        decode64(f.base64),
        Buffer.from("\r\n"),
      );
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    body = Buffer.concat(chunks);
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
  }
  if (body && ["GET", "HEAD"].includes(call.method))
    throw new AppError(400, "BODY_NOT_ALLOWED", "GET/HEAD 不支持请求体");
  if (body && body.length > 10 * 1024 * 1024)
    throw new AppError(413, "TOO_LARGE", "解码请求体最大 10 MiB");
  return { url, headers, body };
}
export async function execute(
  store: Store,
  p: SavedPlatform,
  call: Call,
  res: ExecutionResponse,
  signal: AbortSignal,
  extraSecrets: string[],
  requestId: string,
  trace?: OperationTrace,
  onTrace?: (trace: OperationTrace) => void,
  options: { experience?: boolean; experienceFixture?: boolean } = {},
) {
  const proposedTrace = createOperationTrace(
    trace?.invocationId ?? call.trace?.invocationId,
  );
  const currentTrace = safeOperationTrace(proposedTrace, [
    ...store.secrets(),
    ...extraSecrets,
  ]);
  onTrace?.(currentTrace);
  res.setHeader("x-abilock-invocation-id", currentTrace.invocationId);
  res.setHeader("x-abilock-operation-id", currentTrace.operationId);
  const { url, headers, body } = prepare(p, call);
  // Only the local, explicitly opted-in path observes business results. The
  // observer is best effort and never changes the request or response bytes.
  let observer: ReturnType<typeof createExperienceObserver>;
  if (options.experience && call.experience?.capture) {
    try {
      observer = createExperienceObserver(
        p,
        call,
        currentTrace.operationId,
        [...store.secrets(), ...extraSecrets],
        { fixture: options.experienceFixture },
      );
      if (observer) res.setHeader("x-abilock-experience-id", observer.id);
    } catch {
      /* Observation cannot prevent an otherwise authorized call. */
    }
  }
  const secret = p.sealed ? store.unseal(p.sealed) : {};
  const fixedTarget = url.origin + url.pathname;
  await inject({
    platform: p,
    secret,
    url,
    method: call.method,
    headers,
    body,
  });
  if (url.origin + url.pathname !== fixedTarget)
    throw new AppError(
      422,
      "ADAPTER_TARGET_CHANGED",
      "鉴权适配器不得更改固定目标与接口路径",
    );
  const response = await upstream(
    url,
    call.method,
    headers,
    body,
    call.timeoutMs,
    signal,
    p.allowInsecureLocal,
  );
  const status = response.statusCode ?? 502;
  if (status >= 300 && status < 400) {
    response.destroy();
    throw new AppError(
      502,
      "REDIRECT_BLOCKED",
      "上游重定向已阻止；请由管理员核对固定目标",
    );
  }
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    response.destroy();
    throw new AppError(
      502,
      "ENCODING_UNSUPPORTED",
      "上游忽略 identity 编码请求；为保证脱敏拒绝压缩响应",
    );
  }
  res.statusCode = status;
  res.setHeader(
    "content-type",
    redact(response.headers["content-type"] ?? "application/octet-stream", [
      ...store.secrets(),
      ...extraSecrets,
    ]),
  );
  res.setHeader("x-abilock-request-id", requestId);
  res.setHeader("x-abilock-response-kind", "upstream");
  for (const key of ["retry-after"]) {
    const v = response.headers[key];
    if (typeof v === "string" && /^\d{1,8}$/.test(v)) res.setHeader(key, v);
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _e, cb) {
      bytes += chunk.length;
      try {
        observer?.write(chunk);
      } catch {
        observer = undefined;
      }
      cb(
        bytes > 100 * 1024 * 1024
          ? new AppError(413, "RESPONSE_TOO_LARGE", "响应最大 100 MiB")
          : null,
        chunk,
      );
    },
  });
  const recordObservation = async (complete: boolean) => {
    if (!observer) return;
    try {
      const evidence = observer.finish(
        status,
        response.headers["content-type"] ?? "application/octet-stream",
        complete,
      );
      await new ExperienceStore(store.dir, [
        ...store.secrets(),
        ...extraSecrets,
      ]).recordEvidence(p, evidence);
    } catch {
      // The CLI explicitly looks up this evidence ID and reports a fixed
      // fallback warning if missing. Never replace the original call result.
    }
  };
  try {
    await pipeline(
      response,
      limit,
      responseRedactor(
        response.headers["content-type"] ?? "application/octet-stream",
        [...store.secrets(), ...extraSecrets],
      ),
      res,
      { signal },
    );
  } catch (error) {
    await recordObservation(false);
    throw upstreamFailure(response, error);
  }
  await recordObservation(true);
  return status;
}
