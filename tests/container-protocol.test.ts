import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import type {
  Adapter,
  AdapterContext,
  Credentials,
  Operation,
} from "../src/connections.js";
import {
  dockerAdapter,
  kubernetesAdapter,
} from "../src/protocols/containers.js";
import { runProtocolOperation } from "../src/operation-runner.js";
import { AppError } from "../src/schema.js";

type Recorded = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};
function operation(args: string[], input?: unknown): Operation {
  return {
    args,
    timeoutMs: 2000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  };
}
function context(
  kind: "docker" | "kubernetes",
  endpoint: string,
  secret: Credentials = {},
  config: Record<string, unknown> = {},
  signal = new AbortController().signal,
): AdapterContext {
  return {
    connection: {
      alias: "TEST",
      name: "fixture",
      kind,
      trustBoundary: "development-fixture",
      enabled: true,
      description: "",
      config: {
        endpoint,
        auth: kind === "docker" ? "none" : "bearer",
        ...config,
      },
    },
    secret,
    signal,
    allowLocal: true,
    dataDir: "/tmp/abilock-container-test",
  };
}
async function fixture(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const recorded: Recorded[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    recorded.push({
      method: req.method!,
      path: req.url!,
      headers: req.headers,
      body: body ? JSON.parse(body) : undefined,
    });
    if (handler) return handler(req, res);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.startsWith("/api/v1/namespaces/") &&
          req.url?.split("?")[0].endsWith("/pods") &&
          req.method === "GET"
          ? {
              apiVersion: "v1",
              kind: "PodList",
              metadata: { resourceVersion: "1" },
              items: [],
            }
          : { ok: true },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    recorded,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function frame(value: string, stream = 1) {
  const body = Buffer.from(value),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("Docker batches retain completed results when a later request disconnects or times out", async () => {
  for (const mode of ["disconnect", "timeout"] as const) {
    const f = await fixture((req, res) => {
      if (req.url?.includes("/one/")) {
        res.writeHead(204).end();
      } else if (req.url?.includes("/two/") && mode === "disconnect") {
        req.socket.destroy();
      }
      // Timeout deliberately leaves the second owned loopback response open.
    });
    try {
      const result = await runProtocolOperation(
        dockerAdapter,
        context("docker", f.url),
        { ...operation(["stop", "one", "two", "three"]), timeoutMs: 150 },
      );
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.data, [{ status: 204 }]);
      assert.equal(result.batch?.status, "failed");
      assert.deepEqual(
        result.batch?.items.map(({ index, target, status }) => ({
          index,
          target,
          status,
        })),
        [
          { index: 0, target: "one", status: "completed" },
          { index: 1, target: "two", status: "unknown" },
          { index: 2, target: "three", status: "not-started" },
        ],
      );
      assert.equal(
        result.batch?.items[1].error?.code,
        mode === "timeout" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE",
      );
      assert.match(result.stderr ?? "", /不要重试整批/);
      assert.deepEqual(
        f.recorded.map((row) => row.path),
        ["/v1.47/containers/one/stop", "/v1.47/containers/two/stop"],
      );
    } finally {
      await f.close();
    }
  }
});

test("normal batch failures retain their result array and single-item success keeps its existing shape", async () => {
  const f = await fixture((req, res) => {
    if (req.url?.includes("/two/")) {
      res
        .writeHead(409, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: "synthetic conflict" }));
    } else res.writeHead(204).end();
  });
  try {
    const ctx = context("docker", f.url);
    const result = await dockerAdapter.run(
      ctx,
      operation(["stop", "one", "two", "three"]),
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.data, [
      { status: 204 },
      { message: "synthetic conflict" },
    ]);
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["completed", "failed", "not-started"],
    );
    assert.equal(f.recorded.length, 2);
    const firstFailure = await dockerAdapter.run(
      ctx,
      operation(["stop", "two", "three"]),
    );
    assert.deepEqual(firstFailure.data, { message: "synthetic conflict" });
    assert.deepEqual(
      firstFailure.batch?.items.map((item) => item.status),
      ["failed", "not-started"],
    );
    const single = await dockerAdapter.run(ctx, operation(["stop", "one"]));
    assert.deepEqual(single, {
      exitCode: 0,
      stdout: "null",
      data: { status: 204 },
    });
    const successful = await dockerAdapter.run(
      ctx,
      operation(["stop", "one", "three"]),
    );
    assert.equal(successful.exitCode, 0);
    assert.equal(successful.batch?.status, "completed");
    assert.deepEqual(successful.data, [{ status: 204 }, { status: 204 }]);
  } finally {
    await f.close();
  }
});

