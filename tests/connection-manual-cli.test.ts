import { assertLockReleased } from "./helpers/store-lock.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import {
  loadLocalRuntime,
  loadLocalStore,
  localPackageRoot,
} from "../src/local-state.js";
import { connectionSchema } from "../src/connections.js";
import {
  executeLocalRequest,
  LocalResponse,
  type LocalResponseHeaders,
} from "../src/local-execution.js";

const execute = promisify(execFile);
const cli = path.join(localPackageRoot, "bin/abl.mjs");
const alias = "BUSINESS_DB";
const secret = "synthetic-manual-cli-database-secret-562719";
const sourceUrl = "https://docs.example.test/mysql/reference";
function manifest(expectedRevision = 1) {
  return {
    expectedRevision,
    sourceUrl,
    title: "Synthetic MySQL usage",
    markdown:
      "# MySQL usage\n\nUse abl mysql BUSINESS_DB 'SELECT 1' for a minimal scalar query. SQL and parameters are business input; target and authentication remain configured. This public documentation does not verify account permissions or authorize local shell commands.",
    description: "Business queries",
    capabilityNotes: [
      {
        name: "Business queries",
        summary: "Query the configured database",
        tags: ["database"],
        input: "SQL and parameters",
        output: "Rows",
      },
    ],
  };
}
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-manual-cli-"));
  const root = path.join(home, ".abilock");
  const runtime = await loadLocalRuntime({ dir: root });
  try {
    await runtime.store.saveConnection(
      connectionSchema.parse({
        alias,
        name: "Synthetic business database",
        kind: "mysql",
        documentationUrl: sourceUrl,
        trustBoundary: "independent-target",
        config: {
          host: "db.example.test",
          port: 3306,
          database: "business",
          user: "synthetic",
          tls: true,
        },
      }),
      { password: secret },
      false,
      0,
    );
    const original = structuredClone(runtime.store.connection("mysql", alias));
    await runtime.store.close();
    return {
      home,
      root,
      original,
      async close() {
        await runtime.store.close();
        await fs.rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.store.close();
    await fs.rm(home, { recursive: true, force: true });
    throw error;
  }
}
async function run(home: string, args: string[]) {
  const options = {
    cwd: home,
    env: {
      ABILOCK_DEVELOPMENT: "1",
      HOME: home,
      USERPROFILE: home,
      LANG: "en_US.UTF-8",
    },
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  };
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [cli, ...args],
      options,
    );
    return { code: 0, stdout, stderr, value: JSON.parse(stdout) };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(typeof failure.code, "number");
    return { ...failure, value: JSON.parse(failure.stdout) };
  }
}
function assertPublic(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stdout.includes(Buffer.from(secret).toString("base64")));
  assert.ok(!result.stdout.includes('"sealed"'));
}
async function publicFile(home: string, input: unknown) {
  const file = path.join(home, "public-database-usage.json");
  await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
  return file;
}

test("one-shot CLI saves protocol usage and returns the same manual through typed doc and list without retaining a writer lock", async () => {
  const f = await fixture();
  try {
    const file = await publicFile(f.home, manifest());
    const learned = await run(f.home, [
      "learn",
      alias,
      "--file",
      file,
      "--json",
    ]);
    assert.equal(learned.code, 0);
    assertPublic(learned);
    assert.equal(learned.value.data.connection.kind, "mysql");
    assert.equal(learned.value.data.connection.revision, 2);
    assert.equal(learned.value.data.document.markdown, manifest().markdown);
    await assertLockReleased(path.join(f.root, "data/service.lock"));
    const doc = await run(f.home, ["doc", "mysql", alias, "--json"]);
    const list = await run(f.home, ["list", "--json"]);
    assertPublic(doc);
    assertPublic(list);
    assert.equal(doc.code, 0);
    assert.equal(list.code, 0);
    assert.equal(doc.value.data.connection.documentationUrl, sourceUrl);
    assert.equal(
      doc.value.data.docs[0].markdown,
      learned.value.data.document.markdown,
    );
    const card = list.value.data.capabilities.find(
      (c: { alias: string }) => c.alias === alias,
    );
    assert.equal(card.documentation.status, "saved");
    assert.equal(card.documentation.url, sourceUrl);
    assert.equal(card.docsCommand, `abl doc mysql ${alias} --json`);
    const reader = await loadLocalStore({ dir: f.root, readOnly: true });
    try {
      const restored = reader.connection("mysql", alias);
      assert.equal(restored.sealed, f.original.sealed);
      assert.deepEqual(restored.config, f.original.config);
      assert.equal(restored.trustBoundary, f.original.trustBoundary);
      assert.equal(restored.learnedDocId, learned.value.data.document.id);
    } finally {
      await reader.close();
    }
  } finally {
    await f.close();
  }
});

