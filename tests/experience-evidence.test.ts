import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Writable } from "node:stream";
import {
  createExperienceObserver,
  EXPERIENCE_CAPTURE_BYTES,
} from "../src/experience-evidence.js";
import {
  platformSchema,
  requestSchema,
  type SavedPlatform,
} from "../src/schema.js";
import { Store } from "../src/store.js";
import { execute } from "../src/proxy.js";
import { ExperienceStore } from "../src/experience-store.js";

const secret = "synthetic-evidence-secret-556677";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpGQAAAAASUVORK5CYII=";
function platform(baseUrl = "https://openrouter.ai/api/v1"): SavedPlatform {
  return {
    ...platformSchema.parse({
      alias: "OR",
      name: "Synthetic image API",
      baseUrl,
      auth: { type: "bearer" },
      rules: [
        { method: "POST", path: "/images" },
        { method: "POST", path: "/chat/completions" },
      ],
    }),
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
}
function call(
  body: unknown = {
    model: "test/image-model",
    prompt: "Private user story",
    n: 1,
  },
  route = "/images",
) {
  return requestSchema.parse({
    method: "POST",
    path: route,
    body,
    experience: { capture: true },
  });
}
function observe(
  response: unknown,
  status = 200,
  input = call(),
  p = platform(),
  contentType = "application/json",
) {
  const observer = createExperienceObserver(p, input, crypto.randomUUID(), [
    secret,
  ]);
  assert.ok(observer);
  observer.write(
    Buffer.from(
      typeof response === "string" ? response : JSON.stringify(response),
    ),
  );
  return observer.finish(status, contentType);
}

test("OpenRouter image success requires real image structure and stores only typed placeholders", () => {
  const input = call({
    model: "test/image-model",
    prompt: `${secret} https://example.com/?token=private`,
    n: 876543,
    input_references: [
      {
        type: "image_url",
        image_url: { url: "https://example.com/image?token=private" },
      },
    ],
  });
  const evidence = observe(
    { data: [{ b64_json: png }], privateResult: secret },
    200,
    input,
  );
  assert.equal(evidence.level, "machine-verified");
  assert.equal(evidence.validator, "openrouter-image");
  assert.equal(evidence.reason, "verified");
  const serialized = JSON.stringify(evidence);
  for (const privateValue of [
    secret,
    "token=private",
    png,
    "876543",
    "Private user story",
  ])
    assert.ok(!serialized.includes(privateValue));
  assert.ok(serialized.includes("{{model}}"));
  assert.ok(serialized.includes("{{number}}"));
});

test("HTTP 200, JSON success words, arbitrary base64, URLs and incomplete image chunks are not image proof", () => {
  for (const response of [
    { success: true },
    { data: [] },
    { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] },
    { data: [{ url: "https://example.com/result?token=secret" }] },
    { data: [{ b64_json: png.slice(0, -8) }] },
  ]) {
    const evidence = observe(response);
    assert.equal(evidence.level, "transport-only");
    assert.equal(evidence.outcome, "uncertain-failure");
  }
  assert.equal(
    observe("<html>Login</html>", 200, call(), platform(), "text/html").level,
    "transport-only",
  );
});

test("only exact known provider/auth/base and an internal loopback fixture can produce verified evidence", () => {
  for (const target of [
    "https://openrouter.ai.evil.example/api/v1",
    "https://openrouter.ai/custom",
    "https://api.example.com/api/v1",
    "http://127.0.0.1:9988/api/v1",
  ]) {
    const evidence = observe(
      { data: [{ b64_json: png }] },
      200,
      call(),
      platform(target),
    );
    assert.equal(evidence.level, "transport-only");
    assert.equal(evidence.reason, "unsupported-provider");
  }
  const badAuth = platform();
  badAuth.auth = { type: "none" };
  assert.equal(
    observe({ data: [{ b64_json: png }] }, 200, call(), badAuth).level,
    "transport-only",
  );
  const fixture = createExperienceObserver(
    platform("http://127.0.0.1:9988/api/v1"),
    call(),
    crypto.randomUUID(),
    [],
    { fixture: true },
  );
  assert.ok(fixture);
  fixture.write(Buffer.from(JSON.stringify({ data: [{ b64_json: png }] })));
  assert.equal(
    fixture.finish(200, "application/json").level,
    "machine-verified",
  );
});

