import { inject } from "./adapters.js";
import { AppError, type Platform, type SavedPlatform, type Secret } from "./schema.js";
import { safeUrl } from "./security.js";
import { readBounded, upstream, upstreamFailure } from "./transport.js";

/** Management-only probes. No learned document, caller path or request body
 * can select a probe. Generation models come from a fixed verified allowlist.
 * Probes never grant new business execution rules. */
export type HTTPConnectionTestPlan = {
  supported: boolean;
  provider: string;
  method: "GET" | "POST" | null;
  path: string | null;
  level: "authentication" | "generation" | "none";
  billing: "none" | "possible";
  model: string | null;
  generation?: {
    models: { id: string; label: string; inputPriceCnyPerMillion: number; outputPriceCnyPerMillion: number }[];
    prompt: string;
    maxOutputTokens: 16;
    maxRequests: 1;
    thinking: "disabled";
    pricingUrl: string;
    documentationUrl: string;
    pricingCheckedAt: string;
    costNote: string;
  };
  message: string;
};
export type HTTPConnectionTestResult = HTTPConnectionTestPlan & {
  status: "verified" | "unsupported";
  success: boolean;
};
type Provider = "openai" | "openrouter" | "deepseek-balance" | "anthropic" | "gemini" | "siliconflow" | "dashscope" | "doubao";
type Probe = { provider: Provider; label: string; path: string; query?: Record<string, string>; headers?: Record<string, string> };
const labels: Record<Provider, string> = {
  openai: "OpenAI", openrouter: "OpenRouter", "deepseek-balance": "DeepSeek",
  anthropic: "Anthropic", gemini: "Google Gemini", siliconflow: "SiliconFlow", dashscope: "阿里云百炼", doubao: "豆包 · 火山方舟",
};
const doubaoGeneration: NonNullable<HTTPConnectionTestPlan["generation"]> = {
  models: [
    { id: "doubao-seed-2-0-mini-260428", label: "Doubao Seed 2.0 Mini", inputPriceCnyPerMillion: 0.2, outputPriceCnyPerMillion: 2 },
    { id: "doubao-seed-2-0-lite-260428", label: "Doubao Seed 2.0 Lite", inputPriceCnyPerMillion: 0.6, outputPriceCnyPerMillion: 3.6 },
  ],
  prompt: "Reply OK.", maxOutputTokens: 16, maxRequests: 1, thinking: "disabled",
  pricingUrl: "https://www.volcengine.com/docs/ark/model-pricing",
  documentationUrl: "https://www.volcengine.com/docs/ark/chat-api",
  pricingCheckedAt: "2026-10-25",
  costNote: "以上为文本输入不超过 32K token、常规在线推理的参考单价。仅发送一次固定短文本，最多输出 16 token（含思考），关闭深度思考；不自动重试。实际费用以服务商账单为准，这些限制不是金额硬上限；取消或超时也可能已经计费。",
};

function probeFor(platform: Platform): Probe | null {
  let base: URL;
  try { base = new URL(platform.baseUrl); } catch { return null; }
  // Exact HTTPS authorities only. Never treat a proxy/custom suffix as the
  // provider, rewrite a host, use an arbitrary port or escape a saved prefix.
  if (base.protocol !== "https:" || base.port || base.username || base.password ||
      base.search || base.hash || /[\\%]/.test(platform.baseUrl)) return null;
  const host = base.hostname;
  const prefix = base.pathname.replace(/\/$/, "");
  const bearer = platform.auth.type === "bearer";
  const header = platform.auth.type === "header" ? platform.auth.name?.toLowerCase() : "";
  const native = (provider: Provider, path: string, extra: Omit<Probe, "provider" | "label" | "path"> = {}): Probe =>
    ({ provider, label: labels[provider], path, ...extra });
  if (host === "api.openai.com" && bearer && ["", "/v1"].includes(prefix))
    return native("openai", "/v1/models");
  if (host === "openrouter.ai" && bearer && ["", "/api/v1"].includes(prefix))
    return native("openrouter", "/api/v1/key");
  if (host === "ark.cn-beijing.volces.com" && bearer && prefix === "/api/v3")
    return native("doubao", "/api/v3/chat/completions");
  if (host === "api.deepseek.com" && bearer) {
    if (prefix === "") return native("deepseek-balance", "/user/balance");
  }
  if (host === "api.anthropic.com" && (bearer || header === "x-api-key") && ["", "/v1"].includes(prefix))
    return native("anthropic", "/v1/models", {
      query: { limit: "1" }, headers: { "anthropic-version": "2026-10-21" },
    });
  if (host === "generativelanguage.googleapis.com" &&
      (header === "x-goog-api-key" || (platform.auth.type === "query" && platform.auth.name === "key")) &&
      ["", "/v1beta"].includes(prefix))
    return native("gemini", "/v1beta/models", { query: { pageSize: "1" } });
  if (host === "api.siliconflow.cn" && bearer && ["", "/v1"].includes(prefix))
    return native("siliconflow", "/v1/models");
  const dashscope = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "cn-hongkong.dashscope.aliyuncs.com"].includes(host) ||
    /^[a-z0-9][a-z0-9-]*\.(cn-beijing|ap-northeast-1|eu-central-1|us-east-1)\.maas\.aliyuncs\.com$/.test(host);
  if (dashscope && bearer && ["", "/api/v1"].includes(prefix))
    return native("dashscope", "/api/v1/models", { query: { page_no: "1", page_size: "1" } });
  return null;
}

