import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { learnPlatform } from "../src/learn.js";
import { mockUpstream, MOCK_BEARER, MOCK_HEADER } from "./mock-upstream.js";

// Manual mode prepares disposable data only. Open the printed address with the
// user's authorized Chrome control; this branch never launches a browser.
if (process.argv.includes("--manual")) {
  const { runManualFixture } = await import("./ui-manual-fixture.js");
  await runManualFixture();
  process.exit(0);
}

// Run only when browser access is permitted. Every connection, password, secret,
// server and store below is synthetic; this never opens the user's vault.
const testPassword = crypto.randomBytes(20).toString("base64url");
const execToken = "ui-mock-exec-capability-0000000002";
process.env.ABILOCK_ALLOW_LOCAL = "1";
process.env.ABILOCK_MOCK = "1";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-ui-"));
const store = new Store(dir, crypto.randomBytes(32).toString("hex"));
let mock: Awaited<ReturnType<typeof mockUpstream>> | undefined;
let service: Awaited<ReturnType<typeof startServers>> | undefined;
let browser: Browser | undefined;
const pageErrors: string[] = [];
const checks: string[] = [];
const cleanupErrors: unknown[] = [];
const fakeProvider = "https://provider.example";
const fakeDocumentationUrl = "https://docs.example/public-api";
const fakeManual =
  "POST /echo accepts native JSON. GET /slow is a synthetic slow response. POST /error500 returns a synthetic error.";
const keys = [MOCK_BEARER, MOCK_HEADER];

