import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { platformSchema, type Platform } from "../src/schema.js";
import { type Connection } from "../src/connections.js";
import { learnPlatform } from "../src/learn.js";

// These fixtures never read the user's data or make an upstream request.
const key = "synthetic-alias-provider-key-1290234";
const executionToken = "synthetic-alias-execution-capability-9825";
const master = "b".repeat(64);

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-alias-"));
  const store = new Store(dir, master);
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    await store.init();
    server = await startServers({
      store,
      execToken: executionToken,
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      execPort: 0,
      log: () => {},
    });
    const setup = await fetch(server.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: {
        origin: server.adminUrl,
        "x-abilock-ui": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "synthetic-alias-ui-password",
        confirmPassword: "synthetic-alias-ui-password",
      }),
      redirect: "error",
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await setup.json()) as { csrfToken: string };
    const ownedServer = server;
    return {
      dir,
      store,
      server: ownedServer,
      cookie,
      csrfToken,
      async put(route: string, value: unknown) {
        return fetch(ownedServer.adminUrl + route, {
          method: "PUT",
          headers: {
            origin: ownedServer.adminUrl,
            "x-abilock-ui": "1",
            "content-type": "application/json",
            cookie,
            "x-abilock-csrf": csrfToken,
          },
          body: JSON.stringify(value),
          redirect: "error",
        });
      },
      async close() {
        await ownedServer.close();
        await store.close();
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function api(alias: string): Platform {
  return platformSchema.parse({
    alias,
    name: "Synthetic writing API",
    baseUrl: "https://api.example.test",
    auth: { type: "bearer" },
    rules: [],
  });
}
function ssh(alias: string): Connection {
  return {
    alias,
    name: "Synthetic server",
    kind: "ssh",
    enabled: true,
    description: "Saved server usage",
    trustBoundary: "independent-target",
    config: {
      host: "server.example.test",
      port: 22,
      username: "synthetic-user",
      hostKeySHA256: "SHA256:" + "A".repeat(43),
      remoteRoot: "/files",
      fileAccess: "read",
      allowShell: true,
    },
    capabilityNotes: [
      {
        name: "文件",
        summary: "查看已保存的文件",
        tags: ["files"],
        input: "文件路径",
        output: "文件内容",
      },
    ],
  };
}
function editApi(store: Store, previous: string, alias: string): Platform {
  const saved = store.platform(previous);
  return {
    alias,
    name: saved.name,
    baseUrl: saved.baseUrl,
    auth: saved.auth,
    rules: saved.rules,
    enabled: saved.enabled,
    allowInsecureLocal: saved.allowInsecureLocal,
    description: saved.description,
    capabilityNotes: saved.capabilityNotes,
    chat: saved.chat,
  };
}
function editSsh(store: Store, previous: string, alias: string): Connection {
  const saved = store.connection("ssh", previous);
  return {
    alias,
    name: saved.name,
    kind: saved.kind,
    enabled: saved.enabled,
    description: saved.description,
    capabilityNotes: saved.capabilityNotes,
    trustBoundary: saved.trustBoundary,
    config: saved.config,
  };
}
async function snapshot(f: Fixture) {
  const names = (await fs.readdir(path.join(f.dir, "docs"))).sort();
  return {
    state: structuredClone(f.store.state),
    bytes: await fs.readFile(path.join(f.dir, "state.json")),
    docs: await Promise.all(
      names.map(async (name) => ({
        name,
        bytes: await fs.readFile(path.join(f.dir, "docs", name)),
      })),
    ),
  };
}
async function persistedState(f: Fixture) {
  const reader = new Store(f.dir, master, [], { readOnly: true });
  try {
    await reader.init();
    return structuredClone(reader.state);
  } finally {
    await reader.close();
  }
}
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, code);
  assert(!text.includes(key));
  assert(!text.includes(executionToken));
}
async function cli(f: Fixture, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [path.resolve("bin/abl.mjs"), ...args],
        {
          env: {
            PATH: process.env.PATH,
            ABILOCK_ENDPOINT: f.server.execUrl,
            ABILOCK_EXEC_TOKEN: executionToken,
          },
          encoding: "utf8",
          timeout: 20000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") return reject(error);
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}
async function learned(f: Fixture, alias = "DS") {
  await f.store.save(api(alias), { value: key }, false, 0);
  await learnPlatform(f.store, alias, {
    expectedRevision: 1,
    sourceUrl: "https://docs.example.test/api",
    title: "接口",
    markdown:
      "POST /chat accepts a model and messages. GET /models lists models.",
    description: "文案改写",
    rules: [
      { method: "POST", path: "/chat" },
      { method: "GET", path: "/models" },
    ],
    capabilityNotes: [
      {
        name: "文案",
        summary: "改写已有文字",
        tags: ["text"],
        input: "model/messages",
        output: "改写结果",
        method: "POST",
        path: "/chat",
      },
    ],
    chat: { method: "POST", path: "/chat", model: "synthetic-model" },
  });
  await f.store.saveDoc(
    alias,
    {
      title: "补充用法",
      sourceUrl: "https://docs.example.test/examples",
      markdown: "Keep the original facts when rewriting a draft.",
    },
    "manual",
  );
}

test("management HTTP alias edits retain keys and learned usage, move document mirrors and update CLI lookup", async () => {
  const f = await fixture();
  try {
    await learned(f);
    await f.store.save(api("OTHER"), { value: key + "-other" }, false, 0);
    const before = structuredClone(f.store.platform("DS"));
    const other = structuredClone(f.store.platform("OTHER"));
    const docs = structuredClone(f.store.state.docs);
    const mirrors = (await snapshot(f)).docs;
    const response = await f.put("/admin/platforms/DS", {
      platform: editApi(f.store, "DS", "Writer"),
      expectedRevision: before.revision,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert(!text.includes(key));
    assert(!text.includes(before.sealed!));
    assert.equal(JSON.parse(text).alias, "Writer");
    const after = f.store.platform("writer");
    assert.deepEqual(after, {
      ...before,
      alias: "Writer",
      revision: before.revision + 1,
      updatedAt: after.updatedAt,
    });
    assert.deepEqual(f.store.platform("OTHER"), other);
    assert.throws(() => f.store.platform("DS"), /不存在/);
    assert.deepEqual(
      f.store.state.docs,
      docs.map((doc) => ({ ...doc, alias: "Writer" })),
    );
    assert.deepEqual(
      (await snapshot(f)).docs,
      mirrors.map((doc) => ({
        ...doc,
        name: doc.name.replace(/^DS-/, "Writer-"),
      })),
    );
    const catalogue = await cli(f, ["list", "--json"]);
    assert.equal(catalogue.code, 0, catalogue.stderr);
    const cards = JSON.parse(catalogue.stdout).data.capabilities as {
      alias: string;
      docsCommand: string;
      invocation: string;
    }[];
    assert(cards.some((card) => card.alias === "Writer"));
    assert(!cards.some((card) => card.alias === "DS"));
    for (const card of cards.filter((item) => item.alias === "Writer")) {
      assert(card.docsCommand.includes("Writer"));
      assert(card.invocation.includes("Writer"));
    }
    const context = await cli(f, ["doc", "Writer", "--json"]);
    assert.equal(context.code, 0, context.stderr);
    const output = JSON.parse(context.stdout).data;
    assert.equal(output.platform.alias, "Writer");
    assert.equal(output.docs.length, 2);
    assert(!context.stdout.includes(key));
    assert.equal((await cli(f, ["doc", "DS", "--json"])).code, 3);

    // A change in capitalization is also a real rename, including mirror filenames.
    const casing = await f.put("/admin/platforms/writer", {
      platform: editApi(f.store, "Writer", "writer"),
      expectedRevision: after.revision,
    });
    assert.equal(casing.status, 200);
    assert.equal(f.store.platform("WRITER").alias, "writer");
    assert.equal(f.store.platform("writer").sealed, before.sealed);
    assert(f.store.state.docs.every((doc) => doc.alias === "writer"));
    assert.deepEqual(
      (await snapshot(f)).docs,
      mirrors.map((doc) => ({
        ...doc,
        name: doc.name.replace(/^DS-/, "writer-"),
      })),
    );
    assert.deepEqual(await persistedState(f), f.store.state);
  } finally {
    await f.close();
  }
});

test("management protocol alias edits retain credentials, identity, saved inventory and documents without executing SSH", async () => {
  const f = await fixture();
  try {
    await f.store.saveConnection(ssh("SERVER"), { password: key }, false, 0);
    const inventory = {
      inspectedAt: "2026-10-11T00:00:00.000Z",
      os: "Linux" as const,
      architecture: "x86_64",
      tools: ["node" as const, "ffmpeg" as const],
    };
    await f.store.recordInventory("SERVER", inventory, 1);
    const doc = await f.store.saveDoc(
      "SERVER",
      {
        title: "服务器用法",
        sourceUrl: "https://docs.example.test/server",
        markdown: "Files are under the configured remote root.",
      },
      "manual",
    );
    const before = structuredClone(f.store.connection("ssh", "SERVER"));
    const response = await f.put("/admin/connections/server", {
      connection: editSsh(f.store, "SERVER", "production"),
      expectedRevision: before.revision,
    });
    assert.equal(response.status, 200);
    const after = f.store.connection("ssh", "production");
    assert.deepEqual(after, {
      ...before,
      alias: "production",
      revision: before.revision + 1,
      updatedAt: after.updatedAt,
    });
    assert.deepEqual(f.store.state.docs, [{ ...doc, alias: "production" }]);
    assert.throws(() => f.store.connection("ssh", "SERVER"), /不存在/);
    assert.deepEqual(await fs.readdir(path.join(f.dir, "docs")), [
      `production-${doc.id}.md`,
    ]);
    const output = await cli(f, ["doc", "ssh", "production", "--json"]);
    assert.equal(output.code, 0, output.stderr);
    const data = JSON.parse(output.stdout).data;
    assert.equal(data.connection.alias, "production");
    assert.deepEqual(data.connection.inventory, inventory);
    assert.equal(data.docs[0].id, doc.id);
    assert(!output.stdout.includes(key));
    const casing = await f.put("/admin/connections/production", {
      connection: editSsh(f.store, "production", "Production"),
      expectedRevision: after.revision,
    });
    assert.equal(casing.status, 200);
    assert.equal(f.store.connection("ssh", "production").alias, "Production");
    assert.deepEqual(
      f.store.connection("ssh", "Production").inventory,
      inventory,
    );
    assert.deepEqual(await fs.readdir(path.join(f.dir, "docs")), [
      `Production-${doc.id}.md`,
    ]);
    assert.deepEqual(await persistedState(f), f.store.state);
  } finally {
    await f.close();
  }
});

test("alias edits reject case-insensitive collisions and invalid names without mutating either connection or public files", async () => {
  const f = await fixture();
  try {
    await learned(f, "FIRST");
    await f.store.save(api("SECOND"), { value: key + "-second" }, false, 0);
    await f.store.saveConnection(
      ssh("SERVER"),
      { password: key + "-server" },
      false,
      0,
    );
    await f.store.saveConnection(
      ssh("BACKUP"),
      { password: key + "-backup" },
      false,
      0,
    );
    const before = await snapshot(f);
    for (const alias of ["second", "server"]) {
      await expectError(
        await f.put("/admin/platforms/FIRST", {
          platform: editApi(f.store, "FIRST", alias),
          expectedRevision: 2,
        }),
        409,
        "ALIAS_CONFLICT",
      );
      assert.deepEqual(await snapshot(f), before);
    }
    for (const alias of ["first", "backup"]) {
      await expectError(
        await f.put("/admin/connections/SERVER", {
          connection: editSsh(f.store, "SERVER", alias),
          expectedRevision: 1,
        }),
        409,
        "ALIAS_CONFLICT",
      );
      assert.deepEqual(await snapshot(f), before);
    }
    for (const alias of [
      "",
      "1Bad",
      "../escape",
      "has space",
      "A".repeat(33),
    ]) {
      await expectError(
        await f.put("/admin/platforms/FIRST", {
          platform: editApi(f.store, "FIRST", alias),
          expectedRevision: 2,
        }),
        400,
        "VALIDATION",
      );
      await expectError(
        await f.put("/admin/connections/SERVER", {
          connection: editSsh(f.store, "SERVER", alias),
          expectedRevision: 1,
        }),
        400,
        "VALIDATION",
      );
      assert.deepEqual(await snapshot(f), before);
    }
  } finally {
    await f.close();
  }
});

test("stale edits and invented old aliases cannot create connections, and concurrent renames have one winner", async () => {
  const f = await fixture();
  try {
    await learned(f);
    await f.store.saveConnection(ssh("SERVER"), { password: key }, false, 0);
    const before = await snapshot(f);
    for (const [route, body, status, code] of [
      [
        "/admin/platforms/DS",
        { platform: editApi(f.store, "DS", "writer"), expectedRevision: 1 },
        409,
        "REVISION_CONFLICT",
      ],
      [
        "/admin/platforms/MISSING",
        { platform: editApi(f.store, "DS", "writer"), expectedRevision: 0 },
        400,
        "ALIAS_MISMATCH",
      ],
      [
        "/admin/platforms/MISSING",
        { platform: editApi(f.store, "DS", "MISSING"), expectedRevision: 2 },
        409,
        "REVISION_CONFLICT",
      ],
      [
        "/admin/connections/SERVER",
        { connection: editSsh(f.store, "SERVER", "host"), expectedRevision: 9 },
        409,
        "REVISION_CONFLICT",
      ],
      [
        "/admin/connections/MISSING",
        { connection: editSsh(f.store, "SERVER", "host"), expectedRevision: 0 },
        400,
        "ALIAS_MISMATCH",
      ],
      [
        "/admin/connections/MISSING",
        {
          connection: editSsh(f.store, "SERVER", "MISSING"),
          expectedRevision: 1,
        },
        409,
        "REVISION_CONFLICT",
      ],
    ] as const) {
      await expectError(await f.put(route, body), status, code);
      assert.deepEqual(await snapshot(f), before);
    }
    const platform = editApi(f.store, "DS", "WriterOne");
    const results = await Promise.all([
      f.put("/admin/platforms/DS", { platform, expectedRevision: 2 }),
      f.put("/admin/platforms/DS", {
        platform: { ...platform, alias: "WriterTwo" },
        expectedRevision: 2,
      }),
    ]);
    assert.equal(
      results.filter((response) => response.status === 200).length,
      1,
    );
    assert.equal(
      results.filter((response) => response.status === 409).length,
      1,
    );
    const saved = f.store.state.platforms[0];
    assert(["WriterOne", "WriterTwo"].includes(saved.alias));
    assert.equal(saved.revision, 3);
    assert.equal(saved.sealed, before.state.platforms[0].sealed);
    assert.equal(f.store.state.platforms.length, 1);
    assert.equal(f.store.state.docs.length, 2);
    assert(f.store.state.docs.every((doc) => doc.alias === saved.alias));
    const after = await snapshot(f);
    await expectError(
      await f.put(`/admin/platforms/${saved.alias}`, {
        platform: editApi(f.store, saved.alias, "Another"),
        expectedRevision: 2,
      }),
      409,
      "REVISION_CONFLICT",
    );
    assert.deepEqual(await snapshot(f), after);

    const connection = editSsh(f.store, "SERVER", "HostOne");
    const protocolResults = await Promise.all([
      f.put("/admin/connections/SERVER", { connection, expectedRevision: 1 }),
      f.put("/admin/connections/SERVER", {
        connection: { ...connection, alias: "HostTwo" },
        expectedRevision: 1,
      }),
    ]);
    assert.deepEqual(
      protocolResults.map((response) => response.status).sort(),
      [200, 409],
    );
    const savedConnection = f.store.state.connections![0];
    assert(["HostOne", "HostTwo"].includes(savedConnection.alias));
    assert.equal(savedConnection.revision, 2);
    assert.equal(savedConnection.sealed, before.state.connections![0].sealed);
    assert.equal(f.store.state.connections!.length, 1);
    const protocolAfter = await snapshot(f);
    await expectError(
      await f.put(`/admin/connections/${savedConnection.alias}`, {
        connection: editSsh(f.store, savedConnection.alias, "AnotherHost"),
        expectedRevision: 1,
      }),
      409,
      "REVISION_CONFLICT",
    );
    assert.deepEqual(await snapshot(f), protocolAfter);
  } finally {
    await f.close();
  }
});

test("alias editing keeps UI session, CSRF and execution-role separation intact", async () => {
  const f = await fixture();
  try {
    await learned(f);
    const before = await snapshot(f);
    const body = JSON.stringify({
      platform: editApi(f.store, "DS", "Writer"),
      expectedRevision: 2,
    });
    const attempts: {
      base: string;
      headers: Record<string, string>;
      status: number;
    }[] = [
      { base: f.server.adminUrl, headers: {}, status: 401 },
      {
        base: f.server.adminUrl,
        headers: { authorization: `Bearer ${executionToken}` },
        status: 401,
      },
      {
        base: f.server.adminUrl,
        headers: {
          cookie: f.cookie,
          "x-abilock-ui": "1",
          origin: f.server.adminUrl,
        },
        status: 403,
      },
      {
        base: f.server.execUrl,
        headers: { authorization: `Bearer ${executionToken}` },
        status: 404,
      },
    ];
    for (const item of attempts) {
      const response = await fetch(item.base + "/admin/platforms/DS", {
        method: "PUT",
        headers: { "content-type": "application/json", ...item.headers },
        body,
        redirect: "error",
      });
      assert.equal(response.status, item.status);
      assert(!(await response.text()).includes(key));
      assert.deepEqual(await snapshot(f), before);
    }
  } finally {
    await f.close();
  }
});
