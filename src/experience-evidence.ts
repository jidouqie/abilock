import crypto from "node:crypto";
import type { Call, SavedPlatform } from "./schema.js";
import { redact } from "./security.js";

// Observation never authorizes a request. The ordinary execution policy runs
// first; this module only recognizes a deliberately small set of final results.
export const EXPERIENCE_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_PARAMETERS = 64;
const MAX_DEPTH = 6;
const MAX_TEMPLATE_BYTES = 6144;
// Even JSON object keys can contain user text (metadata and JSON schemas often
// do). Only code-known parameter paths are retained; unsupported new fields
// fall back to documentation instead of being copied into an evidence record.
const PARAMETER_PATHS = new Set([
  "body",
  "body.model",
  "body.prompt",
  "body.n",
  "body.seed",
  "body.stream",
  "body.resolution",
  "body.size",
  "body.aspect_ratio",
  "body.quality",
  "body.output_format",
  "body.output_compression",
  "body.background",
  "body.max_tokens",
  "body.max_completion_tokens",
  "body.temperature",
  "body.top_p",
  "body.frequency_penalty",
  "body.presence_penalty",
  "body.stop",
  "body.stop[]",
  "body.messages",
  "body.messages[]",
  "body.messages[].role",
  "body.messages[].content",
  "body.messages[].content[]",
  "body.messages[].content[].type",
  "body.messages[].content[].text",
  "body.messages[].content[].image_url",
  "body.messages[].content[].image_url.url",
  "body.messages[].content[].image_url.detail",
  "body.input_references",
  "body.input_references[]",
  "body.input_references[].type",
  "body.input_references[].image_url",
  "body.input_references[].image_url.url",
  "body.input_references[].image_url.detail",
  "body.image_config",
  "body.image_config.aspect_ratio",
  "body.image_config.image_size",
  "body.modalities",
  "body.modalities[]",
  "body.reasoning",
  "body.reasoning.effort",
  "body.reasoning.enabled",
  "body.reasoning.exclude",
  "body.reasoning.max_tokens",
]);
type ParameterType =
  "string" | "number" | "boolean" | "null" | "object" | "array";