async function cli(args: string[], input?: unknown) {
  assert.ok(service);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["bin/abl.mjs", ...args], {
        env: {
          PATH: process.env.PATH,
          ABILOCK_ENDPOINT: service!.execUrl,
          ABILOCK_EXEC_TOKEN: execToken,
        },
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Synthetic CLI timed out"));
      }, 20000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    },
  );
}
function row(page: Page, alias: string) {
  return page.getByRole("row").filter({
    has: page.getByText(alias, { exact: true }),
  });
}
async function add(
  page: Page,
  alias: string,
  type: "bearer" | "header",
  key: string,
) {
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加", exact: true });
  await dialog.getByLabel("类型", { exact: true }).selectOption("api");
  await dialog.getByLabel("别名", { exact: true }).fill(alias);
  const note = alias === "UI_BEARER" ? "公司项目" : "个人账号";
  await dialog.getByLabel("备注", { exact: true }).fill(note);
  assert.equal(await dialog.getByLabel("备注", { exact: true }).getAttribute("maxlength"), "200");
  await dialog.getByLabel("地址", { exact: true }).fill(fakeProvider);
  await dialog.getByLabel("鉴权", { exact: true }).selectOption(type);
  if (type === "header")
    await dialog.getByLabel("字段名", { exact: true }).fill("X-API-Key");
  await dialog.getByLabel("密钥", { exact: true }).fill(key);
  await dialog
    .getByLabel("API 文档", { exact: true })
    .fill(fakeDocumentationUrl);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await row(page, alias).getByText("待整理", { exact: true }).waitFor();
  const platform = store.platform(alias);
  assert.equal(platform.name, alias);
  assert.equal(platform.note, note);
  await row(page, alias).getByText(note, { exact: true }).waitFor();
  assert.equal(platform.baseUrl, fakeProvider);
  assert.equal(platform.documentationUrl, fakeDocumentationUrl);
  assert.deepEqual(platform.rules, []);
  assert.ok(!platform.chat);
  assert.equal(store.unseal(platform.sealed!).value, key);
  checks.push(`${alias}: 简单表单保存固定连接与鉴权，未学习前没有接口权限`);
}
async function learn(alias: string) {
  const platform = store.platform(alias);
  const sealed = platform.sealed;
  const learned = await learnPlatform(store, alias, {
    expectedRevision: platform.revision,
    sourceUrl: fakeDocumentationUrl,
    title: "Synthetic API",
    markdown: fakeManual,
    description: "合成请求测试",
    rules: [
      { method: "POST", path: "/echo" },
      { method: "GET", path: "/slow" },
      { method: "POST", path: "/error500" },
    ],
    capabilityNotes: [
      {
        name: "测试",
        summary: "返回合成请求",
        tags: ["fixture"],
        input: "JSON body",
        output: "JSON response",
        method: "POST",
        path: "/echo",
      },
    ],
  });
  assert.equal(store.platform(alias).sealed, sealed);
  assert.deepEqual(learned.platform.auth, platform.auth);
  assert.equal(learned.platform.baseUrl, platform.baseUrl);
  const document = await cli(["doc", alias, "--json"]);
  assert.equal(document.code, 0, document.stderr);
  const result = JSON.parse(document.stdout);
  assert.equal(result.ok, true);
  assert.ok(
    result.data.docs.some((doc: { markdown: string }) =>
      doc.markdown.includes("POST /echo"),
    ),
  );
  for (const key of keys) assert.ok(!document.stdout.includes(key));
  checks.push(`${alias}: AI 学习公开fixture接口，CLI读取用法不含鉴权`);
}
async function readManual(page: Page, alias: string) {
  const navigation = page.getByRole("complementary", { name: "导航" });
  await navigation
    .getByRole("button")
    .filter({ has: page.getByText(alias, { exact: true }) })
    .click();
  const manual = page.locator(".manual-panel");
  await manual.getByRole("heading", { name: alias, exact: true }).waitFor();
  if (store.platform(alias).note)
    await manual.locator(".connection-summary").getByText(store.platform(alias).note!, { exact: true }).waitFor();
  assert.equal(
    await manual
      .getByRole("link", { name: "官方文档 ↗", exact: true })
      .getAttribute("href"),
    fakeDocumentationUrl,
  );
  assert.equal(
    await manual.locator(".manual-content").textContent(),
    fakeManual,
  );
  assert.equal(
    await manual.locator("input:not([readonly]), textarea, [contenteditable=true]").count(),
    0,
  );
  assert.equal(
    await manual.getByRole("button", { name: "保存", exact: true }).count(),
    0,
  );
  assert.equal(
    await manual.getByRole("button", { name: "删除", exact: true }).count(),
    0,
  );
  for (const key of keys)
    assert.ok(!(await manual.textContent())?.includes(key));
  await manual.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("heading", { name: "连接", exact: true }).waitFor();
  checks.push(
    `${alias}: 左栏展示与 CLI 相同的只读手册，官方链接保留且不显示密钥`,
  );
}
async function updateMockSecret(page: Page, alias: string, key: string) {
  await row(page, alias)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "编辑", exact: true });
  assert.equal(
    await dialog.getByLabel("密钥", { exact: true }).inputValue(),
    "",
  );
  await dialog.getByLabel("密钥", { exact: true }).fill(key);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(store.unseal(store.platform(alias).sealed!).value, key);
  await learn(alias);
  const response = await cli(["call", alias, "--stdin", "--json"], {
    method: "POST",
    path: "/echo",
    body: {
      native: { text: "界面配置后的合成调用", array: [1, 2] },
      temperature: 0.3,
    },
  });
  assert.equal(response.code, 0, response.stderr);
  const envelope = JSON.parse(response.stdout);
  assert.equal(envelope.data.body.native.text, "界面配置后的合成调用");
  assert.equal(envelope.data.body.temperature, 0.3);
  assert.equal(envelope.data.authApplied, true);
  for (const value of keys) assert.ok(!response.stdout.includes(value));
  checks.push(`${alias}: UI只写鉴权，CLI调用loopback fixture并脱敏`);
}

