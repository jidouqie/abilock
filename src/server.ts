import { setting } from "./environment.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Socket } from "node:net";
import { z } from "zod";
import { Store } from "./store.js";
import {
  AppError,
  platformWriteSchema,
  docSchema,
  requestSchema,
} from "./schema.js";
import { constantEqual, redact, safeUrl } from "./security.js";
import { readBounded } from "./transport.js";
import { execute } from "./proxy.js";
import { fetchMarkdown, assertDocumentMetadata } from "./docs.js";
import { adapters } from "./adapters.js";
import { AdminAuth } from "./admin-auth.js";
import { WebSocketServer } from "ws";
import { connectionWriteSchema } from "./connections.js";
import {
  protocolAdapters,
  capabilities,
  capabilityFor,
} from "./protocols/index.js";
import { assertTargetBoundary } from "./protocol-boundary.js";
import { testSSHConnection } from "./protocols/ssh.js";
import { planProtocolConnectionTest, testProtocolConnection } from "./connection-test.js";
import { assertHTTPConnectionTestConsent, planHTTPConnectionTest, testHTTPConnection } from "./http-connection-test.js";
import {
  parseServerInventory,
  serverInspectionCommand,
} from "./server-inspection.js";
import {
  createOperationTrace,
  resolveOperationTrace,
  safeOperationTrace,
  type OperationTrace,
} from "./operation-trace.js";
import {
  runProtocolOperation,
  operationTraceForError,
} from "./operation-runner.js";
import { configurationFormVersion } from "./configuration-contract.js";
import { awaitWithSignal } from "./async-boundary.js";
import {
  protocolDocumentation,
  publicError,
  routeExecution,
  writePublicJson,
} from "./execution-routes.js";
import { createTerminalSession } from "./local-terminal.js";
export type ServerOptions = {
  store: Store;
  adminToken?: string;
  execToken: string;
  webDir: string;
  /** Package root holding docs/protocols; defaults to two levels above webDir. */
  programRoot?: string;
  adminHost?: string;
  execHost?: string;
  adminPort?: number;
  execPort?: number;
  managementOnly?: boolean;
  log?: (record: Record<string, unknown>) => unknown;
};
async function body(req: http.IncomingMessage, limit = 20 * 1024 * 1024) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new AppError(415, "CONTENT_TYPE", "需要 application/json");
  try {
    return JSON.parse((await readBounded(req, limit)).toString());
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "INVALID_JSON", "请求 JSON 无效");
  }
}
const revisionSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const connectionTestSchema = z
  .object({ expectedRevision: z.number().int().positive(), allowBillable: z.boolean().optional(), model: z.string().min(1).max(100).optional() })
  .strict();
const docWrite = z
  .object({ doc: docSchema, expectedRevision: z.number().int().optional() })
  .strict();
