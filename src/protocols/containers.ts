import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { assertResolvedTargetBoundary } from "../protocol-boundary.js";
import { z } from "zod";
import { AppError } from "../schema.js";
import { credentialSecretValues, publicAddress, redact } from "../security.js";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Connection,
  Credentials,
  Operation,
} from "../connections.js";

const baseConfig = {
  endpoint: z.string().url().max(1000),
  trustedPrivate: z.boolean().default(false),
};
const dockerConfig = z
  .object({
    ...baseConfig,
    apiVersion: z
      .string()
      .regex(/^v1\.\d{2,3}$/)
      .default("v1.47"),
    auth: z.enum(["mtls", "basic", "none"]).default("mtls"),
  })
  .strict();
const nameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .max(253);
const namespaceSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .max(63);

// Paths and API groups are code-owned, never read from a caller's raw URL.
const resources = {
  pods: ["v1", "Pod", true, ["po", "pod"]],
  services: ["v1", "Service", true, ["svc", "service"]],
  configmaps: ["v1", "ConfigMap", true, ["cm", "configmap"]],
  secrets: ["v1", "Secret", true, ["secret"]],
  persistentvolumeclaims: ["v1", "PersistentVolumeClaim", true, ["pvc"]],
  serviceaccounts: ["v1", "ServiceAccount", true, ["sa"]],
  events: ["v1", "Event", true, ["event", "ev"]],
  deployments: ["apps/v1", "Deployment", true, ["deploy", "deployment"]],
  statefulsets: ["apps/v1", "StatefulSet", true, ["sts", "statefulset"]],
  daemonsets: ["apps/v1", "DaemonSet", true, ["ds", "daemonset"]],
  replicasets: ["apps/v1", "ReplicaSet", true, ["rs", "replicaset"]],
  jobs: ["batch/v1", "Job", true, ["job"]],
  cronjobs: ["batch/v1", "CronJob", true, ["cj", "cronjob"]],
  ingresses: ["networking.k8s.io/v1", "Ingress", true, ["ing", "ingress"]],
  networkpolicies: ["networking.k8s.io/v1", "NetworkPolicy", true, ["netpol"]],
  namespaces: ["v1", "Namespace", false, ["ns", "namespace"]],
  nodes: ["v1", "Node", false, ["no", "node"]],
  persistentvolumes: ["v1", "PersistentVolume", false, ["pv"]],
  storageclasses: ["storage.k8s.io/v1", "StorageClass", false, ["sc"]],
} as const;
type Resource = keyof typeof resources;
const defaultResources = Object.keys(resources).filter(
  (key) => resources[key as Resource][2],
) as Resource[];
const kubeConfig = z
  .object({
    ...baseConfig,
    auth: z.enum(["bearer", "mtls"]).default("bearer"),
    namespace: namespaceSchema.default("default"),
    namespaces: z.array(namespaceSchema).min(1).max(100).optional(),
    resources: z
      .array(z.enum(Object.keys(resources) as [Resource, ...Resource[]]))
      .min(1)
      .max(100)
      .default(defaultResources),
  })
  .strict();

function fail(message: string, code = "CONTAINER_ARGUMENT"): never {
  throw new AppError(400, code, message);
}
function endpoint(raw: string) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /[\\\s]/.test(raw)
  )
    fail(
      "endpoint 必须为不含凭据、查询或路径的固定服务地址",
      "CONTAINER_TARGET",
    );
  if (!["https:", "http:"].includes(url.protocol))
    fail("endpoint 只接受 HTTPS", "CONTAINER_TARGET");
  return url;
}
function validateSecrets(
  kind: "docker" | "kubernetes",
  auth: string,
  secret?: Credentials,
) {
  if (!secret) return; // An existing encrypted secret can be retained by a metadata-only edit.
  const allowed =
    kind === "docker"
      ? ["ca", "cert", "key", "username", "password", "passphrase"]
      : ["ca", "cert", "key", "token", "passphrase"];
  if (Object.keys(secret).some((key) => !allowed.includes(key)))
    fail("凭据含不支持字段", "CONTAINER_CREDENTIAL");
  if (auth === "mtls" && (!secret.cert || !secret.key))
    fail("mTLS 需要客户端证书和私钥", "CONTAINER_CREDENTIAL");
  if (auth === "basic" && (!secret.username || !secret.password))
    fail("Basic 需要用户名和密码", "CONTAINER_CREDENTIAL");
  if (auth === "bearer" && !secret.token)
    fail("Bearer 需要 token", "CONTAINER_CREDENTIAL");
  if (Object.values(secret).some((value) => !value || value.length > 100000))
    fail("凭据字段为空或过大", "CONTAINER_CREDENTIAL");
  if (auth === "bearer" && /[\r\n]/.test(secret.token!))
    fail("token 不得含换行", "CONTAINER_CREDENTIAL");
  if (auth === "basic" && /[:\r\n]/.test(secret.username!))
    fail("Basic 用户名无效", "CONTAINER_CREDENTIAL");
}
function values(ctx: AdapterContext) {
  return credentialSecretValues(ctx.connection, ctx.secret);
}

