import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
const run = promisify(execFile);
const runId = "abilock-test-" + Date.now().toString(36);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), runId + "-"));
const client = path.join(dir, "docker-client");
await fs.mkdir(client);
await fs.writeFile(path.join(client, "config.json"), "{}\n");
const prefix = ["--config", client, "--host", "unix:///var/run/docker.sock"];
const docker = async (args, opts = {}) =>
  (
    await run("/usr/local/bin/docker", [...prefix, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180000,
      ...opts,
    })
  ).stdout.trim();
const password = () => crypto.randomBytes(24).toString("base64url");
const state = {
  runId,
  dir,
  client,
  network: runId + "-network",
  containers: [],
  utilityContainers: [],
  configPath: path.join(dir, "fixture-config.json"),
};
const statePath = path.resolve("artifacts/docker-test-owned.json");
async function record() {
  const current = await fs.readFile(statePath, "utf8").then(
    (v) => JSON.parse(v),
    () => undefined,
  );
  if (current?.runId === state.runId && current.engineChecks)
    state.engineChecks = current.engineChecks;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const results = [];
  for (const c of state.containers) {
    try {
      await docker(["stop", "--time", "10", c.id]);
      const info = JSON.parse(
        await docker(["inspect", "--format", "{{json .State}}", c.id]),
      );
      results.push({
        name: c.name,
        id: c.id,
        running: info.Running,
        status: info.Status,
        stopped: !info.Running,
      });
    } catch {
      results.push({
        name: c.name,
        id: c.id,
        stopped: false,
        error: "STOP_FAILED",
      });
    }
  }
  await fs.writeFile(
    path.resolve("artifacts/docker-test-cleanup.json"),
    JSON.stringify(
      {
        runId,
        checkedAt: new Date().toISOString(),
        onlyOwnedContainers: true,
        results,
        allStopped: results.every((r) => r.stopped),
        utilityContainers: state.utilityContainers,
        network: state.network,
        existingUserContainersStopped: false,
        pruneRun: false,
      },
      null,
      2,
    ) + "\n",
  );
  await record();
  console.log(
    JSON.stringify({
      event: "docker-tests-stopped",
      allStopped: results.every((r) => r.stopped),
      count: results.length,
    }),
  );
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    void stop().finally(() => process.exit(130));
  });
