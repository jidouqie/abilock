import { readSelectedFile } from "./client-files.mjs";
import { brokerFetch, localBase, remoteExecution } from "./local-transport.mjs";
import { createCliTrace } from "./trace.mjs";

export const EXPERIENCE_INPUT_BYTES = 16 * 1024;
export const EXPERIENCE_OUTPUT_BYTES = 16 * 1024;
const aliasPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions = new Set([
  "search",
  "get",
  "evidence",
  "learn",
  "status",
  "mark",
  "remove",
]);
const failInput = () =>
  Object.assign(new Error("经验命令参数无效；请查看 abl --help"), {
    code: "USAGE",
  });

/** Parse before reading any selected file or starting a worker. */
export function parseExperienceArgs(args) {
  const values = [...args];
  const action = values.shift();
  if (!actions.has(action)) throw failInput();
  const needsAlias = ["get", "evidence", "learn", "mark", "remove"].includes(
    action,
  );
  const alias = needsAlias ? values.shift() : undefined;
  if (needsAlias && !aliasPattern.test(alias ?? "")) throw failInput();
  const needsId = ["get", "evidence", "mark", "remove"].includes(action);
  const id = needsId ? values.shift() : undefined;
  if (needsId && !idPattern.test(id ?? "")) throw failInput();
  const allowed = {
    search: ["--query", "--alias", "--limit", "--json"],
    get: ["--previous", "--json"],
    evidence: ["--json"],
    learn: ["--file", "--stdin", "--json"],
    status: ["--offset", "--limit", "--json"],
    mark: ["--status", "--revision", "--reason", "--json"],
    remove: ["--revision", "--json"],
  }[action];
  const options = new Map();
  for (let index = 0; index < values.length; index++) {
    const flag = values[index];
    if (!allowed.includes(flag) || options.has(flag)) throw failInput();
    if (["--json", "--stdin", "--previous"].includes(flag))
      options.set(flag, true);
    else {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw failInput();
      options.set(flag, value);
    }
  }
  /** @type {Record<string, unknown>} */
  const payload = { ...(alias ? { alias } : {}), ...(id ? { id } : {}) };
  if (action === "get" && options.has("--previous")) payload.previous = true;
  if (action === "search") {
    const query = options.get("--query");
    if (
      typeof query !== "string" ||
      !query.trim() ||
      Buffer.byteLength(query) > 512
    )
      throw failInput();
    Object.assign(payload, { query: query.trim() });
    if (options.has("--alias")) {
      if (!aliasPattern.test(options.get("--alias"))) throw failInput();
      Object.assign(payload, { alias: options.get("--alias") });
    }
    if (options.has("--limit")) {
      if (!/^[1-5]$/.test(options.get("--limit"))) throw failInput();
      Object.assign(payload, { limit: Number(options.get("--limit")) });
    }
  }
  if (action === "status") {
    if (options.has("--offset")) {
      const offset = options.get("--offset");
      if (!/^(0|[1-9][0-9]{0,2})$/.test(offset) || Number(offset) > 128)
        throw failInput();
      Object.assign(payload, { offset: Number(offset) });
    }
    if (options.has("--limit")) {
      const limit = options.get("--limit");
      if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 20) throw failInput();
      Object.assign(payload, { limit: Number(limit) });
    }
  }
  if (action === "learn" && options.has("--file") === options.has("--stdin"))
    throw failInput();
  if (["mark", "remove"].includes(action)) {
    const revision = options.get("--revision");
    if (
      !/^[1-9][0-9]{0,14}$/.test(revision ?? "") ||
      !Number.isSafeInteger(Number(revision))
    )
      throw failInput();
    Object.assign(payload, { expectedRevision: Number(revision) });
  }
  if (action === "mark") {
    const status = options.get("--status"),
      reason = options.get("--reason");
    if (
      !["stale", "archived"].includes(status) ||
      !["contract-change", "manual-review", "capacity-cleanup"].includes(reason)
    )
      throw failInput();
    Object.assign(payload, { status, reason });
  }
  return {
    action,
    payload,
    json: options.has("--json"),
    file: options.get("--file"),
    stdin: options.has("--stdin"),
  };
}

