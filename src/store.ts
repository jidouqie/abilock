import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  AppError,
  chatSchema,
  connectionNoteSchema,
  docVersionSchema,
  type DocVersion,
  type State,
  type Platform,
  type SavedPlatform,
  type Secret,
  type Doc,
} from "./schema.js";
import {
  capabilityNotesSchema,
  serverInventorySchema,
  type ServerInventory,
} from "./capability-notes.js";
import { buildDiscovery } from "./discovery.js";
import { acquireProcessLock } from "./process-lock.js";
import { assertPrivatePath, syncDirectory } from "./platform-files.js";
import { connectionUsageContext } from "./connection-usage-context.js";
import { assertDocumentMetadata } from "./docs.js";
import {
  validatePlatform,
  credentialSecretValues,
  redact,
  safeUrl,
} from "./security.js";
import {
  connectionSchema,
  type Connection,
  type Credentials,
  type SavedConnection,
} from "./connections.js";
import { protocolAdapters } from "./protocols/index.js";
import {
  parseLearnManifest,
  parseConnectionLearnManifest,
  type LearnManifest,
  type ConnectionLearnManifest,
} from "./learn.js";
export type DocumentExportStatus =
  | { status: "ready" }
  | { status: "pending"; code: "DOCUMENT_EXPORT_PENDING"; message: string };
