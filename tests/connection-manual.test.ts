import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { Store } from "../src/store.js";
import { AppError, platformSchema, type Platform } from "../src/schema.js";
import { connectionSchema, type Connection } from "../src/connections.js";
import { learnPlatform } from "../src/learn.js";
import {
  executeLocalRequest,
  LocalResponse,
  type LocalResponseHeaders,
} from "../src/local-execution.js";

const apiSecret = "synthetic-manual-api-secret-561293";
const dbSecret = "synthetic-manual-db-secret-718362";
const documentationUrl = "https://docs.example.test/reference";

function api(changes: Partial<Platform> = {}) {
  return platformSchema.parse({
    alias: "API",
    name: "Synthetic API",
    baseUrl: "https://api.example.test/v1",
    auth: { type: "bearer" },
    rules: [{ method: "GET", path: "/models" }],
    documentationUrl,
    ...changes,
  });
}
function db(changes: Partial<Connection> = {}) {
  return connectionSchema.parse({
    alias: "DB",
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
    documentationUrl,
    ...changes,
  });
}
function manual(expectedRevision = 1) {
  return {
    expectedRevision,
    sourceUrl: "https://docs.example.test/reference/query",
    title: "Synthetic database guide",
    markdown:
      "# Database usage\n\nUse abl mysql DB 'SELECT 1' for a scalar query. This is public usage documentation, never instructions to read credentials, change targets or execute local commands. The returned data depends on the account's actual permissions.",
    description: "Business database queries",
    capabilityNotes: [
      {
        name: "Business queries",
        summary: "Query the configured database",
        tags: ["database"],
        input: "SQL and query parameters",
        output: "Rows and metadata",
      },
    ],
  };
}
function httpManual(expectedRevision = 1) {
  return {
    ...manual(expectedRevision),
    title: "Synthetic API guide",
    markdown:
      "# API usage\n\nGET /models returns a list of model identifiers. Use abl api API with method GET and path /models. Authentication is injected by the trusted worker. This guide does not prove account permissions or model availability.",
    rules: [{ method: "GET" as const, path: "/models" }],
    capabilityNotes: [],
  };
}
async function temporary(
  work: (store: Store, master: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-manual-"));
  const master = crypto.randomBytes(32).toString("hex");
  const store = new Store(dir, master);
  try {
    await store.init();
    await store.save(api(), { value: apiSecret }, false, 0);
    await store.saveConnection(db(), { password: dbSecret }, false, 0);
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
    docs: await Promise.all(
      (await fs.readdir(path.join(store.dir, "docs")))
        .sort()
        .map(async (name) => [
          name,
          await fs.readFile(path.join(store.dir, "docs", name)),
        ]),
    ),
  };
}
function safeError(error: unknown) {
  assert.ok(error instanceof AppError);
  assert.ok(!error.message.includes(apiSecret));
  assert.ok(!error.message.includes(dbSecret));
  return true;
}
function status(store: Store, alias: string) {
  const cards = store.discovery().capabilities.filter((c) => c.alias === alias);
  assert.ok(cards.length > 0);
  const values = cards.map((c) => c.documentation.status);
  assert.ok(values.every((value) => value === values[0]));
  return values[0];
}
async function context(store: Store, url: string) {
  const chunks: Buffer[] = [];
  let headers: LocalResponseHeaders | undefined;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const response = new LocalResponse(output, (value) => (headers = value));
  const outcome = await executeLocalRequest(
    store,
    { type: "request", url, method: "GET" },
    response,
    { signal: new AbortController().signal, programRoot: path.resolve(".") },
  );
  assert.equal(outcome.failed, false);
  assert.equal(headers?.status, 200);
  const raw = Buffer.concat(chunks).toString("utf8");
  for (const value of [apiSecret, dbSecret, '"sealed"'])
    assert.ok(!raw.includes(value));
  return JSON.parse(raw);
}

test("documentation links persist and are available through public HTTP and protocol context", async () => {
  await temporary(async (store, master) => {
    assert.equal(
      (await context(store, "/v1/context/API")).platform.documentationUrl,
      documentationUrl,
    );
    assert.equal(
      (await context(store, "/v2/context/mysql/DB")).connection
        .documentationUrl,
      documentationUrl,
    );
    assert.equal(status(store, "API"), "pending");
    assert.equal(status(store, "DB"), "pending");
    await store.close();
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try {
      await reader.init();
      assert.equal(reader.platform("API").documentationUrl, documentationUrl);
      assert.equal(
        reader.connection("mysql", "DB").documentationUrl,
        documentationUrl,
      );
      assert.ok(!JSON.stringify(reader.discovery()).includes(apiSecret));
    } finally {
      await reader.close();
    }
  });
});

test("documentation links reject embedded credentials and known secrets atomically", async () => {
  await temporary(async (store) => {
    const before = await snapshot(store);
    const unsafeUrls = [
      "https://user:password@docs.example.test/api",
      "https://docs.example.test/api#token",
      "https://docs.example.test/api?api_key=placeholder",
      "https://docs.example.test/api?%2561ccess_token=placeholder",
      `https://docs.example.test/${apiSecret}`,
      `https://docs.example.test/${encodeURIComponent(dbSecret)}`,
      "file:///tmp/manual.md",
    ];
    for (const url of unsafeUrls) {
      await assert.rejects(
        store.save(api({ documentationUrl: url }), undefined, false, 1),
        safeError,
      );
      assert.deepEqual(await snapshot(store), before);
      await assert.rejects(
        store.saveConnection(
          db({ documentationUrl: url }),
          undefined,
          false,
          1,
        ),
        safeError,
      );
      assert.deepEqual(await snapshot(store), before);
    }
  });
});

test("every configured custom query credential name is forbidden in every connection's document link", async () => {
  await temporary(async (store) => {
    await store.save(
      api({ alias: "QUERY", auth: { type: "query", name: "client_ticket" } }),
      { value: "synthetic-query-ticket-978341" },
      false,
      0,
    );
    const before = await snapshot(store);
    for (const name of [
      "client_ticket",
      "CLIENT_TICKET",
      "%2563lient_ticket",
    ]) {
      const url = `https://docs.example.test/api?${name}=public-looking-value`;
      await assert.rejects(
        store.save(api({ documentationUrl: url }), undefined, false, 1),
        safeError,
      );
      await assert.rejects(
        store.saveConnection(
          db({ documentationUrl: url }),
          undefined,
          false,
          1,
        ),
        safeError,
      );
      assert.deepEqual(await snapshot(store), before);
    }
  });
});

test("document-link edits preserve HTTP target, rules, credentials and existing usage while marking stale", async () => {
  await temporary(async (store) => {
    const learned = await learnPlatform(store, "API", httpManual());
    const saved = store.platform("API");
    const sealed = saved.sealed;
    const omitted = api();
    delete omitted.documentationUrl;
    await store.save(omitted, undefined, false, saved.revision);
    assert.equal(store.platform("API").documentationUrl, documentationUrl);
    assert.equal(status(store, "API"), "saved");
    await store.save(
      api({ documentationUrl: "https://docs.example.test/v2" }),
      undefined,
      false,
      3,
    );
    assert.equal(status(store, "API"), "stale");
    assert.equal(store.platform("API").baseUrl, api().baseUrl);
    assert.deepEqual(store.platform("API").rules, api().rules);
    assert.equal(store.platform("API").sealed, sealed);
    assert.equal(store.state.docs[0].markdown, learned.document.markdown);
    await store.save(api({ documentationUrl: null }), undefined, false, 4);
    assert.equal(store.platform("API").documentationUrl, null);
    assert.equal(store.platform("API").sealed, sealed);
    assert.equal(store.state.docs.length, 1);
  });
});

test("protocol learning stores public usage atomically without changing target, identity, credentials or permission", async () => {
  await temporary(async (store) => {
    const original = structuredClone(store.connection("mysql", "DB"));
    const learned = await learnPlatform(store, "db", manual());
    assert.ok("connection" in learned);
    const saved = store.connection("mysql", "DB");
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.config, original.config);
    assert.equal(saved.trustBoundary, original.trustBoundary);
    assert.equal(saved.enabled, original.enabled);
    assert.equal(saved.kind, original.kind);
    assert.equal(saved.sealed, original.sealed);
    assert.deepEqual(saved.capabilityNotes, manual().capabilityNotes);
    assert.equal(saved.learnedDocId, learned.document.id);
    assert.equal(status(store, "DB"), "saved");
    assert.equal(
      store.discovery().capabilities.find((c) => c.alias === "DB")
        ?.documentation.sourceUrl,
      manual().sourceUrl,
    );
    assert.ok(!JSON.stringify(learned).includes(dbSecret));
    const next = await learnPlatform(store, "DB", {
      ...manual(2),
      markdown:
        "Updated public database usage. No business command is executed.",
    });
    assert.equal(next.document.id, learned.document.id);
    assert.equal(next.document.revision, 2);
    assert.equal(store.state.docs.length, 1);
  });
});

