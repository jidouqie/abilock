import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { resolveDataDirectory } from "../src/start.js";
import { Store } from "../src/store.js";
import { platformSchema, type Platform } from "../src/schema.js";
import { connectionKinds, connectionSchema } from "../src/connections.js";
import { mockUpstream, MOCK_BEARER } from "../scripts/mock-upstream.js";
import { startServers } from "../src/server.js";

test("service data defaults to ~/.abilock and an explicit old location remains unchanged", () => {
  assert.equal(
    resolveDataDirectory("/project", "/synthetic-service-home"),
    "/synthetic-service-home/.abilock",
  );
  assert.equal(
    resolveDataDirectory("/project", "/synthetic-service-home", "./data"),
    "/project/data",
  );
  assert.equal(
    resolveDataDirectory("/project", "/synthetic-service-home", "~/.abilock"),
    "/synthetic-service-home/.abilock",
  );
  assert.equal(
    resolveDataDirectory(
      "/project",
      "/synthetic-service-home",
      "/old/location",
    ),
    "/old/location",
  );
  assert.throws(
    () => resolveDataDirectory("/project", "/synthetic-service-home", ""),
    /不能是空值/,
  );
});

test("ABILOCK environment wins over legacy names without inspecting service files", async () => {
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { setting } from "./src/environment.ts"; process.stdout.write(JSON.stringify([setting("EXEC_TOKEN"),setting("DATA_DIR"),setting("GATEWAY_PORT")]));',
      ],
      {
        env: {
          ABILOCK_EXEC_TOKEN: "synthetic-new-execution",
          PERMIVELO_EXEC_TOKEN: "synthetic-previous-execution",
          COI_EXEC_TOKEN: "synthetic-legacy-execution",
          COI_DATA_DIR: "/synthetic-old-store",
          PERMIVELO_GATEWAY_PORT: "12345",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error("synthetic environment check failed")),
    );
  });
  assert.deepEqual(JSON.parse(result), [
    "synthetic-new-execution",
    "/synthetic-old-store",
    "12345",
  ]);
});

test("list and doc are reserved commands, never registered service types", () => {
  assert(
    !connectionKinds.some((kind: string) => ["list", "doc"].includes(kind)),
  );
  for (const kind of ["list", "doc"])
    assert.equal(
      connectionSchema.safeParse({
        alias: "SERVICE",
        name: "service",
        kind,
        config: {},
        description: "",
        enabled: true,
      }).success,
      false,
    );
});

const platform: Platform = {
  alias: "CHAT",
  name: "synthetic chat",
  baseUrl: "https://example.com",
  auth: { type: "bearer" },
  enabled: true,
  allowInsecureLocal: false,
  description: "",
  rules: [{ method: "POST", path: "/chat/completions" }],
};
test("chat convenience configuration cannot add an endpoint, wildcard, model guess or credential field", () => {
  const valid = {
    method: "POST" as const,
    path: "/chat/completions",
    model: "synthetic-model",
  };
  assert(platformSchema.safeParse({ ...platform, chat: valid }).success);
  for (const chat of [
    { ...valid, method: "GET" },
    { ...valid, path: "/new-route" },
    { ...valid, path: "/chat/*" },
    { ...valid, model: "" },
    { ...valid, model: "x".repeat(257) },
    { ...valid, apiKey: "synthetic-secret" },
  ])
    assert.equal(
      platformSchema.safeParse({ ...platform, chat }).success,
      false,
    );
});

test("chat metadata persists with existing credentials, supports explicit clearing and follows allowed rules", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-chat-settings-"),
  );
  const store = new Store(dir, "7".repeat(64));
  await store.init();
  const chat = {
    method: "POST" as const,
    path: "/chat/completions",
    model: "synthetic-model",
  };
  const secret = "synthetic-chat-provider-key-34156";
  try {
    await store.save({ ...platform, chat }, { value: secret }, false, 0);
    const sealed = store.platform("CHAT").sealed;
    await store.save({ ...platform, name: "rename" }, undefined, false, 1);
    assert.deepEqual(store.platform("CHAT").chat, chat);
    assert.equal(store.platform("CHAT").sealed, sealed);
    await assert.rejects(
      store.save(
        { ...platform, chat: { ...chat, model: secret } },
        undefined,
        false,
        2,
      ),
      /不得包含已保管/,
    );
    assert.equal(store.platform("CHAT").revision, 2);
    await store.save({ ...platform, chat: null }, undefined, false, 2);
    assert.equal(store.platform("CHAT").chat, null);
    await store.save({ ...platform, chat }, undefined, false, 3);
    await store.save(
      { ...platform, rules: [{ method: "GET", path: "/models" }] },
      undefined,
      false,
      4,
    );
    assert.equal(store.platform("CHAT").chat, undefined);
    assert.equal(store.platform("CHAT").sealed, sealed);
    await store.close();
    const restored = new Store(dir, "7".repeat(64));
    try {
      await restored.init();
      assert.equal(restored.platform("CHAT").chat, undefined);
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("abl api chat reads UI-owned metadata through the real broker and submits one synthetic request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-chat-chain-"));
  const store = new Store(dir, "8".repeat(64));
  await store.init();
  const upstream = await mockUpstream();
  const oldLocal = process.env.ABILOCK_ALLOW_LOCAL,
    oldMock = process.env.ABILOCK_MOCK;
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  process.env.ABILOCK_MOCK = "1";
  const execToken = "synthetic-abilock-chat-exec-capability";
  const servers = await startServers({
    store,
    execToken,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: () => {},
  });
  try {
    await store.save(
      {
        ...platform,
        baseUrl: upstream.url,
        allowInsecureLocal: true,
        rules: [{ method: "POST", path: "/echo" }],
        chat: { method: "POST", path: "/echo", model: "synthetic-model" },
      },
      { value: MOCK_BEARER },
      false,
      0,
    );
    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["bin/abl.mjs", "api", "CHAT", "chat", "你好 $()", "--json"],
          {
            env: {
              ABILOCK_ENDPOINT: servers.execUrl,
              ABILOCK_EXEC_TOKEN: execToken,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout }));
      },
    );
    assert.equal(result.code, 0);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.authApplied, true);
    assert.equal(data.body.model, "synthetic-model");
    assert.deepEqual(data.body.messages, [
      { role: "user", content: "你好 $()" },
    ]);
    assert.equal(upstream.calls.length, 1);
    assert(
      !result.stdout.includes(MOCK_BEARER) &&
        !result.stdout.includes(execToken),
    );
  } finally {
    await servers.close();
    await upstream.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = oldMock;
  }
});