async function checkSshTestControls(page: Page) {
  // UI responses are synthetic. This does not establish a real SSH session.
  let calls = 0;
  let respond!: (value: { status: number; body: unknown }) => void;
  let arrived!: () => void;
  const nextRequest = () => new Promise<void>((resolve) => { arrived = resolve; });
  const plan = () => ({ alias: "UI_SSH", revision: store.connection("ssh", "UI_SSH").revision,
    kind: "ssh", supported: true, provider: "SSH", method: "SSH handshake", path: null,
    level: "authentication", billing: "none", model: null,
    message: "核对主机指纹并验证登录，不执行远端命令。" });
  const result = () => ({ ...plan(), status: "verified", success: true,
    message: "主机指纹与登录鉴权已通过；未运行命令或文件操作。", durationMs: 12 });
  await page.route("**/admin/connections/UI_SSH/test-plan", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(plan()),
  }));
  await page.route("**/admin/connections/UI_SSH/connection-test", async (route) => {
    calls++;
    assert.equal(route.request().method(), "POST");
    assert.deepEqual(route.request().postDataJSON(), { expectedRevision: store.connection("ssh", "UI_SSH").revision });
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => { respond = resolve; });
    arrived();
    const response = await pending;
    try { await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) }); }
    catch { /* A cancelled browser request has no response recipient. */ }
  });
  const ssh = row(page, "UI_SSH");
  const button = ssh.getByRole("button", { name: "测试连接", exact: true });
  assert.equal(await row(page, "UI_BEARER").getByRole("button", { name: "测试连接", exact: true }).count(), 1);
  let request = nextRequest();
  await button.click();
  await request;
  assert.equal(await ssh.getByRole("button", { name: "测试中…", exact: true }).isDisabled(), true);
  assert.equal(calls, 1);
  respond({ status: 200, body: result() });
  await page.locator(".connection-row-feedback").getByText("鉴权通过", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator(".connection-row-feedback").waitFor({ state: "hidden" });

  await ssh.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑", exact: true });
  const test = edit.getByRole("button", { name: "测试连接", exact: true });
  assert.equal(await test.isEnabled(), true);
  await edit.getByLabel("备注", { exact: true }).fill("Changed unsaved note");
  assert.equal(await test.isDisabled(), true);
  await edit.getByText("保存后测试", { exact: true }).waitFor();
  await edit.getByLabel("备注", { exact: true }).fill("合成连接");
  await edit.getByLabel("鉴权", { exact: true }).selectOption("password");
  await edit.getByLabel("密码", { exact: true }).fill("synthetic-unsaved-ui-password");
  assert.equal(await test.isDisabled(), true);
  assert.equal(calls, 1, "unsaved credentials must not start a saved-connection probe");
  await edit.getByLabel("鉴权", { exact: true }).selectOption("keep");
  assert.equal(await test.isEnabled(), true);
  request = nextRequest();
  await test.click();
  await request;
  respond({ status: 401, body: { error: { code: "CONNECTION_TEST_AUTH", message: "synthetic-private-diagnostic" } } });
  await edit.getByRole("alert").getByText("鉴权失败，请检查账号和凭据", { exact: true }).waitFor();
  assert.ok(!(await edit.textContent())?.includes("synthetic-private-diagnostic"));
  await edit.locator(".test-result").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/ui-2.2.11/ssh-error.png", fullPage: true, animations: "disabled" });
  await edit.getByLabel("主机", { exact: true }).fill("other.example.invalid");
  assert.equal(await edit.getByRole("alert").count(), 0);
  await edit.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.locator(".connection-row-feedback").count(), 0);

  await ssh.getByRole("button", { name: "编辑", exact: true }).click();
  request = nextRequest();
  await test.click();
  await request;
  await edit.getByRole("button", { name: "取消测试", exact: true }).click();
  await edit.getByText("已取消", { exact: true }).waitFor();
  respond({ status: 200, body: result() });
  assert.equal(await edit.getByText("鉴权通过", { exact: true }).count(), 0);
  await edit.getByRole("button", { name: "关闭", exact: true }).click();
  request = nextRequest();
  await button.click();
  await request;
  await ssh.getByRole("button", { name: "UI_SSH", exact: true }).click();
  respond({ status: 200, body: result() });
  await page.locator(".manual-panel h1").filter({ hasText: "UI_SSH" }).waitFor();
  await page.locator(".manual-panel").getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.locator(".connection-row-feedback").count(), 0);
  assert.equal(store.connection("ssh", "UI_SSH").revision, 1, "probing and cancelling never save a connection");
  await page.unroute("**/admin/connections/UI_SSH/test-plan");
  await page.unroute("**/admin/connections/UI_SSH/connection-test");
  checks.push("统一测试：防重复、草稿禁用、错误脱敏、显式取消、导航返回不保留旧结果（合成 UI 响应）");
}