test("batch errors before network are failed and never expose raw errors or credential-shaped target names", async (t) => {
  const privateValue = "synthetic-private-batch-value";
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => {
    lookups++;
    throw new Error(privateValue);
  });
  const result = await dockerAdapter.run(
    context(
      "docker",
      "https://batch.example.test",
      { username: "synthetic-user", password: privateValue },
      { auth: "basic" },
    ),
    operation(["stop", privateValue, "two", "three"]),
  );
  assert.equal(lookups, 1);
  assert.deepEqual(
    result.batch?.items.map((item) => item.status),
    ["failed", "not-started", "not-started"],
  );
  assert.equal(result.batch?.items[0].target, "[REDACTED]");
  assert.equal(result.batch?.items[0].error?.code, "UPSTREAM_FAILURE");
  assert.deepEqual(result.data, []);
  assert.ok(!JSON.stringify(result).includes(privateValue));
});

test("outer protocol timeout preserves the partial ledger and timeout error code", async () => {
  const controller = new AbortController();
  const f = await fixture((req, res) => {
    if (req.url?.includes("/one/")) res.writeHead(204).end();
    else
      controller.abort(
        new AppError(
          504,
          "UPSTREAM_TIMEOUT",
          "synthetic untrusted timeout detail",
        ),
      );
  });
  try {
    const result = await runProtocolOperation(
      dockerAdapter,
      context("docker", f.url, {}, {}, controller.signal),
      operation(["stop", "one", "two", "three"]),
    );
    assert.equal(result.batch?.status, "cancelled");
    assert.equal(result.batch?.items[1].error?.code, "UPSTREAM_TIMEOUT");
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["completed", "unknown", "not-started"],
    );
    assert.ok(!JSON.stringify(result).includes("synthetic untrusted"));
    assert.equal(f.recorded.length, 2);
  } finally {
    await f.close();
  }
});

test("cancelled Kubernetes apply keeps the first result, uncertain second target and unstarted third target", async () => {
  const controller = new AbortController();
  const privateValue = "synthetic-batch-token-must-not-leak";
  const events: string[] = [];
  const f = await fixture((req, res) => {
    if (req.url?.split("?")[0].endsWith("/one")) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ kind: "ConfigMap", metadata: { name: "one" } }));
    } else controller.abort(new Error(privateValue));
  });
  try {
    const manifests = ["one", "two", "three"].map((name) => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name },
      data: { text: "synthetic public content" },
    }));
    const result = await runProtocolOperation(
      kubernetesAdapter,
      context(
        "kubernetes",
        f.url,
        { token: privateValue },
        {},
        controller.signal,
      ),
      operation(["apply", "-f", "-"], manifests),
      undefined,
      (event) => {
        events.push(event.event);
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.batch?.status, "cancelled");
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["completed", "unknown", "not-started"],
    );
    assert.equal(result.batch?.items[1].error?.code, "CANCELLED");
    assert.deepEqual(
      result.batch?.items.map((item) => item.target),
      [
        "/api/v1/namespaces/default/configmaps/one",
        "/api/v1/namespaces/default/configmaps/two",
        "/api/v1/namespaces/default/configmaps/three",
      ],
    );
    assert.deepEqual(result.data, [
      { kind: "ConfigMap", metadata: { name: "one" } },
    ]);
    assert.deepEqual(events, ["start", "cancelled"]);
    assert.ok(!JSON.stringify(result).includes(privateValue));
    assert.equal(f.recorded.length, 2);
  } finally {
    await f.close();
  }
});

