import type { AdapterContext, AdapterResult, Connection, Operation } from "./connections.js";
import { AppError } from "./schema.js";
import { protocolAdapters } from "./protocols/index.js";
import { assertTargetBoundary } from "./protocol-boundary.js";
import { sshConnectionTestHostKey, testSSHConnection } from "./protocols/ssh.js";
import { awaitWithSignal } from "./async-boundary.js";
import { kubernetesConnectionTestTarget, testKubernetesConnection } from "./protocols/containers.js";
import { testGitConnection } from "./protocols/git.js";

export type ConnectionTestPlan = {
  supported: boolean;
  provider: string;
  method: string | null;
  path: string | null;
  level: "authentication" | "service" | "none";
  billing: "none" | "possible";
  model: null;
  message: string;
};
export type ConnectionTestResult = ConnectionTestPlan & {
  status: "verified" | "reachable" | "unsupported";
  success: boolean;
};
const providerNames: Record<Connection["kind"], string> = {
  ssh: "SSH", postgres: "PostgreSQL", mysql: "MySQL", redis: "Redis",
  git: "Git", s3: "S3 / OSS / R2", aws: "AWS STS", registry: "OCI Registry",
  docker: "Docker Engine", kubernetes: "Kubernetes",
};
function hasAllowed(config: Record<string, unknown>, field: string, value: string, defaultAllowed = false) {
  return config[field] === undefined ? defaultAllowed : Array.isArray(config[field]) && config[field].includes(value);
}
function officialSTS(connection: Connection) {
  const endpoint = record(connection.config.endpoints).sts;
  if (endpoint === undefined) return true;
  if (typeof endpoint !== "string") return false;
  const region = connection.config.region;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
      (url.hostname === "sts.amazonaws.com" || url.hostname === `sts.${String(region)}.${String(region).startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`);
  } catch { return false; }
}