const docFetch = z
  .object({
    title: z.string().min(1).max(200),
    sourceUrl: z.string().url().max(1500),
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();
export async function startServers(o: ServerOptions) {
  if (
    (o.adminToken !== undefined && o.adminToken.length < 24) ||
    o.execToken.length < 24 ||
    (o.adminToken !== undefined && constantEqual(o.adminToken, o.execToken))
  )
    throw new Error("管理与执行凭据必须不同，且各至少 24 字符");
  const store = o.store;
  const programRoot = o.programRoot ?? path.resolve(o.webDir, "../..");
  const json = (res: http.ServerResponse, status: number, value: unknown, secrets: string[]) =>
    writePublicJson(res, status, value, secrets, store);
  // A cheap fingerprint of everything the management page renders, so idle
  // pages poll this instead of reloading every connection and manual.
  const stateRevision = () =>
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          store.discovery().revision,
          store.unrecognizedRecords(),
          store.docsExportStatus.status,
        ]),
      )
      .digest("hex");
  store.setProtectedSecrets([
    o.execToken,
    ...(o.adminToken ? [o.adminToken] : []),
  ]);
  const auth = new AdminAuth(store.dir, o.adminToken, o.execToken);
  await auth.init();
  const logSink =
    o.log ??
    ((x) => {
      process.stdout.write(JSON.stringify(x) + "\n");
    });
  const log = (record: Record<string, unknown>) => {
    try {
      // Observation failures must not fail or cause retries of completed work.
      void Promise.resolve(logSink(record)).catch(() => {});
    } catch {
      /* The logger is optional and never owns operation completion. */
    }
  };
  const rates = new Map<string, { at: number; count: number }>();
  // One test per saved alias across windows. There is no automatic replay when
  // a test is cancelled, timed out or superseded by a saved configuration.
  const connectionTests = new Set<string>();
  let inflight = 0;
  const allowLocal = () =>
    setting("MOCK") === "1" && setting("ALLOW_LOCAL") === "1";
  function handler(management: boolean) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const requestId = crypto.randomUUID();
      let trace = createOperationTrace();
      const started = Date.now();
      let alias: string | undefined;
      let failure: AppError | undefined;
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      let requestSecrets = store.secrets();
      const secrets = () => [
        ...requestSecrets,
        ...store.secrets(),
        ...(o.adminToken ? [o.adminToken] : []),
        o.execToken,
        ...(req.headers.cookie
          ?.split(";")
          .map((x) => x.trim())
          .filter((x) => x.startsWith("abilock_admin_session="))
          .map((x) => x.slice("abilock_admin_session=".length)) ?? []),
        ...(typeof req.headers["x-abilock-csrf"] === "string"
          ? [req.headers["x-abilock-csrf"]]
          : []),
      ];
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("x-abilock-request-id", requestId);
      const updateTrace = (next: OperationTrace) => {
        trace = safeOperationTrace(next, secrets());
        res.setHeader("x-abilock-invocation-id", trace.invocationId);
        res.setHeader("x-abilock-operation-id", trace.operationId);
      };
      updateTrace(trace);
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      try {
        updateTrace(
          resolveOperationTrace(trace, req.headers["x-abilock-invocation-id"]),
        );
        const host = req.headers.host ?? "";
        const port = (management ? admin : executor).address();
        const actualPort = typeof port === "object" && port ? port.port : 0;
        if (
          ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(
            host,
          ) &&
          setting("ISOLATED_BIND") !== "1"
        )
          throw new AppError(403, "HOST_REJECTED", "Host 不允许");
        const origin = req.headers.origin;
        if (origin && (management ? origin !== `http://${host}` : true))
          throw new AppError(403, "ORIGIN_REJECTED", "跨源请求不允许");
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new AppError(403, "ORIGIN_REJECTED", "跨站请求不允许");
        if (
          !req.url ||
          req.url.includes("\\") ||
          req.url.includes("%") ||
          req.url.startsWith("//") ||
          !req.url.startsWith("/")
        )
          throw new AppError(400, "INVALID_ROUTE", "路由无效");
        const url = new URL(req.url, "http://local");
        const route = url.pathname;
        const method = req.method ?? "GET";
        if (route === "/health" && method === "GET") {
          json(
            res,
            200,
            { ok: true, role: management ? "management" : "execution" },
            secrets(),
          );
          return;
        }
        if (route.startsWith("/admin/auth/")) {
          if (!management)
            throw new AppError(404, "NOT_FOUND", "接口不存在或不属于此角色");
          if (route === "/admin/auth/status" && method === "GET") {
            json(res, 200, auth.status(req), []);
            return;
          }
          if (method === "POST") {
            auth.requireUi(req, route === "/admin/auth/setup");
            let result: unknown;
            if (route === "/admin/auth/logout") result = auth.logout(req, res);
            else {
              const input = z
                .object({
                  password: z.unknown().optional(),
                  confirmPassword: z.unknown().optional(),
                  currentPassword: z.unknown().optional(),
                })
                .strict()
                .parse(await body(req, 4096));
              if (route === "/admin/auth/setup")
                result = await auth.setup(req, res, input);
              else if (route === "/admin/auth/login")
                result = await auth.login(req, res, input);
              else if (route === "/admin/auth/password")
                result = await auth.change(req, res, input);
              else throw new AppError(404, "NOT_FOUND", "接口不存在");
            }
            json(res, route === "/admin/auth/setup" ? 201 : 200, result, []);
            return;
          }
          throw new AppError(404, "NOT_FOUND", "接口不存在");
        }
        if (management && !route.startsWith("/admin/")) {
          if (method !== "GET")
            throw new AppError(404, "NOT_FOUND", "不存在的页面");
          const file = route === "/" ? "index.html" : route.slice(1);
          if (file.includes("..") || !/^[-A-Za-z0-9_./]+$/.test(file))
            throw new AppError(404, "NOT_FOUND", "不存在的文件");
          let data: Buffer;
          try {
            data = await fs.readFile(path.join(o.webDir, file));
          } catch {
            throw new AppError(
              404,
              "NOT_FOUND",
              "页面尚未构建或文件不存在；请 npm run build",
            );
          }
          const ext = path.extname(file);
          res.setHeader(
            "content-type",
            (
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".png": "image/png",
                ".css": "text/css",
                ".svg": "image/svg+xml",
              } as Record<string, string>
            )[ext] ?? "application/octet-stream",
          );
          res.end(data);
          return;
        }
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (management)
          auth.authenticate(req, !["GET", "HEAD"].includes(method));
        else if (!constantEqual(token, o.execToken))
          throw new AppError(401, "UNAUTHORIZED", "凭据无效或角色不符");
        const rateKey = `${management}:${req.socket.remoteAddress}`;
        const now = Date.now();
        let rate = rates.get(rateKey);
        if (!rate || now - rate.at > 60000) {
          rate = { at: now, count: 0 };
          rates.set(rateKey, rate);
        }
        if (++rate.count > 240)
          throw new AppError(429, "RATE_LIMIT", "每分钟最多 240 次请求");
        if (inflight >= 16) throw new AppError(429, "BUSY", "并发请求达到限制");
        inflight++;
        res.once("close", () => inflight--);
        await store.refresh();
        requestSecrets = store.secrets();
        if (management) {
          if (route === "/admin/discovery" && method === "GET") {
            json(res, 200, store.discovery(), secrets());
            return;
          }
          if (route === "/admin/state-revision" && method === "GET") {
            json(res, 200, { revision: stateRevision() }, secrets());
            return;
          }
          const unrecognized = route.match(
            /^\/admin\/unrecognized\/([A-Za-z][A-Za-z0-9_-]{0,31})$/,
          );
          if (unrecognized && method === "DELETE") {
            alias = unrecognized[1];
            await store.removeUnrecognized(alias);
            json(res, 200, { ok: true }, secrets());
            return;
          }
          const savedTest = route.match(
            /^\/admin\/(connections|platforms)\/([A-Za-z][A-Za-z0-9_-]{0,31})\/(test-plan|connection-test)$/,
          );
          if (savedTest && ((savedTest[3] === "test-plan" && method === "GET") ||
            (savedTest[3] === "connection-test" && method === "POST"))) {
            alias = savedTest[2];
            const testStarted = Date.now();
            const timer = setTimeout(() => controller.abort(
              new AppError(504, "CONNECTION_TEST_TIMEOUT", "连接测试超时，未自动重试。"),
            ), 30000);
            timer.unref();
            let key = "";
            let acquired = false;
            try {
              const input = method === "POST"
                ? connectionTestSchema.parse(await awaitWithSignal(body(req, 4096), controller.signal))
                : undefined;
              // Do not retain credentials while a slow caller uploads its body.
              // Re-read after input arrives, immediately before choosing the record.
              await awaitWithSignal(store.refresh(), controller.signal);
              const platform = savedTest[1] === "platforms" ? store.platform(alias) : undefined;
              const selected = !platform ? store.listConnections().find(
                (item) => item.alias.toLowerCase() === alias!.toLowerCase(),
              ) : undefined;
              const connection = selected ? store.connection(selected.kind, selected.alias) : undefined;
              if (!platform && !connection)
                throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
              const saved = platform ?? connection!;
              const plan = platform ? planHTTPConnectionTest(platform) : planProtocolConnectionTest(connection!);
              const identity = { alias: saved.alias, revision: saved.revision, kind: platform ? "api" : connection!.kind };
              if (!input) {
                json(res, 200, { ...identity, ...plan }, secrets());
                return;
              }
              key = saved.alias.toLowerCase();
              if (saved.revision !== input.expectedRevision)
                throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入");
              if (!saved.enabled)
                throw new AppError(403, "CONNECTION_DISABLED", "连接已停用");
              if (connectionTests.has(key))
                throw new AppError(409, "CONNECTION_TEST_BUSY", "该连接正在测试，请等待或取消当前测试。");
              connectionTests.add(key);
              acquired = true;
              const tested = structuredClone(saved);
              if (platform && plan.supported && (plan.billing === "none" || input.allowBillable === true))
                assertHTTPConnectionTestConsent(platform, input);
              if (connection && input.model !== undefined)
                throw new AppError(400, "CONNECTION_TEST_CONFIG", "此连接不接受模型测试参数");
              // Possible charges require a separate, explicit UI confirmation.
              // No upstream request is sent before that confirmation.
              const result = !plan.supported || (plan.billing === "possible" && input.allowBillable !== true)
                ? { ...plan, status: "unsupported" as const, success: false,
                  ...(plan.billing === "possible" ? { message: "测试可能产生请求费用，需要确认后才会发送。" } : {}) }
                : platform
                  ? await testHTTPConnection({
                    platform, secret: platform.sealed ? store.unseal(platform.sealed) : {},
                    signal: controller.signal, allowLocal: allowLocal(),
                    allowBillable: input.allowBillable, model: input.model,
                  })
                  : await testProtocolConnection({
                    connection: connection!, secret: connection!.sealed ? store.unsealCredentials(connection!.sealed) : {},
                    signal: controller.signal, allowLocal: allowLocal(), dataDir: path.join(store.dir, "workspaces"), trace,
                  }, { allowBillable: input.allowBillable === true });
              controller.signal.throwIfAborted();
              await awaitWithSignal(store.refresh(), controller.signal);
              controller.signal.throwIfAborted();
              let current: unknown;
              try { current = platform ? store.platform(saved.alias) : store.connection(connection!.kind, saved.alias); }
              catch { throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入"); }
              if (!isDeepStrictEqual(current, tested))
                throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入");
              json(res, 200, {
                ...identity, ...result, durationMs: Math.max(0, Date.now() - testStarted),
                requestId, ...trace, operationIdSource: "server",
              }, secrets());
            } catch (error) {
              if (controller.signal.aborted) {
                if (controller.signal.reason instanceof AppError && controller.signal.reason.code === "CONNECTION_TEST_TIMEOUT")
                  throw controller.signal.reason;
                throw new AppError(499, "CONNECTION_TEST_CANCELLED", "连接测试已取消。");
              }
              throw error;
            } finally {
              clearTimeout(timer);
              if (acquired) connectionTests.delete(key);
            }
            return;
          }
          const connectionTest = route.match(
            /^\/admin\/connections\/([A-Za-z][A-Za-z0-9_-]{0,31})\/test$/,
          );
          if (connectionTest && method === "POST") {
            alias = connectionTest[1];
            const testStarted = Date.now();
            const timer = setTimeout(
              () => controller.abort(new AppError(504, "SSH_TEST_TIMEOUT", "SSH 连接测试超时")),
              30000,
            );
            timer.unref();
            let testKey: string | undefined;
            try {
              const input = revisionSchema.parse(
                await awaitWithSignal(body(req, 4096), controller.signal),
              );
              await awaitWithSignal(store.refresh(), controller.signal);
              // The URL selects an existing alias, never a target or identity.
              const selected = store.listConnections().find(
                (item) => item.alias.toLowerCase() === alias!.toLowerCase(),
              );
              if (!selected)
                throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
              if (selected.kind !== "ssh")
                throw new AppError(400, "CONNECTION_TEST_UNSUPPORTED", "该连接不支持连接测试");
              const connection = store.connection("ssh", selected.alias);
              if (connection.revision !== input.expectedRevision)
                throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入");
              if (!connection.enabled)
                throw new AppError(403, "CONNECTION_DISABLED", "连接已停用");
              if (!connection.sealed)
                throw new AppError(400, "SECRET_REQUIRED", "请先在管理页面录入 SSH 凭据");
              if (connectionTests.has(selected.alias.toLowerCase()))
                throw new AppError(409, "CONNECTION_TEST_BUSY", "该连接正在测试，请等待或取消当前测试。");
              testKey = selected.alias.toLowerCase();
              connectionTests.add(testKey);
              // Revision numbers restart when an alias is deleted and recreated.
              // Retain this exact saved record (including encrypted credentials)
              // so a completed handshake cannot attest to a replacement record.
              const testedConnection = structuredClone(connection);
              try {
                await assertTargetBoundary(connection, allowLocal(), controller.signal);
              } catch (error) {
                if (controller.signal.aborted) {
                  if (controller.signal.reason instanceof AppError)
                    throw controller.signal.reason;
                  throw new AppError(499, "SSH_TEST_CANCELLED", "SSH 连接测试已取消");
                }
                if (error instanceof AppError) throw error;
                throw new AppError(502, "SSH_TEST_DNS", "SSH 目标地址解析失败");
              }
              const result = await testSSHConnection({
                connection,
                secret: store.unsealCredentials(connection.sealed),
                signal: controller.signal,
                allowLocal: allowLocal(),
                dataDir: path.join(store.dir, "workspaces"),
                trace,
              });
              controller.signal.throwIfAborted();
              // A different window can edit or rotate this saved connection
              // while the handshake is in flight. Report success only for the
              // same current revision, without holding a lock over the network.
              await awaitWithSignal(store.refresh(), controller.signal);
              controller.signal.throwIfAborted();
              const current = store.listConnections().find(
                (item) => item.alias.toLowerCase() === selected.alias.toLowerCase(),
              );
              if (!current)
                throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
              if (current.kind !== "ssh" || current.revision !== input.expectedRevision ||
                !isDeepStrictEqual(store.connection("ssh", current.alias), testedConnection))
                throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入");
              json(res, 200, {
                ...result,
                durationMs: Math.max(0, Date.now() - testStarted),
                requestId,
                ...trace,
                operationIdSource: "server",
              }, secrets());
            } catch (error) {
              if (controller.signal.aborted) {
                if (controller.signal.reason instanceof AppError &&
                  controller.signal.reason.code === "SSH_TEST_TIMEOUT")
                  throw controller.signal.reason;
                throw new AppError(499, "SSH_TEST_CANCELLED", "SSH 连接测试已取消");
              }
              throw error;
            } finally {
              clearTimeout(timer);
              if (testKey) connectionTests.delete(testKey);
            }
            return;
          }
          const inspect = route.match(
            /^\/admin\/connections\/([A-Za-z][A-Za-z0-9_-]{0,31})\/inspect$/,
          );
          if (inspect && method === "POST") {
            alias = inspect[1];
            const input = revisionSchema.parse(await body(req, 4096));
            const connection = store.connection("ssh", alias);
            if (connection.revision !== input.expectedRevision)
              throw new AppError(
                409,
                "REVISION_CONFLICT",
                "连接已变化，请重新载入",
              );
            if (!connection.enabled || connection.config.allowShell === false)
              throw new AppError(
                403,
                "INSPECTION_DISABLED",
                "该连接未启用 SSH 远程命令",
              );
            if (!connection.sealed)
              throw new AppError(
                400,
                "SECRET_REQUIRED",
                "请先在管理页面录入 SSH 凭据",
              );
            const timer = setTimeout(
              () =>
                controller.abort(
                  new AppError(
                    504,
                    "UPSTREAM_TIMEOUT",
                    "服务器概况读取超时；旧概况已保留",
                  ),
                ),
              10000,
            );
            timer.unref();
            try {
              await assertTargetBoundary(
                connection,
                allowLocal(),
                controller.signal,
              );
              controller.signal.throwIfAborted();
              const result = await runProtocolOperation(
                protocolAdapters.ssh,
                {
                  connection,
                  secret: store.unsealCredentials(connection.sealed),
                  signal: controller.signal,
                  allowLocal: allowLocal(),
                  dataDir: path.join(store.dir, "workspaces"),
                },
                { args: ["--", serverInspectionCommand], timeoutMs: 10000 },
                trace,
              );
              updateTrace({
                invocationId: result.invocationId!,
                operationId: result.operationId!,
              });
              controller.signal.throwIfAborted();
              if (result.exitCode !== 0)
                throw new AppError(
                  502,
                  "INSPECTION_FAILED",
                  "服务器概况读取失败；旧概况已保留",
                );
              const inventory = parseServerInventory(result.stdout ?? "");
              json(
                res,
                200,
                await store.recordInventory(
                  alias,
                  inventory,
                  input.expectedRevision,
                ),
                secrets(),
              );
            } finally {
              clearTimeout(timer);
            }
            return;
          }
          if (route === "/admin/connections" && method === "GET") {
            json(
              res,
              200,
              {
                connections: store.listConnections(),
                capabilities,
                unrecognized: store.unrecognizedRecords(),
              },
              secrets(),
            );
            return;
          }
          const connectionRoute = route.match(
            /^\/admin\/connections\/([A-Za-z][A-Za-z0-9_-]{0,31})$/,
          );
          if (connectionRoute && method === "PUT") {
            alias = connectionRoute[1];
            const input = connectionWriteSchema.parse(await body(req));
            json(
              res,
              200,
              await store.saveConnection(
                input.connection,
                input.secret,
                !!input.clearSecret,
                input.expectedRevision,
                alias,
              ),
              secrets(),
            );
            return;
          }
          if (connectionRoute && method === "DELETE") {
            const input = revisionSchema.parse(await body(req));
            await store.removeConnection(
              connectionRoute[1],
              input.expectedRevision,
            );
            json(res, 200, { ok: true }, secrets());
            return;
          }
          if (route === "/admin/platforms" && method === "GET") {
            json(
              res,
              200,
              {
                platforms: store.list(),
                formVersion: configurationFormVersion,
                adapters: [...adapters.keys()],
                mode: setting("MOCK") === "1" ? "mock" : "local",
              },
              secrets(),
            );
            return;
          }
          const m = route.match(
            /^\/admin\/platforms\/([A-Za-z][A-Za-z0-9_-]{0,31})$/,
          );
          if (m && (method === "PUT" || method === "DELETE")) {
            alias = m[1];
            if (method === "DELETE") {
              const input = revisionSchema.parse(await body(req));
              await store.remove(alias, input.expectedRevision);
              json(res, 200, { ok: true }, secrets());
              return;
            }
            const input = platformWriteSchema.parse(await body(req));
            const saved = await store.save(
              input.platform,
              input.secret,
              !!input.clearSecret,
              input.expectedRevision,
              alias,
            );
            json(res, 200, saved, secrets());
            return;
          }
          if (route === "/admin/docs" && method === "GET") {
            // Built-in guides are per protocol: send each text once, and let
            // every connection refer to its kind's guide.
            const connections = store.listConnections();
            const guideMarkdown: Record<string, string> = {};
            for (const kind of new Set(connections.map((item) => item.kind)))
              guideMarkdown[kind] = await protocolDocumentation(
                programRoot,
                capabilityFor(kind).documentation,
                "本机协议手册不可用，请重新安装 Abilock。",
              );
            const protocolGuides = connections.map((connection) => ({
              alias: connection.alias,
              kind: connection.kind,
              title: connection.name,
              source: "builtin",
            }));
            json(
              res,
              200,
              { docs: store.state.docs, protocolGuides, guideMarkdown,
                docsExportStatus: store.docsExportStatus,
                documentationStatuses: Object.fromEntries(store.discovery().capabilities.map((item) =>
                  [item.alias, item.documentation?.status])),
              },
              secrets(),
            );
            return;
          }
          const d = route.match(/^\/admin\/docs\/([a-f0-9-]{36})$/);
          if (d && method === "DELETE") {
            const input = revisionSchema.parse(await body(req));
            await store.removeDoc(d[1], input.expectedRevision);
            json(res, 200, { ok: true }, secrets());
            return;
          }
          if (d && method === "PUT") {
            const input = docWrite.parse(await body(req));
            const old = store.state.docs.find((x) => x.id === d[1]);
            if (!old) throw new AppError(404, "DOC_NOT_FOUND", "文档不存在");
            safeUrl(input.doc.sourceUrl, setting("MOCK") === "1");
            assertDocumentMetadata(
              input.doc,
              secrets(),
              store.state.platforms.flatMap((p) =>
                p.auth.type === "query" && p.auth.name ? [p.auth.name] : [],
              ),
            );
            const saved = await store.saveDoc(
              old.alias,
              { ...input.doc, markdown: redact(input.doc.markdown, secrets()) },
              "manual",
              d[1],
              input.expectedRevision,
            );
            json(res, 200, saved, secrets());
            return;
          }
          const docs = route.match(
            /^\/admin\/(?:platforms|connections)\/([A-Za-z][A-Za-z0-9_-]{0,31})\/docs(?:\/(fetch))?$/,
          );
          if (docs && method === "POST") {
            alias = docs[1];
            if (route.startsWith("/admin/connections/")) {
              if (!store.listConnections().some((c) => c.alias === alias))
                throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
            } else store.platform(alias);
            if (docs[2]) {
              const input = docFetch.parse(await body(req));
              assertDocumentMetadata(
                input,
                secrets(),
                store.state.platforms.flatMap((p) =>
                  p.auth.type === "query" && p.auth.name ? [p.auth.name] : [],
                ),
              );
              const markdown = await fetchMarkdown(
                input.sourceUrl,
                controller.signal,
                setting("MOCK") === "1",
              );
              const saved = await store.saveDoc(
                alias,
                {
                  title: input.title,
                  sourceUrl: input.sourceUrl,
                  markdown: redact(markdown, secrets()),
                },
                "fetched",
                input.id,
                input.expectedRevision,
              );
              json(res, 200, saved, secrets());
              return;
            }
            const input = docSchema.parse(await body(req));
            safeUrl(input.sourceUrl, setting("MOCK") === "1");
            assertDocumentMetadata(
              input,
              secrets(),
              store.state.platforms.flatMap((p) =>
                p.auth.type === "query" && p.auth.name ? [p.auth.name] : [],
              ),
            );
            json(
              res,
              201,
              await store.saveDoc(
                alias,
                { ...input, markdown: redact(input.markdown, secrets()) },
                "manual",
              ),
              secrets(),
            );
            return;
          }
          const test = route.match(
            /^\/admin\/platforms\/([A-Za-z][A-Za-z0-9_-]{0,31})\/test$/,
          );
          if (test && method === "POST") {
            alias = test[1];
            const input = requestSchema.parse(await body(req));
            updateTrace(
              resolveOperationTrace(
                trace,
                req.headers["x-abilock-invocation-id"],
                input.trace,
              ),
            );
            await execute(
              store,
              store.platform(alias),
              input,
              res,
              controller.signal,
              secrets(),
              requestId,
              trace,
              updateTrace,
            );
            return;
          }
        } else if (
          await routeExecution({
            store,
            route,
            method,
            readJson: () => body(req),
            res,
            signal: controller.signal,
            secrets,
            requestId,
            trace: () => trace,
            updateTrace,
            invocationHeader: req.headers["x-abilock-invocation-id"],
            programRoot,
            allowLocal: allowLocal(),
            allowLocalDocuments: setting("MOCK") === "1",
            learning: false,
            onAlias: (value) => {
              alias = value;
            },
          })
        )
          return;
        throw new AppError(404, "NOT_FOUND", "接口不存在或不属于此角色");
      } catch (e) {
        const executionTrace = operationTraceForError(e);
        if (executionTrace && !res.headersSent) updateTrace(executionTrace);
        const error = publicError(e);
        failure = error;
        if (!res.headersSent && !res.destroyed)
          json(
            res,
            error.status,
            {
              error: { code: error.code, message: error.message },
              requestId,
              ...trace,
              operationIdSource: "server",
            },
            secrets(),
          );
        else if (!res.destroyed) res.destroy();
      } finally {
        log({
          event: "request",
          role: management ? "management" : "execution",
          requestId,
          invocationId: trace.invocationId,
          operationId: trace.operationId,
          ...(alias ? { alias: redact(alias, secrets()) } : {}),
          status: res.statusCode,
          completed: failure === undefined,
          ...(failure ? { errorCode: redact(failure.code, secrets()) } : {}),
          durationMs: Date.now() - started,
        });
      }
    };
  }
  const admin = http.createServer(handler(true)),
    executor = http.createServer(handler(false));
  const rawSockets = new Set<Socket>();
  for (const server of [admin, executor])
    server.on("connection", (socket: Socket) => {
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));
    });
  const terminalServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  executor.on("upgrade", async (req, socket, head) => {
    const host = req.headers.host,
      port = (executor.address() as import("node:net").AddressInfo).port;
    const match = req.url?.match(
      /^\/v2\/terminal\/ssh\/([A-Za-z0-9_.:-]{1,100})$/,
    );
    if (
      !match ||
      req.headers.origin ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !constantEqual(
        (req.headers.authorization ?? "").replace(/^Bearer /, ""),
        o.execToken,
      ) ||
      (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? "") &&
        setting("ISOLATED_BIND") !== "1")
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
    try {
      await store.refresh();
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    if (socket.destroyed) return;
    if (inflight >= 16) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
        () => socket.destroy(),
      );
      return;
    }
    // A malformed caller trace is rejected before the protocol upgrade.
    const invocation = req.headers["x-abilock-invocation-id"];
    try {
      resolveOperationTrace(createOperationTrace(), invocation);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
    terminalServer.handleUpgrade(req, socket, head, (ws) => {
      inflight++;
      const started = Date.now();
      const controller = new AbortController();
      // The same session as the local worker: frame validation, sequencing,
      // rate and backpressure limits, redaction and the one-hour maximum.
      let session: ReturnType<typeof createTerminalSession>;
      try {
        session = createTerminalSession(
          store,
          {
            type: "terminal",
            selector: match[1],
            headers:
              typeof invocation === "string"
                ? { "x-abilock-invocation-id": invocation }
                : {},
          },
          {
            signal: controller.signal,
            allowLocalFixture: allowLocal(),
            send: (frame) =>
              new Promise<void>((resolve, reject) => {
                if (ws.readyState !== 1) {
                  reject(new Error("closed"));
                  return;
                }
                ws.send(JSON.stringify(frame), (error) =>
                  error ? reject(error) : resolve(),
                );
              }),
          },
        );
      } catch {
        inflight--;
        ws.close(1011);
        return;
      }
      ws.on("message", (data) => {
        let frame: unknown = null;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          /* An unparsable frame is answered as an invalid frame. */
        }
        session.receive(frame);
      });
      ws.on("close", () => controller.abort());
      ws.on("error", () => controller.abort());
      void session.done.then(() => {
        inflight--;
        const summary = session.summary();
        log({
          event: "terminal",
          role: "execution",
          requestId: session.requestId,
          ...session.trace,
          alias: redact(match[1], store.secrets()),
          status: summary.exitCode,
          durationMs: Date.now() - started,
          messagesIn: summary.messagesIn,
          messagesOut: summary.messagesOut,
        });
        if (ws.readyState === 1) ws.close();
      });
    });
  });
  for (const server of [admin, executor]) {
    server.requestTimeout = 130000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 100;
  }
  const listen = (server: http.Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(admin, o.adminPort ?? 4317, o.adminHost ?? "127.0.0.1");
    if (!o.managementOnly)
      await listen(executor, o.execPort ?? 4318, o.execHost ?? "127.0.0.1");
  } catch (e) {
    for (const socket of rawSockets) socket.destroy();
    admin.close();
    executor.close();
    throw e;
  }
  const address = (s: http.Server) =>
    `http://127.0.0.1:${(s.address() as import("node:net").AddressInfo).port}`;
  return {
    admin,
    executor,
    adminUrl: address(admin),
    execUrl: o.managementOnly ? "" : address(executor),
    close: async () => {
      for (const client of terminalServer.clients) client.terminate();
      terminalServer.close();
      for (const socket of rawSockets) socket.destroy();
      await Promise.all(
        [admin, executor].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
    },
  };
}
