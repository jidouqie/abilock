import { spawn } from "node:child_process";
import { createIsolatedTransport } from "./isolated-transport.mjs";
import {
  validateWindowsInstallation,
  windowsClientEnvironment,
  windowsInstallationPaths,
} from "./windows-platform.mjs";

async function launch(mode) {
  try {
    await validateWindowsInstallation();
  } catch {
    throw Object.assign(
      new Error(
        "Install the complete Abilock Windows package before using local commands. No unprotected fallback is available.",
      ),
      { code: "ISOLATION_REQUIRED", exit: 3 },
    );
  }
  const p = windowsInstallationPaths();
  return spawn(p.host, ["client", mode], {
    cwd: p.root,
    env: windowsClientEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const transport = createIsolatedTransport({ launch });
export const brokerFetch = transport.brokerFetch;
export const localConfiguration = transport.localConfiguration;
export const localTerminal = transport.localTerminal;
