import test from "node:test";
import assert from "node:assert/strict";
import { pinnedAddress, safeUrl } from "../src/security.js";
import { s3Adapter } from "../src/protocols/cloud.js";
import { registryAdapter } from "../src/protocols/registry.js";
import { connectionSchema } from "../src/connections.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

test("private business addresses need explicit trust; special ranges never pass", async () => {
  assert.throws(() => safeUrl("https://10.0.0.5/"), code("PRIVATE_TARGET"));
  assert.equal(safeUrl("https://10.0.0.5/", false, true).hostname, "10.0.0.5");
  assert.equal(safeUrl("https://[fd12::5]/", false, true).hostname, "[fd12::5]");
  for (const target of [
    "https://127.0.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://localhost/",
  ])
    assert.throws(() => safeUrl(target, false, true), code("PRIVATE_TARGET"));

  await assert.rejects(
    pinnedAddress(new URL("https://10.0.0.5/")),
    code("PRIVATE_TARGET"),
  );
  assert.deepEqual(
    await pinnedAddress(new URL("https://10.0.0.5/"), false, true),
    { address: "10.0.0.5", family: 4 },
  );
  await assert.rejects(
    pinnedAddress(new URL("https://100.100.100.200/"), false, true),
    code("BROKER_TARGET_REJECTED"),
  );
});

test("S3-compatible and Registry connections accept private endpoints only with trustedPrivate", () => {
  const storage = (config: Record<string, unknown>) =>
    connectionSchema.parse({
      alias: "STORE",
      name: "Self-hosted storage",
      kind: "s3",
      trustBoundary: "independent-target",
      config: {
        endpoint: "https://10.0.0.8/",
        region: "us-east-1",
        bucket: "business",
        ...config,
      },
    });
  assert.throws(() => s3Adapter.validate(storage({})), code("PRIVATE_TARGET"));
  s3Adapter.validate(storage({ trustedPrivate: true, ca: "-----BEGIN CERTIFICATE-----" }));
  assert.throws(
    () =>
      s3Adapter.validate(
        storage({
          provider: "r2",
          endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com/`,
          region: "auto",
          trustedPrivate: true,
        }),
      ),
    code("CLOUD_ARGUMENT"),
  );

  const registry = (config: Record<string, unknown>) =>
    connectionSchema.parse({
      alias: "IMAGES",
      name: "Self-hosted registry",
      kind: "registry",
      trustBoundary: "independent-target",
      config: {
        endpoint: "https://192.168.10.20/",
        authType: "none",
        allowedRepositories: ["team/app"],
        ...config,
      },
    });
  assert.throws(() => registryAdapter.validate(registry({})), code("PRIVATE_TARGET"));
  registryAdapter.validate(registry({ trustedPrivate: true }));
});
