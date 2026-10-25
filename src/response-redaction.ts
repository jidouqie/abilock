import { Transform, type TransformCallback } from "node:stream";
import { AppError } from "./schema.js";
import { createSecretMatcher, Redactor } from "./security.js";

const RESPONSE_LIMIT = 100 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const MARKER = Buffer.from("[REDACTED]");
type Emit = (bytes: Buffer) => void;
type Unit = { text: string; raw: Buffer; syntax: boolean };
type Matcher = ReturnType<typeof createSecretMatcher>;

function joinRaw(parts: Buffer[]) {
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  let length = first.length;
  for (let i = 1; i < parts.length; i++) {
    if (
      parts[i].buffer !== first.buffer ||
      parts[i].byteOffset !== first.byteOffset + length
    )
      return Buffer.concat(parts);
    length += parts[i].length;
  }
  return Buffer.from(first.buffer, first.byteOffset, length);
}

function invalidJson(): never {
  throw new AppError(502, "UPSTREAM_INVALID_JSON", "上游 JSON 响应语法无效");
}

// Match decoded string content while retaining its exact wire representation.
// Fixed JSON/SSE syntax is not a credential echo. Syntax interleaved between
// multi-line SSE data remains present even when the semantic match spans it.
class SemanticFilter {
  private units: Unit[] = [];
  private text = "";
  private readonly matcher;
  constructor(
    values: string[],
    private readonly emit: Emit,
    matcher: Matcher = createSecretMatcher(values),
  ) {
    this.matcher = matcher;
  }
  add(text: string, raw: Buffer, syntax = false) {
    if (!this.matcher.maxLength) {
      this.emit(raw);
      return;
    }
    const previous = this.units.at(-1);
    if (
      !text &&
      previous &&
      !previous.text &&
      previous.syntax === syntax &&
      previous.raw.buffer === raw.buffer &&
      previous.raw.byteOffset + previous.raw.length === raw.byteOffset
    )
      previous.raw = Buffer.from(
        raw.buffer,
        previous.raw.byteOffset,
        previous.raw.length + raw.length,
      );
    else this.units.push({ text, raw, syntax });
    this.text += text;
    this.drain(false);
  }
  finish() {
    this.drain(true);
  }
  private drain(final: boolean) {
    while (this.units.length) {
      const first = this.units[0];
      if (!first.text) {
        this.emit(first.raw);
        this.units.shift();
        continue;
      }
      const match = this.matcher.matchPrefix(this.text, final);
      if (match.pending && !final) return;
      if (match.matchedLength) {
        this.emit(MARKER);
        let consumed = 0;
        while (this.units.length && consumed < match.matchedLength) {
          const unit = this.units.shift()!;
          consumed += unit.text.length;
          if (unit.syntax) this.emit(unit.raw);
        }
        this.text = this.text.slice(consumed);
      } else {
        this.emit(first.raw);
        this.units.shift();
        this.text = this.text.slice(first.text.length);
      }
    }
  }
}

// UTF-8 units retain the original bytes, including split code points. A JSON
// escape is decoded separately, so Unicode and escaped spellings match the
// same semantic value without reserializing unrelated strings.
class Utf8Units {
  private bytes: Buffer[] = [];
  private remaining = 0;
  constructor(private readonly emit: (text: string, raw: Buffer) => void) {}
  add(byte: number, raw: Buffer) {
    if (!this.remaining) {
      this.remaining =
        byte >= 0xc2 && byte <= 0xdf
          ? 2
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xf0 && byte <= 0xf4
              ? 4
              : 1;
    }
    this.bytes.push(raw);
    if (!--this.remaining) this.finish();
  }
  finish() {
    if (!this.bytes.length) return;
    const raw = joinRaw(this.bytes);
    this.bytes = [];
    this.remaining = 0;
    this.emit(raw.toString("utf8"), raw);
  }
  get pending() {
    return this.remaining > 0;
  }
}

