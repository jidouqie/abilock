import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { redactBytes, Redactor } from "../src/security.js";

// Shared pure Buffer filtering; no protocol adapter or Git command is invoked.
async function streamed(bytes: Buffer, secrets: string[], width: number) {
  const chunks: Buffer[] = [];
  for (let position = 0; position < bytes.length; position += width)
    chunks.push(bytes.subarray(position, position + width));
  const output: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(new Redactor(secrets)))
    output.push(Buffer.from(chunk));
  return Buffer.concat(output);
}
async function assertStreamAgreement(
  bytes: Buffer,
  secrets: string[],
  expected: Buffer,
) {
  const original = Buffer.from(bytes);
  assert.deepEqual(redactBytes(bytes, secrets), expected);
  assert.deepEqual(
    bytes,
    original,
    "filtering must not mutate caller-owned bytes",
  );
  for (const width of [1, 2, 5, 13, bytes.length || 1])
    assert.deepEqual(await streamed(bytes, secrets, width), expected);
}
function mixed(text: string) {
  return text.replace(
    /%([0-9A-F])([0-9A-F])/g,
    (_escape, first: string, last: string) => `%${first.toLowerCase()}${last}`,
  );
}

test("synchronous binary redaction recognizes standard form and mixed-percent credentials without decoding other bytes", async () => {
  const secret = "Case/known credential+密碼:2026";
  const form = new URLSearchParams({ value: secret })
    .toString()
    .slice("value=".length);
  const body = `${mixed(form)}|${mixed(encodeURIComponent(secret))}`;
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 192]),
    Buffer.from(body),
    Buffer.from([128, 254, 1]),
  ]);
  const expected = Buffer.concat([
    Buffer.from([0, 255, 192]),
    Buffer.from("[REDACTED]|[REDACTED]"),
    Buffer.from([128, 254, 1]),
  ]);
  await assertStreamAgreement(bytes, [secret], expected);
});

test("synchronous and streaming filters agree on UTF8 secrets and overlapping shorter prefixes", async () => {
  await assertStreamAgreement(
    Buffer.from("合成😀秘密|abc|abcdef|ab"),
    ["合成😀秘密", "abc", "abcdef"],
    Buffer.from("[REDACTED]|[REDACTED]|[REDACTED]|ab"),
  );
});

test("binary nonmatches retain every non-UTF8 byte and do not change literal or credential character casing", async () => {
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 192, 175, 128]),
    Buffer.from("case%2fSecret|Case%2fsecret|Literal%2f"),
    Buffer.from([254]),
  ]);
  const secrets = ["Case/Secret", "Literal%2F"];
  assert.strictEqual(
    redactBytes(bytes, secrets),
    bytes,
    "the no-match path may reuse the original immutable view",
  );
  await assertStreamAgreement(bytes, secrets, Buffer.from(bytes));
});

test("synchronous binary matching replaces each complete longest secret once", async () => {
  const bytes = Buffer.from("complete-secret|complete|partial|complete-secret");
  await assertStreamAgreement(
    bytes,
    ["complete", "complete-secret", "partial-secret"],
    Buffer.from("[REDACTED]|[REDACTED]|partial|[REDACTED]"),
  );
  assert.deepEqual(redactBytes(Buffer.alloc(0), ["secret"]), Buffer.alloc(0));
});
