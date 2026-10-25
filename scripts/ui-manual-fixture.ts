import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { mockUpstream, MOCK_BEARER } from "./mock-upstream.js";

// npm run test:ui -- --manual
// Build first, keep stdin open (a terminal or PTY), then open the printed URL
// using the user's own authorized Chrome session. All credentials and records
// are disposable fixtures. EOF, Ctrl+C, or SIGTERM closes the fixture and removes
// its directory. This does not load boot(), service.env, or an installed vault.
// It deliberately does not write ui-validation.json: preparing a page is not a
// completed visual check, and browser observations must be recorded separately.

async function seed(store: Store, baseUrl: string) {
  const documentationUrl = "https://docs.example.test/synthetic-api";
  const notes: Record<string, string> = {
    API_READY: "公司项目",
    API_PENDING: "",
    API_STALE: "个人账号 · Personal workspace",
  };
  for (const alias of ["API_READY", "API_PENDING", "API_STALE"]) {
    await store.save({
      alias, note: notes[alias], name: alias, baseUrl, auth: { type: "bearer" },
      documentationUrl, rules: [], enabled: true, allowInsecureLocal: true,
      description: "界面测试用 API",
    }, { value: MOCK_BEARER }, false, 0);
  }
  for (const alias of ["API_READY", "API_STALE"]) {
    const manifest = {
      expectedRevision: 1, sourceUrl: documentationUrl, title: "API 用法",
      markdown: "# API 用法\n\n这是手册上一版。\n\n向 `POST /echo` 发送 JSON。",
      description: "返回发送的 JSON，仅用于本机界面测试。",
      rules: [{ method: "POST" as const, path: "/echo" }],
      capabilityNotes: [],
    };
    await store.applyLearnedPlatform(alias, manifest);
    await store.applyLearnedPlatform(alias, {
      ...manifest, expectedRevision: store.platform(alias).revision,
      markdown: "# API 用法\n\n这是当前手册。\n\n## 调用\n\n向 `POST /echo` 发送 JSON。\n\n```json\n{\"message\":\"合成测试\"}\n```\n\n## 返回\n\n返回请求正文。密钥由 Abilock 添加，不在命令里填写。",
    });
  }
  const stale = store.platform("API_STALE");
  await store.save({
    alias: stale.alias, note: stale.note, name: stale.name, baseUrl: stale.baseUrl,
    auth: stale.auth, rules: stale.rules, enabled: true,
    allowInsecureLocal: true, description: stale.description,
    documentationUrl: "https://docs.example.test/synthetic-api-v2",
  }, undefined, false, stale.revision);

  await store.saveConnection({
    alias: "SSH_DEMO", note: "测试服务器", name: "测试服务器", kind: "ssh", enabled: true,
    description: "不连接真实服务器，仅测试管理表单。",
    documentationUrl: "https://docs.example.test/synthetic-ssh",
    trustBoundary: "independent-target",
    config: {
      host: "ssh.example.invalid", port: 22, username: "synthetic-user",
      remoteRoot: "/srv/demo",
      fileAccess: "read", allowShell: true,
    },
  }, { password: "synthetic-ui-ssh-password-20261022" }, false, 0);
  await store.applyLearnedConnection("SSH_DEMO", {
    expectedRevision: 1, sourceUrl: "https://docs.example.test/synthetic-ssh",
    title: "服务器用法", markdown: "# 服务器\n\n合成连接，不对应真实服务器。\n\n```sh\nabl ssh SSH_DEMO \"df -h\"\n```",
    capabilityNotes: [],
  });
  await store.saveConnection({
    alias: "DB_DEMO", note: "测试数据库", name: "测试数据库", kind: "mysql", enabled: false,
    description: "已停用的合成数据库。", trustBoundary: "independent-target",
    documentationUrl: "https://docs.example.test/synthetic-mysql",
    config: { host: "db.example.invalid", port: 3306, user: "synthetic-user", database: "demo", tls: true },
  }, { password: "synthetic-ui-db-password-20261022" }, false, 0);
  await store.applyLearnedConnection("DB_DEMO", {
    expectedRevision: 1, sourceUrl: "https://docs.example.test/synthetic-mysql",
    title: "数据库用法", markdown: "# 数据库\n\n合成连接，不对应真实数据库。\n\n```sh\nabl mysql DB_DEMO \"SELECT 1\"\n```",
    capabilityNotes: [],
  });
}

function waitForStop() {
  let finish: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  if (process.stdin.readableEnded || process.stdin.destroyed) stop();
  else process.stdin.resume();
  return {
    stopped,
    dispose() {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdin.off("end", stop);
      process.stdin.off("error", stop);
      process.stdin.pause();
    },
  };
}

export async function runManualFixture() {
  const webDir = fileURLToPath(new URL("../dist/web", import.meta.url));
  await fs.access(path.join(webDir, "index.html"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-ui-manual-"));
  const store = new Store(dir, crypto.randomBytes(32).toString("hex"));
  const password = "fixture-" + crypto.randomBytes(12).toString("hex");
  const priorMock = process.env.ABILOCK_MOCK;
  const priorLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const lifetime = waitForStop();
  let mock: Awaited<ReturnType<typeof mockUpstream>> | undefined;
  let service: Awaited<ReturnType<typeof startServers>> | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    await store.init();
    mock = await mockUpstream();
    await seed(store, mock.url);
    service = await startServers({
      store, execToken: crypto.randomBytes(32).toString("hex"), webDir,
      adminHost: "127.0.0.1", adminPort: 0, managementOnly: true, log: () => {},
    });
    const initialized = await fetch(service.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: service.adminUrl, "x-abilock-ui": "1" },
      body: JSON.stringify({ password, confirmPassword: password }),
      signal: AbortSignal.timeout(10000),
    });
    await initialized.arrayBuffer();
    if (!initialized.ok) throw new Error("Synthetic UI password setup failed");
    console.log(JSON.stringify({
      fixtureOnly: true, url: service.adminUrl, password, temporaryDirectory: dir,
      browserLaunched: false, executionListener: false,
      aliases: ["API_READY", "API_PENDING", "API_STALE", "SSH_DEMO", "DB_DEMO"],
      instructions: "Open this URL in the user's authorized Google Chrome. Use only synthetic values. Close stdin or press Ctrl+C to clean up.",
    }, null, 2));
    await lifetime.stopped;
  } finally {
    lifetime.dispose();
    for (const close of [
      () => service?.close(), () => mock?.close(), () => store.close(),
      () => fs.rm(dir, { recursive: true, force: true }),
    ]) {
      try { await close(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (priorMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = priorMock;
    if (priorLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = priorLocal;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Synthetic UI fixture cleanup failed");
  console.log(JSON.stringify({ fixtureOnly: true, closed: true, temporaryDirectoryRemoved: true }));
}