// Stack states encode only JSON grammar; strings are streamed and only a
// scalar token is retained (bounded by the same 100 MiB response limit).
class JsonLexer {
  private stack: number[] = [];
  private rootDone = false;
  private mode: "syntax" | "string" | "scalar" = "syntax";
  private key = false;
  private scalar: Buffer[] = [];
  private scalarChunk = Buffer.alloc(0);
  private scalarSize = 0;
  private scalarChunkSize = 0;
  private escape: Buffer[] = [];
  private escapeText = "";
  private high?: { text: string; raw: Buffer };
  private filter: SemanticFilter;
  private utf8: Utf8Units;
  private readonly matcher;
  constructor(
    private readonly values: string[],
    private readonly emit: Emit,
    matcher: Matcher = createSecretMatcher(values),
  ) {
    this.matcher = matcher;
    this.filter = new SemanticFilter(values, emit, matcher);
    this.utf8 = new Utf8Units((text, raw) => this.character(text, raw));
  }
  private character(text: string, raw: Buffer) {
    if (this.high) {
      const high = this.high;
      this.high = undefined;
      if (
        text.length === 1 &&
        text.charCodeAt(0) >= 0xdc00 &&
        text.charCodeAt(0) <= 0xdfff
      ) {
        this.filter.add(high.text + text, Buffer.concat([high.raw, raw]));
        return;
      }
      this.filter.add(high.text, high.raw);
    }
    if (
      text.length === 1 &&
      text.charCodeAt(0) >= 0xd800 &&
      text.charCodeAt(0) <= 0xdbff
    )
      this.high = { text, raw };
    else this.filter.add(text, raw);
  }
  private valueAllowed() {
    const state = this.stack.at(-1);
    return state === undefined
      ? !this.rootDone
      : state === 3 || state === 5 || state === 6;
  }
  private completed() {
    if (!this.stack.length) this.rootDone = true;
    else {
      const state = this.stack.at(-1)!;
      if (state !== 3 && state !== 5 && state !== 6) invalidJson();
      this.stack[this.stack.length - 1] = state === 3 ? 4 : 7;
    }
  }
  add(byte: number, raw: Buffer) {
    if (this.mode === "string") {
      if (this.escape.length) {
        this.escape.push(raw);
        this.escapeText += String.fromCharCode(byte);
        const escape = this.escapeText;
        if (escape.length === 2 && escape[1] !== "u") {
          const simple: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!(escape[1] in simple)) invalidJson();
          this.character(simple[escape[1]], Buffer.concat(this.escape));
          this.escape = [];
          this.escapeText = "";
        } else if (escape.length > 2 && !/^[0-9a-f]$/i.test(escape.at(-1)!))
          invalidJson();
        else if (escape.length === 6) {
          this.character(
            String.fromCharCode(parseInt(escape.slice(2), 16)),
            Buffer.concat(this.escape),
          );
          this.escape = [];
          this.escapeText = "";
        }
        return;
      }
      if (this.utf8.pending) {
        if ((byte & 0xc0) !== 0x80) invalidJson();
        this.utf8.add(byte, raw);
      } else if (byte === 92) {
        this.escape = [raw];
        this.escapeText = "\\";
      } else if (byte === 34) {
        if (this.high) {
          this.filter.add(this.high.text, this.high.raw);
          this.high = undefined;
        }
        this.filter.finish();
        this.emit(raw);
        this.mode = "syntax";
        if (this.key) this.stack[this.stack.length - 1] = 2;
        else this.completed();
      } else {
        if (byte < 32) invalidJson();
        this.utf8.add(byte, raw);
      }
      return;
    }
    if (this.mode === "scalar") {
      if (/[0-9a-zE+.-]/.test(String.fromCharCode(byte))) {
        if (++this.scalarSize > RESPONSE_LIMIT)
          throw new AppError(413, "RESPONSE_TOO_LARGE", "响应最大 100 MiB");
        if (!this.scalarChunk.length)
          this.scalarChunk = Buffer.alloc(CHUNK_SIZE);
        this.scalarChunk[this.scalarChunkSize++] = byte;
        if (this.scalarChunkSize === CHUNK_SIZE) {
          this.scalar.push(this.scalarChunk);
          this.scalarChunk = Buffer.alloc(CHUNK_SIZE);
          this.scalarChunkSize = 0;
        }
        return;
      }
      this.finishScalar();
    }
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13) {
      this.emit(raw);
      return;
    }
    const state = this.stack.at(-1);
    if (byte === 34) {
      this.key = state === 0 || state === 1;
      if (!this.key && !this.valueAllowed()) invalidJson();
      this.mode = "string";
      this.filter = new SemanticFilter(this.values, this.emit, this.matcher);
      this.emit(raw);
    } else if (byte === 123 || byte === 91) {
      if (!this.valueAllowed()) invalidJson();
      this.stack.push(byte === 123 ? 0 : 5);
      this.emit(raw);
    } else if (byte === 125 || byte === 93) {
      if (
        byte === 125 ? state !== 0 && state !== 4 : state !== 5 && state !== 7
      )
        invalidJson();
      this.stack.pop();
      this.completed();
      this.emit(raw);
    } else if (byte === 58 && state === 2) {
      this.stack[this.stack.length - 1] = 3;
      this.emit(raw);
    } else if (byte === 44 && (state === 4 || state === 7)) {
      this.stack[this.stack.length - 1] = state === 4 ? 1 : 6;
      this.emit(raw);
    } else if (
      (byte >= 48 && byte <= 57) ||
      byte === 45 ||
      byte === 116 ||
      byte === 102 ||
      byte === 110
    ) {
      if (!this.valueAllowed()) invalidJson();
      this.mode = "scalar";
      this.add(byte, raw);
    } else invalidJson();
  }
  private finishScalar() {
    const raw = Buffer.concat(
      [...this.scalar, this.scalarChunk.subarray(0, this.scalarChunkSize)],
      this.scalarSize,
    );
    const token = raw.toString();
    if (
      !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(
        token,
      )
    )
      invalidJson();
    let secret = false;
    if (this.matcher.maxLength)
      for (let i = 0; i < token.length && !secret; i++)
        secret = !!this.matcher.matchPrefix(
          token.slice(i, i + this.matcher.maxLength),
          true,
        ).matchedLength;
    this.emit(secret ? Buffer.from('"[REDACTED]"') : raw);
    this.scalar = [];
    this.scalarChunkSize = 0;
    this.scalarSize = 0;
    this.mode = "syntax";
    this.completed();
  }
  finish(allowEmpty = false) {
    if (this.mode === "scalar") this.finishScalar();
    if (
      this.mode !== "syntax" ||
      this.stack.length ||
      (!this.rootDone && !allowEmpty)
    )
      invalidJson();
  }
}