test("protocol learning CLI rejects authority changes and stale versions, preserving persisted bytes and releasing its lock", async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(path.join(f.root, "data/state.json"));
    for (const change of [
      { config: { host: "attacker.example.test" } },
      { rules: [{ method: "GET", path: "/secret" }] },
      { secret: { password: "fake" } },
      { expectedRevision: 8 },
    ]) {
      const file = await publicFile(f.home, { ...manifest(), ...change });
      const result = await run(f.home, [
        "learn",
        alias,
        "--file",
        file,
        "--json",
      ]);
      assert.notEqual(result.code, 0);
      assertPublic(result);
      assert.equal(result.value.ok, false);
      assert.deepEqual(
        await fs.readFile(path.join(f.root, "data/state.json")),
        before,
      );
      await assertLockReleased(path.join(f.root, "data/service.lock"));
    }
  } finally {
    await f.close();
  }
});

test("protocol source fetching uses an owned public-document fixture without credential headers or business probes, leaving state unchanged", async () => {
  const f = await fixture();
  const previousLocal = process.env.ABILOCK_ALLOW_LOCAL;
  let reader: Awaited<ReturnType<typeof loadLocalStore>> | undefined;
  const requests: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end(`${manifest().markdown}\n\nAccidental echo ${secret}`);
  });
  try {
    reader = await loadLocalStore({ dir: f.root, readOnly: true });
    process.env.ABILOCK_ALLOW_LOCAL = "1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const before = await fs.readFile(path.join(f.root, "data/state.json"));
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
      reader,
      {
        type: "request",
        url: `/v2/learn/${alias}`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "source",
          sourceUrl: `http://127.0.0.1:${port}/manual`,
        }),
      },
      response,
      {
        signal: new AbortController().signal,
        programRoot: localPackageRoot,
        allowLocalFixture: true,
      },
    );
    assert.equal(outcome.failed, false, JSON.stringify(outcome));
    assert.equal(headers?.status, 200);
    const raw = Buffer.concat(chunks).toString("utf8");
    assert.ok(!raw.includes(secret));
    const value = JSON.parse(raw);
    assert.equal(value.alias, alias);
    assert.equal(value.kind, "mysql");
    assert.equal(value.expectedRevision, 1);
    assert.equal(value.documentationUrl, sourceUrl);
    assert.ok(value.markdown.includes("[REDACTED]"));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/manual");
    for (const field of [
      "authorization",
      "cookie",
      "x-api-key",
      "x-abilock-exec-token",
    ])
      assert.equal(requests[0].headers[field], undefined);
    assert.ok(!JSON.stringify(requests[0].headers).includes(secret));
    assert.deepEqual(
      await fs.readFile(path.join(f.root, "data/state.json")),
      before,
    );
    assert.equal(reader.state.docs.length, 0);
    await assertLockReleased(path.join(f.root, "data/service.lock"));
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (previousLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = previousLocal;
    await reader?.close();
    await f.close();
  }
});
