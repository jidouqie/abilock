// Runs only against the owned, temporary local containers coordinated by root.
// Never discovers user credentials, Docker config, .env, or database config files.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import { z } from "zod";
import {
  postgresAdapter,
  mysqlAdapter,
  redisAdapter,
} from "../src/protocols/databases.js";
import type {
  AdapterContext,
  AdapterResult,
  Operation,
} from "../src/connections.js";

const endpoint = z.object({
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  database: z.string().min(1),
  password: z.string().min(1),
});
const settingsSchema = z.object({
  reviewFile: z.literal("/var/lib/mysql-files/abilock-synthetic-review.txt"),
  postgres: endpoint,
  mysql: endpoint,
  redis: z.object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
    username: z.string().optional(),
    password: z.string().min(1),
  }),
});
const configFile = process.env.ABILOCK_TEST_ENV;
if (
  !configFile ||
  !path.isAbsolute(configFile) ||
  !(
    configFile.startsWith("/tmp/") ||
    configFile.startsWith(os.tmpdir().replace(/\/$/, "") + "/")
  )
)
  throw new Error("ABILOCK_OWNED_TEMP_CONFIG_REQUIRED");
const settings = settingsSchema.parse(
  JSON.parse(await fs.readFile(configFile, "utf8")),
);
const checks: { name: string; passed: boolean; error?: string }[] = [];
const engines: Partial<Record<"postgres" | "mysql" | "redis", string>> = {};
const started = new Date().toISOString();

