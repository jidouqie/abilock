// Actual target runtime with disposable mock state. No browser or real secrets.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const env = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  ABILOCK_ADMIN_PORT: "0",
  ABILOCK_EXEC_PORT: "0",
  ABILOCK_MOCK_PORT: "0",
};
const mock = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/mock-mode.ts"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "",
  failed = false;
mock.stdout.on("data", (v) => {
  output += v;
});
mock.stderr.resume();
mock.on("error", () => {
  failed = true;
});
const report = {
  checkedAt: new Date().toISOString(),
  target: process.cwd(),
  temporaryMockOnly: true,
  browserInteractionVerified: false,
  checks: [],
  stopped: false,
};
try {
  const until = Date.now() + 15000;
  while (
    !output.includes("本机 mock 已就绪") &&
    Date.now() < until &&
    !failed &&
    mock.exitCode === null
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(output.includes("本机 mock 已就绪"));
  const ready = output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((v) => v?.management && v?.execution);
  assert.ok(ready);
  const cliEnv = {
    PATH: env.PATH,
    ABILOCK_ENDPOINT: ready.execution,
    ABILOCK_EXEC_TOKEN: "mock-execution-capability-not-real-0002",
  };
  for (const [name, args] of [
    ["abl-list", ["bin/abl.mjs", "list", "--json"]],
    ["abl-docs", ["bin/abl.mjs", "docs", "MOCK_BEARER", "--json"]],
    [
      "abl-native-api",
      [
        "bin/abl.mjs",
        "api",
        "MOCK_BEARER",
        "--file",
        "examples/mock.json",
        "--json",
      ],
    ],
    [
      "abl-repeat",
      [
        "bin/abl.mjs",
        "api",
        "MOCK_BEARER",
        "--file",
        "examples/mock.json",
        "--json",
      ],
    ],
    [
      "abilock-multipart",
      [
        "bin/abl.mjs",
        "call",
        "MOCK_HEADER",
        "--file",
        "examples/multipart.json",
        "--json",
      ],
    ],
  ]) {
    const response = await run(process.execPath, args, {
      env: cliEnv,
      timeout: 15000,
      maxBuffer: 300000,
    });
    const data = JSON.parse(response.stdout);
    assert.equal(data.ok, true);
    for (const syntheticSecret of [
      "mock-bearer-not-a-real-api-key-001",
      "mock-header-not-a-real-api-key-002",
    ])
      assert.ok(!response.stdout.includes(syntheticSecret));
    report.checks.push({ name, passed: true, status: data.status });
  }
  const status = await (
    await fetch(ready.management + "/admin/auth/status")
  ).json();
  assert.equal(status.initialized, false);
  assert.equal(status.authenticated, false);
  report.checks.push({ name: "no-default-management-password", passed: true });
  const html = await (await fetch(ready.management)).text();
  const script =
    html.match(/src="([^"]+\/assets\/[^"]+\.js)"/)?.[1] ??
    html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(script);
  const asset = Buffer.from(
    await (await fetch(new URL(script, ready.management))).arrayBuffer(),
  );
  assert.equal(
    crypto.createHash("sha256").update(asset).digest("hex"),
    crypto
      .createHash("sha256")
      .update(await fs.readFile("dist/web" + script))
      .digest("hex"),
  );
  report.checks.push({ name: "built-ui-asset-served-over-http", passed: true });
} finally {
  mock.kill("SIGTERM");
  await new Promise((resolve) => {
    if (mock.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      mock.kill("SIGKILL");
      resolve();
    }, 10000);
    mock.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  report.stopped = mock.exitCode !== null;
  report.passed =
    report.checks.length === 7 &&
    report.checks.every((v) => v.passed) &&
    report.stopped;
  await fs.writeFile(
    "artifacts/post-review-runtime-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      stopped: report.stopped,
      browserInteractionVerified: false,
    }),
  );
}
