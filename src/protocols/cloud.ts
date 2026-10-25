import { setting } from "../environment.js";
/* eslint-disable no-control-regex -- reject control bytes in credential headers and object keys */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { Readable, Transform } from "node:stream";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  type Filter,
} from "@aws-sdk/client-ec2";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Connection,
  Credentials,
  Operation,
} from "../connections.js";
import { AppError } from "../schema.js";
import { pinnedAddress, redact, redactBytes, safeUrl } from "../security.js";
import { awaitWithSignal } from "../async-boundary.js";

const objectCommands = [
  "list-objects-v2",
  "get-object",
  "put-object",
  "delete-object",
  "head-object",
  "copy-object",
  "move-object",
] as const;
const bucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
const common = {
  region: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  prefix: z.string().max(1000).default(""),
  allowInsecureLocal: z.boolean().default(false),
  maxBytes: z.number().int().min(1).max(12_000_000).default(12_000_000),
};
const storageSchema = z
  .object({
    ...common,
    provider: z.enum(["s3", "r2", "oss"]).default("s3"),
    endpoint: z.string().max(1000),
    bucket: bucketSchema,
    allowedCommands: z
      .array(z.enum(objectCommands))
      .min(1)
      .default([...objectCommands]),
    // Explicit administrator trust for a self-hosted S3-compatible service on
    // an ordinary private network; loopback/link-local/metadata stay refused.
    trustedPrivate: z.boolean().default(false),
    // Public CA certificate (PEM) for such a service; never a credential.
    ca: z.string().min(1).max(100000).optional(),
  })
  .strict();
const awsSchema = z
  .object({
    ...common,
    allowedServices: z.array(z.enum(["sts", "ec2", "s3api"])).min(1),
    endpoints: z
      .object({
        sts: z.string().max(1000).optional(),
        ec2: z.string().max(1000).optional(),
        s3api: z.string().max(1000).optional(),
      })
      .strict()
      .default({}),
    bucket: bucketSchema.optional(),
    allowedCommands: z
      .array(z.enum(objectCommands))
      .min(1)
      .default([...objectCommands]),
  })
  .strict();
type StorageConfig = z.infer<typeof storageSchema>;
type AwsConfig = z.infer<typeof awsSchema>;

function bad(message: string): never {
  throw new AppError(400, "CLOUD_ARGUMENT", message);
}
function endpoint(raw: string, local: boolean, allowPrivate = false) {
  const u = safeUrl(raw, local, allowPrivate);
  if (u.search || u.pathname !== "/" || /[\\%]/.test(raw))
    bad("云服务 endpoint 只允许固定根地址，不能含查询、路径或编码");
  return u;
}
function validatePrefix(prefix: string) {
  if (prefix && !prefix.endsWith("/"))
    bad("桶 prefix 范围需以 / 结尾，防止同名前缀越界");
  key(prefix || "prefix-check");
}
function validateCredentials(secret?: Credentials) {
  if (!secret) return;
  if (
    Object.keys(secret).some(
      (k) => !["accessKeyId", "secretAccessKey", "sessionToken"].includes(k),
    )
  )
    bad("只允许 Access Key、Secret Access Key 和可选 Session Token");
  if (
    !secret.accessKeyId ||
    !secret.secretAccessKey ||
    Object.values(secret).some((x) => /[\r\n\u0000]/.test(x))
  )
    bad("请通过管理页面填写有效云服务凭据");
}
function credentials(secret: Credentials) {
  validateCredentials(secret);
  return {
    accessKeyId: secret.accessKeyId,
    secretAccessKey: secret.secretAccessKey,
    ...(secret.sessionToken ? { sessionToken: secret.sessionToken } : {}),
  };
}
function validateStorage(config: StorageConfig) {
  const u = endpoint(
    config.endpoint,
    config.allowInsecureLocal,
    config.trustedPrivate,
  );
  validatePrefix(config.prefix);
  if (config.provider !== "s3" && (config.trustedPrivate || config.ca))
    bad("内网与自定义 CA 只适用于自建 S3 兼容服务");
  if (
    config.provider === "r2" &&
    (!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(u.hostname) ||
      config.region !== "auto")
  )
    bad("R2 请使用固定 account ID 的官方 endpoint 与 auto region");
  if (
    config.provider === "oss" &&
    (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(u.hostname) ||
      u.protocol !== "https:")
  )
    bad("OSS 请使用官方 HTTPS 区域 endpoint；适配器强制 virtual-hosted 样式");
}
function defaultEndpoint(service: "sts" | "ec2" | "s3api", region: string) {
  const suffix = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return `https://${service === "s3api" ? "s3" : service}.${region}.${suffix}`;
}
function validateAws(config: AwsConfig) {
  validatePrefix(config.prefix);
  for (const raw of Object.values(config.endpoints))
    if (raw) endpoint(raw, config.allowInsecureLocal);
  for (const service of config.allowedServices)
    endpoint(
      config.endpoints[service] || defaultEndpoint(service, config.region),
      config.allowInsecureLocal,
    );
  if (config.allowedServices.includes("s3api") && !config.bucket)
    bad("AWS s3api 连接必须固定 bucket");
}
const sdkPolicy = {
  defaultsMode: "standard" as const,
  retryMode: "standard" as const,
  useFipsEndpoint: false,
  useDualstackEndpoint: false,
  authSchemePreference: ["aws.auth#sigv4"],
  sigv4aSigningRegionSet: [],
  userAgentAppId: "Abilock",
  disableClockSkewCorrection: true,
  credentialDefaultProvider: () => async () => {
    throw new AppError(
      400,
      "CLOUD_CREDENTIAL",
      "只能使用管理页面保存的凭据；禁止默认凭据查找",
    );
  },
};

