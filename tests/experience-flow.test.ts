import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import { Store } from "../src/store.js";
import { platformSchema } from "../src/schema.js";
import { LocalResponse, executeLocalRequest } from "../src/local-execution.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=";
const secret = "synthetic-experience-flow-secret-7352";
const prompt = "PRIVATE USER PROMPT MUST NEVER BE SAVED 934782";

async function request(store: Store, route: string, payload: unknown) {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const response = new LocalResponse(output, () => {});
  const outcome = await executeLocalRequest(
    store,
    {
      type: "request",
      method: "POST",
      url: route,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    response,
    {
      signal: new AbortController().signal,
      programRoot: process.cwd(),
      allowLocalFixture: true,
    },
  );
  const body = Buffer.concat(chunks).toString();
  return {
    outcome,
    status: response.statusCode,
    response,
    body,
    json: JSON.parse(body),
  };
}

test("local OpenRouter-shaped image flow learns only executor evidence and reuses bounded methods", async () => {
  const oldMock = process.env.ABILOCK_MOCK,
    oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-experience-flow-"));
  const store = new Store(dir, crypto.randomBytes(32).toString("hex"));
  let calls = 0,
    status = 200;
  let data: unknown = { data: [{ b64_json: png, media_type: "image/png" }] };
  const server = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    for await (const chunk of req) void chunk;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await store.init();
    await store.save(
      platformSchema.parse({
        alias: "OR",
        name: "Synthetic OpenRouter",
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
        auth: { type: "bearer" },
        allowInsecureLocal: true,
        rules: [{ method: "POST", path: "/images" }],
      }),
      { value: secret },
      false,
      0,
    );
    const authority = await fs.readFile(path.join(dir, "state.json"));
    const call = {
      method: "POST",
      path: "/images",
      body: { model: "synthetic/image-model", prompt, n: 1 },
      experience: { capture: true },
    };
    const first = await request(store, "/v1/call/OR", call);
    assert.equal(first.status, 200, first.body);
    assert.deepEqual(first.json, data);
    const id = first.response.getHeader("x-abilock-experience-id");
    assert.equal(typeof id, "string");
    const evidence = await request(store, "/v2/experience/evidence", {
      alias: "OR",
      id,
    });
    assert.equal(evidence.status, 200, evidence.body);
    assert.equal(evidence.json.data.level, "machine-verified");
    const learned = await request(store, "/v2/experience/learn", {
      alias: "OR",
      manifest: {
        evidenceId: id,
        intent: "image-generation",
        sourceUrls: [
          "https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
        ],
        constraints: ["billable", "no-auto-retry"],
      },
    });
    assert.equal(learned.status, 200, learned.body);
    const methodId = learned.json.data.method.id;
    const found = await request(store, "/v2/experience/search", {
      alias: "OR",
      query: "生图",
      limit: 3,
    });
    assert.equal(found.status, 200, found.body);
    assert.equal(found.json.data.methods.length, 1);
    assert.equal(found.json.data.methods[0].id, methodId);
    assert.ok(Buffer.byteLength(found.body) <= 8192);
    const detail = await request(store, "/v2/experience/get", {
      alias: "OR",
      id: methodId,
    });
    assert.equal(detail.json.data.usable, true);
    assert.ok(detail.body.includes("{{string}}"));
    assert.equal(calls, 1, "knowledge lookup must never call provider");
    const spoofed = await request(store, "/v2/experience/learn", {
      alias: "OR",
      manifest: {
        evidenceId: crypto.randomUUID(),
        intent: "image-generation",
        sourceUrls: ["https://openrouter.ai/docs"],
        level: "machine-verified",
      },
    });
    assert.notEqual(spoofed.status, 200);
    // Prompt and numeric value changes are not new knowledge.
    const second = await request(store, "/v1/call/OR", {
      ...call,
      body: { ...call.body, prompt: "ANOTHER PRIVATE PROMPT", n: 2 },
    });
    const again = await request(store, "/v2/experience/learn", {
      alias: "OR",
      manifest: {
        evidenceId: second.response.getHeader("x-abilock-experience-id"),
        intent: "image-generation",
        sourceUrls: ["https://openrouter.ai/docs"],
      },
    });
    assert.equal(again.json.data.method.id, methodId);
    assert.equal(again.json.data.method.variants.length, 1);
    // A quota failure is not evidence that the method is wrong.
    status = 429;
    data = { error: { code: "rate_limit_exceeded", message: secret } };
    await request(store, "/v1/call/OR", {
      ...call,
      experience: { capture: true, methodId },
    });
    const afterTemporary = await request(store, "/v2/experience/search", {
      alias: "OR",
      query: "生图",
    });
    assert.equal(afterTemporary.json.data.methods.length, 1);
    status = 404;
    data = { error: { code: "model_removed", message: "model retired" } };
    await request(store, "/v1/call/OR", {
      ...call,
      experience: { capture: true, methodId },
    });
    const retired = await request(store, "/v2/experience/search", {
      alias: "OR",
      query: "生图",
    });
    assert.equal(retired.json.data.methods.length, 0);
    const ledger = await fs.readFile(path.join(dir, "experience.json"), "utf8");
    for (const value of [
      secret,
      prompt,
      "ANOTHER PRIVATE PROMPT",
      png,
      "model retired",
    ])
      assert.ok(
        !ledger.includes(value),
        "business values cannot enter knowledge store",
      );
    assert.deepEqual(
      await fs.readFile(path.join(dir, "state.json")),
      authority,
    );
    // Corrupt optional knowledge never damages the normal business result.
    await fs.writeFile(path.join(dir, "experience.json"), "not valid json", {
      mode: 0o600,
    });
    status = 200;
    data = { data: [{ b64_json: png }] };
    const successful = await request(store, "/v1/call/OR", call);
    assert.equal(successful.status, 200);
    assert.deepEqual(successful.json, data);
    const fallback = await request(store, "/v2/experience/search", {
      alias: "OR",
      query: "生图",
    });
    assert.equal(fallback.json.error.code, "EXPERIENCE_UNAVAILABLE");
    assert.equal(fallback.json.fallback, "abl doc OR --json");
    assert.equal(
      await fs.readFile(path.join(dir, "experience.json"), "utf8"),
      "not valid json",
    );
    const huge = await request(store, "/v2/experience/search", {
      query: "x".repeat(17000),
    });
    assert.equal(huge.status, 413);
    const invalidLimit = await request(store, "/v2/experience/search", {
      query: "生图",
      limit: 999,
    });
    assert.notEqual(invalidLimit.status, 200);
  } finally {
    await store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
    if (oldMock === undefined) delete process.env.ABILOCK_MOCK;
    else process.env.ABILOCK_MOCK = oldMock;
    if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
    else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
  }
});