class Chunks {
  private parts: Buffer[] = [];
  private head = 0;
  private size = 0;
  add = (raw: Buffer) => {
    if (raw.length) {
      this.parts.push(raw);
      this.size += raw.length;
    }
  };
  *take(final = false): Generator<Buffer> {
    while (this.size >= CHUNK_SIZE || (final && this.size)) {
      const length = Math.min(CHUNK_SIZE, this.size),
        parts: Buffer[] = [];
      let remaining = length;
      while (remaining) {
        const part = this.parts[this.head],
          amount = Math.min(part.length, remaining);
        parts.push(part.subarray(0, amount));
        if (amount === part.length) this.head++;
        else this.parts[this.head] = part.subarray(amount);
        remaining -= amount;
      }
      this.size -= length;
      if (this.head > 1024) {
        this.parts = this.parts.slice(this.head);
        this.head = 0;
      }
      yield parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    }
  }
}

// Pause processing the current input chunk when readable backpressure applies;
// this is also used when draining a cached SSE event into bounded output chunks.
abstract class IncrementalTransform extends Transform {
  private current?: {
    raw: Buffer;
    at: number;
    callback: TransformCallback;
    ended?: boolean;
  };
  private blocked = false;
  private pumping = false;
  protected work?: Iterator<Buffer>;
  private output = new Chunks();
  protected outputBytes = (raw: Buffer) => this.output.add(raw);
  protected abstract byte(raw: Buffer, at: number): boolean;
  protected chunkEnd(_raw: Buffer) {
    void _raw;
  }
  protected abstract finish(): void;
  _read(size: number) {
    this.blocked = false;
    super._read(size);
    this.pump();
  }
  _transform(
    raw: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.current = { raw, at: 0, callback };
    this.pump();
  }
  private pushReady(final = false) {
    for (const raw of this.output.take(final))
      if (!this.push(raw)) {
        this.blocked = true;
        break;
      }
  }
  private pump() {
    if (this.pumping || !this.current) return;
    this.pumping = true;
    try {
      while (!this.blocked && this.current) {
        if (this.work) {
          const next = this.work.next();
          if (next.done) this.work = undefined;
          else this.outputBytes(next.value);
          this.pushReady();
          continue;
        }
        const current = this.current;
        if (current.at < current.raw.length) {
          if (this.byte(current.raw, current.at)) current.at++;
          this.pushReady();
        } else {
          if (!current.ended) {
            this.chunkEnd(current.raw);
            current.ended = true;
          }
          this.pushReady(true);
          if (!this.blocked) {
            this.current = undefined;
            current.callback();
          }
        }
      }
    } catch (error) {
      const current = this.current;
      this.current = undefined;
      current?.callback(error as Error);
    } finally {
      this.pumping = false;
    }
  }
  _flush(callback: TransformCallback) {
    try {
      this.finish();
      // EOF can flush a large scalar or dispatch an SSE event. Both must drain
      // completely through the normal backpressure pump before completing.
      this.current = { raw: Buffer.alloc(0), at: 0, callback };
      this.pump();
    } catch (error) {
      callback(error as Error);
    }
  }
}

