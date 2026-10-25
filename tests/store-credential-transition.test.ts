import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { AppError } from "../src/schema.js";
import { redact } from "../src/security.js";
import type { Connection, Credentials } from "../src/connections.js";

const syntheticBasic = {
  username: "synthetic-user",
  password: "synthetic-transition-password",
};
function registry(authType: "basic" | "bearer" | "none"): Connection {
  return {
    alias: "REG_TRANSITION",
    name: "Temporary registry",
    kind: "registry",
    enabled: true,
    description: "Synthetic store-only fixture",
    config: {
      endpoint: "https://registry.example.com",
      authType,
      allowedRepositories: ["business/repo"],
    },
  };
}
function database(kind: "postgres" | "mysql" = "postgres"): Connection {
  return {
    alias: "DB_TRANSITION",
    name: "Temporary DB metadata",
    kind,
    enabled: true,
    description: "No network activity",
    config: {
      host: "database.example.com",
      user: "business-user",
      database: "business",
      tls: true,
    },
  };
}
async function temporary(
  work: (store: Store, master: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-store-transition-"),
  );
  const master = crypto.randomBytes(32).toString("hex"),
    store = new Store(dir, master);
  try {
    await store.init();
    await work(store, master);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function snapshot(store: Store) {
  return {
    state: structuredClone(store.state),
    bytes: await fs.readFile(path.join(store.dir, "state.json")),
    entries: await fs.readdir(store.dir),
    docs: await Promise.all(
      (await fs.readdir(path.join(store.dir, "docs")))
        .sort()
        .map(async (file) => [
          file,
          await fs.readFile(path.join(store.dir, "docs", file), "utf8"),
        ]),
    ),
  };
}
async function unchanged(
  store: Store,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  assert.deepEqual(await snapshot(store), before);
}
function assertPublic(value: unknown, secrets: Credentials) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes("sealed"));
  for (const secret of Object.values(secrets))
    assert.ok(!text.includes(secret));
}
async function reopen(store: Store, master: string) {
  await store.close();
  const restored = new Store(store.dir, master);
  await restored.init();
  return restored;
}

test("Store validates retained Basic credentials against Bearer/none configuration before persisting", async () => {
  await temporary(async (store, master) => {
    await store.saveConnection(registry("basic"), syntheticBasic, false, 0);
    await store.saveDoc(
      "REG_TRANSITION",
      {
        title: "Synthetic doc",
        sourceUrl: "https://example.com/docs",
        markdown: "Store-only business documentation",
      },
      "manual",
    );
    const before = await snapshot(store);
    for (const authType of ["bearer", "none"] as const) {
      await assert.rejects(
        store.saveConnection(registry(authType), undefined, false, 1),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.ok(!error.message.includes(syntheticBasic.password));
          return true;
        },
      );
      await unchanged(store, before);
    }
    const restored = await reopen(store, master);
    try {
      assert.equal(
        restored.connection("registry", "REG_TRANSITION").config.authType,
        "basic",
      );
      assert.deepEqual(
        restored.unsealCredentials(
          restored.connection("registry", "REG_TRANSITION").sealed!,
        ),
        syntheticBasic,
      );
      assertPublic(restored.listConnections(), syntheticBasic);
    } finally {
      await restored.close();
    }
  });
});

test("Store rejects protocol changes without explicit credential replacement or clear", async () => {
  await temporary(async (store) => {
    await store.saveConnection(database(), syntheticBasic, false, 0);
    const before = await snapshot(store);
    const changed: Connection = {
      ...database("mysql"),
      config: {
        host: "database.example.com",
        user: "business-user",
        database: "business",
        tls: true,
      },
    };
    await assert.rejects(
      store.saveConnection(changed, undefined, false, 1),
      (error: unknown) =>
        error instanceof AppError && error.code === "SECRET_REQUIRED",
    );
    await unchanged(store, before);
  });
});

test("Store retains compatible DB credentials on same-kind configuration edits and reloads normally", async () => {
  await temporary(async (store, master) => {
    const saved = await store.saveConnection(
      database(),
      syntheticBasic,
      false,
      0,
    );
    const sealed = store.connection("postgres", "DB_TRANSITION").sealed;
    const updated = await store.saveConnection(
      {
        ...database(),
        name: "Edited business DB",
        config: {
          ...database().config,
          user: "next-business-user",
          database: "next-business",
        },
      },
      undefined,
      false,
      saved.revision,
    );
    assert.equal(updated.revision, 2);
    assert.equal(store.connection("postgres", "DB_TRANSITION").sealed, sealed);
    assertPublic(updated, syntheticBasic);
    const restored = await reopen(store, master);
    try {
      assert.equal(
        restored.connection("postgres", "DB_TRANSITION").config.database,
        "next-business",
      );
      assert.deepEqual(
        restored.unsealCredentials(
          restored.connection("postgres", "DB_TRANSITION").sealed!,
        ),
        syntheticBasic,
      );
    } finally {
      await restored.close();
    }
  });
});

