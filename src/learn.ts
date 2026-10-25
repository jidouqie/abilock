import { z } from "zod";
import { AppError, chatSchema, httpRuleSchema } from "./schema.js";
import { capabilityNotesSchema } from "./capability-notes.js";
import { assertDocumentMetadata } from "./docs.js";
import { cleanPath, safeUrl } from "./security.js";
import type { Store } from "./store.js";

// This is an assistant-produced public API description, not a connection or
// credential configuration. Unknown fields fail closed, including executable
// code, target/auth overrides, adapters, and vendor credentials.
export const learnManifestSchema = z
  .object({
    sourceUrl: z.string().url().max(1500),
    title: z.string().trim().min(1).max(200),
    markdown: z.string().trim().min(1).max(2_000_000),
    description: z.string().max(2000).optional(),
    rules: z
      .array(httpRuleSchema)
      .min(1)
      .max(1000)
      .refine(
        (rules) =>
          new Set(rules.map((rule) => `${rule.method} ${rule.path}`)).size ===
          rules.length,
        "接口不能重复",
      ),
    capabilityNotes: capabilityNotesSchema.default([]),
    chat: chatSchema.optional(),
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((input, ctx) => {
    const isAllowed = (method?: string, path?: string) =>
      input.rules.some((rule) => rule.method === method && rule.path === path);
    if (input.chat && !isAllowed(input.chat.method, input.chat.path))
      ctx.addIssue({
        code: "custom",
        message: "聊天配置必须对应本次整理的接口",
        path: ["chat"],
      });
    if (
      input.capabilityNotes.some((note) => !isAllowed(note.method, note.path))
    )
      ctx.addIssue({
        code: "custom",
        message: "能力说明必须对应本次整理的接口",
        path: ["capabilityNotes"],
      });
  });

export type LearnManifest = z.infer<typeof learnManifestSchema>;

export const connectionLearnManifestSchema = z
  .object({
    sourceUrl: z.string().url().max(1500),
    title: z.string().trim().min(1).max(200),
    markdown: z.string().trim().min(1).max(2_000_000),
    description: z.string().max(2000).optional(),
    capabilityNotes: capabilityNotesSchema.default([]),
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.capabilityNotes.some(
        (note) => note.method !== undefined || note.path !== undefined,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "协议说明不能添加 HTTP 方法或路径",
        path: ["capabilityNotes"],
      });
  });
export type ConnectionLearnManifest = z.infer<
  typeof connectionLearnManifestSchema
>;

export function parseConnectionLearnManifest(
  input: unknown,
): ConnectionLearnManifest {
  const result = connectionLearnManifestSchema.safeParse(input);
  if (!result.success)
    throw new AppError(400, "LEARN_MANIFEST", "协议说明格式无效");
  assertDocumentMetadata(result.data);
  safeUrl(result.data.sourceUrl);
  return result.data;
}

export function parseLearnManifest(input: unknown): LearnManifest {
  const result = learnManifestSchema.safeParse(input);
  if (!result.success)
    throw new AppError(400, "LEARN_MANIFEST", "接口说明格式无效");
  // Validate the literal source before URL normalization can hide userinfo,
  // credential queries, fragments, or nested encoded credential names.
  assertDocumentMetadata(result.data);
  safeUrl(result.data.sourceUrl);
  for (const rule of result.data.rules) cleanPath(rule.path, true);
  return result.data;
}

export function learnPlatform(
  store: Store,
  alias: string,
  input: { rules: unknown; [key: string]: unknown },
): ReturnType<Store["applyLearnedPlatform"]>;
export function learnPlatform(
  store: Store,
  alias: string,
  input: unknown,
): Promise<
  | Awaited<ReturnType<Store["applyLearnedPlatform"]>>
  | Awaited<ReturnType<Store["applyLearnedConnection"]>>
>;
export async function learnPlatform(
  store: Store,
  alias: string,
  input: unknown,
) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias))
    throw new AppError(400, "PLATFORM_ALIAS", "连接别名无效");
  if (
    store.state.connections?.some(
      (item) => item.alias.toLowerCase() === alias.toLowerCase(),
    )
  )
    return store.applyLearnedConnection(
      alias,
      parseConnectionLearnManifest(input),
    );
  return store.applyLearnedPlatform(alias, parseLearnManifest(input));
}
