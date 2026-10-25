import assert from "node:assert/strict";
import test from "node:test";
import { checkSql } from "../src/protocols/databases.js";

type Kind = "postgres" | "mysql";
function denied(kind: Kind, sql: string, code = "DB_LOCAL_EXTENSION_DENIED") {
  assert.throws(() => checkSql(sql, kind), { message: code });
}

test("MySQL arithmetic -- is not a comment without following whitespace/control", () => {
  for (const after of ["1", "+1", "é"]) {
    denied(
      "mysql",
      `SELECT 1--${after}; SELECT LOAD_FILE('/tmp/synthetic-review-file');`,
    );
  }
  for (const char of [" ", "\t", "\x01", "\x7f"]) {
    assert.doesNotThrow(() =>
      checkSql("SELECT 1--" + char + " LOAD_FILE('x')", "mysql"),
    );
  }
  for (const newline of ["\n", "\r", "\r\n"]) {
    denied("mysql", "SELECT 1-- comment" + newline + "SELECT LOAD_FILE('x');");
    denied("mysql", "SELECT 1--" + newline + "SELECT LOAD_FILE('x');");
    denied("mysql", "SELECT 1 # comment" + newline + "SELECT LOAD_FILE('x');");
  }
  assert.doesNotThrow(() => checkSql("SELECT 1--1; SELECT 2;", "mysql"));
});

test("PostgreSQL ordinary strings and quoted identifiers do not backslash-escape quotes", () => {
  denied(
    "postgres",
    String.raw`SELECT '\'; SELECT pg_read_file('/tmp/synthetic-review-file'); -- '`,
  );
  denied(
    "postgres",
    String.raw`SELECT "safe\"; SELECT pg_read_file('/tmp/synthetic-review-file'); -- "`,
  );
  assert.doesNotThrow(() =>
    checkSql(
      String.raw`SELECT '\' AS slash, 'it''s business' AS value; SELECT 2;`,
      "postgres",
    ),
  );
  assert.doesNotThrow(() =>
    checkSql(String.raw`SELECT 1 AS "safe\"; SELECT 2;`, "postgres"),
  );
});

test("PostgreSQL E-string escapes and native newline continuation retain correct boundaries", () => {
  assert.doesNotThrow(() =>
    checkSql(
      String.raw`SELECT E'it\'s text mentioning pg_read_file()'; SELECT 2;`,
      "postgres",
    ),
  );
  denied(
    "postgres",
    String.raw`SELECT E'it\'s text'; SELECT pg_read_file('x');`,
  );
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT E'first'\n'it\\'s pg_read_file() text'; SELECT 2;",
      "postgres",
    ),
  );
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT E'first' -- comment\r'it\\'s text'; SELECT 2;",
      "postgres",
    ),
  );
  denied(
    "postgres",
    "SELECT E'first'\n'it\\'s text'; SELECT pg_read_file('x');",
  );
  denied("postgres", "SELECT 'first'\n'\\'; SELECT pg_read_file('x'); -- '");
});

test("PostgreSQL Unicode escaped syntax is explicitly unsupported", () => {
  for (const sql of [
    String.raw`SELECT U&"pg_read\005ffile"('/tmp/synthetic-review-file');`,
    String.raw`SELECT u&"pg!005fread!005ffile" UESCAPE '!' ('x');`,
    String.raw`SELECT U&'business\0061';`,
    "SELECT $标签$business$标签$;",
  ])
    denied("postgres", sql, "DB_SQL_SYNTAX_UNSUPPORTED");
  assert.doesNotThrow(() =>
    checkSql(`SELECT 'U&"pg_read_file" is business text';`, "postgres"),
  );
});

