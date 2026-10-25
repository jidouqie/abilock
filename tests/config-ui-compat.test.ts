import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platformWriteSchema as priorPlatformWriteSchema } from "./fixtures/legacy-config-v2/schema.js";
import {
  platformWrite,
  type Platform,
} from "../web/components/platform-form.js";
import { platformSchema, platformWriteSchema } from "../src/schema.js";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import {
  configurationFormVersion,
  configurationRestartMessage,
  isConfigurationCompatible,
  requireConfigurationCompatible,
} from "../src/configuration-contract.js";

// Only public package code and temporary synthetic state. No real configuration,
// browser, real listener, upstream request, native Git or SSH command is involved.
// The server test owns a temporary management-only loopback listener.
const fixtureSecret = "synthetic-ui-compat-provider-key-49127";
function fixture(): Platform {
  return {
    alias: "DS",
    note: "项目 A",
    name: "Synthetic API",
    baseUrl: "https://api.example.test",
    auth: { type: "bearer" },
    rules: [{ method: "POST", path: "/chat/completions" }],
    description: "Saved synthetic usage",
    capabilityNotes: [],
    chat: {
      method: "POST",
      path: "/chat/completions",
      model: "synthetic-model",
    },
    enabled: true,
    allowInsecureLocal: false,
    hasSecret: true,
    revision: 1,
    updatedAt: "2026-10-12T00:00:00.000Z",
    learnedDocumentationUrl: "https://docs.example.test/old",
  };
}