test("Docker exact Engine paths, filter encoding, lifecycle, create and framed logs", async () => {
  const f = await fixture((req, res) => {
    if (req.url!.includes("/already/")) {
      res.statusCode = 304;
      res.end();
      return;
    }
    if (req.url!.includes("/logs")) {
      res.setHeader("content-type", "application/vnd.docker.raw-stream");
      res.end(Buffer.concat([frame("hello\n"), frame("warning\n", 2)]));
    } else if (req.url!.startsWith("/v1.47/containers/json"))
      res.end(JSON.stringify([{ Id: "container-a" }]));
    else {
      res.statusCode = req.method === "POST" ? 201 : 200;
      res.end(JSON.stringify({ ok: true }));
    }
  });
  try {
    const ctx = context("docker", f.url);
    const ps = await dockerAdapter.run(
      ctx,
      operation(["ps", "-a", "-q", "--filter", "label=team=test"]),
    );
    assert.equal(ps.stdout, "container-a\n");
    const first = new URL(f.recorded[0].path, "http://fixture");
    assert.equal(first.pathname, "/v1.47/containers/json");
    assert.equal(first.searchParams.get("all"), "1");
    assert.deepEqual(JSON.parse(first.searchParams.get("filters")!), {
      label: ["team=test"],
    });
    await dockerAdapter.run(ctx, operation(["images"]));
    assert.equal(f.recorded[1].path, "/v1.47/images/json");
    await dockerAdapter.run(
      ctx,
      operation(["inspect", "--type=image", "repo/image:tag"]),
    );
    assert.equal(f.recorded[2].path, "/v1.47/images/repo%2Fimage%3Atag/json");
    for (const cmd of ["start", "stop", "restart", "rm"])
      await dockerAdapter.run(
        ctx,
        operation(
          cmd === "stop"
            ? [cmd, "--time=3", "one"]
            : cmd === "rm"
              ? [cmd, "--force", "one"]
              : [cmd, "one"],
        ),
      );
    assert.deepEqual(
      f.recorded.slice(3, 7).map((row) => [row.method, row.path]),
      [
        ["POST", "/v1.47/containers/one/start"],
        ["POST", "/v1.47/containers/one/stop?t=3"],
        ["POST", "/v1.47/containers/one/restart"],
        ["DELETE", "/v1.47/containers/one?force=true"],
      ],
    );
    const manifest = {
      Image: "alpine:3",
      Cmd: ["echo", "hello"],
      HostConfig: { ReadonlyRootfs: true },
    };
    await dockerAdapter.run(
      ctx,
      operation(["create", "--name", "one"], manifest),
    );
    assert.deepEqual(f.recorded[7].body, manifest);
    assert.equal(f.recorded[7].path, "/v1.47/containers/create?name=one");
    const logs = await dockerAdapter.run(
      ctx,
      operation(["logs", "--tail=20", "--since=2m", "one"]),
    );
    assert.equal(logs.stdout, "hello\nwarning\n");
    assert.equal(
      new URL(f.recorded[8].path, "http://fixture").searchParams.get("tail"),
      "20",
    );
    assert.ok(
      Math.abs(
        Number(
          new URL(f.recorded[8].path, "http://fixture").searchParams.get(
            "since",
          ),
        ) -
          (Date.now() / 1000 - 120),
      ) < 5,
    );
    for (const command of ["start", "stop"])
      assert.equal(
        (await dockerAdapter.run(ctx, operation([command, "already"])))
          .exitCode,
        0,
      );
  } finally {
    await f.close();
  }
});

test("Kubernetes exact list/create/server-side apply/patch/delete/logs/scale/restart HTTP semantics", async () => {
  const f = await fixture();
  const ctx = context(
    "kubernetes",
    f.url,
    { token: "synthetic-kube-token" },
    { namespace: "team", namespaces: ["team"] },
  );
  try {
    await kubernetesAdapter.run(
      ctx,
      operation([
        "get",
        "pods",
        "-n",
        "team",
        "-l",
        "app=web",
        "--chunk-size=50",
        "-o",
        "json",
      ]),
    );
    const get = new URL(f.recorded[0].path, "http://fixture");
    assert.equal(get.pathname, "/api/v1/namespaces/team/pods");
    assert.equal(get.searchParams.get("labelSelector"), "app=web");
    assert.equal(get.searchParams.get("limit"), "50");
    assert.equal(
      f.recorded[0].headers.authorization,
      "Bearer synthetic-kube-token",
    );
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web" },
      spec: { replicas: 1 },
    };
    await kubernetesAdapter.run(
      ctx,
      operation(["create", "-f", "-"], deployment),
    );
    assert.equal(f.recorded[1].method, "POST");
    assert.equal(
      new URL(f.recorded[1].path, "http://fixture").pathname,
      "/apis/apps/v1/namespaces/team/deployments",
    );
    assert.deepEqual(f.recorded[1].body, {
      ...deployment,
      metadata: { name: "web", namespace: "team" },
    });
    await kubernetesAdapter.run(
      ctx,
      operation(
        [
          "apply",
          "-f",
          "-",
          "--server-side",
          "--force-conflicts",
          "--dry-run=server",
        ],
        deployment,
      ),
    );
    const apply = new URL(f.recorded[2].path, "http://fixture");
    assert.equal(f.recorded[2].method, "PATCH");
    assert.equal(
      f.recorded[2].headers["content-type"],
      "application/apply-patch+yaml",
    );
    assert.equal(
      apply.pathname,
      "/apis/apps/v1/namespaces/team/deployments/web",
    );
    assert.equal(apply.searchParams.get("fieldManager"), "abilock");
    assert.equal(apply.searchParams.get("force"), "true");
    assert.equal(apply.searchParams.get("dryRun"), "All");
    await kubernetesAdapter.run(
      ctx,
      operation(["patch", "deployment/web", "--type=merge"], {
        spec: { replicas: 2 },
      }),
    );
    assert.equal(
      f.recorded[3].headers["content-type"],
      "application/merge-patch+json",
    );
    await kubernetesAdapter.run(
      ctx,
      operation(["delete", "pod/web", "--grace-period=0", "--cascade=orphan"]),
    );
    assert.equal(f.recorded[4].method, "DELETE");
    assert.deepEqual(f.recorded[4].body, {
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Orphan",
      gracePeriodSeconds: 0,
    });
    await kubernetesAdapter.run(
      ctx,
      operation([
        "logs",
        "pod/web",
        "-c",
        "main",
        "--tail=10",
        "--since=2m",
        "--previous",
      ]),
    );
    const log = new URL(f.recorded[5].path, "http://fixture");
    assert.equal(log.pathname, "/api/v1/namespaces/team/pods/web/log");
    assert.equal(log.searchParams.get("sinceSeconds"), "120");
    assert.equal(log.searchParams.get("container"), "main");
    assert.equal(log.searchParams.get("previous"), "true");
    await kubernetesAdapter.run(
      ctx,
      operation(["scale", "deployment/web", "--replicas=0"]),
    );
    assert.equal(
      f.recorded[6].path,
      "/apis/apps/v1/namespaces/team/deployments/web/scale",
    );
    assert.deepEqual(f.recorded[6].body, { spec: { replicas: 0 } });
    await kubernetesAdapter.run(
      ctx,
      operation(["rollout", "restart", "deployment/web"]),
    );
    assert.equal(
      f.recorded[7].headers["content-type"],
      "application/strategic-merge-patch+json",
    );
  } finally {
    await f.close();
  }
});

