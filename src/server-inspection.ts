import { AppError } from "./schema.js";
import {
  serverInventorySchema,
  type ServerInventory,
} from "./capability-notes.js";

export const inspectionTools = [
  "node",
  "python3",
  "ffmpeg",
  "docker",
  "nginx",
  "git",
  "psql",
  "mysql",
  "redis-cli",
] as const;
// Only this code-owned read-only command is submitted to the configured SSH
// identity. No caller command, file content, path, environment or URL is used.
export const serverInspectionCommand = [
  "printf 'abl-os:'; uname -s || exit 1;",
  "printf 'abl-arch:'; uname -m || exit 1;",
  ...inspectionTools.map(
    (tool) =>
      `if command -v ${tool} >/dev/null 2>&1; then printf 'abl-tool:${tool}\\n'; fi;`,
  ),
].join(" ");

export function parseServerInventory(
  stdout: string,
  now = new Date().toISOString(),
): ServerInventory {
  if (Buffer.byteLength(stdout) > 16384)
    throw new AppError(
      502,
      "INSPECTION_RESULT",
      "服务器概况响应无效；旧概况已保留",
    );
  const lines = stdout.split(/\r?\n/);
  const os = lines.find((line) => line.startsWith("abl-os:"))?.slice(7);
  const architecture = lines
    .find((line) => line.startsWith("abl-arch:"))
    ?.slice(9);
  if (!os || !architecture || !/^[A-Za-z0-9_-]{1,32}$/.test(architecture))
    throw new AppError(
      502,
      "INSPECTION_RESULT",
      "服务器概况响应无效；旧概况已保留",
    );
  return serverInventorySchema.parse({
    inspectedAt: now,
    os: ["Linux", "Darwin", "FreeBSD", "OpenBSD", "NetBSD", "SunOS"].includes(
      os,
    )
      ? os
      : "unknown",
    architecture,
    tools: inspectionTools.filter((tool) => lines.includes(`abl-tool:${tool}`)),
  });
}
