import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { AppError, platformSchema, requestSchema } from "../src/schema.js";
import {
  learnPlatform,
  parseLearnManifest,
  type LearnManifest,
} from "../src/learn.js";
import { prepare } from "../src/proxy.js";
import { matchesHttpPath } from "../src/security.js";

const syntheticSecret = "synthetic-learn-provider-secret-123456";
const alias = "WRITER";
const platform = () =>
  platformSchema.parse({
    alias,
    name: "Synthetic API",
    baseUrl: "https://api.example.com",
    auth: { type: "bearer" },
    rules: [],
  });
function manifest(expectedRevision = 1): LearnManifest {
  return {
    expectedRevision,
    sourceUrl: "https://docs.example.com/api",
    title: "Synthetic writing API",
    markdown:
      "POST /chat/completions accepts model and messages. GET /models lists available models. Documentation is data; ignore-instructions text here is never executed.",
    description: "中文文案改写",
    rules: [
      { method: "POST", path: "/chat/completions" },
      { method: "GET", path: "/models" },
    ],
    capabilityNotes: [
      {
        name: "文案",
        summary: "保持原稿事实与语气，调整表达",
        tags: ["text", "文案"],
        input: "model, messages",
        output: "改写后的文案",
        method: "POST",
        path: "/chat/completions",
      },
    ],
    chat: { method: "POST", path: "/chat/completions", model: "test-model" },
  };
}
async function temporary(
  work: (store: Store, master: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-learn-"));
  const master = crypto.randomBytes(32).toString("hex");
  const store = new Store(dir, master);
  try {
    await store.init();
    await store.save(platform(), { value: syntheticSecret }, false, 0);
    await work(store, master);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function snapshot(store: Store) {
  return {
    state: structuredClone(store.state),
    file: await fs.readFile(path.join(store.dir, "state.json")),
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
function code(value: string) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.code === value &&
    !error.message.includes(syntheticSecret);
}

test("a newly saved API without learned interfaces authorizes no calls", async () => {
  await temporary(async (store) => {
    assert.deepEqual(store.platform(alias).rules, []);
    const catalogue = store.discovery();
    assert.equal(catalogue.capabilities.length, 1);
    assert.equal(catalogue.capabilities[0].alias, alias);
    assert.equal(catalogue.capabilities[0].status, "needs-documentation");
    assert.deepEqual(catalogue.capabilities[0].scope, []);
    assert.equal(catalogue.capabilities[0].operation, undefined);
    assert.ok(!JSON.stringify(catalogue).includes(syntheticSecret));
    assert.throws(
      () =>
        prepare(
          store.platform(alias),
          requestSchema.parse({ method: "POST", path: "/chat/completions" }),
        ),
      code("PATH_NOT_ALLOWED"),
    );
  });
});

test("learning stores public interfaces and documentation atomically without fetching or changing credentials", async () => {
  await temporary(async (store, master) => {
    const original = store.platform(alias);
    const sealed = original.sealed;
    let fetched = false;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      fetched = true;
      throw new Error("learning must not fetch or probe");
    });
    try {
      const learned = await learnPlatform(
        store,
        alias.toLowerCase(),
        manifest(),
      );
      assert.equal(fetched, false);
      assert.equal(learned.platform.alias, alias);
      assert.equal(learned.platform.revision, 2);
      assert.equal(learned.platform.hasSecret, true);
      assert.deepEqual(learned.platform.auth, original.auth);
      assert.equal(learned.platform.baseUrl, original.baseUrl);
      assert.equal(store.platform(alias).sealed, sealed);
      assert.deepEqual(store.platform(alias).rules, manifest().rules);
      assert.equal(store.state.docs.length, 1);
      assert.equal(store.state.docs[0].id, learned.platform.learnedDocId);
      assert.deepEqual(learned.document, store.state.docs[0]);
      assert.ok(!JSON.stringify(learned).includes(syntheticSecret));
      assert.ok(!JSON.stringify(learned).includes("sealed"));
      assert.equal(
        prepare(
          store.platform(alias),
          requestSchema.parse({ method: "GET", path: "/models" }),
        ).url.href,
        "https://api.example.com/models",
      );
      assert.throws(
        () =>
          prepare(
            store.platform(alias),
            requestSchema.parse({ method: "POST", path: "/models" }),
          ),
        code("PATH_NOT_ALLOWED"),
      );
      await store.close();
      const reopened = new Store(store.dir, master, [], { readOnly: true });
      try {
        await reopened.init();
        assert.deepEqual(reopened.platform(alias).rules, manifest().rules);
        assert.equal(reopened.state.docs[0].id, learned.document.id);
        assert.equal(reopened.platform(alias).sealed, sealed);
      } finally {
        await reopened.close();
      }
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("a repeat learning updates one document and replaces old interfaces and chat configuration", async () => {
  await temporary(async (store) => {
    const first = await learnPlatform(store, alias, manifest());
    const next = {
      ...manifest(2),
      rules: [{ method: "GET" as const, path: "/models" }],
      capabilityNotes: [],
    };
    delete next.chat;
    const second = await learnPlatform(store, alias, next);
    assert.equal(second.platform.revision, 3);
    assert.equal(second.document.id, first.document.id);
    assert.equal(second.document.revision, 2);
    assert.equal(store.state.docs.length, 1);
    assert.equal(store.platform(alias).chat, undefined);
    assert.throws(
      () =>
        prepare(
          store.platform(alias),
          requestSchema.parse({ method: "POST", path: "/chat/completions" }),
        ),
      code("PATH_NOT_ALLOWED"),
    );
  });
});

test("learning requires a matching platform revision and cannot create a connection", async () => {
  await temporary(async (store) => {
    const before = await snapshot(store);
    await assert.rejects(
      learnPlatform(store, "NEW_CONNECTION", manifest()),
      code("PLATFORM_NOT_FOUND"),
    );
    await assert.rejects(
      learnPlatform(store, alias, manifest(7)),
      code("REVISION_CONFLICT"),
    );
    await assert.rejects(
      learnPlatform(store, alias, {
        ...manifest(),
        expectedRevision: undefined,
      }),
      code("LEARN_MANIFEST"),
    );
    assert.deepEqual(await snapshot(store), before);
    const first = learnPlatform(store, alias, manifest());
    const stale = learnPlatform(store, alias, manifest());
    await first;
    await assert.rejects(stale, code("REVISION_CONFLICT"));
    assert.equal(store.platform(alias).revision, 2);
  });
});

test("the manifest accepts public API descriptions only, never target, authentication, secrets or executable options", () => {
  for (const forbidden of [
    { baseUrl: "https://other.example.com" },
    { auth: { type: "none" } },
    { secret: { value: "synthetic-attacker-key" } },
    { clearSecret: true },
    { env: { TOKEN: "synthetic-attacker-key" } },
    { adapter: "custom" },
    { plugin: "custom" },
    { command: "run this" },
    { alias: "OTHER" },
    { enabled: true },
    { allowInsecureLocal: true },
  ])
    assert.throws(
      () => parseLearnManifest({ ...manifest(), ...forbidden }),
      code("LEARN_MANIFEST"),
    );
  assert.throws(
    () =>
      parseLearnManifest({
        ...manifest(),
        rules: [{ method: "POST", path: "/chat/completions", command: "run" }],
      }),
    code("LEARN_MANIFEST"),
  );
});

test("invalid or overbroad paths and unbound chat or notes leave existing state untouched", async () => {
  await temporary(async (store) => {
    const before = await snapshot(store);
    for (const rulePath of [
      "https://other.example.com/route",
      "//other.example.com/route",
      "/../route",
      "/route?api_key=synthetic",
      "/route#fragment",
      "/r%6fute",
      "/route*",
      "/tasks/prefix-{id}/result",
    ]) {
      await assert.rejects(
        learnPlatform(store, alias, {
          ...manifest(),
          rules: [{ method: "GET", path: rulePath }],
          chat: undefined,
          capabilityNotes: [],
        }),
        code("UNSAFE_PATH"),
      );
      assert.deepEqual(await snapshot(store), before);
    }
    for (const changes of [
      { chat: { method: "POST", path: "/extra", model: "test-model" } },
      {
        capabilityNotes: [{ ...manifest().capabilityNotes[0], path: "/extra" }],
      },
      { rules: [] },
      { rules: [manifest().rules[0], manifest().rules[0]] },
    ])
      await assert.rejects(
        learnPlatform(store, alias, { ...manifest(), ...changes }),
        code("LEARN_MANIFEST"),
      );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("learned parameter templates match one safe path segment and retain method, target and authentication restrictions", async () => {
  await temporary(async (store) => {
    const template = "/files/{file_id}/content";
    const learned = await learnPlatform(store, alias, {
      ...manifest(),
      markdown:
        "GET /files/{file_id}/content retrieves one file. file_id is a single safe ASCII identifier.",
      rules: [{ method: "GET", path: template }],
      capabilityNotes: [],
      chat: undefined,
    });
    assert.deepEqual(learned.platform.rules, [
      { method: "GET", path: template },
    ]);
    assert.equal(learned.document.markdown.includes(template), true);
    assert.equal(matchesHttpPath(template, "/files/file-123/content"), true);
    const prepared = prepare(
      store.platform(alias),
      requestSchema.parse({ method: "GET", path: "/files/file-123/content" }),
    );
    assert.equal(
      prepared.url.href,
      "https://api.example.com/files/file-123/content",
    );
    assert.equal(store.platform(alias).baseUrl, platform().baseUrl);
    assert.deepEqual(store.platform(alias).auth, platform().auth);
    for (const forbiddenPath of [
      "/files/content",
      "/files/file-123/other",
      "/files/file-123/extra/content",
      "/files/file-123/content/extra",
    ]) {
      assert.equal(matchesHttpPath(template, forbiddenPath), false);
      assert.throws(
        () =>
          prepare(
            store.platform(alias),
            requestSchema.parse({ method: "GET", path: forbiddenPath }),
          ),
        code("PATH_NOT_ALLOWED"),
      );
    }
    for (const unsafePath of [
      "/files//content",
      "/files/%2f/content",
      "/files/%252f/content",
      "/files/../content",
      "/files/./content",
      "/files/file\\other/content",
      "/files/file-123/content?secret=synthetic",
      "/files/file-123/content#fragment",
      "//other.example.com/files/file-123/content",
    ]) {
      assert.throws(
        () => matchesHttpPath(template, unsafePath),
        code("UNSAFE_PATH"),
      );
      assert.throws(
        () =>
          prepare(
            store.platform(alias),
            requestSchema.parse({ method: "GET", path: unsafePath }),
          ),
        code("UNSAFE_PATH"),
      );
    }
    assert.throws(
      () =>
        prepare(
          store.platform(alias),
          requestSchema.parse({
            method: "DELETE",
            path: "/files/file-123/content",
          }),
        ),
      code("PATH_NOT_ALLOWED"),
    );
    assert.throws(
      () =>
        prepare(
          store.platform(alias),
          requestSchema.parse({
            method: "GET",
            path: "/files/file-123/content",
            headers: { authorization: "Bearer synthetic-override" },
          }),
        ),
      code("HEADER_NOT_ALLOWED"),
    );
    const before = await snapshot(store);
    await assert.rejects(
      learnPlatform(store, alias, {
        ...manifest(learned.platform.revision),
        rules: [{ method: "POST", path: "/chats/{chat_id}/completions" }],
        capabilityNotes: [],
        chat: {
          method: "POST",
          path: "/chats/{chat_id}/completions",
          model: "test-model",
        },
      }),
      code("LEARN_MANIFEST"),
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("documentation sources cannot contain credentials, fragments or private targets", async () => {
  await temporary(async (store) => {
    const before = await snapshot(store);
    for (const sourceUrl of [
      "https://user:password@docs.example.com/api",
      "https://docs.example.com/api?api_key=synthetic",
      "https://docs.example.com/api?%2561pi_key=synthetic",
      "https://docs.example.com/api#fragment",
      "http://docs.example.com/api",
      "https://127.0.0.1/api",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/api",
    ])
      await assert.rejects(
        learnPlatform(store, alias, { ...manifest(), sourceUrl }),
      );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("known secrets are scrubbed from body, rejected in public metadata and never returned", async () => {
  await temporary(async (store) => {
    const learned = await learnPlatform(store, alias, {
      ...manifest(),
      markdown: `Ordinary docs. ${syntheticSecret} ${encodeURIComponent(syntheticSecret)}`,
    });
    assert.ok(learned.document.markdown.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(learned).includes(syntheticSecret));
    assert.ok(
      !(await fs.readFile(path.join(store.dir, "state.json"), "utf8")).includes(
        syntheticSecret,
      ),
    );
    const before = await snapshot(store);
    for (const fields of [
      { title: syntheticSecret },
      { sourceUrl: `https://docs.example.com/${syntheticSecret}` },
      { description: syntheticSecret },
      {
        rules: [{ method: "GET", path: `/${syntheticSecret}` }],
        chat: undefined,
        capabilityNotes: [],
      },
      { chat: { ...manifest().chat!, model: syntheticSecret } },
      {
        capabilityNotes: [
          { ...manifest().capabilityNotes[0], summary: syntheticSecret },
        ],
      },
    ]) {
      await assert.rejects(
        learnPlatform(store, alias, { ...manifest(2), ...fields }),
        (error: unknown) =>
          error instanceof AppError && !error.message.includes(syntheticSecret),
      );
      assert.deepEqual(await snapshot(store), before);
    }
  });
});

test("the effective query authentication name is forbidden in learned source URLs", async () => {
  await temporary(async (store) => {
    await store.save(
      { ...platform(), auth: { type: "query", name: "tenantCredential" } },
      { value: syntheticSecret },
      false,
      1,
    );
    const before = await snapshot(store);
    await assert.rejects(
      learnPlatform(store, alias, {
        ...manifest(2),
        sourceUrl: "https://docs.example.com/api?tenantCredential=ordinary",
      }),
      code("DOC_URL_CREDENTIAL"),
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("ordinary document updates cannot grant API routes or change learned configuration", async () => {
  await temporary(async (store) => {
    const learned = await learnPlatform(store, alias, manifest());
    const rules = structuredClone(store.platform(alias).rules);
    await store.saveDoc(
      alias,
      {
        title: "Ordinary docs",
        sourceUrl: "https://docs.example.com/api",
        markdown: "POST /extra is advertised in a new public document.",
      },
      "manual",
      learned.document.id,
      learned.document.revision,
    );
    assert.deepEqual(store.platform(alias).rules, rules);
    assert.equal(store.platform(alias).revision, learned.platform.revision + 1);
    assert.throws(
      () =>
        prepare(
          store.platform(alias),
          requestSchema.parse({ method: "POST", path: "/extra" }),
        ),
      code("PATH_NOT_ALLOWED"),
    );
  });
});

test("target or authentication edits clear learned routes and keep the manual marked stale, while key rotation retains them", async () => {
  await temporary(async (store) => {
    await learnPlatform(store, alias, manifest());
    const learnedPlatform = store.platform(alias);
    const fields = platformSchema.parse({
      ...platform(),
      rules: learnedPlatform.rules,
      chat: learnedPlatform.chat,
      capabilityNotes: learnedPlatform.capabilityNotes,
      description: learnedPlatform.description,
    });
    const replacement = await store.save(
      fields,
      { value: "synthetic-learn-next-key-456789" },
      false,
      learnedPlatform.revision,
    );
    assert.deepEqual(replacement.rules, manifest().rules);
    assert.equal(store.state.docs.length, 1);
    const changed = await store.save(
      { ...fields, baseUrl: "https://next-api.example.com" },
      undefined,
      false,
      replacement.revision,
    );
    assert.deepEqual(changed.rules, []);
    assert.equal(changed.chat, undefined);
    assert.equal(changed.capabilityNotes, undefined);
    // The manual is user-visible text: it stays, linked and marked stale.
    const [kept] = store.state.docs;
    assert.equal(store.state.docs.length, 1);
    assert.equal(changed.learnedDocId, kept.id);
    assert.equal(changed.learnedContext, "identity-changed");
    assert.equal(
      store.discovery().capabilities.find((card) => card.alias === alias)
        ?.documentation.status,
      "stale",
    );
    await assert.rejects(
      learnPlatform(store, alias, manifest(learnedPlatform.revision)),
      code("REVISION_CONFLICT"),
    );
    const relearned = await learnPlatform(store, alias, manifest(changed.revision));
    assert.equal(relearned.document.id, kept.id);
    assert.equal(relearned.platform.learnedContext, undefined);
    assert.equal(store.state.docs[0].previous?.markdown, kept.markdown);
    assert.notEqual(
      store.discovery().capabilities.find((card) => card.alias === alias)
        ?.documentation.status,
      "stale",
    );
    const withNewAuth = await store.save(
      {
        ...fields,
        baseUrl: changed.baseUrl,
        auth: { type: "header", name: "X-API-Key" },
      },
      { value: "synthetic-learn-header-key-654321" },
      false,
      changed.revision + 1,
    );
    assert.deepEqual(withNewAuth.rules, []);
    assert.equal(store.state.docs.length, 1);
    assert.equal(withNewAuth.learnedContext, "identity-changed");
  });
});

test("a manually written manual survives a base URL edit", async () => {
  await temporary(async (store) => {
    await store.saveDoc(
      alias,
      {
        title: "Hand notes",
        sourceUrl: "https://docs.example.com/notes",
        markdown: "# Notes\n\n" + "Human-maintained usage notes. ".repeat(10),
      },
      "manual",
    );
    await store.save(
      platformSchema.parse({ ...platform(), baseUrl: "https://api.example.com/v2" }),
      undefined,
      false,
      store.platform(alias).revision,
      alias,
    );
    assert.equal(store.state.docs.length, 1);
    assert.equal(store.state.docs[0].title, "Hand notes");
  });
});

test("read-only execution stores cannot persist a learned manifest", async () => {
  await temporary(async (store, master) => {
    const before = await snapshot(store);
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try {
      await reader.init();
      await assert.rejects(
        learnPlatform(reader, alias, manifest()),
        code("LOCAL_READ_ONLY"),
      );
      assert.deepEqual(await snapshot(store), before);
    } finally {
      await reader.close();
    }
  });
});

test("public API learning supports large documented catalogues and rejects excess routes or notes atomically", async () => {
  await temporary(async (store) => {
    const rules = Array.from({ length: 1000 }, (_, index) => ({
      method: "GET" as const,
      path: `/functions/f${index}`,
    }));
    const capabilityNotes = rules.map((rule, index) => ({
      name: `功能 ${index}`,
      summary: `公开文档中的功能 ${index}`,
      tags: [],
      input: "业务参数",
      output: "业务结果",
      ...rule,
    }));
    const learned = await learnPlatform(store, alias, {
      ...manifest(),
      rules,
      capabilityNotes,
      chat: undefined,
      markdown: rules.map((rule) => `${rule.method} ${rule.path}`).join("\n"),
    });
    assert.equal(learned.platform.rules.length, 1000);
    assert.equal(learned.platform.capabilityNotes?.length, 1000);
    const before = await snapshot(store);
    for (const excess of [
      { rules: [...rules, { method: "GET", path: "/functions/excess" }] },
      {
        capabilityNotes: [
          ...capabilityNotes,
          { ...capabilityNotes[0], name: "超限能力" },
        ],
      },
    ])
      await assert.rejects(
        learnPlatform(store, alias, {
          ...manifest(learned.platform.revision),
          rules,
          capabilityNotes,
          chat: undefined,
          ...excess,
        }),
        code("LEARN_MANIFEST"),
      );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("credential rotation rechecks previously learned public descriptions before committing a new key", async () => {
  await temporary(async (store) => {
    const nextSecret = "synthetic-future-learn-key-678901";
    await learnPlatform(store, alias, {
      ...manifest(),
      description: nextSecret,
    });
    const before = await snapshot(store);
    await assert.rejects(
      store.save(
        platformSchema.parse({
          ...platform(),
          rules: store.platform(alias).rules,
          description: nextSecret,
          capabilityNotes: store.platform(alias).capabilityNotes,
          chat: store.platform(alias).chat,
        }),
        { value: nextSecret },
        false,
        2,
      ),
      code("LEARN_SECRET"),
    );
    assert.deepEqual(await snapshot(store), before);
  });
});
