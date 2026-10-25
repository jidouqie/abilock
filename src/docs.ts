import Turndown from "turndown";
import { AppError } from "./schema.js";
import { safeUrl, redact } from "./security.js";
import { readBounded, upstream } from "./transport.js";

const METADATA_DECODE_DEPTH = 8;
const METADATA_CANDIDATE_LIMIT = 2048;
const METADATA_CANDIDATE_SIZE = 8192;

// Only finite, common representations of already-known secrets are checked.
// This is not a detector for arbitrary encodings or business-data DLP.
function metadataCandidates(value: string, source: boolean): string[] {
  const candidates = new Set<string>();
  let pending = new Set([value]);
  const invalid = () =>
    new AppError(
      400,
      source ? "DOC_SOURCE_INVALID" : "DOC_METADATA_ENCODING",
      source ? "文档来源URL编码无效或层数过多" : "文档元数据编码层数过多",
    );
  const decode = (text: string) => {
    if (source) {
      try {
        return decodeURIComponent(text);
      } catch {
        throw invalid();
      }
    }
    // A title may contain literal '%' or malformed percent text. Preserve those
    // characters while still decoding independent, valid escape sequences.
    return text.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  };
  const add = (text: string) => {
    if (text.length > METADATA_CANDIDATE_SIZE)
      throw new AppError(400, "DOC_METADATA_LIMIT", "文档元数据过长");
    candidates.add(text);
    if (candidates.size > METADATA_CANDIDATE_LIMIT) throw invalid();
  };
  for (let depth = 0; pending.size; depth++) {
    const next = new Set<string>();
    for (const text of pending) {
      // Keep the literal form as well as application/x-www-form-urlencoded
      // spaces. Following both branches preserves encoded literal '+' values.
      for (const current of new Set([text, text.replace(/\+/g, " ")])) {
        add(current);
        if (!/%[0-9a-f]{2}/i.test(current)) continue;
        const decoded = decode(current);
        if (decoded === current || candidates.has(decoded)) continue;
        if (depth === METADATA_DECODE_DEPTH) throw invalid();
        next.add(decoded);
      }
    }
    pending = next;
  }
  return [...candidates];
}

export function assertDocumentMetadata(
  input: { title: string; sourceUrl: string },
  secrets: string[] = [],
  authQueryNames: string[] = [],
) {
  if (input.title.length > 200 || input.sourceUrl.length > 1500)
    throw new AppError(400, "DOC_METADATA_LIMIT", "文档元数据过长");
  if (
    [
      ...metadataCandidates(input.title, false),
      ...metadataCandidates(input.sourceUrl, true),
    ].some((value) => redact(value, secrets) !== value)
  )
    throw new AppError(
      400,
      "DOC_METADATA_SECRET",
      "文档标题与来源URL不得包含已保管秘密",
    );
  let url: URL;
  try {
    url = new URL(input.sourceUrl);
  } catch {
    throw new AppError(400, "DOC_SOURCE_INVALID", "文档来源URL无效");
  }
  if (!/^https?:$/.test(url.protocol))
    throw new AppError(400, "DOC_SOURCE_INVALID", "文档来源必须为 HTTP(S) URL");
  // URL canonicalization and searchParams decode differently from raw text.
  // Use the same bounded variants for both fields and parsed URL components.
  const candidates = [
    url.href,
    url.pathname,
    ...url.searchParams.keys(),
    ...url.searchParams.values(),
  ];
  if (
    candidates.some((value) =>
      metadataCandidates(value, true).some(
        (candidate) => redact(candidate, secrets) !== candidate,
      ),
    )
  )
    throw new AppError(
      400,
      "DOC_METADATA_SECRET",
      "文档标题与来源URL不得包含已保管秘密",
    );
  if (url.username || url.password || url.hash)
    throw new AppError(
      400,
      "DOC_URL_CREDENTIAL",
      "文档来源URL不得含凭据或片段",
    );
  const custom = new Set(authQueryNames.map((name) => name.toLowerCase()));
  if (
    [...url.searchParams.keys()].some((rawKey) => {
      return metadataCandidates(rawKey, true).some(
        (key) =>
          /^(?:key|api[_-]?key|token|password|secret|authorization|access[_-]?token|access[_-]?key)$/i.test(
            key,
          ) || custom.has(key.toLowerCase()),
      );
    })
  )
    throw new AppError(400, "DOC_URL_CREDENTIAL", "文档 URL 不得携带鉴权字段");
}
export async function fetchMarkdown(
  sourceUrl: string,
  signal: AbortSignal,
  allowLocal = false,
) {
  const url = safeUrl(sourceUrl, allowLocal);
  assertDocumentMetadata({ title: "", sourceUrl });
  // Deliberately independent of provider auth adapters and secret store.
  const response = await upstream(
    url,
    "GET",
    {
      accept:
        "application/json,text/markdown,text/html,text/plain,application/yaml",
      "accept-encoding": "identity",
      "user-agent": "Abilock-Docs/1.0",
    },
    undefined,
    15000,
    signal,
    allowLocal,
  );
  if (response.statusCode !== 200) {
    response.destroy();
    throw new AppError(
      502,
      "DOC_FETCH_FAILED",
      "未取得官方文档或来源发生重定向；已保存的用法保留",
    );
  }
  if (
    response.headers["content-encoding"] &&
    response.headers["content-encoding"] !== "identity"
  ) {
    response.destroy();
    throw new AppError(
      502,
      "DOC_FETCH_FAILED",
      "来源返回不支持的压缩数据；已保存的用法保留",
    );
  }
  const content = await readBounded(response, 2_000_000);
  const type = response.headers["content-type"] ?? "";
  if (
    !/text\/(html|plain|markdown|yaml)|application\/(xhtml|json|yaml|x-yaml)/.test(
      type,
    )
  )
    throw new AppError(400, "DOC_TYPE", "来源不是公开文本或 API 文档");
  let markdown = content.toString("utf8");
  if (/html/.test(type)) {
    const html = markdown.replace(
      /<(script|style|noscript|nav|footer)[\s\S]*?<\/\1>/gi,
      "",
    );
    const main =
      html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
      html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
      html;
    markdown = new Turndown({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    }).turndown(main);
  }
  if (
    markdown.trim().length < 180 ||
    (/enable javascript/i.test(markdown) && markdown.length < 700)
  )
    throw new AppError(
      422,
      "DOC_EMPTY",
      "未取得可用文档正文；已保存的用法保留",
    );
  return markdown;
}
