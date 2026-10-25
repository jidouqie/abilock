import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  parseExperienceArgs,
  readExperienceManifest,
  experienceRequest,
  captureExperienceResult,
  EXPERIENCE_INPUT_BYTES,
  EXPERIENCE_OUTPUT_BYTES,
} from "../bin/experience.mjs";

const id = "b194be13-7fca-4df1-bb21-6cb9b50d3fe7";

test("experience CLI parses selective reads and explicit lifecycle writes", () => {
  assert.deepEqual(
    parseExperienceArgs([
      "search",
      "--query",
      " 生图 ",
      "--alias",
      "openrouter",
      "--limit",
      "3",
      "--json",
    ]).payload,
    { query: "生图", alias: "openrouter", limit: 3 },
  );
  assert.deepEqual(
    parseExperienceArgs(["get", "openrouter", id, "--json"]).payload,
    { alias: "openrouter", id },
  );
  assert.deepEqual(
    parseExperienceArgs(["get", "openrouter", id, "--previous", "--json"])
      .payload,
    { alias: "openrouter", id, previous: true },
  );
  assert.deepEqual(
    parseExperienceArgs([
      "mark",
      "openrouter",
      id,
      "--status",
      "stale",
      "--reason",
      "contract-change",
      "--revision",
      "3",
    ]).payload,
    {
      alias: "openrouter",
      id,
      status: "stale",
      reason: "contract-change",
      expectedRevision: 3,
    },
  );
  assert.deepEqual(
    parseExperienceArgs(["remove", "openrouter", id, "--revision", "4"])
      .payload,
    { alias: "openrouter", id, expectedRevision: 4 },
  );
  assert.equal(
    parseExperienceArgs(["learn", "openrouter", "--stdin"]).stdin,
    true,
  );
  assert.equal(
    parseExperienceArgs(["learn", "openrouter", "--file", "method.json"]).file,
    "method.json",
  );
  assert.deepEqual(
    parseExperienceArgs(["status", "--offset", "10", "--limit", "20"]).payload,
    { offset: 10, limit: 20 },
  );
});

test("experience CLI rejects unbounded queries, limit bypasses, duplicate flags and unconfirmed status changes", () => {
  for (const args of [
    ["search", "--query", "image", "--limit", "6"],
    ["search", "--query", "image", "--limit", "1e2"],
    ["search", "--query", "image", "--limit", "0"],
    ["search", "--query", "image", "--query", "text"],
    ["search", "--query", "生".repeat(171)],
    ["search", "--query", "image", "--alias", "../../private"],
    ["get", "openrouter", "not-a-uuid"],
    ["get", "openrouter", id, "extra"],
    ["learn", "openrouter", "--file", "method.json", "--stdin"],
    ["learn", "openrouter"],
    [
      "mark",
      "openrouter",
      id,
      "--status",
      "verified",
      "--revision",
      "1",
      "--reason",
      "manual-review",
    ],
    [
      "mark",
      "openrouter",
      id,
      "--status",
      "stale",
      "--revision",
      "1",
      "--reason",
      "free-form-user-text",
    ],
    ["remove", "openrouter", id],
    ["remove", "openrouter", id, "--revision", "-1"],
    ["status", "--file", "method.json"],
    ["status", "--offset", "129"],
    ["status", "--limit", "21"],
    ["status", "--offset", "1e2"],
  ])
    assert.throws(() => parseExperienceArgs(args));
});

