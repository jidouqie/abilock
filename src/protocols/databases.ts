import { lookup } from "node:dns/promises";
import { isIP, createConnection as connectSocket, type Socket } from "node:net";
import { assertResolvedTargetBoundary } from "../protocol-boundary.js";
import pg, { Client as PgClient, type QueryResult } from "pg";
import mysql from "mysql2/promise";
import type { ExecuteValues } from "mysql2";
import {
  createClient as createRedisClient,
  ErrorReply,
  RESP_TYPES,
} from "redis";
import { z } from "zod";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Connection,
  Credentials,
  Operation,
} from "../connections.js";

const MAX_OUTPUT = 16 * 1024 * 1024;
const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (host) =>
      isIP(host) !== 0 ||
      /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host),
  );
const transportFields = {
  host: hostSchema,
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().default(true),
  ca: z.string().min(1).max(100000).optional(),
  serverName: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/)
    .refine((name) => !isIP(name))
    .optional(),
};
const sqlConfigSchema = z
  .object({
    ...transportFields,
    user: z.string().min(1).max(128),
    database: z.string().min(1).max(128),
  })
  .strict();
const redisConfigSchema = z
  .object({
    ...transportFields,
    username: z.string().min(1).max(128).optional(),
    database: z.number().int().min(0).max(2147483647).default(0),
  })
  .strict();
type SqlConfig = z.infer<typeof sqlConfigSchema>;
type RedisConfig = z.infer<typeof redisConfigSchema>;

function fail(code: string): never {
  throw new Error(code);
}

function parseConfig<T>(
  schema: z.ZodType<T>,
  connection: Connection,
  kind: string,
): T {
  if (connection.kind !== kind) fail("DB_CONFIG_KIND");
  const parsed = schema.safeParse(connection.config);
  if (!parsed.success) fail("DB_CONFIG_INVALID");
  return parsed.data;
}

function checkSecret(secret?: Credentials) {
  if (
    secret &&
    Object.keys(secret).some((key) => !["password", "username"].includes(key))
  ) {
    fail("DB_CREDENTIALS_INVALID");
  }
}

async function fixedAddress(
  host: string,
  allowLocal: boolean,
): Promise<string> {
  // Resolve once and pass only that address to the client. The TLS identity remains
  // the administrator's original hostname. Private networks are valid DB targets.
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  try {
    assertResolvedTargetBoundary(addresses, { allowLocalFixture: allowLocal });
  } catch {
    fail("DB_LOCAL_TARGET_DISABLED");
  }
  return addresses[0].address;
}

function timer(
  context: AdapterContext,
  operation: Operation,
  close: () => void,
) {
  let timedOut = false;
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    close();
  };
  context.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, operation.timeoutMs);
  timeout.unref();
  if (context.signal.aborted) abort();
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted)
        fail(timedOut ? "DB_TIMEOUT" : "DB_CANCELLED");
    },
    dispose() {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
    },
    code() {
      return timedOut
        ? "DB_TIMEOUT"
        : context.signal.aborted
          ? "DB_CANCELLED"
          : undefined;
    },
    async wait<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted)
        fail(timedOut ? "DB_TIMEOUT" : "DB_CANCELLED");
      return new Promise<T>((resolve, reject) => {
        const rejectAbort = () =>
          reject(new Error(timedOut ? "DB_TIMEOUT" : "DB_CANCELLED"));
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
        promise.then(
          (value) => {
            controller.signal.removeEventListener("abort", rejectAbort);
            resolve(value);
          },
          (error) => {
            controller.signal.removeEventListener("abort", rejectAbort);
            reject(error);
          },
        );
      });
    },
  };
}

function result(data: unknown): AdapterResult {
  const stdout =
    JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      return value;
    }) + "\n";
  if (Buffer.byteLength(stdout) > MAX_OUTPUT) fail("DB_OUTPUT_LIMIT");
  return { exitCode: 0, stdout, data };
}