test("protocol learning rejects permission and executable fields without changing any persisted bytes", async () => {
  await temporary(async (store) => {
    const before = await snapshot(store);
    for (const forbidden of [
      { rules: [{ method: "GET", path: "/admin" }] },
      { chat: { method: "POST", path: "/chat", model: "fake" } },
      { config: { host: "another.example.test" } },
      { auth: { type: "none" } },
      { secret: { password: "fake" } },
      { kind: "ssh" },
      { enabled: true },
      { trustBoundary: "development-fixture" },
      { plugin: "shell" },
      { documentationUrl: "https://other.example.test" },
      {
        capabilityNotes: [
          { ...manual().capabilityNotes[0], method: "GET", path: "/extra" },
        ],
      },
    ]) {
      await assert.rejects(
        learnPlatform(store, "DB", { ...manual(), ...forbidden }),
        safeError,
      );
      assert.deepEqual(await snapshot(store), before);
    }
  });
});

test("protocol document-link edits retain learned notes, target and sealed credentials", async () => {
  await temporary(async (store) => {
    await learnPlatform(store, "DB", manual());
    const original = structuredClone(store.connection("mysql", "DB"));
    await store.saveConnection(
      db({ documentationUrl: "https://docs.example.test/revised" }),
      undefined,
      false,
      2,
    );
    const current = store.connection("mysql", "DB");
    assert.deepEqual(current.config, original.config);
    assert.equal(current.sealed, original.sealed);
    assert.equal(current.learnedDocId, original.learnedDocId);
    assert.deepEqual(current.capabilityNotes, original.capabilityNotes);
    assert.equal(status(store, "DB"), "stale");
  });
});

