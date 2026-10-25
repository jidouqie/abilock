import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankConnection, type Connection } from "../web/components/connection-form.js";
import { connectionKinds } from "../src/protocol-kinds.js";
import type { Platform } from "../web/components/platform-form.js";
import { planHTTPConnectionTest } from "../src/http-connection-test.js";
import { ConnectionList } from "../web/components/connection-list.js";
import {
  ConnectionTest, ConnectionTestFeedback, connectionTestUnavailable, connectionTestError,
  readConnectionTestPlan, type ConnectionTestPlan, type ConnectionTestResult,
} from "../web/components/connection-test.js";

const api: Platform = {
  alias: "API_FIXTURE", name: "API fixture", baseUrl: "https://api.example.invalid",
  auth: { type: "bearer" }, rules: [], enabled: true, allowInsecureLocal: false,
  description: "", hasSecret: true, revision: 4,
};
const ssh: Connection = {
  ...blankConnection("ssh"), alias: "SSH_FIXTURE", name: "SSH fixture", revision: 3, hasSecret: true,
};
const plan: ConnectionTestPlan = {
  alias: api.alias, revision: 4, kind: "api", supported: true,
  provider: "Synthetic provider", method: "GET /models", level: "authentication", billing: "none",
  message: "只读鉴权验证，不调用生成模型。",
};
const result: ConnectionTestResult = { alias: api.alias, revision: 4, status: "verified", message: "已确认鉴权。", plan, durationMs: 125 };

test("API and every saved protocol have a test entry with a separate full-width result row", () => {
  const connections = connectionKinds.map((kind) => ({
    ...blankConnection(kind), alias: `FIXTURE_${kind.toUpperCase()}`, name: kind, hasSecret: true, revision: 1,
  }));
  const html = renderToStaticMarkup(React.createElement(ConnectionList, {
    platforms: [api], connections, filter: "全部", query: "", actionsDisabled: false,
    connectionTest: { disabled: false, pending: null, result, onTest() {}, onCancel() {}, onConfirm() {} },
    onAdd() {}, onSelect() {}, onEditPlatform() {}, onEditConnection() {}, onRemove() {},
  }));
  assert.equal((html.match(/>测试连接<\/button>/g) ?? []).length, connectionKinds.length + 1);
  assert.equal((html.match(/role="columnheader"/g) ?? []).length, 4);
  assert.match(html, /class="connection-row-feedback"/);
  assert.match(html, /鉴权通过/);
  assert.match(html, /0\.1 秒/);
});

test("test availability rejects unsaved credentials, drafts, stale revisions and disabled connections", () => {
  assert.equal(connectionTestUnavailable(api), "");
  assert.equal(connectionTestUnavailable(ssh), "");
  assert.equal(connectionTestUnavailable(null), "保存后测试");
  assert.equal(connectionTestUnavailable({ ...api, revision: 0 }), "保存后测试");
  assert.equal(connectionTestUnavailable({ ...api, enabled: false }), "连接已停用");
  assert.equal(connectionTestUnavailable({ ...api, hasSecret: false }), "请先保存凭据");
  assert.equal(connectionTestUnavailable({ ...api, auth: { type: "none" }, hasSecret: false }), "");
  assert.equal(connectionTestUnavailable(api, api, { value: "synthetic-new-key" }), "保存后测试");
  assert.equal(connectionTestUnavailable(api, { ...api, note: "unsaved" }), "保存后测试");
  assert.equal(connectionTestUnavailable(api, api, {}, "keep", { ...api, revision: 5 }), "请重新打开连接");
  assert.equal(connectionTestUnavailable(api, api, {}, "keep", undefined), "请重新打开连接");
  assert.equal(connectionTestUnavailable(ssh, ssh, {}, "privateKey"), "保存后测试");
  assert.equal(connectionTestUnavailable(ssh, { ...ssh, config: Object.fromEntries(Object.entries(ssh.config).reverse()) }), "");
});

test("result display cannot attest to another saved alias or revision", () => {
  const render = (next: ConnectionTestResult, unavailable = "") => renderToStaticMarkup(React.createElement(ConnectionTestFeedback, {
    connection: api, result: next, unavailable,
  }));
  assert.match(render(result), /鉴权通过/);
  assert.equal(render({ ...result, alias: "OTHER" }), "");
  assert.equal(render({ ...result, revision: 3 }), "");
  assert.equal(render(result, "保存后测试"), "");
  const reachable = render({ ...result, status: "reachable", message: "服务响应，凭据未确认。", plan: { ...plan, level: "service" } });
  assert.match(reachable, /服务已响应/);
  assert.match(reachable, /仅验证服务响应/);
  assert.doesNotMatch(reachable, /鉴权通过/);
});

