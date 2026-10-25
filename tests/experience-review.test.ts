import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, platformSchema, requestSchema } from "../src/schema.js";
import {
  ExperienceStore,
  type ExperienceEvidenceInput,
} from "../src/experience-store.js";
import { createExperienceObserver } from "../src/experience-evidence.js";

const platform = {
  ...platformSchema.parse({
    alias: "ROUTER",
    name: "Synthetic review fixture",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "bearer" },
    rules: [
      { method: "POST", path: "/images" },
      { method: "POST", path: "/chat/completions" },
    ],
  }),
  revision: 1,
  updatedAt: new Date().toISOString(),
};
const syntheticSecret = "synthetic-review-credential-never-leave-local";
function evidence(
  extra: Partial<ExperienceEvidenceInput> = {},
): ExperienceEvidenceInput {
  return {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    model: "synthetic/image-v1",
    method: "POST",
    path: "/images",
    parameters: [
      { path: "body", type: "object" },
      { path: "body.model", type: "string" },
      { path: "body.prompt", type: "string" },
    ],
    template: { body: { model: "{{model}}", prompt: "{{string}}" } },
    validator: "openrouter-image",
    level: "machine-verified",
    outcome: "success",
    observedAt: new Date().toISOString(),
    ...extra,
  };
}
const manifest = (id: string) => ({
  evidenceId: id,
  intent: "image-generation" as const,
  sourceUrls: [
    "https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
  ],
});
function code(expected: string) {
  return (error: unknown) =>
    error instanceof AppError && error.code === expected;
}
async function fixture(
  work: (store: ExperienceStore, dir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-experience-review-"),
  );
  try {
    await work(new ExperienceStore(dir, [syntheticSecret]), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("experience review: raw user text in arbitrary object keys is never captured", () => {
  for (const body of [
    {
      model: "synthetic/image-v1",
      prompt: "ordinary",
      PrivatePromptWords123: "hidden",
    },
    {
      model: "synthetic/image-v1",
      prompt: "ordinary",
      metadata: { PrivateUserResult123: "hidden" },
    },
    {
      model: "synthetic/chat-v1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "ordinary", PrivatePromptWords123: "hidden" },
          ],
        },
      ],
    },
  ]) {
    const call = requestSchema.parse({
      method: "POST",
      path: "messages" in body ? "/chat/completions" : "/images",
      body,
    });
    assert.equal(
      createExperienceObserver(platform, call, crypto.randomUUID(), []),
      undefined,
    );
  }
});

test("experience review: neither encoded token URLs nor credential query strings are accepted as sources", async () => {
  await fixture(async (store) => {
    const proof = evidence();
    await store.recordEvidence(platform, proof);
    for (const url of [
      "https://docs.example.com/page?token=private-value",
      "https://docs.example.com/%61pi%5Fkey/private-value",
      "https://docs.example.com/docs%3Ftoken%3Dprivate-value",
      "https://docs.example.com/%2574oken/private-value",
      "https://user:private-value@docs.example.com/page",
    ]) {
      await assert.rejects(
        store.learn(platform, { ...manifest(proof.id), sourceUrls: [url] }),
      );
    }
    assert.equal((await store.inspect([platform])).methods, 0);
  });
});

test("experience review: user-supplied success fields and unknown evidence identifiers cannot mint verified methods", async () => {
  await fixture(async (store) => {
    const forged = {
      ...manifest(crypto.randomUUID()),
      verified: true,
      level: "machine-verified",
    };
    await assert.rejects(
      store.learn(platform, forged),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.learn(platform, manifest(crypto.randomUUID())),
      code("EXPERIENCE_NOT_FOUND"),
    );
    assert.equal((await store.inspect([platform])).methods, 0);
  });
});

test("experience review: retrieval and write limits reject caller inflation", async () => {
  await fixture(async (store) => {
    await assert.rejects(
      store.search([platform], { query: "x", limit: 6 }),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.search([platform], { query: "x", budgetBytes: 8193 }),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.search([platform], { query: "x".repeat(301) }),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.learn(platform, {
        ...manifest(crypto.randomUUID()),
        version: "x".repeat(17000),
      }),
      code("EXPERIENCE_TOO_LARGE"),
    );
    assert.equal((await store.inspect([platform])).methods, 0);
  });
});

test("experience review: synthetic secret rotation and unsafe ledger links fail closed without rewriting", async () => {
  await fixture(async (store, dir) => {
    const proof = evidence();
    await store.recordEvidence(platform, proof);
    await store.learn(platform, manifest(proof.id));
    const file = path.join(dir, "experience.json");
    const before = await fs.readFile(file);
    const rotated = new ExperienceStore(dir, [
      syntheticSecret,
      "synthetic/image-v1",
    ]);
    await assert.rejects(
      rotated.search([platform], { query: "生图" }),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.deepEqual(await fs.readFile(file), before);
    const backing = path.join(dir, "retained.json");
    await fs.rename(file, backing);
    await fs.symlink(backing, file);
    await assert.rejects(
      store.inspect([platform]),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.deepEqual(await fs.readFile(backing), before);
    await fs.unlink(file);
    await fs.link(backing, file);
    await assert.rejects(
      store.inspect([platform]),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.deepEqual(await fs.readFile(backing), before);
  });
});

test("experience review: an old success receipt cannot revive a subsequently removed method", async () => {
  await fixture(async (store) => {
    const old = evidence();
    await store.recordEvidence(platform, old);
    const learned = await store.learn(platform, manifest(old.id));
    await store.remove(platform, {
      id: learned.method.id,
      expectedRevision: learned.method.revision,
    });
    await assert.rejects(store.learn(platform, manifest(old.id)));
    assert.equal(
      (await store.search([platform], { query: "生图" })).methods.length,
      0,
    );
    const fresh = evidence();
    await store.recordEvidence(platform, fresh);
    await store.learn(platform, manifest(fresh.id));
    assert.equal(
      (await store.search([platform], { query: "生图" })).methods.length,
      1,
    );
  });
});

test("experience review: contract failure hides only matching method and requires post-failure evidence", async () => {
  await fixture(async (store) => {
    const old = evidence();
    await store.recordEvidence(platform, old);
    const learned = await store.learn(platform, manifest(old.id));
    await store.recordEvidence(
      platform,
      evidence({
        methodId: learned.method.id,
        validator: "none",
        level: "transport-only",
        outcome: "contract-change",
      }),
    );
    assert.equal(
      (await store.search([platform], { query: "生图" })).methods.length,
      0,
    );
    await assert.rejects(store.learn(platform, manifest(old.id)));
    const recovered = evidence();
    await store.recordEvidence(platform, recovered);
    const replacement = await store.learn(platform, manifest(recovered.id));
    const detail = await store.get(platform, replacement.method.id);
    assert.equal(detail.usable, true);
    assert.equal(
      (await store.search([platform], { query: "生图" })).methods.length,
      1,
    );
  });
});