async function checkApiTestControls(page: Page) {
  const apiRow = row(page, "UI_BEARER");
  await apiRow.getByRole("button", { name: "测试连接", exact: true }).click();
  await page.locator(".connection-row-feedback").getByText("尚未验证", { exact: true }).waitFor();
  assert.equal(mock!.calls.length, 0, "unknown provider test must not contact the upstream");
  await page.locator(".toast").waitFor({ state: "hidden" });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "artifacts/ui-2.2.11/connections-light.png", fullPage: true, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "artifacts/ui-2.2.11/connections-dark.png", fullPage: true, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await apiRow.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑", exact: true });
  assert.equal(await edit.getByRole("button", { name: "测试连接", exact: true }).isEnabled(), true);
  await edit.getByLabel("密钥", { exact: true }).fill("synthetic-unsaved-api-secret");
  assert.equal(await edit.getByRole("button", { name: "测试连接", exact: true }).isDisabled(), true);
  await edit.getByLabel("密钥", { exact: true }).fill("");
  await page.screenshot({ path: "artifacts/ui-2.2.11/api-editor.png", fullPage: true, animations: "disabled" });
  await edit.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("API 列表和编辑器均提供测试；未知提供商只说明未验证，不发送请求，未保存密钥禁用测试");
}

async function checkRequestCostConfirmation(page: Page) {
  await store.saveConnection({
    alias: "UI_STORAGE", name: "UI_STORAGE", kind: "s3", enabled: true,
    description: "Synthetic only", trustBoundary: "independent-target",
    config: { provider: "s3", endpoint: "https://storage.example.invalid", region: "us-east-1",
      bucket: "synthetic-bucket", prefix: "fixture/" },
  }, { accessKeyId: "synthetic-ui-access", secretAccessKey: "synthetic-ui-storage-key" }, false, 0);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  let calls = 0;
  await page.route("**/admin/connections/UI_STORAGE/connection-test", (route) => {
    calls++;
    assert.deepEqual(route.request().postDataJSON(), { expectedRevision: 1, allowBillable: true });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      alias: "UI_STORAGE", revision: 1, status: "reachable", success: true,
      message: "合成只读响应通过；未进行真实存储请求。", durationMs: 10,
    }) });
  });
  await row(page, "UI_STORAGE").getByRole("button", { name: "测试连接", exact: true }).click();
  await page.getByText("等待确认", { exact: true }).waitFor();
  assert.equal(calls, 0, "possible request fees must require a distinct user confirmation");
  await page.getByRole("button", { name: "确认测试（可能产生请求费）", exact: true }).click();
  await page.getByText("服务已响应", { exact: true }).waitFor();
  assert.equal(calls, 1);
  assert.equal(await page.getByText("鉴权通过", { exact: true }).count(), 0);
  await page.unroute("**/admin/connections/UI_STORAGE/connection-test");
  await store.removeConnection("UI_STORAGE", 1);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  checks.push("可能产生请求费的存储测试需单独确认，确认前零请求、确认后一次合成请求；服务响应不冒充鉴权通过");
}

