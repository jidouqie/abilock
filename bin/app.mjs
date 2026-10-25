import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  validateWindowsInstallation,
  windowsInstallationPaths,
  windowsClientEnvironment,
} from "./windows-platform.mjs";

export const macApplication =
  "/usr/local/libexec/abilock/runtime/desktop/Abilock.app";
export async function openApplication() {
  let executable, args, options;
  if (process.platform === "darwin") {
    const app = await fs.lstat(macApplication).catch(() => undefined);
    if (
      !app?.isDirectory() ||
      app.isSymbolicLink() ||
      app.uid !== 0 ||
      app.mode & 0o022
    )
      throw Object.assign(
        new Error(
          "Install or update the complete Abilock desktop package first.",
        ),
        { code: "APPLICATION_REQUIRED", exit: 3 },
      );
    executable = "/usr/bin/open";
    args = [macApplication];
    options = { env: { PATH: "/usr/bin:/bin" } };
  } else if (process.platform === "win32") {
    await validateWindowsInstallation();
    const p = windowsInstallationPaths();
    executable = p.app;
    args = [];
    options = {
      env: {
        ...windowsClientEnvironment(),
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        USERPROFILE: process.env.USERPROFILE,
      },
      windowsHide: false,
    };
  } else
    throw Object.assign(
      new Error("The desktop application supports macOS and Windows."),
      { code: "APPLICATION_UNSUPPORTED", exit: 3 },
    );
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () =>
      reject(
        Object.assign(
          new Error("The Abilock application could not be started."),
          { code: "APPLICATION_START", exit: 3 },
        ),
      ),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
