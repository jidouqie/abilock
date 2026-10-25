import { setting } from "../environment.js";
/* eslint-disable no-control-regex -- reject credential header control bytes */
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Credentials,
  Operation,
} from "../connections.js";
import { AppError } from "../schema.js";
import { pinnedAddress, redact, redactBytes, safeUrl } from "../security.js";
import { awaitWithSignal } from "../async-boundary.js";

const commands = [
  "ping",
  "catalog",
  "tags",
  "manifest-get",
  "manifest-head",
  "manifest-put",
  "manifest-delete",
  "blob-get",
  "blob-head",
  "blob-put",
  "blob-delete",
] as const;
const mediaTypes = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
] as const;
const repoPattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const configSchema = z
  .object({
    endpoint: z.string().max(1000),
    authType: z.enum(["none", "basic", "bearer"]),
    allowedRepositories: z
      .array(z.string().min(1).max(255).regex(repoPattern))
      .min(1)
      .max(200),
    allowedCommands: z
      .array(z.enum(commands))
      .min(1)
      .default([...commands]),
    allowInsecureLocal: z.boolean().default(false),
    maxBytes: z.number().int().min(1).max(12_000_000).default(12_000_000),
    // Explicit administrator trust for a self-hosted registry on an ordinary
    // private network; loopback/link-local/metadata stay refused.
    trustedPrivate: z.boolean().default(false),
    // Public CA certificate (PEM) for such a registry; never a credential.
    ca: z.string().min(1).max(100000).optional(),
  })
  .strict();
