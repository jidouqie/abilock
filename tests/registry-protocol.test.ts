import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { before, after, mock, test } from "node:test";
import { registryAdapter } from "../src/protocols/registry.js";
import type { AdapterContext, Operation } from "../src/connections.js";
import { AppError } from "../src/schema.js";
import {
  operationTraceForError,
  runProtocolOperation,
} from "../src/operation-runner.js";

const username = "fixture-registry-user",
  password = "synthetic-registry-password-2026",
  token = "synthetic-bearer-registry-2026";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const oldLocal = process.env.ABILOCK_ALLOW_LOCAL;
before(() => {
  process.env.ABILOCK_ALLOW_LOCAL = "1";
});
after(() => {
  if (oldLocal === undefined) delete process.env.ABILOCK_ALLOW_LOCAL;
  else process.env.ABILOCK_ALLOW_LOCAL = oldLocal;
});
function digest(body: Buffer) {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}
async function fixture(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) => void,
) {
  const failures: unknown[] = [],
    requests: { method: string; url: string }[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      for await (const p of req) parts.push(Buffer.from(p));
      requests.push({ method: req.method!, url: req.url! });
      handler(req, res, Buffer.concat(parts));
    } catch (error) {
      failures.push(error);
      res.statusCode = 500;
      res.end("fixture rejects malformed protocol");
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
  endpoint: string,
  more: Record<string, unknown> = {},
  bearer = false,
): AdapterContext {
  return {
    connection: {
      alias: "REG",
      name: "Synthetic Registry",
      kind: "registry",
      enabled: true,
      description: "",
      trustBoundary: "development-fixture",
      config: {
        endpoint,
        authType: bearer ? "bearer" : "basic",
        allowedRepositories: ["team/app"],
        allowInsecureLocal: true,
        ...more,
      },
    },
    secret: bearer ? { token } : { username, password },
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: "/tmp",
  };
}
function op(args: string[], extra: Partial<Operation> = {}): Operation {
  return { args, timeoutMs: 2000, ...extra };
}
const manifestType = "application/vnd.docker.distribution.manifest.v2+json";
function json(res: http.ServerResponse, data: unknown) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

for (const cancelled of [false, true]) {
  test(`Registry final DNS ${cancelled ? "cancellation" : "deadline"} stops before agent/socket creation and ignores late resolution`, async () => {
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
      throw new Error(
        "Stopped Registry DNS must not create an agent or request",
      );
    };
    const guards = [
      mock.method(http, "Agent", forbidden),
      mock.method(https, "Agent", forbidden),
      mock.method(http, "request", forbidden),
      mock.method(https, "request", forbidden),
    ];
    const controller = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const ctx = {
        ...context("https://synthetic.example.com", {
          allowInsecureLocal: false,
        }),
        allowLocal: false,
        signal: controller.signal,
      };
      const pending = registryAdapter.run(
        ctx,
        op(["ping"], { timeoutMs: cancelled ? 10000 : 100 }),
      );
      const rejected = assert.rejects(pending, {
        code: cancelled ? "REGISTRY_CANCELLED" : "REGISTRY_TIMEOUT",
        status: cancelled ? 499 : 504,
      });
      if (cancelled) controller.abort();
      await Promise.race([
        rejected,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("Registry DNS wait did not stop")),
            1000,
          );
        }),
      ]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      release([{ address: "1.1.1.1", family: 4 }]);
      await nextTurn();
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      assert.equal(lookup.mock.callCount(), 1);
    } finally {
      clearTimeout(watchdog);
      lookup.mock.restore();
      for (const guard of guards) guard.mock.restore();
    }
  });
}

