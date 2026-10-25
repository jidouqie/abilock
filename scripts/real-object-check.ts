import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { s3Adapter } from "../src/protocols/cloud.js";
import type { AdapterContext, Operation } from "../src/connections.js";
import { AppError } from "../src/schema.js";

const reportPath = path.resolve("artifacts/real-object-validation.json");
const checks: { name: string; ok: boolean; evidence?: unknown }[] = [];
const startedAt = new Date().toISOString();
function hash(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
async function record(name: string, run: () => Promise<unknown>) {
  const evidence = await run();
  checks.push({
    name,
    ok: true,
    ...(evidence === undefined ? {} : { evidence }),
  });
}
async function writeReport(ok: boolean, extra: object = {}) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        ok,
        startedAt,
        completedAt: new Date().toISOString(),
        integration: "official AWS SDK against real local MinIO container",
        checks,
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}
let client: S3Client | undefined;
try {
  const ownedConfig = process.env.ABILOCK_TEST_ENV;
  if (!ownedConfig) throw new Error("ABILOCK_TEST_ENV_REQUIRED");
  const stat = await fs.stat(ownedConfig);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("OWNED_CONFIG_REQUIRED");
  const { minio } = z
    .object({
      minio: z.object({
        endpoint: z.string(),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        bucket: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
          .default("abilock-test"),
        region: z.string().default("us-east-1"),
      }),
    })
    .passthrough()
    .parse(JSON.parse(await fs.readFile(ownedConfig, "utf8")));
  const endpoint = new URL(minio.endpoint);
  if (
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("LOCAL_MINIO_ONLY");
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  const secret = {
    accessKeyId: minio.accessKeyId,
    secretAccessKey: minio.secretAccessKey,
  };
  client = new S3Client({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 3000,
      requestTimeout: 10000,
      socketTimeout: 10000,
      throwOnRequestTimeout: true,
    }),
    endpoint: minio.endpoint,
    region: minio.region,
    // SDK identity providers may annotate their object; keep the adapter's strict UI secret record untouched.
    credentials: { ...secret },
    forcePathStyle: true,
    maxAttempts: 1,
    defaultsMode: "standard",
    retryMode: "standard",
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    useArnRegion: false,
    disableS3ExpressSessionAuth: true,
    disableClockSkewCorrection: true,
    authSchemePreference: ["aws.auth#sigv4"],
    sigv4aSigningRegionSet: [],
    userAgentAppId: "Abilock",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentialDefaultProvider: () => async () => {
      throw new Error("NO_DEFAULT_CREDENTIALS");
    },
  });
  await record("owned local MinIO test bucket is available", async () => {
    try {
      await client!.send(new HeadBucketCommand({ Bucket: minio.bucket }));
    } catch {
      await client!.send(new CreateBucketCommand({ Bucket: minio.bucket }));
    }
    return { bucket: minio.bucket };
  });
  const prefix = `verification/${crypto.randomUUID()}/`;
  const ctx: AdapterContext = {
    connection: {
      alias: "MINIO_REAL_TEST",
      name: "Owned temporary local MinIO",
      kind: "s3",
      enabled: true,
      description: "Synthetic integration only",
      trustBoundary: "development-fixture",
      config: {
        endpoint: minio.endpoint,
        region: minio.region,
        bucket: minio.bucket,
        prefix,
        allowInsecureLocal: true,
      },
    },
    secret,
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: "/tmp",
  };
  s3Adapter.validate(ctx.connection, secret);
  const op = (args: string[], extra: Partial<Operation> = {}): Operation => ({
    args,
    timeoutMs: 10000,
    ...extra,
  });
  const bytes = Buffer.concat([
    Buffer.from([0, 1, 255]),
    crypto.randomBytes(4096),
  ]);
  const digest = hash(bytes);
  await record("put-object uploads actual binary bytes", async () => {
    const result = await s3Adapter.run(
      ctx,
      op(["put-object", "--key", prefix + "a.bin", "--body", "upload.bin"], {
        files: [{ path: "upload.bin", base64: bytes.toString("base64") }],
      }),
    );
    assert.equal(result.exitCode, 0);
    return { sha256: digest, bytes: bytes.length };
  });
  await record("list-objects-v2 discovers uploaded object", async () => {
    const result = await s3Adapter.run(ctx, op(["list-objects-v2"]));
    assert.match(result.stdout!, /a\.bin/);
    return {
      objects: (result.data as { Contents: unknown[] }).Contents.length,
    };
  });
  await record("get-object matches upload SHA-256", async () => {
    const result = await s3Adapter.run(
      ctx,
      op(["get-object", "--key", prefix + "a.bin", "download.bin"]),
    );
    const downloaded = Buffer.from(result.files![0].base64, "base64");
    assert.equal(hash(downloaded), digest);
    return { sha256: hash(downloaded), bytes: downloaded.length };
  });
  await record("head-object matches actual object length", async () => {
    const result = await s3Adapter.run(
      ctx,
      op(["head-object", "--key", prefix + "a.bin"]),
    );
    assert.equal(
      (result.data as { ContentLength: number }).ContentLength,
      bytes.length,
    );
  });
  await record("native cp uses real MinIO CopyObject", async () => {
    await s3Adapter.run(
      ctx,
      op([
        "cp",
        `s3://${minio.bucket}/${prefix}a.bin`,
        `s3://${minio.bucket}/${prefix}b.bin`,
      ]),
    );
    const result = await s3Adapter.run(ctx, op(["get", prefix + "b.bin"]));
    assert.equal(hash(Buffer.from(result.files![0].base64, "base64")), digest);
  });
  await record("native mv copies and deletes its source", async () => {
    await s3Adapter.run(
      ctx,
      op([
        "mv",
        `s3://${minio.bucket}/${prefix}b.bin`,
        `s3://${minio.bucket}/${prefix}c.bin`,
      ]),
    );
    const result = await s3Adapter.run(ctx, op(["ls"]));
    assert.ok(!result.stdout!.includes(prefix + "b.bin"));
    assert.ok(result.stdout!.includes(prefix + "c.bin"));
  });
  await record("delete-object removes owned test objects", async () => {
    for (const object of ["a.bin", "c.bin"])
      await s3Adapter.run(ctx, op(["delete-object", "--key", prefix + object]));
    const result = await s3Adapter.run(ctx, op(["ls"]));
    assert.equal(
      (result.data as { Contents?: unknown[] }).Contents?.length || 0,
      0,
    );
  });
  await record(
    "real MinIO authentication errors remain credential-free",
    async () => {
      await assert.rejects(
        s3Adapter.run(
          {
            ...ctx,
            secret: {
              ...secret,
              secretAccessKey: "intentionally-invalid-synthetic-only",
            },
          },
          op(["ls"]),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          for (const value of Object.values(secret))
            assert.ok(!error.message.includes(value));
          return true;
        },
      );
    },
  );
  await writeReport(true, {
    endpoint: endpoint.origin,
    vendorCloudsVerified: [],
  });
  process.stdout.write(
    `MinIO real integration passed (${checks.length} checks); ${reportPath}\n`,
  );
} catch (error) {
  const code =
    error instanceof AppError
      ? error.code
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "REAL_MINIO_CHECK_FAILED";
  await writeReport(false, { error: { code } });
  process.stderr.write(
    `MinIO real integration failed: ${code}; ${reportPath}\n`,
  );
  process.exitCode = 1;
} finally {
  client?.destroy();
}