async function checkPasswordCapsLockHint(page: Page) {
  const password = page.getByLabel("管理密码", { exact: true });
  const hint = password.locator("..").locator(".password-keyboard-hint");
  await password.fill("synthetic-password-display-only");
  const before = await password.inputValue();
  await password.dispatchEvent("keydown", { key: "CapsLock", modifierCapsLock: true });
  await hint.getByText("大写锁定已开启（Caps Lock）", { exact: true }).waitFor();
  assert.ok(await password.getAttribute("aria-describedby"));
  assert.equal(await password.getAttribute("type"), "password");
  assert.equal(await password.inputValue(), before);
  await page.screenshot({ path: "artifacts/feedback-2.2.11/login-caps-lock-light.png", fullPage: true, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "artifacts/feedback-2.2.11/login-caps-lock-dark.png", fullPage: true, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await password.dispatchEvent("keyup", { key: "CapsLock", modifierCapsLock: false });
  await hint.waitFor({ state: "hidden" });
  await password.dispatchEvent("keydown", { key: "CapsLock", modifierCapsLock: true });
  await hint.waitFor();
  await page.getByRole("button", { name: "登录", exact: true }).focus();
  await hint.waitFor({ state: "hidden" });
  assert.equal(await password.inputValue(), before);
  assert.equal(await password.getAttribute("type"), "password");
  await password.fill("");
  checks.push("合成键盘事件验证大写锁定中文提示、关闭与失焦清除，密码不改变或明文显示；Chrome不代表WebKit原生图标已验收");
}

async function checkDoubaoGenerationConfirmation(page: Page) {
  const alias = "UI_DOUBAO";
  const mini = "doubao-seed-2-0-mini-260428";
  const lite = "doubao-seed-2-0-lite-260428";
  const upstreamCallsBefore = mock!.calls.length;
  await store.save({
    alias, name: alias, note: "仅合成界面测试", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: { type: "bearer" }, rules: [], enabled: true, allowInsecureLocal: false, description: "",
  }, { value: "synthetic-doubao-ui-key-never-sent" }, false, 0);
  const saved = structuredClone(store.platform(alias));
  let calls = 0;
  let expectedModel = mini;
  let respond!: (value: { status: number; body: unknown }) => void;
  let arrived!: () => void;
  const nextRequest = () => new Promise<void>((resolve) => { arrived = resolve; });
  // The generation endpoint is intercepted before any test click. Only the
  // local server's no-network plan route runs; no official API receives a key.
  await page.route(`**/admin/platforms/${alias}/connection-test`, async (route) => {
    calls++;
    assert.equal(route.request().method(), "POST");
    assert.deepEqual(route.request().postDataJSON(), {
      expectedRevision: saved.revision, allowBillable: true, model: expectedModel,
    });
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => { respond = resolve; });
    arrived();
    const response = await pending;
    try { await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) }); }
    catch { /* Cancelled requests cannot receive their synthetic response. */ }
  });
  const result = () => ({ alias, revision: saved.revision, kind: "api", status: "verified", success: true,
    model: expectedModel, level: "generation", billing: "possible",
    message: "合成模型响应通过；未向真实服务发送请求。", durationMs: 12 });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "搜索连接", exact: true });
  await search.fill(alias);
  const apiRow = row(page, alias);
  const test = apiRow.getByRole("button", { name: "测试连接", exact: true });
  const feedback = page.locator(".connection-row-feedback");
  const selection = feedback.getByLabel("测试模型", { exact: true });
  const confirm = feedback.getByRole("button", { name: "确认模型测试（可能计费）", exact: true });
  const openPlan = async () => {
    await test.click();
    await feedback.getByText("等待确认", { exact: true }).waitFor();
    assert.equal(await selection.inputValue(), "", "each new test starts without a selected model");
    assert.equal(await confirm.isDisabled(), true);
  };
  await openPlan();
  assert.equal(calls, 0, "reading a plan does not send a generation request");
  await selection.selectOption(mini);
  assert.equal(await confirm.isEnabled(), true);
  const description = await feedback.textContent();
  assert.ok(description?.includes(mini));
  assert.ok(description?.includes("16"));
  assert.ok(description?.includes("0.2"));
  assert.equal(calls, 0, "choosing a model does not grant generation consent");
  await page.screenshot({ path: "artifacts/feedback-2.2.11/doubao-model-confirmation.png", fullPage: true, animations: "disabled" });
  let request = nextRequest();
  await confirm.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await request;
  assert.equal(calls, 1, "duplicate confirmation clicks must send only one synthetic request");
  assert.equal(await apiRow.getByRole("button", { name: "测试中…", exact: true }).isDisabled(), true);
  respond({ status: 200, body: result() });
  await feedback.getByText("合成模型响应通过；未向真实服务发送请求。", { exact: true }).waitFor();
  assert.equal(calls, 1);

  await openPlan();
  await selection.selectOption(lite);
  expectedModel = lite;
  request = nextRequest();
  await confirm.click();
  await request;
  await apiRow.getByRole("button", { name: "取消测试", exact: true }).click();
  await feedback.getByText("已取消", { exact: true }).waitFor();
  respond({ status: 200, body: result() });
  assert.equal(await feedback.getByText("合成模型响应通过；未向真实服务发送请求。", { exact: true }).count(), 0);
  assert.equal(calls, 2, "cancellation must not retry a possibly accepted generation");

  await openPlan();
  await selection.selectOption(mini);
  await apiRow.getByRole("button", { name: alias, exact: true }).click();
  await page.locator(".manual-panel h1").filter({ hasText: alias }).waitFor();
  await page.locator(".manual-panel").getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await feedback.count(), 0);
  assert.equal(calls, 2, "navigation from an unconfirmed plan sends no generation request");
  await openPlan();
  await selection.selectOption(mini);
  expectedModel = mini;
  request = nextRequest();
  await confirm.click();
  await request;
  respond({ status: 403, body: { error: { code: "CONNECTION_TEST_MODEL_PERMISSION", message: "synthetic-private-provider-detail" } } });
  await feedback.getByRole("alert").waitFor();
  assert.ok((await feedback.textContent())?.includes("所选模型未开通"));
  assert.ok(!(await feedback.textContent())?.includes("synthetic-private-provider-detail"));
  assert.equal(await feedback.getByText("鉴权通过", { exact: true }).count(), 0);
  await page.screenshot({ path: "artifacts/feedback-2.2.11/doubao-model-permission.png", fullPage: true, animations: "disabled" });
  assert.equal(calls, 3);
  assert.equal(mock!.calls.length, upstreamCallsBefore);
  assert.deepEqual(store.platform(alias), saved, "test and cancel controls cannot save a model choice or modify credentials");
  await page.unroute(`**/admin/platforms/${alias}/connection-test`);
  await store.remove(alias, saved.revision);
  await search.fill("");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  checks.push("豆包合成界面：明确选择模型和计费确认前零请求，确认一次、防重复、取消不重试、导航返回清空选择、权限错误脱敏；无真实鉴权或生成");
}

