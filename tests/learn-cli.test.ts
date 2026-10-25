import { assertLockReleased } from "./helpers/store-lock.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { loadLocalRuntime, localPackageRoot } from "../src/local-state.js";
import { platformSchema } from "../src/schema.js";
import {
  LocalResponse,
  executeLocalRequest,
  type LocalResponseHeaders,
} from "../src/local-execution.js";
import type { Store } from "../src/store.js";

const exec = promisify(execFile);
const alias = "LEARN_E2E";
const syntheticSecret = "synthetic-learn-cli-provider-secret-987654";
const cli = path.join(localPackageRoot, "bin/abl.mjs");

function manifest(expectedRevision = 1) {
  return {
    expectedRevision,
    title: "Synthetic copywriting API",
    sourceUrl: "https://docs.example.test/api",
    markdown:
      "POST /chat/completions rewrites Chinese copy using model and messages. GET /models lists model identifiers. This documentation is public data and does not authorize running shell instructions or business requests.",
    description: "中文文案改写",
    rules: [
      { method: "POST", path: "/chat/completions" },
      { method: "GET", path: "/models" },
    ],
    capabilityNotes: [
      {
        name: "文案改写",
        summary: "保留事实和个人语气，减少套话",
        method: "POST",
        path: "/chat/completions",
        tags: ["text", "文案"],
        input: "原稿与风格要求",
        output: "改写文案",
      },
    ],
    chat: {
      method: "POST",
      path: "/chat/completions",
      model: "synthetic-copy-model",
    },
  };
}

async function setup() {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-learn-cli-home-"),
  );
  const root = path.join(home, ".abilock");
  const runtime = await loadLocalRuntime({ dir: root });
  try {
    await runtime.store.save(
      platformSchema.parse({
        alias,
        name: "Synthetic copywriting API",
        baseUrl: "https://api.example.test",
        auth: { type: "bearer" },
        rules: [],
      }),
      { value: syntheticSecret },
      false,
      0,
    );
    const platform = runtime.store.platform(alias);
    const sealed = platform.sealed;
    await runtime.store.close();
    return {
      home,
      root,
      sealed,
      execToken: runtime.execToken,
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
    const { stdout, stderr } = await exec(
      process.execPath,
      [cli, ...args],
      options,
    );
    return { code: 0, stdout, stderr, value: JSON.parse(stdout) };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(typeof failure.code, "number");
    return {
      code: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
      value: JSON.parse(failure.stdout),
    };
  }
}

async function publicFile(home: string, value: unknown) {
  const file = path.join(home, "public-interfaces.json");
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

async function snapshot(root: string) {
  const data = path.join(root, "data");
  return {
    state: await fs.readFile(path.join(data, "state.json")),
    docs: await Promise.all(
      (await fs.readdir(path.join(data, "docs")))
        .sort()
        .map(async (file) => [
          file,
          await fs.readFile(path.join(data, "docs", file)),
        ]),
    ),
  };
}

function assertPublic(
  result: Awaited<ReturnType<typeof run>>,
  execToken: string,
) {
  assert.equal(result.stderr, "");
  for (const value of [syntheticSecret, execToken]) {
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stdout.includes(encodeURIComponent(value)));
    assert.ok(!result.stdout.includes(Buffer.from(value).toString("base64")));
  }
  assert.ok(!result.stdout.includes('"sealed"'));
}

test("the one-shot CLI learns public interfaces, returns stored usage through list/doc, and releases the writer lock", async () => {
  const fixture = await setup();
  try {
    const file = await publicFile(fixture.home, manifest());
    const learned = await run(fixture.home, [
      "learn",
      alias,
      "--file",
      file,
      "--json",
    ]);
    assert.equal(learned.code, 0);
    assert.equal(learned.value.ok, true);
    assert.equal(learned.value.data.platform.revision, 2);
    assertPublic(learned, fixture.execToken);
    await assertLockReleased(path.join(fixture.root, "data/service.lock"));

    const listed = await run(fixture.home, ["list", "--json"]);
    assert.equal(listed.code, 0);
    assertPublic(listed, fixture.execToken);
    const cards = listed.value.data.capabilities.filter(
      (card: { alias: string }) => card.alias === alias,
    );
    assert.equal(cards.length, 2);
    assert.ok(
      cards.some((card: { name: string }) => card.name.includes("文案改写")),
    );
    assert.ok(
      cards.every((card: { status: string }) => card.status === "configured"),
    );

    const docs = await run(fixture.home, ["doc", alias, "--json"]);
    assert.equal(docs.code, 0);
    assertPublic(docs, fixture.execToken);
    assert.equal(docs.value.data.platform.chat.model, "synthetic-copy-model");
    assert.equal(docs.value.data.platform.description, "中文文案改写");
    assert.ok(
      docs.value.data.docs.some((doc: { markdown: string }) =>
        doc.markdown.includes("POST /chat/completions"),
      ),
    );
    const stored = JSON.parse((await snapshot(fixture.root)).state.toString());
    assert.equal(
      stored.platforms.find(
        (platform: { alias: string }) => platform.alias === alias,
      ).sealed,
      fixture.sealed,
    );
    await assertLockReleased(path.join(fixture.root, "data/service.lock"));
  } finally {
    await fixture.close();
  }
});