// undefined: no stored credential; null: a malformed record or ciphertext field.
function sealedValue(record: unknown): string | undefined | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const sealed = (record as { sealed?: unknown }).sealed;
  return sealed === undefined ? undefined : typeof sealed === "string" ? sealed : null;
}
function recordAlias(record: unknown) {
  const alias =
    record && typeof record === "object"
      ? (record as { alias?: unknown }).alias
      : undefined;
  return typeof alias === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias)
    ? alias
    : null;
}
function pendingDocumentExport(): DocumentExportStatus {
  return {
    status: "pending",
    code: "DOCUMENT_EXPORT_PENDING",
    message:
      "配置和手册已保存；Markdown 副本暂未更新，重新打开配置后会自动重建。",
  };
}
export class Store {
  state: State = { version: 1, platforms: [], docs: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private pendingWrites = 0;
  private initialized = false;
  private closing = false;
  private initialization?: Promise<void>;
  private closePromise?: Promise<void>;
  private key: Buffer;
  private exportStatus: DocumentExportStatus = { status: "ready" };
  get docsExportStatus(): DocumentExportStatus {
    return { ...this.exportStatus };
  }
  private protectedSecrets: readonly string[];
  constructor(
    public dir: string,
    master: string,
    protectedSecrets: readonly string[] = [],
    private options: { readOnly?: boolean; signal?: AbortSignal } = {},
  ) {
    if (!/^[a-f0-9]{64}$/i.test(master))
      throw new Error("ABILOCK_MASTER_KEY 必须为 64 位十六进制，不能使用空值");
    this.key = Buffer.from(master, "hex");
    this.protectedSecrets = Object.freeze([
      ...new Set(protectedSecrets.filter(Boolean)),
    ]);
  }
  init(): Promise<void> {
    if (this.closing)
      return Promise.reject(
        new AppError(503, "STORE_CLOSED", "存储正在关闭或已关闭"),
      );
    if (!this.initialization)
      this.initialization = this.initialize()
        .then(() => {
          this.initialized = true;
        })
        .catch(async (error: unknown) => {
          this.closing = true;
          throw error;
        });
    return this.initialization;
  }
  private async readState(): Promise<State> {
    try {
      const raw = await fs.readFile(path.join(this.dir, "state.json"), "utf8");
      const parsed = JSON.parse(raw) as State;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.platforms) ||
        !Array.isArray(parsed.docs) ||
        (parsed.connections !== undefined && !Array.isArray(parsed.connections))
      ) throw new Error("invalid state");
      const unrecognized = {
        platforms: [] as unknown[],
        connections: [] as unknown[],
      };
      // A ciphertext that does not open means a wrong master key or damaged
      // file. That stays a whole-store failure; only records this version
      // cannot validate are set aside, never executed and never deleted.
      const connections: SavedConnection[] = [];
      for (const c of parsed.connections ?? []) {
        const sealed = sealedValue(c);
        const secret =
          typeof sealed === "string" ? this.unsealCredentials(sealed) : undefined;
        if (sealed !== null && this.validConnectionRecord(c, secret))
          connections.push(c);
        else unrecognized.connections.push(c);
      }
      const platforms: SavedPlatform[] = [];
      for (const p of parsed.platforms) {
        const sealed = sealedValue(p);
        if (typeof sealed === "string") this.unseal(sealed);
        if (sealed !== null && this.validPlatformRecord(p)) platforms.push(p);
        else unrecognized.platforms.push(p);
      }
      parsed.platforms = platforms;
      if (parsed.connections !== undefined) parsed.connections = connections;
      if (unrecognized.platforms.length || unrecognized.connections.length)
        parsed.unrecognized = unrecognized;
      else delete parsed.unrecognized;
      this.assertStoredMetadata(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      // Never expose stored bytes or parsing/decryption details to a caller.
      throw new Error("配置或主密钥无效；不会覆盖现有数据");
    }
  }
  private validConnectionRecord(
    c: SavedConnection,
    secret: Credentials | undefined,
  ) {
    try {
      if (c.learnedContext !== undefined &&
          !/^(?:[a-f0-9]{64}|identity-changed)$/.test(c.learnedContext))
        return false;
      connectionSchema.parse({
        alias: c.alias, name: c.name, kind: c.kind, enabled: c.enabled,
        note: c.note,
        description: c.description, documentationUrl: c.documentationUrl,
        capabilityNotes: c.capabilityNotes, trustBoundary: c.trustBoundary,
        config: c.config,
      });
      const note = connectionNoteSchema.parse(c.note) ?? "";
      protocolAdapters[c.kind].validate(c, secret);
      if (c.inventory) serverInventorySchema.parse(c.inventory);
      c.note = note;
      return true;
    } catch {
      return false;
    }
  }
  private validPlatformRecord(p: SavedPlatform) {
    try {
      if (p.learnedContext !== undefined && p.learnedContext !== "identity-changed")
        return false;
      const note = connectionNoteSchema.parse(p.note) ?? "";
      validatePlatform(p);
      this.assertPlatformNotes(p);
      p.note = note;
      return true;
    } catch {
      return false;
    }
  }
  private async writerLock() {
    // Waiting is only for a bounded local commit. Network requests, document
    // fetching and the lifetime of the configuration window never hold this lock.
    // Each attempt starts a short native helper, so retries back off.
    const deadline = Date.now() + 10000;
    let wait = 25;
    for (;;) {
      try {
        return await acquireProcessLock(path.join(this.dir, "service.lock"), {
          signal: this.options.signal,
          busyCode: "CONFIG_BUSY",
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "CONFIG_BUSY" ||
            Date.now() >= deadline) throw error;
        await delay(Math.min(wait, Math.max(1, deadline - Date.now())), undefined, {
          signal: this.options.signal,
        });
        wait = Math.min(wait * 2, 250);
      }
    }
  }
  // Atomic commits rename a fresh file, so identity plus nanosecond times
  // change on every commit. The protected-secret version forces a rescan when
  // redaction inputs change without a new file.
  private snapshotKey?: string;
  private secretsVersion = 0;
  private async stateFileKey() {
    const stat = await fs.stat(path.join(this.dir, "state.json"), {
      bigint: true,
    });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs,
      this.secretsVersion].join(":");
  }
  private async updateSnapshot() {
    let key: string;
    try {
      key = await this.stateFileKey();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new AppError(409, "CONFIG_REQUIRED", "请先运行 abl config 完成本机配置");
      throw error;
    }
    // Stat precedes the read: a commit landing in between only causes one more
    // reload, never a stale snapshot. Unchanged authority skips parsing,
    // decryption and redaction scans that grow with every saved manual.
    if (key !== this.snapshotKey) {
      let parsed: State;
      try {
        parsed = await this.readState();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new AppError(409, "CONFIG_REQUIRED", "请先运行 abl config 完成本机配置");
        throw error;
      }
      // Read-only refresh is an atomic-file snapshot, without a lock, repairs or
      // filesystem writes. A concurrent commit is visible on the next request.
      this.cleanDocumentBodies(parsed);
      parsed.discovery = this.catalog(parsed);
      this.state = parsed;
      this.snapshotKey = key;
    }
    try {
      await fs.access(path.join(this.dir, ".docs-export-pending"));
      this.exportStatus = pendingDocumentExport();
    } catch (error) {
      this.exportStatus = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "ready" } : pendingDocumentExport();
    }
  }
  private async initialize() {
    if (this.options.readOnly) return this.updateSnapshot();
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = await this.writerLock();
    try {
      let parsed: State;
      try {
        parsed = await this.readState();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.persist({ version: 1, platforms: [], docs: [] });
        return;
      }
      this.state = parsed;
      if (this.cleanDocumentBodies(parsed)) await this.persist(parsed);
      else {
        parsed.discovery = this.catalog(parsed);
        await this.rebuildDocumentMirror(parsed);
        this.snapshotKey = await this.stateFileKey();
      }
    } finally {
      await lock.release();
    }
  }
  /** Refresh between requests; writes always reload again under the lock. */
  refresh(): Promise<void> {
    if (this.closing)
      return Promise.reject(new AppError(503, "STORE_CLOSED", "存储正在关闭或已关闭"));
    if (!this.initialized)
      return Promise.reject(new AppError(503, "STORE_NOT_READY", "存储尚未初始化"));
    const task = this.queue.then(() => this.updateSnapshot());
    this.queue = task.catch(() => {});
    return task;
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      // Seal the queue synchronously; accepted transactions finish and release
      // their own descriptors even if close arrives while waiting for a lock.
      this.closing = true;
      this.closePromise = (async () => {
        await this.initialization?.catch(() => {});
        await this.queue;
      })();
    }
    return this.closePromise;
  }
  seal(secret: Secret | Credentials) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(secret)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
  }
  unsealCredentials(sealed: string): Credentials {
    return this.unseal(sealed) as Credentials;
  }
  unseal(sealed: string): Secret {
    const b = Buffer.from(sealed, "base64");
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      b.subarray(0, 12),
    );
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
    );
  }
  secrets() {
    return this.stateSecrets(this.state);
  }
  setProtectedSecrets(values: readonly string[]) {
    if (this.pendingWrites)
      throw new AppError(409, "CONFIG_BUSY", "配置正在写入，请完成后重试");
    const candidate = Object.freeze([
      ...new Set([...this.protectedSecrets, ...values.filter(Boolean)]),
    ]);
    this.assertStoredMetadata(this.state, candidate);
    this.protectedSecrets = candidate;
    this.secretsVersion++;
    this.state.discovery = this.catalog(this.state);
  }
  private stateSecrets(
    state: State,
    protectedSecrets: readonly string[] = this.protectedSecrets,
  ) {
    const platformSecrets = state.platforms.flatMap((p) => {
      if (!p.sealed) return [];
      const s = this.unseal(p.sealed);
      const basic =
        s.username && s.password
          ? Buffer.from(`${s.username}:${s.password}`).toString("base64")
          : undefined;
      return [
        s.value,
        s.username,
        s.password,
        p.auth.type === "bearer" && s.value ? `Bearer ${s.value}` : undefined,
        basic,
        basic ? `Basic ${basic}` : undefined,
      ].filter((v): v is string => !!v);
    });
    const connectionSecrets = (state.connections ?? []).flatMap((c) =>
      c.sealed
        ? credentialSecretValues(c, this.unsealCredentials(c.sealed))
        : [],
    );
    // Set-aside records still own real credentials: keep redacting them.
    const unrecognizedSecrets = [
      ...(state.unrecognized?.platforms ?? []),
      ...(state.unrecognized?.connections ?? []),
    ].flatMap((record) => {
      const sealed = sealedValue(record);
      if (typeof sealed !== "string") return [];
      const opened = this.unseal(sealed) as Record<string, unknown>;
      const values = Object.values(opened).filter(
        (value): value is string => typeof value === "string" && !!value,
      );
      const user = typeof opened.username === "string" ? opened.username : "";
      const password =
        typeof opened.password === "string"
          ? opened.password
          : typeof opened.token === "string"
            ? opened.token
            : "";
      if (user && password) {
        const pair = `${user}:${password}`,
          encoded = Buffer.from(pair).toString("base64");
        values.push(pair, encoded, `Basic ${encoded}`);
      }
      if (typeof opened.value === "string" && opened.value)
        values.push(`Bearer ${opened.value}`);
      if (typeof opened.token === "string" && opened.token)
        values.push(`Bearer ${opened.token}`);
      return values;
    });
    return [
      this.key.toString("hex"),
      this.key.toString("hex").toUpperCase(),
      ...protectedSecrets,
      ...platformSecrets,
      ...connectionSecrets,
      ...unrecognizedSecrets,
    ];
  }
  /** Public names of set-aside records; never their configuration or secrets. */
  unrecognizedRecords() {
    return [
      ...(this.state.unrecognized?.platforms ?? []).map((record) => ({
        record,
        type: "api",
      })),
      ...(this.state.unrecognized?.connections ?? []).map((record) => ({
        record,
        type: "connection",
      })),
    ].map(({ record, type }) => {
      const kind =
        record && typeof record === "object"
          ? (record as { kind?: unknown }).kind
          : undefined;
      return {
        alias: recordAlias(record),
        type,
        kind:
          typeof kind === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(kind)
            ? kind
            : null,
      };
    });
  }
  private reservedAliases(state: State) {
    return new Set(
      [
        ...(state.unrecognized?.platforms ?? []),
        ...(state.unrecognized?.connections ?? []),
      ]
        .map(recordAlias)
        .filter((alias): alias is string => !!alias)
        .map((alias) => alias.toLowerCase()),
    );
  }
  /** Deletes a set-aside record and its manuals after explicit user action. */
  async removeUnrecognized(alias: string) {
    this.assertAlias(alias);
    return this.transact((d) => {
      const matches = (record: unknown) =>
        recordAlias(record)?.toLowerCase() === alias.toLowerCase();
      const before =
        (d.unrecognized?.platforms.length ?? 0) +
        (d.unrecognized?.connections.length ?? 0);
      if (d.unrecognized) {
        d.unrecognized.platforms = d.unrecognized.platforms.filter(
          (record) => !matches(record),
        );
        d.unrecognized.connections = d.unrecognized.connections.filter(
          (record) => !matches(record),
        );
      }
      const after =
        (d.unrecognized?.platforms.length ?? 0) +
        (d.unrecognized?.connections.length ?? 0);
      if (before === after)
        throw new AppError(404, "CONNECTION_NOT_FOUND", "记录不存在");
      if (
        ![...d.platforms, ...(d.connections ?? [])].some(
          (owner) => owner.alias.toLowerCase() === alias.toLowerCase(),
        )
      )
        d.docs = d.docs.filter(
          (doc) => doc.alias.toLowerCase() !== alias.toLowerCase(),
        );
    });
  }
  private assertConnectionNote(note: string | undefined, secrets: string[]) {
    if (redact(note ?? "", secrets) !== (note ?? ""))
      throw new AppError(
        400,
        "NOTE_SECRET",
        "备注不得包含已保管的凭据，请填写用途或账号标记",
      );
  }
  private assertStoredMetadata(
    state: State,
    protectedSecrets: readonly string[] = this.protectedSecrets,
  ) {
    const secrets = this.stateSecrets(state, protectedSecrets);
    const authQueryNames = state.platforms.flatMap((platform) =>
      platform.auth.type === "query" && platform.auth.name
        ? [platform.auth.name]
        : [],
    );
    // Credentials can become known after documentation was imported. Recheck
    // metadata against the complete effective draft before committing either
    // management write path; document business text is deliberately excluded.
    for (const doc of state.docs) {
      if (doc.previous !== undefined) docVersionSchema.parse(doc.previous);
      for (const version of [doc, ...(doc.previous ? [doc.previous] : [])]) {
        try { assertDocumentMetadata(version, secrets, authQueryNames); }
        catch (error) {
          if (error instanceof AppError && ["DOC_METADATA_SECRET", "DOC_URL_CREDENTIAL"].includes(error.code))
            throw new AppError(error.status, error.code, "当前手册或上一版的标题、来源含有凭据，请先清理");
          throw error;
        }
      }
    }
    for (const owner of [...state.platforms, ...(state.connections ?? [])]) {
      this.assertConnectionNote(owner.note, secrets);
      if (
        owner.documentationUrl !== undefined &&
        owner.documentationUrl !== null
      ) {
        assertDocumentMetadata(
          { title: owner.alias, sourceUrl: owner.documentationUrl },
          secrets,
          authQueryNames,
        );
        safeUrl(owner.documentationUrl);
      }
      if (owner.learnedDocumentationUrl) {
        assertDocumentMetadata(
          { title: owner.alias, sourceUrl: owner.learnedDocumentationUrl },
          secrets,
          authQueryNames,
        );
        safeUrl(owner.learnedDocumentationUrl);
      }
      const text = (owner.capabilityNotes ?? []).flatMap((note) => [
        note.name,
        note.summary,
        note.input,
        note.output,
        ...note.tags,
      ]);
      if (text.some((value) => redact(value, secrets) !== value))
        throw new AppError(
          400,
          "CAPABILITY_SECRET",
          "能力说明不得包含已保管的凭据；请仅填写用途和业务参数说明",
        );
    }
    if (
      state.platforms.some(
        (p) =>
          p.chat &&
          [p.chat.model, p.chat.path].some(
            (text) => redact(text, secrets) !== text,
          ),
      )
    )
      throw new AppError(
        400,
        "CHAT_SECRET",
        "聊天快捷配置不得包含已保管的凭据",
      );
    if (
      [...state.platforms, ...(state.connections ?? [])].some(
        (platform) =>
          platform.learnedDocId &&
          [
            platform.description,
            ...("rules" in platform
              ? platform.rules.map((rule) => rule.path)
              : []),
          ].some((text) => redact(text, secrets) !== text),
      )
    )
      throw new AppError(
        400,
        "LEARN_SECRET",
        "公开接口说明不得包含已保管的凭据",
      );
  }
  private cleanDocumentBodies(state: State) {
    const secrets = this.stateSecrets(state);
    let changed = false;
    for (const doc of state.docs) {
      let documentChanged = false;
      for (const version of [doc, ...(doc.previous ? [doc.previous] : [])]) {
        // A credential enrolled later must also disappear from the previous
        // version. History never preserves a copy excluded from current rules.
        const markdown = version.markdown.split("[REDACTED]")
          .map((part) => redact(part, secrets)).join("[REDACTED]");
        if (markdown === version.markdown) continue;
        version.markdown = markdown;
        documentChanged = true;
      }
      if (documentChanged) {
        doc.revision++;
        doc.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    return changed;
  }
  private previousDocument(doc: Doc): DocVersion {
    // Explicit projection prevents recursive history or configuration/secrets
    // from being included when a saved document is replaced.
    return { title: doc.title, sourceUrl: doc.sourceUrl, markdown: doc.markdown,
      revision: doc.revision, updatedAt: doc.updatedAt };
  }
  publicDocument(doc: Doc) {
    return { id: doc.id, alias: doc.alias, title: doc.title, sourceUrl: doc.sourceUrl,
      markdown: doc.markdown, mode: doc.mode, revision: doc.revision, updatedAt: doc.updatedAt,
      ...(doc.previous ? { hasPrevious: true } : {}) };
  }
  documents(alias: string) {
    return this.state.docs.filter((doc) => doc.alias === alias)
      .map((doc) => this.publicDocument(doc));
  }
  publicPlatform(p: SavedPlatform) {
    const { sealed, ...out } = p;
    return { ...out, note: out.note ?? "", hasSecret: !!sealed };
  }
  list() {
    return this.state.platforms.map((p) => this.publicPlatform(p));
  }
  platform(alias: string) {
    const p = this.state.platforms.find(
      (p) => p.alias.toLowerCase() === alias.toLowerCase(),
    );
    if (!p) throw new AppError(404, "PLATFORM_NOT_FOUND", "平台不存在");
    return p;
  }
  publicConnection(c: SavedConnection) {
    const { sealed, ...out } = c;
    return { ...out, note: out.note ?? "", hasSecret: !!sealed };
  }
  listConnections() {
    return (this.state.connections ?? []).map((c) => this.publicConnection(c));
  }
  private assertPlatformNotes(p: Platform) {
    if (p.chat) {
      chatSchema.parse(p.chat);
      if (
        !p.rules.some(
          (r) => r.method === p.chat!.method && r.path === p.chat!.path,
        )
      )
        throw new AppError(
          400,
          "CHAT_SCOPE",
          "聊天快捷配置必须绑定已允许的 POST 接口",
        );
    }
    if (p.capabilityNotes) {
      capabilityNotesSchema.parse(p.capabilityNotes);
      if (
        p.capabilityNotes.some(
          (note) =>
            !p.rules.some(
              (r) => r.method === note.method && r.path === note.path,
            ),
        )
      )
        throw new AppError(
          400,
          "CAPABILITY_SCOPE",
          "能力说明必须关联已允许的方法与路径",
        );
    }
  }
  private catalog(state: State) {
    const secrets = this.stateSecrets(state);
    return buildDiscovery(
      {
        platforms: state.platforms.map((p) => this.publicPlatform(p)),
        connections: (state.connections ?? []).map((c) =>
          this.publicConnection(c),
        ),
        docs: state.docs,
      },
      (value) => redact(value, secrets),
    );
  }
  discovery() {
    return structuredClone(this.state.discovery ?? this.catalog(this.state));
  }
  async recordInventory(
    alias: string,
    inventory: ServerInventory,
    expected: number,
  ) {
    const parsed = serverInventorySchema.parse(inventory);
    return this.transact((draft) => {
      const c = draft.connections?.find(
        (c) => c.alias.toLowerCase() === alias.toLowerCase(),
      );
      if (!c || c.kind !== "ssh")
        throw new AppError(404, "CONNECTION_NOT_FOUND", "SSH连接不存在");
      if (c.revision !== expected)
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          "连接已变化，概况未覆盖，请重新载入",
        );
      c.inventory = parsed;
      if (
        [parsed.os, parsed.architecture, ...parsed.tools].some(
          (value) => redact(value, this.stateSecrets(draft)) !== value,
        )
      )
        throw new AppError(
          502,
          "INSPECTION_RESULT",
          "服务器概况响应无效；旧概况已保留",
        );
      c.revision++;
      c.updatedAt = new Date().toISOString();
      return this.publicConnection(c);
    });
  }
  connection(kind: Connection["kind"], selector: string) {
    const all = (this.state.connections ?? []).filter((c) => c.kind === kind);
    const aliased = all.find(
      (c) => c.alias.toLowerCase() === selector.toLowerCase(),
    );
    if (aliased) return aliased;
    const matches = all.filter((c) => {
      if (c.config.host === selector) return true;
      const target = c.config.endpoint ?? c.config.url;
      if (typeof target === "string") {
        try {
          return (
            new URL(target).hostname.replaceAll("[", "").replaceAll("]", "") ===
            selector
          );
        } catch {
          return false;
        }
      }
      return false;
    });
    if (matches.length > 1)
      throw new AppError(
        409,
        "AMBIGUOUS_IDENTITY",
        "同一目标有多个身份，请使用明确连接别名",
      );
    if (matches.length === 1) return matches[0];
    throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
  }
  async saveConnection(
    c: Connection,
    secret: Credentials | undefined,
    clear: boolean,
    expected?: number,
    existingAlias?: string,
  ) {
    c = connectionSchema.parse(c);
    if (existingAlias !== undefined) this.assertAlias(existingAlias);
    let previous: { alias: string; kind: Connection["kind"] } | undefined;
    const saved = await this.transact((d) => {
      d.connections ??= [];
      const selectedAlias = existingAlias ?? c.alias;
      const i = d.connections.findIndex(
          (x) => x.alias.toLowerCase() === selectedAlias.toLowerCase(),
        ),
        old = d.connections[i];
      this.assertWriteIdentity(existingAlias, c.alias, !!old, expected);
      previous = old ? { alias: old.alias, kind: old.kind } : undefined;
      if (
        d.platforms.some(
          (p) => p.alias.toLowerCase() === c.alias.toLowerCase(),
        ) ||
        d.connections.some(
          (connection, index) =>
            index !== i &&
            connection.alias.toLowerCase() === c.alias.toLowerCase(),
        ) ||
        this.reservedAliases(d).has(c.alias.toLowerCase())
      )
        throw new AppError(409, "ALIAS_CONFLICT", "别名已存在");
      if (
        (old && expected !== old.revision) ||
        (!old && expected !== undefined && expected !== 0)
      )
        throw new AppError(409, "REVISION_CONFLICT", "连接已变化，请重新载入");
      if (old && old.kind !== c.kind && !secret && !clear)
        throw new AppError(
          400,
          "SECRET_REQUIRED",
          "切换协议时请重新录入或清除凭据",
        );
      const effectiveSecret = clear
        ? undefined
        : (secret ??
          (old?.sealed ? this.unsealCredentials(old.sealed) : undefined));
      // Validate the exact credentials that would be persisted, inside the
      // serialized transaction. A metadata/config edit must not retain a
      // ciphertext that the new adapter configuration would reject on restart.
      protocolAdapters[c.kind].validate(c, effectiveSecret);
      if (
        old?.sealed &&
        !secret &&
        !clear &&
        (c.config.auth ?? c.config.authType) === "none" &&
        (old.config.auth ?? old.config.authType) !== "none"
      )
        throw new AppError(
          400,
          "SECRET_REQUIRED",
          "切换为无鉴权时请明确清除旧凭据",
        );
      const saved: SavedConnection = {
        ...c,
        note: c.note ?? old?.note ?? "",
        documentationUrl:
          c.documentationUrl === undefined
            ? old?.documentationUrl
            : c.documentationUrl,
        capabilityNotes:
          c.capabilityNotes ??
          (old?.kind === c.kind ? old.capabilityNotes : undefined),
        alias: existingAlias === undefined ? (old?.alias ?? c.alias) : c.alias,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        ...(old?.learnedDocId && old.kind === c.kind
          ? {
              learnedDocId: old.learnedDocId,
              learnedDocumentationUrl: old.learnedDocumentationUrl,
              learnedContext: old.learnedContext,
            }
          : {}),
      };
      // Check the old credentials too: rotating or clearing a credential in
      // this write must not allow its value to move into the public note.
      this.assertConnectionNote(saved.note, this.stateSecrets(d));
      if (saved.documentationUrl === undefined) delete saved.documentationUrl;
      if (saved.learnedDocumentationUrl === undefined)
        delete saved.learnedDocumentationUrl;
      if (saved.learnedContext === undefined) delete saved.learnedContext;
      if (
        old?.learnedDocId &&
        old.kind === c.kind &&
        ["git", "registry", "redis"].includes(c.kind) &&
        (old.sealed
          ? this.unsealCredentials(old.sealed).username
          : undefined) !== effectiveSecret?.username
      )
        // Some adapters accept their account name as part of the credential.
        // Record only invalidation, never publish a hash of private values.
        saved.learnedContext = "identity-changed";
      if (saved.capabilityNotes === undefined) delete saved.capabilityNotes;
      if (
        old?.inventory &&
        old.kind === c.kind &&
        JSON.stringify(old.config) === JSON.stringify(c.config) &&
        !secret &&
        !clear
      )
        saved.inventory = old.inventory;
      if (effectiveSecret) {
        if (secret) saved.sealed = this.seal(effectiveSecret);
        else if (old?.sealed) saved.sealed = old.sealed;
      }
      if (i < 0) d.connections.push(saved);
      else d.connections[i] = saved;
      if (old) this.renameDocumentOwner(d, old.alias, saved.alias);
      this.assertStoredMetadata(d);
      return this.publicConnection(saved);
    });
    if (previous) await this.moveConnectionState(previous, saved);
    return saved;
  }
  // Alias-owned broker state (Git workspaces) follows a committed rename and
  // goes away with a protocol change. The configuration stays authoritative:
  // a filesystem failure here never reverses or fails the committed write.
  private async moveConnectionState(
    previous: { alias: string; kind: Connection["kind"] },
    saved: { alias: string; kind: Connection["kind"] },
  ) {
    const dataDir = path.join(this.dir, "workspaces");
    try {
      if (previous.kind !== saved.kind)
        await protocolAdapters[previous.kind].removeState?.(dataDir, previous.alias);
      else if (previous.alias !== saved.alias)
        await protocolAdapters[saved.kind].renameState?.(
          dataDir,
          previous.alias,
          saved.alias,
        );
    } catch {
      /* Best effort; the next removal of this alias retries the cleanup. */
    }
  }
  private assertAlias(alias: string) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias))
      throw new AppError(400, "INVALID_ALIAS", "别名格式无效");
  }
  private assertWriteIdentity(
    existingAlias: string | undefined,
    savedAlias: string,
    exists: boolean,
    expected: number | undefined,
  ) {
    if (existingAlias === undefined || exists) return;
    // A PUT path identifies the record being edited. Only a new record with
    // the same path/body alias can use the existing creation contract.
    if (expected !== undefined && expected !== 0)
      throw new AppError(
        409,
        "REVISION_CONFLICT",
        "连接已变化，请重新载入后保存",
      );
    if (existingAlias !== savedAlias)
      throw new AppError(400, "ALIAS_MISMATCH", "原连接不存在，无法改名");
  }
  private renameDocumentOwner(
    state: State,
    oldAlias: string,
    newAlias: string,
  ) {
    if (oldAlias === newAlias) return;
    for (const doc of state.docs)
      if (doc.alias.toLowerCase() === oldAlias.toLowerCase())
        doc.alias = newAlias;
  }
  async removeConnection(alias: string, revision: number) {
    const removed = await this.transact((d) => {
      const c = (d.connections ?? []).find(
        (c) => c.alias.toLowerCase() === alias.toLowerCase(),
      );
      if (!c) throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
      if (c.revision !== revision)
        throw new AppError(409, "REVISION_CONFLICT", "连接已变化");
      d.connections = d.connections!.filter((x) => x !== c);
      d.docs = d.docs.filter((doc) => doc.alias !== c.alias);
      return { alias: c.alias, kind: c.kind };
    });
    try {
      await protocolAdapters[removed.kind].removeState?.(
        path.join(this.dir, "workspaces"),
        removed.alias,
      );
    } catch {
      /* The deletion is committed; leftover state never authorizes access. */
    }
  }
  private transact<T>(work: (draft: State) => T) {
    if (this.options.readOnly)
      return Promise.reject<T>(
        new AppError(403, "LOCAL_READ_ONLY", "执行进程不能修改本机配置"),
      );
    if (this.closing)
      return Promise.reject<T>(
        new AppError(503, "STORE_CLOSED", "存储正在关闭或已关闭"),
      );
    if (!this.initialized)
      return Promise.reject<T>(
        new AppError(503, "STORE_NOT_READY", "存储尚未初始化"),
      );
    this.pendingWrites++;
    const task = this.queue
      .then(async () => {
        const lock = await this.writerLock();
        let committed = false;
        try {
          // The latest authority, not this process's previous snapshot, is the
          // basis for every revision/identity check and every merged commit.
          const current = await this.readState();
          this.state = current;
          const draft = structuredClone(current);
          const value = work(draft);
          this.assertStoredMetadata(draft);
          await this.persist(draft);
          committed = true;
          this.state = draft;
          return value;
        } finally {
          // A rejected draft leaves an unscanned in-memory snapshot behind;
          // the next refresh must reload and scrub it instead of reusing it.
          if (!committed) this.snapshotKey = undefined;
          await lock.release();
        }
      })
      .finally(() => {
        this.pendingWrites--;
      });
    this.queue = task.catch(() => {});
    return task;
  }
  private async persist(state: State) {
    // Only the validated final draft is scrubbed; rejected transactions do not
    // alter the authoritative bytes or the existing document mirror.
    this.cleanDocumentBodies(state);
    state.discovery = this.catalog(state);
    // One atomic authoritative file contains encrypted secrets + docs; readable MD is an export for humans/AI.
    const file = path.join(this.dir, "state.json"),
      tmp = path.join(this.dir, `.state-${crypto.randomUUID()}`);
    // Set-aside records are written back verbatim, never dropped by a commit.
    const { unrecognized, ...authority } = state;
    const stored = {
      ...authority,
      platforms: [...state.platforms, ...(unrecognized?.platforms ?? [])],
      ...(state.connections !== undefined || unrecognized?.connections.length
        ? {
            connections: [
              ...(state.connections ?? []),
              ...(unrecognized?.connections ?? []),
            ],
          }
        : {}),
    };
    try {
      const h = await fs.open(tmp, "wx", 0o600);
      try {
        await h.writeFile(JSON.stringify(stored, null, 2));
        await h.sync();
      } finally {
        await h.close();
      }
      // Mark before commit so interruption after rename remains repairable.
      // This marker contains no source document, configuration or credentials.
      await this.markDocumentExportPending();
      await fs.rename(tmp, file);
      // Every persist runs under the writer lock, so this is our own file.
      this.snapshotKey = await this.stateFileKey();
      // A committed revision must immediately become the next transaction's
      // base even when its disposable Markdown export cannot be written.
      this.state = state;
      await this.rebuildDocumentMirror(state);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  private async markDocumentExportPending() {
    const h = await fs.open(
      path.join(this.dir, ".docs-export-pending"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await h.stat();
      const named = await assertPrivatePath(path.join(this.dir, ".docs-export-pending"), "file");
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino)
        throw new Error("invalid document export marker");
      await h.truncate(0);
      await h.writeFile('{"version":1}\n');
      await h.sync();
      this.exportStatus = pendingDocumentExport();
    } finally {
      await h.close();
    }
  }
  private async rebuildDocumentMirror(state: State) {
    this.exportStatus = pendingDocumentExport();
    try {
      await this.markDocumentExportPending();
      // Persist the authoritative rename and repair marker before advancing
      // any derived file, including across a sudden interruption.
      await syncDirectory(this.dir);
      await this.exportDocs(state);
      await fs.unlink(path.join(this.dir, ".docs-export-pending"));
      this.exportStatus = { status: "ready" };
    } catch {
      // The authoritative state is already saved. Expose a fixed public
      // warning, keep the repair marker and retry on the next write/init.
    }
  }
  private async exportDocs(state: State) {
    const docsDir = path.join(this.dir, "docs");
    await fs.mkdir(docsDir, { recursive: true, mode: 0o700 });
    for (const doc of state.docs) {
      const dest = path.join(docsDir, `${doc.alias}-${doc.id}.md`);
      const tempDoc = `${dest}.${crypto.randomUUID()}.part`;
      try {
        await fs.writeFile(
          tempDoc,
          `# ${doc.title}\n\n来源：${doc.sourceUrl}\n更新时间：${doc.updatedAt}\n导入方式：${doc.mode}\n版本：${doc.revision}\n\n${doc.markdown}\n`,
          { flag: "wx", mode: 0o600 },
        );
        await fs.rename(tempDoc, dest);
      } finally {
        await fs.unlink(tempDoc).catch(() => {});
      }
    }
    const keep = new Set(state.docs.map((d) => `${d.alias}-${d.id}.md`));
    const canonicalNames = new Map(
      [...keep].map((name) => [name.toLowerCase(), name]),
    );
    const entries = new Set(await fs.readdir(docsDir));
    for (const entry of entries) {
      if (!entry.endsWith(".md") || keep.has(entry)) continue;
      const canonical = canonicalNames.get(entry.toLowerCase());
      if (canonical && !entries.has(canonical)) {
        // On a case-insensitive filesystem, replacing a file through a new
        // casing can retain the old directory spelling. The contents are
        // already current; rename that entry before removing stale mirrors.
        await fs.rename(
          path.join(docsDir, entry),
          path.join(docsDir, canonical),
        );
        entries.delete(entry);
        entries.add(canonical);
      } else {
        // Case-sensitive filesystems have both entries after the new export.
        // Remove only the stale one, never replace the freshly written file.
        await fs.unlink(path.join(docsDir, entry));
        entries.delete(entry);
      }
    }
  }
  async save(
    p: Platform,
    secret: Secret | undefined,
    clear: boolean,
    expected?: number,
    existingAlias?: string,
  ) {
    p = { ...p, note: connectionNoteSchema.parse(p.note) };
    this.assertAlias(p.alias);
    if (existingAlias !== undefined) this.assertAlias(existingAlias);
    if (p.capabilityNotes !== undefined)
      p = {
        ...p,
        capabilityNotes: capabilityNotesSchema.parse(p.capabilityNotes),
      };
    validatePlatform(p);
    this.assertPlatformNotes(p);
    return this.transact((d) => {
      const selectedAlias = existingAlias ?? p.alias;
      const i = d.platforms.findIndex(
          (x) => x.alias.toLowerCase() === selectedAlias.toLowerCase(),
        ),
        old = d.platforms[i];
      this.assertWriteIdentity(existingAlias, p.alias, !!old, expected);
      if (
        (d.connections ?? []).some(
          (c) => c.alias.toLowerCase() === p.alias.toLowerCase(),
        ) ||
        d.platforms.some(
          (platform, index) =>
            index !== i &&
            platform.alias.toLowerCase() === p.alias.toLowerCase(),
        ) ||
        this.reservedAliases(d).has(p.alias.toLowerCase())
      )
        throw new AppError(409, "ALIAS_CONFLICT", "别名已存在");
      if (old && expected !== old.revision)
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          "配置已变化，请重新载入后保存",
        );
      if (!old && expected !== undefined && expected !== 0)
        throw new AppError(409, "REVISION_CONFLICT", "新增配置版本冲突");
      if (
        old &&
        JSON.stringify(old.auth) !== JSON.stringify(p.auth) &&
        !secret &&
        !clear &&
        p.auth.type !== "none"
      )
        throw new AppError(
          400,
          "SECRET_REQUIRED",
          "切换鉴权类型时请重新录入秘密或清除旧秘密",
        );
      if (
        secret &&
        p.auth.type === "basic" &&
        (!secret.username || secret.password === undefined)
      )
        throw new AppError(400, "SECRET_REQUIRED", "Basic 需要用户名和密码");
      if (
        secret &&
        !["none", "basic", "adapter"].includes(p.auth.type) &&
        !secret.value
      )
        throw new AppError(400, "SECRET_REQUIRED", "该鉴权需要密钥");
      const saved: SavedPlatform = {
        ...p,
        note: p.note ?? old?.note ?? "",
        documentationUrl:
          p.documentationUrl === undefined
            ? old?.documentationUrl
            : p.documentationUrl,
        chat:
          p.chat === undefined
            ? old?.chat &&
              p.rules.some(
                (r) =>
                  r.method === old.chat!.method && r.path === old.chat!.path,
              )
              ? old.chat
              : undefined
            : p.chat,
        capabilityNotes:
          p.capabilityNotes ??
          old?.capabilityNotes?.filter((note) =>
            p.rules.some(
              (r) => r.method === note.method && r.path === note.path,
            ),
          ),
        alias: existingAlias === undefined ? (old?.alias ?? p.alias) : p.alias,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        ...(old?.learnedDocId
          ? {
              learnedDocId: old.learnedDocId,
              learnedDocumentationUrl: old.learnedDocumentationUrl,
              ...(old.learnedContext
                ? { learnedContext: old.learnedContext }
                : {}),
            }
          : {}),
      };
      this.assertConnectionNote(saved.note, this.stateSecrets(d));
      if (saved.documentationUrl === undefined) delete saved.documentationUrl;
      if (saved.learnedDocumentationUrl === undefined)
        delete saved.learnedDocumentationUrl;
      if (saved.capabilityNotes === undefined) delete saved.capabilityNotes;
      if (saved.chat === undefined) delete saved.chat;
      this.assertPlatformNotes(saved);
      if (p.auth.type !== "none" && !clear) {
        if (secret) saved.sealed = this.seal(secret);
        else if (old?.sealed) saved.sealed = old.sealed;
      }
      if (i < 0) d.platforms.push(saved);
      else d.platforms[i] = saved;
      if (old) this.renameDocumentOwner(d, old.alias, saved.alias);
      // Revalidate credentials against all existing metadata before removing
      // stale descriptions, so an identity edit cannot bypass enrollment checks.
      this.assertStoredMetadata(d);
      if (
        old &&
        (old.baseUrl !== saved.baseUrl ||
          JSON.stringify(old.auth) !== JSON.stringify(saved.auth) ||
          old.allowInsecureLocal !== saved.allowInsecureLocal)
      ) {
        // Public API rules belong to a particular configured target and
        // authentication contract. User identity edits require fresh learning.
        saved.rules = [];
        saved.description = "";
        delete saved.chat;
        delete saved.capabilityNotes;
        // Manuals are user-visible text, not authority: keep every one. The
        // learned manual stays linked so relearning updates it and keeps the
        // prior text as its previous version, and is marked for an update.
        if (saved.learnedDocId) saved.learnedContext = "identity-changed";
      }
      return this.publicPlatform(saved);
    });
  }
  async applyLearnedPlatform(alias: string, input: LearnManifest) {
    const parsed = parseLearnManifest(input);
    const result = await this.transact((draft) => {
      const platform = draft.platforms.find(
        (item) => item.alias.toLowerCase() === alias.toLowerCase(),
      );
      if (!platform)
        throw new AppError(404, "PLATFORM_NOT_FOUND", "连接不存在");
      if (platform.revision !== parsed.expectedRevision)
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          "连接已变化，请重新读取连接并整理接口",
        );
      const secrets = this.stateSecrets(draft);
      assertDocumentMetadata(
        parsed,
        secrets,
        draft.platforms.flatMap((item) =>
          item.auth.type === "query" && item.auth.name ? [item.auth.name] : [],
        ),
      );
      const publicText = [
        ...(parsed.description === undefined ? [] : [parsed.description]),
        ...parsed.rules.map((rule) => rule.path),
        ...(parsed.chat ? [parsed.chat.model, parsed.chat.path] : []),
      ];
      if (publicText.some((text) => redact(text, secrets) !== text))
        throw new AppError(
          400,
          "LEARN_SECRET",
          "公开接口说明不得包含已保管的凭据",
        );
      const oldDoc = platform.learnedDocId
        ? draft.docs.find(
            (doc) =>
              doc.id === platform.learnedDocId && doc.alias === platform.alias,
          )
        : undefined;
      const updatedAt = new Date().toISOString();
      const doc: Doc = {
        title: parsed.title,
        sourceUrl: parsed.sourceUrl,
        markdown: redact(parsed.markdown, secrets),
        id: oldDoc?.id ?? crypto.randomUUID(),
        alias: platform.alias,
        mode: "manual",
        revision: (oldDoc?.revision ?? 0) + 1,
        updatedAt,
        ...(oldDoc ? { previous: this.previousDocument(oldDoc) } : {}),
      };
      platform.rules = parsed.rules;
      platform.capabilityNotes = parsed.capabilityNotes;
      platform.learnedDocId = doc.id;
      delete platform.learnedContext;
      platform.learnedDocumentationUrl = platform.documentationUrl ?? null;
      if (parsed.description !== undefined)
        platform.description = parsed.description;
      if (parsed.chat) platform.chat = parsed.chat;
      else delete platform.chat;
      platform.revision++;
      platform.updatedAt = updatedAt;
      validatePlatform(platform);
      this.assertPlatformNotes(platform);
      if (oldDoc)
        draft.docs = draft.docs.map((item) => (item === oldDoc ? doc : item));
      else draft.docs.push(doc);
      this.assertStoredMetadata(draft);
      return {
        platform: this.publicPlatform(platform),
        document: doc,
      };
    });
    // Persist may scrub a newly registered runtime value from prior content
    // and advance the document revision. Return the committed public version.
    return { ...result, document: this.publicDocument(result.document) };
  }
  async applyLearnedConnection(alias: string, input: ConnectionLearnManifest) {
    const parsed = parseConnectionLearnManifest(input);
    const result = await this.transact((draft) => {
      const connection = draft.connections?.find(
        (item) => item.alias.toLowerCase() === alias.toLowerCase(),
      );
      if (!connection)
        throw new AppError(404, "CONNECTION_NOT_FOUND", "连接不存在");
      if (connection.revision !== parsed.expectedRevision)
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          "连接已变化，请重新读取连接并整理用法",
        );
      const secrets = this.stateSecrets(draft);
      assertDocumentMetadata(
        parsed,
        secrets,
        draft.platforms.flatMap((item) =>
          item.auth.type === "query" && item.auth.name ? [item.auth.name] : [],
        ),
      );
      if (
        parsed.description !== undefined &&
        redact(parsed.description, secrets) !== parsed.description
      )
        throw new AppError(400, "LEARN_SECRET", "公开用法不得包含已保管的凭据");
      const oldDoc = connection.learnedDocId
        ? draft.docs.find(
            (doc) =>
              doc.id === connection.learnedDocId &&
              doc.alias === connection.alias,
          )
        : undefined;
      const updatedAt = new Date().toISOString();
      const doc: Doc = {
        title: parsed.title,
        sourceUrl: parsed.sourceUrl,
        markdown: redact(parsed.markdown, secrets),
        id: oldDoc?.id ?? crypto.randomUUID(),
        alias: connection.alias,
        mode: "manual",
        revision: (oldDoc?.revision ?? 0) + 1,
        updatedAt,
        ...(oldDoc ? { previous: this.previousDocument(oldDoc) } : {}),
      };
      connection.capabilityNotes = parsed.capabilityNotes;
      if (parsed.description !== undefined)
        connection.description = parsed.description;
      connection.learnedDocId = doc.id;
      connection.learnedDocumentationUrl = connection.documentationUrl ?? null;
      connection.learnedContext = connectionUsageContext(connection);
      connection.revision++;
      connection.updatedAt = updatedAt;
      if (oldDoc)
        draft.docs = draft.docs.map((item) => (item === oldDoc ? doc : item));
      else draft.docs.push(doc);
      this.assertStoredMetadata(draft);
      return { connection: this.publicConnection(connection), document: doc };
    });
    // Persist may scrub a newly registered runtime value from prior content
    // and advance the document revision. Return the committed public version.
    return { ...result, document: this.publicDocument(result.document) };
  }
  async remove(alias: string, revision: number) {
    return this.transact((d) => {
      const p = d.platforms.find(
        (p) => p.alias.toLowerCase() === alias.toLowerCase(),
      );
      if (!p) throw new AppError(404, "PLATFORM_NOT_FOUND", "平台不存在");
      if (p.revision !== revision)
        throw new AppError(409, "REVISION_CONFLICT", "配置版本冲突");
      d.platforms = d.platforms.filter((x) => x !== p);
      d.docs = d.docs.filter((x) => x.alias !== p.alias);
    });
  }
  async saveDoc(
    alias: string,
    input: Pick<Doc, "title" | "sourceUrl" | "markdown">,
    mode: Doc["mode"],
    id?: string,
    expected?: number,
  ) {
    return this.transact((d) => {
      const p =
        d.platforms.find(
          (p) => p.alias.toLowerCase() === alias.toLowerCase(),
        ) ??
        d.connections?.find(
          (c) => c.alias.toLowerCase() === alias.toLowerCase(),
        );
      if (!p) throw new AppError(404, "PLATFORM_NOT_FOUND", "平台不存在");
      assertDocumentMetadata(
        input,
        this.stateSecrets(d),
        d.platforms.flatMap((platform) =>
          platform.auth.type === "query" && platform.auth.name
            ? [platform.auth.name]
            : [],
        ),
      );
      const old = id
        ? d.docs.find((x) => x.id === id && x.alias === p.alias)
        : undefined;
      if (id && !old) throw new AppError(404, "DOC_NOT_FOUND", "文档不存在");
      if (old && expected !== old.revision)
        throw new AppError(409, "REVISION_CONFLICT", "文档已变化，请重新载入");
      const doc: Doc = {
        ...input,
        markdown: redact(input.markdown, this.stateSecrets(d)),
        id: old?.id ?? crypto.randomUUID(),
        alias: p.alias,
        mode,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        ...(old ? { previous: this.previousDocument(old) } : {}),
      };
      if (old) d.docs = d.docs.map((x) => (x === old ? doc : x));
      else d.docs.push(doc);
      if (p.learnedDocId === doc.id) {
        // A human edit is part of the learned context's optimistic revision.
        // In-flight learning based on the previous manual must not overwrite it.
        p.revision++;
        p.updatedAt = doc.updatedAt;
      }
      return doc;
    });
  }
  async removeDoc(id: string, revision: number) {
    return this.transact((d) => {
      const doc = d.docs.find((d) => d.id === id);
      if (!doc) throw new AppError(404, "DOC_NOT_FOUND", "文档不存在");
      if (doc.revision !== revision)
        throw new AppError(409, "REVISION_CONFLICT", "文档版本冲突");
      d.docs = d.docs.filter((d) => d.id !== id);
      const owner = [...d.platforms, ...(d.connections ?? [])].find(
        (item) => item.alias === doc.alias && item.learnedDocId === id,
      );
      if (owner) {
        owner.revision++;
        owner.updatedAt = new Date().toISOString();
      }
    });
  }
}