try {
  await fs.mkdir("artifacts/ui-2.2.11", { recursive: true });
  await fs.mkdir("artifacts/feedback-2.2.11", { recursive: true });
  await store.init();
  mock = await mockUpstream();
  // HTTP loopback permission is fixture metadata. It is not a form field or a
  // user default, and no real service receives any test request.
  for (const [alias, type] of [
    ["MOCK_BEARER", "bearer"],
    ["MOCK_HEADER", "header"],
  ] as const) {
    await store.save(
      {
        alias,
        name: alias,
        baseUrl: mock.url,
        auth: { type, ...(type === "header" ? { name: "X-API-Key" } : {}) },
        rules: [],
        enabled: true,
        allowInsecureLocal: true,
        description: "",
      },
      { value: "previous-synthetic-secret" },
      false,
      0,
    );
  }
  await store.saveConnection({
    alias: "UI_SSH", note: "合成连接", name: "UI_SSH", kind: "ssh", enabled: true,
    description: "仅验证界面，所有测试响应由浏览器合成。", trustBoundary: "independent-target",
    config: { host: "ssh.example.invalid", port: 22, username: "fixture",
      remoteRoot: "/", allowShell: false, fileAccess: "read" },
  }, { password: "synthetic-saved-ui-password" }, false, 0);
  service = await startServers({
    store,
    execToken,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: () => {},
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ABILOCK_BROWSER_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(service.adminUrl);
  await page.getByLabel("管理密码", { exact: true }).fill("1234567");
  await page.getByLabel("确认密码", { exact: true }).fill("1234567");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.ok((await page.getByRole("alert").textContent())?.includes("8"));
  checks.push("首次密码无默认值，7字符被拒绝");
  await page.getByLabel("管理密码", { exact: true }).fill(testPassword);
  await page.getByLabel("确认密码", { exact: true }).fill(testPassword);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("heading", { name: "连接", exact: true }).waitFor();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByRole("heading", { name: "登录", exact: true }).waitFor();
  await checkPasswordCapsLockHint(page);
  await page.getByLabel("管理密码", { exact: true }).fill(testPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "连接", exact: true }).waitFor();

  await add(page, "UI_BEARER", "bearer", MOCK_BEARER);
  await add(page, "UI_HEADER", "header", MOCK_HEADER);
  await checkSshTestControls(page);
  await checkApiTestControls(page);
  await checkRequestCostConfirmation(page);
  await checkDoubaoGenerationConfirmation(page);
  await learn("UI_BEARER");
  await learn("UI_HEADER");
  const catalogue = await cli(["list", "--json"]);
  assert.equal(catalogue.code, 0, catalogue.stderr);
  assert.equal(JSON.parse(catalogue.stdout).ok, true);
  for (const key of keys) assert.ok(!catalogue.stdout.includes(key));
  await page.reload();
  await row(page, "UI_BEARER").getByText("已配置", { exact: true }).waitFor();
  const search = page.getByRole("searchbox", { name: "搜索连接", exact: true });
  await search.fill("公司项目");
  await row(page, "UI_BEARER").waitFor();
  assert.equal(await row(page, "UI_HEADER").count(), 0);
  const navigation = page.getByRole("complementary", { name: "导航" });
  await navigation.getByText("公司项目", { exact: true }).waitFor();
  assert.equal(await navigation.getByText("UI_HEADER", { exact: true }).count(), 0);
  await search.fill("");
  checks.push("备注在列表和侧栏显示，搜索备注可区分相同平台连接");
  await readManual(page, "UI_BEARER");
  checks.push("AI学习后连接可用，CLI目录不含秘密");

  await row(page, "UI_BEARER")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "编辑", exact: true });
  assert.equal(await edit.getByLabel("密钥", { exact: true }).inputValue(), "");
  assert.equal(await edit.locator('input:not([type="checkbox"])').count(), 5);
  assert.equal(await edit.getByLabel("备注", { exact: true }).inputValue(), "公司项目");
  assert.equal(
    await edit.getByLabel("API 文档", { exact: true }).inputValue(),
    fakeDocumentationUrl,
  );
  assert.equal(await edit.locator("textarea").count(), 0);
  await edit
    .getByLabel("密钥", { exact: true })
    .fill("cancelled-synthetic-key");
  await edit.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(
    store.unseal(store.platform("UI_BEARER").sealed!).value,
    MOCK_BEARER,
  );
  await row(page, "UI_BEARER")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  assert.equal(await edit.getByLabel("密钥", { exact: true }).inputValue(), "");
  const before = store.platform("UI_BEARER");
  await edit.getByLabel("备注", { exact: true }).fill("公司文案");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const after = store.platform("UI_BEARER");
  assert.equal(after.sealed, before.sealed);
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(after.capabilityNotes, before.capabilityNotes);
  assert.equal(after.documentationUrl, fakeDocumentationUrl);
  assert.equal(after.note, "公司文案");
  assert.equal(after.alias, before.alias);
  assert.deepEqual(after.auth, before.auth);
  checks.push("关闭清空输入，留空保存保留鉴权及AI用法");

  await row(page, "UI_BEARER")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "编辑", exact: true });
  assert.equal(
    await rename.getByLabel("别名", { exact: true }).isEnabled(),
    true,
  );
  await rename.getByLabel("别名", { exact: true }).fill("UI_HEADER");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await rename.getByRole("alert").waitFor();
  assert.equal(store.platform("UI_BEARER").sealed, after.sealed);
  assert.equal(store.platform("UI_HEADER").alias, "UI_HEADER");
  await rename.getByLabel("别名", { exact: true }).fill("UI_RENAMED");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await rename.waitFor({ state: "hidden" });
  await row(page, "UI_RENAMED").waitFor();
  assert.equal(await row(page, "UI_BEARER").count(), 0);
  const renamed = store.platform("UI_RENAMED");
  assert.equal(renamed.sealed, after.sealed);
  assert.deepEqual(renamed.rules, after.rules);
  assert.deepEqual(renamed.capabilityNotes, after.capabilityNotes);
  assert.equal(renamed.documentationUrl, fakeDocumentationUrl);
  const renamedUsage = await cli(["doc", "UI_RENAMED", "--json"]);
  assert.equal(renamedUsage.code, 0, renamedUsage.stderr);
  assert.ok(JSON.parse(renamedUsage.stdout).data.docs.length);
  checks.push("别名可编辑，重名不覆盖，改名后密钥及用法保留");
  await readManual(page, "UI_RENAMED");

  await page.getByRole("button", { name: "添加", exact: true }).click();
  const duplicate = page.getByRole("dialog", { name: "添加", exact: true });
  await duplicate.getByLabel("别名", { exact: true }).fill("UI_RENAMED");
  await duplicate.getByLabel("地址", { exact: true }).fill(fakeProvider);
  await duplicate
    .getByLabel("密钥", { exact: true })
    .fill("duplicate-synthetic-key");
  await duplicate.getByRole("button", { name: "保存", exact: true }).click();
  await duplicate.getByRole("alert").waitFor();
  assert.ok(
    (await duplicate.getByRole("alert").textContent())?.includes("重新载入"),
  );
  assert.equal(
    store.unseal(store.platform("UI_RENAMED").sealed!).value,
    MOCK_BEARER,
  );
  await duplicate.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("重复新增不覆盖连接");

  await updateMockSecret(page, "MOCK_BEARER", MOCK_BEARER);
  await updateMockSecret(page, "MOCK_HEADER", MOCK_HEADER);
  const failure = await cli(["call", "MOCK_BEARER", "--stdin", "--json"], {
    method: "POST",
    path: "/error500",
  });
  assert.notEqual(failure.code, 0);
  for (const key of keys) assert.ok(!failure.stdout.includes(key));
  checks.push("合成上游错误不回显鉴权");
  assert.equal(mock.calls.filter((call) => call.path === "/echo").length, 2);
  assert.equal(
    mock.calls.filter((call) => call.path === "/echo")[0].headers.authorization,
    `Bearer ${MOCK_BEARER}`,
  );
  assert.equal(
    mock.calls.filter((call) => call.path === "/echo")[1].headers["x-api-key"],
    MOCK_HEADER,
  );

  await row(page, "UI_HEADER")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const header = page.getByRole("dialog", { name: "编辑", exact: true });
  await header
    .getByLabel("地址", { exact: true })
    .fill("https://replacement.example");
  await header.getByRole("button", { name: "保存", exact: true }).click();
  await header.waitFor({ state: "hidden" });
  assert.deepEqual(store.platform("UI_HEADER").rules, []);
  assert.deepEqual(store.platform("UI_HEADER").capabilityNotes ?? [], []);
  await row(page, "UI_HEADER").getByText("待整理", { exact: true }).waitFor();
  checks.push("用户修改地址后旧AI用法失效，需重新学习");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.locator(".toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "artifacts/ui-2.2.11/connections-mobile.png", fullPage: true, animations: "disabled" });
  checks.push("移动页面无横向溢出，测试按钮及反馈可见");
  assert.equal(pageErrors.length, 0);
  assert.equal(mock.calls.filter((call) => call.path === "/echo").length, 2);
} finally {
  for (const close of [
    () => browser?.close(),
    () => service?.close(),
    () => mock?.close(),
    () => store.close(),
    () => fs.rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}
if (cleanupErrors.length)
  throw new AggregateError(
    cleanupErrors,
    "Synthetic UI fixture cleanup failed",
  );

// Evidence follows both a completed authorized browser run and full cleanup.
// A capture or prewritten result never substitutes for browser verification.
await fs.writeFile(
  "artifacts/ui-validation.json",
  JSON.stringify(
    {
      ok: true,
      checkedAt: new Date().toISOString(),
      browser: "local Google Chrome, Playwright headless",
      checks,
      pageErrors,
      realCredentialsUsed: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ ok: true, checks }, null, 2));