type Template = string | Template[] | { [key: string]: Template };
export type ObservedExperience = {
  id: string;
  operationId: string;
  methodId?: string;
  model: string;
  method: Call["method"];
  path: string;
  parameters: { path: string; type: ParameterType }[];
  template: Template;
  validator: "openrouter-image" | "openai-chat" | "none";
  level: "machine-verified" | "transport-only";
  outcome:
    "success" | "contract-change" | "temporary-failure" | "uncertain-failure";
  observedAt: string;
  reason:
    | "verified"
    | "unsupported-provider"
    | "unsupported-response"
    | "response-too-large"
    | "incomplete-response"
    | "model-mismatch"
    | "upstream-error"
    | "contract-change"
    | "temporary-failure"
    | "uncertain-failure";
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function safeIdentifier(value: string, secrets: string[]) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value) &&
    !/^(?:sk-|bearer|https?:|eyJ)/i.test(value) &&
    redact(value, secrets) === value
  );
}
function requestDescription(p: SavedPlatform, call: Call, secrets: string[]) {
  // Dynamic resource IDs and caller-supplied headers are not reusable recipes.
  // A saved method cannot silently omit one of those request prerequisites.
  if (
    call.rawBody ||
    call.multipart ||
    Object.keys(call.headers ?? {}).length ||
    call.query ||
    !p.rules.some((r) => r.method === call.method && r.path === call.path) ||
    call.path.length > 160 ||
    redact(call.path, secrets) !== call.path
  )
    return undefined;
  const body = object(call.body);
  const model = typeof body?.model === "string" ? body.model : "unspecified";
  if (!safeIdentifier(model, secrets)) return undefined;
  const parameters = new Map<string, ParameterType>();
  let nodes = 0;
  const visit = (value: unknown, location: string, depth: number): Template => {
    if (
      ++nodes > 256 ||
      depth > MAX_DEPTH ||
      location.length > 160 ||
      !PARAMETER_PATHS.has(location)
    )
      throw new Error("shape-limit");
    const type: ParameterType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "object"
            ? "object"
            : typeof value === "number"
              ? "number"
              : typeof value === "boolean"
                ? "boolean"
                : "string";
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("invalid-number");
    if (!["string", "number", "boolean", "object"].includes(typeof value))
      throw new Error("invalid-type");
    const previous = parameters.get(location);
    if (previous && previous !== type) throw new Error("mixed-array");
    parameters.set(location, type);
    if (parameters.size > MAX_PARAMETERS) throw new Error("shape-limit");
    if (Array.isArray(value)) {
      if (value.length > 32) throw new Error("shape-limit");
      if (!value.length) return [];
      const items = value.map((item) =>
        visit(item, `${location}[]`, depth + 1),
      );
      if (
        items.some((item) => JSON.stringify(item) !== JSON.stringify(items[0]))
      )
        throw new Error("mixed-array");
      return [items[0]];
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (entries.length > MAX_PARAMETERS) throw new Error("shape-limit");
      return Object.fromEntries(
        entries.map(([key, item]) => {
          if (
            !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
            ["__proto__", "constructor", "prototype"].includes(key) ||
            redact(key, secrets) !== key
          )
            throw new Error("unsafe-field");
          return [key, visit(item, `${location}.${key}`, depth + 1)];
        }),
      );
    }
    return location === "body.model" ? "{{model}}" : `{{${type}}}`;
  };
  try {
    const template: Record<string, Template> = {};
    if (call.body !== undefined) template.body = visit(call.body, "body", 0);
    if (call.query !== undefined)
      template.query = visit(call.query, "query", 0);
    if (Buffer.byteLength(JSON.stringify(template)) > MAX_TEMPLATE_BYTES)
      return undefined;
    return {
      model,
      template,
      parameters: [...parameters].map(([path, type]) => ({ path, type })),
    };
  } catch {
    return undefined;
  }
}
function provider(p: SavedPlatform, fixture: boolean) {
  try {
    const url = new URL(p.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      p.auth.type !== "bearer"
    )
      return undefined;
    const base = url.pathname.replace(/\/$/, "");
    if (
      fixture &&
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return "openrouter";
    if (url.protocol !== "https:" || url.port) return undefined;
    if (url.hostname === "openrouter.ai" && base === "/api/v1")
      return "openrouter";
    if (url.hostname === "api.openai.com" && base === "/v1") return "openai";
  } catch {
    /* A malformed target cannot produce verified evidence. */
  }
  return undefined;
}
function png(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return false;
  let offset = 8,
    header = false,
    imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!header) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8),
        height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 32768 || height > 32768) return false;
      header = true;
    }
    if (type === "IDAT" && length) imageData = true;
    if (type === "IEND")
      return length === 0 && imageData && offset + 12 === bytes.length;
    offset += 12 + length;
  }
  return false;
}
function jpeg(bytes: Buffer) {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    return false;
  let offset = 2,
    dimensions = false;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return dimensions && offset + 8 < bytes.length;
    if (marker === 0xd9) return false;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (
        length < 8 ||
        !bytes.readUInt16BE(offset + 3) ||
        !bytes.readUInt16BE(offset + 5)
      )
        return false;
      dimensions = true;
    }
    offset += length;
  }
  return false;
}
function webp(bytes: Buffer) {
  return (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(16) > 0 &&
    bytes.readUInt32LE(16) <= bytes.length - 20
  );
}
function imageResult(value: Record<string, unknown>) {
  if (
    value.error ||
    !Array.isArray(value.data) ||
    !value.data.length ||
    value.data.length > 10
  )
    return false;
  return value.data.every((item) => {
    const entry = object(item);
    if (
      !entry ||
      typeof entry.b64_json !== "string" ||
      entry.b64_json.length > EXPERIENCE_CAPTURE_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        entry.b64_json,
      )
    )
      return false;
    const bytes = Buffer.from(entry.b64_json, "base64");
    return png(bytes) || jpeg(bytes) || webp(bytes);
  });
}
function chatResult(value: Record<string, unknown>, model: string) {
  if (
    value.error ||
    typeof value.model !== "string" ||
    !(value.model === model || value.model.startsWith(`${model}-`))
  )
    return false;
  const usage = object(value.usage);
  if (
    !usage ||
    !Number.isInteger(usage.prompt_tokens) ||
    Number(usage.prompt_tokens) < 0 ||
    !Number.isInteger(usage.completion_tokens) ||
    Number(usage.completion_tokens) < 1 ||
    !Number.isInteger(usage.total_tokens) ||
    usage.total_tokens !==
      Number(usage.prompt_tokens) + Number(usage.completion_tokens)
  )
    return false;
  return (
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    value.choices.length <= 16 &&
    value.choices.every((choice) => {
      const c = object(choice),
        message = object(c?.message);
      return (
        c?.finish_reason === "stop" &&
        message?.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim().length > 0 &&
        !message.tool_calls &&
        !message.refusal
      );
    })
  );
}
function contractChange(status: number, value: Record<string, unknown>) {
  if (![400, 404, 422].includes(status)) return false;
  const error = object(value.error);
  return (
    typeof error?.code === "string" &&
    [
      "model_removed",
      "model_deprecated",
      "model_not_supported",
      "unsupported_model",
      "unsupported_parameter",
      "unknown_parameter",
    ].includes(error.code)
  );
}

