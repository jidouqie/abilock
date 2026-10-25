import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "../src/schema.js";
import {
  ExperienceStore,
  EXPERIENCE_LIMITS,
  type ExperienceEvidenceInput,
  type ExperiencePlatform,
} from "../src/experience-store.js";

const syntheticSecret = "synthetic-private-key-never-persist-123456";
const platform: ExperiencePlatform = {
  alias: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  auth: { type: "bearer" },
  rules: [{ method: "POST", path: "/images" }],
  enabled: true,
};
const sourceUrls = [
  "https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
];
const code = (wanted: string) => (cause: unknown) =>
  cause instanceof AppError &&
  cause.code === wanted &&
  !cause.message.includes(syntheticSecret);
function evidence(
  now: number,
  patch: Partial<ExperienceEvidenceInput> = {},
): ExperienceEvidenceInput {
  return {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    model: "synthetic/image-v1",
    method: "POST",
    path: "/images",
    parameters: [
      { path: "body.model", type: "string" },
      { path: "body.prompt", type: "string" },
    ],
    template: { body: { model: "{{model}}", prompt: "{{string}}" } },
    validator: "openrouter-image",
    level: "machine-verified",
    outcome: "success",
    observedAt: new Date(now).toISOString(),
    ...patch,
  };
}
async function fixture(
  work: (input: {
    store: ExperienceStore;
    dir: string;
    now: () => number;
    advance: (ms?: number) => void;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-experience-store-"),
  );
  let clock = Date.now();
  try {
    await work({
      dir,
      store: new ExperienceStore(dir, [syntheticSecret], { now: () => clock }),
      now: () => clock,
      advance: (ms = 1000) => {
        clock += ms;
      },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function learned(
  store: ExperienceStore,
  now: number,
  patch: Partial<ExperienceEvidenceInput> = {},
) {
  const receipt = await store.recordEvidence(platform, evidence(now, patch));
  return store.learn(platform, {
    evidenceId: receipt.id,
    intent: "image-generation",
    sourceUrls,
  });
}

test("first OpenRouter image method is evidence-bound, selectively retrievable and literal-free", async () => {
  await fixture(async ({ store, dir, now }) => {
    assert.equal(
      (await store.search([platform], { query: "生图" })).fallback,
      "documents",
    );
    const saved = await learned(store, now());
    assert.equal(saved.action, "created");
    const search = await store.search([platform], { query: "图片" });
    assert.equal(search.methods.length, 1);
    const detail = await store.get(platform, saved.method.id);
    assert.equal(detail.usable, true);
    assert.equal(detail.variants.length, 1);
    assert.deepEqual(detail.variants[0].template, {
      body: { model: "{{model}}", prompt: "{{string}}" },
    });
    const raw = await fs.readFile(path.join(dir, "experience.json"), "utf8");
    assert.ok(!raw.includes(syntheticSecret));
    assert.ok(!raw.includes("b64_json"));
    assert.ok(
      Buffer.byteLength(JSON.stringify(search)) <=
        EXPERIENCE_LIMITS.searchBytes,
    );
  });
});

test("repeated values reuse one method; exact new shapes stay separate without overclaiming combinations", async () => {
  await fixture(async ({ store, now, advance }) => {
    const first = await learned(store, now());
    advance();
    const repeated = await learned(store, now());
    assert.equal(repeated.method.id, first.method.id);
    assert.equal(repeated.method.variants.length, 1);
    for (const field of ["quality", "resolution", "aspect_ratio"]) {
      advance();
      const original = evidence(now());
      const updated = await learned(store, now(), {
        parameters: [
          ...original.parameters,
          { path: `body.${field}`, type: "string" },
        ],
        template: {
          body: {
            model: "{{model}}",
            prompt: "{{string}}",
            [field]: "{{string}}",
          },
        },
      });
      assert.equal(updated.method.id, first.method.id);
    }
    advance();
    const original = evidence(now());
    const receipt = await store.recordEvidence(
      platform,
      evidence(now(), {
        parameters: [
          ...original.parameters,
          { path: "body.seed", type: "number" },
        ],
        template: {
          body: {
            model: "{{model}}",
            prompt: "{{string}}",
            seed: "{{number}}",
          },
        },
      }),
    );
    await assert.rejects(
      store.learn(platform, {
        evidenceId: receipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_CAPACITY"),
    );
    const current = await store.get(platform, first.method.id);
    assert.equal(current.variants.length, 4);
    assert.equal((await store.inspect([platform])).methods, 1);
  });
});

test("no arbitrary self-reported success, changed target, raw prompts or token URLs enter knowledge", async () => {
  await fixture(async ({ store, now }) => {
    await assert.rejects(
      store.learn(platform, {
        evidenceId: crypto.randomUUID(),
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_NOT_FOUND"),
    );
    const receipt = await store.recordEvidence(platform, evidence(now()));
    for (const source of [
      "https://docs.example/api?token=unknown",
      "https://user:password@docs.example/api",
      "https://docs.example/%61pi%5Fkey/value",
      "https://docs.example/token/value",
      `https://docs.example/${syntheticSecret}`,
    ]) {
      await assert.rejects(
        store.learn(platform, {
          evidenceId: receipt.id,
          intent: "image-generation",
          sourceUrls: [source],
        }),
        code("EXPERIENCE_VALIDATION"),
      );
    }
    await assert.rejects(
      store.learn(platform, {
        evidenceId: receipt.id,
        intent: "image-generation",
        sourceUrls,
        success: true,
      } as never),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.learn(
        { ...platform, baseUrl: "https://other.example/api" },
        { evidenceId: receipt.id, intent: "image-generation", sourceUrls },
      ),
      code("EXPERIENCE_NOT_FOUND"),
    );
    await assert.rejects(
      store.recordEvidence(
        platform,
        evidence(now(), {
          template: { body: { prompt: "the private user prompt" } },
        }),
      ),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.recordEvidence(
        platform,
        evidence(now(), { model: syntheticSecret }),
      ),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.recordEvidence(
        platform,
        evidence(now(), {
          template: { body: { authorization: "{{string}}" } },
        }),
      ),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.recordEvidence(platform, evidence(now(), { path: "/unapproved" })),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.recordEvidence(
        platform,
        evidence(now(), { template: { body: { prompt: "x".repeat(17000) } } }),
      ),
      code("EXPERIENCE_TOO_LARGE"),
    );
  });
});

test("transport receipt cannot assert verified business success or richer intent", async () => {
  await fixture(async ({ store, now }) => {
    const receipt = await store.recordEvidence(
      platform,
      evidence(now(), {
        level: "transport-only",
        validator: "none",
        reason: "unsupported-provider",
      }),
    );
    await assert.rejects(
      store.learn(platform, {
        evidenceId: receipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_REVIEW_REQUIRED"),
    );
    const reviewed = await store.learn(platform, {
      evidenceId: receipt.id,
      intent: "image-generation",
      sourceUrls,
      review: "assistant-reviewed",
    });
    assert.equal((await store.get(platform, reviewed.method.id)).usable, false);
    assert.equal((await store.search([platform], {})).methods.length, 0);
    const verified = await store.recordEvidence(platform, evidence(now()));
    await assert.rejects(
      store.learn(platform, {
        evidenceId: verified.id,
        intent: "image-editing",
        sourceUrls,
      }),
      code("EXPERIENCE_VALIDATION"),
    );
  });
});

test("temporary failure preserves method; bound contract/uncertain failure retires it without exposing error text", async () => {
  await fixture(async ({ store, now, advance }) => {
    const initial = await learned(store, now());
    advance();
    await store.recordEvidence(
      platform,
      evidence(now(), {
        methodId: initial.method.id,
        level: "transport-only",
        validator: "none",
        outcome: "temporary-failure",
      }),
    );
    assert.equal((await store.search([platform], {})).methods.length, 1);
    advance();
    await store.recordEvidence(
      platform,
      evidence(now(), {
        methodId: initial.method.id,
        model: "synthetic/other",
        level: "transport-only",
        validator: "none",
        outcome: "contract-change",
      }),
    );
    assert.equal((await store.search([platform], {})).methods.length, 1);
    advance();
    await store.recordEvidence(
      platform,
      evidence(now(), {
        methodId: initial.method.id,
        level: "transport-only",
        validator: "none",
        outcome: "uncertain-failure",
      }),
    );
    assert.equal((await store.search([platform], {})).methods.length, 0);
    assert.equal(
      (await store.get(platform, initial.method.id)).reason,
      "manual-review",
    );
  });
});

test("retirement rejects old receipt replay; verified replacement excludes old variants and keeps bounded recovery", async () => {
  await fixture(async ({ store, dir, now, advance }) => {
    const oldReceipt = await store.recordEvidence(platform, evidence(now()));
    const initial = await store.learn(platform, {
      evidenceId: oldReceipt.id,
      intent: "image-generation",
      sourceUrls,
    });
    advance();
    await store.recordEvidence(
      platform,
      evidence(now(), {
        methodId: initial.method.id,
        level: "transport-only",
        validator: "none",
        outcome: "contract-change",
      }),
    );
    await assert.rejects(
      store.learn(platform, {
        evidenceId: oldReceipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_FRESH_EVIDENCE_REQUIRED"),
    );
    advance();
    const changed = evidence(now());
    const replacement = await learned(store, now(), {
      parameters: [
        ...changed.parameters,
        { path: "body.quality", type: "string" },
      ],
      template: {
        body: {
          model: "{{model}}",
          prompt: "{{string}}",
          quality: "{{string}}",
        },
      },
    });
    const detail = await store.get(platform, replacement.method.id);
    assert.equal(detail.hasPrevious, true);
    assert.equal(detail.variants.length, 1);
    assert.ok(!("previous" in detail));
    const disk = JSON.parse(
      await fs.readFile(path.join(dir, "experience.json"), "utf8"),
    );
    assert.equal(disk.methods[0].previous.status, "archived");
    assert.equal(disk.methods[0].previous.variants[0].parameters.length, 2);
    const beforePrevious = await fs.readFile(path.join(dir, "experience.json"));
    const older = await store.get(platform, replacement.method.id, {
      previous: true,
    });
    assert.equal(older.status, "archived");
    assert.equal(older.usable, false);
    assert.equal(older.isPrevious, true);
    assert.equal(older.variants[0].parameters.length, 2);
    assert.deepEqual(
      await fs.readFile(path.join(dir, "experience.json")),
      beforePrevious,
    );
    advance();
    const removed = await store.remove(platform, {
      id: detail.id,
      expectedRevision: detail.revision,
    });
    assert.equal(removed.recoverable, true);
    assert.equal((await store.search([platform], {})).methods.length, 0);
    advance();
    const currentReceipt = await store.recordEvidence(
      platform,
      evidence(now()),
    );
    await assert.rejects(
      store.learn(platform, {
        evidenceId: currentReceipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_CAPACITY"),
    );
  });
});

test("read-only expiry/context changes and bounded retrieval do not mutate the file", async () => {
  await fixture(async ({ store, dir, now, advance }) => {
    const learnedMethod = await learned(store, now());
    const before = await fs.readFile(path.join(dir, "experience.json"));
    assert.equal(
      (
        await store.search(
          [
            {
              ...platform,
              rules: [...platform.rules, { method: "GET", path: "/models" }],
            },
          ],
          {},
        )
      ).methods.length,
      1,
    );
    const changed = {
      ...platform,
      rules: [{ method: "GET" as const, path: "/models" }],
    };
    assert.equal(
      (await store.get(changed, learnedMethod.method.id)).status,
      "stale",
    );
    assert.equal((await store.search([changed], {})).methods.length, 0);
    await assert.rejects(
      store.search([platform], { limit: 6 }),
      code("EXPERIENCE_VALIDATION"),
    );
    await assert.rejects(
      store.search([platform], { budgetBytes: 9000 }),
      code("EXPERIENCE_VALIDATION"),
    );
    const small = await store.search([platform], { budgetBytes: 512 });
    assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 512);
    assert.equal(small.fallback, "documents");
    advance(EXPERIENCE_LIMITS.methodTtlMs + 1);
    assert.equal(
      (await store.get(platform, learnedMethod.method.id)).status,
      "expired",
    );
    assert.equal((await store.search([platform], {})).methods.length, 0);
    assert.deepEqual(
      await fs.readFile(path.join(dir, "experience.json")),
      before,
    );
  });
});

test("capacity full stops new methods without eviction; status and retention remain bounded", async () => {
  await fixture(async ({ store, dir, now }) => {
    await learned(store, now());
    const file = path.join(dir, "experience.json");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.methods = Array.from(
      { length: EXPERIENCE_LIMITS.methods },
      (_, index) => ({
        ...state.methods[0],
        id: crypto.randomUUID(),
        model: `synthetic/model-${index}`,
      }),
    );
    await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
    const receipt = await store.recordEvidence(
      platform,
      evidence(now(), { model: "synthetic/new" }),
    );
    const before = await fs.readFile(file);
    await assert.rejects(
      store.learn(platform, {
        evidenceId: receipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_CAPACITY"),
    );
    assert.deepEqual(await fs.readFile(file), before);
    const status = await store.inspect([platform]);
    assert.equal(status.methods, 128);
    assert.equal(status.items.length, 10);
    assert.equal(status.nextOffset, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 8192);
    assert.equal(
      (await store.search([platform], { limit: 5 })).methods.length,
      5,
    );
  });
});

test("concurrent writers reread under the kernel lock and preserve unrelated methods", async () => {
  await fixture(async ({ dir, now }) => {
    const receipts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new ExperienceStore(dir, [syntheticSecret]).recordEvidence(
          platform,
          evidence(now(), { model: `synthetic/concurrent-${index}` }),
        ),
      ),
    );
    await Promise.all(
      receipts.map((receipt) =>
        new ExperienceStore(dir, [syntheticSecret]).learn(platform, {
          evidenceId: receipt.id,
          intent: "image-generation",
          sourceUrls,
        }),
      ),
    );
    const status = await new ExperienceStore(dir, [syntheticSecret]).inspect([
      platform,
    ]);
    assert.equal(status.methods, 8);
    assert.equal(status.evidence, 8);
    assert.equal(status.revision, 16);
  });
});

test("ephemeral evidence is bounded; corrupt knowledge refuses writes and preserves main data", async () => {
  await fixture(async ({ store, dir, now, advance }) => {
    const first = await store.recordEvidence(platform, evidence(now()));
    for (let i = 0; i < 34; i++) {
      advance();
      await store.recordEvidence(platform, evidence(now()));
    }
    assert.equal((await store.inspect([platform])).evidence, 32);
    await assert.rejects(
      store.getEvidence(platform, first.id),
      code("EXPERIENCE_NOT_FOUND"),
    );
    await fs.writeFile(
      path.join(dir, "state.json"),
      "synthetic-main-state-untouched",
      { mode: 0o600 },
    );
    const corrupt = `broken knowledge ${syntheticSecret}`;
    await fs.writeFile(path.join(dir, "experience.json"), corrupt, {
      mode: 0o600,
    });
    await assert.rejects(
      store.search([platform], {}),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    await assert.rejects(
      store.recordEvidence(platform, evidence(now())),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.equal(
      await fs.readFile(path.join(dir, "experience.json"), "utf8"),
      corrupt,
    );
    assert.equal(
      await fs.readFile(path.join(dir, "state.json"), "utf8"),
      "synthetic-main-state-untouched",
    );
  });
});

test("same-millisecond fresh evidence is ordered by ledger revision; removal cannot reuse an old receipt", async () => {
  await fixture(async ({ store, now }) => {
    const receipt = await store.recordEvidence(platform, evidence(now()));
    const first = await store.learn(platform, {
      evidenceId: receipt.id,
      intent: "image-generation",
      sourceUrls,
    });
    await store.remove(platform, {
      id: first.method.id,
      expectedRevision: first.method.revision,
    });
    await assert.rejects(
      store.learn(platform, {
        evidenceId: receipt.id,
        intent: "image-generation",
        sourceUrls,
      }),
      code("EXPERIENCE_FRESH_EVIDENCE_REQUIRED"),
    );
    const fresh = await store.recordEvidence(platform, evidence(now()));
    const renewed = await store.learn(platform, {
      evidenceId: fresh.id,
      intent: "image-generation",
      sourceUrls,
    });
    assert.equal(renewed.method.status, "active");
    assert.ok(renewed.method.previous);
    await assert.rejects(
      store.remove(platform, {
        id: renewed.method.id,
        expectedRevision: first.method.revision,
      }),
      code("REVISION_CONFLICT"),
    );
  });
});

test("single record, nesting and parameter caps reject oversized metadata before commit", async () => {
  await fixture(async ({ store, now }) => {
    const fields = Array.from(
      { length: 64 },
      (_, i) => `field_${i}_${"x".repeat(50)}`,
    );
    const oversized = evidence(now(), {
      parameters: fields.map((field) => ({
        path: `body.${field}`,
        type: "string",
      })),
      template: {
        body: Object.fromEntries(fields.map((field) => [field, "{{string}}"])),
      },
    });
    await assert.rejects(
      store.recordEvidence(platform, oversized),
      code("EXPERIENCE_TOO_LARGE"),
    );
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    cursor.value = "{{string}}";
    await assert.rejects(
      store.recordEvidence(platform, evidence(now(), { template: deep })),
      code("EXPERIENCE_VALIDATION"),
    );
    assert.equal((await store.inspect([platform])).evidence, 0);
  });
});

test("symlink and over-limit experience files are refused without following or resetting them", async () => {
  await fixture(async ({ store, dir }) => {
    const target = path.join(dir, "synthetic-other.txt");
    await fs.writeFile(target, "unchanged", { mode: 0o600 });
    const file = path.join(dir, "experience.json");
    await fs.symlink(target, file);
    await assert.rejects(
      store.inspect([platform]),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.equal(await fs.readFile(target, "utf8"), "unchanged");
    await fs.unlink(file);
    await fs.writeFile(
      file,
      "x".repeat(
        EXPERIENCE_LIMITS.methodBytes + EXPERIENCE_LIMITS.evidenceBytes + 5000,
      ),
      { mode: 0o600 },
    );
    await assert.rejects(
      store.inspect([platform]),
      code("EXPERIENCE_UNAVAILABLE"),
    );
    assert.ok((await fs.stat(file)).size > EXPERIENCE_LIMITS.methodBytes);
  });
});
