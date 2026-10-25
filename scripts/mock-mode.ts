import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mockUpstream, MOCK_BEARER, MOCK_HEADER } from "./mock-upstream.js";
import { boot } from "../src/start.js";
export const MOCK_EXEC = "mock-execution-capability-not-real-0002";
// Entire state and encryption key are disposable. These are mock credentials only.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-mock-"));
delete process.env.ABILOCK_ADMIN_TOKEN;
delete process.env.COI_ADMIN_TOKEN;
delete process.env.PERMIVELO_ADMIN_TOKEN;
const mockMasterKey = crypto.randomBytes(32).toString("hex");
Object.assign(process.env, {
  ABILOCK_MASTER_KEY: mockMasterKey,
  ABILOCK_EXEC_TOKEN: MOCK_EXEC,
  ABILOCK_DATA_DIR: dir,
  ABILOCK_ADMIN_HOST: "127.0.0.1",
  ABILOCK_EXEC_HOST: "127.0.0.1",
  ABILOCK_ALLOW_LOCAL: "1",
  ABILOCK_MOCK: "1",
});
const mock = await mockUpstream(Number(process.env.ABILOCK_MOCK_PORT ?? 4316));
const service = await boot({ registerSignals: false });
for (const [alias, name, key, auth] of [
  ["MOCK_BEARER", "本机 mock · Bearer", MOCK_BEARER, { type: "bearer" }],
  [
    "MOCK_HEADER",
    "本机 mock · Header Key",
    MOCK_HEADER,
    { type: "header", name: "X-API-Key" },
  ],
] as const) {
  await service.store.save(
    {
      alias,
      name,
      baseUrl: mock.url,
      auth,
      enabled: true,
      allowInsecureLocal: true,
      description:
        "仅本机无真实凭据验证；可编辑、录入 mock 密钥、读文档和调用。",
      rules: [
        { method: "POST", path: "/echo" },
        { method: "POST", path: "/require-auth" },
        { method: "POST", path: "/error401" },
        { method: "POST", path: "/error500" },
        { method: "GET", path: "/stream" },
        { method: "GET", path: "/binary" },
        { method: "GET", path: "/slow" },
        { method: "GET", path: "/redirect" },
        { method: "POST", path: "/tasks" },
        { method: "GET", path: "/tasks/*" },
      ],
    },
    { value: key },
    false,
    0,
  );
  await service.store.saveDoc(
    alias,
    {
      title: "Mock REST · JSON / 文件 / 流 / 任务",
      sourceUrl: `${mock.url}/docs`,
      markdown:
        "# 本机 mock 接口\n\nPOST /echo 使用 body 原生 JSON；GET /stream 返回 SSE；GET /binary 返回二进制；POST /tasks 提交任务，GET /tasks/task-001 查询状态。\n\n秘密由服务自动注入。不要把鉴权字段放进请求。",
    },
    "manual",
  );
}
console.log(
  "本机 mock 已就绪：管理密码尚未设置，请在本机管理页首次设置。数据及密码记录保存在临时目录，重开 mock 会丢弃；abl 仅使用 mock 执行能力令牌。",
);
let closing = false;
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.once(s, () => {
    if (closing) return;
    closing = true;
    void Promise.all([service.close(), mock.close()])
      .then(async () => {
        await fs.rm(dir, { recursive: true, force: true });
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
