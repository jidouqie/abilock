import React, { useRef } from "react";
import {
  ConnectionFields,
  blankConnection,
  connectionLabels,
  credentialFields,
  type Connection,
  type ConnectionKind,
} from "./connection-form.js";
import { Modal } from "./modal.js";
import { PrivateKeyFile } from "./private-key-file.js";
import { FieldLabel } from "./field-label.js";
import {
  ConnectionTest,
  connectionTestUnavailable,
  sameValue,
  type ConnectionTestControls,
} from "./connection-test.js";

export function ConnectionEditor({
  edit,
  original,
  saved,
  secrets,
  sshIdentity,
  busy,
  keyReading,
  configurationReady,
  configurationAlert,
  alert,
  connectionTest,
  onEdit,
  onFieldsChange,
  onIdentity,
  onSecrets,
  onKeyReading,
  onKeyError,
  onKind,
  onClose,
  onSubmit,
}: {
  edit: Connection;
  original: Connection | null;
  /** The latest saved copy of the original, for test freshness checks. */
  saved: Connection | undefined;
  secrets: Record<string, string>;
  sshIdentity: string;
  busy: boolean;
  keyReading: boolean;
  configurationReady: boolean;
  configurationAlert: React.ReactNode;
  alert: React.ReactNode;
  connectionTest: ConnectionTestControls;
  onEdit: (connection: Connection) => void;
  onFieldsChange: (connection: Connection) => void;
  onIdentity: (identity: string) => void;
  onSecrets: (update: (current: Record<string, string>) => Record<string, string>) => void;
  onKeyReading: (reading: boolean) => void;
  onKeyError: (message: string) => void;
  onKind: (kind: ConnectionKind | "api") => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent, trustBoundary: Connection["trustBoundary"]) => void;
}) {
  const dirty =
    Object.values(secrets).some(Boolean) ||
    JSON.stringify(edit) !== JSON.stringify(original ?? blankConnection(edit.kind));
  const replacing = Object.values(secrets).some(Boolean);
  const changingSshIdentity = (edit.kind === "ssh" ||
    (edit.kind === "git" && edit.config.transport === "ssh")) && sshIdentity !== "keep";
  const trustCheckbox = useRef<HTMLInputElement>(null);
  const requiresTrustConfirmation = edit.trustBoundary !== "development-fixture" && (
    original?.trustBoundary !== "independent-target" || original.kind !== edit.kind ||
    !sameValue(edit.config, original.config) || replacing || changingSshIdentity
  );
  const changedAuth =
    !!original &&
    ((original.config.auth ?? original.config.authType) !==
      (edit.config.auth ?? edit.config.authType) ||
      original.config.transport !== edit.config.transport);
  const fields = credentialFields(edit, sshIdentity);
  const renderCredential = (field: (typeof fields)[number]) => {
    const required =
      field.required &&
      (!edit.hasSecret ||
        changedAuth ||
        replacing ||
        changingSshIdentity);
    const retaining = edit.hasSecret && !changedAuth && !required && !replacing &&
      !changingSshIdentity;
    const placeholder = retaining ? "全部留空保留已保存凭据" : !field.required ? "可留空" : "";
    const label = `${field.label}${!field.required ? "（可选）" : retaining ? "（留空保留）" : ""}`;
    const update = (value: string) => {
      if (value === (secrets[field.key] ?? "")) return;
      if (trustCheckbox.current) trustCheckbox.current.checked = false;
      onSecrets((current) => ({ ...current, [field.key]: value }));
    };
    return (
      <label key={field.key}>
        <FieldLabel required={required}>
          {label}
        </FieldLabel>
        {field.multiline ? (
          <textarea
            aria-label={label}
            value={secrets[field.key] ?? ""}
            rows={4}
            required={required}
            maxLength={100000}
            autoComplete="off"
            placeholder={placeholder}
            onChange={(event) => update(event.target.value)}
          />
        ) : (
          <input
            aria-label={label}
            type="password"
            value={secrets[field.key] ?? ""}
            required={required}
            maxLength={100000}
            autoComplete="off"
            placeholder={placeholder}
            onChange={(event) => update(event.target.value)}
          />
        )}
        {field.key === "privateKey" && (
          <PrivateKeyFile
            disabled={busy}
            onReading={onKeyReading}
            onError={onKeyError}
            onValue={(value) => {
              onKeyError(""); // A newly read key clears an earlier read error.
              update(value);
            }}
          />
        )}
        {field.note && <small className="field-note">{field.note}</small>}
      </label>
    );
  };
  return (
    <Modal
      title={original ? "编辑" : "添加"}
      onClose={onClose}
      busy={busy || keyReading}
      dirty={dirty}
    >
      {configurationAlert}
      <form onSubmit={(event) => {
        let trustBoundary = edit.trustBoundary;
        if (requiresTrustConfirmation) {
          trustBoundary = new FormData(event.currentTarget).get("trustBoundary") === "independent-target"
            ? "independent-target"
            : undefined;
        }
        onSubmit(event, trustBoundary);
      }}>
        <fieldset disabled={busy || keyReading || !configurationReady}>
          {!original && <label>
            类型
            <select
              aria-label="类型"
              value={edit.kind}
              disabled={!!original}
              onChange={(event) => onKind(event.target.value as ConnectionKind | "api")}
            >
              <option value="api">API</option>
              {Object.entries(connectionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>}
          <label>
            <FieldLabel required>别名</FieldLabel>
            <input
              aria-label="别名"
              value={edit.alias}
              required
              maxLength={32}
              pattern="[A-Za-z][A-Za-z0-9_-]{0,31}"
              placeholder="例如 main-db"
              onChange={(event) => onEdit({ ...edit, alias: event.target.value })}
            />
          </label>
          <ConnectionFields
            connection={edit}
            onChange={onFieldsChange}
            identity={sshIdentity}
            onIdentityChange={onIdentity}
            section="basic"
          />
          {fields.filter((field) => !field.advanced).map(renderCredential)}
          {original?.hasSecret && replacing && fields.some((field) => field.advanced) && (
            <p className="field-note" role="status">
              保存会更换整组凭据；如使用了{fields.filter((field) => field.advanced).map((field) => field.label).join("、")}，请在更多选项中一并填写。
            </p>
          )}
          <details className="connection-options">
            <summary>更多选项</summary>
            <div className="option-fields">
              <ConnectionFields
                connection={edit}
                onChange={onFieldsChange}
                identity={sshIdentity}
                onIdentityChange={onIdentity}
                section="advanced"
              />
              {fields.filter((field) => field.advanced).map(renderCredential)}
              <label>
                备注（可选）
                <input
                  value={edit.note ?? ""}
                  maxLength={200}
                  placeholder="可留空，例如公司项目、个人账号"
                  onChange={(event) => onEdit({ ...edit, note: event.target.value })}
                />
              </label>
              <label>
                文档（可选）
                <input
                  type="url"
                  value={edit.documentationUrl ?? ""}
                  maxLength={1500}
                  placeholder="官方文档链接，可留空"
                  onChange={(event) => onEdit({ ...edit, documentationUrl: event.target.value })}
                />
              </label>
            </div>
          </details>
          {original && (
            <label className="check switch">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(event) => onEdit({ ...edit, enabled: event.target.checked })}
              />
              启用
            </label>
          )}
          {requiresTrustConfirmation && (
            <label className="check trust-check">
              <input
                key={JSON.stringify([edit.kind, edit.config, sshIdentity])}
                ref={trustCheckbox}
                aria-label="我确认远端及所用账号无法管理 Abilock 所在电脑"
                name="trustBoundary"
                type="checkbox"
                value="independent-target"
                required
              />
              <FieldLabel required>我确认远端及所用账号无法管理 Abilock 所在电脑</FieldLabel>
            </label>
          )}
        </fieldset>
        {alert}
          <ConnectionTest
            connection={original ?? edit}
            unavailable={connectionTestUnavailable(original, edit, secrets, sshIdentity, saved)}
            {...connectionTest}
          />
        <div className="form-actions">
          <button className="primary" disabled={busy || keyReading || !configurationReady}>
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