export function planHTTPConnectionTest(platform: Platform): HTTPConnectionTestPlan {
  const probe = probeFor(platform);
  if (!probe) return {
    supported: false, provider: "自定义 API", method: null, path: null,
    level: "none", billing: "none", model: null,
    message: "此地址或鉴权方式暂无已核验的只读测试方案，未发送请求。需要实际模型调用时，先确认模型与费用上限。",
  };
  if (probe.provider === "doubao") return {
    supported: true, provider: probe.label, method: "POST", path: probe.path,
    level: "generation", billing: "possible", model: null,
    generation: structuredClone(doubaoGeneration),
    message: "未找到适用此 API Key 的通用只读鉴权接口。请明确选择已开通的模型，确认后发送一次最小生成请求；可能产生费用。",
  };
  return {
    supported: true, provider: probe.label, method: "GET", path: probe.path,
    level: "authentication", billing: "none", model: null,
    message: probe.provider === "deepseek-balance"
      ? "只读检查账户鉴权与余额状态；不调用模型，不产生生成费用。"
      : probe.provider === "openrouter"
      ? "只读检查当前密钥鉴权与额度状态；不发送提示词，不调用模型，不产生生成费用。通过不代表模型可调用或账户余额充足。"
      : "只读检查模型目录鉴权；不调用模型，不产生生成费用。通过不代表模型可调用或余额充足。",
  };
}

/** Call before unsealing a saved key, and again before any network operation. */
export function assertHTTPConnectionTestConsent(platform: Platform, options: { allowBillable?: boolean; model?: string } = {}): void {
  if (probeFor(platform)?.provider !== "doubao") {
    if (options.model !== undefined) fail("CONFIG", "此测试方案不接受模型参数", 400);
    return;
  }
  if (!doubaoGeneration.models.some((item) => item.id === options.model))
    fail("CONFIG", "请选择列表中已开通的测试模型；不会自动猜测或替换模型", 400);
  if (options.allowBillable !== true)
    fail("CONSENT", "请确认所选模型、一次短文本请求及可能费用后再测试", 400);
}

