import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { startServers } from "../src/server.js";
import { Store } from "../src/store.js";
import { mockUpstream, MOCK_BEARER } from "../scripts/mock-upstream.js";

// All values and stores in this file are disposable test data, never product defaults.
const password = "87654321";
const replacement = "八个汉字密码测试";
const execToken = "synthetic-execution-capability-0042";
const legacyToken = "synthetic-legacy-management-0043";
const master = "a".repeat(64);
const run = promisify(execFile);
type Servers = Awaited<ReturnType<typeof startServers>>;
type Session = { cookie: string; csrfToken: string };
type Fixture = {
  dir: string;
  store: Store;
  servers: Servers;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  dispose: () => Promise<void>;
};

async function fixture(adminToken?: string): Promise<Fixture> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-password-test-"),
  );
  let stopped = true;
  const f = { dir } as Fixture;
  f.restart = async () => {
    f.store = new Store(dir, master);
    await f.store.init();
    try {
      f.servers = await startServers({
        store: f.store,
        adminToken,
        execToken,
        webDir: path.resolve("dist/web"),
        adminPort: 0,
        execPort: 0,
        log: () => {},
      });
      stopped = false;
    } catch (e) {
      await f.store.close();
      throw e;
    }
  };
  f.stop = async () => {
    if (!stopped) {
      stopped = true;
      await f.servers.close();
      await f.store.close();
    }
  };
  f.dispose = async () => {
    await f.stop();
    await fs.rm(dir, { recursive: true, force: true });
  };
  try {
    await f.restart();
    return f;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function request(
  f: Fixture,
  route: string,
  value?: unknown,
  session?: Session,
  extra: Record<string, string> = {},
) {
  return fetch(f.servers.adminUrl + route, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      origin: f.servers.adminUrl,
      "x-abilock-ui": "1",
      ...(value === undefined ? {} : { "content-type": "application/json" }),
      ...(session
        ? { cookie: session.cookie, "x-abilock-csrf": session.csrfToken }
        : {}),
      ...extra,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    redirect: "error",
  });
}

async function sessionFrom(
  res: Response,
  expectedStatus = 200,
): Promise<Session> {
  assert.equal(res.status, expectedStatus);
  const rawCookie = res.headers.get("set-cookie");
  assert(rawCookie, "successful authentication must issue a cookie");
  assert.match(rawCookie, /HttpOnly/i);
  assert.match(rawCookie, /SameSite=Strict/i);
  assert.match(rawCookie, /Path=\/admin(?:;|$)/i);
  const cookie = rawCookie.split(";")[0];
  const value = (await res.json()) as { csrfToken: string };
  assert.equal(typeof value.csrfToken, "string");
  assert(value.csrfToken.length >= 24);
  assert(!JSON.stringify(value).includes(cookie.split("=")[1]));
  return { cookie, csrfToken: value.csrfToken };
}

async function setup(f: Fixture, value = password, session?: Session) {
  return sessionFrom(
    await request(
      f,
      "/admin/auth/setup",
      { password: value, confirmPassword: value },
      session,
    ),
    201,
  );
}

async function login(f: Fixture, value = password) {
  return sessionFrom(
    await request(f, "/admin/auth/login", { password: value }),
  );
}

test("password setup and login accept a full Unicode password beyond 256 UTF-16 units", async () => {
  const f = await fixture();
  try {
    const value = "🔒".repeat(130);
    await setup(f, value);
    await login(f, value);
    const tooLong = "🔒".repeat(257);
    const rejected = await request(f, "/admin/auth/login", { password: tooLong });
    assert.equal(rejected.status, 401);
  } finally { await f.dispose(); }
});

async function addSyntheticState(f: Fixture) {
  await f.store.save(
    {
      alias: "SYNTHETIC",
      name: "临时测试平台",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer" },
      enabled: true,
      rules: [{ method: "POST", path: "/echo" }],
      description: "仅用于证明管理密码变更不修改平台数据",
      allowInsecureLocal: false,
    },
    { value: "temporary-provider-secret-0044" },
    false,
    0,
  );
  await f.store.saveDoc(
    "SYNTHETIC",
    {
      title: "临时接口说明",
      sourceUrl: "https://example.com/docs",
      markdown: "# 测试\n\nPOST /echo 使用原生 JSON 参数。",
    },
    "manual",
  );
  const files = await fs.readdir(path.join(f.dir, "docs"));
  return {
    state: await fs.readFile(path.join(f.dir, "state.json"), "utf8"),
    docs: await Promise.all(
      files
        .sort()
        .map(async (file) => [
          file,
          await fs.readFile(path.join(f.dir, "docs", file), "utf8"),
        ]),
    ),
  };
}

