import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalRuntime, loadLocalStore } from "../src/local-state.js";
import { Store } from "../src/store.js";
import { AppError, type Platform } from "../src/schema.js";

const fixturePlatform: Platform = {
  alias: "MOCK",
  name: "Synthetic API",
  baseUrl: "https://example.com",
  auth: { type: "bearer" },
  enabled: true,
  allowInsecureLocal: false,
  description: "Synthetic fixture only",
  rules: [{ method: "POST", path: "/write" }],
};
async function temporary(work: (dir: string) => Promise<void>) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-state-"),
  );
  try {
    await work(path.join(parent, "private"));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof AppError && error.code === expected;
}
async function diskSnapshot(dir: string): Promise<unknown> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        return [
          entry.name,
          entry.isDirectory()
            ? await diskSnapshot(file)
            : (await fs.readFile(file)).toString("base64"),
        ];
      }),
  );
}

test("local execution does not initialize an absent configuration or repair an existing empty directory", async () => {
  await temporary(async (dir) => {
    await assert.rejects(
      loadLocalStore({ dir, readOnly: true }),
      code("CONFIG_REQUIRED"),
    );
    await assert.rejects(fs.access(dir));
    await fs.mkdir(dir, { mode: 0o700 });
    await assert.rejects(loadLocalStore({ dir }), code("CONFIG_REQUIRED"));
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("trusted installer bootstrap initializes only a private empty directory or its secure empty tmp", async () => {
  for (const withTemporary of [false, true]) {
    await temporary(async (dir) => {
      await fs.mkdir(dir, { mode: 0o700 });
      if (withTemporary) await fs.mkdir(path.join(dir, "tmp"), { mode: 0o700 });
      const runtime = await loadLocalRuntime({
        dir,
        initializeEmptyDirectory: true,
      });
      await runtime.store.close();
      const before = await fs.readFile(path.join(dir, "service.env"));
      const reopened = await loadLocalRuntime({
        dir,
        initializeEmptyDirectory: true,
      });
      await reopened.store.close();
      assert.deepEqual(
        await fs.readFile(path.join(dir, "service.env")),
        before,
      );
    });
  }
  for (const entry of ["foreign", "tmp", "data", "AppData"]) {
    await temporary(async (dir) => {
      await fs.mkdir(dir, { mode: 0o700 });
      if (entry === "tmp") {
        await fs.mkdir(path.join(dir, "tmp"), { mode: 0o700 });
        await fs.writeFile(path.join(dir, "tmp", "existing"), "public fixture");
      } else if (entry === "data") {
        // Losing service.env must never turn existing application state into a
        // fresh installation, even with the trusted bootstrap flag.
        await fs.mkdir(path.join(dir, entry), { mode: 0o700 });
        await fs.writeFile(path.join(dir, entry, "state.json"), "public fixture");
      } else await fs.writeFile(path.join(dir, entry), "public fixture");
      const before = await diskSnapshot(dir);
      await assert.rejects(
        loadLocalRuntime({ dir, initializeEmptyDirectory: true }),
      );
      await assert.rejects(fs.access(path.join(dir, "service.env")));
      assert.deepEqual(await diskSnapshot(dir), before);
    });
  }
});

test("local configuration creates private bootstrap exactly once, and concurrent readers never take the writer lock", async () => {
  await temporary(async (dir) => {
    const writer = await loadLocalRuntime({ dir });
    const readers: Store[] = [];
    try {
      assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
      assert.equal(
        (await fs.stat(path.join(dir, "service.env"))).mode & 0o777,
        0o600,
      );
      assert.equal((await fs.stat(writer.store.dir)).mode & 0o777, 0o700);
      assert.equal(writer.store.list().length, 0);
      const before = await diskSnapshot(dir);
      readers.push(
        ...(await Promise.all(
          Array.from({ length: 6 }, () =>
            loadLocalStore({ dir, readOnly: true }),
          ),
        )),
      );
      assert.deepEqual(
        readers.map((reader) => reader.discovery()),
        readers.map(() => writer.store.discovery()),
      );
      for (const reader of readers)
        await assert.rejects(
          reader.save(fixturePlatform, undefined, false, 0),
          code("LOCAL_READ_ONLY"),
        );
      await Promise.all(readers.map((reader) => reader.close()));
      assert.deepEqual(await diskSnapshot(dir), before);
      const config = await fs.readFile(path.join(dir, "service.env"));
      await writer.store.close();
      const reopened = await loadLocalRuntime({ dir });
      try {
        assert.deepEqual(
          await fs.readFile(path.join(dir, "service.env")),
          config,
        );
        assert.equal(reopened.store.list().length, 0);
      } finally {
        await reopened.store.close();
      }
    } finally {
      await Promise.all(readers.map((reader) => reader.close()));
      await writer.store.close();
    }
  });
});

test("read-only Store validates and scrubs only its memory while preserving the authoritative state and document files", async () => {
  await temporary(async (dir) => {
    const master = crypto.randomBytes(32).toString("hex");
    const syntheticSecret = "synthetic-only-provider-secret-0042";
    const writer = new Store(dir, master);
    await writer.init();
    try {
      await writer.save(fixturePlatform, { value: syntheticSecret }, false, 0);
      await writer.saveDoc(
        "MOCK",
        {
          title: "Public docs",
          sourceUrl: "https://example.com/docs",
          markdown: "Public original",
        },
        "manual",
      );
      const state = structuredClone(writer.state);
      state.docs[0].markdown = `Untrusted documentation ${syntheticSecret}`;
      await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state), {
        mode: 0o600,
      });
      const before = await diskSnapshot(dir);
      const reader = new Store(dir, master, [], { readOnly: true });
      try {
        await reader.init();
        assert.ok(reader.state.docs[0].markdown.includes("[REDACTED]"));
        assert.ok(
          !JSON.stringify(reader.discovery()).includes(syntheticSecret),
        );
        assert.deepEqual(await diskSnapshot(dir), before);
        await assert.rejects(reader.remove("MOCK", 1), code("LOCAL_READ_ONLY"));
      } finally {
        await reader.close();
      }
      assert.deepEqual(await diskSnapshot(dir), before);
      const wrongMaster = new Store(dir, "b".repeat(64), [], {
        readOnly: true,
      });
      try {
        await assert.rejects(wrongMaster.init(), /配置或主密钥无效/);
      } finally {
        await wrongMaster.close();
      }
      assert.deepEqual(await diskSnapshot(dir), before);
    } finally {
      await writer.close();
    }
  });
});

test("local runtime refuses unsafe paths, duplicated configuration and inherited service policy without leaking contents", async () => {
  await temporary(async (dir) => {
    const runtime = await loadLocalRuntime({ dir });
    await runtime.store.close();
    const file = path.join(dir, "service.env");
    const original = await fs.readFile(file, "utf8");
    for (const invalid of [
      original + "ABILOCK_ALLOW_LOCAL=1\n",
      original + "ABILOCK_MASTER_KEY=" + "b".repeat(64) + "\n",
      original.replace(
        "ABILOCK_ADMIN_HOST=127.0.0.1",
        "ABILOCK_ADMIN_HOST=0.0.0.0",
      ),
      original.replace(
        JSON.stringify(path.join(dir, "data")),
        JSON.stringify(os.tmpdir()),
      ),
    ]) {
      await fs.writeFile(file, invalid);
      await assert.rejects(
        loadLocalStore({ dir, readOnly: true }),
        code("LOCAL_CONFIG_INVALID"),
      );
      assert.equal(await fs.readFile(file, "utf8"), invalid);
    }
    await fs.writeFile(file, original);
    process.env.ABILOCK_LOCAL_SYNTHETIC_POLICY = "synthetic-unused-value";
    try {
      await assert.rejects(
        loadLocalStore({ dir, readOnly: true }),
        code("LOCAL_ENV_CONFLICT"),
      );
    } finally {
      delete process.env.ABILOCK_LOCAL_SYNTHETIC_POLICY;
    }
    const outside = path.join(path.dirname(dir), "outside.env");
    await fs.writeFile(outside, original, { mode: 0o600 });
    await fs.unlink(file);
    await fs.symlink(outside, file);
    await assert.rejects(
      loadLocalStore({ dir, readOnly: true }),
      code("LOCAL_CONFIG_INVALID"),
    );
    await fs.unlink(file);
    await fs.writeFile(file, original, { mode: 0o600 });
    const state = path.join(dir, "data/state.json");
    const outsideState = path.join(path.dirname(dir), "outside-state.json");
    await fs.writeFile(outsideState, await fs.readFile(state), { mode: 0o600 });
    await fs.unlink(state);
    await fs.symlink(outsideState, state);
    await assert.rejects(
      loadLocalStore({ dir, readOnly: true }),
      code("LOCAL_CONFIG_INVALID"),
    );
  });
});
