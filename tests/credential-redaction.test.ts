import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Connection, Credentials } from "../src/connections.js";
import { credentialSecretValues, redact, Redactor } from "../src/security.js";

// Pure synthetic echoes only: no socket, Docker, Git, credential file, or native command.
const username = "synthetic-identity-only-X",
  password = "synthetic-password-2026-only";
const secret = Object.freeze({ username, password });
const pair = `${username}:${password}`;
const bare = Buffer.from(pair).toString("base64");
const complete = `Basic ${bare}`;
const connection = (
  kind: Connection["kind"],
  config: Record<string, unknown>,
) => ({ kind, config });

test("Docker Basic redacts the bare username:password Base64 credential as well as individual fields and full header", () => {
  const values = credentialSecretValues(
    connection("docker", { auth: "basic" }),
    secret,
  );
  const oldValues = [...Object.values(secret), complete];
  assert.equal(
    redact(bare, oldValues),
    bare,
    "bare Basic value is an independent credential exposure",
  );
  for (const echo of [username, password, pair, bare, complete])
    assert.equal(redact(echo, values), "[REDACTED]");
  assert.equal(
    redact("ordinary business response", values),
    "ordinary business response",
  );
  assert.deepEqual(secret, { username, password });
});

test("the shared credential set covers configured Registry/Git Basic and Git token-as-password forms", () => {
  const entries: {
    connection: Pick<Connection, "kind" | "config">;
    secret: Credentials;
    password: string;
  }[] = [
    {
      connection: connection("registry", { authType: "basic" }),
      secret,
      password,
    },
    {
      connection: connection("git", { transport: "https", authType: "basic" }),
      secret,
      password,
    },
    { connection: connection("git", { transport: "https" }), secret, password },
    {
      connection: connection("git", { transport: "https", authType: "basic" }),
      secret: { username, token: "synthetic-personal-token-only" },
      password: "synthetic-personal-token-only",
    },
  ];
  for (const entry of entries) {
    const combined = `${username}:${entry.password}`,
      encoded = Buffer.from(combined).toString("base64");
    const values = credentialSecretValues(entry.connection, entry.secret);
    for (const echo of [
      combined,
      encoded,
      `Basic ${encoded}`,
      Buffer.from(`Basic ${encoded}`).toString("base64"),
      encodeURIComponent(encoded),
    ])
      assert.equal(redact(echo, values), "[REDACTED]");
  }
});

test("JSON, URL and nested base64 echoes of Basic combinations are removed without altering business values", () => {
  const unusual = {
    username: "synthetic-user",
    password: 'synthetic-密碼/with+quote"and:colon',
  };
  const combined = `${unusual.username}:${unusual.password}`,
    encoded = Buffer.from(combined).toString("base64");
  const values = credentialSecretValues(
    connection("docker", { auth: "basic" }),
    unusual,
  );
  const echo = JSON.stringify({
    plain: combined,
    encoded,
    full: `Basic ${encoded}`,
    url: encodeURIComponent(combined),
    doubleBase64: Buffer.from(encoded).toString("base64"),
    normal: { count: 23, value: "business-data" },
  });
  const result = JSON.parse(redact(echo, values)) as Record<string, unknown>;
  for (const field of ["plain", "encoded", "full", "url", "doubleBase64"])
    assert.equal(result[field], "[REDACTED]");
  assert.deepEqual(result.normal, { count: 23, value: "business-data" });
});

test("streaming binary credential echoes split across chunks are redacted using the same shared set", async () => {
  const values = credentialSecretValues(
    connection("docker", { auth: "basic" }),
    secret,
  );
  const raw = Buffer.concat([
    Buffer.from([0, 255]),
    Buffer.from(bare + "|" + complete + "|business"),
    Buffer.from([1, 254]),
  ]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < raw.length; i += 7) chunks.push(raw.subarray(i, i + 7));
  const output: Buffer[] = [];
  for await (const part of Readable.from(chunks).pipe(new Redactor(values)))
    output.push(Buffer.from(part));
  assert.deepEqual(
    Buffer.concat(output),
    Buffer.concat([
      Buffer.from([0, 255]),
      Buffer.from("[REDACTED]|[REDACTED]|business"),
      Buffer.from([1, 254]),
    ]),
  );
});

test("Bearer combinations cover kube defaults and explicit Registry/Git auth without creating Basic for other protocols", () => {
  const bearer = { token: "synthetic-bearer-value-2026" },
    full = `Bearer ${bearer.token}`;
  for (const config of [
    connection("kubernetes", {}),
    connection("registry", { authType: "bearer" }),
    connection("git", { transport: "https", authType: "bearer" }),
  ]) {
    const values = credentialSecretValues(config, bearer);
    assert.equal(redact(full, values), "[REDACTED]");
    assert.equal(
      redact(Buffer.from(full).toString("base64"), values),
      "[REDACTED]",
    );
  }
  for (const config of [
    connection("docker", { auth: "mtls" }),
    connection("postgres", {}),
    connection("git", { transport: "ssh" }),
  ]) {
    const values = credentialSecretValues(config, secret);
    assert.deepEqual(values, Object.values(secret));
  }
  assert.deepEqual(
    credentialSecretValues(connection("registry", { authType: "none" }), {}),
    [],
  );
});