test("Store rejects incompatible replacement DB secret fields without changing bytes or revision", async () => {
  await temporary(async (store) => {
    const saved = await store.saveConnection(
      database(),
      syntheticBasic,
      false,
      0,
    );
    const before = await snapshot(store);
    await assert.rejects(
      store.saveConnection(
        {
          ...database(),
          config: { ...database().config, user: "next-business-user" },
        },
        { token: "synthetic-invalid-db-token" },
        false,
        saved.revision,
      ),
      /DB_CREDENTIALS_INVALID/,
    );
    await unchanged(store, before);
  });
});

test("Store replacement and clear select the effective persisted credentials and survive restart", async () => {
  await temporary(async (store, master) => {
    await store.saveConnection(registry("basic"), syntheticBasic, false, 0);
    const bearer = { token: "synthetic-replacement-bearer" };
    const replacement = await store.saveConnection(
      registry("bearer"),
      bearer,
      false,
      1,
    );
    assert.equal(replacement.revision, 2);
    assertPublic(replacement, bearer);
    assert.deepEqual(
      store.unsealCredentials(
        store.connection("registry", "REG_TRANSITION").sealed!,
      ),
      bearer,
    );
    // Clear wins explicitly, including when a stale UI input is still present.
    const cleared = await store.saveConnection(
      registry("none"),
      syntheticBasic,
      true,
      2,
    );
    assert.equal(cleared.hasSecret, false);
    assert.equal(cleared.revision, 3);
    assert.equal(
      store.connection("registry", "REG_TRANSITION").sealed,
      undefined,
    );
    const restored = await reopen(store, master);
    try {
      assert.equal(
        restored.connection("registry", "REG_TRANSITION").sealed,
        undefined,
      );
      assert.equal(
        restored.connection("registry", "REG_TRANSITION").config.authType,
        "none",
      );
    } finally {
      await restored.close();
    }
  });
});

test("Store protocol changes still require explicit replacement or clear and both paths reload", async () => {
  await temporary(async (store, master) => {
    await store.saveConnection(database(), syntheticBasic, false, 0);
    const replacement = { password: "synthetic-next-db-password" };
    await store.saveConnection(database("mysql"), replacement, false, 1);
    assert.deepEqual(
      store.unsealCredentials(
        store.connection("mysql", "DB_TRANSITION").sealed!,
      ),
      replacement,
    );
    await store.saveConnection(database("postgres"), undefined, true, 2);
    assert.equal(
      store.connection("postgres", "DB_TRANSITION").sealed,
      undefined,
    );
    const restored = await reopen(store, master);
    try {
      assert.equal(
        restored.connection("postgres", "DB_TRANSITION").revision,
        3,
      );
      assert.equal(
        restored.connection("postgres", "DB_TRANSITION").sealed,
        undefined,
      );
    } finally {
      await restored.close();
    }
  });
});

test("Store rejects implicit Docker Basic-to-none credential retention and filters combined Basic forms", async () => {
  await temporary(async (store) => {
    const docker: Connection = {
      alias: "DOCKER_TRANSITION",
      name: "Temporary metadata",
      kind: "docker",
      enabled: true,
      description: "No server",
      config: { endpoint: "https://docker.example.com", auth: "basic" },
    };
    await store.saveConnection(docker, syntheticBasic, false, 0);
    const before = await snapshot(store);
    await assert.rejects(
      store.saveConnection(
        { ...docker, config: { ...docker.config, auth: "none" } },
        undefined,
        false,
        1,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "SECRET_REQUIRED",
    );
    await unchanged(store, before);
    const raw = `${syntheticBasic.username}:${syntheticBasic.password}`,
      bare = Buffer.from(raw).toString("base64");
    assert.ok(store.secrets().includes(bare));
    assert.equal(
      redact(`bare=${bare}; header=Basic ${bare}; raw=${raw}`, store.secrets()),
      "bare=[REDACTED]; header=[REDACTED]; raw=[REDACTED]",
    );
  });
});
