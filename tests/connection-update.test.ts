import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Store } from "../src/store.js";
import type { Connection } from "../src/connections.js";

const basicSecret = {
  username: "synthetic-update-user",
  password: "synthetic-update-password",
};
const bearerSecret = { token: "synthetic-update-bearer" };

function registry(authType = "basic"): Connection {
  return {
    alias: "REGISTRY_UPDATE",
    name: "Offline synthetic Registry",
    kind: "registry",
    enabled: true,
    description: "Disposable offline connection update test",
    trustBoundary: "independent-target",
    config: {
      endpoint: "https://registry.example.invalid",
      authType,
      allowedRepositories: ["review/app"],
    },
  };
}

type Fixture = {
  dir: string;
  store: Store;
  restart: () => Promise<void>;
};

async function withStore(work: (fixture: Fixture) => Promise<void>) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-connection-update-"),
  );
  const master = crypto.randomBytes(32).toString("hex");
  const stores: Store[] = [];
  const fixture = { dir } as Fixture;
  fixture.restart = async () => {
    await fixture.store?.close();
    fixture.store = new Store(dir, master);
    stores.push(fixture.store);
    await fixture.store.init();
  };
  try {
    await fixture.restart();
    await work(fixture);
  } finally {
    for (const store of stores) await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("connection auth changes reject incompatible retained credentials without changing persisted state", async () => {
  await withStore(async (fixture) => {
    const first = await fixture.store.saveConnection(
      registry(),
      basicSecret,
      false,
      0,
    );
    const before = structuredClone(fixture.store.state);
    const persisted = await fs.readFile(
      path.join(fixture.dir, "state.json"),
      "utf8",
    );
    await assert.rejects(
      fixture.store.saveConnection(
        registry("bearer"),
        undefined,
        false,
        first.revision,
      ),
      { code: "REGISTRY_ARGUMENT" },
    );
    assert.deepEqual(fixture.store.state, before);
    assert.equal(
      await fs.readFile(path.join(fixture.dir, "state.json"), "utf8"),
      persisted,
    );
    await fixture.restart();
    const restored = fixture.store.connection("registry", first.alias);
    assert.equal(restored.config.authType, "basic");
    assert.equal(restored.revision, first.revision);
    assert.deepEqual(
      fixture.store.unsealCredentials(restored.sealed!),
      basicSecret,
    );
  });
});

test("metadata-only connection edits retain compatible encrypted credentials and restart with the same key", async () => {
  await withStore(async (fixture) => {
    const first = await fixture.store.saveConnection(
      registry(),
      basicSecret,
      false,
      0,
    );
    const sealed = fixture.store.connection("registry", first.alias).sealed;
    const saved = await fixture.store.saveConnection(
      { ...registry(), name: "Updated public name" },
      undefined,
      false,
      first.revision,
    );
    assert.equal(saved.hasSecret, true);
    assert.equal(saved.revision, first.revision + 1);
    assert.equal(
      fixture.store.connection("registry", first.alias).sealed,
      sealed,
    );
    await fixture.restart();
    const restored = fixture.store.connection("registry", first.alias);
    assert.equal(restored.name, "Updated public name");
    assert.deepEqual(
      fixture.store.unsealCredentials(restored.sealed!),
      basicSecret,
    );
  });
});

test("auth changes with replacement credentials persist only the new identity and restart", async () => {
  await withStore(async (fixture) => {
    const first = await fixture.store.saveConnection(
      registry(),
      basicSecret,
      false,
      0,
    );
    const saved = await fixture.store.saveConnection(
      registry("bearer"),
      bearerSecret,
      false,
      first.revision,
    );
    assert.equal(saved.hasSecret, true);
    await fixture.restart();
    const restored = fixture.store.connection("registry", first.alias);
    assert.equal(restored.config.authType, "bearer");
    assert.equal(restored.revision, saved.revision);
    assert.deepEqual(
      fixture.store.unsealCredentials(restored.sealed!),
      bearerSecret,
    );
  });
});

test("explicit clearing takes precedence and permits an auth change awaiting UI credentials", async () => {
  await withStore(async (fixture) => {
    const first = await fixture.store.saveConnection(
      registry(),
      basicSecret,
      false,
      0,
    );
    const saved = await fixture.store.saveConnection(
      registry("bearer"),
      basicSecret,
      true,
      first.revision,
    );
    assert.equal(saved.hasSecret, false);
    await fixture.restart();
    const restored = fixture.store.connection("registry", first.alias);
    assert.equal(restored.config.authType, "bearer");
    assert.equal(restored.sealed, undefined);
    assert.equal(restored.revision, saved.revision);
  });
});

test("unconfigured connections remain valid while revision and kind-change protections remain enforced", async () => {
  await withStore(async (fixture) => {
    const first = await fixture.store.saveConnection(
      registry("bearer"),
      undefined,
      false,
      0,
    );
    assert.equal(first.hasSecret, false);
    const before = structuredClone(fixture.store.state);
    await assert.rejects(
      fixture.store.saveConnection(registry("bearer"), undefined, false, 0),
      { code: "REVISION_CONFLICT" },
    );
    await assert.rejects(
      fixture.store.saveConnection(
        {
          ...registry(),
          kind: "postgres",
          config: {
            host: "database.example.invalid",
            user: "synthetic-user",
            database: "synthetic-db",
          },
        },
        undefined,
        false,
        first.revision,
      ),
      { code: "SECRET_REQUIRED" },
    );
    assert.deepEqual(fixture.store.state, before);
    await fixture.restart();
    const restored = fixture.store.connection("registry", first.alias);
    assert.equal(restored.sealed, undefined);
    assert.equal(restored.revision, first.revision);
  });
});
