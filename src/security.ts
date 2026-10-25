import { setting } from "./environment.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import ipaddr from "ipaddr.js";
import { AppError, type Platform } from "./schema.js";
import type { Connection, Credentials } from "./connections.js";
import { assertResolvedTargetBoundary } from "./protocol-boundary.js";

export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function cleanPath(path: string, pattern = false) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\?#\s\x00-\x1f]/.test(path) ||
    path.includes("//") ||
    /%/i.test(path)
  )
    throw new AppError(
      400,
      "UNSAFE_PATH",
      "路径必须为不含编码、查询、片段或双斜线的绝对接口路径",
    );
  if (path.split("/").some((s) => s === "." || s === ".."))
    throw new AppError(400, "UNSAFE_PATH", "禁止路径穿越");
  if (
    pattern
      ? !path
          .slice(1)
          .split("/")
          .every(
            (segment, index, segments) =>
              /^[A-Za-z0-9_~.:-]*$/.test(segment) ||
              /^\{[A-Za-z][A-Za-z0-9_]{0,79}\}$/.test(segment) ||
              (segment === "*" && index === segments.length - 1),
          )
      : !/^\/[A-Za-z0-9/_~.:-]*$/.test(path)
  )
    throw new AppError(
      400,
      "UNSAFE_PATH",
      "路径含不支持字符；动态参数请使用安全 ASCII 标识",
    );
  if (pattern && path.includes("*") && !path.endsWith("/*"))
    throw new AppError(400, "UNSAFE_PATH", "通配符只能作为末尾 /*");
  return path;
}
export function matchesHttpPath(pattern: string, actual: string) {
  cleanPath(pattern, true);
  cleanPath(actual);
  const wanted = pattern.split("/"),
    given = actual.split("/");
  const wildcard = wanted.at(-1) === "*";
  if (wildcard ? given.length < wanted.length : given.length !== wanted.length)
    return false;
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i] === "*") return !!given[i];
    if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(wanted[i])) {
      if (!given[i]) return false;
    } else if (wanted[i] !== given[i]) return false;
  }
  return true;
}
export function publicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
/** Ordinary business private ranges an administrator may explicitly trust.
 * Loopback, link-local, metadata and other special ranges never qualify. */