test("pending tests have a non-submit cancellation control and billable tests require explicit confirmation", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionTest, {
    connection: api, unavailable: "", pending: true, disabled: false, result,
    onTest() {}, onCancel() {}, onConfirm() {},
  }));
  assert.match(html, /type="button" disabled=""[^>]*>测试中…/);
  assert.match(html, /type="button" class="test-cancel">取消测试/);
  const confirmation = renderToStaticMarkup(React.createElement(ConnectionTestFeedback, {
    connection: api,
    result: { ...result, status: "confirmation", plan: { ...plan, billing: "possible" } },
    onConfirm() {},
  }));
  assert.match(confirmation, /type="button">确认测试（可能产生请求费）/);
  assert.match(confirmation, /等待确认/);
});

test("plan validation rejects mismatched identities and ambiguous validation or billing levels", () => {
  assert.deepEqual(readConnectionTestPlan(plan, api), plan);
  for (const patch of [
    { alias: "OTHER" }, { revision: 3 }, { kind: "ssh" }, { supported: "true" },
    { level: "healthy" }, { billing: "free-probably" }, { provider: null }, { method: 200 },
  ]) assert.throws(() => readConnectionTestPlan({ ...plan, ...patch }, api), { code: "INVALID_RESPONSE" });
});

test("connection test error labels use only fixed categories and never raw upstream text", () => {
  const secret = "synthetic-upstream-echo-secret";
  for (const code of [
    "CONNECTION_TEST_AUTH", "CONNECTION_TEST_PERMISSION", "CONNECTION_TEST_BALANCE", "CONNECTION_TEST_RATE_LIMIT",
    "CONNECTION_TEST_TIMEOUT", "CONNECTION_TEST_CANCELLED", "CONNECTION_TEST_PROTOCOL", "CONNECTION_TEST_CONNECT",
    "CONNECTION_TEST_TLS", "SSH_TEST_HOST_KEY_REQUIRED", "SSH_TEST_HOST_KEY_MISMATCH", "REVISION_CONFLICT", "UNKNOWN",
  ]) assert.ok(!connectionTestError({ code, message: secret }).includes(secret));
  assert.match(connectionTestError({ code: "CONNECTION_TEST_TLS" }), /证书/);
  assert.match(connectionTestError({ code: "SSH_TEST_HOST_KEY_MISMATCH" }), /已停止连接/);
});

test("model test plan requires explicit model choice and presents bounded generation and price evidence", () => {
  const saved = { ...api, baseUrl: "https://ark.cn-beijing.volces.com/api/v3" };
  const generationPlan = { ...planHTTPConnectionTest({ alias: saved.alias, name: saved.name,
    baseUrl: saved.baseUrl, auth: { type: "bearer" }, rules: [], description: "", enabled: true,
    allowInsecureLocal: false }), alias: saved.alias, revision: 4, kind: "api" };
  assert.equal(readConnectionTestPlan(generationPlan, saved), generationPlan);
  const confirmation = renderToStaticMarkup(React.createElement(ConnectionTestFeedback, {
    connection: saved, result: { ...result, status: "confirmation", plan: generationPlan }, onConfirm() {},
  }));
  assert.match(confirmation, /测试模型/);
  assert.match(confirmation, /doubao-seed-2-0-mini-260428/);
  assert.match(confirmation, /doubao-seed-2-0-lite-260428/);
  assert.match(confirmation, /disabled="">确认模型测试（可能计费）/);
  assert.match(confirmation, /最多 16 个输出 tokens/);
  assert.match(confirmation, /已受理的请求仍可能计费/);
  assert.match(confirmation, /已保存的 API Key/);
  assert.match(confirmation, /https:\/\/ark.cn-beijing.volces.com\/api\/v3\/chat\/completions/);
  for (const patch of [{ maxOutputTokens: 1600 }, { maxRequests: 2 }, { thinking: "enabled" },
    { models: [] }, { pricingUrl: "http://bad.invalid" }])
    assert.throws(() => readConnectionTestPlan({ ...generationPlan, generation: { ...generationPlan.generation, ...patch } }, saved), { code: "INVALID_RESPONSE" });
  const success = renderToStaticMarkup(React.createElement(ConnectionTestFeedback, {
    connection: saved, result: { ...result, plan: { ...generationPlan, model: "doubao-seed-2-0-mini-260428" } },
  }));
  assert.match(success, /模型调用通过/);
  assert.match(connectionTestError({ code: "CONNECTION_TEST_MODEL_PERMISSION", message: "synthetic secret" }), /模型未开通/);
});
