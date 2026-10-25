import { z } from "zod";

export const LOCAL_REQUEST_MAX_BODY = 20 * 1024 * 1024;
// One IPC request envelope from the CLI to the one-shot local worker.
export const localRequestSchema = z
  .object({
    type: z.literal("request"),
    url: z.string().min(1).max(1200),
    method: z.enum(["GET", "POST"]),
    headers: z.record(z.string().max(100), z.string().max(4096)).default({}),
    body: z.string().max(LOCAL_REQUEST_MAX_BODY).optional(),
  })
  .strict();
export type LocalRequest = z.input<typeof localRequestSchema>;