test("protocol usage becomes stale after target, database or identity changes and stays saved after renaming or key rotation", async () => {
  await temporary(async (store, master) => {
    const learned = await learnPlatform(store, "DB", manual());
    const original = structuredClone(store.connection("mysql", "DB"));
    const renamed = await store.saveConnection(
      db({ alias: "REPORTING" }),
      undefined,
      false,
      original.revision,
      "DB",
    );
    assert.equal(status(store, "REPORTING"), "saved");
    await store.saveConnection(
      db({ alias: "REPORTING" }),
      { password: "synthetic-rotated-password-89234" },
      false,
      renamed.revision,
    );
    assert.equal(status(store, "REPORTING"), "saved");
    for (const change of [
      { host: "other-db.example.test" },
      { database: "other-business" },
      { user: "other-public-user" },
    ]) {
      const current = store.connection("mysql", "REPORTING");
      await store.saveConnection(
        db({ alias: "REPORTING", config: { ...current.config, ...change } }),
        undefined,
        false,
        current.revision,
      );
      assert.equal(status(store, "REPORTING"), "stale");
      assert.equal(store.state.docs[0].id, learned.document.id);
      assert.equal(store.state.docs[0].markdown, learned.document.markdown);
      const reader = new Store(store.dir, master, [], { readOnly: true });
      try {
        await reader.init();
        assert.equal(status(reader, "REPORTING"), "stale");
      } finally {
        await reader.close();
      }
      await learnPlatform(store, "REPORTING", manual(current.revision + 1));
      assert.equal(status(store, "REPORTING"), "saved");
    }
  });
});

test("usage context does not change with object-key order and legacy manuals without a binding remain available but stale", async () => {
  await temporary(async (store, master) => {
    await learnPlatform(store, "DB", manual());
    const current = store.connection("mysql", "DB");
    await store.saveConnection(
      db({
        config: Object.fromEntries(Object.entries(current.config).reverse()),
      }),
      undefined,
      false,
      current.revision,
    );
    assert.equal(status(store, "DB"), "saved");
    await store.close();
    const old = structuredClone(store.state);
    delete old.connections![0].learnedContext;
    await fs.writeFile(path.join(store.dir, "state.json"), JSON.stringify(old));
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try {
      await reader.init();
      assert.equal(status(reader, "DB"), "stale");
      assert.equal(reader.state.docs[0].markdown, manual().markdown);
    } finally {
      await reader.close();
    }
  });
});