export class JsonResponseRedactor extends IncrementalTransform {
  private lexer: JsonLexer;
  private seen = false;
  constructor(values: string[]) {
    super();
    this.lexer = new JsonLexer(values, this.outputBytes);
  }
  protected byte(raw: Buffer, at: number) {
    this.seen = true;
    this.lexer.add(raw[at], raw.subarray(at, at + 1));
    return true;
  }
  protected finish() {
    this.lexer.finish(!this.seen);
  }
}

type Line = {
  start: number;
  value: number;
  end: number;
  after: number;
  data: boolean;
  fixed: boolean;
  content: number;
};
function* lines(raw: Buffer, bom = false): Generator<Line> {
  for (let start = 0; start < raw.length;) {
    let end = start;
    while (end < raw.length && raw[end] !== 10 && raw[end] !== 13) end++;
    let after = end;
    if (after < raw.length) {
      after++;
      if (raw[end] === 13 && raw[after] === 10) after++;
    }
    let colon = start;
    while (colon < end && raw[colon] !== 58) colon++;
    let value = colon < end ? colon + 1 : end;
    if (raw[value] === 32 && value < end) value++;
    const field =
      bom &&
      start === 0 &&
      raw[0] === 0xef &&
      raw[1] === 0xbb &&
      raw[2] === 0xbf
        ? 3
        : start;
    const name = raw.subarray(field, colon).toString("utf8");
    yield {
      start,
      value,
      end,
      after,
      data: name === "data",
      fixed: colon === field || ["data", "event", "id", "retry"].includes(name),
      content: field,
    };
    start = after;
  }
}
function jsonEvent(raw: Buffer, bom: boolean) {
  const lexer = new JsonLexer([], () => {});
  let found = false;
  try {
    for (const line of lines(raw, bom))
      if (line.data) {
        found = true;
        for (let at = line.value; at < line.end; at++)
          lexer.add(raw[at], raw.subarray(at, at + 1));
        lexer.add(10, Buffer.alloc(0));
      }
    lexer.finish();
    return found;
  } catch (error) {
    if (error instanceof AppError && error.code === "UPSTREAM_INVALID_JSON")
      return false;
    throw error;
  }
}
function* filteredEvent(
  raw: Buffer,
  values: string[],
  bom: boolean,
  matcher: Matcher,
): Generator<Buffer> {
  const chunks = new Chunks();
  const json = jsonEvent(raw, bom);
  const lexer = json ? new JsonLexer(values, chunks.add, matcher) : undefined;
  const data = new SemanticFilter(values, chunks.add, matcher);
  const utf8 = new Utf8Units((text, bytes) => data.add(text, bytes));
  let dataLines = 0;
  for (const line of lines(raw, bom)) if (line.data) dataLines++;
  for (const line of lines(raw, bom)) {
    if (!line.fixed) {
      // Unknown field names are upstream data, not trusted grammar. Filter the
      // entire line so a credential may span its colon/value. The replacement
      // contains no colon or newline and includes '[', so an originally ignored
      // name cannot turn into a standard data/event/id/retry field.
      const opaque = (bytes: Buffer) =>
        lexer ? chunks.add(bytes) : data.add("", bytes, true);
      opaque(raw.subarray(line.start, line.content));
      const field = new SemanticFilter(values, opaque, matcher);
      const decoder = new Utf8Units((text, bytes) => field.add(text, bytes));
      for (let at = line.content; at < line.end; at++) {
        decoder.add(raw[at], raw.subarray(at, at + 1));
        yield* chunks.take();
      }
      decoder.finish();
      field.finish();
      opaque(raw.subarray(line.end, line.after));
      yield* chunks.take();
      continue;
    }
    const prefix = raw.subarray(line.start, line.value);
    if (lexer || !line.data) {
      if (!lexer) {
        utf8.finish();
        data.add("", prefix, true);
      } else chunks.add(prefix);
    } else data.add("", prefix, true);
    if (line.data) {
      for (let at = line.value; at < line.end; at++) {
        if (lexer) lexer.add(raw[at], raw.subarray(at, at + 1));
        else utf8.add(raw[at], raw.subarray(at, at + 1));
        yield* chunks.take();
      }
      const ending = raw.subarray(line.end, line.after);
      if (lexer) lexer.add(10, ending);
      else {
        utf8.finish();
        data.add(--dataLines ? "\n" : "", ending, true);
      }
    } else {
      const field = new SemanticFilter(
        values,
        (bytes) => (lexer ? chunks.add(bytes) : data.add("", bytes, true)),
        matcher,
      );
      const decoder = new Utf8Units((text, bytes) => field.add(text, bytes));
      for (let at = line.value; at < line.end; at++) {
        decoder.add(raw[at], raw.subarray(at, at + 1));
        yield* chunks.take();
      }
      decoder.finish();
      field.finish();
      if (lexer) chunks.add(raw.subarray(line.end, line.after));
      else data.add("", raw.subarray(line.end, line.after), true);
    }
    yield* chunks.take();
  }
  if (lexer) lexer.finish();
  else {
    utf8.finish();
    data.finish();
  }
  yield* chunks.take(true);
}

