import React from "react";
import {
  ConnectionFields,
  connectionLabels,
  credentialFields,
  type Connection,
  type ConnectionKind,
} from "./connection-form.js";
import { Modal } from "./modal.js";
import { PrivateKeyFile } from "./private-key-file.js";
import {
  ConnectionTest,
  connectionTestUnavailable,
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
  onSubmit: (event: React.FormEvent) => void;
}) {
  const dirty =
    Object.values(secrets).some(Boolean) ||
    JSON.stringify(edit) !== JSON.stringify(original ?? edit);
  const replacing = Object.values(secrets).some(Boolean);
  const changedAuth =
    !!original &&
    ((original.config.auth ?? original.config.authType) !==
      (edit.config.auth ?? edit.config.authType) ||
      original.config.transport !== edit.config.transport);
  return (
    <Modal
      title={original ? "编辑" : "添加"}
      onClose={onClose}
      busy={busy || keyReading}
      dirty={dirty}
    >
      {configurationAlert}
      <form onSubmit={onSubmit}>
        <fieldset disabled={busy || keyReading || !configurationReady}>
          <label>
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
          </label>
          <label>
            别名
            <input
              value={edit.alias}
              required
              maxLength={32}
              pattern="[A-Za-z][A-Za-z0-9_-]{0,31}"
              placeholder="例如 main-db"
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
          <ConnectionFields
            connection={edit}
            onChange={onFieldsChange}
            identity={sshIdentity}
            onIdentityChange={onIdentity}
          />
          {credentialFields(edit, sshIdentity).map((field) => {
            const required =
              field.required &&
              (!edit.hasSecret ||
                changedAuth ||
                replacing ||
                ((edit.kind === "ssh" ||
                  (edit.kind === "git" && edit.config.transport === "ssh")) &&
                  sshIdentity !== "keep"));
            const placeholder = edit.hasSecret && !changedAuth ? "留空保留" : "";
            const update = (value: string) =>
              onSecrets((current) => ({ ...current, [field.key]: value }));
            return (
              <label key={field.key}>
                {field.label}
                {field.multiline ? (
                  <textarea
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
              </label>
            );
          })}
          <label>
            文档
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
          {edit.trustBoundary !== "development-fixture" && (
            <label className="check trust-check">
              <input
                type="checkbox"
                required
                checked={edit.trustBoundary === "independent-target"}
                onChange={(event) =>
                  onEdit({
                    ...edit,
                    trustBoundary: event.target.checked ? "independent-target" : undefined,
                  })
                }
              />
              远端无权管理 Abilock 所在电脑
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
