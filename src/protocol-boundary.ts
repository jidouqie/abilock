import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import ipaddr from "ipaddr.js";
import { AppError } from "./schema.js";
import type { Connection } from "./connections.js";
import { awaitWithSignal } from "./async-boundary.js";
export type ResolvedTargetOptions = {
  ownAddresses?: Iterable<string>;
  allowLocalFixture?: boolean;
};
function normalizeAddress(raw: string) {
  if (
    (raw.startsWith("[") || raw.endsWith("]")) &&
    !(raw.startsWith("[") && raw.endsWith("]"))
  )
    throw new Error("INVALID_ADDRESS");
  const withoutBrackets = raw.startsWith("[") ? raw.slice(1, -1) : raw;
  const [address, scope, ...extra] = withoutBrackets.split("%");
  if (
    scope !== undefined &&
    (!address.includes(":") || !/^[A-Za-z0-9_.-]+$/.test(scope) || extra.length)
  )
    throw new Error("INVALID_ADDRESS");
  const parsed = ipaddr.process(address);
  return { address: parsed.toNormalizedString(), range: parsed.range() };
}
// Validate every result from the same DNS resolution used by the actual socket.
// This function never resolves DNS, starts a client, or chooses a different address.
export function assertResolvedTargetBoundary(
  rows: readonly { address: string }[],
  options: ResolvedTargetOptions = {},
): void {
  if (!rows.length)
    throw new AppError(400, "INVALID_TARGET", "目标DNS无可用地址");
  const own = new Set(
    Array.from(
      options.ownAddresses ??
        Object.values(os.networkInterfaces()).flatMap((list) =>
          (list ?? []).map((row) => row.address),
        ),
      (address) => normalizeAddress(address).address,
    ),
  );
  const metadata = new Set(
    ["169.254.169.254", "100.100.100.200", "fd00:ec2::254"].map(
      (address) => normalizeAddress(address).address,
    ),
  );
  for (const row of rows) {
    let parsed: ReturnType<typeof normalizeAddress>;
    try {
      parsed = normalizeAddress(row.address);
    } catch {
      throw new AppError(400, "INVALID_TARGET", "目标DNS包含无效地址");
    }
    const fixtureLoopback =
      options.allowLocalFixture === true && parsed.range === "loopback";
    if (
      metadata.has(parsed.address) ||
      (!fixtureLoopback &&
        (!["unicast", "private", "uniqueLocal", "carrierGradeNat"].includes(
          parsed.range,
        ) ||
          own.has(parsed.address)))
    )
      throw new AppError(
        403,
        "BROKER_TARGET_REJECTED",
        "禁止broker自身地址、loopback、metadata或特殊网络目标",
      );
  }
}
export async function assertTargetBoundary(
  connection: Connection,
  allowLocal: boolean,
  signal?: AbortSignal,
) {
  if (signal?.aborted) await awaitWithSignal(Promise.resolve(), signal);
  if (allowLocal) return;
  if (connection.trustBoundary !== "independent-target")
    throw new AppError(
      403,
      "TARGET_TRUST_REQUIRED",
      "请在管理页确认远端权限不涵盖broker主机、文件、进程或集群资源；这不等于已部署强隔离",
    );
  const hosts: string[] = [];
  if (typeof connection.config.host === "string")
    hosts.push(connection.config.host);
  for (const key of ["endpoint", "url"])
    if (typeof connection.config[key] === "string") {
      try {
        hosts.push(
          new URL(connection.config[key] as string).hostname.replace(
            /[[\]]/g,
            "",
          ),
        );
      } catch {
        throw new AppError(400, "INVALID_TARGET", "目标无效");
      }
    }
  const ends = connection.config.endpoints;
  if (ends && typeof ends === "object")
    for (const val of Object.values(ends))
      if (typeof val === "string")
        hosts.push(
          new URL(val).hostname.replaceAll("[", "").replaceAll("]", ""),
        );
  for (const host of hosts) {
    if (
      host === os.hostname() ||
      host === "localhost" ||
      host.endsWith(".localhost")
    )
      throw new AppError(
        403,
        "BROKER_TARGET_REJECTED",
        "不得让远端业务权限管理broker自身主机",
      );
    const rows = net.isIP(host)
      ? [{ address: host }]
      : await awaitWithSignal(dns.lookup(host, { all: true }), signal);
    assertResolvedTargetBoundary(rows);
  }
}