// SSE has no data content-type. Cache only the current event to distinguish
// actual JSON from ordinary text (including [DONE]) without guessing its first
// character. Dispatch at a blank line/EOF, with the existing 100 MiB raw cap.
export class SseResponseRedactor extends IncrementalTransform {
  private parts: Buffer[] = [];
  private size = 0;
  private start = 0;
  private lineSize = 0;
  private cr = false;
  private blank = false;
  private firstEvent = true;
  private readonly matcher;
  constructor(private readonly values: string[]) {
    super();
    this.matcher = createSecretMatcher(values);
  }
  private append(raw: Buffer, end: number) {
    if (end > this.start) this.parts.push(raw.subarray(this.start, end));
    this.start = end;
  }
  private dispatch() {
    const raw = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.work = filteredEvent(raw, this.values, this.firstEvent, this.matcher);
    this.firstEvent = false;
  }
  protected byte(raw: Buffer, at: number) {
    const byte = raw[at];
    if (this.cr) {
      this.cr = false;
      if (byte === 10) {
        if (++this.size > RESPONSE_LIMIT)
          throw new AppError(413, "RESPONSE_TOO_LARGE", "响应最大 100 MiB");
        if (this.blank) {
          this.append(raw, at + 1);
          this.dispatch();
        }
        return true;
      }
      if (this.blank) {
        this.append(raw, at);
        this.dispatch();
        return false;
      }
    }
    if (++this.size > RESPONSE_LIMIT)
      throw new AppError(413, "RESPONSE_TOO_LARGE", "响应最大 100 MiB");
    if (byte === 13) {
      this.cr = true;
      this.blank = !this.lineSize;
      this.lineSize = 0;
    } else if (byte === 10) {
      const blank = !this.lineSize;
      this.lineSize = 0;
      if (blank) {
        this.append(raw, at + 1);
        this.dispatch();
      }
    } else this.lineSize++;
    return true;
  }
  protected chunkEnd(raw: Buffer) {
    this.append(raw, raw.length);
    this.start = 0;
  }
  protected finish() {
    if (this.parts.length) this.dispatch();
  }
}

export function responseRedactor(
  contentType: string,
  values: string[],
): Transform {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (
    type === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type)
  )
    return new JsonResponseRedactor(values);
  if (type === "text/event-stream") return new SseResponseRedactor(values);
  return new Redactor(values);
}