type DbKind = "postgres" | "mysql" | "redis";
type DbDiagnostic = {
  category:
    | "auth"
    | "permission"
    | "connection"
    | "tls"
    | "undefined_object"
    | "syntax"
    | "constraint"
    | "data"
    | "transaction"
    | "resource"
    | "command"
    | "unknown";
  sqlState?: string;
  driverCode?: string;
  errno?: number;
};
const SQLSTATE = /^[0-9A-Z]{5}$/;
const DRIVER_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
]);
// Fixed, server-independent classifications only. Driver and server message
// text is never returned: it can echo SQL, URIs, passwords or business data.
function diagnose(kind: DbKind, error: unknown): DbDiagnostic {
  const found: Omit<DbDiagnostic, "category"> = {};
  if (error instanceof Error) {
    const fields = error as Error & {
      code?: unknown;
      errno?: unknown;
      sqlState?: unknown;
    };
    if (
      kind === "postgres" &&
      error instanceof pg.DatabaseError &&
      typeof fields.code === "string" &&
      SQLSTATE.test(fields.code)
    )
      found.sqlState = fields.code;
    if (kind === "mysql" && typeof fields.sqlState === "string" && SQLSTATE.test(fields.sqlState))
      found.sqlState = fields.sqlState;
    if (
      kind === "mysql" &&
      typeof fields.errno === "number" &&
      Number.isSafeInteger(fields.errno) &&
      fields.errno > 0 &&
      fields.errno < 100000
    )
      found.errno = fields.errno;
    const reply =
      kind === "redis" && error instanceof ErrorReply
        ? /^([A-Z][A-Z_]{1,31})(?:\s|$)/.exec(error.message)?.[1]
        : undefined;
    if (reply) found.driverCode = reply;
    // PostgreSQL reports its SQLSTATE in `code`; other values are client-side
    // constants such as ECONNREFUSED, ER_PARSE_ERROR or TLS verification codes.
    else if (
      !(kind === "postgres" && found.sqlState) &&
      typeof fields.code === "string" &&
      DRIVER_CODE.test(fields.code)
    )
      found.driverCode = fields.code;
  }
  const state = found.sqlState ?? "",
    code = found.driverCode ?? "",
    errno = found.errno ?? 0;
  const category: DbDiagnostic["category"] =
    state.startsWith("28") ||
    [1045, 1698].includes(errno) ||
    ["WRONGPASS", "NOAUTH"].includes(code)
      ? "auth"
      : state === "42501" ||
          [1044, 1142, 1143, 1227].includes(errno) ||
          code === "NOPERM"
        ? "permission"
        : state.startsWith("08") || CONNECTION_CODES.has(code)
          ? "connection"
          : /CERT|SSL|TLS/.test(code)
            ? "tls"
            : ["42P01", "42703", "42883", "42704", "3D000", "3F000", "42S02", "42S22"].includes(state) ||
                [1046, 1049, 1054, 1146].includes(errno)
              ? "undefined_object"
              : state.startsWith("42") || errno === 1064
                ? "syntax"
                : state.startsWith("23")
                  ? "constraint"
                  : state.startsWith("22")
                    ? "data"
                    : state.startsWith("40") || state.startsWith("25")
                      ? "transaction"
                      : state.startsWith("53") || state.startsWith("54") || code === "OOM"
                        ? "resource"
                        : kind === "redis" && code
                          ? "command"
                          : "unknown";
  return { category, ...found };
}

function safeError(
  kind: DbKind,
  error: unknown,
  timeoutCode?: string,
): AdapterResult {
  const message = error instanceof Error ? error.message : "";
  const code =
    timeoutCode ??
    (/^DB_[A-Z_]+$/.test(message) ? message : "DB_OPERATION_FAILED");
  if (code !== "DB_OPERATION_FAILED")
    return { exitCode: 1, stderr: code + "\n", data: { code } };
  const detail = diagnose(kind, error);
  const summary = [
    code,
    `category=${detail.category}`,
    ...(detail.sqlState ? [`sqlState=${detail.sqlState}`] : []),
    ...(detail.errno ? [`errno=${detail.errno}`] : []),
    ...(detail.driverCode ? [`driverCode=${detail.driverCode}`] : []),
  ].join(" ");
  return { exitCode: 1, stderr: summary + "\n", data: { code, ...detail } };
}

function uploadedSql(operation: Operation, name: string) {
  if (name === "-") {
    if (operation.input === undefined) fail("DB_INPUT_REQUIRED");
    return operation.input;
  }
  const matches = (operation.files ?? []).filter((file) => file.path === name);
  if (matches.length !== 1) fail("DB_UPLOADED_FILE_REQUIRED");
  const file = matches[0];
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      file.base64,
    )
  ) {
    fail("DB_FILE_ENCODING");
  }
  const bytes = Buffer.from(file.base64, "base64");
  const sql = bytes.toString("utf8");
  if (!Buffer.from(sql).equals(bytes)) fail("DB_FILE_ENCODING");
  return sql;
}

