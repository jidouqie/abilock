import React from "react";
import { connectionLabels, type ConnectionKind } from "./connection-form.js";
import { Modal } from "./modal.js";
import { authIdentity, type Platform } from "./platform-form.js";
import { ConnectionTest, connectionTestUnavailable, type ConnectionTestControls } from "./connection-test.js";

const authLabels: Record<string, string> = {
  none: "无",
  bearer: "Bearer",
  header: "Header",
  query: "Query",
  basic: "Basic",
  adapter: "适配器",
};

export function PlatformEditor({
  edit,
  original,
  saved,
  connectionTest,
  secret,
  username,
  adapters,
  busy,
  configurationReady,
  configurationAlert,
  alert,
  onEdit,
  onAuth,
  onSecret,
  onUsername,
  onKind,
  onClose,
  onSubmit,
}: {
  edit: Platform;
  original: Platform | null;
  saved: Platform | undefined;
  connectionTest: ConnectionTestControls;
  secret: string;
  username: string;
  adapters: string[];
  busy: boolean;
  configurationReady: boolean;
  configurationAlert: React.ReactNode;
  alert: React.ReactNode;
  onEdit: (platform: Platform) => void;
  onAuth: (auth: Platform["auth"]) => void;
  onSecret: (value: string) => void;
  onUsername: (value: string) => void;
  onKind: (kind: ConnectionKind | "api") => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const authChanged =
    !!original && authIdentity(edit.auth) !== authIdentity(original.auth);
  const secretRequired = edit.auth.type !== "none" && authChanged;
  // Changing the target or authentication clears learned rules; manuals stay.
  const identityChanged =
    !!original && (edit.baseUrl.trim() !== original.baseUrl || authChanged);
  const dirty =
    !!secret ||
    !!username ||
    JSON.stringify(edit) !== JSON.stringify(original ?? edit);
  return (
    <Modal title={original ? "编辑" : "添加"} onClose={onClose} busy={busy} dirty={dirty}>
      {configurationAlert}
      <form onSubmit={onSubmit}>
        <fieldset disabled={busy || !configurationReady}>
          {!original && (
            <label>
              类型
              <select
                aria-label="类型"
                value="api"
                onChange={(event) => onKind(event.target.value as ConnectionKind | "api")}
              >
                <option value="api">API</option>
                {Object.entries(connectionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            别名
            <input
              value={edit.alias}
              required
              maxLength={32}
              pattern="[A-Za-z][A-Za-z0-9_-]{0,31}"
              placeholder="例如 DS"
              onChange={(event) => onEdit({ ...edit, alias: event.target.value })}
            />
          </label>
          <label>
            备注
            <input
              value={edit.note ?? ""}
              maxLength={200}
              placeholder="可选，例如公司项目、个人账号"
              onChange={(event) => onEdit({ ...edit, note: event.target.value })}
            />
          </label>
          <label>
            地址
            <input
              type="url"
              value={edit.baseUrl}
              required
              maxLength={1000}
              placeholder="https://api.deepseek.com"
              onChange={(event) => onEdit({ ...edit, baseUrl: event.target.value })}
            />
          </label>
          <label>
            鉴权
            <select
              aria-label="鉴权"
              value={edit.auth.type}
              onChange={(event) =>
                onAuth({
                  type: event.target.value,
                  ...(["header", "query"].includes(event.target.value) ? { name: "" } : {}),
                  ...(event.target.value === "adapter" ? { adapter: adapters[0] } : {}),
                })
              }
            >
              {[
                "bearer",
                "header",
                "query",
                "basic",
                "none",
                ...(adapters.length || edit.auth.type === "adapter" ? ["adapter"] : []),
              ].map((type) => (
                <option key={type} value={type}>
                  {authLabels[type]}
                </option>
              ))}
            </select>
          </label>
          {["header", "query"].includes(edit.auth.type) && (
            <label>
              字段名
              <input
                value={edit.auth.name ?? ""}
                required
                maxLength={80}
                placeholder={edit.auth.type === "header" ? "X-API-Key" : "api_key"}
                onChange={(event) => onAuth({ ...edit.auth, name: event.target.value })}
              />
            </label>
          )}
          {edit.auth.type === "adapter" && (
            <label>
              适配器
              <select
                aria-label="适配器"
                value={edit.auth.adapter ?? ""}
                required
                onChange={(event) => onAuth({ ...edit.auth, adapter: event.target.value })}
              >
                {edit.auth.adapter && !adapters.includes(edit.auth.adapter) && (
                  <option value={edit.auth.adapter}>{edit.auth.adapter}</option>
                )}
                {adapters.map((adapter) => (
                  <option key={adapter} value={adapter}>
                    {adapter}
                  </option>
                ))}
              </select>
            </label>
          )}
          {edit.auth.type === "basic" && (
            <label>
              账号
              <input
                value={username}
                required={secretRequired || !!secret}
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                placeholder={edit.hasSecret && !authChanged ? "留空保留" : !secretRequired ? "可稍后填写" : ""}
                onChange={(event) => onUsername(event.target.value)}
              />
            </label>
          )}
          {edit.auth.type !== "none" && (
            <label>
              {edit.auth.type === "basic" ? "密码" : "密钥"}
              <input
                type="password"
                value={secret}
                required={secretRequired || (edit.auth.type === "basic" && !!username)}
                autoComplete="off"
                maxLength={4096}
                placeholder={edit.hasSecret && !authChanged ? "留空保留" : !secretRequired ? "可稍后填写" : ""}
                onChange={(event) => onSecret(event.target.value)}
              />
            </label>
          )}
          {edit.auth.type !== "none" && !edit.hasSecret && !secretRequired && (
            <p className="field-note">可留空保存，稍后补充；填入后才能测试或调用。</p>
          )}
          <label>
            API 文档
            <input
              type="url"
              value={edit.documentationUrl ?? ""}
              maxLength={1500}
              placeholder="官方文档链接，可选"
              onChange={(event) => onEdit({ ...edit, documentationUrl: event.target.value })}
            />
          </label>
          {original && (
            <label className="check">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(event) => onEdit({ ...edit, enabled: event.target.checked })}
              />
              启用
            </label>
          )}
        </fieldset>
        {identityChanged && (original.rules.length > 0 || !!original.description) && (
          <p className="field-note" role="status">
            地址或鉴权已修改：保存后接口规则会清空，需要让 AI 重新整理；已保存的手册会保留并标记为待更新。
          </p>
        )}
        {alert}
        <ConnectionTest connection={original ?? edit}
          unavailable={connectionTestUnavailable(original, edit, { secret, username }, "keep", saved)}
          {...connectionTest} />
        <div className="form-actions">
          <button className="primary" disabled={busy || !configurationReady}>
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
