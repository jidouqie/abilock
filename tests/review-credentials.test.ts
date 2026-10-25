import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AppError, platformSchema } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  createSecretByteMatcher,
  createSecretMatcher,
  redact,
  Redactor,
} from "../src/security.js";
import {
  createOperationTrace,
  runtimeInvocationId,
  safeOperationTrace,
  traceContainsCredential,
} from "../src/operation-trace.js";
import {
  operationTraceForError,
  runProtocolOperation,
  type OperationEvent,
} from "../src/operation-runner.js";
import type {
  Adapter,
  AdapterContext,
  Connection,
} from "../src/connections.js";

// Pure matchers, stub adapters and synthetic temporary stores only. No socket,
// native command, account configuration, service environment or real vault.
const fake = "Review/known credential+密碼:2026";
const master = "c".repeat(64);
function mixedPercent(text: string) {
  return text.replace(
    /%([0-9A-F])([0-9A-F])/g,
    (_whole, first: string, last: string) => `%${first.toLowerCase()}${last}`,
  );
}
function form(value: string) {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}
async function filtered(chunks: Buffer[], values: string[]) {
  const output: Buffer[] = [];
  for await (const part of Readable.from(chunks).pipe(new Redactor(values)))
    output.push(Buffer.from(part));
  return Buffer.concat(output);
}
function platform(alias = "REVIEW_HTTP") {
  return platformSchema.parse({
    alias,
    name: "Business API",
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
    rules: [{ method: "POST", path: "/business" }],
  });
}
async function withStore(work: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp("/private/tmp/abilock-review-credentials-");
  const store = new Store(dir, master);
  try {
    await store.init();
    await work(store);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function mirror(store: Store) {
  const doc = store.state.docs[0];
  return fs.readFile(
    path.join(store.dir, "docs", `${doc.alias}-${doc.id}.md`),
    "utf8",
  );
}
function context(value: string): AdapterContext {
  return {
    connection: {
      alias: "REVIEW",
      name: "Fixture",
      kind: "ssh",
      enabled: true,
      description: "",
      config: {},
    },
    secret: { password: value },
    signal: new AbortController().signal,
    allowLocal: false,
    dataDir: "/synthetic-unused-directory",
  };
}
const stub: Adapter = {
  validate: () => {},
  run: async () => ({ exitCode: 0 }),
};
const operation = { args: ["synthetic"], timeoutMs: 30000 };

test("known URL and form credential echoes accept mixed percent hex casing without changing business text", () => {
  const forms = [
    fake,
    encodeURIComponent(fake),
    mixedPercent(encodeURIComponent(fake)),
    form(fake),
    mixedPercent(form(fake)),
  ];
  for (const encoded of forms)
    assert.equal(
      redact(`before|${encoded}|after`, [fake]),
      "before|[REDACTED]|after",
    );
  assert.equal(
    redact("ordinary business content", [fake]),
    "ordinary business content",
  );
  assert.equal(
    redact("review/known credential+密碼:2026", [fake]),
    "review/known credential+密碼:2026",
  );
  assert.equal(redact("Literal%2f", ["Literal%2F"]), "Literal%2f");
});

test("character matcher reports UTF16 lengths and holds ambiguous longer prefixes", () => {
  const unicode = "合成😀秘密";
  const matcher = createSecretMatcher([unicode]);
  assert(matcher.maxLength >= unicode.length);
  assert.deepEqual(matcher.matchPrefix(unicode + "rest", true), {
    matchedLength: unicode.length,
    pending: false,
  });
  assert.deepEqual(matcher.matchPrefix(unicode.slice(0, 3)), {
    matchedLength: 0,
    pending: true,
  });
  assert.deepEqual(matcher.matchPrefix(unicode.slice(0, 3), true), {
    matchedLength: 0,
    pending: false,
  });
  const overlapping = createSecretMatcher(["abc", "abcdef"]);
  assert.deepEqual(overlapping.matchPrefix("abc"), {
    matchedLength: 0,
    pending: true,
  });
  assert.deepEqual(overlapping.matchPrefix("abc", true), {
    matchedLength: 3,
    pending: false,
  });
  assert.deepEqual(overlapping.matchPrefix("abcdef", true), {
    matchedLength: 6,
    pending: false,
  });
});

test("raw bytes preserve non-UTF8 surroundings across every chunk boundary while matching URL forms", async () => {
  const echo = mixedPercent(form(fake));
  const bytes = Buffer.concat([
    Buffer.from([0, 255]),
    Buffer.from(echo),
    Buffer.from([254, 1]),
  ]);
  const expected = Buffer.concat([
    Buffer.from([0, 255]),
    Buffer.from("[REDACTED]"),
    Buffer.from([254, 1]),
  ]);
  for (let split = 1; split < bytes.length; split++)
    assert.deepEqual(
      await filtered([bytes.subarray(0, split), bytes.subarray(split)], [fake]),
      expected,
    );
  const rawUnicode = Buffer.from(fake);
  const byteMatcher = createSecretByteMatcher([fake]);
  assert.deepEqual(byteMatcher.matchPrefix(rawUnicode, true), {
    matchedLength: rawUnicode.length,
    pending: false,
  });
  assert.deepEqual(
    await filtered([Buffer.from("abc"), Buffer.from("def")], ["abc", "abcdef"]),
    Buffer.from("[REDACTED]"),
  );
});

test("percent equivalent matching changes only escape hex letters", () => {
  const matcher = createSecretMatcher(["Case/Secret"]);
  assert.deepEqual(matcher.matchPrefix("Case%2fSecret", true), {
    matchedLength: 13,
    pending: false,
  });
  for (const text of [
    "case%2fSecret",
    "Case%2fsecret",
    "Case%\u0012fSecret",
    "Case%2gSecret",
  ])
    assert.deepEqual(matcher.matchPrefix(text, true), {
      matchedLength: 0,
      pending: false,
    });
});

test("safe trace preserves normal IDs and ignores public UUID fragments of short credentials", () => {
  const trace = createOperationTrace();
  assert.deepEqual(safeOperationTrace(trace, ["4", "-", "a"]), trace);
  assert.equal(traceContainsCredential(trace.invocationId, ["4"]), false);
  const clone = safeOperationTrace(trace, []);
  assert.notEqual(clone, trace);
  assert.equal(createOperationTrace().invocationId, trace.invocationId);
});

test("full known runtime credential collisions select stable safe defaults for narrower consumers", () => {
  const incoming = {
    invocationId: runtimeInvocationId,
    operationId: runtimeInvocationId,
  };
  const safe = safeOperationTrace(incoming, [runtimeInvocationId]);
  assert.notEqual(safe.invocationId, runtimeInvocationId);
  assert.notEqual(safe.operationId, runtimeInvocationId);
  assert.deepEqual(incoming, {
    invocationId: runtimeInvocationId,
    operationId: runtimeInvocationId,
  });
  assert.equal(
    safeOperationTrace(incoming, [runtimeInvocationId]).invocationId,
    safe.invocationId,
  );
  // A same-process gateway has fewer known secrets but must not restart using
  // the UUID that the core has already established is a complete credential.
  assert.equal(
    safeOperationTrace(createOperationTrace(), ["synthetic-exec-only"])
      .invocationId,
    safe.invocationId,
  );
  assert.equal(createOperationTrace().invocationId, safe.invocationId);
});

test("safe UUID reselection is bounded and verifies each generated candidate", (t) => {
  const colliding = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const trace = createOperationTrace();
  let generated = 0;
  t.mock.method(crypto, "randomUUID", () => {
    generated++;
    return colliding;
  });
  assert.throws(
    () => safeOperationTrace({ ...trace, operationId: colliding }, [colliding]),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "TRACE_INVALID" &&
      !error.message.includes(colliding),
  );
  assert.equal(generated, 32);
});

test("pure protocol runner keeps short credentials usable and rejects exact caller credential UUID safely", async () => {
  const publicId = "44444444-4444-4444-8444-444444444444";
  const normal = await runProtocolOperation(stub, context("4"), {
    ...operation,
    trace: { invocationId: publicId },
  });
  assert.equal(normal.exitCode, 0);
  assert.equal(normal.invocationId, publicId);
  const events: OperationEvent[] = [];
  const defaulted = await runProtocolOperation(
    stub,
    context(runtimeInvocationId),
    operation,
  );
  assert.notEqual(defaulted.invocationId, runtimeInvocationId);
  await assert.rejects(
    runProtocolOperation(
      stub,
      context(runtimeInvocationId),
      { ...operation, trace: { invocationId: runtimeInvocationId } },
      undefined,
      (event) => {
        events.push(event);
      },
    ),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, "TRACE_INVALID");
      assert.notEqual(
        operationTraceForError(error)?.invocationId,
        runtimeInvocationId,
      );
      assert(!JSON.stringify(error).includes(runtimeInvocationId));
      return true;
    },
  );
  assert(!JSON.stringify(events).includes(runtimeInvocationId));
});