type Config = z.infer<typeof configSchema>;
type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};
function invalid(message: string): never {
  throw new AppError(400, "REGISTRY_ARGUMENT", message);
}
function registryUrl(raw: string, local: boolean, allowPrivate = false) {
  const u = safeUrl(raw, local, allowPrivate);
  if (u.pathname !== "/" || u.search || /[\\%]/.test(raw))
    invalid("Registry endpoint 必须是固定根地址");
  return u;
}
function validateSecret(config: Config, secret?: Credentials) {
  if (secret === undefined) return;
  const fields =
    config.authType === "basic"
      ? ["username", "password"]
      : config.authType === "bearer"
        ? ["token"]
        : [];
  if (
    Object.keys(secret).some((k) => !fields.includes(k)) ||
    fields.some((k) => !secret[k]) ||
    Object.values(secret).some((v) => /[\r\n\u0000]/.test(v))
  )
    invalid("请通过 UI 填写当前 Registry 鉴权类型的秘密字段");
  if (config.authType === "basic" && secret.username.includes(":"))
    invalid("Basic username 不得含冒号");
}
function auth(config: Config, secret: Credentials) {
  validateSecret(config, secret);
  if (config.authType === "basic")
    return `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString("base64")}`;
  if (config.authType === "bearer") return `Bearer ${secret.token}`;
  return undefined;
}
function values(config: Config, secret: Credentials) {
  return [
    ...Object.values(secret),
    ...(config.authType === "basic"
      ? [`${secret.username}:${secret.password}`, auth(config, secret)!]
      : config.authType === "bearer"
        ? [auth(config, secret)!]
        : []),
  ];
}
function digest(bytes: Buffer) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
function checkedDigest(raw: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(raw))
    invalid("digest 需使用 sha256: 加 64 位小写十六进制");
  return raw;
}
function reference(raw: string) {
  if (/^sha256:/.test(raw)) return checkedDigest(raw);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(raw))
    invalid("manifest reference 必须是安全 tag 或 SHA-256 digest");
  return raw;
}
function repository(raw: string, config: Config) {
  if (
    !repoPattern.test(raw) ||
    raw.length > 255 ||
    !config.allowedRepositories.includes(raw)
  )
    invalid("repository 不在管理配置的允许名单中");
  return raw;
}
function options(args: string[], specs: string[]) {
  const positional: string[] = [],
    flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    if (
      !specs.includes(value) ||
      Object.hasOwn(flags, value) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      invalid("未知、重复或缺少值的 Registry 参数");
    flags[value] = args[++i];
  }
  return { positional, flags };
}
function payload(op: Operation, label: string | undefined, maxBytes: number) {
  let bytes: Buffer;
  if (label) {
    if (/^file(?:b)?:\/\//i.test(label))
      invalid("Registry 上传文件必须由客户端封装");
    const matches = (op.files || []).filter((f) => f.path === label);
    if (
      matches.length !== 1 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        matches[0].base64,
      )
    )
      invalid("--body 需要恰好一个同名、有效 base64 的 files 文件");
    bytes = Buffer.from(matches[0].base64, "base64");
  } else if (op.input !== undefined) bytes = Buffer.from(op.input);
  else invalid("上传需要 --body 与 files 或 stdin input");
  if (bytes.length > maxBytes)
    throw new AppError(413, "REGISTRY_LIMIT", "Registry 上传超过大小限制");
  return bytes;
}
function parseJson(reply: Reply) {
  try {
    return JSON.parse(reply.body.toString()) as unknown;
  } catch {
    throw new AppError(502, "REGISTRY_JSON", "Registry 返回了无效 JSON");
  }
}
function jsonResult(data: unknown): AdapterResult {
  return { exitCode: 0, data, stdout: JSON.stringify(data, null, 2) + "\n" };
}
function returnedFile(label: string, bytes: Buffer) {
  if (
    !label ||
    label.startsWith("/") ||
    label.includes("\\") ||
    label.split("/").some((x) => x === "." || x === "..") ||
    label.length > 1000
  )
    invalid("下载文件标签必须是安全相对路径");
  return { path: label, base64: bytes.toString("base64") };
}
function responseMetadata(reply: Reply) {
  const contentDigest = reply.headers["docker-content-digest"];
  if (
    contentDigest !== undefined &&
    (typeof contentDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(contentDigest))
  )
    throw new AppError(502, "REGISTRY_DIGEST", "Registry 返回无效 digest");
  return {
    status: reply.status,
    digest: contentDigest,
    contentType: reply.headers["content-type"],
    contentLength: reply.headers["content-length"],
  };
}
function verifyDigest(
  bytes: Buffer,
  expected?: string,
  declared?: string | string[],
) {
  const actual = digest(bytes);
  if (
    (expected && actual !== checkedDigest(expected)) ||
    (declared &&
      (typeof declared !== "string" || actual !== checkedDigest(declared)))
  )
    throw new AppError(
      502,
      "REGISTRY_DIGEST",
      "Registry 内容的 SHA-256 digest 不匹配",
    );
  return actual;
}
function safeUploadLocation(
  raw: string | undefined,
  origin: URL,
  repo: string,
) {
  if (!raw || raw.length > 8000 || raw.includes("\\"))
    throw new AppError(
      502,
      "REGISTRY_UPLOAD_LOCATION",
      "Registry 未返回安全的上传地址",
    );
  const u = new URL(raw, origin);
  const prefix = `/v2/${repo}/blobs/uploads/`;
  if (
    u.origin !== origin.origin ||
    u.username ||
    u.password ||
    u.hash ||
    !u.pathname.startsWith(prefix) ||
    u.pathname.length <= prefix.length ||
    /%|\/\//.test(u.pathname) ||
    u.pathname.split("/").some((p) => p === "." || p === "..")
  )
    throw new AppError(
      502,
      "REGISTRY_UPLOAD_LOCATION",
      "Registry 上传地址必须绑定当前 origin 和 repository",
    );
  return u;
}