test("changing prompts, values and array length produces the same request structure", () => {
  const a = observe(
    { data: [{ b64_json: png }] },
    200,
    call({ model: "test/image-model", prompt: "A", n: 1, seed: 5 }),
  );
  const b = observe(
    { data: [{ b64_json: png }] },
    200,
    call({ model: "test/image-model", prompt: "B", n: 2, seed: 9000 }),
  );
  assert.deepEqual(a.parameters, b.parameters);
  assert.deepEqual(a.template, b.template);
  const text = (messages: unknown[]) =>
    call({ model: "test/chat", messages }, "/chat/completions");
  const one = createExperienceObserver(
    platform(),
    text([{ role: "user", content: "secret one" }]),
    crypto.randomUUID(),
    [],
  );
  const two = createExperienceObserver(
    platform(),
    text([
      { role: "system", content: "secret two" },
      { role: "user", content: "secret three" },
    ]),
    crypto.randomUUID(),
    [],
  );
  assert.deepEqual(
    one?.finish(200, "text/plain").template,
    two?.finish(200, "text/plain").template,
  );
});

test("deep, oversized, unsafe and mixed shapes decline capture without throwing", () => {
  const nested: Record<string, unknown> = {};
  let node = nested;
  for (let i = 0; i < 12; i++) {
    node.next = {};
    node = node.next as Record<string, unknown>;
  }
  const many = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`param${i}`, "private"]),
  );
  for (const body of [
    nested,
    many,
    { model: secret },
    { "private field": "value" },
    { values: [1, "different"] },
    { model: "test/image-model", PrivateUserPromptText123: "value" },
    { model: "test/image-model", metadata: { privatePrompt: "value" } },
    {
      model: "test/chat",
      messages: [
        { role: "user", content: { PrivateUserPromptText123: "value" } },
      ],
    },
  ])
    assert.equal(
      createExperienceObserver(platform(), call(body), crypto.randomUUID(), [
        secret,
      ]),
      undefined,
    );
  assert.equal(
    createExperienceObserver(
      platform(),
      requestSchema.parse({ ...call(), headers: { "x-mode": "value" } }),
      crypto.randomUUID(),
      [],
    ),
    undefined,
  );
  const dynamic = platform();
  dynamic.rules = [{ method: "POST", path: "/images/{id}" }];
  assert.equal(
    createExperienceObserver(
      dynamic,
      { ...call(), path: "/images/private-id" },
      crypto.randomUUID(),
      [],
    ),
    undefined,
  );
});

test("capture limits, streaming and incomplete responses never become successful business evidence", () => {
  const observer = createExperienceObserver(
    platform(),
    call(),
    crypto.randomUUID(),
    [],
  );
  assert.ok(observer);
  observer.write(Buffer.alloc(EXPERIENCE_CAPTURE_BYTES + 1));
  const oversized = observer.finish(200, "application/json");
  assert.equal(oversized.reason, "response-too-large");
  assert.equal(oversized.level, "transport-only");
  const streaming = observe(
    { data: [{ b64_json: png }] },
    200,
    call({ model: "test/image", stream: true }),
  );
  assert.equal(streaming.level, "transport-only");
  const incomplete = createExperienceObserver(
    platform(),
    call(),
    crypto.randomUUID(),
    [],
  );
  assert.ok(incomplete);
  incomplete.write(Buffer.from(JSON.stringify({ data: [{ b64_json: png }] })));
  assert.equal(
    incomplete.finish(200, "application/json", false).outcome,
    "temporary-failure",
  );
});