for (const frozen of [false, true]) {
  test(`Registry copies a ${frozen ? "frozen" : "shared"} caller cancellation reason without mutating it`, async () => {
    const releases: ((rows: { address: string; family: number }[]) => void)[] = [];
    const lookup = mock.method(
      dns,
      "lookup",
      () =>
        new Promise<{ address: string; family: number }[]>((resolve) => {
          releases.push(resolve);
        }),
    );
    const forbidden = () => {
      throw new Error("Cancelled Registry DNS must not create a socket or agent");
    };
    const guards = [
      mock.method(http, "Agent", forbidden),
      mock.method(https, "Agent", forbidden),
      mock.method(http, "request", forbidden),
      mock.method(https, "request", forbidden),
    ];
    const controller = new AbortController();
    const reason = new AppError(
      499,
      "SYNTHETIC_CANCELLED",
      `synthetic cancellation ${token}`,
    );
    if (frozen) Object.freeze(reason);
    try {
      const ctx = {
        ...context(
          "https://synthetic.example.com",
          { allowInsecureLocal: false },
          true,
        ),
        allowLocal: false,
        signal: controller.signal,
      };
      const pending = [1, 2].map(() =>
        runProtocolOperation(registryAdapter, ctx, op(["ping"])).then(
          () => assert.fail("the Registry operation must be cancelled"),
          (error: unknown) => error,
        ),
      );
      assert.equal(lookup.mock.callCount(), 2, "cancel after both DNS waits start");
      controller.abort(reason);
      const errors = await Promise.all(pending);
      for (const error of errors) {
        assert(error instanceof AppError);
        assert.equal(error.status, 499);
        assert.equal(error.code, "SYNTHETIC_CANCELLED");
        assert.equal(error.message, "synthetic cancellation [REDACTED]");
        const safeCause: unknown = Reflect.get(error, "cause");
        assert(safeCause instanceof AppError);
        assert.notEqual(safeCause, reason);
        assert.equal(Reflect.get(safeCause, "cause"), reason);
        assert(operationTraceForError(error));
      }
      assert.notEqual(
        operationTraceForError(errors[0])?.operationId,
        operationTraceForError(errors[1])?.operationId,
      );
      assert.equal(reason.status, 499);
      assert.equal(reason.code, "SYNTHETIC_CANCELLED");
      assert.equal(reason.message, `synthetic cancellation ${token}`);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      for (const release of releases) release([{ address: "1.1.1.1", family: 4 }]);
      await nextTurn();
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
    } finally {
      lookup.mock.restore();
      for (const guard of guards) guard.mock.restore();
    }
  });
}

test("Registry V2 Basic auth catalog/tags/blob upload/download/head/delete and manifest get/head/put/delete obey wire protocol", async () => {
  const blobs = new Map<string, Buffer>(),
    manifests = new Map<string, Buffer>();
  const api = await fixture((req, res, body) => {
    assert.equal(req.headers.authorization, authorization);
    assert.equal(req.headers["accept-encoding"], "identity");
    const u = new URL(req.url!, `http://${req.headers.host}`);
    res.setHeader("docker-distribution-api-version", "registry/2.0");
    if (u.pathname === "/v2/") {
      assert.equal(req.method, "GET");
      json(res, {});
    } else if (u.pathname === "/v2/_catalog") {
      assert.equal(req.method, "GET");
      assert.equal(u.searchParams.get("n"), "10");
      json(res, { repositories: ["team/app", "outside/private"] });
    } else if (u.pathname === "/v2/team/app/tags/list") {
      assert.equal(req.method, "GET");
      json(res, { name: "team/app", tags: ["v1"] });
    } else if (u.pathname === "/v2/team/app/blobs/uploads/") {
      assert.equal(req.method, "POST");
      assert.equal(body.length, 0);
      res.statusCode = 202;
      res.setHeader(
        "location",
        "/v2/team/app/blobs/uploads/fixture-uuid?_state=opaque-state",
      );
      res.end();
    } else if (u.pathname === "/v2/team/app/blobs/uploads/fixture-uuid") {
      assert.equal(req.method, "PUT");
      assert.equal(u.searchParams.get("_state"), "opaque-state");
      assert.equal(req.headers["content-type"], "application/octet-stream");
      const id = digest(body);
      assert.equal(u.searchParams.get("digest"), id);
      blobs.set(id, body);
      res.statusCode = 201;
      res.setHeader("docker-content-digest", id);
      res.end();
    } else if (u.pathname.startsWith("/v2/team/app/blobs/")) {
      const id = u.pathname.slice("/v2/team/app/blobs/".length);
      assert.ok(blobs.has(id));
      res.setHeader("docker-content-digest", id);
      if (req.method === "DELETE") {
        blobs.delete(id);
        res.statusCode = 202;
        res.end();
      } else {
        assert.ok(["GET", "HEAD"].includes(req.method!));
        res.setHeader("content-length", blobs.get(id)!.length);
        res.end(req.method === "HEAD" ? undefined : blobs.get(id));
      }
    } else if (u.pathname.startsWith("/v2/team/app/manifests/")) {
      assert.ok(req.headers.accept?.includes(manifestType));
      const ref = u.pathname.slice("/v2/team/app/manifests/".length);
      if (req.method === "PUT") {
        assert.equal(req.headers["content-type"], manifestType);
        const data = JSON.parse(body.toString()) as {
          config: { digest: string };
        };
        assert.ok(blobs.has(data.config.digest));
        manifests.set(ref, body);
        manifests.set(digest(body), body);
        res.statusCode = 201;
        res.setHeader("docker-content-digest", digest(body));
        res.end();
      } else {
        const bytes = manifests.get(ref);
        assert.ok(bytes);
        res.setHeader("docker-content-digest", digest(bytes));
        res.setHeader("content-type", manifestType);
        if (req.method === "DELETE") {
          for (const [k, v] of manifests)
            if (v.equals(bytes)) manifests.delete(k);
          res.statusCode = 202;
          res.end();
        } else {
          assert.ok(["GET", "HEAD"].includes(req.method!));
          res.setHeader("content-length", bytes.length);
          res.end(req.method === "HEAD" ? undefined : bytes);
        }
      }
    } else assert.fail("unexpected Registry V2 wire path");
  });
  const ctx = context(api.endpoint);
  try {
    registryAdapter.validate(ctx.connection, ctx.secret);
    assert.equal((await registryAdapter.run(ctx, op(["ping"]))).exitCode, 0);
    const catalog = await registryAdapter.run(
      ctx,
      op(["catalog", "--n", "10"]),
    );
    assert.deepEqual(
      (catalog.data as { repositories: string[] }).repositories,
      ["team/app"],
    );
    assert.match(
      (await registryAdapter.run(ctx, op(["tags", "team/app"]))).stdout!,
      /v1/,
    );
    const blob = Buffer.from([0, 1, 2, 255, 13]),
      blobDigest = digest(blob);
    const put = await registryAdapter.run(
      ctx,
      op(["blob", "put", "team/app", "--body", "config.bin"], {
        files: [{ path: "config.bin", base64: blob.toString("base64") }],
      }),
    );
    assert.equal((put.data as { digest: string }).digest, blobDigest);
    const out = await registryAdapter.run(
      ctx,
      op(["blob", "get", "team/app", blobDigest, "out.bin"]),
    );
    assert.deepEqual(Buffer.from(out.files![0].base64, "base64"), blob);
    await registryAdapter.run(ctx, op(["blob-head", "team/app", blobDigest]));
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: manifestType,
        config: {
          mediaType: "application/vnd.docker.container.image.v1+json",
          size: blob.length,
          digest: blobDigest,
        },
        layers: [],
      }),
    );
    await registryAdapter.run(
      ctx,
      op(["manifest", "put", "team/app", "v1"], { input: manifest.toString() }),
    );
    const received = await registryAdapter.run(
      ctx,
      op(["manifest", "get", "team/app", "v1", "manifest.json"]),
    );
    assert.equal(
      digest(Buffer.from(received.files![0].base64, "base64")),
      digest(manifest),
    );
    await registryAdapter.run(
      ctx,
      op(["manifest", "head", "team/app", digest(manifest)]),
    );
    await registryAdapter.run(
      ctx,
      op(["manifest", "delete", "team/app", digest(manifest)]),
    );
    assert.equal(manifests.size, 0);
    await registryAdapter.run(
      ctx,
      op(["blob", "delete", "team/app", blobDigest]),
    );
    assert.equal(blobs.size, 0);
  } finally {
    await api.close();
  }
});

