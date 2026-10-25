import http from "node:http";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { constantEqual } from "./security.js";
import { setting } from "./environment.js";
import { traceInputSchema } from "./trace-schema.js";
import { createOperationTrace, safeOperationTrace } from "./operation-trace.js";
import requestLimits from "../request-limits.json" with { type: "json" };
import { protocolContextRoute, protocolRunRoute } from "./protocol-kinds.js";
// Separate deployment identity. This module never imports Store or reads a master/admin credential.
export function executionGateway(options: {
  coreUrl: string;
  execToken: string;
  host?: string;
  port?: number;
}) {
  const base = new URL(options.coreUrl);
  if (
    base.protocol !== "http:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("网关 CORE_URL 必须为可信内部 HTTP 根地址");
  const server = http.createServer(async (req, res) => {
    let trace = createOperationTrace();
    const inputTrace = traceInputSchema.safeParse({
      invocationId: req.headers["x-abilock-invocation-id"],
    });
    if (inputTrace.success) trace.invocationId = inputTrace.data.invocationId;
    trace = safeOperationTrace(trace, [options.execToken]);
    // Local gateway failures also get their own IDs; successful core replies
    // replace them with the IDs of the actual operation.
    res.setHeader("x-abilock-invocation-id", trace.invocationId);
    res.setHeader("x-abilock-operation-id", trace.operationId);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const route = req.url ?? "";
    const method = req.method ?? "GET";
    if (route === "/health" && method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"role":"execution-gateway"}');
      return;
    }
    if (req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403);
      res.end('{"error":{"code":"ORIGIN_REJECTED"}}');
      return;
    }
    if (
      !constantEqual(
        (req.headers.authorization ?? "").replace(/^Bearer /, ""),
        options.execToken,
      )
    ) {
      res.writeHead(401);
      res.end('{"error":{"code":"UNAUTHORIZED"}}');
      return;
    }
    if (!(
      (method === "GET" &&
        /^\/v1\/(platforms|context\/[A-Za-z][A-Za-z0-9_-]{0,31})$/.test(
          route,
        )) ||
      (method === "POST" &&
        /^\/v1\/call\/[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(route)) ||
      (method === "GET" &&
        (route === "/v2/connections" ||
          route === "/v2/discovery" ||
          protocolContextRoute.test(route))) ||
      (method === "POST" && protocolRunRoute.test(route))
    )) {
      res.writeHead(404);
      res.end('{"error":{"code":"NOT_FOUND"}}');
      return;
    }
    let invocationId: string | undefined;
    if (req.headers["x-abilock-invocation-id"] !== undefined) {
      const parsed = traceInputSchema.safeParse({
        invocationId: req.headers["x-abilock-invocation-id"],
      });
      if (!parsed.success) {
        res.writeHead(400);
        res.end(
          '{"error":{"code":"TRACE_INVALID","message":"调用编号格式无效"}}',
        );
        return;
      }
      invocationId = parsed.data.invocationId;
    }
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const upstream = http.request(
      new URL(route, base),
      {
        method,
        headers: {
          authorization: `Bearer ${options.execToken}`,
          ...(invocationId ? { "x-abilock-invocation-id": invocationId } : {}),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
        agent: false,
      },
      (response) => {
        if (
          (response.statusCode ?? 500) >= 300 &&
          (response.statusCode ?? 500) < 400
        ) {
          response.destroy();
          res.writeHead(502);
          res.end('{"error":{"code":"REDIRECT_BLOCKED"}}');
          return;
        }
        res.statusCode = response.statusCode ?? 502;
        for (const h of [
          "content-type",
          "x-abilock-request-id",
          "x-abilock-operation-id",
          "x-abilock-invocation-id",
          "x-abilock-response-kind",
        ])
          if (response.headers[h]) res.setHeader(h, response.headers[h]!);
        void pipeline(response, res).catch(() => {
          if (!res.destroyed) res.destroy();
        });
      },
    );
    const timer = setTimeout(
      () => upstream.destroy(),
      route.startsWith("/v1/call/")
        ? requestLimits.httpClientTimeoutMs
        : requestLimits.metadataClientTimeoutMs,
    );
    timer.unref();
    upstream.on("close", () => clearTimeout(timer));
    upstream.on("error", () => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          '{"error":{"code":"CORE_UNAVAILABLE","message":"执行核心暂不可用"}}',
        );
      } else res.destroy();
    });
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        upstream.destroy();
        if (!res.headersSent) {
          res.writeHead(413);
          res.end('{"error":{"code":"TOO_LARGE"}}');
        }
        req.destroy();
      }
    });
    req.pipe(upstream);
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  const rawSockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const route = req.url ?? "";
    if (
      req.headers.origin ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !/^\/v2\/terminal\/ssh\/[A-Za-z0-9_.:-]{1,100}$/.test(route) ||
      !constantEqual(
        (req.headers.authorization ?? "").replace(/^Bearer /, ""),
        options.execToken,
      )
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
    let invocationId: string | undefined;
    if (req.headers["x-abilock-invocation-id"] !== undefined) {
      const parsed = traceInputSchema.safeParse({
        invocationId: req.headers["x-abilock-invocation-id"],
      });
      if (!parsed.success) {
        socket.end(
          "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
          () => socket.destroy(),
        );
        return;
      }
      invocationId = parsed.data.invocationId;
    }
    sockets.handleUpgrade(req, socket, head, (downstream) => {
      const url = new URL(route, base);
      url.protocol = "ws:";
      const upstream = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${options.execToken}`,
          ...(invocationId ? { "x-abilock-invocation-id": invocationId } : {}),
        },
        followRedirects: false,
        maxPayload: 1024 * 1024,
        handshakeTimeout: 10000,
      });
      const cleanup = () => {
        pending.length = 0;
        pendingBytes = 0;
        upstream.terminate();
        downstream.terminate();
      };
      const pending: { data: RawData; isBinary: boolean }[] = [];
      let pendingBytes = 0;
      upstream.on("open", () => {
        for (const frame of pending) {
          if (upstream.bufferedAmount >= 4 * 1024 * 1024) {
            cleanup();
            return;
          }
          upstream.send(frame.data, { binary: frame.isBinary });
        }
        pending.length = 0;
        pendingBytes = 0;
      });
      downstream.on("close", () => upstream.close());
      upstream.on("close", (code, reason) =>
        downstream.close(
          code >= 1000 &&
            code <= 4999 &&
            ![1004, 1005, 1006, 1015].includes(code)
            ? code
            : 1011,
          reason,
        ),
      );
      upstream.on("error", cleanup);
      downstream.on("error", cleanup);
      downstream.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          const bytes = Array.isArray(data)
            ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
            : data.byteLength;
          if (pending.length >= 16 || pendingBytes + bytes > 4 * 1024 * 1024) {
            cleanup();
            return;
          }
          pending.push({ data, isBinary });
          pendingBytes += bytes;
          return;
        }
        if (
          upstream.readyState === WebSocket.OPEN &&
          upstream.bufferedAmount < 4 * 1024 * 1024
        )
          upstream.send(data, { binary: isBinary });
        else cleanup();
      });
      upstream.on("message", (data, isBinary) => {
        if (
          downstream.readyState === WebSocket.OPEN &&
          downstream.bufferedAmount < 4 * 1024 * 1024
        )
          downstream.send(data, { binary: isBinary });
        else cleanup();
      });
    });
  });
  server.requestTimeout = 140000;
  server.headersTimeout = 10000;
  return new Promise<{
    server: http.Server;
    url: string;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4318, options.host ?? "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
        close: () =>
          new Promise<void>((r) => {
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            for (const socket of rawSockets) socket.destroy();
            server.close(() => r());
            server.closeAllConnections();
          }),
      }),
    );
  });
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const coreUrl = setting("CORE_URL"),
    execToken = setting("EXEC_TOKEN");
  if (!coreUrl || !execToken || execToken.length < 24) {
    console.error("网关需要 ABILOCK_CORE_URL 和执行能力令牌");
    process.exitCode = 1;
  } else
    executionGateway({
      coreUrl,
      execToken,
      host: setting("GATEWAY_HOST") ?? "127.0.0.1",
      port: Number(setting("GATEWAY_PORT") ?? 4318),
    })
      .then((g) => {
        console.log("Abilock 执行网关已启动（仅 /v1 与 /v2 协议白名单）");
        for (const s of ["SIGINT", "SIGTERM"] as const)
          process.once(s, () => void g.close().then(() => process.exit(0)));
      })
      .catch(() => {
        console.error("网关启动失败");
        process.exitCode = 1;
      });
}