type SqlOperation = { text: string; values?: unknown[] };
function sqlOperation(
  operation: Operation,
  kind: "postgres" | "mysql",
): SqlOperation {
  const texts: string[] = [];
  let values: unknown[] | undefined;
  let usedInput = false;
  for (let index = 0; index < operation.args.length; index++) {
    const arg = operation.args[index];
    const commandOptions =
      kind === "postgres"
        ? ["-c", "--command"]
        : ["-e", "--execute", "-c", "--command"];
    const equalsCommand = commandOptions.find(
      (option) => option.startsWith("--") && arg.startsWith(option + "="),
    );
    if (commandOptions.includes(arg) || equalsCommand) {
      const text = equalsCommand
        ? arg.slice(equalsCommand.length + 1)
        : operation.args[++index];
      if (text === undefined || !text.trim()) fail("DB_SQL_REQUIRED");
      texts.push(text);
    } else if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) {
      const name = arg.startsWith("--file=")
        ? arg.slice(7)
        : operation.args[++index];
      if (!name) fail("DB_UPLOADED_FILE_REQUIRED");
      texts.push(uploadedSql(operation, name));
      usedInput ||= name === "-";
    } else if (arg === "--params" || arg.startsWith("--params=")) {
      if (values !== undefined) fail("DB_ARGUMENT_INVALID");
      const json = arg.startsWith("--params=")
        ? arg.slice(9)
        : operation.args[++index];
      try {
        const parsed: unknown = JSON.parse(json ?? "");
        if (!Array.isArray(parsed) || parsed.length > 10000)
          fail("DB_PARAMS_INVALID");
        values = parsed;
      } catch {
        fail("DB_PARAMS_INVALID");
      }
    } else if (
      [
        "-A",
        "--no-align",
        "-t",
        "--tuples-only",
        "-X",
        "--no-psqlrc",
        "-q",
        "--quiet",
        "-B",
        "--batch",
        "-N",
        "--skip-column-names",
      ].includes(arg)
    ) {
      // These formatting/startup flags are safe; broker output is always JSON.
    } else {
      // No native executable is launched. Strict parsing also rejects connection,
      // password, rc-file, output-file, shell and arbitrary positional overrides.
      fail("DB_ARGUMENT_DENIED");
    }
  }
  if (operation.input !== undefined && !usedInput) {
    if (texts.length) fail("DB_INPUT_AMBIGUOUS");
    texts.push(operation.input);
  }
  if (!texts.length || texts.some((text) => !text.trim()))
    fail("DB_SQL_REQUIRED");
  if (values && texts.length !== 1) fail("DB_PARAMS_SINGLE_STATEMENT");
  const text = texts.join("\n;\n");
  if (Buffer.byteLength(text) > 16 * 1024 * 1024 || text.includes("\0"))
    fail("DB_SQL_SIZE");
  checkSql(text, kind);
  return { text, values };
}

// A lexer, not a complete SQL authorization system. Literal text is preserved on
// the wire but excluded from checks, so ordinary business data is not scanned.
function sqlTokens(text: string, kind: "postgres" | "mysql") {
  let output = "";
  // Classification must distinguish SQL keywords from quoted identifiers and
  // literals. The other stream retains identifier names for known-call checks.
  let structure = "";
  let index = 0;
  const identifierPart = (char: string | undefined) =>
    char !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(char);
  // PostgreSQL continues a single-quoted literal across a newline, including
  // -- comments, retaining its original E-string escape mode. Block comments
  // are not part of quotecontinue in the PostgreSQL scanner.
  const pgContinuation = (start: number) => {
    let cursor = start;
    let newline = false;
    while (cursor < text.length) {
      if (/[ \t\n\r\f]/.test(text[cursor])) {
        if (text[cursor] === "\n" || text[cursor] === "\r") newline = true;
        cursor++;
      } else if (text[cursor] === "-" && text[cursor + 1] === "-") {
        while (cursor < text.length && !/[\r\n]/.test(text[cursor])) cursor++;
      } else break;
    }
    return newline && text[cursor] === "'" ? cursor + 1 : undefined;
  };
  while (index < text.length) {
    const char = text[index],
      next = text[index + 1];
    if (char === "\\") fail("DB_CLIENT_META_COMMAND_DENIED");
    if (
      kind === "postgres" &&
      /[uU]/.test(char) &&
      next === "&" &&
      ["'", '"'].includes(text[index + 2]) &&
      !identifierPart(text[index - 1])
    )
      fail("DB_SQL_SYNTAX_UNSUPPORTED");
    const afterDashes = text[index + 2]?.charCodeAt(0);
    const dashComment =
      char === "-" &&
      next === "-" &&
      (kind === "postgres" ||
        (afterDashes !== undefined &&
          (afterDashes <= 32 || afterDashes === 127)));
    if (dashComment || (kind === "mysql" && char === "#")) {
      while (index < text.length && !/[\r\n]/.test(text[index])) index++;
      output += " ";
      structure += " ";
    } else if (char === "/" && next === "*") {
      if (kind === "mysql" && text[index + 2] === "!")
        fail("DB_EXECUTABLE_COMMENT_DENIED");
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (
          text[index] === "/" &&
          text[index + 1] === "*" &&
          kind === "postgres"
        ) {
          depth++;
          index += 2;
        } else if (text[index] === "*" && text[index + 1] === "/") {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth) fail("DB_SQL_UNTERMINATED");
      output += " ";
      structure += " ";
    } else if (
      char === "'" ||
      char === '"' ||
      (kind === "mysql" && char === "`")
    ) {
      const quote = char;
      const identifier = kind === "postgres" ? char === '"' : char === "`";
      const escapes =
        !identifier &&
        (kind === "mysql" ||
          (/[eE]/.test(text[index - 1] ?? "") &&
            !identifierPart(text[index - 2])));
      let content = "";
      index++;
      let closed = false;
      while (index < text.length) {
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            content += quote;
            index += 2;
          } else {
            index++;
            if (kind === "postgres" && quote === "'") {
              const continuation = pgContinuation(index);
              if (continuation !== undefined) {
                index = continuation;
                continue;
              }
            }
            closed = true;
            break;
          }
        } else if (text[index] === "\\" && escapes) {
          // Only MySQL strings and PG E'...' consume backslash escapes. PG
          // ordinary strings use standard_conforming_strings=on; identifiers
          // escape their delimiter by doubling it, never with a backslash.
          content += " ";
          index += 2;
        } else content += text[index++];
      }
      if (!closed) fail("DB_SQL_UNTERMINATED");
      output += identifier ? " " + content.replaceAll(";", " ") + " " : " ";
      structure += identifier ? " _PV_IDENTIFIER_ " : " _PV_LITERAL_ ";
    } else if (
      kind === "postgres" &&
      char === "$" &&
      !identifierPart(text[index - 1]) &&
      /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.test(
        text.slice(index),
      )
    ) {
      const delimiter =
        /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(
          text.slice(index),
        )![0];
      if ([...delimiter].some((char) => char.charCodeAt(0) > 127))
        fail("DB_SQL_SYNTAX_UNSUPPORTED");
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end < 0) fail("DB_SQL_UNTERMINATED");
      index = end + delimiter.length;
      output += " ";
      structure += " _PV_LITERAL_ ";
    } else {
      output += char;
      structure += char;
      index++;
    }
  }
  return { calls: output.toUpperCase(), structure: structure.toUpperCase() };
}

