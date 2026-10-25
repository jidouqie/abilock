import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  postgresAdapter,
  mysqlAdapter,
  redisAdapter,
} from "../src/protocols/databases.js";
import type { Adapter, AdapterContext, Operation } from "../src/connections.js";
import {
  postgresFixture,
  mysqlFixture,
  redisFixture,
  FIXTURE_PASSWORD,
  type WireFixture,
} from "./db-wire-fixtures.js";

function context(
  kind: "postgres" | "mysql" | "redis",
  fixture: WireFixture,
  controller = new AbortController(),
): AdapterContext {
  return {
    connection: {
      alias: "DB_FIXTURE",
      name: "Protocol fixture",
      description: "Temporary synthetic credentials",
      kind,
      enabled: true,
      config: {
        host: "127.0.0.1",
        port: fixture.port,
        tls: false,
        ...(kind === "redis"
          ? { username: "fixture-user", database: 0 }
          : { user: "fixture-user", database: "fixture-db" }),
      },
    },
    secret: { password: FIXTURE_PASSWORD },
    signal: controller.signal,
    allowLocal: true,
    dataDir: "unused-by-protocol-adapter",
  };
}
function operation(args: string[], extra: Partial<Operation> = {}): Operation {
  return { args, timeoutMs: 5000, ...extra };
}
function code(result: Awaited<ReturnType<Adapter["run"]>>) {
  return (result.data as { code?: string })?.code;
}

test("PostgreSQL native SQL, parameters, uploaded script and writes use the v3 wire protocol", async () => {
  const fixture = await postgresFixture();
  try {
    const ctx = context("postgres", fixture);
    const native = await postgresAdapter.run(
      ctx,
      operation(["-c", "SELECT 42"]),
    );
    assert.equal(native.exitCode, 0);
    assert.match(native.stdout!, /"answer":42/);
    const params = await postgresAdapter.run(
      ctx,
      operation(["--command=SELECT $1::int AS answer", "--params", "[42]"]),
    );
    assert.equal(params.exitCode, 0);
    assert.ok(fixture.commands.includes("SELECT $1::int AS answer"));
    const script = "BEGIN; UPDATE orders SET status = 'complete'; COMMIT;";
    const uploaded = await postgresAdapter.run(
      ctx,
      operation(["-f", "business.sql"], {
        files: [
          {
            path: "business.sql",
            base64: Buffer.from(script).toString("base64"),
          },
        ],
      }),
    );
    assert.equal(uploaded.exitCode, 0);
    assert.ok(fixture.commands.includes(script));
    const stdin = await postgresAdapter.run(
      ctx,
      operation([], { input: "INSERT INTO orders (status) VALUES ('queued')" }),
    );
    assert.equal(stdin.exitCode, 0);
    assert.equal(fixture.authCount(), 4);
    assert.ok(!native.stdout!.includes(FIXTURE_PASSWORD));
  } finally {
    await fixture.close();
  }
});

test("MySQL native SQL, prepared parameters, script and writes use protocol 4.1", async () => {
  const fixture = await mysqlFixture();
  try {
    const ctx = context("mysql", fixture);
    const native = await mysqlAdapter.run(ctx, operation(["-e", "SELECT 42"]));
    assert.equal(native.exitCode, 0);
    assert.match(native.stdout!, /"answer":42/);
    const params = await mysqlAdapter.run(
      ctx,
      operation(["--execute=SELECT ? AS answer", "--params", "[42]"]),
    );
    assert.equal(params.exitCode, 0);
    assert.match(params.stdout!, /"answer":42/);
    assert.ok(fixture.commands.includes("SELECT ? AS answer"));
    const script = "BEGIN; UPDATE orders SET status = 'complete'; COMMIT;";
    const uploaded = await mysqlAdapter.run(
      ctx,
      operation(["--file", "business.sql"], {
        files: [
          {
            path: "business.sql",
            base64: Buffer.from(script).toString("base64"),
          },
        ],
      }),
    );
    assert.equal(uploaded.exitCode, 0);
    assert.ok(fixture.commands.includes(script));
    const stdin = await mysqlAdapter.run(
      ctx,
      operation([], { input: "INSERT INTO orders (status) VALUES ('queued')" }),
    );
    assert.equal(stdin.exitCode, 0);
    assert.equal(fixture.authCount(), 4);
  } finally {
    await fixture.close();
  }
});