async function session(
  context: AdapterContext,
  config: Config,
  timeoutMs: number,
) {
  context.signal.throwIfAborted();
  const origin = registryUrl(
    config.endpoint,
    context.allowLocal && config.allowInsecureLocal,
    config.trustedPrivate,
  );
  const pinned = await awaitWithSignal(
    pinnedAddress(
      origin,
      context.allowLocal && config.allowInsecureLocal,
      config.trustedPrivate,
    ),
    context.signal,
  );
  context.signal.throwIfAborted();
  const normalized = (address: string) =>
    ipaddr.process(address.replace(/%.+$/, "")).toNormalizedString();
  const own = new Set(
    Object.values(networkInterfaces()).flatMap((rows) =>
      (rows || []).map((row) => normalized(row.address)),
    ),
  );
  const fixture =
    context.allowLocal &&
    config.allowInsecureLocal &&
    setting("ALLOW_LOCAL") === "1" &&
    origin.hostname === "127.0.0.1";
  if (!fixture && own.has(normalized(pinned.address)))
    throw new AppError(
      400,
      "REGISTRY_BROKER_TARGET",
      "Registry 不得指向 broker 本机",
    );
  const agentOptions: http.AgentOptions = {
    keepAlive: false,
    lookup: (_host, opts, cb) => dns.lookup(pinned.address, opts, cb),
  };
  const agent =
    origin.protocol === "https:"
      ? new https.Agent({
          ...agentOptions,
          rejectUnauthorized: true,
          ...(config.ca ? { ca: config.ca } : {}),
        })
      : new http.Agent(agentOptions);
  const authorization = auth(config, context.secret);
  const request = (
    method: string,
    target: string | URL,
    body?: Buffer,
    customHeaders: Record<string, string> = {},
  ) =>
    new Promise<Reply>((resolve, reject) => {
      context.signal.throwIfAborted();
      const u = typeof target === "string" ? new URL(target, origin) : target;
      if (
        u.origin !== origin.origin ||
        u.username ||
        u.password ||
        u.hash ||
        !u.pathname.startsWith("/v2/") ||
        u.pathname.includes("%") ||
        u.pathname.includes("\\")
      ) {
        reject(
          new AppError(400, "REGISTRY_TARGET", "Registry 请求不得改变固定目标"),
        );
        return;
      }
      const headers: Record<string, string | number> = {
        accept: "application/json",
        "accept-encoding": "identity",
        ...customHeaders,
      };
      if (authorization) headers.authorization = authorization;
      if (body) headers["content-length"] = body.length;
      const req = (u.protocol === "https:" ? https : http).request(
        u,
        { method, headers, agent, signal: context.signal },
        (res) => {
          if (res.statusCode! >= 300 && res.statusCode! < 400) {
            res.destroy();
            reject(
              new AppError(502, "REGISTRY_REDIRECT", "Registry 重定向已拒绝"),
            );
            return;
          }
          if (
            res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity"
          ) {
            res.destroy();
            reject(
              new AppError(
                502,
                "REGISTRY_ENCODING",
                "Registry 不得返回压缩响应",
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (bytes: Buffer) => {
            length += bytes.length;
            if (length > config.maxBytes) {
              res.destroy();
              reject(
                new AppError(
                  413,
                  "REGISTRY_LIMIT",
                  "Registry 响应超过大小限制",
                ),
              );
            } else chunks.push(bytes);
          });
          res.on("error", reject);
          res.on("end", () => {
            const reply = {
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks),
            };
            if (reply.status === 401) {
              reject(
                new AppError(
                  401,
                  "REGISTRY_AUTH_REQUIRED",
                  "Registry 拒绝当前 UI 凭据；不会自动访问认证 challenge realm",
                ),
              );
              return;
            }
            if (reply.status >= 400) {
              let code = "REGISTRY_UPSTREAM";
              try {
                const data = JSON.parse(reply.body.toString()) as {
                  errors?: { code?: string }[];
                };
                const remote = data.errors?.[0]?.code;
                if (remote && /^[A-Z_]{1,100}$/.test(remote))
                  code = `REGISTRY_${remote}`;
              } catch {
                /* Never return raw remote error bodies. */
              }
              reject(
                new AppError(
                  reply.status,
                  code,
                  `Registry HTTP ${reply.status}`,
                ),
              );
              return;
            }
            resolve(reply);
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () =>
        req.destroy(new AppError(504, "REGISTRY_TIMEOUT", "Registry 操作超时")),
      );
      req.end(body);
    });
  return { origin, request, close: () => agent.destroy() };
}

function redactData(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactData(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        redact(k, secrets),
        redactData(v, secrets),
      ]),
    );
  return value;
}
async function run(context: AdapterContext, operation: Operation) {
  const config = configSchema.parse(context.connection.config);
  registryUrl(config.endpoint, config.allowInsecureLocal, config.trustedPrivate);
  validateSecret(config, context.secret);
  let command = operation.args[0];
  const args = operation.args.slice(1);
  if (command === "manifest" || command === "blob") {
    command += `-${args.shift() || ""}`;
  }
  if (
    !commands.includes(command as (typeof commands)[number]) ||
    !config.allowedCommands.includes(command as (typeof commands)[number])
  )
    invalid("该 Registry 命令未实现或未被管理员允许");
  const allowedFlags =
    command === "catalog" || command === "tags"
      ? ["--n", "--last"]
      : command === "manifest-put"
        ? ["--body", "--content-type"]
        : command === "blob-put"
          ? ["--body", "--digest"]
          : [];
  const parsed = options(args, allowedFlags);
  let repo: string | undefined,
    ref: string | undefined,
    upload: Buffer | undefined;
  if (command !== "catalog" && command !== "ping")
    repo = repository(parsed.positional[0] || "", config);
  if (
    [
      "manifest-get",
      "manifest-head",
      "manifest-put",
      "manifest-delete",
      "blob-get",
      "blob-head",
      "blob-delete",
    ].includes(command)
  )
    ref = command.startsWith("manifest-")
      ? reference(parsed.positional[1] || "")
      : checkedDigest(parsed.positional[1] || "");
  if (command === "manifest-delete") checkedDigest(ref!);
  if (command.endsWith("-put"))
    upload = payload(operation, parsed.flags["--body"], config.maxBytes);
  let manifestType: string | undefined;
  if (command === "manifest-put") {
    try {
      const manifest = z
        .object({
          schemaVersion: z.literal(2),
          mediaType: z.enum(mediaTypes).optional(),
        })
        .passthrough()
        .parse(JSON.parse(upload!.toString()));
      manifestType =
        parsed.flags["--content-type"] || manifest.mediaType || mediaTypes[0];
      if (
        !mediaTypes.includes(manifestType as (typeof mediaTypes)[number]) ||
        (manifest.mediaType && manifest.mediaType !== manifestType)
      )
        invalid("manifest mediaType 与 Content-Type 必须匹配已支持类型");
    } catch (error) {
      if (error instanceof AppError) throw error;
      invalid("manifest-put 需要 schemaVersion 2 的有效 JSON 清单");
    }
    if (ref!.startsWith("sha256:")) verifyDigest(upload!, ref);
  }
  if (command === "blob-put" && parsed.flags["--digest"])
    verifyDigest(upload!, parsed.flags["--digest"]);
  const maxPositionals =
    command === "catalog" || command === "ping"
      ? 0
      : command === "tags" || command === "blob-put"
        ? 1
        : command.endsWith("-get")
          ? 3
          : 2;
  if (parsed.positional.length > maxPositionals)
    invalid("Registry 位置参数过多");
  const api = await session(context, config, operation.timeoutMs);
  try {
    if (command === "ping") {
      const reply = await api.request("GET", "/v2/");
      return jsonResult({
        status: reply.status,
        apiVersion: reply.headers["docker-distribution-api-version"],
      });
    }
    if (command === "catalog" || command === "tags") {
      const target = new URL(
        command === "catalog" ? "/v2/_catalog" : `/v2/${repo}/tags/list`,
        api.origin,
      );
      if (parsed.flags["--n"]) {
        if (
          !/^\d+$/.test(parsed.flags["--n"]) ||
          +parsed.flags["--n"] < 1 ||
          +parsed.flags["--n"] > 1000
        )
          invalid("分页 n 需在 1–1000 内");
        target.searchParams.set("n", parsed.flags["--n"]);
      }
      if (parsed.flags["--last"]) {
        const last = parsed.flags["--last"];
        if (
          command === "catalog"
            ? !repoPattern.test(last)
            : !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(last)
        )
          invalid("分页 last 无效");
        target.searchParams.set("last", last);
      }
      const reply = await api.request("GET", target);
      const data =
        command === "catalog"
          ? z
              .object({ repositories: z.array(z.string()) })
              .parse(parseJson(reply))
          : z
              .object({
                name: z.string(),
                tags: z.array(z.string()).nullable(),
              })
              .parse(parseJson(reply));
      if ("repositories" in data)
        data.repositories = data.repositories.filter((name) =>
          config.allowedRepositories.includes(name),
        );
      return jsonResult(data);
    }
    if (command === "blob-put") {
      const start = await api.request(
        "POST",
        `/v2/${repo}/blobs/uploads/`,
        Buffer.alloc(0),
      );
      if (start.status !== 202)
        throw new AppError(
          502,
          "REGISTRY_UPLOAD_STATUS",
          "Registry 未接受 blob 上传会话",
        );
      const target = safeUploadLocation(
        typeof start.headers.location === "string"
          ? start.headers.location
          : undefined,
        api.origin,
        repo!,
      );
      const contentDigest = digest(upload!);
      target.searchParams.set("digest", contentDigest);
      const finish = await api.request("PUT", target, upload, {
        "content-type": "application/octet-stream",
      });
      if (finish.status !== 201)
        throw new AppError(
          502,
          "REGISTRY_UPLOAD_STATUS",
          "Registry 未确认 blob 上传完成",
        );
      if (
        finish.headers["docker-content-digest"] &&
        finish.headers["docker-content-digest"] !== contentDigest
      )
        throw new AppError(
          502,
          "REGISTRY_DIGEST",
          "Registry 上传 digest 与本地 SHA-256 不一致",
        );
      return jsonResult({
        ...responseMetadata(finish),
        digest: contentDigest,
        bytes: upload!.length,
      });
    }
    const target = `/v2/${repo}/${command.startsWith("manifest-") ? "manifests" : "blobs"}/${ref}`;
    const method = command.endsWith("-head")
      ? "HEAD"
      : command.endsWith("-put")
        ? "PUT"
        : command.endsWith("-delete")
          ? "DELETE"
          : "GET";
    const reply = await api.request(
      method,
      target,
      upload,
      command.startsWith("manifest-")
        ? {
            accept: mediaTypes.join(", "),
            ...(manifestType ? { "content-type": manifestType } : {}),
          }
        : {},
    );
    const metadata = responseMetadata(reply);
    if (method === "PUT") {
      if (
        reply.status !== 201 ||
        typeof reply.headers["docker-content-digest"] !== "string"
      )
        throw new AppError(
          502,
          "REGISTRY_MANIFEST_STATUS",
          "Registry 未确认 manifest 上传完成和 digest",
        );
      verifyDigest(upload!, undefined, reply.headers["docker-content-digest"]);
    }
    if (method !== "GET") return jsonResult(metadata);
    const verifiedDigest = verifyDigest(
      reply.body,
      ref!.startsWith("sha256:") ? ref : undefined,
      reply.headers["docker-content-digest"],
    );
    const output = parsed.positional[2];
    if (command === "manifest-get")
      return {
        ...jsonResult({
          ...metadata,
          digest: verifiedDigest,
          manifest: parseJson(reply),
        }),
        ...(output ? { files: [returnedFile(output, reply.body)] } : {}),
      };
    return {
      ...jsonResult({
        ...metadata,
        digest: verifiedDigest,
        bytes: reply.body.length,
      }),
      files: [returnedFile(output || `${ref!.slice(7)}.blob`, reply.body)],
    };
  } finally {
    api.close();
  }
}

export const registryAdapter: Adapter = {
  validate(connection, secret) {
    const config = configSchema.parse(connection.config);
    registryUrl(config.endpoint, config.allowInsecureLocal, config.trustedPrivate);
    validateSecret(config, secret);
  },
  async run(context, operation) {
    const config = configSchema.parse(context.connection.config);
    const controller = new AbortController();
    const cancel = () =>
      controller.abort(
        context.signal.reason instanceof AppError
          ? context.signal.reason
          : new AppError(499, "REGISTRY_CANCELLED", "Registry 操作已取消"),
      );
    const timer = setTimeout(
      () =>
        controller.abort(
          new AppError(504, "REGISTRY_TIMEOUT", "Registry 操作超时"),
        ),
      operation.timeoutMs,
    );
    timer.unref();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    try {
      controller.signal.throwIfAborted();
      const result = await awaitWithSignal(
          run({ ...context, signal: controller.signal }, operation),
          controller.signal,
        ),
        secrets = values(config, context.secret);
      if (result.stdout !== undefined)
        result.stdout = redact(result.stdout, secrets);
      if (result.stderr !== undefined)
        result.stderr = redact(result.stderr, secrets);
      if (result.data !== undefined)
        result.data = redactData(result.data, secrets);
      if (result.files)
        result.files = result.files.map((f) => ({
          path: redact(f.path, secrets),
          base64: redactBytes(
            Buffer.from(f.base64, "base64"),
            secrets,
          ).toString("base64"),
        }));
      return result;
    } catch (error) {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : error;
      if (failure instanceof AppError) {
        const safe = new AppError(
          failure.status,
          redact(failure.code, Object.values(context.secret)),
          redact(failure.message, values(config, context.secret)),
        );
        Object.defineProperty(safe, "cause", {
          value: failure,
          configurable: true,
        });
        throw safe;
      }
      throw new AppError(
        502,
        "REGISTRY_TRANSPORT",
        "Registry 连接、TLS 或协议验证失败",
      );
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
    }
  },
};
