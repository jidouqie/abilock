import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../src/store.js";
import { AppError, platformSchema } from "../src/schema.js";
import { connectionSchema } from "../src/connections.js";
import { LocalResponse, executeLocalRequest } from "../src/local-execution.js";
import { startServers } from "../src/server.js";
import { ManualHistory, manualDraft, manualWrite, previousManualDraft } from "../web/components/manual-edit.js";

const master = "9".repeat(64);
const providerKey = "synthetic-history-provider-9184";
const api = platformSchema.parse({ alias: "API", name: "Synthetic API", baseUrl: "https://example.test",
  auth: { type: "bearer" }, rules: [] });
const database = connectionSchema.parse({ alias: "DB", name: "Synthetic database", kind: "mysql",
  config: { host: "db.example.test", user: "synthetic-user", database: "business", tls: true }, trustBoundary: "independent-target" });
const manifest = (expectedRevision: number, markdown = "Current public usage", title = "Public guide") => ({
  expectedRevision, title, sourceUrl: "https://example.test/docs", markdown,
  rules: [{ method: "GET" as const, path: "/status" }], capabilityNotes: [],
});
async function temporary(work: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-manual-history-"));
  const store = new Store(dir, master);
  try {
    await store.init(); await store.save(api, { value: providerKey }, false, 0);
    await work(store);
  } finally { await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
async function context(store: Store, url: string) {
  const chunks: Buffer[] = [];
  const response = new LocalResponse(new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }), () => {});
  await executeLocalRequest(store, { type: "request", method: "GET", url, headers: {} }, response,
    { signal: new AbortController().signal, programRoot: path.resolve(".") });
  return JSON.parse(Buffer.concat(chunks).toString());
}

test("HTTP learning and manual edits retain exactly one previous public version in the same authority", async () => {
  await temporary(async (store) => {
    const first = await store.applyLearnedPlatform("API", manifest(1, "FIRST public body"));
    assert.equal(store.state.docs[0].previous, undefined);
    const second = await store.applyLearnedPlatform("API", manifest(2, "SECOND public body"));
    const previous = store.state.docs[0].previous!;
    assert.deepEqual(Object.keys(previous).sort(), ["markdown", "revision", "sourceUrl", "title", "updatedAt"]);
    assert.equal(previous.markdown, first.document.markdown);
    assert.equal(previous.revision, first.document.revision);
    assert.equal(Reflect.get(second.document, "previous"), undefined);
    assert.equal(second.document.hasPrevious, true);
    const changed = await store.saveDoc("API", { title: "Human edit", sourceUrl: second.document.sourceUrl,
      markdown: "THIRD public body" }, "manual", second.document.id, second.document.revision);
    assert.equal(changed.previous!.markdown, "SECOND public body");
    assert.equal(Reflect.get(changed.previous!, "previous"), undefined);
    const authority = JSON.parse(await fs.readFile(path.join(store.dir, "state.json"), "utf8"));
    assert.equal(authority.docs[0].previous.markdown, "SECOND public body");
    assert.ok(!JSON.stringify(authority.docs).includes("FIRST public body"));
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try { await reader.init(); assert.deepEqual(reader.state.docs, store.state.docs); }
    finally { await reader.close(); }
  });
});

test("protocol learning also retains one previous version without config, credentials or execution scope", async () => {
  await temporary(async (store) => {
    await store.saveConnection(database, { password: "synthetic-history-db-9184" }, false, 0);
    const first = { expectedRevision: 1, title: "Database guide", sourceUrl: "https://example.test/database",
      markdown: "First SQL usage", capabilityNotes: [] };
    await store.applyLearnedConnection("DB", first);
    const original = structuredClone(store.connection("mysql", "DB"));
    const second = await store.applyLearnedConnection("DB", { ...first, expectedRevision: 2, markdown: "Second SQL usage" });
    const doc = store.state.docs.find((item) => item.alias === "DB")!;
    assert.equal(doc.previous!.markdown, first.markdown);
    assert.deepEqual(Object.keys(doc.previous!).sort(), ["markdown", "revision", "sourceUrl", "title", "updatedAt"]);
    assert.equal(Reflect.get(second.document, "previous"), undefined);
    assert.deepEqual(store.connection("mysql", "DB").config, original.config);
    assert.equal(store.connection("mysql", "DB").sealed, original.sealed);
    const data = await context(store, "/v2/context/mysql/DB");
    assert.equal(data.docs[0].previous, undefined);
    assert.equal(data.docs[0].hasPrevious, true);
    assert.ok(!JSON.stringify(data).includes("First SQL usage"));
  });
});

