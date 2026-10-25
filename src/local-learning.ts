import { z } from "zod";
import { traceInputSchema } from "./trace-schema.js";
import { localRequestSchema } from "./local-request.js";

export const learningRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      sourceUrl: z.string().url().max(1500),
      trace: traceInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("manifest"),
      manifest: z.unknown(),
      trace: traceInputSchema.optional(),
    })
    .strict(),
]);

export function learningWriteRequest(raw: unknown) {
  const request = localRequestSchema.safeParse(raw);
  if (
    !request.success ||
    request.data.method !== "POST" ||
    !/^\/v2\/learn\/[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(request.data.url) ||
    request.data.body === undefined ||
    Buffer.byteLength(request.data.body) > 20 * 1024 * 1024
  )
    return false;
  try {
    const payload = learningRequestSchema.safeParse(
      JSON.parse(request.data.body),
    );
    return payload.success && payload.data.kind === "manifest";
  } catch {
    return false;
  }
}
