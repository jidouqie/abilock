import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executionGateway } from "../src/execution-gateway.js";
import { startServers } from "../src/server.js";
import { Store } from "../src/store.js";
test("独立执行网关只能访问 /v1，无法用执行凭据进入管理面", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-boundary-"));
  const store = new Store(dir, "1".repeat(64));
  await store.init();
  const execToken = "isolated-execution-capability-001";
  const core = await startServers({
    store,
    adminToken: "isolated-management-capability-002",
    execToken,
    webDir: path.resolve("dist/web"),
    adminPort: 0,
    execPort: 0,
    log: () => {},
  });
  const gateway = await executionGateway({
    coreUrl: core.execUrl,
    execToken,
    port: 0,
  });
  try {
    const read = await fetch(gateway.url + "/v1/platforms", {
      headers: { authorization: `Bearer ${execToken}` },
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { platforms: [] });
    for (const url of [
      "/admin/platforms",
      "/v1/secrets",
      "/v1/platforms?target=/admin/platforms",
      "//core/admin/platforms",
      "/%2e%2e/admin/platforms",
    ]) {
      const res = await fetch(gateway.url + url, {
        headers: { authorization: `Bearer ${execToken}` },
      });
      assert.equal(res.status, 404);
    }
    const direct = await fetch(core.adminUrl + "/admin/platforms", {
      headers: { authorization: `Bearer ${execToken}` },
    });
    assert.equal(direct.status, 401);
    const source = await fs.readFile("src/execution-gateway.ts", "utf8");
    assert(!/import .*store/.test(source));
    assert(!source.includes("ABILOCK_MASTER_KEY"));
    assert(!source.includes("ABILOCK_ADMIN_TOKEN"));
    const compose = await fs.readFile("deploy/compose.yaml", "utf8");
    const gatewayConfig = compose
      .split("  execution-gateway:")[1]
      .split("\nnetworks:")[0];
    assert(!gatewayConfig.includes("volumes:"));
    assert(!gatewayConfig.includes("ABILOCK_ADMIN_TOKEN"));
    assert(!gatewayConfig.includes("ABILOCK_MASTER_KEY"));
  } finally {
    await gateway.close();
    await core.close();
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