/** Plans are code-owned and never expand saved targets, resources or commands. */
export function planProtocolConnectionTest(connection: Connection): ConnectionTestPlan {
  const plan: ConnectionTestPlan = {
    supported: true, provider: providerNames[connection.kind], method: null, path: null,
    level: "service", billing: "none", model: null, message: "",
  };
  switch (connection.kind) {
    case "ssh":
      plan.method = "SSH handshake";
      plan.level = "authentication";
      plan.message = "核对已保存的主机指纹并验证登录；不运行命令或文件操作。";
      try { sshConnectionTestHostKey(connection.config); }
      catch { plan.supported = false; plan.message = "尚未保存可信主机指纹，无法安全测试；不会自动接受服务器密钥。"; }
      break;
    case "postgres":
    case "mysql":
      plan.method = "SELECT 1 AS abilock_probe";
      plan.message = "建立数据库会话并查询常量，不读取业务表；服务端免密配置时不能证明密码有效。";
      break;
    case "redis":
      plan.method = "PING";
      plan.message = "使用已保存身份建立会话并执行 PING，不读取或修改业务键。";
      break;
    case "aws":
      plan.method = "STS GetCallerIdentity";
      plan.level = officialSTS(connection) ? "authentication" : "service";
      plan.message = "只读查询当前 AWS 身份；不验证 EC2、S3 权限或账户余额。";
      if (plan.level === "service") plan.message = "读取自定义 STS 兼容端点的身份格式响应；该响应不能证明 AWS 凭据有效。";
      if (!hasAllowed(connection.config, "allowedServices", "sts")) {
        plan.supported = false;
        plan.message = "已保存范围未允许 STS，无法执行身份测试；不会扩大服务权限。";
      }
      break;
    case "docker":
      plan.method = "GET";
      plan.path = `/${typeof connection.config.apiVersion === "string" ? connection.config.apiVersion : "v1.47"}/version`;
      plan.message = "读取 Docker 版本确认协议响应；公开版本接口不能证明凭据有效或操作权限。";
      break;
    case "registry":
      plan.method = "GET";
      plan.path = "/v2/";
      plan.message = "检查 Registry V2 协议响应；该入口可能公开，不据此判断密钥或仓库权限有效。";
      if (!hasAllowed(connection.config, "allowedCommands", "ping", true)) {
        plan.supported = false;
        plan.message = "已保存范围未允许 Registry ping，无法执行连接测试。";
      }
      break;
    case "kubernetes": {
      const target = kubernetesConnectionTestTarget(connection);
      plan.method = "GET";
      plan.path = target ? `${target.path}?limit=1` : null;
      plan.message = "在已配置命名空间读取一页已允许资源的元信息（最多 1 项）；不读取 Secret、不跟随分页，不证明其他权限。";
      if (!target) {
        plan.supported = false;
        plan.message = "当前资源范围没有适用的非秘密只读测试资源；不会扩大范围或读取 Secret。";
      }
      break;
    }
    case "s3":
      plan.supported = hasAllowed(connection.config, "allowedCommands", "list-objects-v2", true);
      plan.billing = "possible";
      plan.method = "ListObjectsV2 · MaxKeys=1";
      plan.message = plan.supported
        ? "在已保存桶和前缀内最多列出 1 项元信息，不下载文件、不继续分页；可能产生 1 次 LIST 请求费用，需确认后执行。"
        : "已保存范围未允许列举对象，无法测试；不会扩大桶或前缀范围。";
      break;
    case "git":
      plan.method = connection.config.transport === "ssh" ? "SSH handshake" : "GET Git smart refs";
      plan.level = connection.config.transport === "ssh" ? "authentication" : "service";
      plan.message = connection.config.transport === "ssh"
        ? "核对已保存主机指纹并验证 SSH 登录；不打开通道，不验证仓库权限。"
        : "读取固定仓库的 Git 引用通告，不创建工作区；公开仓库不能据此证明凭据有效。";
      break;
  }
  if (!plan.supported) plan.level = "none";
  return plan;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function failure(code: string, status = 502): AppError {
  const messages: Record<string, string> = {
    CONNECTION_TEST_AUTH: "鉴权未通过，请检查已保存的身份和凭据。",
    CONNECTION_TEST_PERMISSION: "服务拒绝了测试权限；不能据此判断凭据无效。",
    CONNECTION_TEST_RATE_LIMIT: "服务限流，请稍后手动重试。",
    CONNECTION_TEST_BALANCE: "服务报告余额或配额不足。",
    CONNECTION_TEST_TIMEOUT: "连接测试超时，未自动重试。",
    CONNECTION_TEST_CANCELLED: "连接测试已取消。",
    CONNECTION_TEST_CONNECT: "无法建立连接，请检查地址、网络和端口。",
    CONNECTION_TEST_TLS: "服务器证书或 TLS 校验未通过。",
    CONNECTION_TEST_PROTOCOL: "服务响应与预期协议不符，未确认连接或凭据有效。",
    CONNECTION_TEST_FAILED: "连接测试失败，未确认凭据有效。",
  };
  return new AppError(status, code, messages[code] ?? messages.CONNECTION_TEST_FAILED);
}

/** Never expose remote message, stderr, response body or account identity. */
export function connectionTestFailure(error: unknown): AppError {
  const item = record(error);
  const code = typeof item.code === "string" ? item.code : "";
  const name = typeof item.name === "string" ? item.name : "";
  if (error instanceof AppError && /^SSH_TEST_/.test(code)) return error;
  if (/^CONNECTION_TEST_(AUTH|PERMISSION|RATE_LIMIT|BALANCE|TIMEOUT|CANCELLED|CONNECT|TLS|PROTOCOL|FAILED)$/.test(code))
    return failure(code, typeof item.status === "number" ? item.status : 502);
  const detail = record(item.data);
  const category = detail.category;
  const status = Number(detail.status ?? item.upstreamStatus ?? item.status ?? record(item.$metadata).httpStatusCode);
  const known = `${code} ${name} ${typeof detail.code === "string" ? detail.code : ""} ${typeof item.upstreamCode === "string" ? item.upstreamCode : ""}`;
  if (category === "auth" || status === 401 || /InvalidClientTokenId|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|UnrecognizedClientException|REGISTRY_UNAUTHORIZED/.test(known))
    return failure("CONNECTION_TEST_AUTH", 401);
  if (category === "permission" || status === 403 || /AccessDenied|REGISTRY_DENIED/.test(known))
    return failure("CONNECTION_TEST_PERMISSION", 403);
  if (status === 429 || /Throttl|TooManyRequests/.test(known)) return failure("CONNECTION_TEST_RATE_LIMIT", 429);
  if (/TIMEOUT|Timeout|ETIMEDOUT/.test(known)) return failure("CONNECTION_TEST_TIMEOUT", 504);
  if (/CANCELLED|AbortError/.test(known)) return failure("CONNECTION_TEST_CANCELLED", 499);
  if (category === "tls" || /CERT|TLS|SSL/.test(known)) return failure("CONNECTION_TEST_TLS");
  if (category === "connection" || /ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET/.test(known)) return failure("CONNECTION_TEST_CONNECT");
  return failure("CONNECTION_TEST_FAILED");
}

function checkedResponse(kind: Connection["kind"], response: AdapterResult, connection: Connection): boolean {
  if (response.exitCode !== 0) throw connectionTestFailure({ data: response.data, status: response.httpStatus });
  const data = record(response.data);
  if (kind === "postgres" || kind === "mysql") {
    const table = kind === "postgres" && Array.isArray(response.data) ? record(response.data[0]) : data;
    return Array.isArray(table.rows) && table.rows.length === 1 && record(table.rows[0]).abilock_probe === 1;
  }
  if (kind === "redis") return data.command === "PING" && data.result === "PONG";
  if (kind === "aws") return typeof data.Arn === "string" && /^arn:aws(?:-cn|-us-gov)?:/.test(data.Arn) && typeof data.Account === "string" && /^\d{12}$/.test(data.Account) && typeof data.UserId === "string" && data.UserId.length > 0;
  if (kind === "docker") return typeof data.Version === "string" && data.Version.length > 0 && typeof data.ApiVersion === "string" && /^1\.\d+$/.test(data.ApiVersion);
  if (kind === "registry") return data.status === 200 && data.apiVersion === "registry/2.0";
  if (kind === "kubernetes") {
    const target = kubernetesConnectionTestTarget(connection);
    return !!target && data.kind === target.kind && data.apiVersion === target.apiVersion && Array.isArray(data.items) && data.items.length <= 1;
  }
  if (kind === "s3") return typeof data.KeyCount === "number" && data.KeyCount >= 0 && data.KeyCount <= 1 && (data.Contents === undefined || (Array.isArray(data.Contents) && data.Contents.length <= 1));
  return false;
}

export async function testProtocolConnection(context: AdapterContext, options: { allowBillable?: boolean } = {}): Promise<ConnectionTestResult> {
  const { connection, signal } = context;
  const plan = planProtocolConnectionTest(connection);
  if (!plan.supported) return { ...plan, status: "unsupported", success: false };
  if (plan.billing === "possible" && options.allowBillable !== true)
    return { ...plan, status: "unsupported", success: false, message: "测试可能产生请求费用，需要确认后才会发送。" };
  try {
    signal.throwIfAborted();
    protocolAdapters[connection.kind].validate(connection, context.secret);
    await assertTargetBoundary(connection, context.allowLocal, signal);
    if (connection.kind === "ssh") {
      await testSSHConnection(context);
      return { ...plan, status: "verified", success: true, message: "主机指纹与登录鉴权已通过；未运行命令或文件操作。" };
    }
    if (connection.kind === "git") {
      const result = await testGitConnection(context);
      return { ...plan, ...result, success: true };
    }
    const args: Partial<Record<Connection["kind"], string[]>> = {
      postgres: ["-c", "SELECT 1 AS abilock_probe"], mysql: ["-e", "SELECT 1 AS abilock_probe"],
      redis: ["PING"], aws: ["sts", "get-caller-identity"], docker: ["version"], registry: ["ping"],
      s3: ["list-objects-v2", "--max-keys", "1"],
    };
    const operation: Operation = { args: args[connection.kind]!, timeoutMs: 30000 };
    const response = await awaitWithSignal(connection.kind === "kubernetes" ? testKubernetesConnection(context) : protocolAdapters[connection.kind].run(context, operation), signal);
    signal.throwIfAborted();
    if (!checkedResponse(connection.kind, response, connection)) throw failure("CONNECTION_TEST_PROTOCOL");
    return {
      ...plan, status: plan.level === "authentication" ? "verified" : "reachable", success: true,
      message: connection.kind === "aws" && plan.level === "authentication" ? "AWS 身份验证通过；未测试其他服务权限或余额。" : `只读检查通过。${plan.message}`,
    };
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason instanceof AppError && signal.reason.code === "CONNECTION_TEST_TIMEOUT") throw signal.reason;
      throw failure("CONNECTION_TEST_CANCELLED", 499);
    }
    throw connectionTestFailure(error);
  }
}
