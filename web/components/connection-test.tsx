import { useEffect, useState } from "react";
import { needsCredential, type Connection } from "./connection-form.js";
import type { Platform } from "./platform-form.js";

export type TestableConnection = Connection | Platform;
export type ConnectionTestPlan = {
  alias: string;
  revision: number;
  kind: string;
  supported: boolean;
  provider: string;
  method: string | null;
  path?: string | null;
  level: "authentication" | "generation" | "service" | "none";
  billing: "none" | "possible";
  model?: string | null;
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
export type ConnectionTestResult = {
  alias: string;
  revision: number;
  status: "verified" | "reachable" | "unsupported" | "failed" | "cancelled" | "pending" | "confirmation";
  message: string;
  plan?: ConnectionTestPlan;
  durationMs?: number;
};
export type ConnectionTestControls = {
  disabled: boolean;
  pending: boolean;
  result: ConnectionTestResult | null;
  onTest: () => void;
  onCancel: () => void;
  onConfirm: (model?: string) => void;
};

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) &&
    sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

// Only the saved alias and revision go over the wire. Draft values never select
// an upstream or supply credentials for a connection test.
export function connectionTestUnavailable(
  saved: TestableConnection | null | undefined,
  draft = saved,
  secrets: Record<string, string> = {},
  identity = "keep",
  ...latestSnapshot: [] | [TestableConnection | null | undefined]
): string {
  if (!saved || !Number.isInteger(saved.revision) || saved.revision! < 1) return "保存后测试";
  const identityChanged = "kind" in saved &&
    (saved.kind === "ssh" || (saved.kind === "git" && saved.config.transport === "ssh")) && identity !== "keep";
  if (!draft || !sameValue(saved, draft) || identityChanged || Object.values(secrets).some(Boolean)) return "保存后测试";
  const latest = latestSnapshot.length ? latestSnapshot[0] : saved;
  if (!latest || !sameValue(saved, latest)) return "请重新打开连接";
  if (!saved.enabled) return "连接已停用";
  const required = "auth" in saved ? saved.auth.type !== "none" : needsCredential(saved);
  if (required && !saved.hasSecret) return "请先保存凭据";
  return "";
}

export function connectionTestError(failure: unknown): string {
  const code = (failure as { code?: unknown } | null)?.code;
  switch (code) {
    case "CONNECTION_TEST_AUTH": case "SSH_TEST_AUTH": return "鉴权失败，请检查账号和凭据";
    case "CONNECTION_TEST_PERMISSION": return "服务拒绝了测试权限，不能据此判断凭据无效";
    case "CONNECTION_TEST_MODEL_PERMISSION": return "所选模型未开通、无访问权限或需使用专属接入点；不能据此判断密钥无效";
    case "CONNECTION_TEST_CONSENT": return "请先选择测试模型并确认本次可能产生的费用";
    case "CONNECTION_TEST_BALANCE": return "账户余额或额度不足";
    case "CONNECTION_TEST_RATE_LIMIT": case "RATE_LIMIT": return "请求受到限流，请稍后再试";
    case "CONNECTION_TEST_TIMEOUT": case "SSH_TEST_TIMEOUT": return "连接测试超时，未自动重试";
    case "CONNECTION_TEST_CANCELLED": case "SSH_TEST_CANCELLED": return "连接测试已取消，未自动重试";
    case "CONNECTION_TEST_PROTOCOL": case "INVALID_RESPONSE": return "服务响应不符合验证协议，尚未确认凭据有效";
    case "CONNECTION_TEST_NETWORK": case "CONNECTION_TEST_CONNECT": case "SSH_TEST_CONNECT": return "无法连接服务，请检查地址和网络";
    case "CONNECTION_TEST_TLS": return "TLS 证书验证失败，请检查服务器证书和连接配置";
    case "CONNECTION_TEST_DNS": case "SSH_TEST_DNS": return "无法解析服务器地址";
    case "CONNECTION_TEST_TARGET": case "SSH_TARGET": return "目标地址不符合当前连接范围";
    case "CONNECTION_TEST_CONFIG": return "连接配置不完整或不适用于此测试";
    case "SSH_TEST_HOST_KEY_REQUIRED": return "请先保存从可信渠道取得的 SSH 主机指纹";
    case "SSH_TEST_HOST_KEY_MISMATCH": return "SSH 主机指纹不匹配，已停止连接";
    case "CONNECTION_TEST_BUSY": case "BUSY": return "该连接已有测试进行中，请稍后再试";
    case "CONNECTION_DISABLED": case "PLATFORM_DISABLED": return "连接已停用";
    case "SECRET_REQUIRED": return "请先保存凭据";
    case "REVISION_CONFLICT": return "连接已变化，请刷新后重试";
    case "CONNECTION_NOT_FOUND": case "PLATFORM_NOT_FOUND": return "连接已删除，请刷新列表";
    default: return "连接测试失败，尚未确认凭据有效";
  }
}

