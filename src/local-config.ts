import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalRuntime, localPackageRoot } from "./local-state.js";
import { startServers } from "./server.js";
import { AppError } from "./schema.js";
import {
  assertIsolatedEnvironment,
  assertIsolatedAdmin,
  isolatedDataRoot,
} from "./isolated-environment.js";

export async function bootLocalConfig(
  options: {
    dir?: string;
    adminPort?: number;
    registerSignals?: boolean;
    requireExisting?: boolean;
    log?: (record: Record<string, unknown>) => void;
  } = {},
) {
  const controller = new AbortController();
  let runtime: Awaited<ReturnType<typeof loadLocalRuntime>> | undefined;
  let servers: Awaited<ReturnType<typeof startServers>> | undefined;
  let startupFinished!: () => void;
  const startup = new Promise<void>((resolve) => {
    startupFinished = resolve;
  });
  const signalEvents =
    options.registerSignals === false ? [] : (["SIGINT", "SIGTERM"] as const);
  let closePromise: Promise<void> | undefined;
  const close = () => {
    controller.abort();
    return (closePromise ??= (async () => {
      // Cancellation during loading waits for that path to release any acquired
      // writer lock. Keep signal handlers until all cleanup has completed.
      await startup;
      try {
        await servers?.close();
      } finally {
        try {
          await runtime?.store.close();
        } finally {
          for (const event of signalEvents) process.off(event, onSignal);
        }
      }
    })());
  };
  const onSignal = () => {
    controller.abort();
    void close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  for (const event of signalEvents) process.on(event, onSignal);
  try {
    runtime = await loadLocalRuntime({
      dir: options.dir,
      signal: controller.signal,
      requireExisting: options.requireExisting,
    });
    if (controller.signal.aborted)
      throw new AppError(499, "CANCELLED", "配置页启动已取消");
    servers = await startServers({
      store: runtime.store,
      execToken: runtime.execToken,
      webDir: path.join(localPackageRoot, "dist/web"),
      adminHost: "127.0.0.1",
      adminPort: options.adminPort ?? runtime.adminPort,
      managementOnly: true,
      log: options.log,
    });
    if (controller.signal.aborted)
      throw new AppError(499, "CANCELLED", "配置页启动已取消");
    startupFinished();
    return {
      ...servers,
      store: runtime.store,
      close,
      signal: controller.signal,
    };
  } catch (error) {
    startupFinished();
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const args = process.argv.slice(2);
  const isolated = args.length === 1 && args[0] === "--isolated";
  if (
    !isolated &&
    (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
  ) {
    console.error("USAGE: 配置入口只接受 --json，密钥和密码请在页面填写");
    process.exitCode = 2;
  } else
    (async () => {
      if (isolated) {
        await assertIsolatedEnvironment();
        await assertIsolatedAdmin();
      }
      return bootLocalConfig(
        isolated
          ? {
              dir: isolatedDataRoot,
              requireExisting: true,
              log: () => {},
            }
          : {},
      );
    })()
      .then(async (server) => {
        if (isolated) {
          process.stdout.write(
            JSON.stringify({
              type: "configuration-ready",
              url: server.adminUrl,
            }) + "\n",
          );
          process.stdin.once("end", () => void server.close());
          process.stdin.once("error", () => void server.close());
          process.stdin.resume();
          return;
        }
        if (args[0] === "--json")
          console.log(
            JSON.stringify({
              ok: true,
              event: "configuration-ready",
              data: {
                url: server.adminUrl,
                temporary: true,
                executionMode: "local-cli",
              },
            }),
          );
        else
          console.log(
            `Abilock 临时配置页：${server.adminUrl}\n正在打开 Chrome。配置完成后按 Ctrl+C 关闭；日常调用无需保持此窗口。`,
          );
        try {
          // Compiled code lives under dist/src; locate the public opener at the
          // installed package root instead of importing a nonexistent dist/bin.
          const opener = (await import(
            pathToFileURL(path.join(localPackageRoot, "bin/open-config.mjs"))
              .href
          )) as {
            openConfigPage(
              url: string,
              options: { signal: AbortSignal },
            ): Promise<string>;
          };
          await opener.openConfigPage(server.adminUrl, {
            signal: server.signal,
          });
        } catch {
          if (!server.signal.aborted)
            console.error(
              "未能自动打开浏览器，请在 Chrome 手动打开上面的配置地址。配置页仍可用。",
            );
        }
      })
      .catch((error: unknown) => {
        if (error instanceof AppError && error.code === "CANCELLED") {
          process.exitCode = 130;
          return;
        }
        // Startup never prints file content, credentials, or exception stacks.
        console.error(
          error instanceof AppError
            ? `${error.code}: ${error.message}`
            : "配置页启动失败，请检查本机配置或端口占用",
        );
        process.exitCode = 1;
      });
}
