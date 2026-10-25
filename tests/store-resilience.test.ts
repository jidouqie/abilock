import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectionSchema, type Connection } from "../src/connections.js";
import { Store } from "../src/store.js";

const futureSecret = "synthetic-future-record-secret-582731";
const dbSecret = "synthetic-resilience-db-secret-913374";

function database(alias = "DB_A", changes: Partial<Connection> = {}) {
  return connectionSchema.parse({
    alias,
    name: "Synthetic database",
    kind: "mysql",
    config: {
      host: "db.example.test",
      port: 3306,
      database: "business",
      user: "synthetic-user",
      tls: true,
    },
    trustBoundary: "independent-target",
    ...changes,
  });
}

async function temporary(
  work: (dir: string, master: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-resilience-"));
  try {
    await work(dir, crypto.randomBytes(32).toString("hex"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readRaw(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
    connections?: Record<string, unknown>[];
    platforms: Record<string, unknown>[];
  };
}

// A record written by a newer version (unknown kind) or damaged by hand must
// not make every other connection unusable, and must survive later commits.
test("records this version cannot validate are set aside, preserved and still redacted", async () => {
  await temporary(async (dir, master) => {
    const writer = new Store(dir, master);
    await writer.init();
    await writer.saveConnection(database(), { password: dbSecret }, false, 0);
    const future = {
      alias: "FUTURE",
      name: "From a newer version",
      kind: "future-kind",
      enabled: true,
      description: "",
      config: { endpoint: "https://future.example.test" },
      revision: 1,
      updatedAt: new Date().toISOString(),
      sealed: writer.seal({ token: futureSecret }),
    };
    const brokenApi = {
      alias: "BROKEN",
      name: "Damaged",
      baseUrl: "not a url",
      auth: { type: "bearer" },
      rules: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    await writer.close();
    const raw = await readRaw(dir);
    raw.connections!.push(future);
    raw.platforms.push(brokenApi);
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(raw));

    const store = new Store(dir, master);
    await store.init();
    try {
      assert.deepEqual(
        store.listConnections().map((item) => item.alias),
        ["DB_A"],
      );
      assert.deepEqual(store.list(), []);
      assert.deepEqual(
        store.unrecognizedRecords().sort((a, b) => a.alias!.localeCompare(b.alias!)),
        [
          { alias: "BROKEN", type: "api", kind: null },
          { alias: "FUTURE", type: "connection", kind: "future-kind" },
        ],
      );
      // Credentials of a set-aside record remain redaction inputs.
      assert.ok(store.secrets().includes(futureSecret));
      // Its alias stays reserved, so it can never be silently duplicated.
      await assert.rejects(
        store.saveConnection(database("future"), { password: dbSecret }, false, 0),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ALIAS_CONFLICT",
      );
      // An unrelated commit writes the set-aside records back unchanged.
      await store.saveConnection(
        database("DB_A", { note: "changed" }),
        undefined,
        false,
        store.listConnections()[0].revision,
        "DB_A",
      );
      const after = await readRaw(dir);
      assert.deepEqual(
        after.connections!.find((item) => item.alias === "FUTURE"),
        future,
      );
      assert.deepEqual(
        after.platforms.find((item) => item.alias === "BROKEN"),
        brokenApi,
      );
      await store.removeUnrecognized("FUTURE");
      const removed = await readRaw(dir);
      assert.equal(
        removed.connections!.some((item) => item.alias === "FUTURE"),
        false,
      );
      assert.deepEqual(
        store.unrecognizedRecords().map((item) => item.alias),
        ["BROKEN"],
      );
    } finally {
      await store.close();
    }
  });
});

test("a ciphertext that does not open still fails the whole store", async () => {
  await temporary(async (dir, master) => {
    const writer = new Store(dir, master);
    await writer.init();
    await writer.saveConnection(database(), { password: dbSecret }, false, 0);
    await writer.close();
    const other = new Store(dir, crypto.randomBytes(32).toString("hex"), [], {
      readOnly: true,
    });
    await assert.rejects(other.init(), /配置或主密钥无效/);
    await other.close();
  });
});

test("read-only refresh reuses an unchanged snapshot and sees another process's commit", async () => {
  await temporary(async (dir, master) => {
    const writer = new Store(dir, master);
    await writer.init();
    await writer.saveConnection(database(), { password: dbSecret }, false, 0);
    const reader = new Store(dir, master, [], { readOnly: true });
    await reader.init();
    try {
      const first = reader.state;
      await reader.refresh();
      assert.equal(reader.state, first, "unchanged authority is not reparsed");
      await writer.saveConnection(
        database("DB_A", { note: "visible" }),
        undefined,
        false,
        1,
        "DB_A",
      );
      await reader.refresh();
      assert.notEqual(reader.state, first);
      assert.equal(reader.listConnections()[0].note, "visible");
    } finally {
      await reader.close();
      await writer.close();
    }
  });
});
