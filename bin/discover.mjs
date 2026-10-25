// Read-only execution inventory. This module never opens files or management APIs.
import { brokerFetch } from "./local-transport.mjs";
import requestLimits from "../request-limits.json" with { type: "json" };
function options(args) {
  const seen = new Set();
  let json = false,
    query = "";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--json", "--query"].includes(flag) || seen.has(flag))
      throw new Error("list 只接受一次 --json 和 --query TEXT");
    seen.add(flag);
    if (flag === "--json") json = true;
    else {
      const text = args[++i];
      if (!text || text.startsWith("--") || !text.trim() || text.length > 2000)
        throw new Error("--query 需要 1–2000 字符的搜索文字");
      query = text.trim();
    }
  }
  return { json, query };
}
const string = (value) => (typeof value === "string" ? value : "");
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
const line = (value) =>
  [...string(value).replace(/[\r\n\t]+/g, " ")]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim();

function filterInventory(value, query) {
  const data = value && typeof value === "object" ? value : {};
  const cards = Array.isArray(data.capabilities)
    ? data.capabilities.filter((card) => card && typeof card === "object")
    : [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    ...data,
    capabilities: terms.length
      ? cards.filter((card) => {
          const text = [
            card.name,
            card.summary,
            card.alias,
            card.note,
            card.protocol,
            ...strings(card.tags),
          ]
            .map(string)
            .join(" ")
            .toLowerCase();
          return terms.every((term) => text.includes(term));
        })
      : cards,
  };
}

export function discoveryMarkdown(data) {
  const cards = Array.isArray(data.capabilities) ? data.capabilities : [];
  const lines = ["# Abilock 已配置能力", ""];
  if (line(data.revision)) lines.push(`配置版本：${line(data.revision)}`);
  if (line(data.updatedAt)) lines.push(`更新时间：${line(data.updatedAt)}`);
  if (line(data.guidance)) lines.push("", line(data.guidance));
  lines.push(
    "",
    "读取目录不会发起上游探测；configured不代表凭据有效，inventory-only仅为已保存的概况。",
    "",
  );
  if (!cards.length) lines.push("没有匹配的能力。", "");
  for (const card of cards) {
    const status =
      {
        configured: "已配置",
        "missing-credentials": "缺少凭据",
        disabled: "已停用",
        unavailable: "当前不可调用",
        "needs-documentation": "待整理",
      }[card.status] ?? "状态未说明";
    lines.push(
      `## ${line(card.name) || line(card.alias) || "未命名能力"}`,
      `标识：${line(card.id) || "未说明"} · 连接：${line(card.alias) || "未说明"} · 协议：${line(card.protocol) || "未说明"} · ${status}`,
      ...(line(card.note) ? [`备注：${line(card.note)}`] : []),
      line(card.summary) || "用途未说明。",
    );
    if (strings(card.tags).length)
      lines.push(`标签：${strings(card.tags).map(line).join("、")}`);
    for (const [field, label] of [
      ["input", "输入"],
      ["output", "输出"],
      ["invocation", "调用"],
      ["docsCommand", "详情"],
      ["source", "来源"],
      ["verification", "验证"],
      ["updatedAt", "更新"],
    ])
      if (line(card[field])) lines.push(`${label}：${line(card[field])}`);
    if (strings(card.scope).length)
      lines.push(`范围：${strings(card.scope).map(line).join("；")}`);
    if (strings(card.limitations).length)
      lines.push(`限制：${strings(card.limitations).map(line).join("；")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function cleanInventory(value, token, depth = 0) {
  if (depth > 100) return "[NESTING_LIMIT]";
  if (typeof value === "string") {
    for (const secret of new Set([
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
    ]))
      if (secret) value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => cleanInventory(item, token, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        cleanInventory(key, token, depth + 1),
        cleanInventory(item, token, depth + 1),
      ]),
    );
  return value;
}

export async function discoverMain(args, executionAccess, fail, trace) {
  let selected;
  try {
    trace.reset();
    selected = options(args);
  } catch (error) {
    return fail("USAGE", error.message);
  }
  let access;
  try {
    access = executionAccess();
  } catch (error) {
    return fail(error.code, error.message, error.exit ?? 2);
  }
  const { base, token } = access;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(cancel, requestLimits.metadataClientTimeoutMs);
  timer.unref();
  try {
    const response = await brokerFetch(new URL("/v2/discovery", base), {
      method: "GET",
      headers: trace.headers({ authorization: `Bearer ${token}` }),
      redirect: "error",
      signal: controller.signal,
    });
    trace.response(response);
    const status = response.status;
    const requestId = cleanInventory(
      response.headers.get("x-abilock-request-id") ??
        response.headers.get("x-coi-request-id"),
      token,
    );
    const value = cleanInventory(await response.json(), token);
    trace.verifyBody(value);
    if (!response.ok) {
      const error = {
        code: string(value?.error?.code) || "SERVICE_ERROR",
        message: string(value?.error?.message) || "服务错误",
      };
      const exitCode = status === 400 ? 2 : 3;
      if (selected.json) {
        trace.json({ ok: false, status, requestId, error });
        process.exitCode = exitCode;
      } else fail(error.code, error.message, exitCode);
      return;
    }
    const data = filterInventory(value, selected.query);
    if (selected.json) trace.json({ ok: true, status, requestId, data });
    else process.stdout.write(discoveryMarkdown(data));
  } catch (error) {
    if (
      ["TRACE_CONTEXT", "LOCAL_RUNTIME_REQUIRED", "LOCAL_EXECUTION"].includes(
        error.code,
      )
    )
      return fail(error.code, error.message, error.exit ?? 3);
    fail(
      controller.signal.aborted ? "CANCELLED" : "CONNECTION",
      controller.signal.aborted
        ? "请求已取消或超时"
        : "连接或响应读取失败；不会自动重试",
      controller.signal.aborted ? 130 : 3,
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