test("new and rotated API or protocol credentials are scrubbed from previous bodies", async () => {
  for (const kind of ["api-new", "api-rotate", "protocol-new", "protocol-rotate"] as const) {
    await temporary(async (store) => {
      const future = "synthetic-future-history-value-" + kind;
      if (kind === "protocol-rotate") await store.saveConnection(database, { password: "synthetic-old-history-db-9184" }, false, 0);
      await store.applyLearnedPlatform("API", manifest(1, "Previous contains " + future));
      await store.applyLearnedPlatform("API", manifest(2, "Current contains " + future));
      if (kind === "api-new") await store.save({ ...api, alias: "NEXT" }, { value: future }, false, 0);
      if (kind === "api-rotate") await store.save({ ...api, rules: store.platform("API").rules }, { value: future }, false, 3);
      if (kind.startsWith("protocol")) await store.saveConnection(database, { password: future }, false, kind === "protocol-new" ? 0 : 1);
      const doc = store.state.docs[0];
      assert.ok(doc.markdown.includes("[REDACTED]"));
      assert.ok(doc.previous!.markdown.includes("[REDACTED]"));
      assert.ok(!JSON.stringify(store.state.docs).includes(future));
      const authority = await fs.readFile(path.join(store.dir, "state.json"), "utf8");
      assert.ok(!authority.includes(future));
    });
  }
});

test("previous titles and sources participate in new credential validation atomically", async () => {
  for (const kind of ["api", "protocol"] as const) {
    for (const field of ["title", "sourceUrl"] as const) {
      await temporary(async (store) => {
        const future = "synthetic-prior-metadata-9184";
        const input = manifest(1, "Previous public body", field === "title" ? future : "Old title");
        if (field === "sourceUrl") input.sourceUrl = "https://example.test/" + future;
        await store.applyLearnedPlatform("API", input);
        await store.applyLearnedPlatform("API", manifest(2));
        const before = await fs.readFile(path.join(store.dir, "state.json"));
        const privateError = (error: unknown) => error instanceof AppError &&
          error.code === "DOC_METADATA_SECRET" && /当前手册或上一版/.test(error.message) && !error.message.includes(future);
        if (kind === "api") await assert.rejects(store.save({ ...api, alias: "NEXT" }, { value: future }, false, 0), privateError);
        else await assert.rejects(store.saveConnection(database, { password: future }, false, 0), privateError);
        assert.deepEqual(await fs.readFile(path.join(store.dir, "state.json")), before);
      });
    }
  }
});

test("conflicts and failed commits do not advance previous history", async (t) => {
  await temporary(async (store) => {
    await store.applyLearnedPlatform("API", manifest(1, "Previous"));
    await store.applyLearnedPlatform("API", manifest(2, "Current"));
    const file = path.join(store.dir, "state.json"), before = await fs.readFile(file);
    await assert.rejects(store.applyLearnedPlatform("API", manifest(2, "Stale")), { code: "REVISION_CONFLICT" });
    assert.deepEqual(await fs.readFile(file), before);
    const rename = fs.rename.bind(fs);
    const hook = t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
      if (to === file) throw Object.assign(new Error("synthetic commit failure"), { code: "EIO" });
      return rename(from, to);
    });
    try { await assert.rejects(store.applyLearnedPlatform("API", manifest(3, "Failed")), { code: "EIO" }); }
    finally { hook.mock.restore(); }
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(store.state.docs[0].previous!.markdown, "Previous");
    assert.equal(store.state.docs[0].markdown, "Current");
  });
});

