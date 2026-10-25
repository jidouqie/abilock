import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { platformSchema } from "../src/schema.js";
import { startServers } from "../src/server.js";
import {
  LocalResponse,
  executeLocalRequest,
  type LocalResponseHeaders,
} from "../src/local-execution.js";
import { loadLocalRuntime } from "../src/local-state.js";

const fakeKey = "synthetic-export-test-only-key-729438";
const adminToken = "synthetic-export-test-admin-729439";
const execToken = "synthetic-export-test-exec-729440";
const syntheticFailure = "synthetic-private-error-must-not-be-public-729441";
const alias = "EXPORT";
const platform = platformSchema.parse({
  alias,
  name: "Synthetic export API",
  baseUrl: "https://api.example.test",
  auth: { type: "bearer" },
  documentationUrl: "https://docs.example.test/reference",
  rules: [{ method: "GET", path: "/models" }],
});
function manifest(
  expectedRevision = 1,
  markdown = "Public usage committed successfully",
) {
  return {
    expectedRevision,
    title: "Public usage",
    sourceUrl: "https://docs.example.test/reference",
    markdown,
    rules: [{ method: "GET", path: "/models" }],
    capabilityNotes: [],
  };
}
function assertPublic(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [fakeKey, adminToken, execToken, syntheticFailure]) {
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(Buffer.from(secret).toString("base64")));
  }
  assert.ok(!text.includes('"sealed"'));
}
async function localRequest(store: Store, url: string, body?: unknown) {
  const chunks: Buffer[] = [];
  let headers: LocalResponseHeaders | undefined;
  const response = new LocalResponse(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    (value) => {
      headers = value;
    },
  );
  await executeLocalRequest(
    store,
    {
      type: "request",
      url,
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    response,
    { programRoot: path.resolve("."), signal: new AbortController().signal },
  );
  const text = Buffer.concat(chunks).toString("utf8");
  assertPublic(text);
  return { status: headers?.status, value: JSON.parse(text) };
}

test("committed manual export failure is visible in local and HTTP responses and clears after repair", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-public-export-"),
  );
  const store = new Store(dir, "7".repeat(64));
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  let reader: Store | undefined;
  try {
    await store.init();
    await store.save(platform, { value: fakeKey }, false, 0);
    server = await startServers({
      store,
      adminToken,
      execToken,
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      execPort: 0,
      log: () => {},
    });
    const rename = fs.rename.bind(fs);
    const failure = t.mock.method(
      fs,
      "rename",
      async (from: PathLike, to: PathLike) => {
        if (
          typeof to === "string" &&
          to.startsWith(path.join(dir, "docs") + path.sep)
        )
          throw new Error(syntheticFailure);
        return rename(from, to);
      },
    );
    const learned = await localRequest(store, `/v2/learn/${alias}`, {
      kind: "manifest",
      manifest: manifest(),
    });
    assert.equal(learned.status, 200);
    assert.equal(
      learned.value.document.markdown,
      "Public usage committed successfully",
    );
    assert.equal(learned.value.docsExportStatus.status, "pending");
    assert.equal(
      learned.value.docsExportStatus.code,
      "DOCUMENT_EXPORT_PENDING",
    );
    assert.match(learned.value.docsExportStatus.message, /已保存/);
    for (const url of ["/v2/discovery", `/v1/context/${alias}`]) {
      const local = await localRequest(store, url);
      assert.equal(local.status, 200);
      assert.equal(local.value.docsExportStatus.status, "pending");
      const httpResponse: Response = await fetch(server.execUrl + url, {
        headers: { authorization: `Bearer ${execToken}` },
      });
      assert.equal(httpResponse.status, 200);
      const publicData = await httpResponse.json();
      assertPublic(publicData);
      assert.equal(publicData.docsExportStatus.status, "pending");
    }
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      origin: server.adminUrl,
      "x-abilock-ui": "1",
    };
    const admin = await fetch(server.adminUrl + "/admin/docs", {
      headers: adminHeaders,
    });
    const adminData = await admin.json();
    assert.equal(admin.status, 200);
    assertPublic(adminData);
    assert.equal(adminData.docs[0].markdown, learned.value.document.markdown);
    assert.equal(adminData.documentationStatuses[alias], "saved");
    assert.equal(adminData.docsExportStatus.status, "pending");
    const stale = await localRequest(store, `/v2/learn/${alias}`, {
      kind: "manifest",
      manifest: manifest(),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.value.error.code, "REVISION_CONFLICT");
    assert.equal(stale.value.docsExportStatus.status, "pending");
    reader = new Store(dir, "7".repeat(64), [], { readOnly: true });
    await reader.init();
    const readSnapshot = await localRequest(reader, `/v1/context/${alias}`);
    assert.equal(
      readSnapshot.value.docs[0].markdown,
      learned.value.document.markdown,
    );
    assert.equal(readSnapshot.value.docsExportStatus.status, "pending");
    await reader.close();
    const savedByHttp = await fetch(
      server.adminUrl + `/admin/docs/${learned.value.document.id}`,
      {
        method: "PUT",
        headers: { ...adminHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: learned.value.document.revision,
          doc: {
            title: "Public usage",
            sourceUrl: "https://docs.example.test/reference",
            markdown: "Public manual saved through management HTTP",
          },
        }),
      },
    );
    assert.equal(savedByHttp.status, 200);
    const httpSaveResult = await savedByHttp.json();
    assertPublic(httpSaveResult);
    assert.equal(httpSaveResult.docsExportStatus.status, "pending");
    assert.equal(
      httpSaveResult.markdown,
      "Public manual saved through management HTTP",
    );
    assert.equal(
      (await localRequest(store, `/v1/context/${alias}`)).value.docs[0]
        .markdown,
      httpSaveResult.markdown,
    );
    failure.mock.restore();
    const latestContext = await localRequest(store, `/v1/context/${alias}`);
    assert.equal(latestContext.value.platform.revision, 3,
      "manual edits advance the learned connection revision");
    const rejectedOldLearning = await localRequest(store, `/v2/learn/${alias}`, {
      kind: "manifest", manifest: manifest(2, "Stale manual must not overwrite the human edit"),
    });
    assert.equal(rejectedOldLearning.status, 409);
    assert.equal(rejectedOldLearning.value.error.code, "REVISION_CONFLICT");
    const repaired = await localRequest(store, `/v2/learn/${alias}`, {
      kind: "manifest",
      manifest: manifest(latestContext.value.platform.revision, "Repaired public manual"),
    });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.value.docsExportStatus, undefined);
    assert.match(
      await fs.readFile(
        path.join(dir, "docs", `${alias}-${repaired.value.document.id}.md`),
        "utf8",
      ),
      /Repaired public manual/,
    );
    await assert.rejects(fs.access(path.join(dir, ".docs-export-pending")), {
      code: "ENOENT",
    });
    const ready = await fetch(server.adminUrl + "/admin/docs", {
      headers: adminHeaders,
    });
    const readyData = await ready.json();
    assertPublic(readyData);
    assert.deepEqual(readyData.docsExportStatus, { status: "ready" });
    assert.equal(readyData.documentationStatuses[alias], "saved");
    assert.equal(
      (await localRequest(store, `/v1/context/${alias}`)).value
        .docsExportStatus,
      undefined,
    );
  } finally {
    await reader?.close();
    await server?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI learn warns only for a committed manifest and retains valid JSON; next invocation repairs exports", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-cli-export-"));
  const root = path.join(home, ".abilock");
  const runtime = await loadLocalRuntime({ dir: root });
  const docs = path.join(root, "data/docs");
  const exec = promisify(execFile);
  const publicFile = path.join(home, "public-manifest.json");
  async function run(args: string[]) {
    try {
      const result = await exec(
        process.execPath,
        [path.resolve("bin/abl.mjs"), ...args],
        {
          cwd: home,
          env: {
            HOME: home,
            USERPROFILE: home,
            ABILOCK_DEVELOPMENT: "1",
            LANG: "en_US.UTF-8",
          },
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
      assertPublic(result.stdout + result.stderr);
      return { code: 0, ...result, value: JSON.parse(result.stdout) };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(typeof result.code, "number");
      assertPublic(result.stdout + result.stderr);
      return { ...result, value: JSON.parse(result.stdout) };
    }
  }
  try {
    await runtime.store.save(platform, { value: fakeKey }, false, 0);
    await runtime.store.close();
    await fs.chmod(docs, 0o500);
    await fs.writeFile(publicFile, JSON.stringify(manifest()));
    const learned = await run(["learn", alias, "--file", publicFile, "--json"]);
    assert.equal(learned.code, 0, learned.stderr);
    assert.equal(learned.value.ok, true);
    assert.equal(learned.value.data.docsExportStatus.status, "pending");
    assert.match(learned.stderr, /已保存；Markdown 副本待重建/);
    const stale = await run(["learn", alias, "--file", publicFile, "--json"]);
    assert.equal(stale.code, 3);
    assert.equal(stale.value.ok, false);
    assert.equal(stale.value.error.code, "REVISION_CONFLICT");
    assert.doesNotMatch(stale.stderr, /已保存/);
    const context = await run(["doc", alias, "--json"]);
    assert.equal(context.code, 0);
    assert.equal(
      context.value.data.docs[0].markdown,
      "Public usage committed successfully",
    );
    await fs.chmod(docs, 0o700);
    await fs.writeFile(
      publicFile,
      JSON.stringify(manifest(2, "Repaired by next CLI invocation")),
    );
    const repaired = await run([
      "learn",
      alias,
      "--file",
      publicFile,
      "--json",
    ]);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(repaired.value.data.docsExportStatus, undefined);
    assert.equal(repaired.stderr, "");
    assert.match(
      await fs.readFile(
        path.join(docs, `${alias}-${repaired.value.data.document.id}.md`),
        "utf8",
      ),
      /Repaired by next CLI invocation/,
    );
  } finally {
    await fs.chmod(docs, 0o700).catch(() => {});
    await runtime.store.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