type Response = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};
const responseLimit = 16 * 1024 * 1024;
type RequestBudget = {
  deadline: number;
  receivedBytes: number;
  startedRequests?: number;
};
function abortReason(signal: AbortSignal) {
  return signal.reason instanceof AppError
    ? signal.reason
    : new AppError(499, "CANCELLED", "请求已取消");
}
function waitForSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
async function request(
  ctx: AdapterContext,
  budget: RequestBudget,
  path: string,
  method = "GET",
  query: Record<string, string> = {},
  data?: unknown,
  contentType = "application/json",
): Promise<Response> {
  if (ctx.signal.aborted) throw abortReason(ctx.signal);
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0)
    throw new AppError(504, "UPSTREAM_TIMEOUT", "上游请求超时");
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const timer = setTimeout(
    () =>
      controller.abort(new AppError(504, "UPSTREAM_TIMEOUT", "上游请求超时")),
    remaining,
  );
  timer.unref();
  try {
    return await requestWithinBudget(
      { ...ctx, signal },
      path,
      method,
      query,
      data,
      contentType,
      budget,
    );
  } finally {
    clearTimeout(timer);
  }
}
async function requestWithinBudget(
  ctx: AdapterContext,
  path: string,
  method: string,
  query: Record<string, string>,
  data: unknown,
  contentType: string,
  budget: RequestBudget,
): Promise<Response> {
  const config =
    ctx.connection.kind === "docker"
      ? dockerConfig.parse(ctx.connection.config)
      : kubeConfig.parse(ctx.connection.config);
  const url = endpoint(config.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local =
    ctx.allowLocal &&
    ctx.connection.trustBoundary === "development-fixture" &&
    ["127.0.0.1", "::1", "localhost"].includes(host);
  if (url.protocol !== "https:" && !local)
    fail("正式连接必须使用 HTTPS", "CONTAINER_TARGET");
  if (
    !path.startsWith("/") ||
    /[?#\\]/.test(path) ||
    path.includes("..") ||
    path.includes("//")
  )
    fail("无效的接口路径", "CONTAINER_TARGET");
  const rows = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await waitForSignal(dns.lookup(host, { all: true }), ctx.signal);
  if (!local) {
    if (ctx.connection.trustBoundary !== "independent-target")
      fail("正式容器连接需要声明独立目标边界", "CONTAINER_BOUNDARY");
  }
  try {
    assertResolvedTargetBoundary(rows, { allowLocalFixture: local });
  } catch {
    fail(
      "容器解析包含broker本机、metadata或特殊网络目标",
      "CONTAINER_BROKER_TARGET",
    );
  }
  if (
    !rows.length ||
    rows.some(
      (row) => !publicAddress(row.address) && !config.trustedPrivate && !local,
    )
  )
    fail("私网目标需管理员在连接配置中明确信任", "CONTAINER_PRIVATE_TARGET");
  if (ctx.signal.aborted) throw abortReason(ctx.signal);
  url.pathname = path;
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  const body =
    data === undefined ? undefined : Buffer.from(JSON.stringify(data));
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
  if (body) {
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = String(body.length);
  }
  if (config.auth === "basic")
    headers.Authorization = `Basic ${Buffer.from(`${ctx.secret.username}:${ctx.secret.password}`).toString("base64")}`;
  if (config.auth === "bearer")
    headers.Authorization = `Bearer ${ctx.secret.token}`;
  return new Promise<Response>((resolve, reject) => {
    // Once request construction starts, a transport error cannot prove that a
    // write did not reach the upstream. Batch reporting must preserve unknown.
    budget.startedRequests = (budget.startedRequests ?? 0) + 1;
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers,
        signal: ctx.signal,
        agent: false,
        lookup: (_host, _options, callback) =>
          callback(null, rows[0].address, rows[0].family),
        // Defaults and certificate hostname verification stay enabled; there is no insecure flag.
        ca: ctx.secret.ca,
        cert: ctx.secret.cert,
        key: ctx.secret.key,
        passphrase: ctx.secret.passphrase,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          budget.receivedBytes += chunk.length;
          if (budget.receivedBytes > responseLimit)
            res.destroy(
              new AppError(413, "TOO_LARGE", "响应累计超过 16 MiB 限制"),
            );
          else chunks.push(chunk);
        });
        res.on("error", (error) => {
          reject(ctx.signal.aborted ? abortReason(ctx.signal) : error);
        });
        res.on("end", () => {
          if (ctx.signal.aborted) return reject(abortReason(ctx.signal));
          resolve({
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", (error) => {
      reject(ctx.signal.aborted ? abortReason(ctx.signal) : error);
    });
    req.end(body);
  });
}
function result(
  response: Response,
  ctx: AdapterContext,
  plain = false,
  allowNotModified = false,
): AdapterResult {
  if (
    response.status >= 300 &&
    response.status < 400 &&
    !(allowNotModified && response.status === 304)
  )
    return {
      exitCode: 1,
      stderr: "远端返回重定向，已拒绝跟随",
      data: { status: response.status },
    };
  if (
    response.headers["content-encoding"] &&
    response.headers["content-encoding"] !== "identity"
  )
    throw new AppError(
      502,
      "CONTAINER_ENCODING",
      "远端未遵守 identity 编码，已拒绝无法过滤的响应",
    );
  const text = redact(response.body.toString("utf8"), values(ctx));
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = undefined;
  }
  const success =
    (response.status >= 200 && response.status < 300) ||
    (allowNotModified && response.status === 304);
  const responseResult: AdapterResult = {
    exitCode: success ? 0 : 1,
    ...(success
      ? {
          stdout: plain
            ? text
            : data === undefined
              ? text
              : JSON.stringify(data, null, 2),
        }
      : { stderr: text || `远端返回 HTTP ${response.status}` }),
    data: data ?? { status: response.status },
  };
  // Internal diagnostics must not change the established CLI result shape.
  Object.defineProperty(responseResult, "httpStatus", { value: response.status });
  return responseResult;
}
function dockerInfo(response: Response, ctx: AdapterContext): AdapterResult {
  if (response.status < 200 || response.status >= 300)
    return {
      exitCode: 1,
      stderr: `远端返回 HTTP ${response.status}`,
      data: { status: response.status },
    };
  const received = result(response, ctx).data;
  if (!received || Array.isArray(received) || typeof received !== "object")
    throw new AppError(502, "DOCKER_INFO", "远端 info 响应格式无效");
  const input = received as Record<string, unknown>;
  const data: Record<string, string> = {};
  for (const key of ["ServerVersion", "OSType", "Architecture"]) {
    if (typeof input[key] !== "string")
      throw new AppError(502, "DOCKER_INFO", "远端 info 响应格式无效");
    data[key] = input[key];
  }
  return { exitCode: 0, stdout: JSON.stringify(data, null, 2), data };
}
async function kubernetesList(
  ctx: AdapterContext,
  budget: RequestBudget,
  kind: Resource,
  ns: string,
  query: Record<string, string>,
): Promise<AdapterResult> {
  const seenTokens = new Set<string>();
  let combined: Record<string, unknown> | undefined;
  let metadata: Record<string, unknown> | undefined;
  const items: unknown[] = [];
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const response = await request(
      ctx,
      budget,
      resourcePath(kind, ns),
      "GET",
      query,
      undefined,
      "application/json",
    );
    const pageResult = result(response, ctx);
    if (pageResult.exitCode) return pageResult;
    let page: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(response.body.toString("utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object")
        throw new Error("not object");
      page = value as Record<string, unknown>;
    } catch {
      throw new AppError(502, "KUBERNETES_LIST", "远端列表响应格式无效");
    }
    if (
      page.apiVersion !== resources[kind][0] ||
      page.kind !== `${resources[kind][1]}List` ||
      !Array.isArray(page.items) ||
      !page.metadata ||
      Array.isArray(page.metadata) ||
      typeof page.metadata !== "object"
    )
      throw new AppError(502, "KUBERNETES_LIST", "远端列表响应格式无效");
    const pageMetadata = page.metadata as Record<string, unknown>;
    if (
      typeof pageMetadata.resourceVersion !== "string" ||
      (pageMetadata.continue !== undefined &&
        typeof pageMetadata.continue !== "string")
    )
      throw new AppError(502, "KUBERNETES_LIST", "远端列表元数据无效");
    if (metadata && pageMetadata.resourceVersion !== metadata.resourceVersion)
      throw new AppError(
        502,
        "KUBERNETES_LIST_VERSION",
        "分页资源版本不一致，未返回部分列表",
      );
    if (!combined) {
      combined = { ...page };
      metadata = { ...pageMetadata };
      delete metadata.continue;
      delete metadata.remainingItemCount;
    }
    for (const item of page.items) items.push(item);
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    if (Date.now() >= budget.deadline)
      throw new AppError(504, "UPSTREAM_TIMEOUT", "上游请求超时");
    const next = pageMetadata.continue;
    if (!next) {
      return result(
        {
          ...response,
          body: Buffer.from(JSON.stringify({ ...combined, metadata, items })),
        },
        ctx,
      );
    }
    if (seenTokens.has(next as string))
      throw new AppError(
        502,
        "KUBERNETES_LIST_CONTINUE",
        "远端重复分页令牌，未返回部分列表",
      );
    seenTokens.add(next as string);
    query = { ...query, continue: next as string };
  }
  throw new AppError(
    413,
    "KUBERNETES_LIST_PAGES",
    "列表超过 100 页限制，未返回部分列表",
  );
}
function parsed(
  args: string[],
  specs: Record<string, "bool" | "value" | "repeat">,
) {
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const split = arg.indexOf("=");
    const key = split < 0 ? arg : arg.slice(0, split);
    const type = specs[key];
    if (!type) fail(`不支持的参数 ${key}；目标和鉴权只能在管理页设置`);
    let value = split < 0 ? undefined : arg.slice(split + 1);
    if (type === "bool") {
      if (value !== undefined && !["true", "false"].includes(value))
        fail(`${key} 需要 true/false`);
      value ??= "true";
    } else {
      value ??= args[++i];
      if (value === undefined || (value.startsWith("-") && value !== "-"))
        fail(`${key} 缺少值`);
    }
    if (flags[key] && type !== "repeat") fail(`${key} 不得重复`);
    (flags[key] ??= []).push(value);
  }
  return { flags, positional };
}
function flag(flags: Record<string, string[]>, ...names: string[]) {
  const matches = names.flatMap((name) => flags[name] ?? []);
  if (matches.length > 1) fail(`${names.join(" / ")} 不得重复`);
  return matches[0];
}
function numeric(
  value: string | undefined,
  min: number,
  max: number,
  label: string,
) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    fail(`${label} 数值越界`);
  return value;
}
function dockerTime(value: string) {
  if (/^\d+(?:\.\d{1,9})?$/.test(value)) return value;
  const duration = value.match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
  if (duration)
    return String(
      Date.now() / 1000 -
        Number(duration[1]) *
          { s: 1, m: 60, h: 3600 }[duration[2] as "s" | "m" | "h"],
    );
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/T/.test(value))
    fail("Docker since/until 使用 Unix 秒、RFC3339 或 Ns/Nm/Nh");
  return String(timestamp / 1000);
}
function identifiers(ids: string[], image = false) {
  if (
    !ids.length ||
    ids.length > 100 ||
    ids.some(
      (id) =>
        !(
          image
            ? /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,500}$/
            : /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/
        ).test(id) || id.includes(".."),
    )
  )
    fail("需要安全的容器/镜像标识，不能使用 URL 或路径");
  return ids;
}
function jsonInput(operation: Operation): unknown {
  if (!operation.input) fail("此操作需要通过 stdin / --input 提供原生 JSON");
  try {
    return JSON.parse(operation.input);
  } catch {
    fail("输入必须为有效 JSON");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object")
    fail("需要 JSON 对象");
  return value as Record<string, unknown>;
}
function batchError(error: unknown, signal: AbortSignal) {
  // The outer protocol deadline also arrives through AbortSignal. Preserve
  // its timeout code without reflecting an arbitrary cancellation reason.
  if (signal.aborted && signal.reason instanceof AppError)
    error = signal.reason;
  if (error instanceof AppError && error.code === "UPSTREAM_TIMEOUT")
    return {
      code: "UPSTREAM_TIMEOUT",
      message: "等待超时；请先核对已执行和结果未知的项目，不要重试整批。",
    };
  if (signal.aborted || (error instanceof AppError && error.status === 499))
    return {
      code: "CANCELLED",
      message: "调用已取消；请先核对已执行和结果未知的项目，不要重试整批。",
    };
  if (error instanceof AppError && error.code === "TOO_LARGE")
    return {
      code: "TOO_LARGE",
      message:
        "响应超过大小限制；请先核对已执行和结果未知的项目，不要重试整批。",
    };
  if (error instanceof AppError && error.code === "CONTAINER_ENCODING")
    return {
      code: "CONTAINER_ENCODING",
      message:
        "响应编码无法处理；请先核对已执行和结果未知的项目，不要重试整批。",
    };
  return {
    code: "UPSTREAM_FAILURE",
    message: "调用中断；请先核对已执行和结果未知的项目，不要重试整批。",
  };
}
async function sequential(
  ctx: AdapterContext,
  budget: RequestBudget,
  actions: { target: string; run: () => Promise<AdapterResult> }[],
): Promise<AdapterResult> {
  if (actions.length === 1) return actions[0].run();
  const results: AdapterResult[] = [];
  const batch: NonNullable<AdapterResult["batch"]> = {
    status: "completed",
    items: actions.map((action, index) => ({
      index,
      target: redact(action.target, values(ctx)),
      status: "not-started",
    })),
  };
  let failure: ReturnType<typeof batchError> | undefined;
  for (const [index, action] of actions.entries()) {
    if (ctx.signal.aborted || Date.now() >= budget.deadline) {
      failure = batchError(
        new AppError(504, "UPSTREAM_TIMEOUT", "上游请求超时"),
        ctx.signal,
      );
      batch.items[index].error = failure;
      break;
    }
    const startedRequests = budget.startedRequests ?? 0;
    try {
      const value = await action.run();
      results.push(value);
      batch.items[index].status = value.exitCode ? "failed" : "completed";
      batch.items[index].exitCode = value.exitCode;
      if (value.exitCode) break;
    } catch (error) {
      failure = batchError(error, ctx.signal);
      batch.items[index].status =
        (budget.startedRequests ?? 0) > startedRequests ? "unknown" : "failed";
      batch.items[index].error = failure;
      break;
    }
  }
  batch.status = ctx.signal.aborted
    ? "cancelled"
    : batch.items.every((item) => item.status === "completed")
      ? "completed"
      : "failed";
  // Preserve the legacy one-result shape for a normal first-item failure.
  if (results.length === 1 && batch.items[0].status === "failed")
    return { ...results[0], batch };
  return {
    exitCode: batch.status === "completed" ? 0 : 1,
    stdout: results
      .map((value) => value.stdout)
      .filter(Boolean)
      .join("\n"),
    stderr: [...results.map((value) => value.stderr), failure?.message]
      .filter(Boolean)
      .join("\n"),
    data: results.map((value) => value.data),
    batch,
  };
}
function demultiplexDocker(body: Buffer) {
  if (
    body.length < 8 ||
    ![0, 1, 2].includes(body[0]) ||
    !body.subarray(1, 4).equals(Buffer.alloc(3))
  )
    return body;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < body.length;) {
    if (
      offset + 8 > body.length ||
      ![0, 1, 2].includes(body[offset]) ||
      !body.subarray(offset + 1, offset + 4).equals(Buffer.alloc(3))
    )
      throw new AppError(502, "DOCKER_LOG_FRAME", "Docker 日志帧无效");
    const size = body.readUInt32BE(offset + 4);
    if (offset + 8 + size > body.length)
      throw new AppError(502, "DOCKER_LOG_FRAME", "Docker 日志帧不完整");
    chunks.push(body.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks);
}

export const dockerAdapter: Adapter = {
  validate(connection: Connection, secret?: Credentials) {
    const config = dockerConfig.parse(connection.config);
    endpoint(config.endpoint);
    validateSecrets("docker", config.auth, secret);
  },
  async run(ctx, operation) {
    const budget: RequestBudget = {
      deadline: Date.now() + operation.timeoutMs,
      receivedBytes: 0,
    };
    const config = dockerConfig.parse(ctx.connection.config);
    validateSecrets("docker", config.auth, ctx.secret);
    const prefix = `/${config.apiVersion}`;
    const [command, ...args] = operation.args;
    if (operation.files?.length)
      fail("Docker 不接受 files；create 使用原生 JSON input");
    if (operation.input !== undefined && command !== "create")
      fail("Docker input 仅用于 create JSON");
    const invoke = async (
      path: string,
      method = "GET",
      query: Record<string, string> = {},
      body?: unknown,
      plain = false,
    ) =>
      result(
        await request(ctx, budget, `${prefix}${path}`, method, query, body),
        ctx,
        plain,
        command === "start" || command === "stop",
      );
    if (command === "version" || command === "info") {
      if (args.length) fail("version/info 不接受额外参数");
      return command === "info"
        ? dockerInfo(await request(ctx, budget, `${prefix}/info`), ctx)
        : invoke("/version");
    }
    if (
      command === "ps" ||
      command === "images" ||
      (command === "image" && args[0] === "ls")
    ) {
      const { flags, positional } = parsed(
        command === "image" ? args.slice(1) : args,
        {
          "-a": "bool",
          "--all": "bool",
          "-q": "bool",
          "--quiet": "bool",
          "-f": "repeat",
          "--filter": "repeat",
          "--limit": "value",
        },
      );
      if (positional.length) fail("列表操作不接受额外位置参数");
      const query: Record<string, string> = {};
      const all = flag(flags, "-a", "--all");
      if (all) query.all = all === "true" ? "1" : "0";
      const limit = numeric(flag(flags, "--limit"), 0, 10000, "limit");
      if (limit) {
        if (command !== "ps") fail("images 不支持 --limit");
        query.limit = limit;
      }
      const filters: Record<string, string[]> = {};
      for (const entry of [
        ...(flags["-f"] ?? []),
        ...(flags["--filter"] ?? []),
      ]) {
        const index = entry.indexOf("=");
        if (index < 1) fail("filter 需要 key=value");
        const key = entry.slice(0, index);
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) fail("filter 名称无效");
        (filters[key] ??= []).push(entry.slice(index + 1));
      }
      if (Object.keys(filters).length) query.filters = JSON.stringify(filters);
      const value = await invoke(
        command === "ps" ? "/containers/json" : "/images/json",
        "GET",
        query,
      );
      if (
        flag(flags, "-q", "--quiet") === "true" &&
        !value.exitCode &&
        Array.isArray(value.data)
      )
        value.stdout =
          value.data.map((row) => object(row).Id).join("\n") + "\n";
      return value;
    }
    if (command === "inspect") {
      const { flags, positional } = parsed(args, { "--type": "value" });
      const type = flag(flags, "--type") ?? "container";
      if (!["container", "image"].includes(type))
        fail("inspect --type 只支持 container/image");
      return sequential(
        ctx,
        budget,
        identifiers(positional, type === "image").map((id) => ({
          target: id,
          run: () =>
            invoke(
              `/${type === "container" ? "containers" : "images"}/${encodeURIComponent(id)}/json`,
            ),
        })),
      );
    }
    if (command === "logs") {
      const { flags, positional } = parsed(args, {
        "--tail": "value",
        "--since": "value",
        "--until": "value",
        "-t": "bool",
        "--timestamps": "bool",
        "--details": "bool",
        "-f": "bool",
        "--follow": "bool",
      });
      identifiers(positional);
      if (positional.length !== 1) fail("logs 需要一个容器");
      const query: Record<string, string> = { stdout: "1", stderr: "1" };
      for (const key of ["since", "until", "details", "tail"]) {
        const value = flag(flags, `--${key}`);
        if (value !== undefined)
          query[key] =
            key === "since" || key === "until" ? dockerTime(value) : value;
      }
      if (query.tail && query.tail !== "all")
        numeric(query.tail, 0, 1000000, "tail");
      const timestamps = flag(flags, "-t", "--timestamps"),
        follow = flag(flags, "-f", "--follow");
      if (timestamps) query.timestamps = timestamps;
      if (follow) query.follow = follow;
      const response = await request(
        ctx,
        budget,
        `${prefix}/containers/${positional[0]}/logs`,
        "GET",
        query,
      );
      if (response.status < 300)
        response.body = demultiplexDocker(response.body);
      return result(response, ctx, true);
    }
    if (["start", "stop", "restart", "rm"].includes(command)) {
      const { flags, positional } = parsed(
        args,
        command === "rm"
          ? {
              "-f": "bool",
              "--force": "bool",
              "-v": "bool",
              "--volumes": "bool",
            }
          : command === "start"
            ? {}
            : { "-t": "value", "--time": "value", "--timeout": "value" },
      );
      const query: Record<string, string> = {};
      const time = numeric(
        flag(flags, "-t", "--time", "--timeout"),
        0,
        3600,
        "timeout",
      );
      if (time) query.t = time;
      const force = flag(flags, "-f", "--force"),
        volumes = flag(flags, "-v", "--volumes");
      if (force) query.force = force;
      if (volumes) query.v = volumes;
      return sequential(
        ctx,
        budget,
        identifiers(positional).map((id) => ({
          target: id,
          run: () =>
            invoke(
              `/containers/${id}${command === "rm" ? "" : `/${command}`}`,
              command === "rm" ? "DELETE" : "POST",
              query,
            ),
        })),
      );
    }
    if (command === "create") {
      const { flags, positional } = parsed(args, { "--name": "value" });
      if (positional.length)
        fail("create 接收 stdin 原生 ContainerCreate JSON，不接受命令字符串");
      const name = flag(flags, "--name");
      if (name) identifiers([name]);
      const body = object(jsonInput(operation));
      if (typeof body.Image !== "string" || !body.Image)
        fail("ContainerCreate JSON 需要 Image");
      return invoke("/containers/create", "POST", name ? { name } : {}, body);
    }
    fail(
      "Docker 支持 version/info/ps/images/inspect/logs/start/stop/restart/rm/create；其余命令未接入",
    );
  },
};

