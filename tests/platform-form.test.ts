import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { platformWrite, type Platform } from "../web/components/platform-form.js";
import { PlatformEditor } from "../web/components/platform-editor.js";
import { connectionStatus } from "../web/components/connection-list.js";
import { connectionTestUnavailable } from "../web/components/connection-test.js";

function platform(): Platform {
  return {
    alias: "DS_WORK",
    name: "DeepSeek",
    baseUrl: "https://api.example.test",
    auth: { type: "bearer" },
    description: "已有用法",
    documentationUrl: "https://docs.example.test/api",
    rules: [{ method: "POST", path: "/chat/completions" }],
    capabilityNotes: [{
      name: "聊天", summary: "文本生成", tags: [], input: "messages", output: "text",
      method: "POST", path: "/chat/completions",
    }],
    chat: { method: "POST", path: "/chat/completions", model: "synthetic-model" },
    hasSecret: true,
    enabled: true,
    allowInsecureLocal: false,
    revision: 5,
  };
}

test("API note edits preserve the alias, authentication and learned usage without writing a credential", () => {
  const original = platform();
  const input = platformWrite({ ...original, note: " 公司项目 " }, original);
  assert.equal(input.platform.note, "公司项目");
  assert.equal(input.platform.alias, original.alias);
  assert.deepEqual(input.platform.auth, original.auth);
  assert.equal(input.platform.baseUrl, original.baseUrl);
  assert.equal(input.platform.description, original.description);
  assert.deepEqual(input.platform.rules, original.rules);
  assert.deepEqual(input.platform.capabilityNotes, original.capabilityNotes);
  assert.deepEqual(input.platform.chat, original.chat);
  assert.equal(input.platform.documentationUrl, original.documentationUrl);
  assert.equal(input.expectedRevision, 5);
  assert.equal(input.secret, undefined);
  assert.equal(input.clearSecret, false);
});

test("API note can be omitted for legacy connections or explicitly cleared", () => {
  const original = platform();
  assert.equal(platformWrite(original, original).platform.note, "");
  const noted = { ...original, note: "个人账号" };
  for (const note of ["", "   "]) {
    const input = platformWrite({ ...noted, note }, noted);
    assert.equal(input.platform.note, "");
    assert.equal(input.secret, undefined);
    assert.equal(input.clearSecret, false);
  }
});

test("new API connections can keep their authentication type while awaiting a credential", () => {
  for (const auth of [
    { type: "bearer" }, { type: "header", name: "X-API-Key" },
    { type: "query", name: "api_key" }, { type: "basic" }, { type: "adapter", adapter: "synthetic-adapter" },
  ]) {
    const fresh = { ...platform(), hasSecret: false, revision: undefined, auth };
    const input = platformWrite(fresh, null);
    assert.deepEqual(input.platform.auth, auth);
    assert.equal(input.secret, undefined);
    assert.equal(input.clearSecret, false);
    assert.equal(input.expectedRevision, 0);
    const saved = { ...fresh, revision: 1 };
    assert.equal(connectionStatus(saved), "缺密钥");
    assert.equal(connectionTestUnavailable(saved), "请先保存凭据");
  }
});

test("pending API connections allow public metadata edits without adding or clearing credentials", () => {
  const original = { ...platform(), hasSecret: false };
  const input = platformWrite({ ...original, note: "稍后填写", documentationUrl: "https://docs.example.test/new" }, original);
  assert.equal(input.platform.note, "稍后填写");
  assert.equal(input.platform.documentationUrl, "https://docs.example.test/new");
  assert.deepEqual(input.platform.auth, original.auth);
  assert.deepEqual(input.platform.rules, original.rules);
  assert.equal(input.secret, undefined);
  assert.equal(input.clearSecret, false);
  assert.equal(input.expectedRevision, original.revision);
  const completed = platformWrite(original, original, { secret: "synthetic-later-key" });
  assert.deepEqual(completed.secret, { value: "synthetic-later-key" });
  assert.equal(completed.clearSecret, false);
});

test("changing an existing authentication identity still requires replacement credentials", () => {
  for (const hasSecret of [false, true]) {
    const original = { ...platform(), hasSecret };
    const changed = { ...original, auth: { type: "header", name: "X-API-Key" } };
    assert.throws(() => platformWrite(changed, original), /请填写密钥/);
    const input = platformWrite(changed, original, { secret: "synthetic-replacement-key" });
    assert.deepEqual(input.secret, { value: "synthetic-replacement-key" });
    assert.equal(input.clearSecret, false);
  }
  const header = { ...platform(), auth: { type: "header", name: "X-Old-Key" } };
  assert.throws(() => platformWrite({ ...header, auth: { type: "header", name: "X-New-Key" } }, header), /请填写密钥/);
  const original = platform();
  assert.equal(platformWrite({ ...original, auth: { type: "none" } }, original).clearSecret, true);
});

test("Basic authentication can be deferred only as a complete empty pair", () => {
  const basic = { ...platform(), hasSecret: false, auth: { type: "basic" } };
  assert.equal(platformWrite(basic, null).secret, undefined);
  assert.throws(() => platformWrite(basic, null, { username: "synthetic-user" }), /请填写密码/);
  assert.throws(() => platformWrite(basic, null, { secret: "synthetic-password" }), /请填写账号/);
  assert.deepEqual(platformWrite(basic, null, { username: "synthetic-user", secret: "synthetic-password" }).secret,
    { username: "synthetic-user", password: "synthetic-password" });
});

test("API editor leaves pending credential optional and preserves required replacement inputs", () => {
  const render = (edit: Platform, original: Platform | null, secret = "", username = "") => renderToStaticMarkup(
    React.createElement(PlatformEditor, {
      edit, original, saved: original ?? undefined, secret, username, adapters: [], busy: false,
      configurationReady: true, configurationAlert: null, alert: null,
      connectionTest: { pending: false, disabled: false, result: null, onTest() {}, onCancel() {}, onConfirm() {} },
      onEdit() {}, onAuth() {}, onSecret() {}, onUsername() {}, onKind() {}, onClose() {}, onSubmit() {},
    }),
  );
  const pending = { ...platform(), hasSecret: false };
  const newHtml = render(pending, null);
  const secretInput = (html: string) => html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(secretInput(newHtml), /required=/);
  assert.match(newHtml, /可留空保存，稍后补充/);
  assert.doesNotMatch(secretInput(render(pending, pending)), /required=/);
  assert.match(render(pending, pending), /请先保存凭据/);
  const original = platform();
  assert.match(secretInput(render(original, original)), /placeholder="留空保留"/);
  assert.doesNotMatch(secretInput(render(original, original)), /required=/);
  const changed = { ...original, auth: { type: "header", name: "X-API-Key" } };
  assert.match(secretInput(render(changed, original)), /required=""/);
  assert.doesNotMatch(render(changed, original), /可留空保存/);
  const basic = { ...pending, auth: { type: "basic" } };
  assert.doesNotMatch(secretInput(render(basic, null)), /required=/);
  assert.match(secretInput(render(basic, null, "", "synthetic-user")), /required=""/);
});