function fail(code: string, message: string, status = 502): never {
  throw new AppError(status, `CONNECTION_TEST_${code}`, message);
}
function cancelled(signal: AbortSignal) {
  if (!signal.aborted) return;
  const code = (signal.reason as { code?: unknown } | undefined)?.code;
  if (code === "CONNECTION_TEST_TIMEOUT" || code === "UPSTREAM_TIMEOUT")
    fail("TIMEOUT", "连接测试超时", 504);
  fail("CANCELLED", "连接测试已取消", 499);
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function items(value: unknown, field: string, type?: string) {
  return Array.isArray(value) && value.every((row) => {
    const item = record(row);
    return item && typeof item[field] === "string" && !!item[field] &&
      (!type || item.object === type || item.type === type);
  });
}
function bodyCode(body: Record<string, unknown> | null): string {
  const error = record(body?.error);
  // Codes are compared locally only. Error messages, identifiers, response
  // headers and arbitrary provider content never leave this function.
  const reasons = Array.isArray(error?.details) ? error.details.map((item) => record(item)?.reason) : [];
  return [error?.code, error?.type, error?.status, body?.code, ...reasons].filter((value) =>
    typeof value === "string" || typeof value === "number").join(" ").toLowerCase();
}
function checkFailure(status: number, body: Record<string, unknown> | null, generation = false) {
  const code = bodyCode(body);
  // Ark's documented codes omit the underscores used by other providers.
  // Classify only fixed codes, never echo free-form upstream error messages.
  if (generation) {
    if (code.includes("accountoverdueerror"))
      fail("BALANCE", "服务商报告账户欠费或计费项未开通；请核对账户状态", 402);
    if (code.includes("quotaexceeded"))
      fail("BALANCE", "服务商报告可用额度已耗尽或达到额度限制；请核对模型额度", 402);
    if (code.includes("modelnotopen") || code.includes("invalidendpointormodel.notfound") ||
        code.includes("invalidendpointormodel.modelidaccessdisabled"))
      fail("MODEL_PERMISSION", "所选模型未开通、不存在或当前凭据无访问权限；请在方舟控制台核对模型权限", 403);
  }
  if (status === 401 || /invalid_api_key|authentication_error|authenticationerror|unauthenticated|api_key_invalid|invalidapikey/.test(code))
    fail("AUTH", "鉴权失败，请检查密钥、鉴权方式与服务地域", 401);
  if (status === 402 || /insufficient_quota|insufficient_balance|credit_balance|arrearage|quota_exceeded/.test(code))
    fail("BALANCE", generation ? "服务商报告余额或可用额度不足；请核对账户状态" : "余额或可用额度不足；本次未调用模型", 402);
  if (status === 429 || /rate_limit|resource_exhausted|throttl/.test(code))
    fail("RATE_LIMIT", "服务商限流，请稍后手动重试", 429);
  if (status === 403 || /permission_denied|permission_error|accessdenied|forbidden/.test(code))
    fail("PERMISSION", "当前凭据无权访问此测试接口，不能据此判断所有业务权限", 403);
  if (status < 200 || status >= 300)
    fail("PROTOCOL", generation ? "服务商未接受模型测试请求，请核对接口或稍后手动重试" : "服务商未接受只读测试请求，请核对接口或稍后重试");
  if (body?.error !== undefined || body?.success === false ||
      (body?.code !== undefined && body.code !== null && body.code !== 0 && body.code !== "0"))
    fail("PROTOCOL", "服务商返回了错误内容，未确认鉴权成功");
}
function validateResponse(probe: Probe, value: Record<string, unknown> | null, model?: string) {
  if (!value) fail("PROTOCOL", "服务商返回格式与只读测试接口不符，未确认鉴权成功");
  let valid = false;
  switch (probe.provider) {
    case "doubao": {
      const usage = record(value.usage);
      const choice = Array.isArray(value.choices) && value.choices.length === 1 ? record(value.choices[0]) : null;
      const message = record(choice?.message);
      const promptTokens = usage?.prompt_tokens;
      const completionTokens = usage?.completion_tokens;
      const totalTokens = usage?.total_tokens;
      valid = value.object === "chat.completion" && value.model === model && !!message && message.role === "assistant" &&
        typeof message.content === "string" && !!message.content.trim() &&
        (choice?.finish_reason === "stop" || choice?.finish_reason === "length") &&
        finiteNumber(promptTokens) && Number.isSafeInteger(promptTokens) && promptTokens >= 0 &&
        finiteNumber(completionTokens) && Number.isSafeInteger(completionTokens) && completionTokens >= 1 && completionTokens <= 16 &&
        finiteNumber(totalTokens) && Number.isSafeInteger(totalTokens) && totalTokens === promptTokens + completionTokens;
      if (!valid) fail("PROTOCOL", "模型响应、模型标识或用量与测试协议不符，未确认调用成功；请求可能已计费");
      break;
    }
    case "openai": case "siliconflow":
      valid = value.object === "list" && items(value.data, "id", "model"); break;
    case "openrouter": {
      const key = record(value.data);
      valid = !!key && typeof key.label === "string" && !!key.label &&
        typeof key.is_free_tier === "boolean" && finiteNumber(key.usage) && key.usage >= 0 &&
        (key.limit === null || (finiteNumber(key.limit) && key.limit >= 0)) &&
        (key.limit_remaining === null || finiteNumber(key.limit_remaining));
      if (valid && key && finiteNumber(key.limit_remaining) && key.limit_remaining <= 0)
        fail("BALANCE", "密钥鉴权已通过，但当前密钥额度已用尽；本次未调用模型", 402);
      break;
    }
    case "anthropic":
      valid = typeof value.has_more === "boolean" && items(value.data, "id", "model"); break;
    case "gemini":
      valid = items(value.models, "name"); break;
    case "dashscope": {
      const output = record(value.output);
      valid = value.success === true && !!output && typeof output.total === "number" && items(output.models, "model");
      break;
    }
    case "deepseek-balance":
      valid = typeof value.is_available === "boolean" && Array.isArray(value.balance_infos) &&
        value.balance_infos.every((row) => {
          const item = record(row);
          return item && ["CNY", "USD"].includes(String(item.currency)) &&
            ["total_balance", "granted_balance", "topped_up_balance"].every((key) => typeof item[key] === "string");
        });
      if (valid && value.is_available === false)
        fail("BALANCE", "账户鉴权已通过，但服务商报告余额不足；本次未调用模型", 402);
      break;
  }
  if (!valid) fail("PROTOCOL", "服务商返回格式与只读测试接口不符，未确认鉴权成功");
}

export async function testHTTPConnection({ platform, secret, signal, allowLocal = false, allowBillable, model }: {
  platform: SavedPlatform; secret: Secret; signal: AbortSignal; allowLocal?: boolean; allowBillable?: boolean; model?: string;
}): Promise<HTTPConnectionTestResult> {
  cancelled(signal);
  if (!platform.enabled) fail("CONFIG", "连接已停用", 403);
  const plan = planHTTPConnectionTest(platform);
  const probe = probeFor(platform);
  if (!probe) return { ...plan, status: "unsupported", success: false };
  assertHTTPConnectionTestConsent(platform, { allowBillable, model });
  if (!secret.value) fail("CONFIG", "请先在管理页面保存凭据", 400);
  if ([...secret.value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    fail("CONFIG", "凭据格式无效，请在管理页面重新保存", 400);
  try {
    const generation = probe.provider === "doubao";
    const method = generation ? "POST" : "GET";
    const body = generation ? Buffer.from(JSON.stringify({
      model, messages: [{ role: "user", content: doubaoGeneration.prompt }],
      max_completion_tokens: 16, thinking: { type: "disabled" }, stream: false, service_tier: "default",
    })) : undefined;
    const url = safeUrl(platform.baseUrl, platform.allowInsecureLocal);
    url.pathname = probe.path;
    for (const [key, value] of Object.entries(probe.query ?? {})) url.searchParams.set(key, value);
    const fixedTarget = url.origin + url.pathname;
    const headers: Record<string, string> = {
      accept: "application/json", "accept-encoding": "identity", "content-type": "application/json", ...probe.headers,
    };
    await inject({ platform, secret, url, method, headers, body });
    if (url.origin + url.pathname !== fixedTarget) fail("TARGET", "测试目标发生变化，已停止请求", 400);
    cancelled(signal);
    const response = await upstream(url, method, headers, body, 30000, signal,
      allowLocal && platform.allowInsecureLocal);
    try {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) fail("TARGET", "服务商返回重定向，已阻止转发凭据");
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
        fail("PROTOCOL", "服务商返回不支持的压缩响应，未确认鉴权成功");
      let data: Record<string, unknown> | null = null;
      const raw = await readBounded(response, 1024 * 1024);
      cancelled(signal);
      try { data = record(JSON.parse(raw.toString("utf8"))); } catch { /* Status classification still applies. */ }
      checkFailure(status, data, generation);
      if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(String(response.headers["content-type"] ?? "")))
        fail("PROTOCOL", "服务商未返回预期的 JSON 响应，未确认鉴权成功");
      validateResponse(probe, data, model);
      return {
        ...plan, model: generation ? model! : null, status: "verified", success: true,
        message: generation
          ? "所选模型已完成一次最小生成，鉴权与该模型调用已通过；本次可能已产生费用，不代表其他模型或后续额度均可用。"
          : probe.provider === "deepseek-balance"
          ? "账户鉴权已通过，当前余额可用；未调用模型，未验证生成能力。"
          : "只读接口鉴权已通过；未验证模型调用、余额或其他接口权限。",
      };
    } catch (error) {
      throw upstreamFailure(response, error);
    } finally { response.destroy(); }
  } catch (error) {
    cancelled(signal);
    if (error instanceof AppError && error.code.startsWith("CONNECTION_TEST_")) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "UPSTREAM_TIMEOUT" || code === "ETIMEDOUT") fail("TIMEOUT", "连接测试超时", 504);
    if (code === "CANCELLED" || code === "ABORT_ERR") fail("CANCELLED", "连接测试已取消", 499);
    if (["PRIVATE_TARGET", "BROKER_TARGET_REJECTED", "UNSAFE_URL"].includes(String(code)))
      fail("TARGET", "测试目标不符合固定地址与网络边界要求", 403);
    if (code === "TOO_LARGE") fail("PROTOCOL", "服务商响应超过测试大小限制，未确认鉴权成功");
    if (code === "ERR_INVALID_CHAR" || code === "ERR_INVALID_HTTP_TOKEN")
      fail("CONFIG", "凭据格式无效，请在管理页面重新保存", 400);
    fail("NETWORK", "无法完成安全连接，请检查网络、DNS 和 TLS 配置");
  }
}