test("dollar quotes require token boundary; comments and doubled identifiers cannot conceal extensions", () => {
  assert.doesNotThrow(() =>
    checkSql(
      String.raw`SELECT $tag$pg_read_file('\');$tag$; SELECT 2;`,
      "postgres",
    ),
  );
  denied("postgres", "SELECT foo$tag$; SELECT pg_read_file('x'); -- $tag$");
  denied("postgres", `SELECT pg_catalog."pg_read_file"('x');`);
  denied("mysql", "SELECT `LOAD_FILE`('x');");
  denied(
    "postgres",
    "SELECT 1; /* outer /* inner */ still comment */ SELECT pg_read_file('x');",
  );
  denied("mysql", "SELECT 1; /* business comment */ SELECT LOAD_FILE('x');");
  denied(
    "mysql",
    "SELECT /*!80400 LOAD_FILE('x') */ 1;",
    "DB_EXECUTABLE_COMMENT_DENIED",
  );
  denied(
    "postgres",
    String.raw`\! touch /tmp/synthetic-only`,
    "DB_CLIENT_META_COMMAND_DENIED",
  );
  denied(
    "postgres",
    String.raw`\copy orders TO '/tmp/synthetic-only'`,
    "DB_CLIENT_META_COMMAND_DENIED",
  );
});

test("MySQL strings support standard escaping but backtick identifiers only double their quote", () => {
  assert.doesNotThrow(() =>
    checkSql(
      String.raw`SELECT 'it\'s LOAD_FILE() text', "LOAD_FILE('x') is text"; SELECT 1--1;`,
      "mysql",
    ),
  );
  denied("mysql", String.raw`SELECT 'it\'s text'; SELECT LOAD_FILE('x');`);
  denied("mysql", "SELECT 1 AS `safe\\`; SELECT LOAD_FILE('x'); -- `");
  assert.doesNotThrow(() => checkSql("SELECT 1 AS `a``b`; SELECT 2;", "mysql"));
});

test("SQL calls cannot change fixed lexical modes or use dynamic PostgreSQL set_config", () => {
  for (const sql of [
    "SET standard_conforming_strings = off; SELECT 1;",
    'SET LOCAL "standard_conforming_strings" TO off;',
    "RESET standard_conforming_strings;",
    "RESET ALL;",
    "DISCARD ALL;",
    "SET client_encoding TO 'SJIS';",
    "SET NAMES 'SJIS';",
    "SET NAMES DEFAULT;",
    "SELECT set_config('standard_' || 'conforming_strings', 'off', false);",
    'SELECT pg_catalog."set_config"($1, $2, false);',
  ])
    denied("postgres", sql, "DB_SQL_MODE_DENIED");
  for (const sql of [
    "SET sql_mode='NO_BACKSLASH_ESCAPES'; SELECT 1;",
    "SET @@SESSION.sql_mode='ANSI_QUOTES';",
    "SET SESSION `sql_mode`=DEFAULT;",
    "SET NAMES 'gbk';",
    "SET CHARACTER SET 'gbk';",
    "SET character_set_client='gbk';",
    "SET @@SESSION.character_set_connection='gbk';",
    "SET collation_connection='gbk_chinese_ci';",
    "SET @@SESSION.collation_connection='gbk_chinese_ci';",
  ])
    denied("mysql", sql, "DB_SQL_MODE_DENIED");
  for (const kind of ["postgres", "mysql"] as const) {
    assert.doesNotThrow(() =>
      checkSql(
        "SELECT 'sql_mode standard_conforming_strings SET_CONFIG() SET NAMES' AS business; UPDATE orders SET status='sql_mode';",
        kind,
      ),
    );
    assert.doesNotThrow(() =>
      checkSql(
        "BEGIN; INSERT INTO orders(id,status) VALUES (1,'queued'); UPDATE orders SET status='complete'; DELETE FROM orders WHERE id=2; COMMIT;",
        kind,
      ),
    );
  }
  assert.doesNotThrow(() =>
    checkSql("SET statement_timeout=1000; SELECT $1;", "postgres"),
  );
  assert.doesNotThrow(() =>
    checkSql("SET @business_status='queued'; SELECT ?;", "mysql"),
  );
});

test("unterminated quotes, comments and dollar quotes fail before connecting", () => {
  for (const kind of ["postgres", "mysql"] as const) {
    denied(kind, "SELECT 'unterminated", "DB_SQL_UNTERMINATED");
    denied(kind, "SELECT /* unterminated", "DB_SQL_UNTERMINATED");
  }
  denied("postgres", "SELECT $tag$unterminated", "DB_SQL_UNTERMINATED");
});

