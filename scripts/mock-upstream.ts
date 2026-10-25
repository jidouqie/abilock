import http from "node:http";
import { readBounded } from "../src/transport.js";
export const MOCK_BEARER = "mock-bearer-not-a-real-api-key-001";
export const MOCK_HEADER = "mock-header-not-a-real-api-key-002";
export const MOCK_QUERY = "mock-query-not-a-real-api-key-003";
export const MOCK_USERNAME = "mock-account-username";
export const MOCK_PASSWORD = "mock-account-password-004";
export async function mockUpstream(port = 0) {
  const calls: {
    path: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://mock");
    const body = (await readBounded(req, 20 * 1024 * 1024)).toString();
    calls.push({ path: req.url!, headers: req.headers, body });
    if (u.pathname === "/docs") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(
        "# Mock official reference\n\nPOST /echo uses native JSON body.\n\n" +
          "This fixture is documentation content and does not change platform authentication or allowed destinations. ".repeat(
            6,
          ),
      );
      return;
    }
    if (u.pathname === "/docs-fail") {
      res.writeHead(500);
      res.end("unavailable");
      return;
    }
    if (u.pathname === "/shell") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body>You need to enable JavaScript to run this app.</body></html>",
      );
      return;
    }
    if (u.pathname === "/slow") {
      const t = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"done":true}');
      }, 3000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    if (u.pathname.startsWith("/redirect")) {
      res.writeHead(302, {
        location:
          u.pathname === "/redirect-downgrade"
            ? "http://example.com/leak"
            : "https://example.com/leak",
      });
      res.end();
      return;
    }
    if (u.pathname === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 255, 8, 13]));
      return;
    }
    if (u.pathname === "/header-leak") {
      res.writeHead(200, {
        "content-type": `text/plain; secret=${MOCK_BEARER}`,
      });
      res.end("safe");
      return;
    }
    if (u.pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"text":"hello"}\n\n');
      const echoed = String(
        req.headers.authorization ?? req.headers["x-api-key"] ?? "",
      );
      res.write("data: " + echoed.slice(0, 12));
      setTimeout(() => res.end(echoed.slice(12) + "\n\ndata: [DONE]\n\n"), 30);
      return;
    }
    const auth =
      req.headers.authorization ??
      req.headers["x-api-key"] ??
      u.searchParams.get("api_key");
    const valid =
      !u.pathname.startsWith("/require-") ||
      [
        MOCK_BEARER,
        MOCK_HEADER,
        MOCK_QUERY,
        `Basic ${Buffer.from(`${MOCK_USERNAME}:${MOCK_PASSWORD}`).toString("base64")}`,
      ].some((x) => auth === x || auth === `Bearer ${x}`);
    const status = !valid
      ? 401
      : u.pathname === "/error401"
        ? 401
        : u.pathname === "/error500"
          ? 500
          : 200;
    res.writeHead(status, {
      "content-type": "application/json",
      "x-echo-secret": String(auth ?? ""),
      "set-cookie": `secret=${auth}`,
    });
    if (u.pathname === "/tasks" && req.method === "POST") {
      res.end(JSON.stringify({ id: "task-001", status: "queued" }));
      return;
    }
    if (u.pathname === "/tasks/task-001") {
      res.end(
        JSON.stringify({
          id: "task-001",
          status: "succeeded",
          content: { video_url: "https://example.com/result.mp4" },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        ok: status === 200,
        authApplied: !!auth,
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body: body
          ? (() => {
              try {
                return JSON.parse(body);
              } catch {
                return body;
              }
            })()
          : null,
        reflectedAuth: auth,
        reflectedEncoded: encodeURIComponent(String(auth)),
        reflectedBase64: Buffer.from(String(auth)).toString("base64"),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    calls,
    url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