test("an HTTP auth change scrubs earlier document bodies, keeps the target, and invalidates old interface rules", async () => {
  await withStore(async (store) => {
    const original = platform();
    await store.save(original, undefined, false, 0);
    const doc = await store.saveDoc(
      original.alias,
      {
        title: "Guide",
        sourceUrl: "https://example.com/docs",
        markdown: `ordinary|${fake}|${mixedPercent(form(fake))}|tail`,
      },
      "manual",
    );
    const secured = { ...original, auth: { type: "bearer" as const } };
    await store.save(secured, { value: fake }, false, 1);
    const cleaned = store.state.docs[0];
    assert.equal(cleaned.markdown, "ordinary|[REDACTED]|[REDACTED]|tail");
    assert.equal(cleaned.revision, doc.revision + 1);
    assert.equal(cleaned.id, doc.id);
    assert.equal(cleaned.title, doc.title);
    assert.equal(cleaned.sourceUrl, doc.sourceUrl);
    assert.equal(store.platform(original.alias).baseUrl, original.baseUrl);
    assert.deepEqual(store.platform(original.alias).rules, []);
    assert.deepEqual(store.unseal(store.platform(original.alias).sealed!), {
      value: fake,
    });
    assert(
      !(await fs.readFile(path.join(store.dir, "state.json"), "utf8")).includes(
        fake,
      ),
    );
    assert(!(await mirror(store)).includes(fake));
    assert(
      (await mirror(store)).includes("ordinary|[REDACTED]|[REDACTED]|tail"),
    );
  });
});

