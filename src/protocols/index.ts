import type { Adapter } from "../connections.js";
import { connectionKinds, type ConnectionKind } from "../protocol-kinds.js";
import { sshAdapter } from "./ssh.js";
import { postgresAdapter, mysqlAdapter, redisAdapter } from "./databases.js";
import { gitAdapter } from "./git.js";
import { s3Adapter, awsAdapter } from "./cloud.js";
import { dockerAdapter, kubernetesAdapter } from "./containers.js";
import { registryAdapter } from "./registry.js";
export const protocolAdapters: Record<ConnectionKind, Adapter> = {
  ssh: sshAdapter,
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
  redis: redisAdapter,
  git: gitAdapter,
  s3: s3Adapter,
  aws: awsAdapter,
  registry: registryAdapter,
  docker: dockerAdapter,
  kubernetes: kubernetesAdapter,
};
// Keyed by kind so a new protocol cannot be added without its description.
const capabilityByKind: Record<
  ConnectionKind,
  { commands: string[]; documentation: string }
> = {
  ssh: {
    commands: [
      "remote command",
      "interactive PTY",
      "sftp ls/stat/put/get/mkdir/rm",
      "scp transfer",
      "rsync manifest delta",
    ],
    documentation: "ssh.md",
  },
  postgres: {
    commands: [
      "SQL -c / stdin",
      "parameterized SQL",
      "uploaded scripts",
      "single-call transactions",
    ],
    documentation: "databases.md",
  },
  mysql: {
    commands: [
      "SQL -e / stdin",
      "parameterized SQL",
      "uploaded scripts",
      "single-call transactions",
    ],
    documentation: "databases.md",
  },
  redis: {
    commands: ["native Redis commands", "-x binary stdin", "--pipe RESP batch"],
    documentation: "databases.md",
  },
  git: {
    commands: [
      "clone",
      "fetch",
      "pull",
      "push",
      "commit",
      "status",
      "log",
      "workspaces",
      "drop",
    ],
    documentation: "git.md",
  },
  s3: {
    commands: ["list/get/put/head/delete/copy/move (S3/R2/OSS subset)"],
    documentation: "cloud.md",
  },
  aws: {
    commands: [
      "sts get-caller-identity",
      "ec2 describe/start/stop/reboot",
      "s3api subset",
    ],
    documentation: "cloud.md",
  },
  registry: {
    commands: [
      "ping/catalog/tags",
      "manifest get/head/put/delete",
      "blob get/head/put/delete",
    ],
    documentation: "registry.md",
  },
  docker: {
    commands: [
      "ps",
      "images",
      "inspect",
      "logs",
      "start",
      "stop",
      "restart",
      "rm",
      "create",
    ],
    documentation: "containers.md",
  },
  kubernetes: {
    commands: [
      "get",
      "list",
      "describe",
      "create",
      "apply",
      "delete",
      "patch",
      "logs",
      "scale",
      "rollout restart",
    ],
    documentation: "containers.md",
  },
};
export const capabilities = connectionKinds.map((kind) => ({
  kind,
  ...capabilityByKind[kind],
}));
export function capabilityFor(kind: ConnectionKind) {
  return { kind, ...capabilityByKind[kind] };
}
