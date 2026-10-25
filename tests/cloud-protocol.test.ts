import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import { awsAdapter, s3Adapter } from "../src/protocols/cloud.js";
import type {
  AdapterContext,
  Connection,
  Operation,
} from "../src/connections.js";
import { AppError } from "../src/schema.js";

// Independent HTTP fixtures parse AWS wire protocols and verify SigV4 HMACs.
// This is SDK-to-wire integration, not a real AWS/OSS/R2 or MinIO service.
const accessKeyId = "AKIA_SYNTHETIC_ONLY_2026";
const secretAccessKey = "synthetic-secret-not-a-live-credential-456";
const sessionToken = "synthetic-session-only-789";
const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
before(() => {
  process.env.ABILOCK_ALLOW_LOCAL = "1";
});
after(() => {
  if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
  else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
});
function hash(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function hmac(key: crypto.BinaryLike, value: string) {
  return crypto.createHmac("sha256", key).update(value).digest();
}
function escape(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function verifySignature(req: http.IncomingMessage, body: Buffer) {
  const auth = req.headers.authorization || "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
      auth,
    );
  assert.ok(match, "SDK must send an AWS SigV4 header");
  assert.equal(match[1], accessKeyId);
  assert.equal(req.headers["x-amz-security-token"], sessionToken);
  const [day, region, service, end] = match[2].split("/");
  assert.equal(end, "aws4_request");
  const u = new URL(req.url!, `http://${req.headers.host}`);
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [escape(k), escape(v)])
    .sort(([a, b], [c, d]) =>
      a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signedHeaders = match[3];
  const canonicalHeaders = signedHeaders
    .split(";")
    .map(
      (name) =>
        `${name}:${String(req.headers[name]).trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const payloadHash = String(req.headers["x-amz-content-sha256"] || hash(body));
  if (payloadHash !== "UNSIGNED-PAYLOAD") assert.equal(payloadHash, hash(body));
  const canonical = [
    req.method!,
    u.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    String(req.headers["x-amz-date"]),
    match[2],
    hash(canonical),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service),
    end,
  );
  assert.equal(
    hmac(signingKey, toSign).toString("hex"),
    match[4],
    "independent SigV4 signature must match",
  );
  assert.ok(!body.includes(Buffer.from(secretAccessKey)));
  return { u, service, body: body.toString() };
}
async function fixture(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) => void | Promise<void>,
) {
  const failures: unknown[] = [];
  const requests: { method: string; url: string; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method!,
        url: req.url!,
        body: body.toString(),
      });
      await handler(req, res, body);
    } catch (error) {
      failures.push(error);
      res.statusCode = 500;
      res.end("fixture rejected malformed protocol");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      assert.deepEqual(failures, []);
    },
  };
}
function context(
  config: Record<string, unknown>,
  kind: "s3" | "aws" = "s3",
): AdapterContext {
  return {
    connection: {
      alias: "TEST",
      name: "Synthetic protocol fixture",
      kind,
      enabled: true,
      description: "",
      config,
    },
    secret: { accessKeyId, secretAccessKey, sessionToken },
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: "/tmp",
  };
}
function operation(args: string[], other: Partial<Operation> = {}): Operation {
  return { args, timeoutMs: 3000, ...other };
}
function storageConfig(endpoint: string) {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "test-bucket",
    prefix: "safe/",
    allowInsecureLocal: true,
  };
}
function xml(res: http.ServerResponse, content: string) {
  res.setHeader("content-type", "application/xml");
  res.end(content);
}

const dnsCases: {
  name: string;
  kind: "s3" | "aws";
  config: Record<string, unknown>;
  args: string[];
}[] = [
  {
    name: "S3",
    kind: "s3",
    config: storageConfig("https://synthetic.example.com"),
    args: ["ls"],
  },
  {
    name: "OSS virtual bucket",
    kind: "s3",
    config: {
      ...storageConfig("https://oss-cn-synthetic.aliyuncs.com"),
      provider: "oss",
    },
    args: ["ls"],
  },
  {
    name: "R2",
    kind: "s3",
    config: {
      ...storageConfig(
        "https://00000000000000000000000000000000.r2.cloudflarestorage.com",
      ),
      provider: "r2",
      region: "auto",
    },
    args: ["ls"],
  },
  {
    name: "AWS STS",
    kind: "aws",
    config: {
      region: "us-east-1",
      allowedServices: ["sts"],
      endpoints: { sts: "https://synthetic.example.com" },
    },
    args: ["sts", "get-caller-identity"],
  },
  {
    name: "AWS EC2",
    kind: "aws",
    config: {
      region: "us-east-1",
      allowedServices: ["ec2"],
      endpoints: { ec2: "https://synthetic.example.com" },
    },
    args: ["ec2", "describe-instances"],
  },
  {
    name: "AWS S3API",
    kind: "aws",
    config: {
      region: "us-east-1",
      allowedServices: ["s3api"],
      endpoints: { s3api: "https://synthetic.example.com" },
      bucket: "test-bucket",
      prefix: "safe/",
    },
    args: ["s3api", "list-objects-v2"],
  },
];

async function checkDnsDeadline(
  item: (typeof dnsCases)[number],
  cancelled: boolean,
) {
  let release!: (rows: { address: string; family: number }[]) => void;
  const lookup = mock.method(
    dns,
    "lookup",
    () =>
      new Promise<{ address: string; family: number }[]>((resolve) => {
        release = resolve;
      }),
  );
  const forbidden = () => {
    throw new Error("Stopped cloud DNS must not create an agent or request");
  };
  const agents = [
    mock.method(http, "Agent", forbidden),
    mock.method(https, "Agent", forbidden),
    mock.method(http, "request", forbidden),
    mock.method(https, "request", forbidden),
  ];
  const controller = new AbortController();
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const ctx = {
      ...context({ ...item.config, allowInsecureLocal: false }, item.kind),
      allowLocal: false,
      signal: controller.signal,
    };
    const adapter = item.kind === "aws" ? awsAdapter : s3Adapter;
    const pending = adapter.run(
      ctx,
      operation(item.args, { timeoutMs: cancelled ? 10000 : 100 }),
    );
    const rejected = assert.rejects(pending, {
      code: cancelled ? "CLOUD_CANCELLED" : "CLOUD_TIMEOUT",
      status: cancelled ? 499 : 504,
    });
    if (cancelled) controller.abort();
    await Promise.race([
      rejected,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Cloud DNS wait did not stop")),
          1000,
        );
      }),
    ]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    for (const agent of agents) assert.equal(agent.mock.callCount(), 0);
    release([{ address: "1.1.1.1", family: 4 }]);
    await nextTurn();
    for (const agent of agents) assert.equal(agent.mock.callCount(), 0);
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    clearTimeout(watchdog);
    lookup.mock.restore();
    for (const agent of agents) agent.mock.restore();
  }
}

for (const item of dnsCases) {
  test(`Cloud final DNS deadline stops ${item.name} before agent/socket creation`, () =>
    checkDnsDeadline(item, false));
  test(`Cloud final DNS cancellation stops ${item.name} and ignores late resolution`, () =>
    checkDnsDeadline(item, true));
}

test("S3 official SDK list/put/get/head/copy/move/delete uses independently verified SigV4 wire requests", async () => {
  const objects = new Map<string, Buffer>();
  const api = await fixture((req, res, body) => {
    const { u, service } = verifySignature(req, body);
    assert.equal(service, "s3");
    assert.ok(u.pathname.startsWith("/test-bucket/"));
    const k = decodeURIComponent(u.pathname.slice("/test-bucket/".length));
    if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
      assert.equal(u.searchParams.get("prefix"), "safe/");
      assert.equal(u.searchParams.get("max-keys"), "10");
      xml(
        res,
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix>safe/</Prefix><MaxKeys>10</MaxKeys><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>safe/hello.txt</Key><Size>5</Size></Contents></ListBucketResult>',
      );
    } else if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
      const source = decodeURIComponent(
        String(req.headers["x-amz-copy-source"]),
      ).replace(/^test-bucket\//, "");
      assert.ok(objects.has(source));
      objects.set(k, objects.get(source)!);
      xml(
        res,
        '<CopyObjectResult><ETag>"synthetic-etag"</ETag><LastModified>2026-10-06T00:00:00Z</LastModified></CopyObjectResult>',
      );
    } else if (req.method === "PUT") {
      objects.set(k, body);
      res.setHeader("etag", '"synthetic-etag"');
      res.end();
    } else if (req.method === "HEAD") {
      assert.ok(objects.has(k));
      res.setHeader("content-length", objects.get(k)!.length);
      res.setHeader("etag", '"synthetic-etag"');
      res.end();
    } else if (req.method === "GET") {
      assert.ok(objects.has(k));
      res.setHeader("content-type", "application/octet-stream");
      res.end(objects.get(k));
    } else if (req.method === "DELETE") {
      objects.delete(k);
      res.statusCode = 204;
      res.end();
    } else assert.fail("unexpected S3 wire operation");
  });
  const ctx = context(storageConfig(api.endpoint));
  try {
    s3Adapter.validate(ctx.connection, ctx.secret);
    const list = await s3Adapter.run(
      ctx,
      operation(["ls", "--max-keys", "10"]),
    );
    assert.equal(list.exitCode, 0);
    assert.match(list.stdout!, /safe\/hello.txt/);
    const bytes = Buffer.from([0, 1, 255, 65, 66]);
    await s3Adapter.run(
      ctx,
      operation(
        ["put-object", "--key", "safe/hello.txt", "--body", "upload.bin"],
        { files: [{ path: "upload.bin", base64: bytes.toString("base64") }] },
      ),
    );
    const head = await s3Adapter.run(
      ctx,
      operation(["head", "safe/hello.txt"]),
    );
    assert.equal((head.data as { ContentLength: number }).ContentLength, 5);
    const get = await s3Adapter.run(
      ctx,
      operation(["get-object", "--key", "safe/hello.txt", "out.bin"]),
    );
    assert.equal(get.files![0].path, "out.bin");
    assert.deepEqual(Buffer.from(get.files![0].base64, "base64"), bytes);
    assert.equal(
      hash(Buffer.from(get.files![0].base64, "base64")),
      hash(bytes),
    );
    await s3Adapter.run(
      ctx,
      operation([
        "copy-object",
        "--key",
        "safe/copy.txt",
        "--copy-source",
        "s3://test-bucket/safe/hello.txt",
      ]),
    );
    await s3Adapter.run(
      ctx,
      operation([
        "move-object",
        "--key",
        "safe/moved.txt",
        "--copy-source",
        "safe/copy.txt",
      ]),
    );
    assert.equal(objects.has("safe/copy.txt"), false);
    await s3Adapter.run(ctx, operation(["rm", "safe/hello.txt"]));
    assert.equal(objects.has("safe/hello.txt"), false);
    assert.equal(api.requests.length, 8);
  } finally {
    await api.close();
  }
});

test("native-style S3 cp and mv map to real upload, download and same-bucket operations", async () => {
  const objects = new Map<string, Buffer>();
  const api = await fixture((req, res, body) => {
    const { u } = verifySignature(req, body);
    const k = decodeURIComponent(u.pathname.replace(/^\/test-bucket\//, ""));
    if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
      const source = decodeURIComponent(
        String(req.headers["x-amz-copy-source"]),
      ).replace(/^test-bucket\//, "");
      objects.set(k, objects.get(source)!);
      xml(res, '<CopyObjectResult><ETag>"fixture"</ETag></CopyObjectResult>');
    } else if (req.method === "PUT") {
      objects.set(k, body);
      res.end();
    } else if (req.method === "GET") res.end(objects.get(k));
    else if (req.method === "DELETE") {
      objects.delete(k);
      res.statusCode = 204;
      res.end();
    } else assert.fail("unexpected cp wire operation");
  });
  const ctx = context(storageConfig(api.endpoint));
  try {
    const bytes = Buffer.from("native cp synthetic fixture");
    await s3Adapter.run(
      ctx,
      operation(["cp", "client.bin", "s3://test-bucket/safe/a"], {
        files: [{ path: "client.bin", base64: bytes.toString("base64") }],
      }),
    );
    const out = await s3Adapter.run(
      ctx,
      operation(["cp", "s3://test-bucket/safe/a", "client-out.bin"]),
    );
    assert.equal(
      hash(Buffer.from(out.files![0].base64, "base64")),
      hash(bytes),
    );
    await s3Adapter.run(
      ctx,
      operation(["cp", "s3://test-bucket/safe/a", "s3://test-bucket/safe/b"]),
    );
    await s3Adapter.run(
      ctx,
      operation(["mv", "s3://test-bucket/safe/b", "s3://test-bucket/safe/c"]),
    );
    assert.equal(objects.has("safe/b"), false);
    assert.deepEqual(objects.get("safe/c"), bytes);
  } finally {
    await api.close();
  }
});

test("AWS STS and EC2 SDK query protocols, native IDs/filters/pagination and mutations", async () => {
  const api = await fixture((req, res, body) => {
    const { service } = verifySignature(req, body);
    const q = new URLSearchParams(body.toString());
    if (service === "sts") {
      assert.equal(q.get("Action"), "GetCallerIdentity");
      assert.equal(q.get("Version"), "2011-06-15");
      xml(
        res,
        '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/fixture</Arn><UserId>fixture</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture-request</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
      );
    } else {
      assert.equal(service, "ec2");
      assert.equal(q.get("Version"), "2016-11-15");
      assert.equal(q.get("InstanceId.1"), "i-1234567890abcdef0");
      if (q.get("Action") === "DescribeInstances") {
        assert.equal(q.get("Filter.1.Name"), "tag:Name");
        assert.equal(q.get("Filter.1.Value.1"), "fixture");
        assert.equal(q.get("MaxResults"), "10");
        assert.equal(q.get("NextToken"), "opaque-token");
        xml(
          res,
          '<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>fixture-request</requestId><reservationSet><item><reservationId>r-1</reservationId><instancesSet><item><instanceId>i-1234567890abcdef0</instanceId><instanceState><code>16</code><name>running</name></instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>',
        );
      } else if (q.get("Action") === "RebootInstances")
        xml(
          res,
          "<RebootInstancesResponse><requestId>fixture-request</requestId><return>true</return></RebootInstancesResponse>",
        );
      else {
        assert.ok(
          ["StartInstances", "StopInstances"].includes(q.get("Action")!),
        );
        xml(
          res,
          `<${q.get("Action")}Response><requestId>fixture-request</requestId><instancesSet><item><instanceId>i-1234567890abcdef0</instanceId><currentState><code>16</code><name>running</name></currentState></item></instancesSet></${q.get("Action")}Response>`,
        );
      }
    }
  });
  const ctx = context(
    {
      region: "us-east-1",
      allowedServices: ["sts", "ec2"],
      endpoints: { sts: api.endpoint, ec2: api.endpoint },
      allowInsecureLocal: true,
    },
    "aws",
  );
  try {
    awsAdapter.validate(ctx.connection, ctx.secret);
    const who = await awsAdapter.run(
      ctx,
      operation(["sts", "get-caller-identity"]),
    );
    assert.equal((who.data as { Account: string }).Account, "123456789012");
    const describe = await awsAdapter.run(
      ctx,
      operation([
        "ec2",
        "describe-instances",
        "--instance-ids",
        "i-1234567890abcdef0",
        "--filters",
        '[{"Name":"tag:Name","Values":["fixture"]}]',
        "--max-results",
        "10",
        "--next-token",
        "opaque-token",
      ]),
    );
    assert.match(describe.stdout!, /running/);
    for (const action of [
      "start-instances",
      "stop-instances",
      "reboot-instances",
    ])
      await awsAdapter.run(
        ctx,
        operation(["ec2", action, "--instance-ids", "i-1234567890abcdef0"]),
      );
    assert.equal(api.requests.length, 5);
  } finally {
    await api.close();
  }
});

test("object storage rejects target, credential, bucket, prefix and local-file overrides before requests", async () => {
  const api = await fixture(() =>
    assert.fail("unsafe command must not reach network"),
  );
  const ctx = context(storageConfig(api.endpoint));
  try {
    for (const args of [
      ["get", "safe/a", "--endpoint-url", "https://evil.example"],
      ["get", "safe/a", "--profile", "default"],
      ["get", "safe/a", "--no-sign-request"],
      ["get-object", "--bucket", "other-bucket", "--key", "safe/a"],
      ["get", "s3://other-bucket/safe/a"],
      ["get", "outside/a"],
      ["get", "safe/../a"],
      ["put", "safe/a", "--body", "file:///etc/passwd"],
      ["put", "safe/a", "--body", "/etc/passwd"],
      ["get", "safe/a", "--key", "safe/a", "--key", "safe/b"],
      ["presign", "safe/a"],
      ["configure", "export-credentials"],
    ])
      await assert.rejects(
        s3Adapter.run(ctx, operation(args)),
        (e: unknown) => e instanceof AppError && e.status === 400,
      );
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("AWS refuses credential export, profile/endpoint/config overrides and unsupported services", async () => {
  const api = await fixture(() =>
    assert.fail("unsafe AWS command must not reach network"),
  );
  const ctx = context(
    {
      region: "us-east-1",
      allowedServices: ["sts", "ec2"],
      endpoints: { sts: api.endpoint, ec2: api.endpoint },
      allowInsecureLocal: true,
    },
    "aws",
  );
  try {
    for (const args of [
      ["configure", "export-credentials"],
      ["sts", "assume-role"],
      ["sts", "get-caller-identity", "--endpoint-url", api.endpoint],
      ["ec2", "describe-instances", "--profile", "default"],
      ["ec2", "start-instances"],
      ["ec2", "describe-instances", "--instance-ids", "http://evil.example"],
      ["secretsmanager", "get-secret-value"],
    ])
      await assert.rejects(
        awsAdapter.run(ctx, operation(args)),
        (e: unknown) => e instanceof AppError && e.status === 400,
      );
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("SDK redirects are blocked without leaking signed headers to the Location", async () => {
  let leaked = 0;
  const sink = await fixture((_req, res) => {
    leaked++;
    res.end();
  });
  const api = await fixture((req, res, body) => {
    verifySignature(req, body);
    res.statusCode = 302;
    res.setHeader("location", sink.endpoint + "/stolen");
    res.end();
  });
  try {
    await assert.rejects(
      s3Adapter.run(context(storageConfig(api.endpoint)), operation(["ls"])),
      (e: unknown) => e instanceof AppError && e.code === "CLOUD_REDIRECT",
    );
    await assert.rejects(
      awsAdapter.run(
        context(
          {
            region: "us-east-1",
            allowedServices: ["sts"],
            endpoints: { sts: api.endpoint },
            allowInsecureLocal: true,
          },
          "aws",
        ),
        operation(["sts", "get-caller-identity"]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "CLOUD_REDIRECT",
    );
    assert.equal(leaked, 0);
    assert.equal(api.requests.length, 2);
  } finally {
    await api.close();
    await sink.close();
  }
});

test("cloud errors and binary/text output redact all synthetic credentials; cancellation and size limits work", async () => {
  const api = await fixture((req, res, body) => {
    const { u } = verifySignature(req, body);
    if (u.pathname.endsWith("error")) {
      res.statusCode = 403;
      xml(
        res,
        `<Error><Code>AccessDenied</Code><Message>${secretAccessKey} ${sessionToken} ${accessKeyId}</Message></Error>`,
      );
    } else if (u.pathname.endsWith("large")) {
      res.end(Buffer.alloc(100));
    } else {
      res.end(
        Buffer.concat([
          Buffer.from([0, 255]),
          Buffer.from(`${secretAccessKey} ${sessionToken} ${accessKeyId}`),
        ]),
      );
    }
  });
  const ctx = context(storageConfig(api.endpoint));
  try {
    await assert.rejects(
      s3Adapter.run(ctx, operation(["get", "safe/error"])),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.match(e.message, /AccessDenied/);
        for (const s of Object.values(ctx.secret))
          assert.ok(!e.message.includes(s));
        return true;
      },
    );
    const result = await s3Adapter.run(ctx, operation(["get", "safe/echo"]));
    const bytes = Buffer.from(result.files![0].base64, "base64");
    assert.equal(bytes[0], 0);
    assert.equal(bytes[1], 255);
    for (const s of Object.values(ctx.secret))
      assert.ok(!bytes.includes(Buffer.from(s)));
    assert.match(bytes.toString(), /REDACTED/);
    const small = context({ ...storageConfig(api.endpoint), maxBytes: 5 });
    await assert.rejects(
      s3Adapter.run(small, operation(["get", "safe/large"])),
      (e: unknown) => e instanceof AppError && e.code === "CLOUD_LIMIT",
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      s3Adapter.run({ ...ctx, signal: controller.signal }, operation(["ls"])),
      (e: unknown) => e instanceof AppError && e.code === "CLOUD_CANCELLED",
    );
  } finally {
    await api.close();
  }
});

test("R2/OSS management validation enforces official provider settings, HTTPS and fixed safe root targets", () => {
  const valid = (config: Record<string, unknown>) =>
    ({
      alias: "OBJ",
      kind: "s3",
      name: "Provider",
      enabled: true,
      description: "",
      config,
    }) as Connection;
  s3Adapter.validate(
    valid({
      provider: "r2",
      endpoint:
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "test-bucket",
    }),
  );
  s3Adapter.validate(
    valid({
      provider: "oss",
      endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      region: "cn-hangzhou",
      bucket: "test-bucket",
    }),
  );
  for (const config of [
    {
      provider: "r2",
      endpoint:
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      region: "us-east-1",
      bucket: "test-bucket",
    },
    {
      provider: "oss",
      endpoint: "https://evil.example",
      region: "cn-hangzhou",
      bucket: "test-bucket",
    },
    {
      endpoint: "https://user:password@objects.example",
      region: "us-east-1",
      bucket: "test-bucket",
    },
    {
      endpoint: "https://169.254.169.254",
      region: "us-east-1",
      bucket: "test-bucket",
    },
    {
      endpoint: "https://objects.example/path",
      region: "us-east-1",
      bucket: "test-bucket",
    },
    {
      endpoint: "https://objects.example?x=1",
      region: "us-east-1",
      bucket: "test-bucket",
    },
    {
      endpoint: "https://objects.example",
      region: "us-east-1",
      bucket: "test-bucket",
      prefix: "unsafe",
    },
  ])
    assert.throws(() => s3Adapter.validate(valid(config)));
  assert.throws(() =>
    s3Adapter.validate(
      valid({
        endpoint: "https://objects.example",
        region: "us-east-1",
        bucket: "test-bucket",
      }),
      { accessKeyId, secretAccessKey, credential_process: "evil" },
    ),
  );
});

test("AWS s3api reuses signed fixed-bucket storage operations with explicit service policy", async () => {
  const api = await fixture((req, res, body) => {
    const { u, service } = verifySignature(req, body);
    assert.equal(service, "s3");
    assert.equal(u.pathname, "/test-bucket/safe/a");
    if (req.method === "PUT") {
      assert.equal(body.toString(), "stdin object body");
      res.end();
    } else if (req.method === "GET") res.end("stdin object body");
    else if (req.method === "DELETE") {
      res.statusCode = 204;
      res.end();
    } else assert.fail("unexpected s3api operation");
  });
  const ctx = context(
    {
      region: "us-east-1",
      allowedServices: ["s3api"],
      endpoints: { s3api: api.endpoint },
      bucket: "test-bucket",
      prefix: "safe/",
      allowInsecureLocal: true,
    },
    "aws",
  );
  try {
    awsAdapter.validate(ctx.connection, ctx.secret);
    await awsAdapter.run(
      ctx,
      operation(["s3api", "put-object", "--key", "safe/a"], {
        input: "stdin object body",
      }),
    );
    const out = await awsAdapter.run(
      ctx,
      operation(["s3api", "get-object", "--key", "safe/a", "out.txt"]),
    );
    assert.equal(
      Buffer.from(out.files![0].base64, "base64").toString(),
      "stdin object body",
    );
    await awsAdapter.run(
      ctx,
      operation(["s3api", "delete-object", "--key", "safe/a"]),
    );
    await assert.rejects(
      awsAdapter.run(ctx, operation(["sts", "get-caller-identity"])),
      (e: unknown) => e instanceof AppError && e.status === 400,
    );
    assert.equal(api.requests.length, 3);
  } finally {
    await api.close();
  }
});

test("normal TLS verification rejects a self-signed local fixture certificate", async () => {
  const [key, cert] = await Promise.all([
    fs.readFile(
      new URL("./fixtures/cloud-selfsigned-key.pem", import.meta.url),
    ),
    fs.readFile(
      new URL("./fixtures/cloud-selfsigned-cert.pem", import.meta.url),
    ),
  ]);
  let requests = 0;
  const server = https.createServer({ key, cert }, (_req, res) => {
    requests++;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const ctx = context(
      storageConfig(
        `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ),
    );
    await assert.rejects(
      s3Adapter.run(ctx, operation(["ls"])),
      (e: unknown) => e instanceof AppError && e.code === "CLOUD_UPSTREAM",
    );
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
