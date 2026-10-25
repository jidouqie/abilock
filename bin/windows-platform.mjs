import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export function windowsInstallationPaths(environment = process.env) {
  const folder = (value, fallback) => {
    const selected = value ?? fallback;
    if (
      !/^[A-Za-z]:\\/.test(selected) ||
      /[\r\n\0]/.test(selected) ||
      selected.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid Windows installation location");
    return path.win32.normalize(selected);
  };
  const system = folder(
    environment.SystemRoot ?? environment.WINDIR,
    "C:\\Windows",
  );
  const programFiles = folder(environment.ProgramFiles, "C:\\Program Files");
  const programData = folder(environment.ProgramData, "C:\\ProgramData");
  const root = path.win32.join(programFiles, "Abilock");
  return {
    root,
    system,
    programFiles,
    programData,
    host: path.win32.join(root, "Abilock.Host.exe"),
    app: path.win32.join(root, "desktop", "Abilock.exe"),
  };
}
export function windowsClientEnvironment(environment = process.env) {
  const p = windowsInstallationPaths(environment);
  return {
    SystemRoot: p.system,
    WINDIR: p.system,
    SystemDrive: path.win32.parse(p.system).root.replace(/[\\/]+$/, ""),
    ProgramFiles: p.programFiles,
    ProgramData: p.programData,
    PATH: path.win32.join(p.system, "System32"),
  };
}
export async function validateWindowsInstallation() {
  if (process.platform !== "win32") throw new Error("Windows is required");
  const p = windowsInstallationPaths();
  const info = await fs.lstat(p.host);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("Invalid native host");
  const result = await run(p.host, ["validate"], {
    env: windowsClientEnvironment(),
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16384,
  });
  const metadata = JSON.parse(result.stdout);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    metadata.ok !== true ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version) ||
    !/^S-1-5-21-[0-9-]+$/.test(metadata.ownerSid ?? "") ||
    !/^S-1-5-21-[0-9-]+$/.test(metadata.serviceSid ?? "") ||
    metadata.ownerSid === metadata.serviceSid
  )
    throw new Error("Invalid installation receipt");
  return metadata;
}
