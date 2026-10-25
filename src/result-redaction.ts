import type { AdapterResult } from "./connections.js";
import { safeOperationTrace } from "./operation-trace.js";
import { redact, Redactor } from "./security.js";

// Shared service-side output boundary. Credentials never reach a transport.
export function cleanJson(value: unknown, secrets: string[]): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 100) return "[NESTING_LIMIT]";
    if (typeof v === "string") return redact(v, secrets);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, item]) => [
          depth === 0 ? key : redact(key, secrets),
          walk(item, depth + 1),
        ]),
      );
    return v;
  };
  return walk(JSON.parse(JSON.stringify(value)), 0);
}

export async function cleanResult(result: AdapterResult, secrets: string[]) {
  const cleaned = cleanJson(
    {
      ...result,
      files: undefined,
      invocationId: undefined,
      operationId: undefined,
    },
    secrets,
  ) as AdapterResult;
  if (result.invocationId && result.operationId) {
    const trace = safeOperationTrace(
      { invocationId: result.invocationId, operationId: result.operationId },
      secrets,
    );
    cleaned.invocationId = trace.invocationId;
    cleaned.operationId = trace.operationId;
  }
  if (result.files)
    cleaned.files = await Promise.all(
      result.files.map(async (file) => {
        const filter = new Redactor(secrets),
          chunks: Buffer[] = [];
        filter.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        await new Promise<void>((resolve, reject) => {
          filter.once("end", resolve);
          filter.once("error", reject);
          filter.end(Buffer.from(file.base64, "base64"));
        });
        return {
          path: redact(file.path, secrets),
          base64: Buffer.concat(chunks).toString("base64"),
        };
      }),
    );
  return cleaned;
}
