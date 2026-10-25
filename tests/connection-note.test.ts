import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platformSchema, type Platform } from "../src/schema.js";
import { connectionSchema, type Connection } from "../src/connections.js";
import { Store } from "../src/store.js";
import { parseConnectionLearnManifest, parseLearnManifest } from "../src/learn.js";

const secretA = "synthetic-connection-note-key-a-147928";
const secretB = "synthetic-connection-note-key-b-294816";
const docsUrl = "https://docs.example.test/reference";

function api(alias = "API_A", changes: Partial<Platform> = {}) {
  return platformSchema.parse({
    alias,
    name: "Synthetic provider",
    baseUrl: "https://api.example.test/v1",
    auth: { type: "bearer" },
    rules: [],
    documentationUrl: docsUrl,
    ...changes,
  });
}

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
    documentationUrl: docsUrl,
    ...changes,
  });
}

function manual(expectedRevision: number) {
  return {
    expectedRevision,
    sourceUrl: docsUrl,
    title: "Synthetic usage",
    markdown: "Public usage instructions for the configured connection.",
    description: "AI-maintained usage description",
    capabilityNotes: [],
  };
}

function apiManual(expectedRevision: number) {
  return {
    ...manual(expectedRevision),
    rules: [{ method: "GET" as const, path: "/models" }],
  };
}