// A deliberately small statement classifier, not a SQL parser or a proof of
// database-side effects. Unrecognized control/administration syntax never falls
// through as an ordinary query. Existing views, triggers and arbitrary functions
// remain governed by the independent database's role privileges.
function topLevelSqlWords(statement: string) {
  let depth = 0;
  const words: string[] = [];
  for (const token of statement.match(/[A-Z_][A-Z0-9_$]*|[()]/g) ?? []) {
    if (token === "(") depth++;
    else if (token === ")") {
      if (!depth) fail("DB_SQL_SYNTAX_UNSUPPORTED");
      depth--;
    } else if (!depth) words.push(token);
  }
  if (depth) fail("DB_SQL_SYNTAX_UNSUPPORTED");
  return words;
}

function cteOuterStatement(statement: string) {
  const pieces = [
    ...statement.matchAll(
      /[A-Z_\u0080-\uFFFF][A-Z0-9_$\u0080-\uFFFF]*|[(),]|[^\s]/g,
    ),
  ];
  let cursor = 1; // WITH
  if (pieces[cursor]?.[0] === "RECURSIVE") cursor++;
  const group = () => {
    if (pieces[cursor]?.[0] !== "(") return false;
    let depth = 0;
    do {
      if (pieces[cursor]?.[0] === "(") depth++;
      else if (pieces[cursor]?.[0] === ")") depth--;
      cursor++;
    } while (depth && cursor < pieces.length);
    return depth === 0;
  };
  while (cursor < pieces.length) {
    const name = pieces[cursor++]?.[0];
    if (
      !name ||
      name === "_PV_LITERAL_" ||
      !/^[A-Z_\u0080-\uFFFF][A-Z0-9_$\u0080-\uFFFF]*$/.test(name)
    )
      return;
    if (pieces[cursor]?.[0] === "(" && !group()) return;
    if (pieces[cursor++]?.[0] !== "AS") return;
    if (pieces[cursor]?.[0] === "NOT") cursor++;
    if (pieces[cursor]?.[0] === "MATERIALIZED") cursor++;
    if (!group()) return;
    if (pieces[cursor]?.[0] === ",") cursor++;
    else
      return statement.slice(pieces[cursor]?.index ?? statement.length).trim();
  }
}

function simplePostgresCreateSchema(statement: string) {
  // PostgreSQL permits schema_element DDL without semicolons. Support only the
  // complete schema header so a nested CREATE TRIGGER/GRANT cannot inherit the
  // outer CREATE SCHEMA classification. Quoted names are lexer placeholders.
  const name =
    "(?:(?!_PV_LITERAL_(?:\\s|$))[A-Z_\\u0080-\\uFFFF][A-Z0-9_$\\u0080-\\uFFFF]*)";
  return new RegExp(
    "^CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:AUTHORIZATION\\s+" +
      name +
      "|" +
      name +
      "(?:\\s+AUTHORIZATION\\s+" +
      name +
      ")?)\\s*$",
  ).test(statement);
}