test("known dynamic SQL entry points are unsupported; driver parameter binds and business identifiers remain allowed", () => {
  denied(
    "mysql",
    "PREPARE p FROM 'SELECT LOAD_FILE(''/tmp/synthetic-review-file'')'; EXECUTE p;",
    "DB_DYNAMIC_SQL_DENIED",
  );
  denied(
    "mysql",
    String.raw`PREPARE p FROM 'SET sql_mode=''NO_BACKSLASH_ESCAPES'''; EXECUTE p; SELECT '\'; SELECT LOAD_FILE('/tmp/synthetic-review-file'); -- ';`,
    "DB_DYNAMIC_SQL_DENIED",
  );
  denied("mysql", "EXECUTE p USING @business_value;", "DB_DYNAMIC_SQL_DENIED");
  denied("mysql", "DEALLOCATE PREPARE p;", "DB_DYNAMIC_SQL_DENIED");
  for (const name of [
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
  ]) {
    denied(
      "postgres",
      `SELECT ${name}($q$SELECT pg_read_file('/tmp/synthetic-review-file')$q$,true,false,'');`,
      "DB_DYNAMIC_SQL_DENIED",
    );
  }
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT load, copy, pg_read_file FROM jobs; SELECT $1;",
      "postgres",
    ),
  );
  assert.doesNotThrow(() =>
    checkSql("SELECT source, system, soname FROM events; SELECT ?;", "mysql"),
  );
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT 'PREPARE EXECUTE query_to_xml sql_mode' AS business;",
      "mysql",
    ),
  );
});

test("MySQL loadable functions reject AGGREGATE and IF NOT EXISTS variants without scanning SONAME data", () => {
  for (const aggregate of ["", "AGGREGATE "]) {
    for (const ifNotExists of ["", "IF NOT EXISTS "]) {
      for (const result of ["STRING", "INTEGER", "REAL", "DECIMAL"]) {
        denied(
          "mysql",
          `CREATE ${aggregate}FUNCTION ${ifNotExists}synthetic_probe RETURNS ${result} SONAME 'synthetic-review.so';`,
        );
      }
    }
  }
  denied(
    "mysql",
    "/* review */ CREATE /* comment */ AGGREGATE FUNCTION `synthetic_probe` RETURNS INTEGER SONAME 'synthetic-review.so';",
  );
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT soname, aggregate, source FROM events; SELECT 'CREATE AGGREGATE FUNCTION SONAME' AS text; CREATE TABLE `soname` (`aggregate` INT, `procedure` TEXT);",
      "mysql",
    ),
  );
});

test("stored programs and unsupported compound syntax cannot wrap dynamic SQL", () => {
  for (const sql of [
    "IF TRUE THEN PREPARE p FROM 'SELECT 1'; END IF;",
    "BEGIN IF TRUE THEN PREPARE p FROM 'SELECT 1'; END IF; END;",
    "routine_label: BEGIN PREPARE p FROM 'SELECT 1'; END;",
    "CREATE PROCEDURE synthetic_probe() BEGIN IF TRUE THEN PREPARE p FROM 'SELECT 1'; EXECUTE p; END IF; END;",
    "CREATE DEFINER = CURRENT_USER PROCEDURE synthetic_probe() BEGIN SELECT 1; END;",
    "CREATE FUNCTION synthetic_probe() RETURNS INTEGER RETURN 1;",
    "CREATE TRIGGER synthetic_probe BEFORE INSERT ON orders FOR EACH ROW SET NEW.id=1;",
    "CREATE EVENT synthetic_probe ON SCHEDULE EVERY 1 DAY DO SELECT 1;",
    "ALTER EVENT synthetic_probe DO SELECT 1;",
    "CALL synthetic_probe();",
    "WHILE TRUE DO SELECT 1; END WHILE;",
    "BEGIN NOT ATOMIC SELECT 1; END;",
    "DECLARE synthetic_probe INT;",
    "GRANT ALL ON business.* TO 'synthetic';",
  ])
    denied("mysql", sql, "DB_SQL_STATEMENT_UNSUPPORTED");
  for (const sql of [
    "CALL synthetic_probe();",
    "BEGIN ATOMIC SELECT 1; END;",
    "CREATE TRIGGER synthetic_probe BEFORE INSERT ON orders EXECUTE FUNCTION business_fn();",
    "CREATE EXTENSION dblink;",
    "GRANT pg_read_server_files TO synthetic_role;",
  ])
    denied("postgres", sql, "DB_SQL_STATEMENT_UNSUPPORTED");
  for (const sql of [
    "PREPARE p AS SELECT 1;",
    "EXECUTE p;",
    "DEALLOCATE p;",
    "EXPLAIN ANALYZE EXECUTE p;",
  ])
    denied("postgres", sql, "DB_DYNAMIC_SQL_DENIED");
});