test("container adapters reject credentials/targets/plugins/path and namespace/resource identity overrides before network", async () => {
  const f = await fixture();
  const docker = context("docker", f.url);
  const kube = context(
    "kubernetes",
    f.url,
    { token: "fake" },
    { namespace: "team", resources: ["pods", "deployments"] },
  );
  try {
    for (const args of [
      ["ps", "--host", "https://evil.invalid"],
      ["ps", "--config", "/tmp/creds"],
      ["login"],
      ["inspect", "../../state"],
      ["ps", "--tlsverify=false"],
      ["ps", "--password", "secret"],
    ])
      await assert.rejects(dockerAdapter.run(docker, operation(args)));
    for (const args of [
      ["get", "pods", "--server", "https://evil.invalid"],
      ["get", "pods", "--token", "secret"],
      ["get", "pods", "--kubeconfig", "/tmp/creds"],
      ["config", "view", "--raw"],
      ["exec", "pod/web", "--", "env"],
      ["get", "https://evil.invalid"],
      ["get", "secrets"],
      ["get", "pods", "-n", "other"],
    ])
      await assert.rejects(kubernetesAdapter.run(kube, operation(args)));
    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web", namespace: "other" },
      spec: { containers: [] },
    };
    await assert.rejects(
      kubernetesAdapter.run(kube, operation(["apply", "-f", "-"], manifest)),
    );
    await assert.rejects(
      kubernetesAdapter.run(
        kube,
        operation(["patch", "pod/web", "--type=merge"], {
          metadata: { namespace: "other" },
        }),
      ),
    );
    await assert.rejects(
      kubernetesAdapter.run(
        kube,
        operation(
          ["patch", "pod/web", "--type=json"],
          [{ op: "replace", path: "/metadata", value: { name: "other" } }],
        ),
      ),
    );
    await assert.rejects(
      kubernetesAdapter.run(
        kube,
        operation(
          ["apply", "-f", "-"],
          [
            { apiVersion: "v1", kind: "Pod", metadata: { name: "safe" } },
            manifest,
          ],
        ),
      ),
    );
    assert.equal(f.recorded.length, 0);
    assert.throws(() =>
      dockerAdapter.validate({
        ...docker.connection,
        config: { endpoint: `${f.url}/api`, auth: "none" },
      }),
    );
    assert.throws(() =>
      kubernetesAdapter.validate({
        ...kube.connection,
        config: { ...kube.connection.config, exec: { command: "sh" } },
      }),
    );
    await assert.rejects(
      dockerAdapter.run({ ...docker, allowLocal: false }, operation(["ps"])),
    );
    const loopbackTarget = {
      ...docker,
      allowLocal: false,
      connection: {
        ...docker.connection,
        trustBoundary: "independent-target" as const,
        config: {
          endpoint: f.url.replace("http:", "https:"),
          auth: "none",
          trustedPrivate: true,
        },
      },
    };
    await assert.rejects(dockerAdapter.run(loopbackTarget, operation(["ps"])), {
      code: "CONTAINER_BROKER_TARGET",
    });
    await assert.rejects(
      dockerAdapter.run(
        {
          ...loopbackTarget,
          connection: {
            ...loopbackTarget.connection,
            config: {
              ...loopbackTarget.connection.config,
              endpoint: "https://127.0.0.2:2376",
            },
          },
        },
        operation(["ps"]),
      ),
      { code: "CONTAINER_BROKER_TARGET" },
    );
  } finally {
    await f.close();
  }
});

