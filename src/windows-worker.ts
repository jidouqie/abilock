import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalWorker } from "./local-worker.js";
import { createStdioWorkerTransport } from "./isolated-worker.js";
import { bootLocalConfig } from "./local-config.js";
import { AppError } from "./schema.js";
import {
  initializeWindowsAdmin,
  readWindowsBootstrapRequest,
  verifyWindowsInitialization,
} from "./windows-bootstrap.js";
import {
  assertWindowsAdmin,
  assertWindowsEnvironment,
  windowsRuntime,
} from "./windows-environment.js";

export type WindowsBootstrapStage = "environment" | "input" | "verify" | "initialize";
const bootstrapStages = new Set<string>(["environment", "input", "verify", "initialize"]);
const bootstrapFailureCodes = new Set<string>([
  "CONFIG_REQUIRED", "LOCAL_CONFIG_INVALID", "CONFIG_BUSY", "BOOTSTRAP_BUSY",
  "PRIVATE_PATH_INVALID", "LOCK_FAILED", "ISOLATION_INVALID", "BOOTSTRAP_FAILED",
]);

/** Closed installer diagnostics: never serialize an exception or request. */
export function windowsBootstrapFailure(stage: WindowsBootstrapStage, error: unknown) {
  const code = error instanceof AppError && bootstrapFailureCodes.has(error.code)
    ? error.code : "BOOTSTRAP_FAILED";
  return {
    ok: false,
    event: "bootstrap-failed",
    stage: bootstrapStages.has(stage) ? stage : "environment",
    code,
  } as const;
}

export async function runWindowsWorker(mode: string) {
  let bootstrapStage: WindowsBootstrapStage = "environment";
  try {
    await assertWindowsEnvironment();
    if (mode === "bootstrap") {
      bootstrapStage = "input";
      const input = await readWindowsBootstrapRequest(process.stdin);
      let event: "initialized" | "setup-required";
      if ("verify" in input) {
        bootstrapStage = "verify";
        event = await verifyWindowsInitialization();
      } else {
        bootstrapStage = "initialize";
        await initializeWindowsAdmin(input.password);
        event = "initialized";
      }
      process.stdout.write(JSON.stringify({ ok: true, event }) + "\n");
      return;
    }
    await assertWindowsAdmin();
    if (mode === "execute") {
      runLocalWorker(
        createStdioWorkerTransport(process.stdin, process.stdout),
        { dir: windowsRuntime.data, programRoot: windowsRuntime.program },
      );
    } else if (mode === "config") {
      const server = await bootLocalConfig({
        dir: windowsRuntime.data,
        requireExisting: true,
        log: () => {},
      });
      process.stdout.write(
        JSON.stringify({ type: "configuration-ready", url: server.adminUrl }) +
          "\n",
      );
      process.stdin.once("end", () => void server.close());
      process.stdin.once("error", () => void server.close());
      process.stdin.resume();
    } else throw new Error("Invalid mode");
  } catch (error) {
    if (mode === "bootstrap") {
      process.stdout.write(JSON.stringify(windowsBootstrapFailure(bootstrapStage, error)) + "\n");
    } else {
      process.stderr.write(
        "ISOLATION_INVALID: The protected Windows runtime is unavailable.\n",
      );
    }
    process.exitCode = 3;
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    !["execute", "config", "bootstrap"].includes(args[0])
  ) {
    process.stderr.write("ISOLATION_INVALID: Invalid worker arguments.\n");
    process.exitCode = 2;
  } else void runWindowsWorker(args[0]);
}