function context(kind: "postgres" | "mysql" | "redis"): AdapterContext {
  const target = settings[kind];
  return {
    connection: {
      alias: "OWNED_DB_TEST",
      name: "Root owned temporary database",
      enabled: true,
      description: "Synthetic credentials only",
      kind,
      trustBoundary: "development-fixture",
      config: {
        host: target.host,
        port: target.port,
        tls: false,
        ...(kind === "redis"
          ? { username: settings.redis.username, database: 0 }
          : {
              user: (target as z.infer<typeof endpoint>).user,
              database: (target as z.infer<typeof endpoint>).database,
            }),
      },
    },
    secret: { password: target.password },
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: path.dirname(configFile!),
  };
}
const adapter = {
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
  redis: redisAdapter,
};
function operation(
  args: string[],
  input?: string,
  timeoutMs = 10000,
): Operation {
  return { args, timeoutMs, ...(input === undefined ? {} : { input }) };
}
function errorCode(value: AdapterResult) {
  return (value.data as { code?: string })?.code;
}
async function call(
  kind: "postgres" | "mysql" | "redis",
  op: Operation,
  ctx = context(kind),
) {
  const response = await adapter[kind].run(ctx, op);
  if (response.exitCode !== 0)
    throw new Error(errorCode(response) ?? "TEST_OPERATION_FAILED");
  return response;
}
function rows(
  kind: "postgres" | "mysql",
  response: AdapterResult,
): Record<string, unknown>[] {
  if (kind === "postgres") {
    const results = response.data as { rows: Record<string, unknown>[] }[];
    return results.at(-1)?.rows ?? [];
  }
  const result = response.data as {
    rows: Record<string, unknown>[] | Record<string, unknown>[][];
  };
  if (Array.isArray(result.rows.at(-1)))
    return result.rows.at(-1) as Record<string, unknown>[];
  return result.rows as Record<string, unknown>[];
}
async function check(name: string, work: () => Promise<void>) {
  try {
    await work();
    checks.push({ name, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CHECK_FAILED";
    // No assertion diffs, server text, credential, or stack is persisted.
    checks.push({
      name,
      passed: false,
      error: /^DB_[A-Z_]+$/.test(message) ? message : "CHECK_FAILED",
    });
  }
}

await Promise.all(
  (["postgres", "mysql", "redis"] as const).map((kind) =>
    check(kind + " service-readiness", async () => {
      const until = Date.now() + 45000;
      while (Date.now() < until) {
        const ready = await adapter[kind].run(
          context(kind),
          operation(
            kind === "redis"
              ? ["PING"]
              : [kind === "postgres" ? "-c" : "-e", "SELECT 1"],
            undefined,
            1000,
          ),
        );
        if (ready.exitCode === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("DB_SERVICE_NOT_READY");
    }),
  ),
);

const marker = "public-synthetic-file-marker";
const pgOrdinaryPayload = String.raw`SELECT '\'; SELECT pg_read_file('${settings.reviewFile}') AS marker; -- '`;
const pgUnicodePayload = String.raw`SELECT U&"pg_read\005ffile"('${settings.reviewFile}') AS marker;`;
const mysqlArithmeticPayload = `SELECT 1--1; SELECT LOAD_FILE('${settings.reviewFile}') AS marker;`;

for (const [name, sql, code] of [
  ["ordinary-backslash", pgOrdinaryPayload, "DB_LOCAL_EXTENSION_DENIED"],
  ["unicode-identifier", pgUnicodePayload, "DB_SQL_SYNTAX_UNSUPPORTED"],
] as const) {
  await check("postgres native-" + name + "-semantics", async () => {
    const target = settings.postgres;
    const client = new PgClient({
      host: target.host,
      port: target.port,
      user: target.user,
      database: target.database,
      password: target.password,
      ssl: false,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      client_encoding: "UTF8",
      options: "-c standard_conforming_strings=on",
      ...{ replication: "false" },
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      const response = await client.query(sql);
      const last = Array.isArray(response) ? response.at(-1) : response;
      assert.equal(String(last?.rows[0]?.marker).trim(), marker);
    } finally {
      await client.end().catch(() => undefined);
    }
  });
  await check("postgres adapter-" + name + "-rejected", async () => {
    const response = await postgresAdapter.run(
      context("postgres"),
      operation(["-c", sql]),
    );
    assert.equal(errorCode(response), code);
    assert.ok(!JSON.stringify(response).includes(marker));
  });
}
await check(
  "mysql native-arithmetic-dash-semantics-and-alternate-server-defaults",
  async () => {
    const target = settings.mysql;
    const client = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      database: target.database,
      password: target.password,
      charset: "utf8mb4",
      connectTimeout: 5000,
      multipleStatements: true,
      flags: ["-LOCAL_FILES"],
    });
    try {
      const [modeRows] = await client.query(
        "SELECT @@SESSION.sql_mode AS mode",
      );
      const mode = String((modeRows as { mode: string }[])[0]?.mode);
      assert.ok(mode.split(",").includes("ANSI_QUOTES"));
      assert.ok(mode.split(",").includes("NO_BACKSLASH_ESCAPES"));
      const [response] = await client.query({
        sql: mysqlArithmeticPayload,
        timeout: 5000,
      });
      const last = (response as unknown as { marker: string }[][]).at(-1);
      assert.equal(String(last?.[0]?.marker).trim(), marker);
    } finally {
      client.destroy();
    }
  },
);
await check("mysql adapter-arithmetic-dash-file-read-rejected", async () => {
  const response = await mysqlAdapter.run(
    context("mysql"),
    operation(["-e", mysqlArithmeticPayload]),
  );
  assert.equal(errorCode(response), "DB_LOCAL_EXTENSION_DENIED");
  assert.ok(!JSON.stringify(response).includes(marker));
});
await check(
  "mysql adapter-session-mode-and-charset-normalization",
  async () => {
    const response = await call(
      "mysql",
      operation([
        "-e",
        "SELECT @@SESSION.sql_mode AS mode, @@character_set_client AS charset",
      ]),
    );
    const actual = rows("mysql", response)[0];
    const modes = String(actual.mode).split(",");
    assert.ok(!modes.includes("ANSI_QUOTES"));
    assert.ok(!modes.includes("NO_BACKSLASH_ESCAPES"));
    assert.equal(actual.charset, "utf8mb4");
  },
);
await check(
  "postgres ordinary-escape-dollar-quote-and-comment-business-regression",
  async () => {
    const sql = String.raw`SELECT '\' AS slash; SELECT E'it\'s business' AS escaped; /* outer /* inner */ outer */ SELECT $tag$pg_read_file('x') is business text$tag$ AS value;`;
    const response = await call("postgres", operation(["-c", sql]));
    const items = response.data as { rows: Record<string, unknown>[] }[];
    assert.equal(items[0].rows[0].slash, "\\");
    assert.equal(items[1].rows[0].escaped, "it's business");
    assert.equal(items[2].rows[0].value, "pg_read_file('x') is business text");
  },
);
await check("mysql escaped-and-double-quoted-business-regression", async () => {
  const sql = String.raw`SELECT 'it\'s business' AS business_text; SELECT "LOAD_FILE('x') is business text" AS value; SELECT 1--1 AS arithmetic;`;
  const response = await call("mysql", operation(["-e", sql]));
  const items = (response.data as { rows: Record<string, unknown>[][] }).rows;
  assert.equal(items[0][0].business_text, "it's business");
  assert.equal(items[1][0].value, "LOAD_FILE('x') is business text");
  assert.equal(Number(items[2][0].arithmetic), 2);
});
for (const [kind, sql] of [
  ["postgres", "SET standard_conforming_strings=off; SELECT 1"],
  [
    "postgres",
    "SELECT set_config('standard_' || 'conforming_strings','off',false)",
  ],
  ["mysql", "SET sql_mode='NO_BACKSLASH_ESCAPES'; SELECT 1"],
  ["mysql", "SET NAMES 'gbk'; SELECT 1"],
] as const) {
  await check(
    kind + " adapter-mode-change-denied-" + checks.length,
    async () => {
      const response = await adapter[kind].run(
        context(kind),
        operation([kind === "postgres" ? "-c" : "-e", sql]),
      );
      assert.equal(errorCode(response), "DB_SQL_MODE_DENIED");
    },
  );
}

// These raw-driver semantic probes use only the coordinator's synthetic local
// service. They prove that the forms are native syntax rather than asserting
// that a lexical prefilter is a database-side authorization sandbox.
const routineSql = `CREATE PROCEDURE abilock_probe_review_dynamic() BEGIN IF TRUE THEN SET @abilock_probe_sql='SELECT 37 AS probe'; PREPARE abilock_probe_statement FROM @abilock_probe_sql; EXECUTE abilock_probe_statement; DEALLOCATE PREPARE abilock_probe_statement; END IF; END`;
await check(
  "mysql native-stored-procedure-if-dynamic-query-semantics",
  async () => {
    const target = settings.mysql;
    const client = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      database: target.database,
      password: target.password,
      charset: "utf8mb4",
      connectTimeout: 5000,
      multipleStatements: true,
      flags: ["-LOCAL_FILES"],
    });
    try {
      await client.query(
        "DROP PROCEDURE IF EXISTS abilock_probe_review_dynamic",
      );
      await client.query({ sql: routineSql, timeout: 5000 });
      const [result] = await client.query({
        sql: "CALL abilock_probe_review_dynamic()",
        timeout: 5000,
      });
      assert.equal(
        (result as unknown as { probe: number }[][])[0]?.[0]?.probe,
        37,
      );
    } finally {
      try {
        await client.query(
          "DROP PROCEDURE IF EXISTS abilock_probe_review_dynamic",
        );
      } finally {
        client.destroy();
      }
    }
  },
);
await check(
  "mysql native-aggregate-udf-grammar-nonexistent-library-only",
  async () => {
    const target = settings.mysql;
    const client = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      database: target.database,
      password: target.password,
      charset: "utf8mb4",
      connectTimeout: 5000,
      flags: ["-LOCAL_FILES"],
    });
    const nonexistent = "abilock-review-" + randomUUID() + ".so";
    const functionName =
      "abilock_probe_udf_" + randomUUID().replaceAll("-", "");
    let registered = false;
    try {
      for (const conditional of ["", "IF NOT EXISTS "]) {
        let rejected = false;
        try {
          await client.query({
            sql: `CREATE AGGREGATE FUNCTION ${conditional}${functionName} RETURNS INTEGER SONAME '${nonexistent}'`,
            timeout: 5000,
          });
          registered = true;
        } catch (error) {
          // Syntax error (1064) is not accepted as evidence. The fixture role
          // denies mysql.* registration or the unique nonexistent library fails
          // to open; no real library or native code is installed or executed.
          assert.ok(
            [1044, 1142, 1126].includes(
              (error as { errno?: number }).errno ?? 0,
            ),
          );
          rejected = true;
        }
        assert.ok(rejected);
      }
    } finally {
      try {
        if (registered) await client.query("DROP FUNCTION " + functionName);
      } finally {
        client.destroy();
      }
    }
  },
);
await check(
  "postgres native-adminpack-public-marker-and-dblink-owned-target-semantics",
  async () => {
    const target = settings.postgres;
    const client = new PgClient({
      host: target.host,
      port: target.port,
      user: target.user,
      database: target.database,
      password: target.password,
      ssl: false,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      client_encoding: "UTF8",
      options: "-c standard_conforming_strings=on",
      ...{ replication: "false" },
    });
    const created: string[] = [];
    const markerFile =
      "/tmp/abilock-probe-review-adminpack-" + randomUUID() + ".txt";
    let wrote = false;
    let adminpackAvailable = false;
    let cleanupFailed = false;
    client.on("error", () => undefined);
    try {
      await client.connect();
      const existing = new Set(
        (await client.query("SELECT extname FROM pg_extension")).rows.map(
          (row) => row.extname,
        ),
      );
      for (const name of ["adminpack", "dblink"]) {
        if (!existing.has(name)) {
          await client.query("CREATE EXTENSION " + name);
          created.push(name);
        }
        if (name === "adminpack") adminpackAvailable = true;
      }
      const written = await client.query(
        "SELECT pg_catalog.pg_file_write($1,$2,false) AS bytes",
        [markerFile, marker],
      );
      wrote = true;
      assert.equal(Number(written.rows[0]?.bytes), Buffer.byteLength(marker));
      const content = await client.query("SELECT pg_read_file($1) AS marker", [
        markerFile,
      ]);
      assert.equal(content.rows[0]?.marker, marker);
      const port = Number((await client.query("SHOW port")).rows[0]?.port);
      assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
      const quoted = (value: string) =>
        "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
      const connstr =
        "host=127.0.0.1 port=" +
        port +
        " dbname=" +
        quoted(target.database) +
        " user=" +
        quoted(target.user) +
        " password=" +
        quoted(target.password);
      const linked = await client.query(
        "SELECT probe FROM dblink($1,'SELECT 41 AS probe') AS result(probe integer)",
        [connstr],
      );
      assert.equal(linked.rows[0]?.probe, 41);
    } finally {
      try {
        if (adminpackAvailable) {
          try {
            const removed = (
              await client.query(
                "SELECT pg_catalog.pg_file_unlink($1) AS removed",
                [markerFile],
              )
            ).rows[0]?.removed;
            if (wrote) assert.equal(removed, true);
          } catch {
            cleanupFailed = true;
          }
        }
        for (const name of created.reverse()) {
          try {
            await client.query("DROP EXTENSION " + name);
          } catch {
            cleanupFailed = true;
          }
        }
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    assert.equal(cleanupFailed, false);
  },
);
for (const [kind, name, sql, code] of [
  [
    "mysql",
    "aggregate-udf",
    "CREATE AGGREGATE FUNCTION synthetic_probe RETURNS INTEGER SONAME 'synthetic-review.so';",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "mysql",
    "aggregate-udf-if-not-exists",
    "CREATE AGGREGATE FUNCTION IF NOT EXISTS synthetic_probe RETURNS DECIMAL SONAME 'synthetic-review.so';",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "mysql",
    "stored-procedure-if-dynamic",
    routineSql,
    "DB_SQL_STATEMENT_UNSUPPORTED",
  ],
  [
    "mysql",
    "compound-if-dynamic",
    "IF TRUE THEN PREPARE p FROM 'SELECT 1'; EXECUTE p; END IF;",
    "DB_SQL_STATEMENT_UNSUPPORTED",
  ],
  [
    "mysql",
    "stored-procedure-call",
    "CALL abilock_probe_review_dynamic()",
    "DB_SQL_STATEMENT_UNSUPPORTED",
  ],
  [
    "postgres",
    "adminpack-write",
    "SELECT pg_catalog.pg_file_write('/tmp/abilock-public-marker','public business marker',false)",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "postgres",
    "adminpack-unlink",
    "SELECT pg_catalog.pg_file_unlink('/tmp/abilock-public-marker')",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "postgres",
    "dblink-connstr",
    "SELECT * FROM dblink('host=127.0.0.1 dbname=synthetic','SELECT 1') AS result(probe int)",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "postgres",
    "dblink-exec-connstr",
    "SELECT dblink_exec('host=127.0.0.1 dbname=synthetic','SELECT 1')",
    "DB_LOCAL_EXTENSION_DENIED",
  ],
  [
    "postgres",
    "explain-execute",
    "EXPLAIN ANALYZE EXECUTE synthetic_probe",
    "DB_DYNAMIC_SQL_DENIED",
  ],
] as const) {
  await check(kind + " adapter-review-" + name + "-rejected", async () => {
    const response = await adapter[kind].run(
      context(kind),
      operation([kind === "postgres" ? "-c" : "-e", sql]),
    );
    assert.equal(errorCode(response), code);
    assert.ok(!JSON.stringify(response).includes(marker));
  });
}

for (const kind of ["postgres", "mysql"] as const) {
  const command = kind === "postgres" ? "-c" : "-e";
  await check(kind + " native-query-version", async () => {
    const response = await call(
      kind,
      operation([command, "SELECT version() AS version"]),
    );
    assert.ok(typeof rows(kind, response)[0]?.version === "string");
    engines[kind] = String(rows(kind, response)[0].version).slice(0, 300);
  });
  await check(kind + " idempotent-schema-and-native-writes", async () => {
    await call(
      kind,
      operation([
        command,
        "DROP TABLE IF EXISTS abilock_probe_orders; CREATE TABLE abilock_probe_orders (id INTEGER PRIMARY KEY, status VARCHAR(100)); INSERT INTO abilock_probe_orders (id,status) VALUES (1,'queued');",
      ]),
    );
    const response = await call(
      kind,
      operation([
        command,
        "SELECT id,status FROM abilock_probe_orders WHERE id=1",
      ]),
    );
    assert.equal(rows(kind, response)[0]?.status, "queued");
  });
  await check(kind + " prepared-parameter-binding", async () => {
    const sql =
      kind === "postgres"
        ? "UPDATE abilock_probe_orders SET status=$1 WHERE id=$2"
        : "UPDATE abilock_probe_orders SET status=? WHERE id=?";
    await call(kind, operation([command, sql, "--params", '["complete",1]']));
    const response = await call(
      kind,
      operation([
        command,
        "SELECT status FROM abilock_probe_orders WHERE id=1",
      ]),
    );
    assert.equal(rows(kind, response)[0]?.status, "complete");
  });
}

for (const kind of ["postgres", "mysql"] as const) {
  await check(kind + " script-commit-and-rollback", async () => {
    const sql =
      "BEGIN; INSERT INTO abilock_probe_orders (id,status) VALUES (2,'committed'); COMMIT; BEGIN; INSERT INTO abilock_probe_orders (id,status) VALUES (3,'rolled-back'); ROLLBACK; SELECT id,status FROM abilock_probe_orders ORDER BY id;";
    const response = await call(kind, {
      args: ["-f", "owned-business.sql"],
      files: [
        {
          path: "owned-business.sql",
          base64: Buffer.from(sql).toString("base64"),
        },
      ],
      timeoutMs: 10000,
    });
    assert.deepEqual(
      rows(kind, response).map((row) => Number(row.id)),
      [1, 2],
    );
  });
  await check(kind + " wrong-auth-and-error-redaction", async () => {
    const command = kind === "postgres" ? "-c" : "-e";
    const ctx = context(kind),
      wrong = await adapter[kind].run(
        { ...ctx, secret: { password: "different-synthetic-password" } },
        operation([command, "SELECT 1"]),
      );
    assert.equal(wrong.exitCode, 1);
    assert.equal(errorCode(wrong), "DB_OPERATION_FAILED");
    assert.ok(!JSON.stringify(wrong).includes(ctx.secret.password));
    const badSql = await adapter[kind].run(
      ctx,
      operation([
        command,
        "SELECT definitely_missing_column FROM abilock_probe_orders",
      ]),
    );
    assert.equal(errorCode(badSql), "DB_OPERATION_FAILED");
    assert.ok(!JSON.stringify(badSql).includes("definitely_missing_column"));
  });
  await check(kind + " real-query-timeout", async () => {
    const command = kind === "postgres" ? "-c" : "-e",
      sql = kind === "postgres" ? "SELECT pg_sleep(5)" : "SELECT SLEEP(5)";
    const response = await adapter[kind].run(
      context(kind),
      operation([command, sql], undefined, 150),
    );
    assert.equal(errorCode(response), "DB_TIMEOUT");
  });
  await check(kind + " real-large-result-limit", async () => {
    const sql =
      kind === "postgres"
        ? "SELECT repeat(chr(34),12582912) AS giant"
        : "SELECT REPEAT(CHAR(34),12582912) AS giant";
    const response = await adapter[kind].run(
      context(kind),
      operation([kind === "postgres" ? "-c" : "-e", sql]),
    );
    assert.equal(errorCode(response), "DB_OUTPUT_LIMIT");
  });
}

await check("redis actual-server-version", async () => {
  const response = await call("redis", operation(["INFO", "server"]));
  const info = (response.data as { result: unknown }).result;
  const server =
    typeof info === "string" ? info : (info as { utf8: string }).utf8;
  const version = /^redis_version:(.*)$/m.exec(server)?.[1].trim();
  assert.ok(version);
  engines.redis = version;
});
await check("redis native-write-read-and-resp-batch", async () => {
  const batch =
    "*3\r\n$3\r\nSET\r\n$21\r\nabilock-probe-batch\r\n$5\r\nhello\r\n*2\r\n$3\r\nGET\r\n$21\r\nabilock-probe-batch\r\n";
  const response = await call("redis", operation(["--pipe"], batch));
  const results = response.data as { result: { utf8: string } }[];
  assert.equal(results[1].result.utf8, "hello");
});
await check("redis binary-values", async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
  await call("redis", {
    args: ["-x", "SET", "abilock-probe-binary"],
    files: [{ path: "-", base64: bytes.toString("base64") }],
    timeoutMs: 10000,
  });
  const response = await call(
    "redis",
    operation(["GET", "abilock-probe-binary"]),
  );
  assert.equal(
    (response.data as { result: { base64: string } }).result.base64,
    bytes.toString("base64"),
  );
});
await check(
  "redis lua-business-and-server-noscript-credential-boundary",
  async () => {
    const response = await call(
      "redis",
      operation([
        "EVAL",
        "return redis.call('GET',KEYS[1])",
        "1",
        "abilock-probe-batch",
      ]),
    );
    assert.equal(
      (response.data as { result: { utf8: string } }).result.utf8,
      "hello",
    );
    const forbidden = await redisAdapter.run(
      context("redis"),
      operation([
        "EVAL",
        "return redis.call('CONFIG','GET','requirepass')",
        "0",
      ]),
    );
    assert.equal(errorCode(forbidden), "DB_OPERATION_FAILED");
    assert.ok(!JSON.stringify(forbidden).includes(settings.redis.password));
  },
);
await check("redis wrong-auth-and-credential-command-denial", async () => {
  const ctx = context("redis");
  const wrong = await redisAdapter.run(
    { ...ctx, secret: { password: "different-synthetic-password" } },
    operation(["PING"]),
  );
  assert.equal(errorCode(wrong), "DB_OPERATION_FAILED");
  const forbidden = await redisAdapter.run(
    ctx,
    operation(["CONFIG", "GET", "requirepass"]),
  );
  assert.equal(errorCode(forbidden), "DB_COMMAND_DENIED");
  assert.ok(!JSON.stringify([wrong, forbidden]).includes(ctx.secret.password));
});
await check("redis real-blocking-command-timeout", async () => {
  const response = await redisAdapter.run(
    context("redis"),
    operation(["BLPOP", "abilock-probe-never-present", "5"], undefined, 150),
  );
  assert.equal(errorCode(response), "DB_TIMEOUT");
});
await check("redis real-large-result-limit", async () => {
  await call(
    "redis",
    operation(
      ["-x", "SET", "abilock-probe-large"],
      '"'.repeat(12 * 1024 * 1024),
    ),
  );
  const response = await redisAdapter.run(
    context("redis"),
    operation(["GET", "abilock-probe-large"]),
  );
  assert.equal(errorCode(response), "DB_OUTPUT_LIMIT");
});

for (const kind of ["postgres", "mysql"] as const)
  await check(kind + " temporary-business-data-cleanup", async () => {
    await call(
      kind,
      operation([
        kind === "postgres" ? "-c" : "-e",
        "DROP TABLE IF EXISTS abilock_probe_orders",
      ]),
    );
  });
await check("redis temporary-business-data-cleanup", async () => {
  await call(
    "redis",
    operation([
      "DEL",
      "abilock-probe-batch",
      "abilock-probe-binary",
      "abilock-probe-never-present",
      "abilock-probe-large",
    ]),
  );
});
const report = {
  phase: "post-review-sql-policy",
  started,
  finished: new Date().toISOString(),
  scope:
    "Root-owned temporary PostgreSQL/MySQL/Redis containers only; synthetic credentials; TLS disabled explicitly for isolated loopback integration.",
  actualDatabaseEngines: true,
  successfulTlsNotVerified: true,
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        "src/protocols/databases.ts",
        "tests/database-sql-lexer.test.ts",
        "scripts/real-database-check.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
      ]),
    ),
  ),
  engines,
  checks,
  passed: checks.every((item) => item.passed),
};
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile(
  "artifacts/post-review-sql-policy-real-database-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    passed: report.passed,
    checks: checks.length,
    failed: checks.filter((item) => !item.passed).map((item) => item.name),
    report: "artifacts/post-review-sql-policy-real-database-validation.json",
  }),
);
if (!report.passed) process.exitCode = 1;