test("experience manifest input is byte bounded on stdin and on selected files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abl-experience-cli-"));
  try {
    const file = path.join(dir, "method.json");
    const body = {
      evidenceId: id,
      intent: "image-generation",
      sourceUrls: ["https://docs.example.com/images"],
    };
    await fs.writeFile(file, JSON.stringify(body));
    assert.deepEqual(await readExperienceManifest(file), body);
    assert.deepEqual(
      await readExperienceManifest(
        undefined,
        Readable.from([JSON.stringify(body)]),
      ),
      body,
    );
    await fs.writeFile(file, " ".repeat(EXPERIENCE_INPUT_BYTES + 1));
    await assert.rejects(readExperienceManifest(file));
    await assert.rejects(
      readExperienceManifest(
        undefined,
        Readable.from([Buffer.alloc(EXPERIENCE_INPUT_BYTES), Buffer.from("x")]),
      ),
    );
    await assert.rejects(
      readExperienceManifest(undefined, Readable.from(["[]"])),
    );
    const link = path.join(dir, "linked.json");
    await fs.symlink(file, link);
    await assert.rejects(readExperienceManifest(link));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("experience metadata uses a fixed local route and a bounded body without credentials", async () => {
  const seen: { url: string; options: RequestInit }[] = [];
  const result = await experienceRequest(
    "search",
    { query: "生图", limit: 3 },
    {
      fetcher: async (url: URL, options: RequestInit) => {
        seen.push({ url: String(url), options });
        return new Response(
          JSON.stringify({ methods: [], fallback: "documents" }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seen[0].url, "http://abilock.local/v2/experience/search");
  assert.equal(seen[0].options.redirect, "error");
  assert.equal(
    new Headers(seen[0].options.headers).has("authorization"),
    false,
  );
  assert.deepEqual(JSON.parse(String(seen[0].options.body)), {
    query: "生图",
    limit: 3,
  });
  let fetched = false;
  await assert.rejects(
    experienceRequest(
      "learn",
      { text: "x".repeat(EXPERIENCE_INPUT_BYTES) },
      {
        fetcher: async () => {
          fetched = true;
          return new Response("{}");
        },
      },
    ),
  );
  assert.equal(fetched, false);
});

test("experience read failures and oversized responses produce a safe document fallback", async () => {
  const secret = "synthetic-never-print-this-key";
  const result = await captureExperienceResult("openrouter", id, {
    fetcher: async () => {
      throw new Error(secret);
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.docsCommand, "abl doc openrouter --json");
  assert.ok(!JSON.stringify(result).includes(secret));
  const tooLarge = await captureExperienceResult("openrouter", id, {
    fetcher: async () =>
      new Response(
        JSON.stringify({ data: "x".repeat(EXPERIENCE_OUTPUT_BYTES) }),
      ),
  });
  assert.equal(tooLarge.status, "unavailable");
  const success = await captureExperienceResult("openrouter", id, {
    fetcher: async () =>
      new Response(JSON.stringify({ id, level: "machine-verified" })),
  });
  assert.equal(success.status, "available");
  assert.deepEqual(success.evidence, { id, level: "machine-verified" });
});

async function cli(args: string[], input?: string) {
  const child = spawn(
    process.execPath,
    [new URL("../bin/abl.mjs", import.meta.url).pathname, ...args],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        ABILOCK_ENDPOINT: "http://127.0.0.1:1",
        ABILOCK_EXEC_TOKEN: "synthetic-cli-capability",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(input);
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("public CLI rejects remote experience routes and capture before contacting an upstream", async () => {
  const status = await cli(["experience", "status", "--json"]);
  assert.equal(status.code, 3);
  assert.equal(JSON.parse(status.stdout).error.code, "LOCAL_EXPERIENCE");
  const capture = await cli(
    ["api", "openrouter", "--stdin", "--json", "--experience"],
    JSON.stringify({
      method: "POST",
      path: "/images",
      body: { model: "synthetic/model", prompt: "synthetic prompt" },
    }),
  );
  assert.equal(capture.code, 3);
  assert.equal(JSON.parse(capture.stdout).error.code, "LOCAL_EXPERIENCE");
  const fileCapture = await cli(
    ["api", "openrouter", "--stdin", "--json"],
    JSON.stringify({
      method: "POST",
      path: "/images",
      experience: { capture: true },
    }),
  );
  assert.equal(fileCapture.code, 3);
  assert.equal(JSON.parse(fileCapture.stdout).error.code, "LOCAL_EXPERIENCE");
});

test("public CLI requires JSON for capture and explicit capture for method reuse", async () => {
  const noJson = await cli(
    ["api", "openrouter", "--stdin", "--experience"],
    JSON.stringify({ method: "POST", path: "/images" }),
  );
  assert.equal(noJson.code, 2);
  assert.match(noJson.stderr, /--json/);
  const noCapture = await cli(
    ["api", "openrouter", "--stdin", "--json", "--method-id", id],
    "{}",
  );
  assert.equal(noCapture.code, 2);
  assert.equal(JSON.parse(noCapture.stdout).error.code, "USAGE");
});