test("Redis native commands, RESP batch and binary data survive protocol transport", async () => {
  const fixture = await redisFixture();
  try {
    const ctx = context("redis", fixture);
    assert.equal(
      (await redisAdapter.run(ctx, operation(["PING"]))).exitCode,
      0,
    );
    const data = Buffer.from([0, 0xff, 0x80, 13, 10, 65]);
    const set = await redisAdapter.run(
      ctx,
      operation(["-x", "SET", "binary"], {
        files: [{ path: "-", base64: data.toString("base64") }],
      }),
    );
    assert.equal(set.exitCode, 0);
    const get = await redisAdapter.run(ctx, operation(["GET", "binary"]));
    assert.equal(get.exitCode, 0);
    assert.equal(
      (get.data as { result: { base64: string } }).result.base64,
      data.toString("base64"),
    );
    const batch =
      "*3\r\n$3\r\nSET\r\n$5\r\nbatch\r\n$5\r\nhello\r\n*2\r\n$3\r\nGET\r\n$5\r\nbatch\r\n";
    const piped = await redisAdapter.run(
      ctx,
      operation(["--pipe"], { input: batch }),
    );
    assert.equal(piped.exitCode, 0);
    assert.match(piped.stdout!, /"utf8":"hello"/);
    assert.equal(fixture.authCount(), 4);
  } finally {
    await fixture.close();
  }
});

test("SQL connection/password overrides, client shells and local file extensions fail before connection", async () => {
  const pg = await postgresFixture(),
    sql = await mysqlFixture();
  try {
    const pgctx = context("postgres", pg),
      mysqlctx = context("mysql", sql);
    for (const args of [
      ["-h", "evil", "-c", "SELECT 42"],
      ["-U", "other", "-c", "SELECT 42"],
      ["--password=secret", "-c", "SELECT 42"],
      ["postgres://other:secret@evil/db"],
      ["-c", "\\! cat broker-vault"],
      ["-c", "\\copy orders FROM '/broker/vault'"],
      ["-c", "COPY orders TO PROGRAM 'cat broker-vault'"],
      ["-c", "SELECT pg_read_file('/broker/vault')"],
      ["-c", "SELECT \"pg_read_file\"('/broker/vault')"],
      ["-c", "DO $$ BEGIN EXECUTE 'COPY orders TO PROGRAM'; END $$"],
      ["-f", "/broker/vault"],
    ]) {
      const response = await postgresAdapter.run(pgctx, operation(args));
      assert.equal(response.exitCode, 1);
    }
    for (const args of [
      ["-h", "evil", "-e", "SELECT 42"],
      ["--password=secret", "-e", "SELECT 42"],
      ["--defaults-file", "/broker/vault"],
      ["-e", "\\! cat broker-vault"],
      ["-e", "LOAD DATA LOCAL INFILE '/broker/vault' INTO TABLE orders"],
      ["-e", "SELECT LOAD_FILE('/broker/vault')"],
      ["-e", "SELECT 1 INTO OUTFILE '/broker/vault'"],
      [
        "-e",
        "/*!50000 LOAD DATA LOCAL INFILE '/broker/vault' INTO TABLE orders */",
      ],
      ["-f", "/broker/vault"],
    ]) {
      const response = await mysqlAdapter.run(mysqlctx, operation(args));
      assert.equal(response.exitCode, 1);
    }
    assert.equal(pg.authCount(), 0);
    assert.equal(sql.authCount(), 0);
  } finally {
    await pg.close();
    await sql.close();
  }
});

