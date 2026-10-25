import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualEditor, continueManualDraft, manualDraft, manualWrite, type SavedManual } from "../web/components/manual-edit.js";
import { PrivateKeyFile, readPrivateKeyFile } from "../web/components/private-key-file.js";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { platformSchema } from "../src/schema.js";

const document: SavedManual = {
  id: "d0c2ad39-b315-4521-af4b-68763f4bf500", alias: "FAKE",
  title: "Public usage", sourceUrl: "https://example.test/docs",
  markdown: "GET /status returns health.", revision: 3,
};

test("manual edits retain their source and original revision and submit only document fields", () => {
  const draft = manualDraft(document);
  draft.title = "Human clarification";
  draft.markdown = "GET /status returns the current health.";
  const result = manualWrite(draft);
  assert.deepEqual(result, {
    doc: { title: draft.title, sourceUrl: document.sourceUrl, markdown: draft.markdown },
    expectedRevision: document.revision,
  });
  assert.equal(document.title, "Public usage");
  assert.deepEqual(Object.keys(draft).sort(), ["id", "markdown", "revision", "sourceUrl", "title"]);
  assert.throws(() => manualWrite({ ...draft, title: " " }), /标题和正文/);
  assert.throws(() => manualWrite({ ...draft, revision: 0 }), /版本/);
});