function supportedSqlStatement(statement: string, kind: "postgres" | "mysql") {
  const normalized = statement.trim();
  if (!normalized) return;
  const words = topLevelSqlWords(normalized);
  const first = words[0];
  if (/^(?:PREPARE|EXECUTE|DEALLOCATE)$/.test(first ?? ""))
    fail("DB_DYNAMIC_SQL_DENIED");
  const query = /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE|VALUES|TABLE)$/;
  if (query.test(first ?? "")) return;
  if (first === "WITH") {
    // Recognize the simple CTE list, skip each balanced body and independently
    // classify its actual outer query. SEARCH/CYCLE and unknown wrappers are
    // deliberately unsupported instead of searching for any allowed keyword.
    const outer = cteOuterStatement(normalized);
    if (outer && query.test(topLevelSqlWords(outer)[0] ?? "")) return;
  } else if (first === "EXPLAIN") {
    // Parenthesized PostgreSQL options and the supported plain option words are
    // skipped, then the explained statement is independently classified.
    const wrapper =
      /^EXPLAIN\b\s*(?:\([^)]*\)\s*)?(?:(?:ANALYZE|ANALYSE|VERBOSE|EXTENDED|PARTITIONS)\b\s*|FORMAT\s*=\s*(?:JSON|TREE|TRADITIONAL)\b\s*)*/;
    const remainder = normalized.replace(wrapper, "");
    if (remainder !== normalized && remainder.trim()) {
      const inner = topLevelSqlWords(remainder)[0];
      if (query.test(inner ?? "") || inner === "WITH") {
        supportedSqlStatement(remainder, kind);
        return;
      }
      if (/^(?:PREPARE|EXECUTE|DEALLOCATE)$/.test(inner ?? ""))
        fail("DB_DYNAMIC_SQL_DENIED");
    }
  } else if (/^(?:CREATE|ALTER|DROP)$/.test(first ?? "")) {
    const match =
      /^(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:(TEMP|TEMPORARY|UNLOGGED|UNIQUE|MATERIALIZED)\s+)?(TABLE|INDEX|VIEW|SCHEMA|DATABASE|SEQUENCE)\b/.exec(
        normalized,
      );
    if (match) {
      const [, verb, modifier, object] = match;
      const validModifier =
        !modifier ||
        (verb === "CREATE" &&
          (((modifier === "TEMP" ||
            modifier === "TEMPORARY" ||
            modifier === "UNLOGGED") &&
            object === "TABLE") ||
            (modifier === "UNIQUE" && object === "INDEX") ||
            (kind === "postgres" &&
              modifier === "MATERIALIZED" &&
              object === "VIEW"))) ||
        (kind === "postgres" &&
          modifier === "MATERIALIZED" &&
          object === "VIEW");
      if (validModifier) {
        if (
          kind === "postgres" &&
          verb === "CREATE" &&
          object === "SCHEMA" &&
          !simplePostgresCreateSchema(normalized)
        )
          fail("DB_SQL_STATEMENT_UNSUPPORTED");
        return;
      }
    }
  } else if (
    /^(?:SHOW|DESCRIBE|DESC|SET|RESET|TRUNCATE|ANALYZE|ANALYSE|VACUUM|REINDEX)$/.test(
      first ?? "",
    )
  ) {
    return;
  } else if (
    first === "RENAME" &&
    /^RENAME\s+TABLE\b/.test(normalized) &&
    kind === "mysql"
  ) {
    return;
  } else if (first === "BEGIN" || first === "START") {
    const option =
      "(?:ISOLATION\\s+LEVEL\\s+(?:SERIALIZABLE|REPEATABLE\\s+READ|READ\\s+(?:COMMITTED|UNCOMMITTED))|READ\\s+(?:ONLY|WRITE)|(?:NOT\\s+)?DEFERRABLE|WITH\\s+CONSISTENT\\s+SNAPSHOT)";
    const transaction = new RegExp(
      "^(?:BEGIN(?:\\s+(?:WORK|TRANSACTION))?|START\\s+TRANSACTION)(?:\\s+" +
        option +
        "(?:(?:\\s*,\\s*|\\s+)" +
        option +
        ")*)?\\s*$",
    );
    if (transaction.test(normalized)) return;
  } else if (/^(?:COMMIT|END)$/.test(first ?? "")) {
    if (
      /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?(?:\s+(?:NO\s+)?RELEASE)?\s*$/.test(
        normalized,
      )
    )
      return;
  } else if (first === "ROLLBACK") {
    if (
      /^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?(?:(?:\s+AND\s+(?:NO\s+)?CHAIN)?(?:\s+(?:NO\s+)?RELEASE)?|\s+TO\s+(?:SAVEPOINT\s+)?(?:[A-Z_][A-Z0-9_$]*|_PV_IDENTIFIER_))\s*$/.test(
        normalized,
      )
    )
      return;
  } else if (first === "SAVEPOINT" || first === "RELEASE") {
    if (
      /^(?:SAVEPOINT|RELEASE\s+(?:SAVEPOINT\s+)?)(?:\s+)?(?:[A-Z_][A-Z0-9_$]*|_PV_IDENTIFIER_)\s*$/.test(
        normalized,
      )
    )
      return;
  }
  fail("DB_SQL_STATEMENT_UNSUPPORTED");
}

