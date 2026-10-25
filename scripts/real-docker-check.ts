import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import type { AdapterResult, Operation } from "../src/connections.js";

// Run only after explicit authorization for temporary local Docker integration.
// No Docker socket, daemon key or mTLS credential reaches the product CLI.
const ownedPath = path.resolve("artifacts/docker-test-owned.json");
const reportPath = path.resolve("artifacts/real-docker-validation.json");
const socketPath = "/var/run/docker.sock";
const runId = `abilock-engine-${crypto.randomUUID()}`;
const label = "io.abilock.test";
const containerName = `abl-engine-${crypto.randomBytes(8).toString("hex")}`;
const startedAt = new Date().toISOString();
const checks: { name: string; ok: boolean; evidence?: unknown }[] = [];
const created = new Set<string>();
const removed = new Set<string>();
const requests: { method: string; path: string; status?: number }[] = [];
let temporary: string | undefined, store: Store | undefined;
let service: Awaited<ReturnType<typeof startServers>> | undefined;
let forwarder: https.Server | undefined;
let lastCheck = "initialization";
let failure: string | undefined;
let previousRunId: string | undefined;
const cleanups: {
  id: string;
  stopStatus?: number;
  removeStatus?: number;
  verifiedAbsent: boolean;
  error?: string;
}[] = [];
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
type Wire = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function dockerSocket(
  method: string,
  uri: string,
  body?: Buffer,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: uri,
        method,
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": String(body.length),
            }
          : {},
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) res.destroy(new Error("RESPONSE_LIMIT"));
          else chunks.push(chunk);
        });
        res.once("error", reject);
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.once("timeout", () => req.destroy(new Error("DOCKER_SOCKET_TIMEOUT")));
    req.once("error", reject);
    req.end(body);
  });
}
async function belongs(id: string) {
  if (!created.has(id) || !/^[a-f0-9]{64}$/.test(id)) return false;
  const response = await dockerSocket("GET", `/v1.47/containers/${id}/json`);
  if (response.status !== 200) return false;
  const parsed = JSON.parse(response.body.toString()) as {
    Id: string;
    Config: { Labels?: Record<string, string> };
  };
  return parsed.Id === id && parsed.Config.Labels?.[label] === runId;
}
async function updateOwned(status: string) {
  const stat = await fs.lstat(ownedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("OWNED_METADATA_REQUIRED");
  const current = JSON.parse(await fs.readFile(ownedPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    typeof current.runId !== "string" ||
    !current.runId.startsWith("abilock-test-")
  )
    throw new Error("OWNED_TEST_SESSION_REQUIRED");
  previousRunId = current.runId;
  const old =
    typeof current.engineChecks === "object" && current.engineChecks
      ? (current.engineChecks as Record<string, unknown>)
      : {};
  current.engineChecks = {
    ...old,
    [runId]: {
      runId,
      status,
      parentRunId: previousRunId,
      containerName,
      created: [...created],
      removed: [...removed],
      cleanup: cleanups,
      updatedAt: new Date().toISOString(),
    },
  };
  const filename = `${ownedPath}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  await fs.writeFile(filename, JSON.stringify(current, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(filename, ownedPath);
}
async function certificates(directory: string) {
  const configuration = path.join(directory, "openssl.cnf");
  const configure = (name: string, ca = false) =>
    fs.writeFile(
      configuration,
      `[req]\ndistinguished_name=dn\nprompt=no\n${ca ? "x509_extensions=v3_ca\n" : ""}[dn]\nCN=${name}\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`,
      { mode: 0o600 },
    );
  const run = (args: string[]) =>
    execFileSync("/usr/bin/openssl", args, {
      cwd: directory,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: configuration },
    });
  await configure("Abilock temporary Engine CA", true);
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
  for (const name of ["server", "client"]) {
    await configure(
      name === "server" ? "localhost" : "synthetic-engine-client",
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
    await fs.writeFile(
      path.join(directory, `${name}.ext`),
      name === "server"
        ? "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        : "extendedKeyUsage=clientAuth\n",
      { mode: 0o600 },
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
  const read = (name: string) =>
    fs.readFile(path.join(directory, name), "utf8");
  return {
    ca: await read("ca.pem"),
    cert: await read("client.pem"),
    key: await read("client.key"),
    serverCert: await read("server.pem"),
    serverKey: await read("server.key"),
  };
}
const createBody = {
  Image: "redis:7-alpine",
  User: "999:999",
  Cmd: ["redis-server", "--save", "", "--appendonly", "no"],
  Labels: { [label]: runId, "io.abilock.role": "engine-adapter-check" },
  HostConfig: {
    NetworkMode: "none",
    ReadonlyRootfs: true,
    AutoRemove: false,
    Memory: 64 * 1024 * 1024,
    PidsLimit: 64,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: {
      "/data": "rw,noexec,nosuid,size=16m,mode=1777",
      "/tmp": "rw,noexec,nosuid,size=16m,mode=1777",
    },
  },
};
async function createForwarder(tls: Awaited<ReturnType<typeof certificates>>) {
  const server = https.createServer(
    {
      key: tls.serverKey,
      cert: tls.serverCert,
      ca: tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    async (req, res) => {
      try {
        if (!(req.socket as import("node:tls").TLSSocket).authorized)
          throw new Error("MTLS_REQUIRED");
        const url = new URL(req.url!, "https://127.0.0.1");
        const method = req.method!,
          uri = url.pathname;
        if (url.hash || /[%\\]/.test(url.pathname))
          throw new Error("PATH_DENIED");
        let body: Buffer | undefined;
        if (method === "POST" && uri === "/v1.47/containers/create") {
          assert.deepEqual([...url.searchParams], [["name", containerName]]);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 32768) throw new Error("BODY_LIMIT");
            chunks.push(Buffer.from(chunk));
          }
          body = Buffer.concat(chunks);
          assert.deepEqual(JSON.parse(body.toString()), createBody);
        } else if (
          method === "GET" &&
          ["/v1.47/version", "/v1.47/info"].includes(uri)
        ) {
          if (url.search) throw new Error("QUERY_DENIED");
        } else if (method === "GET" && uri === "/v1.47/containers/json") {
          const filters = JSON.parse(url.searchParams.get("filters") ?? "{}");
          assert.deepEqual(filters, { label: [`${label}=${runId}`] });
          if (
            [...url.searchParams.keys()].some(
              (key) => !["filters", "all", "limit"].includes(key),
            )
          )
            throw new Error("QUERY_DENIED");
        } else {
          const match = uri.match(
            /^\/v1\.47\/containers\/([a-f0-9]{64})(?:\/(json|logs|start|stop|restart))?$/,
          );
          if (!match || !(await belongs(match[1])))
            throw new Error("OWNED_CONTAINER_REQUIRED");
          const action = match[2];
          if (!(
            (method === "GET" && ["json", "logs"].includes(action)) ||
            (method === "POST" &&
              ["start", "stop", "restart"].includes(action)) ||
            (method === "DELETE" && !action)
          ))
            throw new Error("METHOD_DENIED");
          const allowed =
            action === "logs"
              ? [
                  "stdout",
                  "stderr",
                  "tail",
                  "timestamps",
                  "details",
                  "since",
                  "until",
                ]
              : ["stop", "restart"].includes(action)
                ? ["t"]
                : method === "DELETE"
                  ? ["force", "v"]
                  : [];
          if (
            [...url.searchParams.keys()].some((key) => !allowed.includes(key))
          )
            throw new Error("QUERY_DENIED");
          if (
            Number(req.headers["content-length"] ?? 0) > 0 ||
            req.headers["transfer-encoding"]
          )
            throw new Error("BODY_DENIED");
        }
        const entry = { method, path: req.url! } as {
          method: string;
          path: string;
          status?: number;
        };
        requests.push(entry);
        const response = await dockerSocket(method, req.url!, body);
        entry.status = response.status;
        if (uri === "/v1.47/containers/create" && response.status === 201) {
          const id = (JSON.parse(response.body.toString()) as { Id: string })
            .Id;
          if (!/^[a-f0-9]{64}$/.test(id))
            throw new Error("INVALID_CONTAINER_ID");
          created.add(id);
          await updateOwned("container-created");
        }
        if (method === "DELETE" && response.status === 204) {
          const id = uri.split("/").at(-1)!;
          removed.add(id);
          await updateOwned("container-removed");
        }
        // A daemon's info object can contain administrator proxy settings.
        // This fixture only needs these public fields; keep other host settings
        // out of the CLI even though the actual /info request is exercised.
        if (uri === "/v1.47/info" && response.status === 200) {
          const info = JSON.parse(response.body.toString()) as {
            ServerVersion?: string;
            OSType?: string;
            Architecture?: string;
          };
          response.body = Buffer.from(
            JSON.stringify({
              ServerVersion: info.ServerVersion,
              OSType: info.OSType,
              Architecture: info.Architecture,
            }),
          );
        }
        res.writeHead(response.status, {
          "content-type":
            response.headers["content-type"] ?? "application/json",
        });
        res.end(response.body);
      } catch {
        req.resume();
        res.writeHead(403, { "content-type": "application/json" }).end(
          JSON.stringify({
            message: "Temporary Docker forwarder policy denied the request",
          }),
        );
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function check(name: string, run: () => Promise<unknown>) {
  lastCheck = name;
  const evidence = await run();
  checks.push({
    name,
    ok: true,
    ...(evidence === undefined ? {} : { evidence }),
  });
}
async function cli(
  operation: Operation,
  expectedCode = 0,
): Promise<AdapterResult> {
  assert.ok(service && temporary);
  const child = spawn(
    process.execPath,
    [
      path.resolve("bin/abl.mjs"),
      "docker",
      "ENGINE_REAL_TEST",
      "--request-stdin",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: temporary,
        ABILOCK_ENDPOINT: service.execUrl,
        ABILOCK_EXEC_TOKEN: executionToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
      signal: abort.signal,
    },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  child.stdin.end(JSON.stringify(operation));
  const [code] = await once(child, "close");
  assert.equal(code, expectedCode, err || out);
  const value = JSON.parse(out || err) as {
    ok: boolean;
    result?: AdapterResult;
    data?: AdapterResult;
    error?: unknown;
  };
  if (expectedCode !== 0) return value as unknown as AdapterResult;
  assert.equal(value.ok, true);
  return value.result ?? value.data ?? (value as unknown as AdapterResult);
}
const executionToken = crypto.randomBytes(32).toString("base64url");
const op = (args: string[], input?: unknown): Operation => ({
  args,
  timeoutMs: 15000,
  ...(input === undefined ? {} : { input: JSON.stringify(input) }),
});

try {
  await updateOwned("initializing");
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-real-engine-"));
  await fs.chmod(temporary, 0o700);
  const tls = await certificates(temporary);
  forwarder = await createForwarder(tls);
  process.env.ABILOCK_MOCK = "1";
  process.env.ABILOCK_ALLOW_LOCAL = "1";
  store = new Store(
    path.join(temporary, "data"),
    crypto.randomBytes(32).toString("hex"),
  );
  await store.init();
  await store.saveConnection(
    {
      alias: "ENGINE_REAL_TEST",
      name: "Authorized temporary Docker test",
      kind: "docker",
      enabled: true,
      description: "Owned labeled test container only",
      trustBoundary: "development-fixture",
      config: {
        endpoint: `https://127.0.0.1:${(forwarder.address() as AddressInfo).port}`,
        auth: "mtls",
        apiVersion: "v1.47",
      },
    },
    { ca: tls.ca, cert: tls.cert, key: tls.key },
    false,
  );
  service = await startServers({
    store,
    execToken: executionToken,
    adminPort: 0,
    execPort: 0,
    webDir: path.resolve("dist/web"),
    log: () => {},
  });
  await check(
    "real Docker daemon version via abl, broker and mTLS forwarder",
    async () => {
      const result = await cli(op(["version"]));
      const version = result.data as {
        Version: string;
        ApiVersion: string;
        MinAPIVersion: string;
      };
      assert.ok(version.Version && version.ApiVersion);
      return {
        serverVersion: version.Version,
        apiVersion: version.ApiVersion,
        minApiVersion: version.MinAPIVersion,
      };
    },
  );
  await check("real Docker info through fixed adapter endpoint", async () => {
    const result = await cli(op(["info"]));
    const info = result.data as { ServerVersion: string; OSType: string };
    assert.ok(info.ServerVersion);
    return { serverVersion: info.ServerVersion, osType: info.OSType };
  });
  let id = "";
  await check(
    "abl create sends native JSON and records owned label/ID",
    async () => {
      const result = await cli(
        op(["create", "--name", containerName], createBody),
      );
      id = (result.data as { Id: string }).Id;
      assert.ok(created.has(id));
      assert.ok(await belongs(id));
      return { id, label: runId, image: "redis:7-alpine" };
    },
  );
  await check(
    "abl list only returns this run's labeled container",
    async () => {
      const result = await cli(
        op(["ps", "-a", "--filter", `label=${label}=${runId}`]),
      );
      const rows = result.data as {
        Id: string;
        Labels: Record<string, string>;
      }[];
      assert.ok(rows.some((row) => row.Id === id));
      assert.ok(rows.every((row) => row.Labels[label] === runId));
      return { count: rows.length };
    },
  );
  await check(
    "start and repeated start are successful/idempotent",
    async () => {
      await cli(op(["start", id]));
      await cli(op(["start", id]));
      const result = await cli(op(["inspect", id]));
      assert.equal(
        (result.data as { State: { Running: boolean } }).State.Running,
        true,
      );
    },
  );
  await check(
    "real Redis container logs are decoded from Engine frames",
    async () => {
      let result: AdapterResult | undefined;
      for (let i = 0; i < 20; i++) {
        result = await cli(op(["logs", "--tail", "100", id]));
        if (/Ready to accept connections/i.test(result.stdout ?? "")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(result!.stdout!, /Ready to accept connections/i);
      return { readyMessageSeen: true };
    },
  );
  await check("restart operates only on owned container", async () => {
    await cli(op(["restart", "--time", "1", id]));
    const result = await cli(op(["inspect", id]));
    assert.equal(
      (result.data as { State: { Running: boolean } }).State.Running,
      true,
    );
  });
  await check(
    "stop and repeated stop preserve NotModified success",
    async () => {
      await cli(op(["stop", "--time", "1", id]));
      await cli(op(["stop", "--time", "1", id]));
      const result = await cli(op(["inspect", id]));
      assert.equal(
        (result.data as { State: { Running: boolean } }).State.Running,
        false,
      );
    },
  );
  await check(
    "CLI target/key override is rejected before daemon access",
    async () => {
      const before = requests.length;
      await cli(op(["ps", "--host", "https://evil.invalid"]), 2);
      assert.equal(requests.length, before);
    },
  );
  await check(
    "abl remove deletes owned container and repeat is an error",
    async () => {
      await cli(op(["rm", id]));
      assert.ok(removed.has(id));
      const response = await dockerSocket(
        "GET",
        `/v1.47/containers/${id}/json`,
      );
      assert.equal(response.status, 404);
      await cli(op(["inspect", id]), 4);
    },
  );
} catch (error) {
  failure = error instanceof Error ? error.name : "ERROR";
  checks.push({ name: lastCheck, ok: false });
  process.exitCode = 1;
} finally {
  for (const id of created) {
    const cleanup: {
      id: string;
      stopStatus?: number;
      removeStatus?: number;
      verifiedAbsent: boolean;
      error?: string;
    } = { id, verifiedAbsent: false };
    try {
      const inspected = await dockerSocket(
        "GET",
        `/v1.47/containers/${id}/json`,
      );
      if (inspected.status === 404) cleanup.verifiedAbsent = true;
      else {
        assert.ok(await belongs(id), "OWNERSHIP_CHANGED");
        cleanup.stopStatus = (
          await dockerSocket("POST", `/v1.47/containers/${id}/stop?t=1`)
        ).status;
        cleanup.removeStatus = (
          await dockerSocket(
            "DELETE",
            `/v1.47/containers/${id}?force=true&v=true`,
          )
        ).status;
        cleanup.verifiedAbsent =
          (await dockerSocket("GET", `/v1.47/containers/${id}/json`)).status ===
          404;
      }
      if (cleanup.verifiedAbsent) removed.add(id);
      else {
        cleanup.error = "OWNED_CONTAINER_NOT_REMOVED";
        process.exitCode = 1;
      }
    } catch {
      cleanup.error =
        "Cleanup failed or ownership no longer matches; no unrelated container was modified";
      process.exitCode = 1;
    }
    cleanups.push(cleanup);
  }
  await service?.close();
  forwarder?.closeAllConnections();
  if (forwarder)
    await new Promise<void>((resolve) => forwarder!.close(() => resolve()));
  await store?.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  const ok = !failure && cleanups.every((row) => row.verifiedAbsent);
  await updateOwned(ok ? "completed-and-cleaned" : "failed-see-cleanup");
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        ok,
        startedAt,
        completedAt: new Date().toISOString(),
        runId,
        parentRunId: previousRunId,
        integration:
          "real local Docker Engine via test-owned mTLS loopback forwarder to Unix socket; abl -> temporary broker -> adapter",
        infoProjection: ["ServerVersion", "OSType", "Architecture"],
        image: "redis:7-alpine (already cached; no pull)",
        checks,
        requests,
        ownedContainerIds: [...created],
        cleanup: cleanups,
        remainingOwned: [...created].filter((id) => !removed.has(id)),
        ...(failure ? { failureStage: lastCheck, failure } : {}),
        unverified: [
          "remote Docker daemon native TLS setup",
          "production independent broker identity",
          "real Kubernetes cluster",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      ok,
      report: reportPath,
      ownedContainerCount: created.size,
      remainingOwnedCount: [...created].filter((id) => !removed.has(id)).length,
    }) + "\n",
  );
}