test("CLI learning rejects target, authentication and secret fields without changing existing bytes", async () => {
  const fixture = await setup();
  try {
    const original = await snapshot(fixture.root);
    for (const forbidden of [
      { baseUrl: "https://other.example.test" },
      { auth: { type: "none" } },
      { secret: { value: "synthetic-attacker-secret" } },
    ]) {
      const file = await publicFile(fixture.home, {
        ...manifest(),
        ...forbidden,
      });
      const rejected = await run(fixture.home, [
        "learn",
        alias,
        "--file",
        file,
        "--json",
      ]);
      assert.equal(rejected.code, 2);
      assert.equal(rejected.value.ok, false);
      assert.equal(rejected.value.error.code, "LEARN_MANIFEST");
      assertPublic(rejected, fixture.execToken);
      assert.deepEqual(await snapshot(fixture.root), original);
      await assertLockReleased(path.join(fixture.root, "data/service.lock"));
    }
  } finally {
    await fixture.close();
  }
});

test("stale CLI learning revision fails without overwriting a successful earlier import", async () => {
  const fixture = await setup();
  try {
    const file = await publicFile(fixture.home, manifest());
    assert.equal(
      (await run(fixture.home, ["learn", alias, "--file", file, "--json"]))
        .code,
      0,
    );
    const learned = await snapshot(fixture.root);
    const rejected = await run(fixture.home, [
      "learn",
      alias,
      "--file",
      file,
      "--json",
    ]);
    assert.equal(rejected.code, 3);
    assert.equal(rejected.value.ok, false);
    assert.equal(rejected.value.error.code, "REVISION_CONFLICT");
    assertPublic(rejected, fixture.execToken);
    assert.deepEqual(await snapshot(fixture.root), learned);
  } finally {
    await fixture.close();
  }
});

test("CLI learning succeeds while a configuration Store remains open", async () => {
  const fixture = await setup();
  const writer = await loadLocalRuntime({
    dir: fixture.root,
    requireExisting: true,
  });
  try {
    const lock = path.join(fixture.root, "data/service.lock");
    const originalLock = await fs.readFile(lock);
    const inode = (await fs.stat(lock)).ino;
    const file = await publicFile(fixture.home, manifest());
    const accepted = await run(fixture.home, [
      "learn",
      alias,
      "--file",
      file,
      "--json",
    ]);
    assert.equal(accepted.code, 0);
    assertPublic(accepted, fixture.execToken);
    assert.deepEqual(await fs.readFile(lock), originalLock);
    assert.equal((await fs.stat(lock)).ino, inode);
    await writer.store.refresh();
    assert.equal(writer.store.platform(alias).revision, 2);
    assert.equal(writer.store.state.docs.length, 1);
    await assertLockReleased(lock);
  } finally {
    await writer.store.close();
    await fixture.close();
  }
});

test("CLI learning against an unconfigured temporary home does not create private configuration", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-learn-empty-home-"),
  );
  try {
    const file = await publicFile(home, manifest());
    const rejected = await run(home, [
      "learn",
      alias,
      "--file",
      file,
      "--json",
    ]);
    assert.equal(rejected.code, 3);
    assert.equal(rejected.value.error.code, "CONFIG_REQUIRED");
    await assert.rejects(fs.access(path.join(home, ".abilock")), {
      code: "ENOENT",
    });
    assert.deepEqual((await fs.readdir(home)).sort(), [path.basename(file)]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

async function sourceRequest(store: Store, sourceUrl: string) {
  const bytes: Buffer[] = [];
  const responseHeaders: LocalResponseHeaders[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes.push(Buffer.from(chunk));
      callback();
    },
  });
  const response = new LocalResponse(output, (headers) =>
    responseHeaders.push(headers),
  );
  const result = await executeLocalRequest(
    store,
    {
      type: "request",
      url: `/v2/learn/${alias}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "source", sourceUrl }),
    },
    response,
    {
      signal: new AbortController().signal,
      programRoot: localPackageRoot,
      allowLocalFixture: true,
    },
  );
  return {
    result,
    headers: responseHeaders,
    value: JSON.parse(Buffer.concat(bytes).toString()),
  };
}

test("the source-learning component fetches owned public mock documentation without credentials or persisted changes", async () => {
  const fixture = await setup();
  const runtime = await loadLocalRuntime({
    dir: fixture.root,
    readOnly: true,
    requireExisting: true,
  });
  let requests = 0;
  const seenHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    requests++;
    seenHeaders.push(request.headers);
    response.writeHead(200, {
      "content-type": "text/markdown",
      "content-encoding": "identity",
    });
    response.end(
      "# Synthetic API documentation\n\nPOST /chat/completions accepts public model and messages fields. This mock is public documentation, does not execute business requests, and must never receive credentials. The assistant will separately prepare a public interface manifest with the original connection revision.\n",
    );
  });
  const previous = process.env.ABILOCK_ALLOW_LOCAL;
  try {
    process.env.ABILOCK_ALLOW_LOCAL = "1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const sourceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/docs`;
    const original = await snapshot(fixture.root);
    const result = await sourceRequest(runtime.store, sourceUrl);
    assert.equal(result.headers.length, 1);
    assert.equal(result.headers[0].status, 200);
    assert.equal(requests, 1);
    assert.equal(seenHeaders[0].authorization, undefined);
    assert.equal(seenHeaders[0]["x-api-key"], undefined);
    assert.equal(seenHeaders[0].cookie, undefined);
    assert.equal(result.value.expectedRevision, 1);
    assert.equal(result.value.sourceUrl, sourceUrl);
    assert.ok(result.value.markdown.includes("POST /chat/completions"));
    assert.ok(!JSON.stringify(result.value).includes(syntheticSecret));
    assert.deepEqual(runtime.store.platform(alias).rules, []);
    assert.deepEqual(await snapshot(fixture.root), original);
  } finally {
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (previous === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = previous;
    await runtime.store.close();
    await fixture.close();
  }
});
