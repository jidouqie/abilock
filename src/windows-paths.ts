import path from "node:path";

/** The trusted Windows host replaces these OS variables before starting Node. */
export function windowsPaths(environment: NodeJS.ProcessEnv = process.env) {
  const folder = (value: string | undefined, fallback: string) => {
    const selected = value ?? fallback;
    if (
      !/^[A-Za-z]:\\/.test(selected) ||
      /[\r\n\0]/.test(selected) ||
      selected.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid Windows installation location");
    return path.win32.normalize(selected);
  };
  const programFiles = folder(environment.ProgramFiles, "C:\\Program Files");
  const programData = folder(environment.ProgramData, "C:\\ProgramData");
  const system = folder(
    environment.SystemRoot ?? environment.WINDIR,
    "C:\\Windows",
  );
  const install = path.win32.join(programFiles, "Abilock");
  const data = path.win32.join(programData, "Abilock", "private");
  return {
    install,
    data,
    system,
    program: path.win32.join(install, "runtime"),
    host: path.win32.join(install, "Abilock.Host.exe"),
    node: path.win32.join(install, "node.exe"),
    temporary: path.win32.join(data, "tmp"),
  };
}

export function sameWindowsPath(left: string, right: string) {
  return (
    path.win32
      .normalize(left)
      .replace(/[\\/]+$/, "")
      .toLowerCase() ===
    path.win32
      .normalize(right)
      .replace(/[\\/]+$/, "")
      .toLowerCase()
  );
}

export function windowsHostEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const paths = windowsPaths(environment);
  return {
    SystemRoot: paths.system,
    WINDIR: paths.system,
    SystemDrive: path.win32.parse(paths.system).root.replace(/[\\/]+$/, ""),
    ProgramFiles: path.win32.dirname(paths.install),
    ProgramData: path.win32.dirname(path.win32.dirname(paths.data)),
    PATH: path.win32.join(paths.system, "System32"),
    USERPROFILE: paths.data,
    HOME: paths.data,
    TEMP: paths.temporary,
    TMP: paths.temporary,
  };
}