export function createExperienceObserver(
  p: SavedPlatform,
  call: Call,
  operationId: string,
  secrets: string[],
  options: { fixture?: boolean } = {},
) {
  const description = requestDescription(p, call, secrets);
  if (!description) return undefined;
  const id = crypto.randomUUID();
  const knownProvider = provider(p, options.fixture === true);
  const stream = object(call.body)?.stream === true;
  let chunks: Buffer[] = [],
    bytes = 0,
    oversized = false,
    finished = false;
  return {
    id,
    write(chunk: Buffer) {
      if (finished || oversized || stream) return;
      bytes += chunk.length;
      if (bytes > EXPERIENCE_CAPTURE_BYTES) {
        oversized = true;
        chunks = [];
      } else chunks.push(Buffer.from(chunk));
    },
    finish(
      status: number,
      contentType: string,
      complete = true,
    ): ObservedExperience {
      finished = true;
      const base: ObservedExperience = {
        id,
        operationId,
        ...(call.experience?.methodId
          ? { methodId: call.experience.methodId }
          : {}),
        ...description,
        method: call.method,
        path: call.path,
        validator:
          call.method !== "POST" || !knownProvider
            ? "none"
            : call.path === "/images" && knownProvider === "openrouter"
              ? "openrouter-image"
              : call.path === "/chat/completions"
                ? "openai-chat"
                : "none",
        level: "transport-only",
        outcome:
          status >= 200 && status < 300 && complete
            ? "success"
            : "temporary-failure",
        observedAt: new Date().toISOString(),
        reason: !complete
          ? "incomplete-response"
          : oversized
            ? "response-too-large"
            : !knownProvider
              ? "unsupported-provider"
              : "unsupported-response",
      };
      let data: Record<string, unknown> | undefined;
      if (
        complete &&
        !oversized &&
        !stream &&
        /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
      ) {
        try {
          data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          /* Unparseable data is never a business-success proof. */
        }
      }
      chunks = [];
      if (!complete || !knownProvider || oversized || stream) return base;
      if (!data) {
        if (status >= 200 && status < 300 && base.validator !== "none") {
          base.outcome = "uncertain-failure";
          base.reason = "uncertain-failure";
        }
        return base;
      }
      if (status < 200 || status >= 300) {
        if (contractChange(status, data)) {
          base.outcome = "contract-change";
          base.reason = "contract-change";
        } else
          base.reason = [401, 402, 403, 408, 429, 500, 502, 503, 504].includes(
            status,
          )
            ? "temporary-failure"
            : "upstream-error";
        return base;
      }
      // A structured upstream business error differs from an observation that
      // merely lacks a supported verifier. Never suspend on a token-length
      // finish, refusal, streaming result or capture limit alone.
      if (data.error && base.validator !== "none") {
        base.outcome = "uncertain-failure";
        base.reason = "uncertain-failure";
        return base;
      }
      if (
        call.method === "POST" &&
        call.path === "/images" &&
        knownProvider === "openrouter" &&
        description.model !== "unspecified" &&
        imageResult(data)
      ) {
        base.validator = "openrouter-image";
        base.level = "machine-verified";
        base.reason = "verified";
      } else if (
        call.method === "POST" &&
        call.path === "/chat/completions" &&
        description.model !== "unspecified" &&
        chatResult(data, description.model)
      ) {
        base.validator = "openai-chat";
        base.level = "machine-verified";
        base.reason = "verified";
      } else if (
        call.path === "/chat/completions" &&
        typeof data.model === "string" &&
        data.model !== description.model &&
        !data.model.startsWith(`${description.model}-`)
      ) {
        base.outcome = "uncertain-failure";
        base.reason = "model-mismatch";
      } else if (base.validator !== "none") {
        // Queued work, bounded output and policy refusals do not demonstrate a
        // broken method, and are never promoted into verified evidence either.
        const waiting = [
          "queued",
          "pending",
          "in_progress",
          "processing",
          "running",
        ].includes(String(data.status));
        const limited =
          Array.isArray(data.choices) &&
          data.choices.some((choice) => {
            const c = object(choice),
              message = object(c?.message);
            return (
              ["length", "content_filter", "tool_calls"].includes(
                String(c?.finish_reason),
              ) || !!message?.refusal
            );
          });
        if (!waiting && !limited) {
          base.outcome = "uncertain-failure";
          base.reason = "uncertain-failure";
        }
      }
      return base;
    },
  };
}