export async function readExperienceManifest(file, stream = process.stdin) {
  let bytes;
  if (file !== undefined && file !== "-") {
    bytes = await readSelectedFile(file, { maxBytes: EXPERIENCE_INPUT_BYTES });
  } else {
    const chunks = [];
    let count = 0;
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      count += chunk.length;
      if (count > EXPERIENCE_INPUT_BYTES) throw failInput();
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, count);
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failInput();
  return value;
}

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > EXPERIENCE_OUTPUT_BYTES)
    throw failInput();
  if (!response.body) throw failInput();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > EXPERIENCE_OUTPUT_BYTES) {
        await reader.cancel();
        throw failInput();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

/** Internal dependency injection is for synthetic tests, never a CLI argument.
 * @param {string} action
 * @param {unknown} payload
 * @param {{signal?: AbortSignal, fetcher?: typeof brokerFetch, trace?: ReturnType<typeof createCliTrace>}} options
 */
export async function experienceRequest(
  action,
  payload,
  { signal, fetcher = brokerFetch, trace = createCliTrace() } = {},
) {
  if (!actions.has(action)) throw failInput();
  trace.assertInput(payload);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > EXPERIENCE_INPUT_BYTES) throw failInput();
  const response = await fetcher(
    new URL(`/v2/experience/${action}`, localBase),
    {
      method: "POST",
      headers: trace.headers({ "content-type": "application/json" }),
      body,
      redirect: "error",
      signal,
    },
  );
  trace.response(response);
  const value = await boundedJson(response);
  trace.verifyBody(value);
  return { ok: response.ok, status: response.status, value };
}

export async function captureExperienceResult(alias, id, options = {}) {
  const fallback = {
    status: "unavailable",
    code: "EXPERIENCE_UNAVAILABLE",
    message: "调用结果保留；经验未记录，请按需读取连接手册。",
    docsCommand: `abl doc ${alias} --json`,
  };
  if (!aliasPattern.test(alias) || !idPattern.test(id ?? "")) return fallback;
  try {
    const result = await experienceRequest("evidence", { alias, id }, options);
    if (!result.ok) return fallback;
    return {
      status: "available",
      evidence: result.value,
      docsCommand: fallback.docsCommand,
    };
  } catch {
    return fallback;
  }
}

export async function experienceMain(args, fail, trace) {
  let selected;
  try {
    selected = parseExperienceArgs(args);
  } catch {
    return fail("USAGE", "经验命令参数无效；请查看 abl --help", 2);
  }
  if (remoteExecution())
    return fail(
      "LOCAL_EXPERIENCE",
      "经验读写仅支持本机受保护执行器；请在本机使用 abl。",
      3,
    );
  /** @type {Record<string, unknown>} */
  let payload = selected.payload;
  if (selected.action === "learn") {
    try {
      const manifest = await readExperienceManifest(selected.file);
      trace.assertInput(manifest);
      payload = { ...payload, manifest };
    } catch {
      return fail(
        "EXPERIENCE_INPUT",
        "经验文件无效或超过 16 KiB；未写入，请保留现有手册。",
        2,
      );
    }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(cancel, 15_000);
  timer.unref();
  try {
    trace.reset();
    const result = await experienceRequest(selected.action, payload, {
      signal: controller.signal,
      trace,
    });
    if (!result.ok) {
      const code =
        typeof result.value?.error?.code === "string" &&
        /^EXPERIENCE_[A-Z_]+$/.test(result.value.error.code)
          ? result.value.error.code
          : "EXPERIENCE_FAILED";
      const fallback = selected.payload.alias
        ? `abl doc ${selected.payload.alias} --json`
        : "abl list --json";
      return fail(
        code,
        `经验操作未完成；现有调用及手册不受影响。请使用 ${fallback}。`,
        result.status === 400 || result.status === 413 ? 2 : 3,
      );
    }
    if (selected.json)
      trace.json({ ok: true, status: result.status, data: result.value });
    // Pretty-printing can multiply a bounded payload beyond its context budget.
    else process.stdout.write(JSON.stringify(result.value) + "\n");
  } catch {
    return fail(
      controller.signal.aborted ? "CANCELLED" : "EXPERIENCE_UNAVAILABLE",
      "经验操作未完成；不会自动重试，请按需读取连接手册。",
      controller.signal.aborted ? 130 : 3,
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