test("SSH paths and Kubernetes namespaces invalidate saved usage without discarding the previous manual", async () => {
  await temporary(async (store) => {
    const cases: {
      kind: "ssh" | "kubernetes";
      config: Record<string, unknown>;
      secret: Record<string, string>;
      change: Record<string, unknown>;
    }[] = [
      {
        kind: "ssh",
        config: {
          host: "ssh.example.test",
          username: "reader",
          hostKeySHA256: `SHA256:${"A".repeat(43)}`,
          remoteRoot: "/first",
        },
        secret: { password: "synthetic-ssh-usage-password" },
        change: { remoteRoot: "/second" },
      },
      {
        kind: "kubernetes",
        config: {
          endpoint: "https://cluster.example.test",
          namespace: "first",
        },
        secret: { token: "synthetic-kubernetes-usage-token" },
        change: { namespace: "second" },
      },
    ];
    for (const item of cases) {
      const connection = connectionSchema.parse({
        alias: item.kind,
        name: item.kind,
        kind: item.kind,
        config: item.config,
      });
      await store.saveConnection(connection, item.secret, false, 0);
      const learned = await learnPlatform(store, item.kind, manual());
      assert.equal(status(store, item.kind), "saved");
      await store.saveConnection(
        { ...connection, config: { ...connection.config, ...item.change } },
        undefined,
        false,
        2,
      );
      assert.equal(status(store, item.kind), "stale");
      assert.equal(
        store.state.docs.find((doc) => doc.id === learned.document.id)
          ?.markdown,
        learned.document.markdown,
      );
    }
  });
});

test("private account-name changes invalidate usage without exposing private names or invalidating password-only rotation", async () => {
  await temporary(async (store) => {
    const connection = connectionSchema.parse({
      alias: "registry",
      name: "Registry",
      kind: "registry",
      config: {
        endpoint: "https://registry.example.test",
        authType: "basic",
        allowedRepositories: ["test/app"],
      },
    });
    await store.saveConnection(
      connection,
      {
        username: "synthetic-private-identity",
        password: "synthetic-first-pass",
      },
      false,
      0,
    );
    await learnPlatform(store, "registry", manual());
    await store.saveConnection(
      connection,
      {
        username: "synthetic-private-identity",
        password: "synthetic-rotated-pass",
      },
      false,
      2,
    );
    assert.equal(status(store, "registry"), "saved");
    const saved = await store.saveConnection(
      connection,
      {
        username: "synthetic-new-private-identity",
        password: "synthetic-rotated-pass",
      },
      false,
      3,
    );
    assert.equal(status(store, "registry"), "stale");
    assert.equal(saved.learnedContext, "identity-changed");
    assert.ok(
      !JSON.stringify(saved).includes("synthetic-new-private-identity"),
    );
  });
});

