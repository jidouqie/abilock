import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("产品 mock 清除继承的旧管理凭据，首次启动没有默认密码", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/mock-mode.ts"],
    {
      env: {
        PATH: process.env.PATH,
        ABILOCK_ADMIN_TOKEN: "synthetic-inherited-admin-00000009",
        ABILOCK_ADMIN_PORT: "0",
        ABILOCK_EXEC_PORT: "0",
        ABILOCK_MOCK_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  try {
    const started = await new Promise<{
      management: string;
      execution: string;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("mock startup timed out")),
        15000,
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("mock startup failed"));
      });
      child.stdout.on("data", (c) => {
        output += c;
        if (!output.includes("本机 mock 已就绪")) return;
        const line = output
          .split("\n")
          .find((line) => line.startsWith('{"event":"started"'));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
    });
    const status = await fetch(started.management + "/admin/auth/status").then(
      (r) => r.json(),
    );
    assert.deepEqual(status, {
      initialized: false,
      legacy: false,
      authenticated: false,
    });
    const result = await fetch(started.management + "/admin/platforms", {
      headers: { authorization: "Bearer synthetic-inherited-admin-00000009" },
    });
    assert.equal(result.status, 401);
    assert.equal(
      await fetch(started.execution + "/health").then((r) => r.status),
      200,
    );
    assert(!output.includes("synthetic-inherited-admin-00000009"));
    assert.equal(stderr, "");
  } finally {
    child.kill("SIGTERM");
    assert.equal(await exit, 0);
  }
});
