// Frozen public Abilock 2.0.0 compatibility fixture; do not modernize this schema.
// Origin: abilock-2.0.0.tgz, package/src/schema.ts.
// Original member SHA-256: 5c5f22ccd8b531661a66fb815158556397d01793728dbe799840c6735ffea53f
// Exact excerpt: authTypes through platformWriteSchema, with only their required imports.
// Unused runtime schemas/types were omitted. No credentials, state, generated
// runtime, package installation, or private acceptance artifacts are included.
import { z } from "zod";
import { capabilityNotesSchema } from "./capability-notes.js";
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
export const platformSchema = z
  .object({
    alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
    name: z.string().min(1).max(100),
    baseUrl: z.string().url().max(1000),
    auth: authSchema,
    // A saved connection can await public documentation. Empty rules never
    // authorize an API call; the execution policy still requires a match.
    rules: z.array(httpRuleSchema).max(1000),
    enabled: z.boolean().default(true),
    allowInsecureLocal: z.boolean().default(false),
    description: z.string().max(2000).default(""),
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
};
export const platformWriteSchema = z
  .object({
    platform: platformSchema,
    secret: secretSchema.optional(),
    clearSecret: z.boolean().optional(),
    expectedRevision: z.number().int().optional(),
  })
  .strict();
