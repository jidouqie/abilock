import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionFields, blankConnection, connectionWrite, type Connection } from "../web/components/connection-form.js";
import { SshConnectionTest, sshTestError, sshTestUnavailable } from "../web/components/ssh-connection-test.js";

const saved: Connection = {
  ...blankConnection("ssh"), alias: "SSH_FAKE", name: "Synthetic SSH", note: "测试",
  revision: 4, hasSecret: true, trustBoundary: "independent-target",
  config: { host: "ssh.example.invalid", port: 22, username: "fixture",
    allowShell: false, remoteRoot: "/srv" },
};

test("SSH forms omit fingerprints and preserve old records; Git SSH keeps its separate field", () => {
  const fresh = blankConnection("ssh");
  assert.equal(Object.hasOwn(fresh.config, "hostKeySHA256"), false);
  const render = (connection: Connection) => renderToStaticMarkup(React.createElement(ConnectionFields, {
    connection, identity: "keep", onChange() {}, onIdentityChange() {},
  }));
  assert.doesNotMatch(render(saved), /指纹/);
  const pinned = { ...saved, config: { ...saved.config, hostKeySHA256: "SHA256:" + "A".repeat(43) } };
  assert.doesNotMatch(render(pinned), /指纹|SHA256:AAAAAAAA/);
  assert.equal(connectionWrite(pinned, pinned, {}, "keep").connection.config.hostKeySHA256, pinned.config.hostKeySHA256);
  const input = connectionWrite(saved, saved, {}, "keep");
  assert.deepEqual(input.connection.config, saved.config);
  assert.equal(Object.hasOwn(input.connection.config, "hostKeySHA256"), false);
  const git = blankConnection("git");
  git.config.transport = "ssh";
  assert.match(render(git), /主机指纹/);
});

test("SSH probes require an enabled saved revision with retained credentials and no changed draft", () => {
  assert.equal(sshTestUnavailable(saved), "");
  assert.equal(sshTestUnavailable(null, blankConnection("ssh")), "保存后测试");
  assert.equal(sshTestUnavailable({ ...saved, revision: undefined }), "保存后测试");
  assert.equal(sshTestUnavailable({ ...saved, revision: 0 }), "保存后测试");
  assert.equal(sshTestUnavailable({ ...saved, enabled: false }), "连接已停用");
  assert.equal(sshTestUnavailable({ ...saved, hasSecret: false }), "请先保存凭据");
  assert.equal(sshTestUnavailable({ ...saved, kind: "mysql" }), "保存后测试");
  for (const patch of [
    { alias: "SSH_OTHER" }, { note: "个人账号" }, { documentationUrl: "https://example.test/docs" },
    { enabled: false }, { config: { ...saved.config, host: "different.example.invalid" } },
    { config: { ...saved.config, allowShell: true } },
    { trustBoundary: undefined },
  ]) assert.equal(sshTestUnavailable(saved, { ...saved, ...patch }), "保存后测试");
  assert.equal(sshTestUnavailable(saved, saved, { password: "synthetic-unsaved" }), "保存后测试");
  assert.equal(sshTestUnavailable(saved, saved, {}, "privateKey"), "保存后测试");
  assert.equal(sshTestUnavailable(saved, saved, {}, "password"), "保存后测试");
  assert.equal(sshTestUnavailable(saved, saved, {}, "keep", { ...saved, revision: 5 }), "请重新打开连接");
  assert.equal(sshTestUnavailable(saved, saved, {}, "keep", null), "请重新打开连接");
  assert.equal(sshTestUnavailable(saved, saved, {}, "keep", ([] as Connection[]).find((item) => item.alias === saved.alias)), "请重新打开连接");
  assert.equal(sshTestUnavailable(saved, saved, {}, "keep", { ...saved, config: { ...saved.config, host: "replacement.example.invalid" } }), "请重新打开连接");
  const reordered = { ...saved, config: Object.fromEntries(Object.entries(saved.config).reverse()) };
  assert.equal(sshTestUnavailable(saved, reordered, { password: "" }), "");
  assert.equal(saved.config.allowShell, false, "testing availability does not require remote command permission");
});

test("SSH test buttons cannot submit a form and never present another alias or revision's result", () => {
  const render = (extra = {}) => renderToStaticMarkup(React.createElement(SshConnectionTest, {
    connection: saved, unavailable: "", pending: false, onTest() {}, ...extra,
  }));
  assert.match(render(), /<button type="button">测试连接<\/button>/);
  assert.match(render({ pending: true }), /<button type="button" disabled="">测试中…<\/button>/);
  const disabled = render({ unavailable: "保存后测试" });
  assert.match(disabled, /<button type="button" disabled="">测试连接<\/button>/);
  assert.match(disabled, /保存后测试/);
  const result = { alias: saved.alias, revision: 4, success: true, message: "连接成功" };
  assert.match(render({ result }), /role="status">连接成功/);
  assert.doesNotMatch(render({ result: { ...result, alias: "SSH_OTHER" } }), /连接成功/);
  assert.doesNotMatch(render({ result: { ...result, revision: 3 } }), /连接成功/);
  assert.doesNotMatch(render({ result, unavailable: "保存后测试" }), /连接成功/);
  assert.match(render({ result: { ...result, success: false, message: "鉴权失败，请检查账号和凭据" } }), /role="alert">鉴权失败，请检查账号和凭据/);
});

test("SSH test failure labels use fixed causes without exposing raw server error content", () => {
  const secret = "synthetic-sensitive-diagnostic-18582";
  for (const [code, expected] of Object.entries({
    SSH_TEST_DNS: "无法解析服务器地址", SSH_TEST_CONNECT: "无法连接服务器，请检查地址和端口",
    SSH_TEST_AUTH: "鉴权失败，请检查账号和凭据",
    SSH_TEST_TIMEOUT: "连接测试超时", SSH_TEST_CANCELLED: "连接测试已取消",
    REVISION_CONFLICT: "连接已变化，请刷新后重试",
  })) assert.equal(sshTestError({ code, message: secret }), expected);
  for (const failure of [new Error(secret), { code: "OTHER", message: secret }, null, undefined]) {
    assert.equal(sshTestError(failure), "连接测试失败，请重试");
    assert.ok(!sshTestError(failure).includes(secret));
  }
});
