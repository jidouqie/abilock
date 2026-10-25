import { test, before, after, mock as testMock } from "node:test";
import dns from "node:dns/promises";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { platformSchema, type Platform, type Call } from "../src/schema.js";
import { Redactor, publicAddress } from "../src/security.js";
import { registerAdapter, adapters } from "../src/adapters.js";
import {
  mockUpstream,
  MOCK_BEARER,
  MOCK_HEADER,
  MOCK_QUERY,
  MOCK_USERNAME,
  MOCK_PASSWORD,
} from "../scripts/mock-upstream.js";
const ADMIN = "test-admin-capability-000000000001",
  EXEC = "test-exec-capability-0000000000002",
  master = crypto.randomBytes(32).toString("hex");
let dir: string,
  store: Store,
  servers: Awaited<ReturnType<typeof startServers>>,
  mock: Awaited<ReturnType<typeof mockUpstream>>;
const logs: Record<string, unknown>[] = [];
const keys = [
  MOCK_BEARER,
  MOCK_HEADER,
  MOCK_QUERY,
  MOCK_USERNAME,
  MOCK_PASSWORD,
  ADMIN,
  EXEC,
  master,
];
before(async () => {
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  process.env.ABILOCK_MOCK = "1";
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-test-"));
  store = new Store(dir, master);
  await store.init();
  mock = await mockUpstream();
  servers = await startServers({
    store,
    adminToken: ADMIN,
    execToken: EXEC,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: (r) => logs.push(r),
  });
});
after(async () => {
  await servers?.close();
  await mock?.close();
  await store?.close();
  await fs.rm(dir, { recursive: true, force: true });
});
async function api(
  base: string,
  route: string,
  token: string,
  method = "GET",
  value?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(base + route, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(value ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    body: value ? JSON.stringify(value) : undefined,
    redirect: "manual",
  });
}
const p = (alias: string, auth: Platform["auth"]): Platform =>
  platformSchema.parse({
    alias,
    name: `平台 ${alias}`,
    baseUrl: mock.url,
    allowInsecureLocal: true,
    auth,
    rules: [
      { method: "POST", path: "/echo" },
      { method: "POST", path: "/require-auth" },
      { method: "POST", path: "/error401" },
      { method: "POST", path: "/error500" },
      { method: "POST", path: "/tasks" },
      { method: "GET", path: "/tasks/*" },
      ...[
        "/stream",
        "/binary",
        "/slow",
        "/redirect",
        "/redirect-downgrade",
        "/header-leak",
      ].map((path) => ({ method: "GET", path })),
    ],
  });
async function save(platform: Platform, secret?: unknown, revision = 0) {
  return api(
    servers.adminUrl,
    `/admin/platforms/${platform.alias}`,
    ADMIN,
    "PUT",
    { platform, secret, expectedRevision: revision },
  );
}
async function call(
  alias: string,
  data: Partial<Call>,
  extra: Record<string, string> = {},
) {
  return api(servers.execUrl, `/v1/call/${alias}`, EXEC, "POST", data, extra);
}
function clean(text: string) {
  for (const key of keys) {
    assert(!text.includes(key), `secret leaked`);
    assert(!text.includes(encodeURIComponent(key)));
    assert(!text.includes(Buffer.from(key).toString("base64")));
  }
  assert(
    !text.includes(Buffer.from(`Bearer ${MOCK_BEARER}`).toString("base64")),
  );
}
async function cli(args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["bin/abl.mjs", ...args], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          ABILOCK_ENDPOINT: servers.execUrl,
          ABILOCK_EXEC_TOKEN: EXEC,
        },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}