test("only authenticated management receives the previous body; execution context stays small", async () => {
  await temporary(async (store) => {
    await store.applyLearnedPlatform("API", manifest(1, "PREVIOUS BODY ONLY FOR MANAGEMENT"));
    await store.applyLearnedPlatform("API", manifest(2, "Current body"));
    const server = await startServers({ store, adminToken: "synthetic-history-admin-token-9184",
      execToken: "synthetic-history-exec-token-9184", webDir: path.resolve("dist/web"), adminPort: 0, execPort: 0, log: () => {} });
    try {
      const response = await fetch(server.adminUrl + "/admin/docs", { headers: { authorization: "Bearer synthetic-history-admin-token-9184" } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).docs[0].previous.markdown, "PREVIOUS BODY ONLY FOR MANAGEMENT");
      const current = await fetch(server.execUrl + "/v1/context/API", { headers: { authorization: "Bearer synthetic-history-exec-token-9184" } });
      assert.equal(current.status, 200);
      const data = await current.json();
      assert.equal(data.docs[0].hasPrevious, true); assert.equal(data.docs[0].previous, undefined);
      assert.ok(!JSON.stringify(data).includes("PREVIOUS BODY ONLY FOR MANAGEMENT"));
      assert.ok(!JSON.stringify(await context(store, "/v1/context/API")).includes("PREVIOUS BODY ONLY FOR MANAGEMENT"));
      const denied = await fetch(server.adminUrl + "/admin/docs", { headers: { authorization: "Bearer synthetic-history-exec-token-9184" } });
      assert.equal(denied.status, 401);
    } finally { await server.close(); }
  });
});

test("using the previous version changes only the draft title/body and requires the existing save revision", async () => {
  await temporary(async (store) => {
    await store.applyLearnedPlatform("API", manifest(1, "Old body", "Old title"));
    await store.applyLearnedPlatform("API", { ...manifest(2, "New body", "New title"), sourceUrl: "https://example.test/new-docs" });
    const doc = store.state.docs[0], original = structuredClone(store.platform("API"));
    const draft = previousManualDraft(manualDraft(doc));
    assert.equal(draft.markdown, "Old body"); assert.equal(draft.title, "Old title");
    assert.equal(draft.sourceUrl, doc.sourceUrl); assert.equal(draft.id, doc.id); assert.equal(draft.revision, doc.revision);
    assert.equal(store.state.docs[0].markdown, "New body", "loading a draft does not save it");
    const input = manualWrite(draft);
    assert.equal(Reflect.get(input, "previous"), undefined);
    assert.deepEqual(Object.keys(input.doc).sort(), ["markdown", "sourceUrl", "title"]);
    await store.saveDoc("API", input.doc, "manual", doc.id, input.expectedRevision);
    assert.equal(store.state.docs[0].markdown, "Old body");
    assert.equal(store.state.docs[0].previous!.markdown, "New body");
    assert.equal(store.platform("API").baseUrl, original.baseUrl);
    assert.equal(store.platform("API").sealed, original.sealed);
    assert.deepEqual(store.platform("API").rules, original.rules);
    const html = renderToStaticMarkup(React.createElement(ManualHistory, { previous: {
      ...doc.previous!, markdown: "<script>synthetic</script> ![image](https://example.test/tracker)",
    } }));
    assert.ok(html.includes("上一版")); assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!/<script\b|<img\b/.test(html));
  });
});


test("learning returns the committed revision when newly protected runtime values scrub previous content", async () => {
  await temporary(async (store) => {
    const lateRuntimeValue = "synthetic-late-runtime-history-9184";
    await store.applyLearnedPlatform("API", manifest(1, "Earlier public material " + lateRuntimeValue));
    store.setProtectedSecrets([lateRuntimeValue]);
    const saved = await store.applyLearnedPlatform("API", manifest(2, "Updated public material"));
    assert.equal(saved.document.revision, store.state.docs[0].revision);
    assert.equal(saved.document.updatedAt, store.state.docs[0].updatedAt);
    assert.ok(store.state.docs[0].previous!.markdown.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(saved).includes(lateRuntimeValue));
    assert.equal(Reflect.get(saved.document, "previous"), undefined);
  });
});