test("PostgreSQL adminpack file and dblink call families are unsupported", () => {
  for (const name of [
    "pg_file_write",
    "pg_file_sync",
    "pg_file_rename",
    "pg_file_unlink",
    "pg_stat_file",
    "pg_ls_logdir",
    "pg_logdir_ls",
    "dblink",
    "dblink_exec",
    "dblink_send_query",
    "dblink_connect",
    "dblink_connect_u",
  ]) {
    denied("postgres", `SELECT ${name}('synthetic public argument');`);
    denied(
      "postgres",
      `SELECT extension_schema."${name}" ('synthetic public argument');`,
    );
  }
  denied(
    "postgres",
    "SELECT * FROM dblink('host=127.0.0.1 dbname=synthetic','SELECT 1') AS result(id int);",
  );
  assert.doesNotThrow(() =>
    checkSql(
      "SELECT pg_file_write, dblink, pg_stat_file FROM jobs; SELECT 'pg_file_write() dblink(connstr)' AS business_text;",
      "postgres",
    ),
  );
});

test("supported business statements keep quoted names, CTEs, DDL, explanations and single-call transactions", () => {
  const common = [
    "SELECT id, source FROM orders; INSERT INTO orders(id,status) SELECT id,'queued' FROM jobs; UPDATE orders SET status='complete'; DELETE FROM orders WHERE id=2;",
    "WITH selected AS (SELECT id FROM orders) SELECT id FROM selected;",
    "WITH selected AS (SELECT id FROM orders) INSERT INTO archive(id) SELECT id FROM selected;",
    "CREATE TABLE business (id INTEGER, soname TEXT); ALTER TABLE business ADD status TEXT; DROP TABLE IF EXISTS business; CREATE UNIQUE INDEX business_idx ON orders(id); DROP INDEX business_idx;",
    "CREATE VIEW business_view AS SELECT id FROM orders; DROP VIEW business_view;",
    "BEGIN; SAVEPOINT business_save; ROLLBACK TO SAVEPOINT business_save; RELEASE SAVEPOINT business_save; COMMIT;",
    "START TRANSACTION READ ONLY; SELECT 1; ROLLBACK;",
    "EXPLAIN SELECT id FROM orders; EXPLAIN ANALYZE SELECT id FROM orders;",
    "SELECT 'IF THEN PREPARE EXECUTE pg_file_write dblink SONAME' AS business_text;",
  ];
  for (const kind of ["postgres", "mysql"] as const) {
    for (const sql of common)
      assert.doesNotThrow(() => checkSql(sql, kind), sql);
    denied(
      kind,
      "EXPLAIN CALL synthetic_probe();",
      "DB_SQL_STATEMENT_UNSUPPORTED",
    );
    denied(
      kind,
      "EXPLAIN UNKNOWN_NATIVE_EXECUTE 1;",
      "DB_SQL_STATEMENT_UNSUPPORTED",
    );
    denied(
      kind,
      "WITH selected AS (SELECT 1) CALL synthetic_probe(SELECT);",
      "DB_SQL_STATEMENT_UNSUPPORTED",
    );
    denied(
      kind,
      "WITH selected AS (SELECT 1) UNKNOWN SELECT 1;",
      "DB_SQL_STATEMENT_UNSUPPORTED",
    );
  }
  for (const sql of [
    'WITH "SELECT"(id) AS (SELECT id FROM orders), selected AS (SELECT id FROM "SELECT") SELECT id FROM selected;',
    'CREATE TEMP TABLE "FUNCTION" ("pg_file_write" TEXT); SELECT "FUNCTION" FROM jobs;',
    "CREATE MATERIALIZED VIEW business_view AS SELECT id FROM orders; ALTER MATERIALIZED VIEW business_view RENAME TO business_view_two; DROP MATERIALIZED VIEW business_view_two;",
    "CREATE SEQUENCE business_seq; DROP SEQUENCE business_seq;",
    "EXPLAIN (ANALYZE false, FORMAT JSON) WITH selected AS (SELECT 1) SELECT * FROM selected;",
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY; SELECT $1; END;",
  ])
    assert.doesNotThrow(() => checkSql(sql, "postgres"), sql);
  for (const sql of [
    "WITH `SELECT`(id) AS (SELECT id FROM orders), selected AS (SELECT id FROM `SELECT`) SELECT id FROM selected;",
    "CREATE TEMPORARY TABLE `PROCEDURE` (`pg_file_write` TEXT); SELECT `PROCEDURE` FROM jobs;",
    "RENAME TABLE business_old TO business_new; EXPLAIN FORMAT=JSON SELECT ?;",
    "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ WRITE; SELECT ?; COMMIT AND NO CHAIN NO RELEASE;",
  ])
    assert.doesNotThrow(() => checkSql(sql, "mysql"), sql);
});