test("upstream error and secret encodings are filtered; redirects do not contact another target", async () => {
  let redirected = 0;
  const destination = await fixture((_req, res) => {
    redirected++;
    res.end("unexpected");
  });
  const password = "synthetic-container-password",
    username = "synthetic-user",
    token = "synthetic-token";
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const f = await fixture((req, res) => {
    if (req.url!.includes("/logs")) {
      res.statusCode = 401;
      res.end(
        JSON.stringify({
          error: [
            password,
            encodeURIComponent(password),
            basic,
            `Bearer ${token}`,
          ].join(" "),
        }),
      );
    } else {
      res.statusCode = 307;
      res.setHeader("location", destination.url);
      res.end("redirect");
    }
  });
  try {
    const ctx = context(
      "docker",
      f.url,
      { username, password },
      { auth: "basic" },
    );
    const error = await dockerAdapter.run(ctx, operation(["logs", "one"]));
    assert.equal(error.exitCode, 1);
    assert.ok(error.stderr!.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(error).includes(password));
    assert.ok(!JSON.stringify(error).includes(basic));
    const redirect = await dockerAdapter.run(ctx, operation(["ps"]));
    assert.equal(redirect.exitCode, 1);
    assert.equal(redirected, 0);
    const kube = context("kubernetes", f.url, { token });
    const kubeError = await kubernetesAdapter.run(
      kube,
      operation(["logs", "one"]),
    );
    assert.equal(kubeError.exitCode, 1);
    assert.ok(!JSON.stringify(kubeError).includes(token));
  } finally {
    await f.close();
    await destination.close();
  }
});

test("Docker Basic pairs and bare tokens are filtered in success, errors and logs", async () => {
  const username = "user",
    password = "synthetic-basic-password",
    pair = `${username}:${password}`,
    encoded = Buffer.from(pair).toString("base64"),
    basic = `Basic ${encoded}`,
    echoes = [pair, encoded, basic],
    message = "ordinary business result";
  // The pair is not Base64-aligned with either component; individual variants cannot hide this regression.
  assert.ok(!encoded.includes(Buffer.from(username).toString("base64")));
  assert.ok(!encoded.includes(Buffer.from(password).toString("base64")));
  const f = await fixture((req, res) => {
    if (req.url!.includes("/logs")) {
      res.setHeader("content-type", "application/vnd.docker.raw-stream");
      res.end(frame(`${message}\n${echoes.join("\n")}\n`));
    } else {
      if (req.url!.includes("/error/")) res.statusCode = 401;
      res.end(JSON.stringify({ message, echoes }));
    }
  });
  try {
    const ctx = context(
      "docker",
      f.url,
      { username, password },
      { auth: "basic" },
    );
    const success = await dockerAdapter.run(ctx, operation(["version"]));
    assert.equal(success.exitCode, 0);
    assert.deepEqual(success.data, {
      message,
      echoes: echoes.map(() => "[REDACTED]"),
    });
    const error = await dockerAdapter.run(ctx, operation(["inspect", "error"]));
    assert.equal(error.exitCode, 1);
    assert.deepEqual(JSON.parse(error.stderr!), success.data);
    const logs = await dockerAdapter.run(ctx, operation(["logs", "one"]));
    assert.equal(logs.exitCode, 0);
    assert.equal(
      logs.stdout,
      `${message}\n[REDACTED]\n[REDACTED]\n[REDACTED]\n`,
    );
    for (const response of [success, error, logs]) {
      const output = JSON.stringify(response);
      for (const echo of echoes) assert.ok(!output.includes(echo));
      assert.ok(output.includes(message));
    }
    assert.equal(f.recorded.length, 3);
    for (const request of f.recorded)
      assert.equal(request.headers.authorization, basic);
  } finally {
    await f.close();
  }
});

test("Docker production info projects only three strings and suppresses upstream failure bodies", async () => {
  let status = 200;
  const privateMarker = "synthetic-private-registry-configuration";
  const source = {
    ServerVersion: "29.5.3",
    OSType: "linux",
    Architecture: "aarch64",
    RegistryConfig: { IndexConfigs: { password: privateMarker } },
    HTTPProxy: "http://synthetic-user:synthetic-password@internal.example",
    Labels: [privateMarker],
    DriverStatus: [["secret", privateMarker]],
  };
  const f = await fixture((_req, res) => {
    res.statusCode = status;
    res.setHeader("location", "https://unrelated.example");
    res.end(JSON.stringify(source));
  });
  try {
    const ctx = context("docker", f.url);
    const info = await dockerAdapter.run(ctx, operation(["info"]));
    const expected = {
      ServerVersion: source.ServerVersion,
      OSType: source.OSType,
      Architecture: source.Architecture,
    };
    assert.deepEqual(info, {
      exitCode: 0,
      stdout: JSON.stringify(expected, null, 2),
      data: expected,
    });
    assert.ok(!JSON.stringify(info).includes(privateMarker));
    for (status of [302, 401, 500]) {
      assert.deepEqual(await dockerAdapter.run(ctx, operation(["info"])), {
        exitCode: 1,
        stderr: `远端返回 HTTP ${status}`,
        data: { status },
      });
    }
    status = 200;
    (source as Record<string, unknown>).Architecture = { privateMarker };
    await assert.rejects(dockerAdapter.run(ctx, operation(["info"])), {
      code: "DOCKER_INFO",
    });
  } finally {
    await f.close();
  }
});