async function envFile(name, values) {
  const p = path.join(dir, name + ".env");
  await fs.writeFile(
    p,
    Object.entries(values)
      .map(([k, v]) => k + "=" + v)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  return p;
}
async function start(service, image, port, args = [], options = []) {
  const name = runId + "-" + service;
  const id = await docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "io.abilock.test=" + runId,
    "--network",
    state.network,
    "-p",
    "127.0.0.1::" + port,
    ...options,
    image,
    ...args,
  ]);
  state.containers.push({ name, id, image });
  await record();
  const mapping = await docker(["port", id, String(port)]);
  const hostPort = Number(mapping.split(":").at(-1));
  console.log(
    JSON.stringify({ event: "container-started", service, name, id, hostPort }),
  );
  return hostPort;
}
const minioImage = process.env.ABILOCK_MINIO_TEST_IMAGE;
const images = [
  "postgres:16-alpine",
  "mysql:8.4",
  "redis:7-alpine",
  minioImage ?? null,
  "registry:2",
  "httpd:2.4-alpine",
];
try {
  await record();
  const pulls = await Promise.allSettled(
    images.filter(Boolean).map(async (image) => {
      try {
        const present = await docker(["image", "inspect", image]).then(
          () => true,
          () => false,
        );
        if (!present) await docker(["pull", image], { timeout: 240000 });
        console.log(JSON.stringify({ event: "image-ready", image }));
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "image-pull-failed",
            image,
            reason: String(error.stderr ?? "").slice(0, 1600),
          }),
        );
        throw new Error("IMAGE_PULL_FAILED");
      }
    }),
  );
  if (pulls.some((r) => r.status === "rejected"))
    throw new Error("IMAGE_PULL_FAILED");
  await docker([
    "network",
    "create",
    "--label",
    "io.abilock.test=" + runId,
    state.network,
  ]);
  const pgPassword = password(),
    mysqlPassword = password(),
    redisPassword = password(),
    accessKeyId = "abl" + crypto.randomBytes(10).toString("hex"),
    secretAccessKey = password(),
    registryPassword = password();
  const pgEnv = await envFile("postgres", {
    POSTGRES_USER: "fixture",
    POSTGRES_DB: "fixture",
    POSTGRES_PASSWORD: pgPassword,
  });
  const mysqlEnv = await envFile("mysql", {
    MYSQL_ROOT_PASSWORD: password(),
    MYSQL_USER: "fixture",
    MYSQL_DATABASE: "fixture",
    MYSQL_PASSWORD: mysqlPassword,
  });
  const minioEnv = await envFile("minio", {
    MINIO_ROOT_USER: accessKeyId,
    MINIO_ROOT_PASSWORD: secretAccessKey,
  });
  const redisConf = path.join(dir, "redis.conf");
  await fs.writeFile(
    redisConf,
    "bind 0.0.0.0\nprotected-mode yes\nrequirepass " + redisPassword + "\n",
    { mode: 0o600 },
  );
  const authDir = path.join(dir, "registry-auth");
  await fs.mkdir(authDir);
  const utilityName = runId + "-htpasswd";
  const hash = await docker([
    "run",
    "--rm",
    "--name",
    utilityName,
    "--label",
    "io.abilock.test=" + runId,
    "--network",
    "none",
    "--entrypoint",
    "htpasswd",
    "httpd:2.4-alpine",
    "-Bbn",
    "fixture",
    registryPassword,
  ]);
  await fs.writeFile(path.join(authDir, "htpasswd"), hash + "\n", {
    mode: 0o600,
  });
  state.utilityContainers.push({ name: utilityName, exitedAndRemoved: true });
  const registryEnv = await envFile("registry", {
    REGISTRY_AUTH: "htpasswd",
    REGISTRY_AUTH_HTPASSWD_REALM: "Abilock test",
    REGISTRY_AUTH_HTPASSWD_PATH: "/auth/htpasswd",
    REGISTRY_STORAGE_DELETE_ENABLED: "true",
  });
  const pgPort = await start(
    "postgres",
    images[0],
    5432,
    [],
    ["--env-file", pgEnv],
  );
  const mysqlPort = await start(
    "mysql",
    images[1],
    3306,
    [],
    ["--env-file", mysqlEnv],
  );
  const redisPort = await start(
    "redis",
    images[2],
    6379,
    ["redis-server", "/usr/local/etc/redis.conf"],
    [
      "--mount",
      "type=bind,source=" +
        redisConf +
        ",target=/usr/local/etc/redis.conf,readonly",
    ],
  );
  const minioPort = images[3]
    ? await start(
        "minio",
        images[3],
        9000,
        ["server", "/data"],
        ["--env-file", minioEnv],
      )
    : undefined;
  const registryPort = await start(
    "registry",
    images[4],
    5000,
    [],
    [
      "--env-file",
      registryEnv,
      "--mount",
      "type=bind,source=" + authDir + ",target=/auth,readonly",
    ],
  );
  await fs.writeFile(
    state.configPath,
    JSON.stringify(
      {
        runId,
        postgres: {
          host: "127.0.0.1",
          port: pgPort,
          user: "fixture",
          database: "fixture",
          password: pgPassword,
        },
        mysql: {
          host: "127.0.0.1",
          port: mysqlPort,
          user: "fixture",
          database: "fixture",
          password: mysqlPassword,
        },
        redis: {
          host: "127.0.0.1",
          port: redisPort,
          username: "default",
          password: redisPassword,
        },
        ...(minioPort
          ? {
              minio: {
                endpoint: "http://127.0.0.1:" + minioPort,
                accessKeyId,
                secretAccessKey,
                bucket: "abilock-test",
                region: "us-east-1",
              },
            }
          : {}),
        registry: {
          endpoint: "http://127.0.0.1:" + registryPort,
          username: "fixture",
          password: registryPassword,
          repository: "abilock/test",
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await record();
  console.log(
    JSON.stringify({
      event: "docker-fixtures-created",
      configPath: state.configPath,
      statePath,
      runId,
      containers: state.containers.length,
    }),
  );
  if (process.argv.includes("--keep")) {
    await new Promise((resolve) => {
      const poll = setInterval(async () => {
        if (
          await fs.access(path.join(dir, "STOP")).then(
            () => true,
            () => false,
          )
        ) {
          clearInterval(poll);
          resolve();
        }
      }, 1000);
    });
  } else {
    throw new Error("Use --keep for coordinated tests; default safe-stop");
  }
} catch (error) {
  console.log(
    JSON.stringify({
      event: "docker-test-error",
      code: error.code ?? "TEST_ENV_FAILED",
      message: "临时Docker环境失败，清理本次容器",
    }),
  );
  process.exitCode = 1;
} finally {
  await stop();
}