test("manual editor has only title and body inputs and renders external text inertly", () => {
  const html = renderToStaticMarkup(React.createElement(ManualEditor, {
    draft: { ...manualDraft(document), markdown: "<script>synthetic</script>" },
    onChange: () => {}, onSubmit: () => {}, busy: false,
    error: "手册已变化，草稿已保留。",
  }));
  assert.equal((html.match(/<input\b/g) ?? []).length, 1);
  assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
  assert.ok(html.includes('href="https://example.test/docs"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("&lt;script&gt;synthetic&lt;/script&gt;"));
  assert.ok(html.includes('role="alert"'));
  assert.ok(!html.includes("<script>"));
});

test("reviewing the current manual keeps the human draft and requires an explicit continuation", () => {
  const draft = { ...manualDraft(document), title: "Human title", markdown: "Unsaved human text." };
  const latest: SavedManual = { ...document, revision: document.revision + 1,
    title: "AI title", markdown: "<script>untrusted source text</script>",
    sourceUrl: "https://example.test/new-docs",
    previous: { ...document, updatedAt: "2026-10-22T00:00:00Z" } };
  const kept = structuredClone(draft);
  const html = renderToStaticMarkup(React.createElement(ManualEditor, {
    draft, latest, onChange: () => {}, onSubmit: () => {}, onLoadLatest: () => {}, busy: false,
  }));
  assert.deepEqual(draft, kept);
  assert.ok(html.includes("Unsaved human text."));
  assert.ok(html.includes("以此版本继续编辑"));
  assert.ok(html.includes("&lt;script&gt;untrusted source text&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  const continued = continueManualDraft(draft, latest);
  assert.equal(continued.title, kept.title);
  assert.equal(continued.markdown, kept.markdown);
  assert.equal(continued.sourceUrl, latest.sourceUrl);
  assert.equal(continued.revision, latest.revision);
  assert.deepEqual(continued.previous, latest.previous);
  assert.deepEqual(draft, kept);
  assert.throws(() => continueManualDraft(draft, { ...latest, id: "other-document" }), /重新读取/);
  assert.throws(() => continueManualDraft(continued, document), /重新读取/);

  const deleted = renderToStaticMarkup(React.createElement(ManualEditor, {
    draft, latest: null, onChange: () => {}, onSubmit: () => {}, onLoadLatest: () => {}, busy: false,
  }));
  assert.ok(deleted.includes("手册已删除"));
  assert.ok(deleted.includes("Unsaved human text."));
  assert.match(deleted, /type="submit" disabled=""/);
});

test("private-key selection reads only the selected local file and keeps pasted text unchanged", async () => {
  const fake = "-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-NOT-A-KEY\n-----END OPENSSH PRIVATE KEY-----\n";
  let reads = 0;
  assert.equal(await readPrivateKeyFile({ size: fake.length, async text() { reads++; return fake; } }), fake);
  assert.equal(reads, 1);
  for (const size of [0, 100001, Number.NaN]) {
    await assert.rejects(readPrivateKeyFile({ size, async text() { reads++; return fake; } }));
  }
  assert.equal(reads, 1, "invalid size must be rejected before file reads");
  await assert.rejects(readPrivateKeyFile({ size: 4, async text() { return "bad\0"; } }), /文本格式/);
  await assert.rejects(readPrivateKeyFile({ size: 1, async text() { throw new Error(fake); } }), (error: unknown) =>
    error instanceof Error && error.message === "无法读取私钥文件" && !error.message.includes(fake));
  const html = renderToStaticMarkup(React.createElement(PrivateKeyFile, {
    disabled: false, onValue: () => {}, onError: () => {}, onReading: () => {},
  }));
  assert.ok(html.includes('type="file"'));
  assert.ok(html.includes('type="button"'));
  assert.ok(!html.includes("formaction="));
  assert.ok(!html.includes(fake));
});

test("manual HTTP saves protect a stale draft and update the same authority used by CLI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-manual-edit-"));
  const store = new Store(dir, "9".repeat(64));
  const other = new Store(dir, "9".repeat(64));
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  const adminToken = "synthetic-manual-edit-admin-token-1064";
  try {
    await store.init();
    await store.save(platformSchema.parse({ alias: "FAKE", name: "Synthetic API",
      baseUrl: "https://example.test", auth: { type: "bearer" }, rules: [] }),
    { value: "synthetic-provider-value-1064" }, false, 0);
    const learned = await store.applyLearnedPlatform("FAKE", {
      expectedRevision: 1, sourceUrl: document.sourceUrl, title: document.title,
      markdown: document.markdown, rules: [{ method: "GET", path: "/status" }], capabilityNotes: [],
    });
    const original = structuredClone(store.platform("FAKE"));
    server = await startServers({ store, adminToken, execToken: "synthetic-manual-edit-exec-token-1064",
      webDir: path.resolve("dist/web"), adminPort: 0, managementOnly: true, log: () => {} });
    const draft = manualDraft(learned.document);
    draft.markdown = "Human draft that must survive a conflict.";
    const keptDraft = structuredClone(draft);
    await other.init();
    await other.saveDoc("FAKE", { title: document.title, sourceUrl: document.sourceUrl,
      markdown: "Updated in another session." }, "manual", learned.document.id, learned.document.revision);
    const request = (method: string, route: string, body?: unknown) => fetch(server!.adminUrl + route, {
      method, headers: { authorization: "Bearer " + adminToken, origin: server!.adminUrl,
        "x-abilock-ui": "1", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const conflict = await request("PUT", `/admin/docs/${draft.id}`, manualWrite(draft));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "REVISION_CONFLICT");
    assert.deepEqual(draft, keptDraft);
    const current = (await (await request("GET", "/admin/docs")).json()).docs[0] as SavedManual;
    assert.equal(current.markdown, "Updated in another session.");
    let fresh = continueManualDraft(draft, current);
    assert.equal(fresh.markdown, keptDraft.markdown, "review must not replace the human draft");
    fresh.markdown = current.markdown + " Human clarification.";
    await other.saveDoc("FAKE", { title: document.title, sourceUrl: document.sourceUrl,
      markdown: "A second update during review." }, "manual", current.id, current.revision);
    const secondConflict = await request("PUT", `/admin/docs/${fresh.id}`, manualWrite(fresh));
    assert.equal(secondConflict.status, 409, "accepting a reviewed version must not bypass a later conflict");
    const newest = (await (await request("GET", "/admin/docs")).json()).docs[0] as SavedManual;
    fresh = continueManualDraft(fresh, newest);
    fresh.markdown = newest.markdown + " Human clarification.";
    const saved = await request("PUT", `/admin/docs/${fresh.id}`, manualWrite(fresh));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, newest.revision + 1);
    await other.refresh();
    assert.equal(other.state.docs[0].markdown, fresh.markdown);
    assert.equal(other.platform("FAKE").revision, original.revision + 3);
    assert.equal(other.platform("FAKE").baseUrl, original.baseUrl);
    assert.equal(other.platform("FAKE").sealed, original.sealed);
    assert.deepEqual(other.platform("FAKE").rules, original.rules);
    assert.equal(server.executor.listening, false);
  } finally {
    await server?.close(); await other.close(); await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