test("PostgreSQL CREATE SCHEMA supports complete headers and rejects embedded schema elements", () => {
  const trigger =
    "CREATE TRIGGER synthetic_probe BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION business_fn()";
  for (const sql of [
    "CREATE SCHEMA synthetic_review CREATE TABLE synthetic_orders(id int) CREATE TRIGGER synthetic_review_trigger BEFORE INSERT ON synthetic_orders FOR EACH ROW EXECUTE FUNCTION public.synthetic_existing_trigger_fn();",
    `CREATE SCHEMA business ${trigger};`,
    `CREATE SCHEMA AUTHORIZATION CURRENT_USER ${trigger};`,
    `CREATE SCHEMA business AUTHORIZATION application_role ${trigger};`,
    `CREATE SCHEMA IF NOT EXISTS business ${trigger};`,
    'CREATE /* outer */ SCHEMA "CREATE TRIGGER" AUTHORIZATION "role" /* nested */ CREATE /* comment */ TRIGGER "synthetic_probe" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION "business_fn"();',
    `CREATE SCHEMA business -- header\n /* nested /* inner */ comment */ ${trigger};`,
    "CREATE SCHEMA business CREATE TABLE orders(id integer);",
    "CREATE SCHEMA business CREATE VIEW jobs AS SELECT 'CREATE TRIGGER' AS business_text;",
    "CREATE SCHEMA business CREATE INDEX orders_idx ON orders(id);",
    "CREATE SCHEMA business CREATE SEQUENCE orders_seq;",
    "CREATE SCHEMA business GRANT SELECT ON orders TO application_role;",
  ])
    denied("postgres", sql, "DB_SQL_STATEMENT_UNSUPPORTED");
  for (const sql of [
    "CREATE SCHEMA business;",
    "CREATE SCHEMA IF NOT EXISTS business;",
    "CREATE SCHEMA business AUTHORIZATION application_role;",
    "CREATE SCHEMA IF NOT EXISTS business AUTHORIZATION application_role;",
    "CREATE SCHEMA AUTHORIZATION application_role;",
    "CREATE SCHEMA IF NOT EXISTS AUTHORIZATION application_role;",
    "CREATE SCHEMA business AUTHORIZATION CURRENT_ROLE; CREATE SCHEMA AUTHORIZATION CURRENT_USER; CREATE SCHEMA AUTHORIZATION SESSION_USER;",
    'CREATE /* business */ SCHEMA "CREATE TRIGGER" AUTHORIZATION "business role";',
    "CREATE SCHEMA 业务$schema AUTHORIZATION 业务角色;",
    "CREATE SCHEMA business; CREATE TABLE business.orders (id integer, \"TRIGGER\" text DEFAULT 'CREATE TRIGGER');",
    "SELECT 'CREATE SCHEMA business CREATE TRIGGER synthetic_probe' AS business_text; WITH selected AS (SELECT 'TRIGGER' AS value) SELECT value FROM selected;",
    'CREATE SCHEMA "name; CREATE TRIGGER"; SELECT "TRIGGER" FROM jobs;',
  ])
    assert.doesNotThrow(() => checkSql(sql, "postgres"), sql);
  // This PostgreSQL-only compatibility bound does not change MySQL schema SQL.
  assert.doesNotThrow(() =>
    checkSql("CREATE SCHEMA business DEFAULT CHARACTER SET utf8mb4;", "mysql"),
  );
});