async function temporary(work: (store: Store, master: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-note-"));
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

test("connection notes are optional, trimmed and limited for both connection kinds", () => {
  assert.equal(api().note, undefined);
  assert.equal(database().note, undefined);
  assert.equal(api("API_A", { note: "  Personal writing  " }).note, "Personal writing");
  assert.equal(database("DB_A", { note: "  Reporting  " }).note, "Reporting");
  for (const value of ["n".repeat(201), 123, null]) {
    assert.equal(platformSchema.safeParse({ ...api(), note: value }).success, false);
    assert.equal(connectionSchema.safeParse({ ...database(), note: value }).success, false);
  }
});

test("legacy state without notes reads as empty without a read-only disk migration", async () => {
  await temporary(async (store, master) => {
    await store.save(api(), { value: secretA }, false, 0);
    await store.saveConnection(database(), { password: secretB }, false, 0);
    await store.close();
    const file = path.join(store.dir, "state.json");
    const legacy = JSON.parse(await fs.readFile(file, "utf8"));
    delete legacy.platforms[0].note;
    delete legacy.connections[0].note;
    await fs.writeFile(file, JSON.stringify(legacy));
    const before = await fs.readFile(file);
    const reader = new Store(store.dir, master, [], { readOnly: true });
    try {
      await reader.init();
      assert.equal(reader.list()[0].note, "");
      assert.equal(reader.listConnections()[0].note, "");
      assert.equal(reader.platform("API_A").note, "");
      assert.equal(reader.connection("mysql", "DB_A").note, "");
      assert.deepEqual(await fs.readFile(file), before);
    } finally {
      await reader.close();
    }
  });
});

test("API notes distinguish provider keys and survive learning, edits, rename and rotation", async () => {
  await temporary(async (store) => {
    await store.save(api("API_A", { note: "  Personal writing  " }), { value: secretA }, false, 0);
    await store.save(api("API_B", { note: "Work writing" }), { value: secretB }, false, 0);
    assert.deepEqual(store.list().map((item) => [item.alias, item.note]), [
      ["API_A", "Personal writing"], ["API_B", "Work writing"],
    ]);
    const sealed = store.platform("API_A").sealed;
    const learned = await store.applyLearnedPlatform("API_A", apiManual(1));
    assert.equal(learned.platform.note, "Personal writing");
    assert.equal(learned.platform.description, "AI-maintained usage description");
    const edited = await store.save({ ...api(), rules: learned.platform.rules, note: "Personal account" }, undefined, false, 2);
    assert.equal(edited.revision, 3);
    assert.equal(edited.note, "Personal account");
    assert.equal(edited.learnedDocId, learned.platform.learnedDocId);
    assert.deepEqual(edited.rules, learned.platform.rules);
    assert.deepEqual(store.documents("API_A"), [learned.document]);
    assert.equal(store.platform("API_A").sealed, sealed);
    await assert.rejects(store.applyLearnedPlatform("API_A", apiManual(2)), { code: "REVISION_CONFLICT" });
    const renamed = await store.save(api("API_PERSONAL", { rules: edited.rules }), undefined, false, 3, "API_A");
    assert.equal(renamed.note, "Personal account");
    assert.equal(store.documents("API_PERSONAL")[0].id, learned.document.id);
    const rotated = await store.save(api("API_PERSONAL", { rules: edited.rules }), { value: "synthetic-connection-note-rotated-384912" }, false, 4);
    assert.equal(rotated.note, "Personal account");
    const cleared = await store.save(api("API_PERSONAL", { rules: edited.rules, note: "  " }), undefined, false, 5);
    assert.equal(cleared.note, "");
    await store.remove("API_B", 1);
    assert.deepEqual(store.list().map((item) => item.alias), ["API_PERSONAL"]);
  });
});

test("protocol notes preserve learned scope and manuals during metadata edits", async () => {
  await temporary(async (store) => {
    await store.saveConnection(database("DB_A", { note: "Primary account" }), { password: secretA }, false, 0);
    await store.saveConnection(database("DB_B", { note: "Reporting account" }), { password: secretB }, false, 0);
    const learned = await store.applyLearnedConnection("DB_A", manual(1));
    const sealed = store.connection("mysql", "DB_A").sealed;
    const edited = await store.saveConnection(database("DB_A", { note: "Primary business account" }), undefined, false, 2);
    assert.equal(edited.revision, 3);
    assert.equal(edited.note, "Primary business account");
    assert.equal(edited.learnedContext, learned.connection.learnedContext);
    assert.equal(edited.learnedDocId, learned.connection.learnedDocId);
    assert.deepEqual(edited.config, learned.connection.config);
    assert.deepEqual(store.documents("DB_A"), [learned.document]);
    assert.equal(store.connection("mysql", "DB_A").sealed, sealed);
    await assert.rejects(store.applyLearnedConnection("DB_A", manual(2)), { code: "REVISION_CONFLICT" });
    const renamed = await store.saveConnection(database("DB_PRIMARY"), undefined, false, 3, "DB_A");
    assert.equal(renamed.note, "Primary business account");
    const rotated = await store.saveConnection(database("DB_PRIMARY"), { password: "synthetic-db-note-rotated-491827" }, false, 4);
    assert.equal(rotated.note, "Primary business account");
    assert.equal(rotated.learnedContext, learned.connection.learnedContext);
    const cleared = await store.saveConnection(database("DB_PRIMARY", { note: "" }), undefined, false, 5);
    assert.equal(cleared.note, "");
    await store.removeConnection("DB_B", 1);
    assert.deepEqual(store.listConnections().map((item) => item.alias), ["DB_PRIMARY"]);
  });
});

test("notes reject known credentials and credential enrollment rechecks existing notes atomically", async () => {
  await temporary(async (store) => {
    const futureSecret = "synthetic-note-future/key+392864";
    await store.save(api("API_A", { note: "Personal account" }), { value: secretA }, false, 0);
    await store.saveConnection(database("DB_A", { note: "Reporting account" }), { password: secretB }, false, 0);
    const file = path.join(store.dir, "state.json");
    const before = await fs.readFile(file);
    for (const note of [secretA, encodeURIComponent(secretA), `Bearer ${secretA}`, secretB]) {
      await assert.rejects(store.save(api("API_A", { note }), undefined, false, 1), { code: "NOTE_SECRET" });
      await assert.rejects(store.saveConnection(database("DB_A", { note }), undefined, false, 1), { code: "NOTE_SECRET" });
    }
    // Replacing or clearing the old credential cannot move it into a note.
    await assert.rejects(store.save(api("API_A", { note: secretA }), { value: "synthetic-next-api-note-916827" }, false, 1), { code: "NOTE_SECRET" });
    await assert.rejects(store.save(api("API_A", { note: secretA }), undefined, true, 1), { code: "NOTE_SECRET" });
    await assert.rejects(store.saveConnection(database("DB_A", { note: secretB }), { password: "synthetic-next-db-note-318426" }, false, 1), { code: "NOTE_SECRET" });
    await assert.rejects(store.saveConnection(database("DB_A", { note: secretB }), undefined, true, 1), { code: "NOTE_SECRET" });
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(store.save(api("API_NEW", { note: futureSecret }), { value: futureSecret }, false, 0), { code: "NOTE_SECRET" });
    await assert.rejects(store.saveConnection(database("DB_NEW", { note: futureSecret }), { password: futureSecret }, false, 0), { code: "NOTE_SECRET" });
    const updated = await store.save(api("API_A", { note: `Account label ${encodeURIComponent(futureSecret)}` }), undefined, false, 1);
    const enrolledBefore = await fs.readFile(file);
    await assert.rejects(store.save(api("API_A"), { value: futureSecret }, false, updated.revision), { code: "NOTE_SECRET" });
    await assert.rejects(store.saveConnection(database("DB_A"), { password: futureSecret }, false, 1), { code: "NOTE_SECRET" });
    assert.deepEqual(await fs.readFile(file), enrolledBefore);
    assert.equal(store.platform("API_A").revision, updated.revision);
    assert.equal(store.connection("mysql", "DB_A").revision, 1);
    assert.ok(!JSON.stringify(store.list()).includes(secretA));
    assert.ok(!JSON.stringify(store.listConnections()).includes(secretB));
  });
});

test("learning cannot replace a user-owned note", () => {
  assert.throws(() => parseLearnManifest({ ...apiManual(1), note: "AI replacement" }), { code: "LEARN_MANIFEST" });
  assert.throws(() => parseConnectionLearnManifest({ ...manual(1), note: "AI replacement" }), { code: "LEARN_MANIFEST" });
});
