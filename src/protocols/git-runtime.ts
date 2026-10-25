import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../schema.js";
import { windowsHostEnvironment, windowsPaths } from "../windows-paths.js";

const run = promisify(execFile);
export type GitRuntime = {
  windows: boolean;
  binary: string;
  sshHelper?: string;
  environment: NodeJS.ProcessEnv;
  validate(signal?: AbortSignal): Promise<void>;
};

export function productionGitRuntime(): GitRuntime {
  if (process.platform !== "win32") return {
    windows: false, binary: "/usr/bin/git",
    environment: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    validate: async () => {},
  };
  const paths = windowsPaths();
  const git = path.win32.join(paths.install, "git");
  const flavor = process.arch === "arm64" ? "clangarm64" : "ucrt64";
  const binary = path.win32.join(git, "cmd", "git.exe");
  const sshHelper = path.win32.join(paths.install, "Abilock.GitSsh.exe");
  const execPath = path.win32.join(git, flavor, "libexec", "git-core");
  return {
    windows: true, binary, sshHelper,
    environment: {
      SystemRoot: paths.system, WINDIR: paths.system,
      SystemDrive: path.win32.parse(paths.system).root.replace(/[\\/]+$/, ""),
      PATH: [path.win32.join(git, "cmd"), path.win32.join(git, flavor, "bin"),
        path.win32.join(git, "usr", "bin"), path.win32.join(paths.system, "System32")].join(";"),
      GIT_EXEC_PATH: execPath,
      COMSPEC: path.win32.join(paths.system, "System32", "cmd.exe"),
    },
    async validate(signal) {
      try {
        for (const filename of [git, binary, sshHelper, execPath,
          path.win32.join(git, flavor, "bin", "git.exe"),
          path.win32.join(git, flavor, "bin", "git-remote-http.exe"),
          path.win32.join(git, "usr", "bin", "sh.exe")]) {
          signal?.throwIfAborted();
          const stat = await fs.lstat(filename);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error();
          const checked = await run(paths.host, ["check-public", filename],
            { env: windowsHostEnvironment(), windowsHide: true, timeout: 10000, maxBuffer: 1024, signal });
          if (checked.stdout.replace(/\r/g, "") !== "OK\n") throw new Error();
        }
      } catch {
        if (signal?.aborted) throw new AppError(499, "CANCELLED", "Git request was cancelled");
        throw new AppError(503, "GIT_BINARY", "The protected Windows Git runtime is unavailable; reinstall the complete Abilock bundle");
      }
    },
  };
}
