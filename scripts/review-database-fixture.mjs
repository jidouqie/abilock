// Maintenance of this run's explicitly owned, synthetic Docker fixtures only.
import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const state = JSON.parse(
  await fs.readFile(
    process.argv[3] ?? "artifacts/docker-test-owned.json",
    "utf8",
  ),
);
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
      timeout: 30000,
      maxBuffer: 100000,
    })
  ).stdout.trim();
}
const reviewFile = "/var/lib/mysql-files/abilock-synthetic-review.txt";
for (const c of state.containers.filter((row) =>
  /-(postgres|mysql)$/.test(row.name),
)) {
  const label = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "io.abilock.test"}}',
    c.id,
  ]);
  if (label !== state.runId) throw new Error("OWNED_LABEL_MISMATCH");
  await docker([
    "exec",
    "--user",
    "0",
    c.id,
    "sh",
    "-c",
    "mkdir -p /var/lib/mysql-files && printf %s public-synthetic-file-marker > /var/lib/mysql-files/abilock-synthetic-review.txt && chmod 755 /var/lib/mysql-files && chmod 644 /var/lib/mysql-files/abilock-synthetic-review.txt",
  ]);
  if (c.name.endsWith("-mysql")) {
    await new Promise((resolve, reject) => {
      const p = spawn(
        "/usr/local/bin/docker",
        [
          ...prefix,
          "exec",
          "-i",
          c.id,
          "sh",
          "-c",
          'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --batch --skip-column-names',
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      p.stdout.on("data", (v) => {
        output += v;
      });
      // Synthetic credentials never enter output, host argv or persisted evidence.
      p.stderr.resume();
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0
          ? resolve(output)
          : reject(new Error("OWNED_MYSQL_MAINTENANCE_FAILED")),
      );
      p.stdin.end(
        "GRANT FILE ON *.* TO 'fixture'@'%'; SET GLOBAL sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES'; SELECT @@secure_file_priv;\n",
      );
    });
  }
}
const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
config.reviewFile = reviewFile;
await fs.writeFile(state.configPath, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    runId: state.runId,
    syntheticFileCreated: true,
    onlyOwnedContainers: true,
    mysqlFilePrivilegeInFixtureOnly: true,
    alternateSqlModeInFixtureOnly: true,
  }),
);
