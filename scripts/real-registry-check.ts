import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registryAdapter } from "../src/protocols/registry.js";
import type { AdapterContext, Operation } from "../src/connections.js";
import { AppError } from "../src/schema.js";

const reportPath = path.resolve("artifacts/real-registry-validation.json");
const checks: { name: string; ok: boolean; evidence?: unknown }[] = [];
const startedAt = new Date().toISOString();
function digest(bytes: Buffer) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
async function record(name: string, run: () => Promise<unknown>) {
  const evidence = await run();
  checks.push({
    name,
    ok: true,
    ...(evidence === undefined ? {} : { evidence }),
  });
}
async function report(ok: boolean, extra: object = {}) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        ok,
        startedAt,
        completedAt: new Date().toISOString(),
        integration:
          "actual local Docker Registry v2 with htpasswd Basic authentication",
        checks,
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}
try {
  const ownedConfig = process.env.ABILOCK_TEST_ENV;
  if (!ownedConfig) throw new Error("ABILOCK_TEST_ENV_REQUIRED");
  const stat = await fs.stat(ownedConfig);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("OWNED_CONFIG_REQUIRED");
  const { registry } = z
    .object({
      registry: z.object({
        endpoint: z.string(),
        username: z.string().min(1),
        password: z.string().min(1),
        repository: z.string().default("abilock/test"),
      }),
    })
    .passthrough()
    .parse(JSON.parse(await fs.readFile(ownedConfig, "utf8")));
  const url = new URL(registry.endpoint);
  if (
    url.hostname !== "127.0.0.1" ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("LOCAL_REGISTRY_ONLY");
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const secret = { username: registry.username, password: registry.password };
  const ctx: AdapterContext = {
    connection: {
      alias: "REGISTRY_REAL_TEST",
      name: "Owned temporary Registry v2",
      kind: "registry",
      enabled: true,
      description: "Synthetic integration only",
      trustBoundary: "development-fixture",
      config: {
        endpoint: registry.endpoint,
        authType: "basic",
        allowedRepositories: [registry.repository],
        allowInsecureLocal: true,
      },
    },
    secret,
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: "/tmp",
  };
  registryAdapter.validate(ctx.connection, secret);
  const call = (args: string[], extra: Partial<Operation> = {}) =>
    registryAdapter.run(
      { ...ctx, signal: AbortSignal.timeout(10000) },
      { args, timeoutMs: 10000, ...extra },
    );
  const repo = registry.repository;
  const tag = `verification-${crypto.randomUUID()}`;
  const config = Buffer.from(
    JSON.stringify({
      created: new Date().toISOString(),
      architecture: "amd64",
      os: "linux",
      config: {},
      rootfs: { type: "layers", diff_ids: [] },
      history: [],
    }),
  );
  const configDigest = digest(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.docker.container.image.v1+json",
        size: config.length,
        digest: configDigest,
      },
      layers: [],
    }),
  );
  const manifestDigest = digest(manifest);
  await record("htpasswd Basic-authenticated Registry v2 ping", async () => {
    const result = await call(["ping"]);
    assert.equal(
      (result.data as { apiVersion: string }).apiVersion,
      "registry/2.0",
    );
  });
  await record(
    "blob-put uses real Registry start/finalize protocol",
    async () => {
      const result = await call(
        ["blob", "put", repo, "--body", "config.json"],
        { files: [{ path: "config.json", base64: config.toString("base64") }] },
      );
      assert.equal((result.data as { digest: string }).digest, configDigest);
      return { sha256: configDigest, bytes: config.length };
    },
  );
  await record("blob-get verifies uploaded SHA-256", async () => {
    const result = await call([
      "blob",
      "get",
      repo,
      configDigest,
      "config-out.json",
    ]);
    const bytes = Buffer.from(result.files![0].base64, "base64");
    assert.equal(digest(bytes), configDigest);
    assert.deepEqual(bytes, config);
    return { sha256: digest(bytes) };
  });
  await record(
    "repeated blob upload retains its content-addressed digest",
    async () => {
      const result = await call(["blob", "put", repo], {
        input: config.toString(),
      });
      assert.equal((result.data as { digest: string }).digest, configDigest);
    },
  );
  await record("blob-head verifies content metadata", async () => {
    const result = await call(["blob", "head", repo, configDigest]);
    assert.equal((result.data as { digest: string }).digest, configDigest);
  });
  await record(
    "manifest-put publishes an actual schema 2 manifest",
    async () => {
      const result = await call(
        ["manifest", "put", repo, tag, "--body", "manifest.json"],
        {
          files: [
            { path: "manifest.json", base64: manifest.toString("base64") },
          ],
        },
      );
      assert.equal((result.data as { digest: string }).digest, manifestDigest);
      return { sha256: manifestDigest };
    },
  );
  await record(
    "manifest get/head verify exact content and digest",
    async () => {
      const result = await call([
        "manifest",
        "get",
        repo,
        tag,
        "manifest-out.json",
      ]);
      assert.equal(
        digest(Buffer.from(result.files![0].base64, "base64")),
        manifestDigest,
      );
      const head = await call(["manifest", "head", repo, manifestDigest]);
      assert.equal((head.data as { digest: string }).digest, manifestDigest);
    },
  );
  await record(
    "catalog/tags list the owned uploaded repository and tag",
    async () => {
      const catalog = await call(["catalog", "--n", "100"]);
      assert.ok(
        (catalog.data as { repositories: string[] }).repositories.includes(
          repo,
        ),
      );
      const tags = await call(["tags", repo]);
      assert.ok((tags.data as { tags: string[] }).tags.includes(tag));
    },
  );
  await record("manifest-delete removes the test digest", async () => {
    await call(["manifest", "delete", repo, manifestDigest]);
    await assert.rejects(
      call(["manifest", "get", repo, manifestDigest]),
      (error: unknown) => error instanceof AppError && error.status === 404,
    );
  });
  await record("blob-delete removes the owned test config blob", async () => {
    await call(["blob", "delete", repo, configDigest]);
    await assert.rejects(
      call(["blob", "get", repo, configDigest]),
      (error: unknown) => error instanceof AppError && error.status === 404,
    );
  });
  await record(
    "wrong real Registry password returns a credential-free authentication error",
    async () => {
      await assert.rejects(
        registryAdapter.run(
          {
            ...ctx,
            secret: { ...secret, password: "synthetic-intentionally-wrong" },
          },
          { args: ["ping"], timeoutMs: 10000 },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "REGISTRY_AUTH_REQUIRED");
          for (const value of Object.values(secret))
            assert.ok(!error.message.includes(value));
          return true;
        },
      );
    },
  );
  await report(true, {
    endpoint: url.origin,
    repository: repo,
    fullDockerImagePullPushVerified: false,
    tokenExchangeVerified: false,
  });
  process.stdout.write(
    `Registry real integration passed (${checks.length} checks); ${reportPath}\n`,
  );
} catch (error) {
  const code =
    error instanceof AppError
      ? error.code
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "REAL_REGISTRY_CHECK_FAILED";
  await report(false, { error: { code } });
  process.stderr.write(
    `Registry real integration failed: ${code}; ${reportPath}\n`,
  );
  process.exitCode = 1;
}