// SDK transports never read cloud profiles, environment credentials, subprocesses, or proxies.
// A fresh pinned agent is used for each operation; SDK-produced hostname changes are refused.
async function transport(
  raw: string,
  context: AdapterContext,
  timeoutMs: number,
  virtualBucket?: string,
  trust: { allowPrivate?: boolean; ca?: string } = {},
) {
  context.signal.throwIfAborted();
  const u = endpoint(
    raw,
    context.allowLocal && context.connection.config.allowInsecureLocal === true,
    trust.allowPrivate === true,
  );
  const wire = new URL(u);
  if (virtualBucket) wire.hostname = `${virtualBucket}.${u.hostname}`;
  const pinned = await awaitWithSignal(
    pinnedAddress(
      wire,
      context.allowLocal &&
        context.connection.config.allowInsecureLocal === true,
      trust.allowPrivate === true,
    ),
    context.signal,
  );
  context.signal.throwIfAborted();
  const developmentLoopback =
    context.allowLocal &&
    context.connection.config.allowInsecureLocal === true &&
    setting("ALLOW_LOCAL") === "1" &&
    wire.hostname === "127.0.0.1";
  const normalizedAddress = (address: string) =>
    ipaddr.process(address.replace(/%.+$/, "")).toNormalizedString();
  const ownAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((rows) =>
      (rows || []).map((row) => normalizedAddress(row.address)),
    ),
  );
  if (
    !developmentLoopback &&
    ownAddresses.has(normalizedAddress(pinned.address))
  )
    throw new AppError(
      400,
      "CLOUD_BROKER_TARGET",
      "云服务不得指向 broker 本机地址",
    );
  const agentOptions = {
    keepAlive: false,
    lookup: ((_host, options, callback) =>
      dns.lookup(pinned.address, options, callback)) as NonNullable<
      http.AgentOptions["lookup"]
    >,
  };
  const handler = new NodeHttpHandler({
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent({
      ...agentOptions,
      rejectUnauthorized: true,
      ...(trust.ca ? { ca: trust.ca } : {}),
    }),
    connectionTimeout: Math.min(10_000, timeoutMs),
    socketTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    throwOnRequestTimeout: true,
  });
  const port = Number(wire.port || (wire.protocol === "https:" ? 443 : 80));
  return {
    handle: async (...args: Parameters<NodeHttpHandler["handle"]>) => {
      const [request] = args;
      if (
        request.hostname !== wire.hostname ||
        request.protocol !== wire.protocol ||
        Number(request.port || (request.protocol === "https:" ? 443 : 80)) !==
          port
      )
        throw new AppError(
          400,
          "CLOUD_TARGET",
          "SDK 请求不得改变管理配置中的目标",
        );
      const result = await handler.handle(...args);
      if (
        result.response.statusCode >= 300 &&
        result.response.statusCode < 400
      ) {
        if (result.response.body instanceof Readable)
          result.response.body.destroy();
        throw new AppError(
          502,
          "CLOUD_REDIRECT",
          "云服务重定向已阻止；请在管理页面核对区域与 endpoint",
        );
      }
      if (result.response.body instanceof Readable) {
        const source = result.response.body;
        const maxBytes =
          typeof context.connection.config.maxBytes === "number"
            ? context.connection.config.maxBytes
            : 12_000_000;
        let size = 0;
        const limited = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes)
              callback(
                new AppError(
                  413,
                  "CLOUD_LIMIT",
                  "云服务响应超过该连接的大小限制",
                ),
              );
            else callback(null, chunk);
          },
        });
        source.on("error", (error) => limited.destroy(error));
        limited.on("close", () => source.destroy());
        result.response.body = source.pipe(limited);
      }
      return result;
    },
    destroy: () => handler.destroy(),
  };
}