test("Kubernetes combines every page, preserves selectors and opaque continue tokens, and repeats safely", async () => {
  const token = "opaque:/?&=% +\nhttps://unrelated.example";
  const f = await fixture((req, res) => {
    const query = new URL(req.url!, "http://fixture").searchParams;
    const first = !query.has("continue");
    if (!first) assert.equal(query.get("continue"), token);
    res.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "PodList",
        metadata: {
          resourceVersion: "version-42",
          continue: first ? token : "",
          remainingItemCount: first ? 1 : 0,
        },
        items: [{ metadata: { name: first ? "first" : "second" } }],
      }),
    );
  });
  try {
    const ctx = context("kubernetes", f.url, { token: "synthetic-token" });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await kubernetesAdapter.run(
        ctx,
        operation([
          "get",
          "pods",
          "--chunk-size=1",
          "-l",
          "app=web",
          "--field-selector=status.phase=Running",
        ]),
      );
      assert.equal(response.exitCode, 0);
      assert.deepEqual(response.data, {
        apiVersion: "v1",
        kind: "PodList",
        metadata: { resourceVersion: "version-42" },
        items: [
          { metadata: { name: "first" } },
          { metadata: { name: "second" } },
        ],
      });
    }
    assert.equal(f.recorded.length, 4);
    for (const [index, request] of f.recorded.entries()) {
      const url = new URL(request.path, "http://fixture");
      assert.equal(url.pathname, "/api/v1/namespaces/default/pods");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(url.searchParams.get("labelSelector"), "app=web");
      assert.equal(
        url.searchParams.get("fieldSelector"),
        "status.phase=Running",
      );
      assert.equal(url.searchParams.get("continue"), index % 2 ? token : null);
    }
  } finally {
    await f.close();
  }
});

test("Kubernetes rejects incomplete, inconsistent and looping pages without returning earlier items", async () => {
  let mode = "expired",
    pages = 0;
  const f = await fixture((_req, res) => {
    pages++;
    if (pages === 2 && mode === "expired") {
      res.statusCode = 410;
      res.end(JSON.stringify({ message: "continue expired" }));
      return;
    }
    if (pages === 2 && mode === "bad-json") {
      res.end("not-json");
      return;
    }
    res.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "PodList",
        metadata: {
          resourceVersion:
            mode === "version" && pages === 2 ? "changed" : "stable",
          continue:
            mode === "invalid-token"
              ? 1
              : mode === "loop"
                ? "same"
                : mode === "too-many"
                  ? `token-${pages}`
                  : pages === 1
                    ? "next"
                    : "",
        },
        items: [{ marker: "first-page-item-must-not-be-returned-on-failure" }],
      }),
    );
  });
  try {
    const ctx = context("kubernetes", f.url, { token: "synthetic-token" });
    const failed = await kubernetesAdapter.run(ctx, operation(["get", "pods"]));
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.stdout, undefined);
    assert.ok(!JSON.stringify(failed).includes("first-page-item"));
    for (const [nextMode, code, count] of [
      ["version", "KUBERNETES_LIST_VERSION", 2],
      ["loop", "KUBERNETES_LIST_CONTINUE", 2],
      ["invalid-token", "KUBERNETES_LIST", 1],
      ["bad-json", "KUBERNETES_LIST", 2],
      ["too-many", "KUBERNETES_LIST_PAGES", 100],
    ] as const) {
      mode = nextMode;
      pages = 0;
      await assert.rejects(
        kubernetesAdapter.run(ctx, operation(["get", "pods"])),
        { code },
      );
      assert.equal(pages, count);
    }
  } finally {
    await f.close();
  }
});

