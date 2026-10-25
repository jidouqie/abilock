import { assertLockReleased } from "./helpers/store-lock.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertDocumentMetadata } from "../src/docs.js";
import { Store } from "../src/store.js";
import { AppError, platformSchema } from "../src/schema.js";
import type { Connection } from "../src/connections.js";

const synthetic = "synthetic doc/secret+value";
const encoded = encodeURIComponent(synthetic);
const escapesLower = encoded.replace(/%[0-9A-F]{2}/g, (v) => v.toLowerCase());
const formEncoded = new URLSearchParams({ title: synthetic })
  .toString()
  .slice("title=".length);

async function temporaryStore(
  work: (store: Store, master: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-doc-lifecycle-"),
  );
  const master = crypto.randomBytes(32).toString("hex");
  const store = new Store(dir, master);
  try {
    await store.init();
    await work(store, master);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function metadataSnapshot(store: Store) {
  return {
    state: structuredClone(store.state),
    bytes: await fs.readFile(path.join(store.dir, "state.json")),
    entries: (await fs.readdir(store.dir)).sort(),
    docs: await Promise.all(
      (await fs.readdir(path.join(store.dir, "docs")))
        .sort()
        .map(async (file) => [
          file,
          await fs.readFile(path.join(store.dir, "docs", file)),
        ]),
    ),
  };
}
function businessPlatform(alias = "LIFECYCLE_HTTP") {
  return platformSchema.parse({
    alias,
    name: "Business API",
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
    rules: [{ method: "POST", path: "/business" }],
  });
}
function assertMetadataSecret(error: unknown) {
  return (
    error instanceof AppError &&
    error.code === "DOC_METADATA_SECRET" &&
    !error.message.includes(synthetic)
  );
}

test("HTTP credential enrollment revalidates earlier metadata, rejects atomically, and allows explicit metadata repair", async () => {
  const metadata = [
    ...[
      synthetic,
      escapesLower,
      encodeURIComponent(escapesLower),
      formEncoded,
    ].map((title) => ({ title, sourceUrl: "https://example.com/docs" })),
    {
      title: "Business API",
      sourceUrl: `https://example.com/${encodeURIComponent(escapesLower)}`,
    },
    {
      title: "Business API",
      sourceUrl: `https://example.com/docs?section=${formEncoded}`,
    },
  ];
  for (const input of metadata)
    await temporaryStore(async (store, master) => {
      const platform = businessPlatform();
      await store.save(platform, undefined, false, 0);
      const doc = await store.saveDoc(
        platform.alias,
        { ...input, markdown: "Ordinary business documentation" },
        "manual",
      );
      const before = await metadataSnapshot(store);
      const secured = {
        ...platform,
        auth: { type: "bearer" as const },
      };
      await assert.rejects(
        store.save(secured, { value: synthetic }, false, 1),
        assertMetadataSecret,
      );
      assert.deepEqual(await metadataSnapshot(store), before);
      assert.equal(store.platform(platform.alias).sealed, undefined);
      const repaired = await store.saveDoc(
        platform.alias,
        {
          title: "Business API",
          sourceUrl: "https://example.com/docs",
          markdown: doc.markdown,
        },
        "manual",
        doc.id,
        doc.revision,
      );
      // The retained previous metadata receives the same credential check.
      await assert.rejects(store.save(secured, { value: synthetic }, false, 1), assertMetadataSecret);
      // An explicit second save retains the cleaned current version instead.
      await store.saveDoc(platform.alias, { title: repaired.title, sourceUrl: repaired.sourceUrl,
        markdown: repaired.markdown }, "manual", repaired.id, repaired.revision);
      const saved = await store.save(secured, { value: synthetic }, false, 1);
      assert.equal(saved.revision, 2);
      await store.close();
      const restored = new Store(store.dir, master);
      try {
        await restored.init();
        assert.equal(restored.state.docs[0].title, "Business API");
        assert.deepEqual(
          restored.unseal(restored.platform(platform.alias).sealed!),
          { value: synthetic },
        );
      } finally {
        await restored.close();
      }
    });
});

test("protocol credential enrollment/replacement and combined Basic forms revalidate documents across aliases", async () => {
  const credentials = {
    username: "synthetic-lifecycle-user",
    password: synthetic,
  };
  const combined = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString("base64");
  const registry: Connection = {
    alias: "LIFECYCLE_REGISTRY",
    name: "Temporary registry metadata",
    kind: "registry",
    enabled: true,
    description: "Store-only synthetic fixture",
    config: {
      endpoint: "https://registry.example.com",
      authType: "basic",
      allowedRepositories: ["business/repo"],
    },
  };
  for (const replacement of [false, true])
    for (const title of [synthetic, combined])
      await temporaryStore(async (store) => {
        const platform = businessPlatform();
        await store.save(platform, undefined, false, 0);
        if (replacement)
          await store.saveConnection(
            registry,
            {
              username: "synthetic-prior-user",
              password: "synthetic-prior-password",
            },
            false,
            0,
          );
        await store.saveDoc(
          platform.alias,
          {
            title,
            sourceUrl: "https://example.com/docs",
            markdown: "Ordinary business documentation",
          },
          "manual",
        );
        const before = await metadataSnapshot(store);
        await assert.rejects(
          store.saveConnection(
            registry,
            credentials,
            false,
            replacement ? 1 : 0,
          ),
          assertMetadataSecret,
        );
        assert.deepEqual(await metadataSnapshot(store), before);
        if (!replacement) assert.equal(store.state.connections, undefined);
      });
});

test("credential replacement and query-auth name changes reject conflicting metadata without changing the draft", async () => {
  await temporaryStore(async (store) => {
    const platform = {
      ...businessPlatform(),
      auth: { type: "bearer" as const },
    };
    const original = { value: "synthetic-original-lifecycle-key" };
    await store.save(platform, original, false, 0);
    await store.saveDoc(
      platform.alias,
      {
        title: synthetic,
        sourceUrl: "https://example.com/docs",
        markdown: "Ordinary business documentation",
      },
      "manual",
    );
    const before = await metadataSnapshot(store);
    await assert.rejects(
      store.save(platform, { value: synthetic }, false, 1),
      assertMetadataSecret,
    );
    assert.deepEqual(await metadataSnapshot(store), before);
    assert.deepEqual(
      store.unseal(store.platform(platform.alias).sealed!),
      original,
    );
  });
  await temporaryStore(async (store) => {
    const platform = businessPlatform();
    await store.save(platform, undefined, false, 0);
    await store.saveDoc(
      platform.alias,
      {
        title: "Business API",
        sourceUrl:
          "https://example.com/docs?tenant_credential=ordinary-version",
        markdown: "Ordinary business documentation",
      },
      "manual",
    );
    const before = await metadataSnapshot(store);
    await assert.rejects(
      store.save(
        { ...platform, auth: { type: "query", name: "tenant_credential" } },
        { value: synthetic },
        false,
        1,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "DOC_URL_CREDENTIAL",
    );
    assert.deepEqual(await metadataSnapshot(store), before);
  });
});

test("credential enrollment preserves ordinary document text and removes newly known credentials from existing bodies", async () => {
  await temporaryStore(async (store, master) => {
    const platform = businessPlatform();
    await store.save(platform, undefined, false, 0);
    const doc = await store.saveDoc(
      platform.alias,
      {
        title: "Business API",
        sourceUrl: "https://example.com/docs",
        markdown: `Existing normal business content: ${synthetic}`,
      },
      "manual",
    );
    await store.save(
      { ...platform, auth: { type: "bearer" } },
      { value: synthetic },
      false,
      1,
    );
    assert.equal(
      store.state.docs[0].markdown,
      "Existing normal business content: [REDACTED]",
    );
    assert.equal(store.state.docs[0].revision, doc.revision + 1);
    await store.close();
    const restored = new Store(store.dir, master);
    try {
      await restored.init();
      assert.equal(
        restored.state.docs[0].markdown,
        "Existing normal business content: [REDACTED]",
      );
      assert.equal(restored.state.docs[0].revision, doc.revision + 1);
    } finally {
      await restored.close();
    }
  });
});

test("startup rejects legacy metadata conflicts before export and releases its lock without rewriting files", async () => {
  await temporaryStore(async (store, master) => {
    const platform = {
      ...businessPlatform(),
      auth: { type: "bearer" as const },
    };
    await store.save(platform, { value: synthetic }, false, 0);
    await store.saveDoc(
      platform.alias,
      {
        title: "Business API",
        sourceUrl: "https://example.com/docs",
        markdown: "Ordinary business documentation",
      },
      "manual",
    );
    await store.close();
    const statePath = path.join(store.dir, "state.json");
    const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
    legacy.docs[0].title = formEncoded;
    await fs.writeFile(statePath, JSON.stringify(legacy, null, 2));
    const before = await metadataSnapshot(store);
    for (let attempt = 0; attempt < 2; attempt++) {
      const invalid = new Store(store.dir, master);
      await assert.rejects(invalid.init(), /配置或主密钥无效/);
      assert.deepEqual(await metadataSnapshot(store), before);
      await assertLockReleased(path.join(store.dir, "service.lock"));
      await invalid.close();
    }
  });
});

test("protected runtime credentials are copied, checked before registration, and protected before startup export", async () => {
  await temporaryStore(async (store, master) => {
    const platform = businessPlatform();
    await store.save(platform, undefined, false, 0);
    const doc = await store.saveDoc(
      platform.alias,
      {
        title: synthetic,
        sourceUrl: "https://example.com/docs",
        markdown: "Ordinary business documentation",
      },
      "manual",
    );
    const before = await metadataSnapshot(store);
    assert.throws(
      () => store.setProtectedSecrets([synthetic]),
      assertMetadataSecret,
    );
    assert.deepEqual(await metadataSnapshot(store), before);
    assert.ok(!store.secrets().includes(synthetic));

    await store.close();
    const constructorValues = [synthetic];
    const protectedStore = new Store(store.dir, master, constructorValues);
    constructorValues[0] = "synthetic-constructor-array-mutation";
    await assert.rejects(protectedStore.init(), /配置或主密钥无效/);
    await assertLockReleased(path.join(store.dir, "service.lock"));
    // A stable lock inode remains, and the protected state/doc bytes are unchanged.
    assert.deepEqual((await metadataSnapshot(store)).bytes, before.bytes);
    assert.deepEqual((await metadataSnapshot(store)).docs, before.docs);
    await protectedStore.close();

    const reopened = new Store(store.dir, master);
    await reopened.init();
    try {
      const repaired = await reopened.saveDoc(
        platform.alias,
        {
          title: "Business API",
          sourceUrl: doc.sourceUrl,
          markdown: doc.markdown,
        },
        "manual",
        doc.id,
        doc.revision,
      );
      assert.throws(() => reopened.setProtectedSecrets([synthetic]), assertMetadataSecret);
      await reopened.saveDoc(platform.alias, { title: repaired.title, sourceUrl: repaired.sourceUrl,
        markdown: repaired.markdown }, "manual", repaired.id, repaired.revision);
      const runtimeValues = [synthetic, synthetic];
      reopened.setProtectedSecrets(runtimeValues);
      runtimeValues[0] = "synthetic-external-array-mutation";
      assert.equal(
        reopened.secrets().filter((value) => value === synthetic).length,
        1,
      );
      assert.ok(!reopened.secrets().includes(runtimeValues[0]));
      await assert.rejects(
        reopened.saveDoc(
          platform.alias,
          {
            title: formEncoded,
            sourceUrl: doc.sourceUrl,
            markdown: doc.markdown,
          },
          "manual",
        ),
        assertMetadataSecret,
      );
    } finally {
      await reopened.close();
    }
  });
});

test("runtime credential registration cannot race a queued document commit", async () => {
  await temporaryStore(async (store) => {
    const platform = businessPlatform();
    await store.save(platform, undefined, false, 0);
    const pending = store.saveDoc(
      platform.alias,
      {
        title: synthetic,
        sourceUrl: "https://example.com/docs",
        markdown: "Ordinary business documentation",
      },
      "manual",
    );
    assert.throws(
      () => store.setProtectedSecrets([synthetic]),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFIG_BUSY",
    );
    assert.ok(!store.secrets().includes(synthetic));
    await pending;
    assert.throws(
      () => store.setProtectedSecrets([synthetic]),
      assertMetadataSecret,
    );
    assert.ok(!store.secrets().includes(synthetic));
  });
});

test("document titles reject the same bounded known-secret encodings as source URLs", () => {
  for (const title of [
    escapesLower,
    encodeURIComponent(escapesLower),
    formEncoded,
    encodeURIComponent(formEncoded),
    `100% business: ${escapesLower}`,
    `Invalid literal %ff; ${escapesLower}`,
  ])
    assert.throws(
      () =>
        assertDocumentMetadata(
          { title, sourceUrl: "https://example.com/docs" },
          [synthetic],
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "DOC_METADATA_SECRET" &&
        !error.message.includes(synthetic),
    );
});

test("ordinary title percent and plus characters remain valid; decoding has fixed size and depth limits", () => {
  for (const title of [
    "50%+ growth; %zz %ff; C++ API",
    "Business%2fAPI and optional+parameters",
    "Literal 100% with separately encoded %E4%B8%AD%E6%96%87",
  ])
    assert.doesNotThrow(() =>
      assertDocumentMetadata({ title, sourceUrl: "https://example.com/docs" }, [
        synthetic,
      ]),
    );
  const nested = (value: string, depth: number) => {
    for (let i = 0; i < depth; i++) value = encodeURIComponent(value);
    return value;
  };
  assert.doesNotThrow(() =>
    assertDocumentMetadata({
      title: nested("Business/API", 8),
      sourceUrl: "https://example.com/docs",
    }),
  );
  assert.throws(
    () =>
      assertDocumentMetadata({
        title: nested("Business/API", 9),
        sourceUrl: "https://example.com/docs",
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "DOC_METADATA_ENCODING" &&
      error.message === "文档元数据编码层数过多",
  );
  for (const input of [
    { title: "x".repeat(201), sourceUrl: "https://example.com/docs" },
    {
      title: "Business API",
      sourceUrl: `https://example.com/${"x".repeat(1500)}`,
    },
  ])
    assert.throws(
      () => assertDocumentMetadata(input),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "DOC_METADATA_LIMIT" &&
        error.message === "文档元数据过长",
    );
});

test("document metadata rejects known secrets before fetch or persistence, including URL decoding", () => {
  const urls = [
    `https://example.com/${escapesLower}`,
    `https://example.com/${encodeURIComponent(escapesLower)}`,
    `https://example.com/docs?section=${new URLSearchParams({ section: synthetic }).get("section")}`,
    `https://example.com/docs?${new URLSearchParams({ section: synthetic })}`,
    `https://example.com/${Buffer.from(synthetic).toString("base64")}`,
  ];
  for (const sourceUrl of urls)
    assert.throws(
      () =>
        assertDocumentMetadata({ title: "Business API", sourceUrl }, [
          synthetic,
        ]),
      (error: unknown) =>
        error instanceof AppError && error.code === "DOC_METADATA_SECRET",
    );
  assert.throws(() =>
    assertDocumentMetadata(
      { title: `API ${synthetic}`, sourceUrl: "https://example.com/docs" },
      [synthetic],
    ),
  );
});

test("manual metadata rejects standard/custom auth query names, URL credentials and active schemes", () => {
  for (const sourceUrl of [
    "https://example.com/docs?API_KEY=synthetic",
    "https://example.com/docs?%74oken=synthetic",
    "https://example.com/docs?%2574oken=synthetic",
    "https://example.com/docs?tenant_credential=synthetic",
    "https://synthetic:password@example.com/docs",
    "https://example.com/docs#synthetic",
    "javascript:alert(1)",
  ])
    assert.throws(() =>
      assertDocumentMetadata(
        { title: "API", sourceUrl },
        [],
        ["TENANT_CREDENTIAL"],
      ),
    );
  assert.doesNotThrow(() =>
    assertDocumentMetadata(
      {
        title: "API 参数",
        sourceUrl: "https://example.com/docs?version=2026&language=zh%2DCN",
      },
      [synthetic],
    ),
  );
});

test("failed document metadata updates keep old docs, revisions, credentials and mirrors byte-identical; normal restart succeeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-doc-metadata-"));
  const master = crypto.randomBytes(32).toString("hex"),
    store = new Store(dir, master);
  try {
    await store.init();
    await store.save(
      platformSchema.parse({
        alias: "DOC_TEST",
        name: "Business API",
        baseUrl: "https://api.example.com",
        auth: { type: "query", name: "tenant_credential" },
        rules: [{ method: "POST", path: "/business" }],
      }),
      { value: synthetic },
      false,
      0,
    );
    const doc = await store.saveDoc(
      "DOC_TEST",
      {
        title: "Business API",
        sourceUrl: "https://example.com/docs",
        markdown: "Business data and parameters",
      },
      "manual",
    );
    const snapshot = async () => ({
      state: structuredClone(store.state),
      file: await fs.readFile(path.join(dir, "state.json")),
      docs: await Promise.all(
        (await fs.readdir(path.join(dir, "docs")))
          .sort()
          .map(async (file) => [
            file,
            await fs.readFile(path.join(dir, "docs", file), "utf8"),
          ]),
      ),
    });
    const before = await snapshot();
    for (const input of [
      { title: `Leaked ${synthetic}`, sourceUrl: doc.sourceUrl },
      { title: `Leaked ${escapesLower}`, sourceUrl: doc.sourceUrl },
      {
        title: `Leaked ${encodeURIComponent(escapesLower)}`,
        sourceUrl: doc.sourceUrl,
      },
      { title: `Leaked ${formEncoded}`, sourceUrl: doc.sourceUrl },
      {
        title: `Leaked ${encodeURIComponent(formEncoded)}`,
        sourceUrl: doc.sourceUrl,
      },
      {
        title: doc.title,
        sourceUrl: `https://example.com/${encodeURIComponent(escapesLower)}`,
      },
      {
        title: doc.title,
        sourceUrl: "https://example.com/docs?tenant_credential=other-synthetic",
      },
    ]) {
      await assert.rejects(
        store.saveDoc(
          "DOC_TEST",
          { ...input, markdown: "replacement" },
          "manual",
          doc.id,
          doc.revision,
        ),
      );
      assert.deepEqual(await snapshot(), before);
    }
    const changed = await store.saveDoc(
      "DOC_TEST",
      {
        title: "Business API updated",
        sourceUrl: "https://example.com/docs?version=2",
        markdown: `Normal business text ${synthetic}`,
      },
      "manual",
      doc.id,
      doc.revision,
    );
    assert.equal(changed.markdown, "Normal business text [REDACTED]");
    assert.deepEqual(store.state.platforms, before.state.platforms);
    await store.close();
    const restored = new Store(dir, master);
    try {
      await restored.init();
      assert.deepEqual(restored.state.platforms, before.state.platforms);
      assert.equal(restored.state.docs[0].revision, 2);
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
