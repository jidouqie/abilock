import type { Readable } from "node:stream";
import type { PathSnapshot } from "./client-files.mjs";

export interface OutputPlan {
  dest: string;
  temp: string;
  parent: PathSnapshot;
  leaf?: PathSnapshot;
}
export function prepareOutput(
  destination: string,
  options?: { createParents?: boolean },
): Promise<OutputPlan>;
export function saveOutput(
  plan: OutputPlan,
  source: Readable | (() => Readable),
  signal: AbortSignal,
  options?: {
    audit?: (phase: "opened" | "written") => void | Promise<void>;
  },
): Promise<void>;