const multiTargetCases: {
  name: string;
  kind: "docker" | "kubernetes";
  adapter: Adapter;
  operation: (count: number) => Operation;
}[] = [
  {
    name: "Docker inspect",
    kind: "docker",
    adapter: dockerAdapter,
    operation: (count) =>
      operation(["inspect", ...["first", "second", "third"].slice(0, count)]),
  },
  ...(["create", "apply"] as const).map((command) => ({
    name: `Kubernetes ${command}`,
    kind: "kubernetes" as const,
    adapter: kubernetesAdapter,
    operation: (count: number) =>
      operation(
        [command, "-f", "-"],
        ["first", "second", "third"].slice(0, count).map((name) => ({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name },
          data: { business: "value" },
        })),
      ),
  })),
];
for (const item of multiTargetCases) {
  test(`${item.name} shares its 16 MiB budget across targets and resets it for a new run`, async () => {
    const payload = JSON.stringify({ payload: "x".repeat(9 * 1024 * 1024) });
    const f = await fixture((_req, res) => res.end(payload));
    try {
      const ctx = context(
        item.kind,
        f.url,
        item.kind === "kubernetes" ? { token: "synthetic-token" } : {},
      );
      const partial = await runProtocolOperation(
        item.adapter,
        ctx,
        item.operation(3),
      );
      assert.equal(partial.exitCode, 1);
      assert.deepEqual(
        partial.batch?.items.map((row) => row.status),
        ["completed", "unknown", "not-started"],
      );
      assert.equal(partial.batch?.items[1].error?.code, "TOO_LARGE");
      assert.equal((partial.data as unknown[]).length, 1);
      assert.equal(
        f.recorded.length,
        2,
        "no third target after the size limit",
      );
      const next = await runProtocolOperation(
        item.adapter,
        ctx,
        item.operation(1),
      );
      assert.equal(next.exitCode, 0, "the next run has an independent budget");
      assert.equal(f.recorded.length, 3);
    } finally {
      f.server.closeAllConnections();
      await f.close();
    }
  });

  test(`${item.name} shares one deadline across targets in a direct worker call`, async () => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const f = await fixture((_req, res) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.end("{}");
      }, 180);
      timers.add(timer);
      res.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
    try {
      const ctx = context(
        item.kind,
        f.url,
        item.kind === "kubernetes" ? { token: "synthetic-token" } : {},
      );
      const partial = await runProtocolOperation(item.adapter, ctx, {
        ...item.operation(3),
        timeoutMs: 300,
      });
      assert.equal(partial.exitCode, 1);
      assert.deepEqual(
        partial.batch?.items.map((row) => row.status),
        ["completed", "unknown", "not-started"],
      );
      assert.equal(partial.batch?.items[1].error?.code, "UPSTREAM_TIMEOUT");
      assert.deepEqual(partial.data, [{}]);
      assert.equal(
        f.recorded.length,
        2,
        "the second target uses remaining time",
      );
    } finally {
      for (const timer of timers) clearTimeout(timer);
      f.server.closeAllConnections();
      await f.close();
    }
  });
}

test("Kubernetes enforces a cumulative 16 MiB across separately bounded pages", async () => {
  let pages = 0;
  const f = await fixture((_req, res) => {
    pages++;
    res.end(
      JSON.stringify({
        apiVersion: "v1",
        kind: "PodList",
        metadata: {
          resourceVersion: "stable",
          continue: pages === 1 ? "next" : "",
        },
        items: [{ payload: "x".repeat(9 * 1024 * 1024) }],
      }),
    );
  });
  try {
    await assert.rejects(
      kubernetesAdapter.run(
        context("kubernetes", f.url, { token: "synthetic-token" }),
        operation(["get", "pods"]),
      ),
      { code: "TOO_LARGE" },
    );
    assert.equal(pages, 2);
  } finally {
    f.server.closeAllConnections();
    await f.close();
  }
});

test("Kubernetes pagination shares one deadline and cancellation applies during later pages", async () => {
  let pages = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const f = await fixture((_req, res) => {
    const number = ++pages;
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "PodList",
          metadata: {
            resourceVersion: "stable",
            continue: number === 1 ? "next" : "",
          },
          items: [{ name: String(number) }],
        }),
      );
    }, 80);
    timers.add(timer);
  });
  try {
    const ctx = context("kubernetes", f.url, { token: "synthetic-token" });
    await assert.rejects(
      kubernetesAdapter.run(ctx, { args: ["get", "pods"], timeoutMs: 130 }),
      { code: "UPSTREAM_TIMEOUT" },
    );
    assert.equal(pages, 2);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    pages = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 115);
    try {
      await assert.rejects(
        kubernetesAdapter.run(
          { ...ctx, signal: controller.signal },
          operation(["get", "pods"]),
        ),
        { code: "CANCELLED" },
      );
      assert.equal(pages, 2);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    f.server.closeAllConnections();
    await f.close();
  }
});