function resource(input: string, allowed: readonly Resource[]) {
  const value = Object.keys(resources).find(
    (key) =>
      key === input ||
      (resources[key as Resource][3] as readonly string[]).includes(input),
  ) as Resource | undefined;
  if (!value || !allowed.includes(value))
    fail("资源未在此连接的白名单中", "KUBERNETES_RESOURCE");
  return value;
}
function namespace(config: z.infer<typeof kubeConfig>, input?: string) {
  const value = namespaceSchema.parse(input ?? config.namespace);
  if (!(config.namespaces ?? [config.namespace]).includes(value))
    fail("namespace 未在连接白名单中", "KUBERNETES_NAMESPACE");
  return value;
}
function resourcePath(kind: Resource, ns: string, name?: string) {
  const [apiVersion, , namespaced] = resources[kind];
  const prefix = apiVersion === "v1" ? "/api/v1" : `/apis/${apiVersion}`;
  return `${prefix}${namespaced ? `/namespaces/${ns}` : ""}/${kind}${name ? `/${nameSchema.parse(name)}` : ""}`;
}

// A connection probe reads exactly one page of an allowed non-secret resource.
// Normal list operations may follow continuation tokens; probes must not.
const probeResources: Resource[] = ["pods", "services", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "events", "ingresses", "networkpolicies", "persistentvolumeclaims"];
export function kubernetesConnectionTestTarget(connection: Connection) {
  const config = kubeConfig.parse(connection.config);
  const kind = probeResources.find((item) => config.resources.includes(item));
  if (!kind) return null;
  const ns = namespace(config);
  return { path: resourcePath(kind, ns), kind: `${resources[kind][1]}List`, apiVersion: resources[kind][0] };
}
export async function testKubernetesConnection(context: AdapterContext): Promise<AdapterResult> {
  kubernetesAdapter.validate(context.connection, context.secret);
  const target = kubernetesConnectionTestTarget(context.connection);
  if (!target) fail("没有适用的只读测试资源", "CONNECTION_TEST_UNSUPPORTED");
  return result(await request(context, { deadline: Date.now() + 30000, receivedBytes: 0 }, target.path, "GET", { limit: "1" }), context);
}
function target(positionals: string[], allowed: readonly Resource[]) {
  const [raw, second, ...extra] = positionals;
  if (!raw || extra.length) fail("需要 resource [name] 或 resource/name");
  const split = raw.split("/");
  if (split.length > 2 || (split.length === 2 && second)) fail("资源标识无效");
  return { kind: resource(split[0], allowed), name: split[1] || second };
}
function manifests(input: unknown) {
  if (Array.isArray(input)) return input.map(object);
  const value = object(input);
  if (value.kind === "List") {
    if (!Array.isArray(value.items)) fail("List 需要 items");
    return value.items.map(object);
  }
  return [value];
}
function manifestTarget(
  value: Record<string, unknown>,
  config: z.infer<typeof kubeConfig>,
  requestedNamespace?: string,
) {
  const kind = Object.keys(resources).find(
    (key) =>
      resources[key as Resource][1] === value.kind &&
      resources[key as Resource][0] === value.apiVersion,
  ) as Resource | undefined;
  if (!kind || !config.resources.includes(kind))
    fail("manifest 的 kind/apiVersion 未在资源白名单中", "KUBERNETES_RESOURCE");
  const metadata = object(value.metadata),
    name = nameSchema.parse(metadata.name);
  const ns = namespace(
    config,
    typeof metadata.namespace === "string"
      ? metadata.namespace
      : requestedNamespace,
  );
  if (
    requestedNamespace &&
    metadata.namespace &&
    metadata.namespace !== requestedNamespace
  )
    fail("manifest namespace 与 -n 不一致", "KUBERNETES_NAMESPACE");
  if (
    kind === "namespaces" &&
    !(config.namespaces ?? [config.namespace]).includes(name)
  )
    fail("Namespace 名称未在连接白名单中", "KUBERNETES_NAMESPACE");
  if (!resources[kind][2] && metadata.namespace)
    fail("集群级资源不能含 namespace");
  return {
    kind,
    name,
    ns,
    body: {
      ...value,
      metadata: {
        ...metadata,
        ...(resources[kind][2] ? { namespace: ns } : {}),
      },
    },
  };
}
function protectPatch(value: unknown, type: string, name: string, ns: string) {
  if (type === "json") {
    if (!Array.isArray(value)) fail("JSON Patch 需要数组");
    for (const row of value) {
      const patch = object(row);
      for (const field of ["path", "from"]) {
        if (
          patch[field] !== undefined &&
          (typeof patch[field] !== "string" ||
            !String(patch[field]).startsWith("/") ||
            /^(?:\/metadata(?:\/name|\/namespace)?|\/apiVersion|\/kind)$/.test(
              String(patch[field]),
            ) ||
            patch[field] === "/")
        )
          fail("patch 不得修改资源身份", "KUBERNETES_IDENTITY");
      }
    }
  } else {
    const patch = object(value);
    if (patch.apiVersion !== undefined || patch.kind !== undefined)
      fail("patch 不得修改 kind/apiVersion", "KUBERNETES_IDENTITY");
    if (patch.metadata === null)
      fail("patch 不得删除 metadata", "KUBERNETES_IDENTITY");
    if (patch.metadata !== undefined) {
      const metadata = object(patch.metadata);
      if (
        (metadata.name !== undefined && metadata.name !== name) ||
        (metadata.namespace !== undefined && metadata.namespace !== ns)
      )
        fail("patch 不得修改资源身份", "KUBERNETES_IDENTITY");
    }
  }
}
export const kubernetesAdapter: Adapter = {
  validate(connection: Connection, secret?: Credentials) {
    const config = kubeConfig.parse(connection.config);
    endpoint(config.endpoint);
    namespace(config);
    validateSecrets("kubernetes", config.auth, secret);
  },
  async run(ctx, operation) {
    const budget: RequestBudget = {
      deadline: Date.now() + operation.timeoutMs,
      receivedBytes: 0,
    };
    const config = kubeConfig.parse(ctx.connection.config);
    validateSecrets("kubernetes", config.auth, ctx.secret);
    const [command, ...args] = operation.args;
    if (operation.files?.length)
      fail("Kubernetes 不接受 files；manifest/patch 使用 JSON input");
    if (
      operation.input !== undefined &&
      !["create", "apply", "patch"].includes(command)
    )
      fail("Kubernetes input 仅用于 manifest 或 patch");
    const common = { "-n": "value", "--namespace": "value" } as const;
    const invoke = async (
      path: string,
      method = "GET",
      query: Record<string, string> = {},
      body?: unknown,
      contentType?: string,
      plain = false,
    ) =>
      result(
        await request(ctx, budget, path, method, query, body, contentType),
        ctx,
        plain,
      );
    if (["get", "list", "describe"].includes(command)) {
      const { flags, positional } = parsed(args, {
        ...common,
        "-l": "value",
        "--selector": "value",
        "--field-selector": "value",
        "--limit": "value",
        "--chunk-size": "value",
        "-o": "value",
        "--output": "value",
      });
      const ns = namespace(config, flag(flags, "-n", "--namespace")),
        { kind, name } = target(positional, config.resources);
      if (
        kind === "namespaces" &&
        (!name || !(config.namespaces ?? [config.namespace]).includes(name))
      )
        fail("Namespace 查询必须指定获准名称", "KUBERNETES_NAMESPACE");
      const output = flag(flags, "-o", "--output");
      if (output && output !== "json")
        fail("当前输出支持 JSON，未模拟 kubectl 表格或 jsonpath");
      const query: Record<string, string> = {};
      const selector = flag(flags, "-l", "--selector"),
        fields = flag(flags, "--field-selector"),
        limit = numeric(
          flag(flags, "--limit", "--chunk-size"),
          1,
          10000,
          "limit",
        );
      if (selector) query.labelSelector = selector;
      if (fields) query.fieldSelector = fields;
      if (limit) query.limit = limit;
      if (name && Object.keys(query).length)
        fail("单个资源查询不接受列表筛选参数");
      return name
        ? invoke(resourcePath(kind, ns, name), "GET", query)
        : kubernetesList(ctx, budget, kind, ns, query);
    }
    if (["create", "apply"].includes(command)) {
      const { flags, positional } = parsed(args, {
        ...common,
        "-f": "value",
        "--filename": "value",
        "--field-manager": "value",
        "--force-conflicts": "bool",
        "--server-side": "bool",
        "--dry-run": "value",
      });
      if (positional.length || flag(flags, "-f", "--filename") !== "-")
        fail("create/apply 使用 -f - 并从 stdin / --input 读取 JSON");
      const nsFlag = flag(flags, "-n", "--namespace");
      if (nsFlag) namespace(config, nsFlag);
      const manager = flag(flags, "--field-manager") ?? "abilock";
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(manager)) fail("field-manager 无效");
      const query: Record<string, string> = { fieldManager: manager };
      const force = flag(flags, "--force-conflicts"),
        serverSide = flag(flags, "--server-side"),
        dryRun = flag(flags, "--dry-run");
      if (command === "create" && (force || serverSide))
        fail("create 不接受 apply 参数");
      if (command === "apply" && serverSide === "false")
        fail("apply 实现为 Server-Side Apply");
      if (force) query.force = force;
      if (dryRun) {
        if (dryRun !== "server") fail("仅支持 --dry-run=server");
        query.dryRun = "All";
      }
      const targets = manifests(jsonInput(operation)).map((manifest) =>
        manifestTarget(manifest, config, nsFlag),
      );
      if (!targets.length || targets.length > 100)
        fail("manifest 数量应为 1 至 100");
      return sequential(
        ctx,
        budget,
        targets.map((t) => ({
          target: resourcePath(t.kind, t.ns, t.name),
          run: () =>
            invoke(
              resourcePath(
                t.kind,
                t.ns,
                command === "apply" ? t.name : undefined,
              ),
              command === "apply" ? "PATCH" : "POST",
              query,
              t.body,
              command === "apply"
                ? "application/apply-patch+yaml"
                : "application/json",
            ),
        })),
      );
    }
    if (command === "delete") {
      const { flags, positional } = parsed(args, {
        ...common,
        "--grace-period": "value",
        "--cascade": "value",
      });
      const ns = namespace(config, flag(flags, "-n", "--namespace")),
        { kind, name } = target(positional, config.resources);
      if (!name) fail("delete 必须指定资源名，不支持批量 --all");
      if (
        kind === "namespaces" &&
        !(config.namespaces ?? [config.namespace]).includes(name)
      )
        fail("Namespace 未获准", "KUBERNETES_NAMESPACE");
      const grace = numeric(
          flag(flags, "--grace-period"),
          0,
          3600,
          "grace-period",
        ),
        cascade = flag(flags, "--cascade") ?? "background";
      if (!["background", "foreground", "orphan"].includes(cascade))
        fail("cascade 无效");
      return invoke(
        resourcePath(kind, ns, name),
        "DELETE",
        {},
        {
          apiVersion: "v1",
          kind: "DeleteOptions",
          propagationPolicy: {
            background: "Background",
            foreground: "Foreground",
            orphan: "Orphan",
          }[cascade],
          ...(grace ? { gracePeriodSeconds: Number(grace) } : {}),
        },
      );
    }
    if (command === "patch") {
      const { flags, positional } = parsed(args, {
        ...common,
        "--type": "value",
        "-p": "value",
        "--patch": "value",
      });
      const ns = namespace(config, flag(flags, "-n", "--namespace")),
        { kind, name } = target(positional, config.resources);
      if (!name) fail("patch 必须指定资源名");
      if (
        kind === "namespaces" &&
        !(config.namespaces ?? [config.namespace]).includes(name)
      )
        fail("Namespace 未获准", "KUBERNETES_NAMESPACE");
      const type = flag(flags, "--type") ?? "strategic";
      if (!["merge", "strategic", "json"].includes(type))
        fail("patch --type 支持 merge/strategic/json");
      const inline = flag(flags, "-p", "--patch");
      if (inline !== undefined && operation.input !== undefined)
        fail("patch 和 input 只能提供一个");
      let body: unknown;
      try {
        body = inline === undefined ? jsonInput(operation) : JSON.parse(inline);
      } catch {
        fail("patch 必须为有效 JSON");
      }
      protectPatch(body, type, name, ns);
      return invoke(
        resourcePath(kind, ns, name),
        "PATCH",
        {},
        body,
        {
          merge: "application/merge-patch+json",
          strategic: "application/strategic-merge-patch+json",
          json: "application/json-patch+json",
        }[type],
      );
    }
    if (command === "logs") {
      const { flags, positional } = parsed(args, {
        ...common,
        "-c": "value",
        "--container": "value",
        "--tail": "value",
        "--since": "value",
        "--since-time": "value",
        "--timestamps": "bool",
        "-p": "bool",
        "--previous": "bool",
        "-f": "bool",
        "--follow": "bool",
      });
      const ns = namespace(config, flag(flags, "-n", "--namespace"));
      if (positional.length !== 1) fail("logs 必须指定一个 Pod");
      const pod =
        positional[0].startsWith("pod/") || positional[0].startsWith("pods/")
          ? positional[0].split("/")[1]
          : positional[0];
      resource("pods", config.resources);
      const query: Record<string, string> = {};
      const container = flag(flags, "-c", "--container"),
        tail = numeric(flag(flags, "--tail"), 0, 1000000, "tail"),
        since = flag(flags, "--since"),
        sinceTime = flag(flags, "--since-time");
      if (container) query.container = nameSchema.parse(container);
      if (tail) query.tailLines = tail;
      if (since && sinceTime) fail("since 和 since-time 不可同时提供");
      if (since) {
        const match = since.match(/^(\d+)(s|m|h)$/);
        if (!match) fail("since 使用 Ns/Nm/Nh");
        query.sinceSeconds = String(
          Number(match[1]) *
            { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"],
        );
      }
      if (sinceTime) {
        if (!Number.isFinite(Date.parse(sinceTime)))
          fail("since-time 需要有效时间");
        query.sinceTime = sinceTime;
      }
      for (const [key, names] of [
        ["timestamps", ["--timestamps"]],
        ["previous", ["-p", "--previous"]],
        ["follow", ["-f", "--follow"]],
      ] as const) {
        const value = flag(flags, ...names);
        if (value) query[key] = value;
      }
      return invoke(
        `${resourcePath("pods", ns, pod)}/log`,
        "GET",
        query,
        undefined,
        undefined,
        true,
      );
    }
    if (command === "scale") {
      const { flags, positional } = parsed(args, {
        ...common,
        "--replicas": "value",
      });
      const ns = namespace(config, flag(flags, "-n", "--namespace")),
        { kind, name } = target(positional, config.resources);
      if (
        !name ||
        !["deployments", "statefulsets", "replicasets"].includes(kind)
      )
        fail("scale 支持具名 deployment/statefulset/replicaset");
      const replicas = numeric(
        flag(flags, "--replicas"),
        0,
        100000,
        "replicas",
      );
      if (!replicas) fail("scale 需要 --replicas");
      return invoke(
        `${resourcePath(kind, ns, name)}/scale`,
        "PATCH",
        {},
        { spec: { replicas: Number(replicas) } },
        "application/merge-patch+json",
      );
    }
    if (command === "rollout" && args[0] === "restart") {
      const { flags, positional } = parsed(args.slice(1), common);
      const ns = namespace(config, flag(flags, "-n", "--namespace")),
        { kind, name } = target(positional, config.resources);
      if (
        !name ||
        !["deployments", "statefulsets", "daemonsets"].includes(kind)
      )
        fail("rollout restart 支持具名 deployment/statefulset/daemonset");
      return invoke(
        resourcePath(kind, ns, name),
        "PATCH",
        {},
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                },
              },
            },
          },
        },
        "application/strategic-merge-patch+json",
      );
    }
    fail(
      "Kubernetes 支持 get/list/describe/create/apply/delete/patch/logs/scale/rollout restart；exec/插件/context/raw URL 未接入",
    );
  },
};