test("API form accepts blank optional documentation and retains an existing credential", async () => {
  const original = fixture();
  const edit = { ...original, documentationUrl: "" };
  const body = platformWrite(edit, original);
  const input = platformWriteSchema.parse(body);
  assert.equal(input.platform.documentationUrl, null);
  assert.equal(input.secret, undefined);
  assert.equal(input.clearSecret, false);
  for (const key of [
    "hasSecret",
    "revision",
    "updatedAt",
    "learnedDocumentationUrl",
  ])
    assert.equal(Object.hasOwn(input.platform, key), false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-ui-save-"));
  const store = new Store(dir, "d".repeat(64));
  try {
    await store.init();
    await store.save(
      platformSchema.parse(body.platform),
      { value: fixtureSecret },
      false,
      0,
    );
    const previous = store.platform(original.alias).sealed;
    const saved = await store.save(
      input.platform,
      input.secret,
      !!input.clearSecret,
      input.expectedRevision,
      original.alias,
    );
    assert.equal(saved.revision, 2);
    assert.equal(saved.hasSecret, true);
    assert.equal(store.platform(original.alias).sealed, previous);
    assert.ok(!JSON.stringify(saved).includes(fixtureSecret));
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("API form preserves learned metadata when only alias and documentation change", () => {
  const original = fixture();
  const edit = {
    ...original,
    alias: "WRITING",
    documentationUrl: " https://docs.example.test/reference ",
  };
  const input = platformWriteSchema.parse(platformWrite(edit, original));
  assert.equal(input.platform.alias, "WRITING");
  assert.equal(
    input.platform.documentationUrl,
    "https://docs.example.test/reference",
  );
  assert.deepEqual(input.platform.rules, original.rules);
  assert.deepEqual(input.platform.chat, original.chat);
  assert.equal(input.platform.description, original.description);
  assert.equal(input.secret, undefined);
});

test("API form invalidates stale usage on target or authentication edits and requires replacement authentication", () => {
  const original = fixture();
  const changedTarget = platformWriteSchema.parse(
    platformWrite(
      { ...original, baseUrl: "https://other.example.test" },
      original,
    ),
  );
  assert.deepEqual(changedTarget.platform.rules, []);
  assert.deepEqual(changedTarget.platform.capabilityNotes, []);
  assert.equal(changedTarget.platform.chat, null);
  assert.equal(changedTarget.platform.description, "");
  const changedAuth = {
    ...original,
    auth: { type: "header", name: " x-provider-key " },
  };
  assert.throws(() => platformWrite(changedAuth, original), /请填写密钥/);
  const input = platformWriteSchema.parse(
    platformWrite(changedAuth, original, { secret: fixtureSecret }),
  );
  assert.deepEqual(input.platform.auth, {
    type: "header",
    name: "x-provider-key",
  });
  assert.deepEqual(input.platform.rules, []);
  assert.deepEqual(input.secret, { value: fixtureSecret });
});

test("API form emits correct new-connection and Basic credential payloads without read metadata", () => {
  const edit = {
    ...fixture(),
    hasSecret: false,
    alias: "BASIC",
    auth: { type: "basic" },
  };
  const pending = platformWriteSchema.parse(platformWrite(edit, null));
  assert.deepEqual(pending.platform.auth, { type: "basic" });
  assert.equal(pending.secret, undefined);
  assert.equal(pending.clearSecret, false);
  assert.throws(
    () => platformWrite(edit, null, { secret: fixtureSecret }),
    /请填写账号/,
  );
  const input = platformWriteSchema.parse(
    platformWrite(edit, null, {
      secret: fixtureSecret,
      username: "synthetic-user",
    }),
  );
  assert.equal(input.expectedRevision, 0);
  assert.deepEqual(input.secret, {
    username: "synthetic-user",
    password: fixtureSecret,
  });
  assert.equal(input.platform.name, "BASIC");
});

test("the prior public runtime rejects new note and documentation fields", () => {
  const body = platformWrite(fixture(), fixture());
  assert.equal(platformWriteSchema.safeParse(body).success, true);
  const parsed = priorPlatformWriteSchema.safeParse(body);
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error.issues.map((issue) => {
      assert.equal(issue.code, "unrecognized_keys");
      assert.ok("keys" in issue);
      return {
        code: issue.code,
        path: issue.path,
        keys: [...issue.keys].sort(),
      };
    }),
    [
      {
        code: "unrecognized_keys",
        path: ["platform"],
        keys: ["documentationUrl", "note"],
      },
    ],
  );
  // The fixture is the actual old contract: a compatible prior payload must
  // still be accepted, so the failure above cannot be a reject-everything stub.
  const {
    note: _note,
    documentationUrl: _url,
    ...legacyPlatform
  } = body.platform;
  void _note;
  void _url;
  assert.equal(
    priorPlatformWriteSchema.safeParse({ ...body, platform: legacyPlatform })
      .success,
    true,
  );
});

test("unknown, prior and future configuration form versions fail closed with a fixed restart message", () => {
  assert.equal(isConfigurationCompatible(configurationFormVersion), true);
  assert.doesNotThrow(() =>
    requireConfigurationCompatible(configurationFormVersion),
  );
  const untrusted = {
    toString() {
      throw new Error("must not stringify untrusted configuration version");
    },
  };
  for (const version of [
    undefined,
    null,
    0,
    -1,
    configurationFormVersion - 1,
    configurationFormVersion + 1,
    Number.NaN,
    String(configurationFormVersion),
    true,
    [],
    {},
    untrusted,
    fixtureSecret,
    "<script>untrusted-version</script>",
  ]) {
    assert.equal(isConfigurationCompatible(version), false);
    assert.throws(
      () => requireConfigurationCompatible(version),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, configurationRestartMessage);
        assert.ok(error.message.includes("Ctrl+C"));
        assert.ok(error.message.includes("abl config"));
        assert.ok(!error.message.includes(fixtureSecret));
        assert.ok(!error.message.includes("untrusted-version"));
        return true;
      },
    );
  }
});

test("authenticated configuration marker and the actual API form payload save successfully with existing credentials", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-ui-contract-http-"),
  );
  const store = new Store(dir, "e".repeat(64));
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    await store.init();
    const initial = platformWrite(fixture(), fixture()).platform;
    await store.save(
      platformSchema.parse(initial),
      { value: fixtureSecret },
      false,
      0,
    );
    const sealed = store.platform("DS").sealed;
    server = await startServers({
      store,
      execToken: "synthetic-ui-compat-execution-token-19418",
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      managementOnly: true,
      log: () => {},
    });
    const publicHeaders = {
      origin: server.adminUrl,
      "x-abilock-ui": "1",
      "content-type": "application/json",
    };
    const setup = await fetch(server.adminUrl + "/admin/auth/setup", {
      method: "POST",
      headers: publicHeaders,
      body: JSON.stringify({
        password: "synthetic-ui-compat-password-19418",
        confirmPassword: "synthetic-ui-compat-password-19418",
      }),
      redirect: "error",
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await setup.json()) as { csrfToken: string };
    const headers = { ...publicHeaders, cookie, "x-abilock-csrf": csrfToken };
    const response = await fetch(server.adminUrl + "/admin/platforms", {
      headers,
      redirect: "error",
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.ok(!raw.includes(fixtureSecret));
    assert.ok(!raw.includes('"sealed"'));
    const state = JSON.parse(raw) as {
      formVersion: unknown;
      platforms: Platform[];
    };
    assert.equal(state.formVersion, configurationFormVersion);
    requireConfigurationCompatible(state.formVersion);
    const original = state.platforms.find((item) => item.alias === "DS")!;
    const body = platformWrite({ ...original, documentationUrl: "" }, original);
    assert.equal(body.platform.documentationUrl, null);
    assert.equal(body.secret, undefined);
    const savedResponse = await fetch(server.adminUrl + "/admin/platforms/DS", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
    });
    assert.equal(savedResponse.status, 200);
    const savedText = await savedResponse.text();
    assert.ok(!savedText.includes(fixtureSecret));
    assert.ok(!savedText.includes('"sealed"'));
    assert.equal(JSON.parse(savedText).revision, 2);
    assert.equal(store.platform("DS").sealed, sealed);
    assert.equal(server.executor.listening, false);
  } finally {
    await server?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
