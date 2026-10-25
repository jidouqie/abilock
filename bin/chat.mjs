// Only UI-owned metadata defines this shortcut. Documents never supply commands.
import { brokerFetch } from "./local-transport.mjs";
function required() {
  return Object.assign(
    new Error("请给 Skill 官方文档地址，由 AI 整理聊天接口与模型"),
    { code: "CONFIG_REQUIRED", exit: 2 },
  );
}
function safePath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("//") &&
    !/[\\%?#\s]/.test(path) &&
    ![...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    !path
      .split("/")
      .some((part) => part === "." || part === ".." || part === "*")
  );
}
export async function chatRequest(base, token, alias, text, signal, trace) {
  trace.reset();
  const response = await brokerFetch(new URL(`/v1/context/${alias}`, base), {
    method: "GET",
    headers: trace.headers({ authorization: `Bearer ${token}` }),
    signal,
    redirect: "error",
  });
  trace.response(response);
  if (!response.ok)
    throw Object.assign(
      new Error("无法读取已配置平台的聊天参数，请核对执行权限"),
      {
        code: "CONTEXT_ACCESS",
        exit: response.status === 400 ? 2 : 3,
      },
    );
  const context = await response.json();
  trace.verifyBody(context);
  const { platform } = context;
  const chat = platform?.chat;
  if (
    !chat ||
    platform.enabled === false ||
    chat.method !== "POST" ||
    !safePath(chat.path) ||
    typeof chat.model !== "string" ||
    !chat.model.trim() ||
    chat.model.length > 256 ||
    !Array.isArray(platform.rules) ||
    !platform.rules.some(
      (rule) =>
        rule &&
        typeof rule === "object" &&
        rule.method === "POST" &&
        typeof rule.path === "string" &&
        rule.path === chat.path,
    )
  ) {
    trace.reset();
    throw required();
  }
  return {
    method: "POST",
    path: chat.path,
    body: {
      model: chat.model,
      messages: [{ role: "user", content: text }],
    },
  };
}
