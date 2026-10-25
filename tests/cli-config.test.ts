import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import http from "node:http";

const helperPath = new URL("../bin/open-config.mjs", import.meta.url).href;
const helper: {
  managementUrl(value?: string): string;
  browserCommand(
    url: string,
    platform: string,
  ): { command: string; args: string[] };
  openConfigPage(
    value?: string,
    options?: {
      platform?: string;
      launch?: (command: string, args: string[]) => Promise<void>;
    },
  ): Promise<string>;
} = await import(helperPath);
const cli = new URL("../bin/abl.mjs", import.meta.url).pathname;
function clientTrace(stdout: string) {
  const { invocationId, operationId, operationIdSource, ...envelope } =
    JSON.parse(stdout);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(invocationId, uuid);
  assert.match(operationId, uuid);
  assert.notEqual(operationId, invocationId);
  assert.equal(operationIdSource, "client");
  return { invocationId, operationId, envelope };
}

function run(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("config 管理地址只允许无认证信息的根地址，浏览器使用安全 argv", async () => {
  assert.equal(helper.managementUrl(), "http://127.0.0.1:4317/");
  for (const url of [
    "http://127.0.0.1:4317",
    "http://localhost:4317/",
    "http://[::1]:4317/",
    "https://api-center.example/",
  ])
    assert.equal(helper.managementUrl(url), new URL(url).href);
  for (const url of [
    "http://api-center.example/",
    "https://user:synthetic-password@api-center.example/",
    "https://@api-center.example/",
    "https://api-center.example/?password=synthetic-password",
    "https://api-center.example/?",
    "https://api-center.example/#synthetic-password",
    "https://api-center.example/#",
    "https://api-center.example/admin",
    "https://api-center.example/admin/../",
    "https://api-center.example/\\admin",
    " https://api-center.example/",
    "https://api-center.example/\n",
    "https:api-center.example",
    "file:///tmp/config",
    "javascript:alert(1)",
    "https://api-center.example/;touch /tmp/never-run",
  ])
    assert.throws(
      () => helper.managementUrl(url),
      (error: unknown) => {
        assert(error instanceof Error);
        assert(!error.message.includes("synthetic-password"));
        return true;
      },
    );
  const expected = {
    darwin: {
      command: "open",
      args: ["-a", "Google Chrome", "http://127.0.0.1:4317/"],
    },
    linux: { command: "xdg-open", args: ["http://127.0.0.1:4317/"] },
    win32: {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4317/"],
    },
  };
  for (const [platform, command] of Object.entries(expected)) {
    const calls: { command: string; args: string[] }[] = [];
    assert.deepEqual(
      helper.browserCommand("http://127.0.0.1:4317", platform),
      command,
    );
    const url = await helper.openConfigPage("http://127.0.0.1:4317", {
      platform,
      launch: async (name, args) => {
        calls.push({ command: name, args });
      },
    });
    assert.equal(url, "http://127.0.0.1:4317/");
    assert.deepEqual(calls, [command]);
  }
});

test(
  "abl config 无执行凭据也可用，仅启动替身 opener，不读取文件/连接管理面/回显秘密",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-config-"));
    const log = path.join(dir, "opened.jsonl");
    const opener = path.join(
      dir,
      process.platform === "darwin" ? "open" : "xdg-open",
    );
    const synthetic = "synthetic-password-never-output";
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.end("unused");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const adminUrl = `http://127.0.0.1:${address.port}`;
    try {
      await fs.writeFile(
        opener,
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.ABILOCK_TEST_OPEN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.env.ABILOCK_TEST_OPEN_FAIL) { console.error("${synthetic}"); process.exitCode = 1; }\n`,
        { mode: 0o700 },
      );
      await fs.writeFile(
        path.join(dir, ".env"),
        `ABILOCK_ADMIN_PASSWORD=${synthetic}\n`,
      );
      await fs.writeFile(
        path.join(dir, "vault.json"),
        JSON.stringify({ secret: synthetic }),
      );
      const env = {
        PATH: [dir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
          path.delimiter,
        ),
        ABILOCK_TEST_OPEN_LOG: log,
        ABILOCK_ADMIN_PASSWORD: synthetic,
        ABILOCK_MASTER_KEY: synthetic,
        ABILOCK_PLATFORM_API_KEY: synthetic,
        ABILOCK_ENDPOINT: "not-an-execution-address",
      };
      const readCalls = async () =>
        (await fs.readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((value) => JSON.parse(value));
      const initial = await run(["config", "--json"], env, dir);
      assert.equal(initial.code, 0);
      assert.equal(initial.stderr, "");
      const initialTrace = clientTrace(initial.stdout);
      assert.deepEqual(initialTrace.envelope, {
        ok: true,
        data: { url: "http://127.0.0.1:4317/", opened: true },
      });
      const configured = await run(
        ["config", "--json"],
        { ...env, ABILOCK_ADMIN_URL: adminUrl },
        dir,
      );
      assert.equal(configured.code, 0);
      const configuredTrace = clientTrace(configured.stdout);
      assert.deepEqual(configuredTrace.envelope, {
        ok: true,
        data: { url: `${adminUrl}/`, opened: true },
      });
      assert.notEqual(initialTrace.invocationId, configuredTrace.invocationId);
      assert.notEqual(initialTrace.operationId, configuredTrace.operationId);
      assert.deepEqual(await readCalls(), [
        process.platform === "darwin"
          ? ["-a", "Google Chrome", "http://127.0.0.1:4317/"]
          : ["http://127.0.0.1:4317/"],
        process.platform === "darwin"
          ? ["-a", "Google Chrome", `${adminUrl}/`]
          : [`${adminUrl}/`],
      ]);
      assert.equal(requests, 0);
      for (const args of [
        ["config", "--password", synthetic, "--json"],
        ["config", "--token", synthetic, "--json"],
        ["config", "--file", "vault.json", "--json"],
        ["config", "--stdin", "--json"],
        ["config", "--url", adminUrl, "--json"],
        ["config", "--json", "--json"],
      ]) {
        const result = await run(args, env, dir, synthetic);
        assert.equal(result.code, 2);
        assert.equal(clientTrace(result.stdout).envelope.error.code, "USAGE");
        assert(!result.stdout.includes(synthetic));
        assert(!result.stderr.includes(synthetic));
      }
      const invalid = await run(
        ["config", "--json"],
        {
          ...env,
          ABILOCK_ADMIN_URL: `https://user:${synthetic}@api-center.example/?password=${synthetic}`,
        },
        dir,
      );
      assert.equal(invalid.code, 2);
      assert.equal(JSON.parse(invalid.stdout).error.code, "ADMIN_URL");
      assert(!invalid.stdout.includes(synthetic));
      assert(!invalid.stderr.includes(synthetic));
      assert.equal((await readCalls()).length, 2);
      const failed = await run(
        ["config", "--json"],
        { ...env, ABILOCK_TEST_OPEN_FAIL: "1" },
        dir,
      );
      assert.equal(failed.code, 3);
      assert.equal(JSON.parse(failed.stdout).error.code, "BROWSER");
      assert.equal(failed.stderr, "");
      assert(!failed.stdout.includes(synthetic));
      assert.equal((await readCalls()).length, 3); // A failed open is never retried.
      assert.equal(requests, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test("新增 config 不改变 abl platforms/doc/api 的执行能力与原生参数", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-cli-"));
  const token = "synthetic-execution-capability";
  const seen: {
    method?: string;
    url?: string;
    body: string;
    invocationId: string;
  }[] = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = "";
    req.on("data", (value) => (body += value));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        body,
        invocationId: req.headers["x-abilock-invocation-id"] as string,
      });
      res.setHeader("content-type", "application/json");
      res.setHeader("x-abilock-request-id", "synthetic-request-id");
      if (req.url === "/v1/platforms")
        res.end(JSON.stringify({ platforms: [{ alias: "DS" }] }));
      else if (req.url === "/v1/context/DS")
        res.end(
          JSON.stringify({
            platform: { alias: "DS" },
            docs: [{ markdown: "原生参数文档" }],
          }),
        );
      else if (req.url === "/v1/call/DS")
        res.end(JSON.stringify({ native: JSON.parse(body) }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const env = {
    ABILOCK_ENDPOINT: `http://127.0.0.1:${address.port}`,
    ABILOCK_EXEC_TOKEN: token,
  };
  try {
    const list = await run(["platforms", "--json"], env, dir);
    assert.equal(list.code, 0);
    const listTrace = clientTrace(list.stdout);
    assert.deepEqual(listTrace.envelope.data, {
      platforms: [{ alias: "DS" }],
    });
    const docs = await run(["doc", "DS", "--json"], env, dir);
    assert.equal(docs.code, 0);
    const docsTrace = clientTrace(docs.stdout);
    assert.equal(docsTrace.envelope.data.docs[0].markdown, "原生参数文档");
    const input = {
      method: "POST",
      path: "/chat/completions",
      body: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "你好" }],
      },
    };
    const call = await run(
      ["call", "DS", "--stdin", "--json"],
      env,
      dir,
      JSON.stringify(input),
    );
    assert.equal(call.code, 0);
    const callTrace = clientTrace(call.stdout);
    const framed = {
      ...input,
      trace: { invocationId: callTrace.invocationId },
    };
    assert.deepEqual(callTrace.envelope.data, { native: framed });
    assert.deepEqual(seen, [
      {
        method: "GET",
        url: "/v1/platforms",
        body: "",
        invocationId: listTrace.invocationId,
      },
      {
        method: "GET",
        url: "/v1/context/DS",
        body: "",
        invocationId: docsTrace.invocationId,
      },
      {
        method: "POST",
        url: "/v1/call/DS",
        body: JSON.stringify(framed),
        invocationId: callTrace.invocationId,
      },
    ]);
    assert.equal(
      new Set([
        listTrace.invocationId,
        docsTrace.invocationId,
        callTrace.invocationId,
      ]).size,
      3,
    );
    assert.equal(
      new Set([
        listTrace.operationId,
        docsTrace.operationId,
        callTrace.operationId,
      ]).size,
      3,
    );
    for (const result of [list, docs, call]) {
      assert(!result.stdout.includes(token));
      assert.equal(result.stderr, "");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
});