export function readConnectionTestPlan(value: unknown, saved: TestableConnection): ConnectionTestPlan {
  const plan = value as ConnectionTestPlan | null;
  if (!plan || plan.alias !== saved.alias || plan.revision !== saved.revision ||
    plan.kind !== ("baseUrl" in saved ? "api" : saved.kind) ||
    typeof plan.supported !== "boolean" || typeof plan.provider !== "string" ||
    !(plan.method === null || typeof plan.method === "string") ||
    !(plan.path === undefined || plan.path === null || typeof plan.path === "string") ||
    !["authentication", "generation", "service", "none"].includes(plan.level) ||
    !["none", "possible"].includes(plan.billing) || typeof plan.message !== "string")
    throw Object.assign(new Error("Invalid test plan"), { code: "INVALID_RESPONSE" });
  if (plan.level === "generation") {
    const spec = plan.generation;
    if (plan.kind !== "api" || plan.billing !== "possible" || plan.method !== "POST" || !spec ||
      spec.maxRequests !== 1 || spec.maxOutputTokens !== 16 || spec.thinking !== "disabled" ||
      typeof spec.prompt !== "string" || spec.prompt.length > 100 || !spec.prompt ||
      typeof spec.costNote !== "string" || typeof spec.pricingCheckedAt !== "string" ||
      ![spec.pricingUrl, spec.documentationUrl].every((url) => typeof url === "string" && url.startsWith("https://www.volcengine.com/docs/")) ||
      !Array.isArray(spec.models) || !spec.models.length || spec.models.length > 10 ||
      !spec.models.every((item) => item && typeof item.id === "string" && /^[a-z0-9-]{1,100}$/.test(item.id) &&
        typeof item.label === "string" && item.label.length > 0 &&
        [item.inputPriceCnyPerMillion, item.outputPriceCnyPerMillion].every((price) => typeof price === "number" && Number.isFinite(price) && price >= 0)))
      throw Object.assign(new Error("Invalid model test plan"), { code: "INVALID_RESPONSE" });
  } else if (plan.generation !== undefined) throw Object.assign(new Error("Invalid model test plan"), { code: "INVALID_RESPONSE" });
  return plan;
}

const labels: Record<ConnectionTestResult["status"], string> = {
  verified: "鉴权通过", reachable: "服务已响应", unsupported: "尚未验证",
  failed: "验证未通过", cancelled: "已取消", pending: "正在验证",
  confirmation: "等待确认",
};
export function ConnectionTestFeedback({ connection, unavailable = "", result, onConfirm }: {
  connection: TestableConnection;
  unavailable?: string;
  result?: ConnectionTestResult | null;
  onConfirm?: (model?: string) => void;
}) {
  const [model, setModel] = useState("");
  useEffect(() => { setModel(""); }, [result]);
  if (unavailable || result?.alias !== connection.alias || result.revision !== connection.revision) return null;
  const plan = result.plan;
  const generation = plan?.generation;
  const selected = generation?.models.find((item) => item.id === model);
  return <div className={`test-result test-result-${result.status}`} role={result.status === "failed" ? "alert" : "status"}>
    <div className="test-result-heading"><strong>{result.status === "verified" && generation ? "模型调用通过" : labels[result.status]}</strong>
      {result.durationMs !== undefined && <span>{(result.durationMs / 1000).toFixed(1)} 秒</span>}
    </div>
    <p>{result.message}</p>
    {plan && <p className="test-result-meta">
      {plan.provider}{plan.method ? ` · ${plan.method}${plan.path ? ` ${plan.path}` : ""}` : ""}
      {` · ${plan.level === "generation" ? "验证一次模型调用" : plan.level === "authentication" ? "验证鉴权" : plan.level === "service" ? "仅验证服务响应" : "未调用服务"}`}
      {` · ${plan.billing === "none" ? "无生成调用" : "可能产生请求费用"}`}
      {plan.model ? ` · ${plan.model}` : ""}
    </p>}
    {result.status === "confirmation" && onConfirm && (generation ? <div className="model-test-confirmation">
      <label>测试模型<select aria-label="测试模型" value={model} onChange={(event) => setModel(event.target.value)}>
        <option value="">请选择本次测试的模型</option>
        {generation.models.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
      </select></label>
      {selected && <p>常规档价格：输入 ¥{selected.inputPriceCnyPerMillion} / 百万 tokens，输出 ¥{selected.outputPriceCnyPerMillion} / 百万 tokens。</p>}
      <p>使用此连接已保存的 API Key，向 {"baseUrl" in connection ? new URL(connection.baseUrl).origin : ""}{plan?.path} 发送 1 次请求。输入固定为「{generation.prompt}」，最多 {generation.maxOutputTokens} 个输出 tokens，关闭深度思考。</p>
      <p>{generation.costNote}</p>
      <p>取消或超时不会自动重试；服务商已受理的请求仍可能计费。</p>
      <p><a href={generation.documentationUrl} target="_blank" rel="noreferrer">官方接口说明</a> · <a href={generation.pricingUrl} target="_blank" rel="noreferrer">官方价格</a>（核对于 {generation.pricingCheckedAt}）</p>
      <button type="button" disabled={!selected} onClick={() => { if (selected) onConfirm(selected.id); }}>确认模型测试（可能计费）</button>
    </div> : <button type="button" onClick={() => onConfirm()}>确认测试（可能产生请求费）</button>)}
  </div>;
}

export function ConnectionTest({ connection, unavailable, pending, disabled = false, result, onTest, onCancel, onConfirm, compact = false }: {
  connection: TestableConnection;
  unavailable: string;
  compact?: boolean;
} & ConnectionTestControls) {
  return <div className="connection-test">
    <div className="test-actions">
      <button type="button" disabled={disabled || pending || !!unavailable} onClick={onTest} title={unavailable || "检查已保存连接的鉴权或服务响应"}>
        {pending ? "测试中…" : "测试连接"}
      </button>
      {pending && <button type="button" className="test-cancel" onClick={onCancel}>取消测试</button>}
    </div>
    {!!unavailable && !compact && <small className="field-note">{unavailable}</small>}
    {!compact && <ConnectionTestFeedback connection={connection} unavailable={unavailable} result={result} onConfirm={onConfirm} />}
  </div>;
}