test("Registry uses existing Bearer without login/helpers or following arbitrary auth challenge realms", async () => {
  let realmCalls = 0;
  const realm = await fixture((_req, res) => {
    realmCalls++;
    res.end();
  });
  const api = await fixture((req, res) => {
    if (req.headers.authorization === `Bearer ${token}`) json(res, {});
    else {
      res.statusCode = 401;
      res.setHeader(
        "www-authenticate",
        `Bearer realm="${realm.endpoint}/token",service="fixture"`,
      );
      json(res, {
        errors: [
          {
            code: "UNAUTHORIZED",
            message: `${password} ${token} ${authorization}`,
          },
        ],
      });
    }
  });
  try {
    const bearer = context(api.endpoint, {}, true);
    assert.equal((await registryAdapter.run(bearer, op(["ping"]))).exitCode, 0);
    await assert.rejects(
      registryAdapter.run(context(api.endpoint), op(["ping"])),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, "REGISTRY_AUTH_REQUIRED");
        assert.ok(!e.message.includes(password));
        assert.ok(!e.message.includes(authorization));
        return true;
      },
    );
    assert.equal(realmCalls, 0);
  } finally {
    await api.close();
    await realm.close();
  }
});

test("Registry target/repository/auth/local-file/unknown parameter attacks fail before network", async () => {
  const api = await fixture(() =>
    assert.fail("unsafe Registry command reached server"),
  );
  const ctx = context(api.endpoint);
  try {
    for (const args of [
      ["login"],
      ["export-credentials"],
      ["ping", "--endpoint", "https://evil.example"],
      ["ping", "--password", "in-command"],
      ["tags", "outside/app"],
      ["tags", "team/../app"],
      ["manifest", "delete", "team/app", "latest"],
      ["blob", "get", "team/app", "sha256:bad"],
      ["blob", "put", "team/app", "--body", "file:///etc/passwd"],
      ["blob", "put", "team/app", "--body", "/etc/passwd"],
      ["catalog", "--n", "1", "--n", "2"],
    ])
      await assert.rejects(
        registryAdapter.run(ctx, op(args)),
        (e: unknown) => e instanceof AppError && e.status === 400,
      );
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("Registry never follows redirects or unsafe blob upload Locations", async () => {
  let leaks = 0;
  const sink = await fixture((_req, res) => {
    leaks++;
    res.end();
  });
  for (const location of [
    sink.endpoint + "/v2/team/app/blobs/uploads/uuid",
    "/admin/steal",
    "/v2/outside/app/blobs/uploads/uuid",
    `http://user:pass@127.0.0.1:1234/v2/team/app/blobs/uploads/uuid`,
  ]) {
    const api = await fixture((_req, res) => {
      res.statusCode = 202;
      res.setHeader("location", location);
      res.end();
    });
    try {
      await assert.rejects(
        registryAdapter.run(
          context(api.endpoint),
          op(["blob-put", "team/app"], { input: "business blob" }),
        ),
        (e: unknown) =>
          e instanceof AppError && e.code === "REGISTRY_UPLOAD_LOCATION",
      );
      assert.equal(api.requests.length, 1);
    } finally {
      await api.close();
    }
  }
  const redirect = await fixture((_req, res) => {
    res.statusCode = 307;
    res.setHeader("location", sink.endpoint);
    res.end();
  });
  try {
    await assert.rejects(
      registryAdapter.run(context(redirect.endpoint), op(["ping"])),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_REDIRECT",
    );
    assert.equal(leaks, 0);
  } finally {
    await redirect.close();
    await sink.close();
  }
});

test("Registry digest corruption, response limit, cancellation and errors fail safely", async () => {
  const wrongDigest = "sha256:" + "0".repeat(64);
  const api = await fixture((_req, res) => {
    res.setHeader("docker-content-digest", wrongDigest);
    res.end(Buffer.alloc(100, "a"));
  });
  try {
    await assert.rejects(
      registryAdapter.run(
        context(api.endpoint),
        op(["blob-get", "team/app", wrongDigest]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_DIGEST",
    );
    await assert.rejects(
      registryAdapter.run(
        context(api.endpoint, { maxBytes: 5 }),
        op(["blob-get", "team/app", wrongDigest]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_LIMIT",
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      registryAdapter.run(
        { ...context(api.endpoint), signal: abort.signal },
        op(["ping"]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_CANCELLED",
    );
  } finally {
    await api.close();
  }
  const errorApi = await fixture((_req, res) => {
    res.statusCode = 404;
    json(res, {
      errors: [
        { code: "MANIFEST_UNKNOWN", message: `${password} ${authorization}` },
      ],
    });
  });
  try {
    await assert.rejects(
      registryAdapter.run(
        context(errorApi.endpoint),
        op(["manifest-get", "team/app", "latest"]),
      ),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, "REGISTRY_MANIFEST_UNKNOWN");
        assert.equal(e.message, "Registry HTTP 404");
        return true;
      },
    );
  } finally {
    await errorApi.close();
  }
});

test("Registry filters saved credentials in binary output while preserving unrelated bytes", async () => {
  const raw = Buffer.concat([
      Buffer.from([0, 255]),
      Buffer.from(`${username} ${password} ${authorization}`),
    ]),
    id = digest(raw);
  const api = await fixture((_req, res) => {
    res.setHeader("docker-content-digest", id);
    res.end(raw);
  });
  try {
    const result = await registryAdapter.run(
      context(api.endpoint),
      op(["blob-get", "team/app", id]),
    );
    const bytes = Buffer.from(result.files![0].base64, "base64");
    assert.equal(bytes[0], 0);
    assert.equal(bytes[1], 255);
    for (const value of [username, password, authorization])
      assert.ok(!bytes.includes(Buffer.from(value)));
    assert.match(bytes.toString(), /REDACTED/);
  } finally {
    await api.close();
  }
});

test("Registry HTTPS still verifies normal certificates", async () => {
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
    await assert.rejects(
      registryAdapter.run(
        context(`https://127.0.0.1:${(server.address() as AddressInfo).port}`),
        op(["ping"]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_TRANSPORT",
    );
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Registry cancels an in-flight authenticated HTTP request", async () => {
  const controller = new AbortController();
  const api = await fixture((req) => {
    assert.equal(req.headers.authorization, authorization);
    controller.abort();
  });
  try {
    await assert.rejects(
      registryAdapter.run(
        { ...context(api.endpoint), signal: controller.signal },
        op(["ping"]),
      ),
      (e: unknown) => e instanceof AppError && e.code === "REGISTRY_CANCELLED",
    );
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});