// Pure validation entry point: no connection, filesystem, process or credentials.
export function checkSql(text: string, kind: "postgres" | "mysql") {
  const lexical = sqlTokens(text, kind);
  const tokens = lexical.calls;
  const statements = tokens.split(";");
  const changesLexicalMode = statements.some((statement) =>
    kind === "postgres"
      ? (/^\s*(?:SET|RESET)\b/.test(statement) &&
          /\b(?:STANDARD_CONFORMING_STRINGS|CLIENT_ENCODING|NAMES|ALL)\b/.test(
            statement,
          )) ||
        /^\s*DISCARD\s+ALL\b/.test(statement)
      : /^\s*SET\b/.test(statement) &&
        /\b(?:SQL_MODE|NAMES|CHARACTER\s+SET|CHARACTER_SET_CLIENT|CHARACTER_SET_CONNECTION|CHARACTER_SET_RESULTS|COLLATION_CONNECTION)\b/.test(
          statement,
        ),
  );
  if (
    changesLexicalMode ||
    (kind === "postgres" && /\bSET_CONFIG\s*\(/.test(tokens))
  )
    fail("DB_SQL_MODE_DENIED");
  if (kind === "postgres") {
    if (
      /\b(?:PG_READ_(?:BINARY_)?FILE|PG_LS_[A-Z_]+|PG_STAT_FILE|PG_FILE_[A-Z_]+|PG_LOGDIR_LS|LO_IMPORT|LO_EXPORT|DBLINK(?:_[A-Z_]+)?)\s*\(/.test(
        tokens,
      ) ||
      statements.some(
        (statement) =>
          /^\s*(?:COPY|DO|LOAD)\b/.test(statement) ||
          /^\s*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|SERVER|FOREIGN\s+DATA\s+WRAPPER)\b/.test(
            statement,
          ),
      )
    )
      fail("DB_LOCAL_EXTENSION_DENIED");
    if (
      /\b(?:QUERY_TO_XML|QUERY_TO_XMLSCHEMA|QUERY_TO_XML_AND_XMLSCHEMA)\s*\(/.test(
        tokens,
      )
    )
      fail("DB_DYNAMIC_SQL_DENIED");
  } else if (
    /\bLOAD_FILE\s*\(/.test(tokens) ||
    /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/.test(tokens) ||
    statements.some(
      (statement) =>
        /^\s*(?:LOAD\s+(?:DATA|XML)|INSTALL\s+(?:PLUGIN|COMPONENT)|UNINSTALL\s+(?:PLUGIN|COMPONENT)|SOURCE|SYSTEM)\b/.test(
          statement,
        ) ||
        (/^\s*CREATE\s+(?:AGGREGATE\s+)?FUNCTION\b/.test(statement) &&
          /\bSONAME\b/.test(statement)),
    )
  ) {
    fail("DB_LOCAL_EXTENSION_DENIED");
  }
  for (const statement of lexical.structure.split(";"))
    supportedSqlStatement(statement, kind);
}

function sqlValidate(
  connection: Connection,
  secret: Credentials | undefined,
  kind: "postgres" | "mysql",
) {
  const config = parseConfig(sqlConfigSchema, connection, kind);
  if (kind === "mysql" && config.tls && isIP(config.host) && !config.serverName)
    fail("DB_TLS_SERVERNAME_REQUIRED");
  checkSecret(secret);
}

export const postgresAdapter: Adapter = {
  validate(connection, secret) {
    sqlValidate(connection, secret, "postgres");
  },
  async run(context, operation) {
    let client: PgClient | undefined;
    const deadline = timer(context, operation, () => {
      void client?.end().catch(() => undefined);
    });
    try {
      deadline.check();
      const config = parseConfig(
        sqlConfigSchema,
        context.connection,
        "postgres",
      );
      checkSecret(context.secret);
      if (!context.secret.password) fail("DB_CREDENTIALS_MISSING");
      const query = sqlOperation(operation, "postgres");
      const address = await deadline.wait(
        fixedAddress(config.host, context.allowLocal),
      );
      deadline.check();
      client = new PgClient({
        host: address,
        port: config.port ?? 5432,
        user: config.user,
        database: config.database,
        // A non-empty supplied password prevents node-postgres's pgpass fallback.
        password: context.secret.password,
        ssl: config.tls
          ? {
              rejectUnauthorized: true,
              host: config.serverName ?? config.host,
              ...(!isIP(config.serverName ?? config.host)
                ? { servername: config.serverName ?? config.host }
                : {}),
              ...(config.ca ? { ca: config.ca } : {}),
            }
          : false,
        connectionTimeoutMillis: operation.timeoutMs,
        query_timeout: operation.timeoutMs,
        statement_timeout: operation.timeoutMs,
        application_name: "abilock",
        enableChannelBinding: true,
        sslnegotiation: "postgres",
        client_encoding: "UTF8",
        options: "-c standard_conforming_strings=on",
        ...{ replication: "false" },
      });
      client.on("error", () => undefined);
      await deadline.wait(client.connect());
      deadline.check();
      const response = await deadline.wait(
        client.query(query.text, query.values),
      );
      deadline.check();
      const responses = (
        Array.isArray(response) ? response : [response]
      ) as QueryResult<Record<string, unknown>>[];
      return result(
        responses.map((item) => ({
          command: item.command,
          rowCount: item.rowCount,
          fields: item.fields.map((field) => ({
            name: field.name,
            dataTypeID: field.dataTypeID,
          })),
          rows: item.rows,
        })),
      );
    } catch (error) {
      return safeError("postgres", error, deadline.code());
    } finally {
      deadline.dispose();
      void client?.end().catch(() => undefined);
    }
  },
};

export const mysqlAdapter: Adapter = {
  validate(connection, secret) {
    sqlValidate(connection, secret, "mysql");
  },
  async run(context, operation) {
    let client: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
    let socket: Socket | undefined;
    const deadline = timer(context, operation, () => {
      client?.destroy();
      socket?.destroy();
    });
    try {
      deadline.check();
      const config: SqlConfig = parseConfig(
        sqlConfigSchema,
        context.connection,
        "mysql",
      );
      if (config.tls && isIP(config.host) && !config.serverName)
        fail("DB_TLS_SERVERNAME_REQUIRED");
      checkSecret(context.secret);
      const query = sqlOperation(operation, "mysql");
      const address = await deadline.wait(
        fixedAddress(config.host, context.allowLocal),
      );
      deadline.check();
      client = await deadline.wait(
        mysql.createConnection({
          host: config.serverName ?? config.host,
          port: config.port ?? 3306,
          user: config.user,
          database: config.database,
          stream: () => {
            socket = connectSocket({
              host: address,
              port: config.port ?? 3306,
            });
            return socket;
          },
          password: context.secret.password ?? "",
          connectTimeout: operation.timeoutMs,
          ssl: config.tls
            ? {
                rejectUnauthorized: true,
                verifyIdentity: true,
                ...(config.ca ? { ca: config.ca } : {}),
              }
            : undefined,
          multipleStatements: query.values === undefined,
          // The protocol client never reads LOCAL INFILE paths from disk.
          flags: ["-LOCAL_FILES"],
          // No infileStreamFactory is provided: mysql2 refuses even an unsolicited
          // server LOCAL INFILE request and sends an empty packet, never a disk read.
          supportBigNumbers: true,
          bigNumberStrings: true,
          charset: "utf8mb4",
        }),
      );
      deadline.check();
      // Match the lexer even when the server's global defaults enable either
      // alternate quoting mode; preserve all other administrator SQL modes.
      await deadline.wait(
        client.query(
          "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','), ',ANSI_QUOTES,', ','))",
        ),
      );
      deadline.check();
      const [rows, fields] = await deadline.wait(
        query.values === undefined
          ? client.query(query.text)
          : client.execute(query.text, query.values as ExecuteValues[]),
      );
      deadline.check();
      return result({
        rows,
        fields: Array.isArray(fields)
          ? fields.map((field) =>
              Array.isArray(field)
                ? field.map((item) => ({ name: item.name, type: item.type }))
                : field
                  ? { name: field.name, type: field.type }
                  : [],
            )
          : [],
      });
    } catch (error) {
      return safeError("mysql", error, deadline.code());
    } finally {
      deadline.dispose();
      client?.destroy();
      socket?.destroy();
    }
  },
};

const REDIS_DENIED = new Set([
  "AUTH",
  "HELLO",
  "ACL",
  "CONFIG",
  "MODULE",
  "DEBUG",
  "MONITOR",
  "MIGRATE",
  "REPLICAOF",
  "SLAVEOF",
  "SYNC",
  "PSYNC",
  "REPLCONF",
  "SHUTDOWN",
  "SAVE",
  "BGSAVE",
  "BGREWRITEAOF",
  "CLUSTER",
  "SELECT",
  "CLIENT",
  "SENTINEL",
  "SUBSCRIBE",
  "PSUBSCRIBE",
  "SSUBSCRIBE",
  "UNSUBSCRIBE",
  "PUNSUBSCRIBE",
  "SUNSUBSCRIBE",
]);
const REDIS_MULTI_REQUEST = new Set([
  "MULTI",
  "EXEC",
  "DISCARD",
  "WATCH",
  "UNWATCH",
  "QUIT",
  "RESET",
]);
function redisCommand(args: (string | Buffer)[]) {
  if (!args.length) fail("DB_ARGUMENT_DENIED");
  const name = args[0].toString();
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) fail("DB_ARGUMENT_DENIED");
  const command = name.toUpperCase();
  if (REDIS_DENIED.has(command) || REDIS_MULTI_REQUEST.has(command))
    fail("DB_COMMAND_DENIED");
  args[0] = command;
  return args;
}
function redisInput(operation: Operation): Buffer {
  if (operation.files?.length) {
    if (
      operation.input !== undefined ||
      operation.files.length !== 1 ||
      operation.files[0].path !== "-"
    )
      fail("DB_INPUT_AMBIGUOUS");
    const encoding = operation.files[0].base64;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoding,
      )
    )
      fail("DB_FILE_ENCODING");
    return Buffer.from(encoding, "base64");
  }
  if (operation.input === undefined) fail("DB_INPUT_REQUIRED");
  return Buffer.from(operation.input);
}
function redisPipe(buffer: Buffer) {
  const commands: (string | Buffer)[][] = [];
  let offset = 0;
  function number(prefix: number) {
    if (buffer[offset] !== prefix) fail("DB_RESP_INPUT_INVALID");
    const end = buffer.indexOf("\r\n", offset);
    if (
      end < 0 ||
      !/^\d{1,8}$/.test(buffer.subarray(offset + 1, end).toString())
    )
      fail("DB_RESP_INPUT_INVALID");
    const value = Number(buffer.subarray(offset + 1, end).toString());
    offset = end + 2;
    return value;
  }
  if (buffer.length > 16 * 1024 * 1024) fail("DB_SQL_SIZE");
  while (offset < buffer.length) {
    const count = number(42),
      args: Buffer[] = [];
    if (count < 1 || count > 10000 || commands.length >= 10000)
      fail("DB_RESP_INPUT_INVALID");
    for (let index = 0; index < count; index++) {
      const length = number(36);
      if (
        offset + length + 2 > buffer.length ||
        buffer[offset + length] !== 13 ||
        buffer[offset + length + 1] !== 10
      )
        fail("DB_RESP_INPUT_INVALID");
      args.push(buffer.subarray(offset, offset + length));
      offset += length + 2;
    }
    commands.push(redisCommand(args));
  }
  if (!commands.length) fail("DB_INPUT_REQUIRED");
  return commands;
}
function redisOutput(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8"),
      validText = Buffer.from(text).equals(value);
    return {
      type: "bytes",
      base64: value.toString("base64"),
      ...(validText ? { utf8: text } : {}),
    };
  }
  if (Array.isArray(value)) return value.map(redisOutput);
  if (value instanceof Map)
    return [...value].map(([key, item]) => [
      redisOutput(key),
      redisOutput(item),
    ]);
  if (value instanceof Set) return [...value].map(redisOutput);
  return value;
}
export const redisAdapter: Adapter = {
  validate(connection, secret) {
    parseConfig(redisConfigSchema, connection, "redis");
    checkSecret(secret);
  },
  async run(context, operation) {
    let client: ReturnType<typeof createRedisClient> | undefined;
    const deadline = timer(context, operation, () => {
      if (client?.isOpen) client.destroy();
    });
    try {
      deadline.check();
      const config: RedisConfig = parseConfig(
        redisConfigSchema,
        context.connection,
        "redis",
      );
      checkSecret(context.secret);
      const args = [...operation.args];
      let commands: (string | Buffer)[][];
      if (args[0] === "--pipe") {
        if (args.length !== 1) fail("DB_ARGUMENT_DENIED");
        commands = redisPipe(redisInput(operation));
      } else {
        const inputFlag = args[0] === "-x";
        if (inputFlag) {
          args.shift();
          commands = [redisCommand([...args, redisInput(operation)])];
        } else {
          if (operation.input !== undefined || operation.files?.length)
            fail("DB_INPUT_AMBIGUOUS");
          commands = [redisCommand(args)];
        }
      }
      const address = await deadline.wait(
        fixedAddress(config.host, context.allowLocal),
      );
      deadline.check();
      const socket = config.tls
        ? {
            host: address,
            port: config.port ?? 6379,
            tls: true as const,
            rejectUnauthorized: true,
            ...(!isIP(config.serverName ?? config.host)
              ? { servername: config.serverName ?? config.host }
              : {}),
            ...(config.ca ? { ca: config.ca } : {}),
            connectTimeout: operation.timeoutMs,
            reconnectStrategy: false as const,
          }
        : {
            host: address,
            port: config.port ?? 6379,
            connectTimeout: operation.timeoutMs,
            reconnectStrategy: false as const,
          };
      client = createRedisClient({
        socket,
        username: config.username ?? context.secret.username,
        password: context.secret.password,
        database: config.database,
        disableOfflineQueue: true,
      });
      client.on("error", () => undefined);
      await deadline.wait(client.connect());
      deadline.check();
      const responses: unknown[] = [];
      for (const command of commands) {
        const response: unknown = await deadline.wait(
          client.sendCommand(command, {
            typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer },
            abortSignal: deadline.signal,
            timeout: operation.timeoutMs,
          }),
        );
        responses.push({ command: command[0], result: redisOutput(response) });
      }
      deadline.check();
      return result(commands.length === 1 ? responses[0] : responses);
    } catch (error) {
      return safeError("redis", error, deadline.code());
    } finally {
      deadline.dispose();
      if (client?.isOpen) client.destroy();
    }
  },
};
