import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Manual } from "../web/components/manual.js";
import { Store } from "../src/store.js";
import { startServers } from "../src/server.js";
import { learnPlatform } from "../src/learn.js";

test("external manual data renders readable code and public links without executable HTML or automatic images", () => {
  const markdown = [
    "# 调用",
    "```sh",
    "abl mysql MAIN 'SELECT 1'",
    "```",
    "[官方文档](https://docs.example.test/api)",
    "[脚本](javascript:alert(1)) [文件](file:///private/example)",
    "[带账号](https://user:password@example.test/api)",
    "![图片](https://example.test/tracker.png)",
    "<script>alert('unsafe')</script>",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(Manual, { markdown }));
  assert(html.includes("abl mysql MAIN"));
  assert(html.includes('href="https://docs.example.test/api"'));
  assert(html.includes('rel="noopener noreferrer"'));
  assert(html.includes("&lt;script&gt;"));
  assert(
    !/<script\b|<img\b|href="(?:javascript:|file:|https:\/\/user:)/i.test(html),
  );
});

test("the management page serves the generated PNG and the same saved protocol manual as CLI context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-manual-page-"));
  const store = new Store(dir, "5".repeat(64));
  let server: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    await store.init();
    await store.saveConnection(
      {
        alias: "MANUAL_DB",
        name: "Synthetic database",
        kind: "mysql",
        enabled: true,
        description: "",
        documentationUrl: "https://docs.example.test/database",
        config: {
          host: "db.example.test",
          user: "synthetic-user",
          database: "synthetic-database",
          tls: true,
        },
        trustBoundary: "independent-target",
      },
      { password: "synthetic-manual-page-password-953242" },
      false,
      0,
    );
    const learned = await learnPlatform(store, "MANUAL_DB", {
      expectedRevision: 1,
      title: "数据库用法",
      sourceUrl: "https://docs.example.test/database",
      markdown: "# 查询\n\n用 `abl mysql MANUAL_DB 'SELECT 1'` 执行查询。",
    });
    const adminToken = "synthetic-manual-page-admin-token-953242";
    server = await startServers({
      store,
      adminToken,
      execToken: "synthetic-manual-page-exec-token-953242",
      webDir: path.resolve("dist/web"),
      adminPort: 0,
      managementOnly: true,
      log: () => {},
    });
    const index = await fs.readFile("dist/web/index.html", "utf8");
    const asset = /href="([^"]+\.png)"/.exec(index)?.[1];
    assert(asset, "built page must reference its generated PNG");
    const logo = await fetch(server.adminUrl + asset);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await logo.arrayBuffer());
    assert.deepEqual(bytes, await fs.readFile("web/assets/abilock-logo.png"));
    const response = await fetch(server.adminUrl + "/admin/docs", {
      headers: {
        authorization: "Bearer " + adminToken,
        origin: server.adminUrl,
        "x-abilock-ui": "1",
      },
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      docs: { alias: string; markdown: string }[];
      protocolGuides: { alias: string; kind: string }[];
      guideMarkdown: Record<string, string>;
    };
    assert.equal(
      data.docs.find((doc) => doc.alias === "MANUAL_DB")?.markdown,
      learned.document.markdown,
    );
    const guide = data.protocolGuides.find((doc) => doc.alias === "MANUAL_DB");
    assert.equal(guide?.kind, "mysql");
    // Each protocol's built-in guide text is sent once, keyed by kind.
    assert.equal(
      data.guideMarkdown[guide!.kind],
      await fs.readFile("docs/protocols/databases.md", "utf8"),
    );
    assert(
      !JSON.stringify(data).includes("synthetic-manual-page-password-953242"),
    );
    assert.equal(server.executor.listening, false);
  } finally {
    await server?.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
