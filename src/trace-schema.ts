import { z } from "zod";

// Caller metadata can identify its current invocation, never an operation.
export const traceInputSchema = z.object({ invocationId: z.uuid() }).strict();
export type TraceInput = z.infer<typeof traceInputSchema>;

// A full trace is created and carried by trusted service/worker code only.
export const operationTraceSchema = z
  .object({ invocationId: z.uuid(), operationId: z.uuid() })
  .strict();
export type Trace = z.infer<typeof operationTraceSchema>;
