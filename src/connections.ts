import { z } from "zod";
import requestLimits from "../request-limits.json" with { type: "json" };
import {
  capabilityNotesSchema,
  type ServerInventory,
} from "./capability-notes.js";
import { traceInputSchema } from "./trace-schema.js";
import type { OperationTrace } from "./operation-trace.js";
import { connectionNoteSchema } from "./schema.js";
import { connectionKinds } from "./protocol-kinds.js";
export { connectionKinds };
export const connectionSchema = z
  .object({
    alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
    name: z.string().min(1).max(100),
    note: connectionNoteSchema,
    kind: z.enum(connectionKinds),
    enabled: z.boolean().default(true),
    description: z.string().max(2000).default(""),
    documentationUrl: z.string().url().max(1500).nullable().optional(),
    capabilityNotes: capabilityNotesSchema.optional(),
    trustBoundary: z
      .enum(["independent-target", "development-fixture"])
      .optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((connection, ctx) => {
    if (
      connection.capabilityNotes?.some(
        (note) => note.method !== undefined || note.path !== undefined,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "协议能力说明不能添加 HTTP 方法或路径",
        path: ["capabilityNotes"],
      });
  });
export type Connection = z.infer<typeof connectionSchema>;
export type Credentials = Record<string, string>;
export type SavedConnection = Connection & {
  revision: number;
  updatedAt: string;
  sealed?: string;
  inventory?: ServerInventory;
  learnedDocId?: string;
  learnedDocumentationUrl?: string | null;
  /** Hash of public protocol configuration at the last successful learning. */
  learnedContext?: string;
};
export const connectionWriteSchema = z
  .object({
    connection: connectionSchema,
    secret: z.record(z.string(), z.string().min(1).max(100000)).optional(),
    clearSecret: z.boolean().optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();
export const operationSchema = z
  .object({
    trace: traceInputSchema.optional(),
    args: z.array(z.string().max(100000)).max(200),
    input: z.string().max(20000000).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(1000),
            base64: z.string().max(16000000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    deletions: z
      .array(
        z
          .object({
            path: z.string().max(1000),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(requestLimits.protocolMaxTimeoutMs)
      .default(30000),
  })
  .strict();
export type Operation = z.infer<typeof operationSchema>;
export type AdapterContext = {
  connection: Connection;
  secret: Credentials;
  signal: AbortSignal;
  allowLocal: boolean;
  dataDir: string;
  trace?: OperationTrace;
};
export type AdapterResult = {
  exitCode: number;
  /** Transport status, when available; preserves classification without parsing remote text. */
  httpStatus?: number;
  stdout?: string;
  stderr?: string;
  data?: unknown;
  batch?: {
    status: "completed" | "failed" | "cancelled";
    items: {
      /** Zero-based position in the caller's original batch. */
      index: number;
      target: string;
      status: "completed" | "failed" | "unknown" | "not-started";
      exitCode?: number;
      error?: { code: string; message: string };
    }[];
  };
  files?: { path: string; base64: string }[];
  invocationId?: string;
  operationId?: string;
};
export type Adapter = {
  validate: (connection: Connection, secret?: Credentials) => void;
  run: (
    context: AdapterContext,
    operation: Operation,
  ) => Promise<AdapterResult>;
  /** Broker-side state kept under an alias, such as Git workspaces. Called
   * after a committed removal; best effort, never part of the transaction. */
  removeState?: (dataDir: string, alias: string) => Promise<void>;
  /** Moves alias-owned broker state after a committed alias change. */
  renameState?: (dataDir: string, from: string, to: string) => Promise<void>;
};
