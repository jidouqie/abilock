import { z } from "zod";
import { capabilityNotesSchema } from "./capability-notes.js";
import { traceInputSchema } from "./trace-schema.js";
import requestLimits from "../request-limits.json" with { type: "json" };
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const authTypes = [
  "none",
  "bearer",
  "header",
  "query",
  "basic",
  "adapter",
] as const;
export const authSchema = z
  .object({
    type: z.enum(authTypes),
    name: z.string().max(80).optional(),
    adapter: z.string().max(80).optional(),
  })
  .strict();
export const chatSchema = z
  .object({
    method: z.literal("POST"),
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\/[A-Za-z0-9/_~.:-]*$/),
    model: z.string().trim().min(1).max(256),
  })
  .strict();
export const httpRuleSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    path: z.string().min(1).max(500),
  })
  .strict();
// Omitted notes preserve existing values on writes; an explicit empty note
// clears the label. Store normalizes new and legacy records to an empty string.
export const connectionNoteSchema = z.string().trim().max(200).optional();
export const platformSchema = z
  .object({
    alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
    name: z.string().min(1).max(100),
    note: connectionNoteSchema,
    baseUrl: z.string().url().max(1000),
    auth: authSchema,
    // A saved connection can await public documentation. Empty rules never
    // authorize an API call; the execution policy still requires a match.
    rules: z.array(httpRuleSchema).max(1000),
    enabled: z.boolean().default(true),
    allowInsecureLocal: z.boolean().default(false),
    description: z.string().max(2000).default(""),
    documentationUrl: z.string().url().max(1500).nullable().optional(),
    capabilityNotes: capabilityNotesSchema.optional(),
    chat: chatSchema.nullable().optional(),
  })
  .strict()
  .superRefine((platform, ctx) => {
    if (
      platform.chat &&
      !platform.rules.some(
        (rule) =>
          rule.method === platform.chat!.method &&
          rule.path === platform.chat!.path,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "聊天快捷配置必须绑定已允许的 POST 接口",
        path: ["chat"],
      });
    for (const note of platform.capabilityNotes ?? []) {
      if (
        !platform.rules.some(
          (rule) => rule.method === note.method && rule.path === note.path,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "能力说明必须选择已允许的方法与路径",
          path: ["capabilityNotes"],
        });
    }
  });
export type Platform = z.infer<typeof platformSchema>;
export const secretSchema = z
  .object({
    value: z.string().min(1).max(4096).optional(),
    username: z.string().max(500).optional(),
    password: z.string().max(4096).optional(),
  })
  .strict();
export type Secret = z.infer<typeof secretSchema>;
export type SavedPlatform = Platform & {
  revision: number;
  updatedAt: string;
  sealed?: string;
  learnedDocId?: string;
  learnedDocumentationUrl?: string | null;
  /** Set when the target or authentication changed after learning. */
  learnedContext?: "identity-changed";
};
export const platformWriteSchema = z
  .object({
    platform: platformSchema,
    secret: secretSchema.optional(),
    clearSecret: z.boolean().optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();
export const docSchema = z
  .object({
    title: z.string().min(1).max(200),
    sourceUrl: z.string().url().max(1500),
    markdown: z.string().min(1).max(2_000_000),
  })
  .strict();
export const docVersionSchema = docSchema
  .extend({
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type DocVersion = z.infer<typeof docVersionSchema>;
export type Doc = z.infer<typeof docSchema> & {
  id: string;
  alias: string;
  updatedAt: string;
  mode: "manual" | "fetched";
  revision: number;
  previous?: DocVersion;
};
export const requestSchema = z
  .object({
    trace: traceInputSchema.optional(),
    // Explicit local-only observation; never supplied to the upstream API.
    experience: z
      .object({
        capture: z.literal(true),
        methodId: z.uuid().optional(),
      })
      .strict()
      .optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    path: z.string().min(1).max(1000),
    query: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number(), z.boolean()])),
        ]),
      )
      .optional(),
    headers: z.record(z.string(), z.string().max(4096)).optional(),
    body: z.unknown().optional(),
    rawBody: z
      .object({
        base64: z.string().max(16_000_000),
        contentType: z.string().max(150),
      })
      .strict()
      .optional(),
    multipart: z
      .object({
        fields: z.record(z.string(), z.string()).optional(),
        files: z
          .array(
            z
              .object({
                field: z.string().max(100),
                filename: z.string().max(200),
                contentType: z.string().max(150),
                base64: z.string().max(16_000_000),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(requestLimits.httpMaxTimeoutMs)
      .default(requestLimits.httpDefaultTimeoutMs),
  })
  .strict()
  .refine(
    (r) =>
      [r.body !== undefined, !!r.rawBody, !!r.multipart].filter(Boolean)
        .length <= 1,
    "body / rawBody / multipart 只能选一个",
  );
export type Call = z.infer<typeof requestSchema>;
export type State = {
  version: 1;
  platforms: SavedPlatform[];
  docs: Doc[];
  connections?: import("./connections.js").SavedConnection[];
  discovery?: import("./discovery.js").DiscoveryCatalog;
  /** In memory only: stored records this version cannot validate (for example
   * a newer protocol kind). They are never executable, and every commit writes
   * them back unchanged instead of deleting another version's data. */
  unrecognized?: { platforms: unknown[]; connections: unknown[] };
};
