import crypto from "node:crypto";
import type { Connection } from "./connections.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Bind learned usage to public target, identity and execution scope only. */
export function connectionUsageContext(connection: Connection): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          kind: connection.kind,
          config: connection.config,
          trustBoundary: connection.trustBoundary,
        }),
      ),
    )
    .digest("hex");
}