test("enrolling a secret colliding with an existing public document URL rejects rotation atomically", async () => {
  await temporary(async (store) => {
    const collision = "synthetic-future-secret-349102";
    await store.save(
      api({ documentationUrl: `https://docs.example.test/${collision}` }),
      undefined,
      false,
      1,
    );
    const before = await snapshot(store);
    await assert.rejects(
      store.saveConnection(db(), { password: collision }, false, 1),
      safeError,
    );
    assert.deepEqual(await snapshot(store), before);
    await assert.rejects(
      store.save(
        api({ documentationUrl: `https://docs.example.test/${collision}` }),
        { value: collision },
        false,
        2,
      ),
      safeError,
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("protocol learning enforces current revisions during concurrent updates and preserves existing documents", async () => {
  await temporary(async (store) => {
    const first = learnPlatform(store, "DB", manual());
    const stale = learnPlatform(store, "DB", {
      ...manual(),
      markdown: "Stale usage must never overwrite the current document.",
    });
    const learned = await first;
    await assert.rejects(stale, { code: "REVISION_CONFLICT" });
    assert.equal(store.state.docs[0].markdown, learned.document.markdown);
    const before = await snapshot(store);
    await assert.rejects(learnPlatform(store, "DB", manual(1)), {
      code: "REVISION_CONFLICT",
    });
    assert.deepEqual(await snapshot(store), before);
  });
});

test("HTTP and protocol context return exactly the Markdown persisted for the human manual", async () => {
  await temporary(async (store) => {
    const apiLearned = await learnPlatform(store, "API", httpManual());
    const dbLearned = await learnPlatform(store, "DB", manual());
    const httpContext = await context(store, "/v1/context/API");
    const protocolContext = await context(store, "/v2/context/mysql/DB");
    assert.equal(httpContext.docs[0].markdown, apiLearned.document.markdown);
    assert.equal(protocolContext.docs[0].markdown, dbLearned.document.markdown);
    assert.equal(
      store.state.docs.find((d) => d.alias === "DB")?.markdown,
      protocolContext.docs[0].markdown,
    );
    assert.equal(httpContext.platform.learnedDocId, apiLearned.document.id);
    assert.equal(
      protocolContext.connection.learnedDocId,
      dbLearned.document.id,
    );
  });
});

test("missing links remain distinguishable from pending links and cached manuals with cleared sources", async () => {
  await temporary(async (store) => {
    await store.save(api({ documentationUrl: null }), undefined, false, 1);
    await store.saveConnection(
      db({ documentationUrl: null }),
      undefined,
      false,
      1,
    );
    assert.equal(status(store, "API"), "missing");
    assert.equal(status(store, "DB"), "missing");
    await learnPlatform(store, "API", httpManual(2));
    await learnPlatform(store, "DB", manual(2));
    assert.equal(status(store, "API"), "saved");
    assert.equal(status(store, "DB"), "saved");
    await store.save(api(), undefined, false, 3);
    await store.saveConnection(db(), undefined, false, 3);
    assert.equal(status(store, "API"), "stale");
    assert.equal(status(store, "DB"), "stale");
    assert.equal(store.state.docs.length, 2);
  });
});

test("protocol manuals scrub stored secrets in body text and reject them in public summaries", async () => {
  await temporary(async (store) => {
    const learned = await learnPlatform(store, "DB", {
      ...manual(),
      markdown: `Public command example containing accidental text ${dbSecret} and ${apiSecret}`,
    });
    assert.ok(!learned.document.markdown.includes(dbSecret));
    assert.ok(!learned.document.markdown.includes(apiSecret));
    assert.ok(learned.document.markdown.includes("[REDACTED]"));
    const before = await snapshot(store);
    await assert.rejects(
      learnPlatform(store, "DB", { ...manual(2), description: dbSecret }),
      safeError,
    );
    await assert.rejects(
      learnPlatform(store, "DB", {
        ...manual(2),
        capabilityNotes: [
          { ...manual().capabilityNotes[0], summary: apiSecret },
        ],
      }),
      safeError,
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

test("concurrent readers and idle writers coexist while readers cannot replace usage", async () => {
  await temporary(async (store, master) => {
    await learnPlatform(store, "DB", manual());
    const before = await snapshot(store);
    const lockFile = path.join(store.dir, "service.lock");
    const lockBytes = await fs.readFile(lockFile);
    const competing = new Store(store.dir, master);
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try {
      await competing.init();
      await competing.close();
      assert.deepEqual(await fs.readFile(lockFile), lockBytes);
      await reader.init();
      assert.equal(status(reader, "DB"), "saved");
      assert.equal(
        (await context(reader, "/v2/context/mysql/DB")).docs[0].markdown,
        manual().markdown,
      );
      await assert.rejects(learnPlatform(reader, "DB", manual(2)), {
        code: "LOCAL_READ_ONLY",
      });
      await reader.close();
      assert.deepEqual(await fs.readFile(lockFile), lockBytes);
      assert.deepEqual(await snapshot(store), before);
    } finally {
      await competing.close();
      await reader.close();
    }
  });
});

test("human edits and deletion of a learned protocol manual invalidate stale AI writes without changing connection scope", async () => {
  await temporary(async (store, master) => {
    const learned = await store.applyLearnedConnection("DB", manual());
    const before = structuredClone(store.connection("mysql", "DB"));
    const editor = new Store(store.dir, master);
    try {
      await editor.init();
      const edited = await editor.saveDoc("DB", {
        title: learned.document.title, sourceUrl: learned.document.sourceUrl,
        markdown: "Human clarification: run SELECT 1 to verify this connection.",
      }, "manual", learned.document.id, learned.document.revision);
      await assert.rejects(store.applyLearnedConnection("DB", manual(learned.connection.revision)),
        (error: unknown) => error instanceof AppError && error.code === "REVISION_CONFLICT");
      await store.refresh();
      assert.equal(store.connection("mysql", "DB").revision, learned.connection.revision + 1);
      assert.deepEqual(store.connection("mysql", "DB").config, before.config);
      assert.equal(store.connection("mysql", "DB").sealed, before.sealed);
      assert.equal(store.connection("mysql", "DB").learnedContext, before.learnedContext);
      assert.ok(store.discovery().capabilities.filter((item) => item.alias === "DB")
        .every((item) => item.documentation.status === "saved"));
      assert.equal(store.state.docs[0].markdown, edited.markdown);
      const revision = store.connection("mysql", "DB").revision;
      await editor.removeDoc(edited.id, edited.revision);
      await assert.rejects(store.applyLearnedConnection("DB", manual(revision)),
        (error: unknown) => error instanceof AppError && error.code === "REVISION_CONFLICT");
      await store.refresh();
      assert.equal(store.state.docs.length, 0);
      assert.equal(store.connection("mysql", "DB").revision, revision + 1);
    } finally { await editor.close(); }
  });
});