test("UI 管理写入五种鉴权；普通 REST 新增无需改代码", async () => {
  const configs: [string, Platform["auth"], unknown][] = [
    ["BEARER", { type: "bearer" }, { value: MOCK_BEARER }],
    ["HEADER", { type: "header", name: "X-API-Key" }, { value: MOCK_HEADER }],
    ["QUERY", { type: "query", name: "api_key" }, { value: MOCK_QUERY }],
    [
      "BASIC",
      { type: "basic" },
      { username: MOCK_USERNAME, password: MOCK_PASSWORD },
    ],
    ["NONE", { type: "none" }, undefined],
  ];
  for (const [alias, auth, secret] of configs) {
    const res = await save(p(alias, auth), secret);
    assert.equal(res.status, 200);
    clean(await res.text());
    const out = await call(alias, {
      method: "POST",
      path: "/echo",
      body: { native: { unchanged: true } },
    });
    assert.equal(out.status, 200);
    const text = await out.text();
    clean(text);
    assert.deepEqual(JSON.parse(text).body, { native: { unchanged: true } });
  }
  const authRows = mock.calls.filter((x) => x.path.startsWith("/echo"));
  assert.equal(authRows[0].headers.authorization, `Bearer ${MOCK_BEARER}`);
  assert.equal(authRows[1].headers["x-api-key"], MOCK_HEADER);
  assert(authRows[2].path.includes(encodeURIComponent(MOCK_QUERY)));
  assert.equal(
    authRows[3].headers.authorization,
    `Basic ${Buffer.from(`${MOCK_USERNAME}:${MOCK_PASSWORD}`).toString("base64")}`,
  );
  assert.equal(authRows[4].headers.authorization, undefined);
});
test("存储加密、重启恢复、主密钥错误不覆盖；同目录写事务合并并刷新", async () => {
  const disk = await fs.readFile(path.join(dir, "state.json"), "utf8");
  clean(disk);
  assert(disk.includes("sealed"));
  const second = new Store(dir, master, [ADMIN, EXEC]);
  await second.init();
  try {
    await Promise.all([
      store.save(p("TRANSACTION_A", { type: "none" }), undefined, false, 0),
      second.save(p("TRANSACTION_B", { type: "none" }), undefined, false, 0),
    ]);
    await Promise.all([store.refresh(), second.refresh()]);
    for (const current of [store, second]) {
      assert.equal(current.platform("TRANSACTION_A").revision, 1);
      assert.equal(current.platform("TRANSACTION_B").revision, 1);
      assert.equal(current.list().length, 7);
    }
    await Promise.all([
      store.remove("TRANSACTION_A", 1), second.remove("TRANSACTION_B", 1),
    ]);
    await store.refresh();
    assert.equal(store.list().length, 5);
  } finally { await second.close(); }
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-restart-"));
  await fs.writeFile(path.join(copy, "state.json"), disk);
  const reopened = new Store(copy, master);
  await reopened.init();
  assert.equal(reopened.list().length, 5);
  assert.equal(
    reopened.unseal(reopened.platform("BEARER").sealed!).value,
    MOCK_BEARER,
  );
  await reopened.close();
  const wrong = new Store(copy, "0".repeat(64));
  await assert.rejects(() => wrong.init(), /主密钥/);
  assert.equal(await fs.readFile(path.join(copy, "state.json"), "utf8"), disk);
  await fs.rm(copy, { recursive: true, force: true });
});
test("管理与执行角色互斥；执行端无管理/秘密读取路由；跨源阻止", async () => {
  for (const [base, route, token, status] of [
    [servers.adminUrl, "/admin/platforms", EXEC, 401],
    [servers.execUrl, "/v1/platforms", ADMIN, 401],
    [servers.execUrl, "/admin/platforms", EXEC, 404],
    [servers.execUrl, "/v1/secrets", EXEC, 404],
  ] as const) {
    const res = await api(base, route, token);
    assert.equal(res.status, status);
    clean(await res.text());
  }
  const cross = await api(
    servers.adminUrl,
    "/admin/platforms",
    ADMIN,
    "GET",
    undefined,
    { origin: "https://attacker.example" },
  );
  assert.equal(cross.status, 403);
  const exCross = await api(
    servers.execUrl,
    "/v1/platforms",
    EXEC,
    "GET",
    undefined,
    { origin: servers.execUrl },
  );
  assert.equal(exCross.status, 403);
  const pub = await api(servers.execUrl, "/v1/platforms", EXEC);
  const text = await pub.text();
  clean(text);
  assert(!text.includes("sealed"));
  assert(!text.includes("username"));
  assert(JSON.parse(text).platforms[0].hasSecret);
});
test("拒绝绝对/双斜线/反斜线/编码/穿越路径及非白名单方法", async () => {
  const before = mock.calls.length;
  for (const path of [
    "https://example.com/echo",
    "//example.com/echo",
    "/\\example.com/echo",
    "/../echo",
    "/x/../echo",
    "/%2e%2e/echo",
    "/%252e%252e/echo",
    "/%2f%2fevil/echo",
    "/echo?target=https://evil",
    "/echo#x",
    "/echo//x",
  ]) {
    const res = await call("BEARER", { method: "POST", path });
    assert.equal(res.status, 400, path);
    clean(await res.text());
  }
  assert.equal(
    (await call("BEARER", { method: "DELETE", path: "/echo" })).status,
    403,
  );
  assert.equal(mock.calls.length, before);
});
test("禁止 Host、重复大小写鉴权头、Header/query 冲突与未知目标字段", async () => {
  const before = mock.calls.length;
  for (const headers of [
    { Host: "example.com" },
    { Authorization: "override" },
    { authorization: "a", Authorization: "b" },
    { "X-API-KEY": "override" },
    { "x-forwarded-host": "evil" },
    { "X-Custom": "a", "x-custom": "b" },
    { "Content-Length": "1" },
    { Cookie: "secret" },
  ] as Record<string, string>[]) {
    const res = await call("HEADER", {
      method: "POST",
      path: "/echo",
      headers,
    });
    assert.equal(res.status, 400);
    clean(await res.text());
  }
  for (const query of [
    { api_key: "override" },
    { API_KEY: "override" },
  ] as Record<string, string>[])
    assert.equal(
      (await call("QUERY", { method: "POST", path: "/echo", query })).status,
      400,
    );
  assert.equal(
    (
      await call("BEARER", {
        method: "POST",
        path: "/echo",
        baseUrl: "https://evil",
      } as Partial<Call>)
    ).status,
    400,
  );
  assert.equal(mock.calls.length, before);
});
test("SSRF / 私网 / metadata / URL 凭据配置拒绝与安全校验无回显", async () => {
  for (const baseUrl of [
    "http://example.com",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://localhost",
    "https://10.0.0.1",
    `https://${MOCK_BEARER}@example.com`,
    "https://example.com/?key=x",
    "https://example.com/%2e",
  ]) {
    const res = await save(
      {
        ...p("INVALID", { type: "bearer" }),
        baseUrl,
        allowInsecureLocal: false,
      },
      { value: MOCK_BEARER },
    );
    assert.equal(res.status, 400);
    clean(await res.text());
  }
  assert(!publicAddress("127.0.0.1"));
  assert(!publicAddress("192.168.0.1"));
  assert(!publicAddress("::ffff:169.254.169.254"));
  assert(publicAddress("8.8.8.8"));
  const res = await save(
    { ...p("BAD", { type: "bearer" }), name: 123 } as unknown as Platform,
    { value: MOCK_BEARER },
  );
  assert.equal(res.status, 400);
  clean(await res.text());
});
test("每次 DNS 解析拒绝私网与公网/私网混合结果，不建立上游连接", async () => {
  const before = mock.calls.length;
  const config = {
    ...p("DNS", { type: "none" }),
    baseUrl: "https://example.invalid",
    allowInsecureLocal: false,
  };
  assert.equal((await save(config)).status, 200);
  for (const rows of [
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
  ]) {
    const spy = testMock.method(dns, "lookup", async () => rows);
    try {
      const res = await call("DNS", { method: "POST", path: "/echo" });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "PRIVATE_TARGET");
      assert.equal(spy.mock.calls.length, 1);
    } finally {
      spy.mock.restore();
    }
  }
  assert.equal(mock.calls.length, before);
});
test("跨域及降级重定向不跟随，任何方法不自动重试", async () => {
  const before = mock.calls.length;
  for (const path of ["/redirect", "/redirect-downgrade"]) {
    const res = await call("BEARER", { method: "GET", path });
    assert.equal(res.status, 502);
    assert(!res.headers.has("location"));
    clean(await res.text());
  }
  assert.equal(mock.calls.length, before + 2);
  const count = mock.calls.length;
  await (
    await call("BEARER", {
      method: "POST",
      path: "/echo",
      body: { sideEffect: true },
    })
  ).text();
  await (
    await call("BEARER", {
      method: "POST",
      path: "/echo",
      body: { sideEffect: true },
    })
  ).text();
  assert.equal(mock.calls.length, count + 2);
});
test("上游 echo / 401 / 500 / 管理连接测试过滤秘密和响应头", async () => {
  for (const path of ["/echo", "/error401", "/error500"]) {
    const res = await call("BEARER", { method: "POST", path });
    assert.equal(
      res.status,
      path === "/error401" ? 401 : path === "/error500" ? 500 : 200,
    );
    assert(!res.headers.has("x-echo-secret"));
    assert(!res.headers.has("set-cookie"));
    const text = await res.text();
    clean(text);
    assert(text.includes("[REDACTED]"));
  }
  const test = await api(
    servers.adminUrl,
    "/admin/platforms/BEARER/test",
    ADMIN,
    "POST",
    { method: "POST", path: "/error500" },
  );
  assert.equal(test.status, 500);
  clean(await test.text());
  const header = await call("BEARER", { method: "GET", path: "/header-leak" });
  clean(JSON.stringify(Object.fromEntries(header.headers)));
  assert.equal(await header.text(), "safe");
});
test("流式跨 chunk 脱敏、二进制与 multipart 原生上传", async () => {
  const stream = await call("BEARER", { method: "GET", path: "/stream" });
  const text = await stream.text();
  clean(text);
  assert(text.includes("[DONE]"));
  assert(text.includes("[REDACTED]"));
  const binary = await call("BEARER", { method: "GET", path: "/binary" });
  assert.deepEqual(
    Buffer.from(await binary.arrayBuffer()),
    Buffer.from([0, 1, 2, 255, 8, 13]),
  );
  const upload = await call("HEADER", {
    method: "POST",
    path: "/echo",
    multipart: {
      fields: { model: "native" },
      files: [
        {
          field: "file",
          filename: "test.txt",
          contentType: "text/plain",
          base64: "aGVsbG8=",
        },
      ],
    },
  });
  assert.equal(upload.status, 200);
  clean(await upload.text());
  const last = mock.calls.at(-1)!;
  assert(
    last.headers["content-type"]?.startsWith("multipart/form-data; boundary="),
  );
  assert(last.body.includes("hello"));
  assert(last.body.includes('name="file"'));
  assert.equal(
    (
      await call("HEADER", {
        method: "POST",
        path: "/echo",
        rawBody: { contentType: "application/octet-stream", base64: "!!!" },
      })
    ).status,
    400,
  );
});
test("Redactor 在每个字节边界均拦截原始/编码/Basic/Bearer 回显", async () => {
  const values = store.secrets();
  const input = `${MOCK_BEARER}|${encodeURIComponent(`Bearer ${MOCK_BEARER}`)}|${Buffer.from(`Bearer ${MOCK_BEARER}`).toString("base64")}|${MOCK_PASSWORD}`;
  const filter = Readable.from(
    [...Buffer.from(input)].map((n) => Buffer.from([n])),
  ).pipe(new Redactor(values));
  let out = "";
  for await (const chunk of filter) out += chunk.toString();
  clean(out);
  assert(out.includes("[REDACTED]"));
});
test("异步任务 submit/status 原生处理，取消/超时不重复提交", async () => {
  const submit = await call("BEARER", {
    method: "POST",
    path: "/tasks",
    body: { model: "mock-video", native: true },
  });
  const task = await submit.json();
  assert.equal(task.id, "task-001");
  const status = await call("BEARER", {
    method: "GET",
    path: `/tasks/${task.id}`,
  });
  assert.equal((await status.json()).status, "succeeded");
  const before = mock.calls.length;
  const timed = await call("BEARER", {
    method: "GET",
    path: "/slow",
    timeoutMs: 100,
  });
  assert.equal(timed.status, 504);
  clean(await timed.text());
  assert.equal(mock.calls.length, before + 1);
  const controller = new AbortController();
  const waiting = fetch(servers.execUrl + "/v1/call/BEARER", {
    method: "POST",
    headers: {
      authorization: `Bearer ${EXEC}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "GET", path: "/slow" }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(() => waiting, /abort/i);
});
test("文档导入/本地 MD/更新失败保留，抓取不带秘密且不能更改策略", async () => {
  const imported = await api(
    servers.adminUrl,
    "/admin/platforms/BEARER/docs",
    ADMIN,
    "POST",
    {
      title: "原生 REST 文档",
      sourceUrl: mock.url + "/docs",
      markdown: "# Original\n\nPOST /echo accepts native JSON.",
    },
  );
  assert.equal(imported.status, 201);
  const doc = await imported.json();
  const prior = JSON.stringify(store.platform("BEARER"));
  const fetched = await api(
    servers.adminUrl,
    "/admin/platforms/BEARER/docs/fetch",
    ADMIN,
    "POST",
    {
      title: doc.title,
      sourceUrl: mock.url + "/docs",
      id: doc.id,
      expectedRevision: doc.revision,
    },
  );
  assert.equal(fetched.status, 200);
  const updated = await fetched.json();
  assert.equal(updated.revision, 2);
  assert.equal(JSON.stringify(store.platform("BEARER")), prior);
  const fetchCall = mock.calls.at(-1)!;
  assert.equal(fetchCall.headers.authorization, undefined);
  assert.equal(fetchCall.headers["x-api-key"], undefined);
  assert(!fetchCall.path.includes("api_key"));
  for (const suffix of ["/docs-fail", "/shell", "/redirect"]) {
    const fail = await api(
      servers.adminUrl,
      "/admin/platforms/BEARER/docs/fetch",
      ADMIN,
      "POST",
      {
        title: doc.title,
        sourceUrl: mock.url + suffix,
        id: doc.id,
        expectedRevision: 2,
      },
    );
    assert([502, 422].includes(fail.status));
    assert.equal(store.state.docs.find((d) => d.id === doc.id)?.revision, 2);
    assert.equal(JSON.stringify(store.platform("BEARER")), prior);
  }
  const context = await api(servers.execUrl, "/v1/context/BEARER", EXEC);
  clean(await context.text());
  const md = await fs.readFile(
    path.join(dir, "docs", `BEARER-${doc.id}.md`),
    "utf8",
  );
  assert(md.includes("来源："));
  assert(md.includes("更新时间："));
  assert(md.includes("Mock official reference"));
  const malicious = await api(
    servers.adminUrl,
    "/admin/platforms/BEARER/docs/fetch",
    ADMIN,
    "POST",
    {
      title: "attempt",
      sourceUrl: mock.url + "/docs",
      platform: { auth: { type: "none" } },
    },
  );
  assert.equal(malicious.status, 400);
  assert.equal(JSON.stringify(store.platform("BEARER")), prior);
});
test("all document routes reject known credential metadata before fetch/save and preserve persisted state", async () => {
  const doc = store.state.docs.find((d) => d.alias === "BEARER")!;
  const before = await fs.readFile(path.join(dir, "state.json"));
  const state = structuredClone(store.state);
  const calls = mock.calls.length;
  const mdBefore = await fs.readFile(
    path.join(dir, "docs", `BEARER-${doc.id}.md`),
  );
  for (const secret of [MOCK_BEARER, ADMIN, EXEC, master]) {
    const create = await api(
      servers.adminUrl,
      "/admin/platforms/BEARER/docs",
      ADMIN,
      "POST",
      {
        title: `API ${secret}`,
        sourceUrl: mock.url + "/docs",
        markdown: "business docs",
      },
    );
    assert.equal(create.status, 400);
    clean(await create.text());
    const update = await api(
      servers.adminUrl,
      `/admin/docs/${doc.id}`,
      ADMIN,
      "PUT",
      {
        doc: {
          title: "API",
          sourceUrl: `${mock.url}/${encodeURIComponent(secret)}`,
          markdown: "business docs",
        },
        expectedRevision: doc.revision,
      },
    );
    assert.equal(update.status, 400);
    clean(await update.text());
    const fetched = await api(
      servers.adminUrl,
      "/admin/platforms/BEARER/docs/fetch",
      ADMIN,
      "POST",
      {
        title: `API ${secret}`,
        sourceUrl: mock.url + "/docs",
        id: doc.id,
        expectedRevision: doc.revision,
      },
    );
    assert.equal(fetched.status, 400);
    clean(await fetched.text());
  }
  assert.equal(mock.calls.length, calls);
  assert.deepEqual(store.state, state);
  assert.deepEqual(await fs.readFile(path.join(dir, "state.json")), before);
  assert.deepEqual(
    await fs.readFile(path.join(dir, "docs", `BEARER-${doc.id}.md`)),
    mdBefore,
  );
});
test("重复保存、并发版本冲突、切换鉴权/清除/停用与删除操作", async () => {
  const conf = p("CRUD", { type: "header", name: "X-API-Key" });
  assert.equal((await save(conf, { value: MOCK_HEADER })).status, 200);
  assert.equal((await save(conf, { value: MOCK_HEADER })).status, 409);
  const results = await Promise.all([
    save({ ...conf, name: "edit a" }, undefined, 1),
    save({ ...conf, name: "edit b" }, undefined, 1),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await save({ ...conf, auth: { type: "basic" } }, undefined, 2)).status,
    400,
  );
  const clear = await api(
    servers.adminUrl,
    "/admin/platforms/CRUD",
    ADMIN,
    "PUT",
    { platform: conf, clearSecret: true, expectedRevision: 2 },
  );
  assert.equal(clear.status, 200);
  assert.equal(
    (await call("CRUD", { method: "POST", path: "/echo" })).status,
    422,
  );
  assert.equal(
    (await save({ ...conf, enabled: false }, { value: MOCK_HEADER }, 3)).status,
    200,
  );
  assert.equal(
    (await call("CRUD", { method: "POST", path: "/echo" })).status,
    403,
  );
  const del = await api(
    servers.adminUrl,
    "/admin/platforms/CRUD",
    ADMIN,
    "DELETE",
    { expectedRevision: 4 },
  );
  assert.equal(del.status, 200);
  assert.equal(
    (await call("CRUD", { method: "POST", path: "/echo" })).status,
    404,
  );
  assert.equal(
    (
      await api(servers.adminUrl, "/admin/platforms/CRUD", ADMIN, "DELETE", {
        expectedRevision: 4,
      })
    ).status,
    404,
  );
});
test("未实现特殊签名/OAuth 明确拒绝，不假支持", async () => {
  assert.equal(
    (
      await save(p("OAUTH", { type: "adapter", adapter: "oauth2" }), {
        value: "mock-oauth-only",
      })
    ).status,
    200,
  );
  const res = await call("OAUTH", { method: "POST", path: "/echo" });
  assert.equal(res.status, 422);
  assert((await res.json()).error.code === "ADAPTER_UNAVAILABLE");
});
test("可信扩展适配器也不能意外更改固定目标", async () => {
  registerAdapter({
    name: "test-bad-target",
    protectedHeaders: [],
    protectedQuery: [],
    apply: ({ url }) => {
      url.hostname = "evil.example";
    },
  });
  try {
    assert.equal(
      (
        await save(
          p("ADAPTER", { type: "adapter", adapter: "test-bad-target" }),
          { value: "mock-adapter-secret" },
        )
      ).status,
      200,
    );
    const before = mock.calls.length;
    const res = await call("ADAPTER", { method: "POST", path: "/echo" });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "ADAPTER_TARGET_CHANGED");
    assert.equal(mock.calls.length, before);
  } finally {
    adapters.delete("test-bad-target");
  }
});
test("abl file/stdin/JSON/二进制/退出码，不含管理或上游凭据选项", async () => {
  const f = path.join(dir, "request.json");
  await fs.writeFile(
    f,
    JSON.stringify({
      method: "POST",
      path: "/echo",
      body: { native: "abilock-file" },
    }),
  );
  const fromFile = await cli(["call", "BEARER", "--file", f, "--json"]);
  assert.equal(fromFile.code, 0);
  clean(fromFile.stdout + fromFile.stderr);
  const envelope = JSON.parse(fromFile.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.encoding, "json");
  assert.equal(envelope.data.body.native, "abilock-file");
  const list = await cli(["list", "--json"]);
  assert.equal(list.code, 0);
  clean(list.stdout);
  const docs = await cli(["docs", "BEARER", "--json"]);
  assert.equal(docs.code, 0);
  assert(JSON.parse(docs.stdout).data.docs.length);
  for (const [path, code] of [
    ["/error401", 4],
    ["/error500", 4],
    ["/forbidden", 3],
  ] as const) {
    const out = await cli(
      ["call", "BEARER", "--stdin", "--json"],
      JSON.stringify({ method: "POST", path }),
    );
    assert.equal(out.code, code);
    clean(out.stdout + out.stderr);
    assert.equal(JSON.parse(out.stdout).ok, false);
  }
  const invalid = await cli(["call", "BEARER", "--stdin", "--json"], "{bad");
  assert.equal(invalid.code, 2);
  assert(JSON.parse(invalid.stdout).error);
  for (const args of [
    ["secrets", "BEARER", "--json"],
    ["call", "BEARER", "--key", "raw", "--json"],
    ["call", "BEARER", "--verbose", "--json"],
    ["admin", "--json"],
  ]) {
    const out = await cli(args);
    assert.equal(out.code, 2);
  }
  const outFile = path.join(dir, "binary.bin");
  const binary = await cli(
    ["call", "BEARER", "--stdin", "--output", outFile],
    JSON.stringify({ method: "GET", path: "/binary" }),
  );
  assert.equal(binary.code, 0);
  assert.deepEqual(
    await fs.readFile(outFile),
    Buffer.from([0, 1, 2, 255, 8, 13]),
  );
  const source = await fs.readFile("bin/abl.mjs", "utf8");
  assert(!source.includes("/admin"));
  assert(!source.includes("ABILOCK_MASTER_KEY"));
  assert(!source.includes("state.json"));
});
test("请求日志只含结构化 metadata，错误与输入体无秘密", () => {
  clean(JSON.stringify(logs));
  assert(logs.length > 30);
  for (const log of logs)
    assert.deepEqual(
      Object.keys(log).filter(
        (k) =>
          ![
            "event",
            "role",
            "requestId",
            "invocationId",
            "operationId",
            "alias",
            "status",
            "durationMs",
            "completed",
            "errorCode",
          ].includes(k),
      ),
      [],
    );
});
