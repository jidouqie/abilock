import type { Connection } from "./connection-form.js";

export type SshTestResult = {
  alias: string;
  revision: number;
  success: boolean;
  message: string;
};

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) &&
    sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

// A probe always uses the saved revision. Draft targets and credentials never
// become part of the request, even when a draft is otherwise valid to save.
export function sshTestUnavailable(
  saved: Connection | null | undefined,
  draft = saved,
  secrets: Record<string, string> = {},
  identity = "keep",
  ...latestSnapshot: [] | [Connection | null | undefined]
): string {
  // Omitting a latest snapshot is useful for a list row. Supplying a missing
  // lookup explicitly means the editor's saved connection no longer exists.
  const latest = latestSnapshot.length ? latestSnapshot[0] : saved;
  if (!saved || saved.kind !== "ssh" || !Number.isInteger(saved.revision) || saved.revision! < 1)
    return "保存后测试";
  if (!draft || !sameValue(saved, draft) || identity !== "keep" || Object.values(secrets).some(Boolean))
    return "保存后测试";
  if (!latest || !sameValue(saved, latest))
    return "请重新打开连接";
  if (!saved.enabled) return "连接已停用";
  if (!saved.hasSecret) return "请先保存凭据";
  return "";
}

export function sshTestError(failure: unknown): string {
  const code = (failure as { code?: unknown } | null)?.code;
  switch (code) {
    case "SSH_TEST_DNS": return "无法解析服务器地址";
    case "SSH_TEST_CONNECT": return "无法连接服务器，请检查地址和端口";
    case "SSH_TEST_AUTH": return "鉴权失败，请检查账号和凭据";
    case "SSH_TEST_TIMEOUT": return "连接测试超时";
    case "SSH_TEST_CANCELLED": return "连接测试已取消";
    case "REVISION_CONFLICT": return "连接已变化，请刷新后重试";
    default: return "连接测试失败，请重试";
  }
}

export function SshConnectionTest({
  connection, unavailable, pending, disabled = false, result, onTest,
}: {
  connection: Connection;
  unavailable: string;
  pending: boolean;
  disabled?: boolean;
  result?: SshTestResult | null;
  onTest: () => void;
}) {
  const current = result?.alias === connection.alias && result.revision === connection.revision ? result : null;
  return <div className="ssh-connection-test">
    <button type="button" disabled={disabled || pending || !!unavailable} onClick={onTest}>
      {pending ? "测试中…" : "测试连接"}
    </button>
    {!!unavailable && <small className="field-note">{unavailable}</small>}
    {!unavailable && current && <small className={current.success ? "test-success" : "test-error"}
      role={current.success ? "status" : "alert"}>{current.message}</small>}
  </div>;
}