type Parsed = { positional: string[]; options: Record<string, string[]> };
function parse(
  args: string[],
  specs: Record<string, "one" | "many" | "flag">,
): Parsed {
  const positional: string[] = [],
    options: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!Object.hasOwn(specs, arg))
      bad(`不允许的云服务参数：${arg.split("=")[0]}`);
    if (Object.hasOwn(options, arg)) bad(`参数不可重复：${arg}`);
    const values: string[] = [];
    if (specs[arg] !== "flag") {
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        values.push(args[++i]);
        if (specs[arg] === "one") break;
      }
      if (!values.length) bad(`参数缺少值：${arg}`);
    }
    options[arg] = values;
  }
  return { positional, options };
}
function onlyOptions(parsed: Parsed, allowed: string[]) {
  if (Object.keys(parsed.options).some((x) => !allowed.includes(x)))
    bad("该命令不接受这些参数");
}
function key(raw: string) {
  if (
    !raw ||
    Buffer.byteLength(raw) > 1024 ||
    raw.startsWith("/") ||
    /[\u0000-\u001f\\]/.test(raw) ||
    raw.split("/").some((s) => s === "." || s === "..")
  )
    bad("对象 key 必须是非空、无路径穿越的相对名称");
  return raw;
}
function scopedKey(raw: string, config: StorageConfig, allowEmpty = false) {
  let value = raw;
  if (raw.startsWith("s3://")) {
    const parts = raw.slice(5).split("/");
    if (parts.shift() !== config.bucket) bad("目标桶与连接中固定 bucket 不同");
    value = parts.join("/");
  }
  if (!(allowEmpty && value === "")) key(value);
  if (!value.startsWith(config.prefix))
    bad("对象 key 超出管理配置的 prefix 范围");
  return value;
}
function numberOption(raw: string | undefined, min: number, max: number) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
    bad("数字参数超出允许范围");
  return Number(raw);
}
function jsonResult(data: unknown): AdapterResult {
  return { exitCode: 0, data, stdout: JSON.stringify(data, null, 2) + "\n" };
}
function upload(op: Operation, path: string | undefined, limit: number) {
  if (path && /^file(?:b)?:\/\//i.test(path))
    bad("文件须由 CLI 封装上传，broker 不读取本地路径");
  let value: Buffer;
  if (path) {
    const files = (op.files || []).filter((x) => x.path === path);
    if (files.length !== 1) bad("上传文件必须在请求 files 中恰好出现一次");
    const b64 = files[0].base64;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        b64,
      )
    )
      bad("文件 base64 无效");
    value = Buffer.from(b64, "base64");
  } else if (op.input !== undefined) value = Buffer.from(op.input);
  else bad("put-object 需要 --body 对应的 files 或 stdin input");
  if (value.length > limit) bad("上传文件超过该连接的大小限制");
  return value;
}
async function download(body: unknown, limit: number, signal: AbortSignal) {
  if (!(body instanceof Readable))
    throw new AppError(502, "CLOUD_BODY", "云服务未返回可读对象内容");
  const parts: Buffer[] = [];
  let size = 0;
  const abort = () => body.destroy(new Error("Operation cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    for await (const part of body) {
      const bytes = Buffer.isBuffer(part)
        ? part
        : Buffer.from(part as Uint8Array);
      size += bytes.length;
      if (size > limit) {
        body.destroy();
        throw new AppError(413, "CLOUD_LIMIT", "下载对象超过该连接的大小限制");
      }
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function cleanMetadata(result: object) {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([name]) => name !== "$metadata" && name !== "Body",
    ),
  );
}
const objectSpecs = {
  "--bucket": "one",
  "--key": "one",
  "--prefix": "one",
  "--delimiter": "one",
  "--max-keys": "one",
  "--continuation-token": "one",
  "--start-after": "one",
  "--body": "one",
  "--content-type": "one",
  "--metadata": "one",
  "--range": "one",
  "--version-id": "one",
  "--copy-source": "one",
} as const;

async function storageRun(
  context: AdapterContext,
  op: Operation,
  config: StorageConfig,
) {
  validateStorage(config);
  validateCredentials(context.secret);
  const aliases: Record<string, (typeof objectCommands)[number]> = {
    ls: "list-objects-v2",
    get: "get-object",
    put: "put-object",
    rm: "delete-object",
    head: "head-object",
    copy: "copy-object",
    mv: "move-object",
  };
  const [rawCommand, ...args] = op.args;
  if (
    rawCommand === "cp" ||
    (rawCommand === "mv" && args.length >= 2 && !args[0].startsWith("-"))
  ) {
    const [source, destination, ...options] = args;
    if (
      !source ||
      !destination ||
      source.startsWith("-") ||
      destination.startsWith("-")
    )
      bad("cp/mv 需要 source destination；对象地址使用 s3://固定桶/key");
    const fromObject = source.startsWith("s3://"),
      toObject = destination.startsWith("s3://");
    let translated: string[];
    if (fromObject && toObject)
      translated = [
        rawCommand === "mv" ? "move-object" : "copy-object",
        "--key",
        destination,
        "--copy-source",
        source,
        ...options,
      ];
    else if (rawCommand === "mv")
      bad("mv 当前只支持固定桶内移动；不会删除客户端文件");
    else if (toObject)
      translated = [
        "put-object",
        "--key",
        destination,
        "--body",
        source,
        ...options,
      ];
    else if (fromObject)
      translated = ["get-object", "--key", source, destination, ...options];
    else bad("cp 至少一端必须是 s3://固定桶/key，不能复制 broker 本机文件");
    return storageRun(context, { ...op, args: translated }, config);
  }
  const command = aliases[rawCommand] || rawCommand;
  if (
    !objectCommands.includes(command as (typeof objectCommands)[number]) ||
    !config.allowedCommands.includes(command as (typeof objectCommands)[number])
  )
    bad("该对象存储命令未实现或未被管理员允许");
  const parsed = parse(args, objectSpecs);
  const val = (name: string) => parsed.options[name]?.[0];
  if (val("--bucket") && val("--bucket") !== config.bucket)
    bad("不允许改变固定 bucket");
  let objectKey: string | undefined;
  if (command !== "list-objects-v2")
    objectKey = scopedKey(val("--key") || parsed.positional[0] || "", config);
  const reqHandler = await transport(
    config.endpoint,
    context,
    op.timeoutMs,
    config.provider === "oss" ? config.bucket : undefined,
    { allowPrivate: config.trustedPrivate, ca: config.ca },
  );
  const client = new S3Client({
    ...sdkPolicy,
    endpoint: config.endpoint,
    region: config.region,
    credentials: credentials(context.secret),
    forcePathStyle: config.provider !== "oss",
    followRegionRedirects: false,
    useArnRegion: false,
    disableS3ExpressSessionAuth: true,
    maxAttempts: 1,
    requestHandler: reqHandler,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    const Bucket = config.bucket;
    const sendOptions = { abortSignal: context.signal };
    if (command === "list-objects-v2") {
      onlyOptions(parsed, [
        "--bucket",
        "--prefix",
        "--delimiter",
        "--max-keys",
        "--continuation-token",
        "--start-after",
      ]);
      if (
        parsed.positional.length > 1 ||
        (val("--prefix") && parsed.positional.length)
      )
        bad("list 只接受一个 prefix");
      const Prefix = scopedKey(
        val("--prefix") ?? parsed.positional[0] ?? config.prefix,
        config,
        true,
      );
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket,
          Prefix,
          Delimiter: val("--delimiter"),
          MaxKeys: numberOption(val("--max-keys"), 1, 1000),
          ContinuationToken: val("--continuation-token"),
          StartAfter: val("--start-after")
            ? scopedKey(val("--start-after")!, config)
            : undefined,
        }),
        sendOptions,
      );
      return jsonResult(cleanMetadata(result));
    }
    const Key = objectKey!;
    const maxPositional = val("--key") ? 1 : 2;
    if (parsed.positional.length > maxPositional) bad("对象命令的位置参数过多");
    if (command === "get-object") {
      onlyOptions(parsed, ["--bucket", "--key", "--range", "--version-id"]);
      const Range = val("--range");
      if (Range && !/^bytes=\d*-\d*$/.test(Range))
        bad("range 需使用 bytes=start-end");
      const result = await client.send(
        new GetObjectCommand({
          Bucket,
          Key,
          Range,
          VersionId: val("--version-id"),
        }),
        sendOptions,
      );
      const body = await download(result.Body, config.maxBytes, context.signal);
      const output =
        parsed.positional[val("--key") ? 0 : 1] || Key.split("/").at(-1)!;
      if (
        !output ||
        output.startsWith("/") ||
        output.split(/[\\/]/).some((p) => p === ".." || p === ".")
      )
        bad("下载文件名称不可含绝对路径或穿越");
      return {
        ...jsonResult(cleanMetadata(result)),
        files: [{ path: output, base64: body.toString("base64") }],
      };
    }
    if (command === "put-object") {
      onlyOptions(parsed, [
        "--bucket",
        "--key",
        "--body",
        "--content-type",
        "--metadata",
      ]);
      const bodyPath = val("--body") || parsed.positional[val("--key") ? 0 : 1];
      let Metadata: Record<string, string> | undefined;
      if (val("--metadata")) {
        try {
          Metadata = z
            .record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string().max(2000))
            .parse(JSON.parse(val("--metadata")!));
        } catch {
          bad("metadata 需是字符串值的 JSON 对象");
        }
      }
      const ContentType = val("--content-type");
      if (ContentType && /[\r\n]/.test(ContentType)) bad("content-type 无效");
      const result = await client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: upload(op, bodyPath, config.maxBytes),
          ContentType,
          Metadata,
        }),
        sendOptions,
      );
      return jsonResult(cleanMetadata(result));
    }
    if (command === "head-object" || command === "delete-object") {
      onlyOptions(parsed, ["--bucket", "--key", "--version-id"]);
      if (parsed.positional.length > (val("--key") ? 0 : 1))
        bad("命令不接受额外位置参数");
      const input = { Bucket, Key, VersionId: val("--version-id") };
      const result =
        command === "head-object"
          ? await client.send(new HeadObjectCommand(input), sendOptions)
          : await client.send(new DeleteObjectCommand(input), sendOptions);
      return jsonResult(cleanMetadata(result));
    }
    onlyOptions(parsed, ["--bucket", "--key", "--copy-source"]);
    const source = val("--copy-source") || parsed.positional[1];
    if (!source)
      bad("copy/move 需要同桶 --copy-source（源对象 key 或 s3://bucket/key）");
    const sourceKey = scopedKey(source, config);
    if (sourceKey === Key) bad("源对象与目标对象相同");
    const result = await client.send(
      new CopyObjectCommand({
        Bucket,
        Key,
        CopySource: `${Bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
      sendOptions,
    );
    if (command === "move-object") {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket, Key: sourceKey }),
          sendOptions,
        );
      } catch (error) {
        throw new AppError(
          502,
          "CLOUD_MOVE_PARTIAL",
          `对象已复制但源对象删除失败；请核对后重试：${safeCloudError(error, context.secret)}`,
        );
      }
    }
    return jsonResult(cleanMetadata(result));
  } finally {
    client.destroy();
  }
}

function safeCloudError(error: unknown, secret: Credentials) {
  const name =
    error instanceof Error && /^[A-Za-z0-9_.-]{1,100}$/.test(error.name)
      ? error.name
      : "CloudError";
  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error.$metadata as { httpStatusCode?: number })?.httpStatusCode
      : undefined;
  // SDK error.message can echo signed requests, tokens or arbitrary remote output.
  return redact(
    `${name}${status ? ` (HTTP ${status})` : ""}`,
    Object.values(secret),
  );
}
function redactData(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((x) => redactData(x, secrets));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        redact(k, secrets),
        redactData(v, secrets),
      ]),
    );
  return value;
}
async function protectedRun(
  context: AdapterContext,
  operation: Operation,
  run: (context: AdapterContext) => Promise<AdapterResult>,
) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      context.signal.reason instanceof AppError
        ? context.signal.reason
        : new AppError(499, "CLOUD_CANCELLED", "云服务操作已取消"),
    );
  const timer = setTimeout(
    () =>
      controller.abort(new AppError(504, "CLOUD_TIMEOUT", "云服务操作超时")),
    operation.timeoutMs,
  );
  timer.unref();
  context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    const result = await awaitWithSignal(
      run({ ...context, signal: controller.signal }),
      controller.signal,
    );
    const secretValues = Object.values(context.secret);
    result.stdout =
      result.stdout === undefined
        ? undefined
        : redact(result.stdout, secretValues);
    result.stderr =
      result.stderr === undefined
        ? undefined
        : redact(result.stderr, secretValues);
    if (result.data !== undefined)
      result.data = redactData(result.data, secretValues);
    if (result.files)
      result.files = result.files.map((f) => ({
        path: redact(f.path, secretValues),
        base64: redactBytes(
          Buffer.from(f.base64, "base64"),
          secretValues,
        ).toString("base64"),
      }));
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof AppError) throw error;
    const diagnostic = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
    const upstreamStatus = diagnostic?.$metadata?.httpStatusCode;
    const upstreamCode = typeof diagnostic?.name === "string" && [
      "InvalidClientTokenId", "SignatureDoesNotMatch", "ExpiredToken", "ExpiredTokenException",
      "InvalidAccessKeyId", "UnrecognizedClientException", "AccessDenied", "AccessDeniedException",
      "Throttling", "ThrottlingException", "TooManyRequestsException", "RequestTimeout",
    ].includes(diagnostic.name) ? diagnostic.name : undefined;
    throw Object.assign(new AppError(
      502,
      "CLOUD_UPSTREAM",
      safeCloudError(error, context.secret),
    ), {
      ...(typeof upstreamStatus === "number" && Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? { upstreamStatus } : {}),
      ...(upstreamCode ? { upstreamCode } : {}),
    });
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", cancel);
  }
}

export const s3Adapter: Adapter = {
  validate(connection: Connection, secret?: Credentials) {
    const config = storageSchema.parse(connection.config);
    validateStorage(config);
    validateCredentials(secret);
  },
  run(context, op) {
    return protectedRun(context, op, (scopedContext) =>
      storageRun(
        scopedContext,
        op,
        storageSchema.parse(context.connection.config),
      ),
    );
  },
};

function filters(raw: string | undefined): Filter[] | undefined {
  if (!raw) return undefined;
  try {
    return z
      .array(
        z
          .object({
            Name: z.string().min(1).max(200),
            Values: z.array(z.string().max(2000)).min(1).max(100),
          })
          .strict(),
      )
      .max(50)
      .parse(JSON.parse(raw));
  } catch {
    bad(
      'filters 使用原生 [{"Name":"tag:Name","Values":["example"]}] JSON 格式',
    );
  }
}
async function awsRun(context: AdapterContext, op: Operation) {
  const config: AwsConfig = awsSchema.parse(context.connection.config);
  validateAws(config);
  validateCredentials(context.secret);
  const [service, command, ...args] = op.args;
  if (
    !config.allowedServices.includes(
      service as (typeof config.allowedServices)[number],
    )
  )
    bad("该 AWS 服务未被管理员允许");
  if (service === "s3api") {
    const storage = storageSchema.parse({
      region: config.region,
      bucket: config.bucket,
      endpoint:
        config.endpoints.s3api || defaultEndpoint("s3api", config.region),
      prefix: config.prefix,
      maxBytes: config.maxBytes,
      allowInsecureLocal: config.allowInsecureLocal,
      allowedCommands: config.allowedCommands,
    });
    return storageRun(context, { ...op, args: [command, ...args] }, storage);
  }
  if (service === "sts") {
    if (command !== "get-caller-identity" || args.length)
      bad("STS 当前只支持无额外参数的 get-caller-identity");
    const client = new STSClient({
      ...sdkPolicy,
      region: config.region,
      endpoint: config.endpoints.sts || defaultEndpoint("sts", config.region),
      credentials: credentials(context.secret),
      maxAttempts: 1,
      requestHandler: await transport(
        config.endpoints.sts || defaultEndpoint("sts", config.region),
        context,
        op.timeoutMs,
      ),
    });
    try {
      return jsonResult(
        cleanMetadata(
          await client.send(new GetCallerIdentityCommand({}), {
            abortSignal: context.signal,
          }),
        ),
      );
    } finally {
      client.destroy();
    }
  }
  if (
    service !== "ec2" ||
    ![
      "describe-instances",
      "start-instances",
      "stop-instances",
      "reboot-instances",
    ].includes(command)
  )
    bad("该 AWS 命令尚未实现；不会执行本地 aws 程序");
  const parsed = parse(args, {
    "--instance-ids": "many",
    "--filters": "one",
    "--max-results": "one",
    "--next-token": "one",
    "--dry-run": "flag",
  });
  if (parsed.positional.length) bad("EC2 命令不接受额外位置参数");
  const InstanceIds = parsed.options["--instance-ids"];
  if (
    InstanceIds &&
    (InstanceIds.length > 100 ||
      InstanceIds.some((id) => !/^i-[a-f0-9]{8,17}$/.test(id)))
  )
    bad("instance-ids 需使用有效 EC2 实例 ID");
  const DryRun = Object.hasOwn(parsed.options, "--dry-run") || undefined;
  if (command !== "describe-instances") {
    onlyOptions(parsed, ["--instance-ids", "--dry-run"]);
    if (!InstanceIds?.length) bad("实例操作必须明确指定 instance-ids");
  }
  const client = new EC2Client({
    ...sdkPolicy,
    region: config.region,
    endpoint: config.endpoints.ec2 || defaultEndpoint("ec2", config.region),
    credentials: credentials(context.secret),
    maxAttempts: 1,
    requestHandler: await transport(
      config.endpoints.ec2 || defaultEndpoint("ec2", config.region),
      context,
      op.timeoutMs,
    ),
  });
  try {
    const sendOptions = { abortSignal: context.signal };
    const input = { InstanceIds, DryRun };
    let result: object;
    if (command === "describe-instances")
      result = await client.send(
        new DescribeInstancesCommand({
          ...input,
          Filters: filters(parsed.options["--filters"]?.[0]),
          MaxResults: numberOption(
            parsed.options["--max-results"]?.[0],
            5,
            1000,
          ),
          NextToken: parsed.options["--next-token"]?.[0],
        }),
        sendOptions,
      );
    else if (command === "start-instances")
      result = await client.send(new StartInstancesCommand(input), sendOptions);
    else if (command === "stop-instances")
      result = await client.send(new StopInstancesCommand(input), sendOptions);
    else
      result = await client.send(
        new RebootInstancesCommand(input),
        sendOptions,
      );
    return jsonResult(cleanMetadata(result));
  } finally {
    client.destroy();
  }
}

export const awsAdapter: Adapter = {
  validate(connection, secret) {
    validateAws(awsSchema.parse(connection.config));
    validateCredentials(secret);
  },
  run(context, operation) {
    return protectedRun(context, operation, (scopedContext) =>
      awsRun(scopedContext, operation),
    );
  },
};