const chat = {
  model: "test/chat",
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: "Private generated text" },
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};
test("chat proof checks actual model, final stop, text and consistent usage; no response text retained", () => {
  const input = call(
    {
      model: "test/chat",
      messages: [{ role: "user", content: "Private user question" }],
      stream: false,
    },
    "/chat/completions",
  );
  const result = observe(chat, 200, input);
  assert.equal(result.level, "machine-verified");
  assert.equal(result.validator, "openai-chat");
  assert.ok(!JSON.stringify(result).includes("Private"));
  for (const bad of [
    { ...chat, model: "wrong/model" },
    { ...chat, usage: {} },
    {
      ...chat,
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: "" } },
      ],
    },
    {
      ...chat,
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "partial" },
        },
      ],
    },
  ])
    assert.equal(observe(bad, 200, input).level, "transport-only");
  const length = observe(
    {
      ...chat,
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "partial" },
        },
      ],
    },
    200,
    input,
  );
  assert.equal(length.outcome, "success"); // No verified proof, but no broken-method conclusion.
});

test("only explicit contract errors retire; invalid values, permission, quota and rate limits do not", () => {
  for (const code of [
    "unknown_parameter",
    "unsupported_parameter",
    "model_deprecated",
    "model_removed",
  ]) {
    const result = observe({ error: { code, message: secret } }, 400);
    assert.equal(result.outcome, "contract-change");
    assert.equal(result.validator, "openrouter-image");
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  for (const status of [400, 401, 402, 403, 404, 429, 503])
    assert.equal(
      observe({ error: { code: "invalid_parameter", message: secret } }, status)
        .outcome,
      "temporary-failure",
    );
  assert.equal(
    observe({ error: { code: "model_not_found" } }, 404).outcome,
    "temporary-failure",
  );
  assert.equal(
    observe({ error: { message: secret } }).outcome,
    "uncertain-failure",
  );
  assert.equal(
    observe({ status: "queued", id: "temporary-job" }).level,
    "transport-only",
  );
  assert.equal(
    observe({ status: "queued", id: "temporary-job" }).outcome,
    "success",
  );
});

test("proxy observation records proof once, never forwards capture metadata, and preserves response if ledger fails", async () => {
  const previousLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-experience-observe-"),
  );
  const store = new Store(dir, crypto.randomBytes(32).toString("hex"));
  let requests = 0;
  const upstream = http.createServer(async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.experience, undefined);
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as { port: number }).port;
  try {
    await store.init();
    await store.save(
      {
        ...platform(`http://127.0.0.1:${port}/api/v1`),
        allowInsecureLocal: true,
      },
      { value: secret },
      false,
      0,
    );
    const run = async (observeEnabled = true) => {
      const chunks: Buffer[] = [],
        headers = new Map<string, string>();
      const sink = Object.assign(
        new Writable({
          write(chunk: Buffer, _enc, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
        }),
        {
          statusCode: 200,
          setHeader(name: string, value: string | number | readonly string[]) {
            headers.set(name, String(value));
          },
        },
      );
      await execute(
        store,
        store.platform("OR"),
        call(),
        sink,
        new AbortController().signal,
        [],
        crypto.randomUUID(),
        undefined,
        undefined,
        { experience: observeEnabled, experienceFixture: true },
      );
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        data: [{ b64_json: png }],
      });
      return headers;
    };
    const headers = await run();
    const id = headers.get("x-abilock-experience-id");
    assert.ok(id);
    const record = await new ExperienceStore(dir, [secret]).getEvidence(
      store.platform("OR"),
      id,
    );
    assert.ok(JSON.stringify(record).includes("machine-verified"));
    assert.ok(!JSON.stringify(record).includes(png));
    const without = await run(false);
    assert.equal(without.get("x-abilock-experience-id"), undefined);
    await fs.writeFile(
      path.join(dir, "experience.json"),
      "BROKEN SYNTHETIC DATA",
      { mode: 0o600 },
    );
    await run(); // Recording fails, original successful result still completes.
    assert.equal(requests, 3);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
    if (previousLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = previousLocal;
  }
});