async function assertStateUnchanged(
  f: Fixture,
  before: Awaited<ReturnType<typeof addSyntheticState>>,
) {
  assert.equal(
    await fs.readFile(path.join(f.dir, "state.json"), "utf8"),
    before.state,
  );
  const files = await fs.readdir(path.join(f.dir, "docs"));
  assert.deepEqual(
    await Promise.all(
      files
        .sort()
        .map(async (file) => [
          file,
          await fs.readFile(path.join(f.dir, "docs", file), "utf8"),
        ]),
    ),
    before.docs,
  );
}

test("首次启动无默认管理密码；初始化只接受本机同源 UI 请求", async () => {
  const f = await fixture();
  try {
    const status = await request(f, "/admin/auth/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      initialized: false,
      legacy: false,
      authenticated: false,
    });
    assert.equal((await request(f, "/admin/platforms")).status, 401);
    assert.equal(
      (
        await request(f, "/admin/platforms", undefined, undefined, {
          authorization: `Bearer ${execToken}`,
        })
      ).status,
      401,
    );
    const rejectedHeaders: Record<string, string>[] = [
      { "x-abilock-ui": "1" },
      { origin: f.servers.adminUrl },
      { origin: "https://untrusted.example", "x-abilock-ui": "1" },
      {
        origin: f.servers.adminUrl,
        "x-abilock-ui": "1",
        "sec-fetch-site": "cross-site",
      },
      {
        origin: "http://untrusted.example",
        "x-abilock-ui": "1",
        host: "untrusted.example",
      },
    ];
    for (const headers of rejectedHeaders) {
      const denied = await fetch(f.servers.adminUrl + "/admin/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ password, confirmPassword: password }),
      });
      assert.equal(denied.status, 403);
      assert(!JSON.stringify(await denied.json()).includes(password));
    }
    const executor = await fetch(f.servers.execUrl + "/admin/auth/status", {
      headers: { authorization: `Bearer ${execToken}` },
    });
    assert.equal(executor.status, 404);
    assert.equal((await request(f, "/admin/auth/status")).status, 200);
    const session = await setup(f);
    assert.equal(
      (await request(f, "/admin/platforms", undefined, session)).status,
      200,
    );
  } finally {
    await f.dispose();
  }
});

test("密码按 Unicode 字符计数，至少 8 位且不强制字符组合", async () => {
  const f = await fixture();
  try {
    for (const value of ["1234567", "🙂🙂🙂🙂", "一二三四五六七"]) {
      const res = await request(f, "/admin/auth/setup", {
        password: value,
        confirmPassword: value,
      });
      assert.equal(res.status, 400);
      assert(!JSON.stringify(await res.json()).includes(value));
    }
    assert.equal(
      (
        await request(f, "/admin/auth/setup", {
          password,
          confirmPassword: "different-confirmation",
        })
      ).status,
      400,
    );
    await setup(f); // Eight digits satisfy the rule without composition requirements.
    await login(f);
  } finally {
    await f.dispose();
  }
  for (const value of ["🙂🙂🙂🙂🙂🙂🙂🙂", "        "]) {
    const other = await fixture();
    try {
      await setup(other, value);
      await login(other, value);
    } finally {
      await other.dispose();
    }
  }
});

test("管理密码不能复用执行能力令牌；长旧令牌仍可通过 UI 迁移", async () => {
  const f = await fixture();
  try {
    const forbidden = await request(f, "/admin/auth/setup", {
      password: execToken,
      confirmPassword: execToken,
    });
    assert.equal(forbidden.status, 400);
    assert(!JSON.stringify(await forbidden.json()).includes(execToken));
    const session = await setup(f);
    const change = await request(
      f,
      "/admin/auth/password",
      {
        currentPassword: password,
        password: execToken,
        confirmPassword: execToken,
      },
      session,
    );
    assert.equal(change.status, 400);
    assert(!JSON.stringify(await change.json()).includes(execToken));
    await login(f);
  } finally {
    await f.dispose();
  }
  const longLegacy = legacyToken.repeat(10);
  assert(longLegacy.length > 256);
  const old = await fixture(longLegacy);
  try {
    const session = await login(old, longLegacy);
    await setup(old, password, session);
    await login(old);
    assert.equal(
      (await request(old, "/admin/auth/login", { password: longLegacy }))
        .status,
      401,
    );
  } finally {
    await old.dispose();
  }
});

