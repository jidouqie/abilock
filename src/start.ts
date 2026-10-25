import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { startServers } from "./server.js";
import { seed } from "./seed.js";
import os from "node:os";
import { setting } from "./environment.js";

export function resolveDataDirectory(
  cwd: string,
  home: string,
  explicit?: string,
) {
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new Error("ABILOCK_DATA_DIR 不能是空值");
    if (explicit === "~") return path.resolve(home);
    return path.resolve(
      cwd,
      explicit.startsWith("~/") ? path.join(home, explicit.slice(2)) : explicit,
    );
  }
  return path.join(home, ".abilock");
}
export async function boot(options: { registerSignals?: boolean } = {}) {
  const ABILOCK_MASTER_KEY = setting("MASTER_KEY");
  const ABILOCK_ADMIN_TOKEN = setting("ADMIN_TOKEN");
  const ABILOCK_EXEC_TOKEN = setting("EXEC_TOKEN");
  if (!ABILOCK_MASTER_KEY || !ABILOCK_EXEC_TOKEN)
    throw new Error(
      "启动需要 ABILOCK_MASTER_KEY 与 ABILOCK_EXEC_TOKEN，请由用户在可信服务环境配置。管理密码首次在本机页面设置；临时验证使用 npm run dev:mock。",
    );
  const root = process.cwd(),
    explicit = setting("DATA_DIR"),
    dir = resolveDataDirectory(root, os.homedir(), explicit);
  if (
    explicit === undefined &&
    (await fs.access(path.join(root, "data", "state.json")).then(
      () => true,
      () => false,
    ))
  )
    throw new Error(
      "发现项目目录内的旧数据。请由用户设置 ABILOCK_DATA_DIR 指向原数据目录，或自行备份后迁移到 ~/.abilock；不会自动搬迁或另建空白配置。",
    );
  const fresh = await fs.access(path.join(dir, "state.json")).then(
    () => false,
    () => true,
  );
  const store = new Store(dir, ABILOCK_MASTER_KEY, [
    ABILOCK_EXEC_TOKEN,
    ...(ABILOCK_ADMIN_TOKEN ? [ABILOCK_ADMIN_TOKEN] : []),
  ]);
  await store.init();
  try {
    if (fresh) await seed(store, root);
    const hosts = {
      adminHost: setting("ADMIN_HOST") ?? "127.0.0.1",
      execHost: setting("EXEC_HOST") ?? "127.0.0.1",
    };
    if (
      Object.values(hosts).some((h) => h !== "127.0.0.1") &&
      setting("ISOLATED_BIND") !== "1"
    )
      throw new Error(
        "非 loopback 监听需显式 ABILOCK_ISOLATED_BIND=1，并遵循隔离部署说明",
      );
    const servers = await startServers({
      store,
      adminToken: ABILOCK_ADMIN_TOKEN,
      execToken: ABILOCK_EXEC_TOKEN,
      webDir: path.join(root, "dist/web"),
      adminPort: Number(setting("ADMIN_PORT") ?? 4317),
      execPort: Number(setting("EXEC_PORT") ?? 4318),
      ...hosts,
    });
    console.log(
      JSON.stringify({
        event: "started",
        management: servers.adminUrl,
        execution: servers.execUrl,
        mode: setting("MOCK") === "1" ? "mock" : "local",
        message: "启动信息不含任何凭据",
      }),
    );
    const close = async () => {
      await servers.close();
      await store.close();
    };
    let closing = false;
    for (const event of options.registerSignals === false
      ? []
      : (["SIGINT", "SIGTERM"] as const))
      process.once(event, () => {
        if (!closing) {
          closing = true;
          void close().then(() => process.exit(0));
        }
      });
    return { store, ...servers, close };
  } catch (e) {
    await store.close();
    throw e;
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  boot().catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  });