test("container deadlines and cancellation cover a pending DNS lookup", async () => {
  const original = dns.lookup;
  let lookups = 0;
  dns.lookup = (() => {
    lookups++;
    return new Promise(() => {});
  }) as typeof dns.lookup;
  try {
    const ctx = context("kubernetes", "http://localhost:1", {
      token: "synthetic-token",
    });
    await assert.rejects(
      kubernetesAdapter.run(ctx, { args: ["get", "pods"], timeoutMs: 25 }),
      { code: "UPSTREAM_TIMEOUT" },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await assert.rejects(
        kubernetesAdapter.run(
          { ...ctx, signal: controller.signal },
          operation(["get", "pods"]),
        ),
        { code: "CANCELLED" },
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(lookups, 2);
  } finally {
    dns.lookup = original;
  }
});

test("bounded follow responses cancel and timeout without hanging", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("one line\n");
  });
  try {
    const controller = new AbortController();
    const ctx = context("docker", f.url, {}, {}, controller.signal);
    const pending = dockerAdapter.run(
      ctx,
      operation(["logs", "--follow", "one"]),
    );
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await assert.rejects(pending);
    } finally {
      clearTimeout(timer);
    }
    await assert.rejects(
      kubernetesAdapter.run(context("kubernetes", f.url, { token: "fake" }), {
        args: ["logs", "--follow", "one"],
        timeoutMs: 30,
      }),
    );
  } finally {
    f.server.closeAllConnections();
    await f.close();
  }
});

async function certificates() {
  const dir = await mkdtemp(join(tmpdir(), "abilock-tls-fixture-"));
  const config = join(dir, "openssl.cnf");
  const configure = (cn: string, ca = false) =>
    writeFile(
      config,
      `[req]\ndistinguished_name=dn\nprompt=no\n${ca ? "x509_extensions=v3_ca\n" : ""}[dn]\nCN=${cn}\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`,
    );
  await configure("Abilock Synthetic CA", true);
  const run = (args: string[]) =>
    execFileSync("/usr/bin/openssl", args, {
      cwd: dir,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: config },
    });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
  ]);
  for (const name of ["server", "client", "wrongserver"]) {
    await configure(
      name === "server"
        ? "localhost"
        : name === "wrongserver"
          ? "wrong.invalid"
          : "synthetic-client",
    );
    run([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
    ]);
    await writeFile(
      join(dir, `${name}.ext`),
      name === "client"
        ? "extendedKeyUsage=clientAuth\n"
        : name === "server"
          ? "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
          : "subjectAltName=DNS:wrong.invalid\nextendedKeyUsage=serverAuth\n",
    );
    run([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
    ]);
  }
  const read = (name: string) => readFile(join(dir, name), "utf8");
  return {
    dir,
    ca: await read("ca.pem"),
    serverCert: await read("server.pem"),
    serverKey: await read("server.key"),
    cert: await read("client.pem"),
    key: await read("client.key"),
    wrongCert: await read("wrongserver.pem"),
    wrongKey: await read("wrongserver.key"),
  };
}
test("real TLS handshakes validate server CA/hostname and client mTLS certificate for both protocols", async () => {
  const tls = await certificates();
  assert.notEqual(
    new X509Certificate(tls.serverCert).subject,
    new X509Certificate(tls.serverCert).issuer,
  );
  let authorized = 0;
  const server = https.createServer(
    {
      key: tls.serverKey,
      cert: tls.serverCert,
      ca: tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      assert.ok((req.socket as import("node:tls").TLSSocket).authorized);
      authorized++;
      res.end(
        JSON.stringify(
          req.url?.startsWith("/api/")
            ? {
                apiVersion: "v1",
                kind: "PodList",
                metadata: { resourceVersion: "1" },
                items: [],
              }
            : { ok: true },
        ),
      );
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const secret = { ca: tls.ca, cert: tls.cert, key: tls.key };
    assert.equal(
      (
        await dockerAdapter.run(
          context("docker", url, secret, { auth: "mtls" }),
          operation(["ps"]),
        )
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await kubernetesAdapter.run(
          context("kubernetes", url, secret, { auth: "mtls" }),
          operation(["get", "pods"]),
        )
      ).exitCode,
      0,
    );
    await assert.rejects(
      dockerAdapter.run(
        context(
          "docker",
          url,
          { cert: tls.cert, key: tls.key },
          { auth: "mtls" },
        ),
        operation(["ps"]),
      ),
    );
    await assert.rejects(
      kubernetesAdapter.run(
        context(
          "kubernetes",
          url,
          { ca: tls.ca, token: "synthetic" },
          { auth: "bearer" },
        ),
        operation(["get", "pods"]),
      ),
    );
    assert.equal(authorized, 2);
    const wrong = https.createServer(
      { key: tls.wrongKey, cert: tls.wrongCert },
      (_req, res) => res.end("unreachable"),
    );
    wrong.listen(0, "127.0.0.1");
    await once(wrong, "listening");
    try {
      await assert.rejects(
        dockerAdapter.run(
          context(
            "docker",
            `https://127.0.0.1:${(wrong.address() as AddressInfo).port}`,
            secret,
            { auth: "mtls" },
          ),
          operation(["ps"]),
        ),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      );
    } finally {
      wrong.closeAllConnections();
      await new Promise<void>((resolve) => wrong.close(() => resolve()));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tls.dir, { recursive: true, force: true });
  }
});