export function privateBusinessAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ["private", "uniqueLocal", "carrierGradeNat"].includes(ip.range());
  } catch {
    return false;
  }
}
export function safeUrl(raw: string, allowLocal = false, allowPrivate = false) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, "UNSAFE_URL", "无效 URL");
  }
  if (u.username || u.password || u.hash)
    throw new AppError(400, "UNSAFE_URL", "URL 不得含凭据或片段");
  const local =
    allowLocal && setting("ALLOW_LOCAL") === "1" && u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:"))
    throw new AppError(
      400,
      "UNSAFE_URL",
      "正式目标只允许 HTTPS；本机 mock 需显式开启",
    );
  const literal = u.hostname.replace(/\[|\]/g, "");
  if (
    !local &&
    (u.hostname === "localhost" ||
      u.hostname.endsWith(".localhost") ||
      (net.isIP(literal) &&
        !publicAddress(literal) &&
        !(allowPrivate && privateBusinessAddress(literal))))
  )
    throw new AppError(
      400,
      "PRIVATE_TARGET",
      allowPrivate
        ? "禁止 loopback、link-local 与 metadata 目标"
        : "禁止私网、loopback 与 metadata 目标",
    );
  return u;
}
export async function pinnedAddress(
  u: URL,
  allowLocal = false,
  allowPrivate = false,
) {
  if (
    allowLocal &&
    setting("ALLOW_LOCAL") === "1" &&
    u.hostname === "127.0.0.1"
  )
    return { address: "127.0.0.1", family: 4 };
  const h = u.hostname.replace(/\[|\]/g, "");
  const rows = net.isIP(h)
    ? [{ address: h, family: net.isIP(h) }]
    : await dns.lookup(h, { all: true });
  if (
    !rows.length ||
    rows.some(
      (x) =>
        !publicAddress(x.address) &&
        !(allowPrivate && privateBusinessAddress(x.address)),
    )
  )
    throw new AppError(400, "PRIVATE_TARGET", "DNS 解析包含非公网地址");
  // Also rejects this broker's own interface addresses and metadata.
  assertResolvedTargetBoundary(rows);
  return rows[0];
}
export function validatePlatform(p: Platform) {
  const u = safeUrl(p.baseUrl, p.allowInsecureLocal);
  if (u.search || /[\\%]/.test(p.baseUrl))
    throw new AppError(400, "UNSAFE_URL", "Base URL 不得含查询参数或编码");
  cleanPath(u.pathname);
  p.rules.forEach((r) => cleanPath(r.path, true));
  if (
    ["header", "query"].includes(p.auth.type) &&
    !p.auth.name?.match(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
  )
    throw new AppError(400, "AUTH_NAME", "该鉴权方式需要安全的参数名称");
  if (
    p.auth.type === "header" &&
    /^(host|cookie|content-length|content-type|connection|transfer-encoding|proxy-.*)$/i.test(
      p.auth.name!,
    )
  )
    throw new AppError(400, "AUTH_NAME", "该 Header 名称不可用于鉴权");
  if (p.auth.type === "adapter" && !p.auth.adapter)
    throw new AppError(400, "ADAPTER_REQUIRED", "请指定已安装的适配器");
}
// Only code-defined, actual authentication combinations are added here. This is
// finite credential redaction, not a detector for arbitrary remote encodings.
export function credentialSecretValues(
  connection: Pick<Connection, "kind" | "config">,
  secret: Credentials,
) {
  const values = Object.values(secret).filter(Boolean);
  const config = connection.config;
  const basic =
    (connection.kind === "docker" && config.auth === "basic") ||
    (connection.kind === "registry" && config.authType === "basic") ||
    (connection.kind === "git" &&
      config.transport === "https" &&
      (config.authType ?? "basic") === "basic");
  const password =
    connection.kind === "git"
      ? secret.password || secret.token
      : secret.password;
  if (basic && secret.username && password) {
    const pair = `${secret.username}:${password}`;
    const encoded = Buffer.from(pair).toString("base64");
    values.push(pair, encoded, `Basic ${encoded}`);
  }
  const bearer =
    (connection.kind === "kubernetes" &&
      (config.auth ?? "bearer") === "bearer") ||
    (connection.kind === "registry" && config.authType === "bearer") ||
    (connection.kind === "git" &&
      config.transport === "https" &&
      config.authType === "bearer");
  if (bearer && secret.token) values.push(`Bearer ${secret.token}`);
  return [...new Set(values)];
}
export function variants(values: string[]) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((s) => [
          s,
          encodeURIComponent(s),
          new URLSearchParams({ value: s }).toString().slice("value=".length),
          Buffer.from(s).toString("base64"),
          JSON.stringify(s).slice(1, -1),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
}
type SecretPattern = { text: string; foldedHex: Set<number> };
type PrefixMatch = { matchedLength: number; pending: boolean };
type IndexedPattern = {
  length: number;
  at: (index: number) => number;
  foldedHex: Set<number>;
};
function indexPatterns(patterns: IndexedPattern[]) {
  const buckets = new Map<number, IndexedPattern[]>();
  for (const pattern of patterns) {
    const first = pattern.at(0);
    const bucket = buckets.get(first) ?? [];
    bucket.push(pattern);
    buckets.set(first, bucket);
  }
  return buckets;
}
function secretPatterns(values: readonly string[]): SecretPattern[] {
  const patterns = new Map<string, SecretPattern>();
  const add = (text: string, percent = false) => {
    if (!text) return;
    const foldedHex = new Set<number>();
    if (percent)
      for (const match of text.matchAll(/%[0-9A-F]{2}/g)) {
        foldedHex.add(match.index + 1);
        foldedHex.add(match.index + 2);
      }
    const key = `${percent ? "url" : "exact"}:${text}`;
    patterns.set(key, { text, foldedHex });
  };
  for (const value of new Set(values.filter(Boolean))) {
    add(value);
    add(encodeURIComponent(value), true);
    add(new URLSearchParams({ value }).toString().slice("value=".length), true);
    add(Buffer.from(value).toString("base64"));
    add(JSON.stringify(value).slice(1, -1));
  }
  return [...patterns.values()].sort((a, b) => b.text.length - a.text.length);
}
function prefixMatch(
  length: number,
  at: (index: number) => number,
  patterns: IndexedPattern[],
  final: boolean,
): PrefixMatch {
  let matchedLength = 0;
  let pending = false;
  for (const pattern of patterns) {
    let matches = true;
    for (let index = 0; index < Math.min(length, pattern.length); index++) {
      const actual = at(index),
        expected = pattern.at(index);
      if (
        actual !== expected &&
        !(
          pattern.foldedHex.has(index) &&
          expected >= 65 &&
          expected <= 70 &&
          actual === expected + 32
        )
      ) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (length >= pattern.length)
      matchedLength = Math.max(matchedLength, pattern.length);
    else if (!final) pending = true;
  }
  // A longer candidate must get the next chunk before a shorter match wins.
  return pending ? { matchedLength: 0, pending } : { matchedLength, pending };
}
export function createSecretMatcher(values: readonly string[]) {
  const patterns = secretPatterns(values).map(({ text, foldedHex }) => ({
    length: text.length,
    at: (index: number) => text.charCodeAt(index),
    foldedHex,
  }));
  const buckets = indexPatterns(patterns);
  return {
    maxLength: patterns.reduce(
      (maximum, pattern) => Math.max(maximum, pattern.length),
      0,
    ),
    // A position whose first code unit begins no pattern can never match.
    // Scanners skip it without slicing; the match result is unchanged.
    starts: new Set(buckets.keys()),
    matchPrefix(text: string, final = false): PrefixMatch {
      return prefixMatch(
        text.length,
        (index) => text.charCodeAt(index),
        buckets.get(text.charCodeAt(0)) ?? [],
        final,
      );
    },
  };
}
export function createSecretByteMatcher(values: readonly string[]) {
  const patterns = secretPatterns(values).map(({ text, foldedHex }) => {
    const bytes = Buffer.from(text);
    // Flexible percent patterns are ASCII, so character and byte offsets agree.
    return {
      length: bytes.length,
      at: (index: number) => bytes[index],
      foldedHex,
    };
  });
  const buckets = indexPatterns(patterns);
  return {
    maxLength: patterns.reduce(
      (maximum, pattern) => Math.max(maximum, pattern.length),
      0,
    ),
    starts: new Set(buckets.keys()),
    matchPrefix(bytes: Buffer, final = false): PrefixMatch {
      return prefixMatch(
        bytes.length,
        (index) => bytes[index],
        buckets.get(bytes[0]) ?? [],
        final,
      );
    },
  };
}
export function redact(text: string, values: string[]) {
  const matcher = createSecretMatcher(values);
  const chunks: string[] = [];
  let position = 0,
    start = 0;
  while (position < text.length) {
    if (!matcher.starts.has(text.charCodeAt(position))) {
      position++;
      continue;
    }
    const { matchedLength } = matcher.matchPrefix(text.slice(position), true);
    if (!matchedLength) {
      position++;
      continue;
    }
    chunks.push(text.slice(start, position), "[REDACTED]");
    position += matchedLength;
    start = position;
  }
  chunks.push(text.slice(start));
  return chunks.join("");
}
export function redactBytes(bytes: Buffer, values: readonly string[]) {
  const matcher = createSecretByteMatcher(values);
  const chunks: Buffer[] = [];
  let position = 0,
    start = 0;
  while (position < bytes.length) {
    if (!matcher.starts.has(bytes[position])) {
      position++;
      continue;
    }
    const { matchedLength } = matcher.matchPrefix(
      bytes.subarray(position),
      true,
    );
    if (!matchedLength) {
      position++;
      continue;
    }
    chunks.push(bytes.subarray(start, position), Buffer.from("[REDACTED]"));
    position += matchedLength;
    start = position;
  }
  if (!chunks.length) return bytes;
  chunks.push(bytes.subarray(start));
  return Buffer.concat(chunks);
}
// Holds possible prefixes across chunks, including binary chunks. Preserves all unrelated bytes.
export class Redactor extends Transform {
  private pending = Buffer.alloc(0);
  private matcher: ReturnType<typeof createSecretByteMatcher>;
  constructor(values: string[]) {
    super();
    this.matcher = createSecretByteMatcher(values);
  }
  private emitSafe(final = false) {
    let pos = 0,
      start = 0;
    const data = this.pending;
    while (pos < data.length) {
      if (!this.matcher.starts.has(data[pos])) {
        pos++;
        continue;
      }
      const rest = data.subarray(pos);
      const { matchedLength, pending } = this.matcher.matchPrefix(rest, final);
      if (matchedLength) {
        if (pos > start) this.push(data.subarray(start, pos));
        this.push(Buffer.from("[REDACTED]"));
        pos += matchedLength;
        start = pos;
        continue;
      }
      if (pending) break;
      pos++;
    }
    if (pos > start) this.push(data.subarray(start, pos));
    this.pending = data.subarray(pos);
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback) {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.emitSafe();
    cb();
  }
  _flush(cb: TransformCallback) {
    this.emitSafe(true);
    cb();
  }
}
