import React from "react";
import { Modal } from "./modal.js";
import { PasswordInput } from "./password-input.js";
import { FieldLabel } from "./field-label.js";

const logo = new URL("../assets/abilock-logo.png", import.meta.url).href;

export function Brand() {
  return (
    <div className="brand">
      <img src={logo} alt="" />
      <span>Abilock</span>
    </div>
  );
}

export function LoginView({
  ready,
  initial,
  password,
  confirmation,
  busy,
  alert,
  onPassword,
  onConfirmation,
  onSubmit,
}: {
  ready: boolean;
  initial: boolean;
  password: string;
  confirmation: string;
  busy: boolean;
  alert: React.ReactNode;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <main className="login">
      <div className="login-card">
        <img className="login-logo" src={logo} alt="" />
        <h1 className="login-brand">Abilock</h1>
        <h2>{!ready ? "加载中" : initial ? "设置管理密码" : "登录"}</h2>
        <p className="login-hint">
          {initial
            ? "密码只用于打开本机连接配置，不会交给 AI，也没有默认值。"
            : "输入管理密码，管理本机保存的连接与手册。"}
        </p>
        <form onSubmit={onSubmit}>
        <label>
          <FieldLabel required>管理密码</FieldLabel>
          <PasswordInput
            aria-label="管理密码"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            autoComplete={initial ? "new-password" : "current-password"}
            required
            placeholder={initial ? "至少 8 个字符" : ""}
          />
        </label>
        {initial && (
          <label>
            <FieldLabel required>确认密码</FieldLabel>
            <PasswordInput
              aria-label="确认密码"
              value={confirmation}
              onChange={(event) => onConfirmation(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        )}
        {alert}
        <button className="primary large" disabled={busy || !ready}>
          {busy ? "处理中" : initial ? "保存" : "登录"}
        </button>
        </form>
      </div>
    </main>
  );
}

export function PasswordDialog({
  requireCurrent,
  currentPassword,
  password,
  confirmation,
  busy,
  alert,
  onCurrentPassword,
  onPassword,
  onConfirmation,
  onClose,
  onSubmit,
}: {
  requireCurrent: boolean;
  currentPassword: string;
  password: string;
  confirmation: string;
  busy: boolean;
  alert: React.ReactNode;
  onCurrentPassword: (value: string) => void;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <Modal
      title="密码"
      busy={busy}
      dirty={!!(currentPassword || password || confirmation)}
      onClose={onClose}
    >
      <form onSubmit={onSubmit}>
        <fieldset disabled={busy}>
          {requireCurrent && (
            <label>
              <FieldLabel required>原密码</FieldLabel>
              <PasswordInput
                aria-label="原密码"
                value={currentPassword}
                autoComplete="current-password"
                required
                onChange={(event) => onCurrentPassword(event.target.value)}
              />
            </label>
          )}
          <label>
            <FieldLabel required>新密码</FieldLabel>
            <PasswordInput
              aria-label="新密码"
              value={password}
              required
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              onChange={(event) => onPassword(event.target.value)}
            />
          </label>
          <label>
            <FieldLabel required>确认密码</FieldLabel>
            <PasswordInput
              aria-label="确认密码"
              value={confirmation}
              required
              autoComplete="new-password"
              onChange={(event) => onConfirmation(event.target.value)}
            />
          </label>
        </fieldset>
        {alert}
        <div className="form-actions">
          <button className="primary" disabled={busy}>
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