test("并发初始化只有一位赢家；密码慢哈希独立持久化且重启可登录", async () => {
  const f = await fixture();
  try {
    const before = await addSyntheticState(f);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(f, "/admin/auth/setup", {
          password,
          confirmPassword: password,
        }),
      ),
    );
    assert.equal(responses.filter((res) => res.status === 201).length, 1);
    assert(responses.every((res) => [201, 409, 429].includes(res.status)));
    await Promise.all(responses.map((res) => res.arrayBuffer()));
    assert.equal(
      (
        await request(f, "/admin/auth/setup", {
          password,
          confirmPassword: password,
        })
      ).status,
      409,
    );
    const auth = await fs.readFile(path.join(f.dir, "admin-auth.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(auth));
    assert.match(auth, /scrypt/i);
    for (const value of [
      password,
      execToken,
      master,
      "temporary-provider-secret-0044",
    ])
      assert(!auth.includes(value));
    assert.equal(
      (await fs.stat(path.join(f.dir, "admin-auth.json"))).mode & 0o777,
      0o600,
    );
    await assertStateUnchanged(f, before);
    const oldSession = await login(f);
    await f.stop();
    await f.restart();
    const status = await request(
      f,
      "/admin/auth/status",
      undefined,
      oldSession,
    );
    assert.deepEqual(await status.json(), {
      initialized: true,
      legacy: false,
      authenticated: false,
    });
    await login(f);
    await assertStateUnchanged(f, before);
  } finally {
    await f.dispose();
  }
});

