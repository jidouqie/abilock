import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  blankConnection,
  connectionWrite,
  type Connection,
} from "../web/components/connection-form.js";
import { connectionWriteSchema } from "../src/connections.js";
import { Store } from "../src/store.js";

// Public form payloads and owned synthetic storage only: no server, browser,
// DNS, native Git/SSH command, real credentials, or upstream business call.
const password = "synthetic-form-password-913448";
const cloud = {
  accessKeyId: "synthetic-form-access-913448",
  secretAccessKey: "synthetic-form-cloud-secret-913448",
};
const certificate = {
  cert: "synthetic-form-certificate-913448",
  key: "synthetic-form-private-certificate-key-913448",
};
function form(kind: Connection["kind"], alias: string) {
  const connection = blankConnection(kind);
  connection.alias = alias;
  connection.note = " 公司项目 ";
  connection.documentationUrl = "https://docs.example.test/usage";
  connection.trustBoundary = "independent-target";
  const config = connection.config;
  if (["ssh", "postgres", "mysql", "redis"].includes(kind))
    config.host = "server.example.test";
  if (kind === "ssh") {
    config.username = "synthetic-user";
    config.hostKeySHA256 = "SHA256:" + "A".repeat(43);
  }
  if (["postgres", "mysql"].includes(kind)) {
    config.user = "synthetic-user";
    config.database = "synthetic-database";
  }
  if (["s3", "docker", "kubernetes", "registry"].includes(kind))
    config.endpoint = "https://server.example.test";
  if (kind === "s3") config.bucket = "synthetic-bucket";
  if (kind === "registry") config.allowedRepositories = ["synthetic/project"];
  return connection;
}

test("restored form payloads save actual supported protocol configurations and preserve optional documentation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-form-storage-"));
  const store = new Store(dir, "8".repeat(64));
  try {
    await store.init();
    const cases: [Connection["kind"], Record<string, string>, string][] = [
      ["ssh", { password }, "password"],
      ["postgres", { password }, "keep"],
      ["mysql", { password }, "keep"],
      ["redis", { password }, "keep"],
      ["s3", cloud, "keep"],
      ["aws", cloud, "keep"],
      ["docker", certificate, "keep"],
      ["kubernetes", { token: password }, "keep"],
      ["registry", { username: "synthetic-user", password }, "keep"],
    ];
    for (const [kind, credentials, identity] of cases) {
      const connection = form(kind, "FORM_" + kind.toUpperCase());
      const input = connectionWriteSchema.parse(
        connectionWrite(connection, null, credentials, identity),
      );
      const saved = await store.saveConnection(
        input.connection,
        input.secret,
        !!input.clearSecret,
        input.expectedRevision,
        connection.alias,
      );
      assert.equal(saved.documentationUrl, connection.documentationUrl);
      assert.equal(saved.note, "公司项目");
      assert.equal(saved.kind, kind);
      assert.equal(saved.hasSecret, true);
      assert.deepEqual(saved.config, input.connection.config);
      const sealed = store.connection(kind, connection.alias).sealed!;
      assert.deepEqual(store.unsealCredentials(sealed), credentials);
      assert(!Object.hasOwn(saved, "sealed"));
    }
    await store.close();
    const reader = new Store(dir, "8".repeat(64), [], { readOnly: true });
    try {
      await reader.init();
      assert.equal(reader.listConnections().length, cases.length);
      assert(reader.listConnections().every((c) => c.documentationUrl));
    } finally {
      await reader.close();
    }
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("storage and container authentication alternatives retain native controlled configuration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-form-options-"));
  const store = new Store(dir, "7".repeat(64));
  try {
    await store.init();
    const r2 = form("s3", "FORM_R2");
    Object.assign(r2.config, {
      provider: "r2",
      region: "auto",
      endpoint: "https://" + "0".repeat(32) + ".r2.cloudflarestorage.com",
      prefix: "selected/",
      allowedCommands: ["get-object", "head-object"],
    });
    const oss = form("s3", "FORM_OSS");
    Object.assign(oss.config, {
      provider: "oss",
      region: "cn-synthetic",
      endpoint: "https://oss-cn-synthetic.aliyuncs.com",
    });
    const docker = form("docker", "FORM_DOCKER_BASIC");
    docker.config.auth = "basic";
    const registry = form("registry", "FORM_REGISTRY_TOKEN");
    registry.config.authType = "bearer";
    const kube = form("kubernetes", "FORM_KUBE_MTLS");
    Object.assign(kube.config, {
      auth: "mtls",
      namespace: "synthetic",
      namespaces: ["synthetic"],
      resources: ["pods", "deployments"],
    });
    for (const [connection, credentials] of [
      [r2, cloud],
      [oss, cloud],
      [docker, { username: "synthetic-user", password }],
      [registry, { token: password }],
      [kube, certificate],
    ] as [Connection, Record<string, string>][]) {
      const input = connectionWriteSchema.parse(
        connectionWrite(connection, null, credentials, "keep"),
      );
      const saved = await store.saveConnection(
        input.connection,
        input.secret,
        !!input.clearSecret,
        0,
        connection.alias,
      );
      assert.deepEqual(saved.config, connection.config);
    }
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("metadata edits keep the original credential and reject partial authentication replacement", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-form-retain-"));
  const store = new Store(dir, "6".repeat(64));
  try {
    await store.init();
    const original = form("ssh", "FORM_SSH");
    const initial = connectionWriteSchema.parse(
      connectionWrite(original, null, { password }, "password"),
    );
    const saved = await store.saveConnection(
      initial.connection,
      initial.secret,
      false,
      0,
    );
    const sealed = store.connection("ssh", original.alias).sealed;
    const edit = { ...saved, alias: "FORM_SSH_RENAMED", note: " 个人账号 " } as Connection;
    const input = connectionWriteSchema.parse(
      connectionWrite(edit, saved, {}, "keep"),
    );
    assert(!input.secret);
    assert.equal(input.connection.note, "个人账号");
    assert.deepEqual(input.connection.config, saved.config);
    assert.equal(input.connection.description, saved.description);
    await store.saveConnection(
      input.connection,
      input.secret,
      false,
      input.expectedRevision,
      saved.alias,
    );
    assert.equal(store.connection("ssh", edit.alias).sealed, sealed);
    assert.equal(store.connection("ssh", edit.alias).note, "个人账号");
    const cleared = connectionWrite({ ...edit, note: "" }, edit, {}, "keep");
    assert.equal(cleared.connection.note, "");
    assert.equal(cleared.secret, undefined);
    assert.equal(cleared.clearSecret, false);
    assert.throws(() => connectionWrite(edit, saved, {}, "privateKey"));
    const basic = form("registry", "FORM_BASIC");
    assert.throws(() =>
      connectionWrite(basic, null, { username: "synthetic-user" }, "keep"),
    );
    const mtls = form("docker", "FORM_TLS");
    assert.throws(() =>
      connectionWrite(mtls, null, { cert: certificate.cert }, "keep"),
    );
    const cloudForm = form("aws", "FORM_CLOUD");
    assert.throws(() =>
      connectionWrite(
        cloudForm,
        null,
        { accessKeyId: cloud.accessKeyId },
        "keep",
      ),
    );
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
