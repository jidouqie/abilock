import { z } from "zod";
import { AppError } from "./schema.js";
import type { ExecutionRoute } from "./execution-routes.js";
import {
  ExperienceStore,
  EXPERIENCE_LIMITS,
  experienceLearnSchema,
  experienceMarkSchema,
  experienceSearchSchema,
} from "./experience-store.js";

const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
const identified = z.object({ alias: aliasSchema, id: z.uuid() }).strict();
const detail = identified.extend({ previous: z.boolean().optional() });
const learn = z
  .object({ alias: aliasSchema, manifest: experienceLearnSchema })
  .strict();
const mark = experienceMarkSchema.extend({ alias: aliasSchema });
const remove = identified.extend({
  expectedRevision: z.number().int().positive(),
});

/** The optional knowledge store cannot grant execution permission or accept a
 * caller-produced success receipt. Only the executor writes evidence. */
export async function routeExperience(
  input: ExecutionRoute,
  json: (status: number, value: unknown) => void,
): Promise<boolean> {
  const match = input.route.match(
    /^\/v2\/experience\/(search|get|evidence|learn|status|mark|remove)$/,
  );
  if (!match || input.method !== "POST") return false;
  if (!input.learning) {
    json(400, {
      error: {
        code: "EXPERIENCE_LOCAL_ONLY",
        message: "经验仅在本机受保护执行器内使用。",
      },
      fallback: "abl list --json",
    });
    return true;
  }
  let alias: string | undefined;
  try {
    const raw = await input.readJson();
    if (Buffer.byteLength(JSON.stringify(raw)) > EXPERIENCE_LIMITS.writeBytes)
      throw new AppError(
        413,
        "EXPERIENCE_TOO_LARGE",
        "单次经验输入超过 16 KiB；请缩小范围并读取手册。",
      );
    const store = new ExperienceStore(input.store.dir, input.secrets(), {
      signal: input.signal,
    });
    let value: unknown;
    let responseBudget: number = EXPERIENCE_LIMITS.detailBytes;
    const action = match[1];
    if (action === "search") {
      const query = experienceSearchSchema.parse(raw);
      responseBudget = query.budgetBytes;
      if (responseBudget < 1536)
        throw new AppError(
          400,
          "EXPERIENCE_BUDGET",
          "经验摘要预算不足，请直接读取手册。",
        );
      alias = query.alias;
      if (alias) input.store.platform(alias);
      // Reserve for CLI trace/envelope so the rendered result remains bounded.
      value = await store.search(input.store.state.platforms, {
        ...query,
        budgetBytes: responseBudget - 1024,
      });
    } else if (action === "status") {
      const page = z
        .object({
          offset: z
            .number()
            .int()
            .min(0)
            .max(EXPERIENCE_LIMITS.methods)
            .optional(),
          limit: z.number().int().min(1).max(20).optional(),
        })
        .strict()
        .parse(raw);
      value = await store.inspect(input.store.state.platforms, page);
    } else if (action === "learn") {
      const payload = learn.parse(raw);
      alias = payload.alias;
      value = await store.learn(input.store.platform(alias), payload.manifest);
    } else if (action === "mark") {
      const payload = mark.parse(raw);
      alias = payload.alias;
      const { alias: _alias, ...change } = payload;
      void _alias;
      value = await store.mark(input.store.platform(alias), change);
    } else if (action === "remove") {
      const payload = remove.parse(raw);
      alias = payload.alias;
      const { alias: _alias, ...change } = payload;
      void _alias;
      value = await store.remove(input.store.platform(alias), change);
    } else {
      const payload =
        action === "get" ? detail.parse(raw) : identified.parse(raw);
      alias = payload.alias;
      const platform = input.store.platform(alias);
      value =
        action === "get"
          ? await store.get(platform, payload.id, {
              previous: "previous" in payload && payload.previous === true,
            })
          : await store.getEvidence(platform, payload.id);
    }
    input.onAlias?.(alias ?? "");
    // Bound the final public envelope too, including guidance and fallback.
    const result = { data: value };
    if (Buffer.byteLength(JSON.stringify(result)) > responseBudget)
      throw new AppError(
        413,
        "EXPERIENCE_RESPONSE_LIMIT",
        "经验结果超过返回预算；请缩小查询或读取手册。",
      );
    json(200, result);
  } catch (error) {
    const failure = error instanceof AppError ? error : null;
    json(failure?.status ?? (error instanceof z.ZodError ? 400 : 503), {
      error: {
        code:
          failure?.code ??
          (error instanceof z.ZodError
            ? "EXPERIENCE_VALIDATION"
            : "EXPERIENCE_UNAVAILABLE"),
        message: failure?.message ?? "经验步骤未完成；已有连接和手册保持不变，请按当前手册继续。",
      },
      fallback: alias ? `abl doc ${alias} --json` : "abl list --json",
    });
  }
  return true;
}
