import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compareRuntimeVersions } from "./install-isolation.mjs";
import { validateWindowsInstallation } from "./windows-platform.mjs";

export async function ensureWindowsInstallation() {
  try {
    const installed = await validateWindowsInstallation();
    const current = JSON.parse(
      await fs.readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    );
    if (compareRuntimeVersions(installed.version, current.version) < 0)
      throw new Error("A protected runtime update is required");
  } catch {
    throw Object.assign(
      new Error(
        "Run Install-Abilock.ps1 from the verified Windows package to install or update Abilock, then run abl config. Existing data will not be reset.",
      ),
      { code: "ISOLATION_INSTALL", exit: 3 },
    );
  }
}