test("unsolicited MySQL LOCAL INFILE request cannot read a synthetic broker file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-mysql-infile-")),
    file = path.join(dir, "synthetic-vault.json");
  const sentinel = "synthetic-file-sentinel-do-not-send";
  await fs.writeFile(file, sentinel, { mode: 0o600 });
  const fixture = await mysqlFixture(file);
  try {
    const response = await mysqlAdapter.run(
      context("mysql", fixture),
      operation(["-e", "SELECT INFILE_ATTACK"]),
    );
    assert.equal(response.exitCode, 1);
    assert.equal(code(response), "DB_OPERATION_FAILED");
    assert.ok(!JSON.stringify(response).includes(sentinel));
    assert.equal(await fs.readFile(file, "utf8"), sentinel);
  } finally {
    await fixture.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Redis credential/configuration/target/local extensions are refused, including RESP batches", async () => {
  const fixture = await redisFixture();
  try {
    const ctx = context("redis", fixture);
    for (const args of [
      ["AUTH", "guess"],
      ["HELLO", "3", "AUTH", "default", "guess"],
      ["CONFIG", "GET", "requirepass"],
      ["ACL", "LIST"],
      ["MODULE", "LOAD", "/broker/library"],
      ["MIGRATE", "evil", "1", "key", "0", "100"],
      ["CLIENT", "REDIRECT", "1"],
      ["--user", "other", "GET", "key"],
      ["-u", "redis://evil", "GET", "key"],
      ["SELECT", "1"],
    ]) {
      assert.equal((await redisAdapter.run(ctx, operation(args))).exitCode, 1);
    }
    const batch = "*2\r\n$4\r\nAUTH\r\n$5\r\nguess\r\n";
    assert.equal(
      code(
        await redisAdapter.run(ctx, operation(["--pipe"], { input: batch })),
      ),
      "DB_COMMAND_DENIED",
    );
    assert.equal(
      code(
        await redisAdapter.run(
          ctx,
          operation(["--pipe"], { input: "*2\r\n$3\r\nGET\r\n$100\r\nshort" }),
        ),
      ),
      "DB_RESP_INPUT_INVALID",
    );
    assert.equal(fixture.authCount(), 0);
    // A '-h' occurring after a valid command is ordinary business data.
    assert.equal(
      (await redisAdapter.run(ctx, operation(["SET", "literal", "-h"])))
        .exitCode,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("driver errors and wrong authentication never echo credential or server error text", async () => {
  const fixtures = await Promise.all([
    postgresFixture(),
    mysqlFixture(),
    redisFixture(),
  ]);
  try {
    const adapters = [postgresAdapter, mysqlAdapter, redisAdapter],
      kinds = ["postgres", "mysql", "redis"] as const;
    for (let index = 0; index < adapters.length; index++) {
      const ctx = context(kinds[index], fixtures[index]);
      const args =
        kinds[index] === "redis"
          ? ["GET", "FAIL_FIXTURE"]
          : ["-c", "SELECT FAIL_FIXTURE"];
      const response = await adapters[index].run(ctx, operation(args));
      assert.equal(response.exitCode, 1);
      assert.equal(code(response), "DB_OPERATION_FAILED");
      // Only fixed classification codes are returned, never server text.
      assert.deepEqual(
        response.data,
        [
          {
            code: "DB_OPERATION_FAILED",
            category: "syntax",
            sqlState: "42601",
          },
          {
            code: "DB_OPERATION_FAILED",
            category: "syntax",
            sqlState: "42000",
            errno: 1064,
            driverCode: "ER_PARSE_ERROR",
          },
          { code: "DB_OPERATION_FAILED", category: "command", driverCode: "ERR" },
        ][index],
      );
      assert.match(response.stderr ?? "", /^DB_OPERATION_FAILED category=\w+/);
      assert.ok(!JSON.stringify(response).includes(FIXTURE_PASSWORD));
      assert.ok(!JSON.stringify(response).includes("fixture error"));
      const denied = await adapters[index].run(
        { ...ctx, secret: { password: "different-synthetic-password" } },
        operation(kinds[index] === "redis" ? ["PING"] : ["-c", "SELECT 42"]),
      );
      assert.equal(denied.exitCode, 1);
      assert.equal(code(denied), "DB_OPERATION_FAILED");
      if (kinds[index] !== "postgres")
        assert.equal(
          (denied.data as { category?: string }).category,
          "auth",
        );
      assert.ok(!JSON.stringify(denied).includes("different-synthetic-password"));
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
});

test("database cancellation, deadline and large-result errors have stable codes", async () => {
  const fixtures = await Promise.all([
    postgresFixture(),
    mysqlFixture(),
    redisFixture(),
  ]);
  try {
    const adapters = [postgresAdapter, mysqlAdapter, redisAdapter],
      kinds = ["postgres", "mysql", "redis"] as const;
    for (let index = 0; index < adapters.length; index++) {
      const controller = new AbortController(),
        ctx = context(kinds[index], fixtures[index], controller);
      const stalled =
        kinds[index] === "redis"
          ? ["GET", "STALL_FIXTURE"]
          : ["-c", "SELECT STALL_FIXTURE"];
      const promise = adapters[index].run(ctx, operation(stalled));
      setTimeout(() => controller.abort(), 80);
      assert.equal(code(await promise), "DB_CANCELLED");
      assert.equal(
        code(
          await adapters[index].run(
            context(kinds[index], fixtures[index]),
            operation(stalled, { timeoutMs: 150 }),
          ),
        ),
        "DB_TIMEOUT",
      );
      const large =
        kinds[index] === "redis"
          ? ["GET", "LARGE_FIXTURE"]
          : ["-c", "SELECT LARGE_FIXTURE"];
      assert.equal(
        code(
          await adapters[index].run(
            context(kinds[index], fixtures[index]),
            operation(large),
          ),
        ),
        "DB_OUTPUT_LIMIT",
      );
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
});

test("TLS is enabled by default, unverified/client config is rejected and local targets require fixture mode", async () => {
  const fixtures = await Promise.all([
    postgresFixture(),
    mysqlFixture(),
    redisFixture(),
  ]);
  try {
    const adapters = [postgresAdapter, mysqlAdapter, redisAdapter],
      kinds = ["postgres", "mysql", "redis"] as const;
    for (let index = 0; index < adapters.length; index++) {
      const ctx = context(kinds[index], fixtures[index]);
      assert.throws(
        () =>
          adapters[index].validate({
            ...ctx.connection,
            config: { ...ctx.connection.config, rejectUnauthorized: false },
          }),
        /DB_CONFIG_INVALID/,
      );
      const local = await adapters[index].run(
        { ...ctx, allowLocal: false },
        operation(kinds[index] === "redis" ? ["PING"] : ["-c", "SELECT 42"]),
      );
      assert.equal(code(local), "DB_LOCAL_TARGET_DISABLED");
      const mappedLocal = await adapters[index].run(
        {
          ...ctx,
          allowLocal: false,
          connection: {
            ...ctx.connection,
            config: { ...ctx.connection.config, host: "::ffff:7f00:1" },
          },
        },
        operation(kinds[index] === "redis" ? ["PING"] : ["-c", "SELECT 42"]),
      );
      assert.equal(code(mappedLocal), "DB_LOCAL_TARGET_DISABLED");
      const configuration = { ...ctx.connection.config };
      delete configuration.tls;
      const defaultTls = await adapters[index].run(
        { ...ctx, connection: { ...ctx.connection, config: configuration } },
        operation(kinds[index] === "redis" ? ["PING"] : ["-c", "SELECT 42"], {
          timeoutMs: 150,
        }),
      );
      assert.equal(defaultTls.exitCode, 1);
      assert.ok(!JSON.stringify(defaultTls).includes(FIXTURE_PASSWORD));
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
});
