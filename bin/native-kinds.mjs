// CLI command names for each protocol connection kind. Every kind in
// src/protocol-kinds.ts must appear here; tests enforce the match.
export const nativeKinds = new Map([
  ["ssh", "ssh"],
  ["sftp", "ssh"],
  ["scp", "ssh"],
  ["rsync", "ssh"],
  ["postgres", "postgres"],
  ["psql", "postgres"],
  ["mysql", "mysql"],
  ["redis", "redis"],
  ["git", "git"],
  ["s3", "s3"],
  ["aws", "aws"],
  ["docker", "docker"],
  ["registry", "registry"],
  ["kubectl", "kubernetes"],
  ["kubernetes", "kubernetes"],
]);
