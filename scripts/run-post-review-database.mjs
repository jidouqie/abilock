// Reuse only the stopped, explicitly owned synthetic fixtures from this run.
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
// The explicit state file selects an already-owned run; it never weakens the
// run-id, container-label, or loopback-port checks below.
const stateFile = process.argv[3] ?? "artifacts/docker-test-owned.json";
const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
if (
  !/^abilock-test-[a-z0-9]+$/.test(state.runId) ||
  process.argv[2] !== state.runId
)
  throw new Error("OWNED_RUN_REQUIRED");
const prefix = [
  "--config",
  state.client,
  "--host",
  "unix:///var/run/docker.sock",
];
async function docker(args) {
  return (
    await run("/usr/local/bin/docker", [...prefix, ...args], {
      timeout: 60000,
      maxBuffer: 100000,
    })
  ).stdout.trim();
}
for (const c of state.containers) {
  if (
    (await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "io.abilock.test"}}',
      c.id,
    ])) !== state.runId
  )
    throw new Error("OWNED_LABEL_MISMATCH");
}
let result;
try {
  for (const c of state.containers) await docker(["start", c.id]);
  // Docker may assign new ephemeral host ports after a stopped fixture restarts.
  const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
  for (const [service, port] of [
    ["postgres", 5432],
    ["mysql", 3306],
    ["redis", 6379],
    ["registry", 5000],
  ]) {
    const c = state.containers.find((row) => row.name.endsWith(`-${service}`));
    if (!c) throw new Error("OWNED_SERVICE_REQUIRED");
    const mapping = await docker(["port", c.id, String(port)]);
    const hostPort = Number(mapping.split(":").at(-1));
    if (
      !Number.isInteger(hostPort) ||
      hostPort < 1 ||
      !mapping.startsWith("127.0.0.1:")
    )
      throw new Error("OWNED_LOOPBACK_PORT_REQUIRED");
    if (service === "registry")
      config[service].endpoint = `http://127.0.0.1:${hostPort}`;
    else config[service].port = hostPort;
  }
  await fs.writeFile(state.configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  // GLOBAL sql_mode is intentionally temporary and resets after stop/start.
  let maintained = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await run(
        process.execPath,
        ["scripts/review-database-fixture.mjs", state.runId, stateFile],
        { timeout: 10000, maxBuffer: 100000 },
      );
      maintained = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!maintained) throw new Error("OWNED_FIXTURE_MAINTENANCE_FAILED");
  result = await run(
    process.execPath,
    ["--import", "tsx", "scripts/real-database-check.ts"],
    {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: state.dir,
        ABILOCK_TEST_ENV: state.configPath,
      },
      timeout: 180000,
      maxBuffer: 200000,
    },
  );
  process.stdout.write(result.stdout);
} finally {
  const results = [];
  for (const c of state.containers) {
    try {
      await docker(["stop", "--time", "10", c.id]);
      const current = JSON.parse(
        await docker(["inspect", "--format", "{{json .State}}", c.id]),
      );
      results.push({
        name: c.name,
        id: c.id,
        status: current.Status,
        running: current.Running,
        stopped: !current.Running,
      });
    } catch {
      results.push({ name: c.name, id: c.id, stopped: false });
    }
  }
  await fs.writeFile(
    "artifacts/post-review-docker-cleanup.json",
    JSON.stringify(
      {
        runId: state.runId,
        checkedAt: new Date().toISOString(),
        onlyOwnedContainers: true,
        results,
        allStopped: results.every((v) => v.stopped),
        existingUserContainersStopped: false,
        pruneRun: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      event: "post-review-owned-cleanup",
      allStopped: results.every((v) => v.stopped),
      count: results.length,
    }),
  );
  if (results.some((v) => !v.stopped)) process.exitCode = 1;
}