test("a protocol credential added later scrubs earlier documentation across aliases", async () => {
  await withStore(async (store) => {
    const original = platform();
    await store.save(original, undefined, false, 0);
    const username = "synthetic-user-review-credentials";
    const pair = Buffer.from(`${username}:${fake}`).toString("base64");
    await store.saveDoc(
      original.alias,
      {
        title: "Guide",
        sourceUrl: "https://example.com/docs",
        markdown: `ordinary|${mixedPercent(encodeURIComponent(pair))}|${fake}`,
      },
      "manual",
    );
    const registry: Connection = {
      alias: "REVIEW_REGISTRY",
      name: "Fixture",
      kind: "registry",
      enabled: true,
      description: "",
      config: {
        endpoint: "https://registry.example.com",
        authType: "basic",
        allowedRepositories: ["business/repo"],
      },
    };
    await store.saveConnection(
      registry,
      { username, password: fake },
      false,
      0,
    );
    assert.equal(
      store.state.docs[0].markdown,
      "ordinary|[REDACTED]|[REDACTED]",
    );
    assert(!(await mirror(store)).includes(fake));
  });
});

test("old synthetic state is scrubbed and atomically persisted before its documentation is re-exported", async () => {
  await withStore(async (first) => {
    const original = platform();
    await first.save(original, undefined, false, 0);
    await first.saveDoc(
      original.alias,
      {
        title: "Guide",
        sourceUrl: "https://example.com/docs",
        markdown: `ordinary|${fake}`,
      },
      "manual",
    );
    const legacy = structuredClone(first.state);
    legacy.platforms[0].auth = { type: "bearer" };
    legacy.platforms[0].sealed = first.seal({ value: fake });
    await first.close();
    await fs.writeFile(
      path.join(first.dir, "state.json"),
      JSON.stringify(legacy),
      { mode: 0o600 },
    );
    const restored = new Store(first.dir, master);
    try {
      await restored.init();
      assert.equal(restored.state.docs[0].markdown, "ordinary|[REDACTED]");
      assert.equal(
        restored.state.docs[0].revision,
        legacy.docs[0].revision + 1,
      );
      assert(
        !(
          await fs.readFile(path.join(first.dir, "state.json"), "utf8")
        ).includes(fake),
      );
      assert(!(await mirror(restored)).includes(fake));
      const once = await fs.readFile(path.join(first.dir, "state.json"));
      await restored.close();
      const again = new Store(first.dir, master);
      try {
        await again.init();
        assert.deepEqual(
          await fs.readFile(path.join(first.dir, "state.json")),
          once,
        );
        assert.equal(
          again.state.docs[0].revision,
          restored.state.docs[0].revision,
        );
      } finally {
        await again.close();
      }
    } finally {
      await restored.close();
    }
  });
});

test("rejected final credential metadata leaves state and document mirror bytes untouched", async () => {
  await withStore(async (store) => {
    const original = platform();
    await store.save(original, undefined, false, 0);
    await store.saveDoc(
      original.alias,
      {
        title: fake,
        sourceUrl: "https://example.com/docs",
        markdown: `ordinary|${fake}`,
      },
      "manual",
    );
    const snapshot = {
      state: structuredClone(store.state),
      bytes: await fs.readFile(path.join(store.dir, "state.json")),
      mirror: await mirror(store),
      entries: await fs.readdir(store.dir),
    };
    await assert.rejects(
      store.save(
        { ...original, auth: { type: "bearer" } },
        { value: fake },
        false,
        1,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "DOC_METADATA_SECRET",
    );
    assert.deepEqual(store.state, snapshot.state);
    assert.deepEqual(
      await fs.readFile(path.join(store.dir, "state.json")),
      snapshot.bytes,
    );
    assert.equal(await mirror(store), snapshot.mirror);
    assert.deepEqual(await fs.readdir(store.dir), snapshot.entries);
  });
});

test("repeated document scrubbing with a short credential leaves the public replacement marker stable", async () => {
  await withStore(async (store) => {
    const secured = { ...platform(), auth: { type: "bearer" as const } };
    await store.save(secured, { value: "R" }, false, 0);
    const doc = await store.saveDoc(
      secured.alias,
      {
        title: "Guide",
        sourceUrl: "https://example.com/docs",
        markdown: "Ordinary R text",
      },
      "manual",
    );
    assert.equal(doc.markdown, "Ordinary [REDACTED] text");
    await store.save({ ...secured, enabled: false }, undefined, false, 1);
    assert.equal(store.state.docs[0].markdown, doc.markdown);
    assert.equal(store.state.docs[0].revision, doc.revision);
  });
});