test("HttpOnly 会话、CSRF、注销与密码变更撤销会话；平台数据与执行调用保留", async () => {
  const f = await fixture();
  try {
    const before = await addSyntheticState(f);
    const first = await setup(f);
    const second = await login(f);
    const info = await request(f, "/admin/auth/status", undefined, first);
    assert.deepEqual(await info.json(), {
      initialized: true,
      legacy: false,
      authenticated: true,
      csrfToken: first.csrfToken,
    });
    assert.equal(
      (
        await request(f, "/admin/auth/logout", {}, first, {
          "x-abilock-csrf": "",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f, "/admin/auth/logout", {}, first, {
          origin: "https://untrusted.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          f,
          "/admin/auth/password",
          {
            currentPassword: "wrong-current-password",
            password: replacement,
            confirmPassword: replacement,
          },
          first,
        )
      ).status,
      401,
    );
    const fresh = await sessionFrom(
      await request(
        f,
        "/admin/auth/password",
        {
          currentPassword: password,
          password: replacement,
          confirmPassword: replacement,
        },
        first,
      ),
    );
    for (const old of [first, second])
      assert.equal(
        (await request(f, "/admin/platforms", undefined, old)).status,
        401,
      );
    assert.equal(
      (await request(f, "/admin/platforms", undefined, fresh)).status,
      200,
    );
    assert.equal(
      (await request(f, "/admin/auth/login", { password })).status,
      401,
    );
    const last = await login(f, replacement);
    assert.equal(
      (await request(f, "/admin/auth/logout", {}, last)).status,
      200,
    );
    assert.equal(
      (await request(f, "/admin/platforms", undefined, last)).status,
      401,
    );
    await assertStateUnchanged(f, before);
    const cli = await run(
      process.execPath,
      [path.resolve("bin/abl.mjs"), "platforms", "--json"],
      {
        env: {
          ABILOCK_ENDPOINT: f.servers.execUrl,
          ABILOCK_EXEC_TOKEN: execToken,
        },
      },
    );
    const output = JSON.parse(cli.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.platforms[0].alias, "SYNTHETIC");
    assert.equal(output.data.platforms[0].hasSecret, true);
    for (const secret of [
      password,
      replacement,
      master,
      "temporary-provider-secret-0044",
    ])
      assert(!cli.stdout.includes(secret));
  } finally {
    await f.dispose();
  }
});

test("会话有绝对过期时间；失败登录在慢哈希前限速且无输入回显", async () => {
  const f = await fixture();
  try {
    const session = await setup(f);
    const realNow = Date.now;
    try {
      const future = realNow() + 365 * 24 * 60 * 60 * 1000;
      Date.now = () => future;
      assert.equal(
        (await request(f, "/admin/platforms", undefined, session)).status,
        401,
      );
    } finally {
      Date.now = realNow;
    }
    for (let i = 0; i < 5; i++) {
      const res = await request(f, "/admin/auth/login", {
        password: "synthetic-wrong-password",
      });
      assert.equal(res.status, 401);
      assert(
        !JSON.stringify(await res.json()).includes("synthetic-wrong-password"),
      );
    }
    const blocked = await request(f, "/admin/auth/login", { password });
    assert.equal(blocked.status, 429);
    assert(!JSON.stringify(await blocked.json()).includes(password));
  } finally {
    await f.dispose();
  }
});

test("旧管理令牌仅用于迁移；密码初始化及恢复后不会重新启用旧令牌", async () => {
  const f = await fixture(legacyToken);
  try {
    const before = await addSyntheticState(f);
    assert.deepEqual(await (await request(f, "/admin/auth/status")).json(), {
      initialized: false,
      legacy: true,
      authenticated: false,
    });
    assert.equal(
      (
        await request(f, "/admin/platforms", undefined, undefined, {
          authorization: `Bearer ${legacyToken}`,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(f, "/admin/auth/setup", {
          password,
          confirmPassword: password,
        })
      ).status,
      401,
    );
    const legacy = await login(f, legacyToken);
    await setup(f, password, legacy);
    assert.equal(
      (
        await request(f, "/admin/platforms", undefined, undefined, {
          authorization: `Bearer ${legacyToken}`,
        })
      ).status,
      401,
    );
    assert.equal(
      (await request(f, "/admin/auth/login", { password: legacyToken })).status,
      401,
    );
    await f.stop();
    // A trusted service owner can preserve the old password hash while resetting only admin access.
    await fs.rename(
      path.join(f.dir, "admin-auth.json"),
      path.join(f.dir, "admin-auth.json.kept"),
    );
    await f.restart();
    assert.deepEqual(await (await request(f, "/admin/auth/status")).json(), {
      initialized: false,
      legacy: false,
      authenticated: false,
    });
    assert.equal(
      (
        await request(f, "/admin/platforms", undefined, undefined, {
          authorization: `Bearer ${legacyToken}`,
        })
      ).status,
      401,
    );
    await setup(f, replacement);
    await login(f, replacement);
    await assertStateUnchanged(f, before);
  } finally {
    await f.dispose();
  }
});

test("损坏的管理密码文件失败闭合，不变成首次初始化或覆盖平台数据", async () => {
  const f = await fixture();
  try {
    const before = await addSyntheticState(f);
    await setup(f);
    await f.stop();
    await fs.writeFile(path.join(f.dir, "admin-auth.json"), "{incomplete", {
      mode: 0o600,
    });
    await assert.rejects(() => f.restart());
    assert.equal(
      await fs.readFile(path.join(f.dir, "admin-auth.json"), "utf8"),
      "{incomplete",
    );
    await assertStateUnchanged(f, before);
  } finally {
    await f.dispose();
  }
});

test("新 Cookie 管理协议端到端：配置、文档更新与 abl 原生调用，秘密不泄露", async () => {
  const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  const oldMock = process.env.ABILOCK_MOCK;
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  process.env.ABILOCK_MOCK = "1";
  const upstream = await mockUpstream();
  const f = await fixture();
  try {
    const session = await setup(f);
    const alias = "COOKIE_REST";
    const platform = {
      alias,
      name: "Cookie 流程临时 REST 平台",
      baseUrl: upstream.url,
      auth: { type: "bearer" },
      rules: [
        { method: "POST", path: "/echo" },
        { method: "POST", path: "/require-auth" },
      ],
      enabled: true,
      allowInsecureLocal: true,
      description: "首次密码设置后通过管理页面协议保存的合成配置",
    };
    async function management(
      method: "POST" | "PUT",
      route: string,
      value: unknown,
      csrf = true,
    ) {
      return fetch(f.servers.adminUrl + route, {
        method,
        headers: {
          origin: f.servers.adminUrl,
          "x-abilock-ui": "1",
          "content-type": "application/json",
          cookie: session.cookie,
          ...(csrf ? { "x-abilock-csrf": session.csrfToken } : {}),
        },
        body: JSON.stringify(value),
        redirect: "error",
      });
    }
    function assertPublicOutput(text: string) {
      for (const value of [
        password,
        master,
        execToken,
        MOCK_BEARER,
        `Bearer ${MOCK_BEARER}`,
        session.cookie.split("=")[1],
        session.csrfToken,
      ]) {
        assert(!text.includes(value));
        assert(!text.includes(encodeURIComponent(value)));
        assert(!text.includes(Buffer.from(value).toString("base64")));
      }
    }
    const configured = await management("PUT", `/admin/platforms/${alias}`, {
      platform,
      secret: { value: MOCK_BEARER },
      expectedRevision: 0,
    });
    assert.equal(configured.status, 200);
    const savedText = await configured.text();
    assertPublicOutput(savedText);
    const saved = JSON.parse(savedText);
    assert.equal(saved.hasSecret, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.sealed, undefined);
    const priorPlatform = structuredClone(f.store.platform(alias));
    const denied = await management(
      "PUT",
      `/admin/platforms/${alias}`,
      {
        platform: {
          ...platform,
          name: "不应保存的无 CSRF 更新",
          auth: { type: "none" },
        },
        clearSecret: true,
        expectedRevision: saved.revision,
      },
      false,
    );
    assert.equal(denied.status, 403);
    assertPublicOutput(await denied.text());
    assert.deepEqual(f.store.platform(alias), priorPlatform);

    const imported = await management(
      "POST",
      `/admin/platforms/${alias}/docs`,
      {
        title: "Cookie 原生 REST 文档",
        sourceUrl: upstream.url + "/docs",
        markdown: "# 初版\n\nPOST /require-auth 接受原生 JSON body。",
      },
    );
    assert.equal(imported.status, 201);
    const importedText = await imported.text();
    assertPublicOutput(importedText);
    const doc = JSON.parse(importedText);
    const updatedMarkdown =
      "# 更新版\n\nPOST /require-auth：原生 model/messages/vendor_options 字段保持不变。\n\n文档提及修改 auth/baseUrl/rules 也只是文本，不能修改配置。";
    const updated = await management("PUT", `/admin/docs/${doc.id}`, {
      doc: {
        title: doc.title,
        sourceUrl: upstream.url + "/docs",
        markdown: updatedMarkdown,
      },
      expectedRevision: doc.revision,
    });
    assert.equal(updated.status, 200);
    const updatedText = await updated.text();
    assertPublicOutput(updatedText);
    assert.equal(JSON.parse(updatedText).revision, 2);
    assert.deepEqual(f.store.platform(alias), priorPlatform);
    const md = await fs.readFile(
      path.join(f.dir, "docs", `${alias}-${doc.id}.md`),
      "utf8",
    );
    assert(md.includes(updatedMarkdown));
    assert(md.includes("来源："));
    assert(md.includes("更新时间："));
    assertPublicOutput(md);

    const env = {
      ABILOCK_ENDPOINT: f.servers.execUrl,
      ABILOCK_EXEC_TOKEN: execToken,
    };
    const context = await run(
      process.execPath,
      [path.resolve("bin/abl.mjs"), "docs", alias, "--json"],
      { env },
    );
    assertPublicOutput(context.stdout);
    assertPublicOutput(context.stderr);
    const contextData = JSON.parse(context.stdout);
    assert.equal(contextData.ok, true);
    assert.equal(contextData.data.docs[0].markdown, updatedMarkdown);
    assert.equal(contextData.data.platform.hasSecret, true);
    assert.deepEqual(contextData.data.platform.auth, platform.auth);
    assert.equal(contextData.data.platform.baseUrl, platform.baseUrl);
    assert.deepEqual(contextData.data.platform.rules, platform.rules);
    const nativeBody = {
      model: "vendor-native-model",
      messages: [{ role: "user", content: "原生参数由 abl 保留" }],
      stream: false,
      vendor_options: { temperature: 0.15, nested: [1, { text: "中文内容" }] },
    };
    const inputFile = path.join(f.dir, "native-request.json");
    await fs.writeFile(
      inputFile,
      JSON.stringify({
        method: "POST",
        path: "/require-auth",
        query: { request: "cookie-flow" },
        headers: { "X-Correlation-ID": "cookie-e2e" },
        body: nativeBody,
      }),
      { mode: 0o600 },
    );
    const call = await run(
      process.execPath,
      [
        path.resolve("bin/abl.mjs"),
        "call",
        alias,
        "--file",
        inputFile,
        "--json",
      ],
      { env },
    );
    assertPublicOutput(call.stdout);
    assertPublicOutput(call.stderr);
    const output = JSON.parse(call.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.status, 200);
    assert.equal(output.data.authApplied, true);
    assert.deepEqual(output.data.body, nativeBody);
    assert.match(output.data.reflectedAuth, /REDACTED/);
    const actualCall = upstream.calls.at(-1)!;
    assert.equal(actualCall.headers.authorization, `Bearer ${MOCK_BEARER}`);
    assert.equal(actualCall.headers.cookie, undefined);
    assert.equal(actualCall.headers["x-abilock-csrf"], undefined);
    assert.equal(actualCall.headers["x-correlation-id"], "cookie-e2e");
    assert.deepEqual(JSON.parse(actualCall.body), nativeBody);
    assert.deepEqual(f.store.platform(alias), priorPlatform);
  } finally {
    await f.dispose();
    await upstream.close();
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = oldMock;
  }
});
