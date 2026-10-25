import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { AppError } from "./schema.js";
import { constantEqual } from "./security.js";
import { validPasswordLength } from "./password-policy.js";
import { syncDirectory } from "./platform-files.js";

const profile = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const cookieName = "abilock_admin_session";
type RecordData = {
  version: 1;
  algorithm: "scrypt";
  salt: string;
  hash: string;
};
type Session = { csrfToken: string; expires: number; idle: number };
function password(value: unknown): string {
  if (
    !validPasswordLength(value)
  )
    throw new AppError(
      400,
      "PASSWORD_LENGTH",
      "密码须为 8–256 个字符，不限制字符组合",
    );
  return value;
}
async function derive(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      value,
      Buffer.from(salt, "hex"),
      64,
      profile,
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}
export class AdminAuth {
  private record?: RecordData;
  private legacy?: string;
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { at: number; count: number }>();
  private global = { at: 0, count: 0 };
  private hashing = 0;
  private changing = false;
  readonly file: string;
  readonly marker: string;
  constructor(
    dir: string,
    legacy?: string,
    private executionToken = "",
  ) {
    this.file = path.join(dir, "admin-auth.json");
    this.marker = path.join(dir, "admin-auth.v2");
    this.legacy = legacy;
  }
  async init() {
    try {
      const input = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (
        input.version !== 1 ||
        input.algorithm !== "scrypt" ||
        !/^[a-f0-9]{64}$/.test(input.salt) ||
        !/^[a-f0-9]{128}$/.test(input.hash)
      )
        throw new Error("invalid auth record");
      this.record = input;
      await this.disableLegacy();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "管理密码记录不可读取或已损坏；请按恢复指引处理，不会自动重置",
        );
      try {
        await fs.access(this.marker);
        this.legacy = undefined;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  private async syncDirectory() {
    await syncDirectory(path.dirname(this.file));
  }
  private async disableLegacy() {
    try {
      const marker = await fs.open(this.marker, "wx", 0o600);
      try {
        await marker.writeFile("password-management-v2\n");
        await marker.sync();
      } finally {
        await marker.close();
      }
      await this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.legacy = undefined;
  }
  private session(req: http.IncomingMessage) {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    const key = crypto.createHash("sha256").update(token).digest("hex");
    const session = this.sessions.get(key);
    if (session && session.expires > Date.now() && session.idle > Date.now()) {
      // Unattended page polling must not keep an idle session alive forever.
      if (req.headers["x-abilock-background"] !== "1")
        session.idle = Date.now() + 60 * 60 * 1000;
      return session;
    }
    this.sessions.delete(key);
  }
  status(req: http.IncomingMessage) {
    const session = this.session(req);
    return {
      initialized: !!this.record,
      legacy: !!this.legacy,
      authenticated: !!session,
      ...(session ? { csrfToken: session.csrfToken } : {}),
    };
  }
  authenticate(req: http.IncomingMessage, mutate: boolean) {
    const session = this.session(req);
    if (session) {
      if (
        mutate &&
        !constantEqual(
          (req.headers["x-abilock-csrf"] as string) ?? "",
          session.csrfToken,
        )
      )
        throw new AppError(403, "CSRF_REJECTED", "会话校验失败，请刷新管理页");
      return;
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (this.legacy && constantEqual(token, this.legacy)) return;
    throw new AppError(401, "UNAUTHORIZED", "管理会话无效，请登录");
  }
  requireUi(req: http.IncomingMessage, local = false) {
    const host = req.headers.host ?? "";
    const port = req.socket.localPort;
    if (
      req.headers.origin !== `http://${host}` ||
      req.headers["x-abilock-ui"] !== "1" ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new AppError(403, "UI_REQUIRED", "请在同源管理页面操作");
    if (req.headers.authorization)
      throw new AppError(403, "UI_REQUIRED", "此入口仅接受管理页面会话");
    if (
      local &&
      (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        ))
    )
      throw new AppError(
        403,
        "LOCAL_SETUP_REQUIRED",
        "首次设置或恢复密码须从本机管理页面操作",
      );
  }
  private attempt(req: http.IncomingMessage) {
    const key = req.socket.remoteAddress ?? "unknown",
      now = Date.now();
    for (const [key, failure] of this.failures)
      if (now - failure.at >= 60000) this.failures.delete(key);
    const failure = this.failures.get(key);
    if (failure && failure.count >= 5)
      throw new AppError(
        429,
        "LOGIN_RATE_LIMIT",
        "登录尝试过多，请一分钟后重试",
      );
    if (now - this.global.at >= 60000) this.global = { at: now, count: 0 };
    if (++this.global.count > 30 || this.failures.size >= 1000)
      throw new AppError(429, "LOGIN_RATE_LIMIT", "登录尝试过多，请稍后重试");
    return key;
  }
  private failed(key: string) {
    const failure = this.failures.get(key) ?? { at: Date.now(), count: 0 };
    failure.count++;
    this.failures.set(key, failure);
  }
  private async hash(value: string, salt: string) {
    if (this.hashing >= 2)
      throw new AppError(429, "AUTH_BUSY", "密码校验繁忙，请稍后重试");
    this.hashing++;
    try {
      return await derive(value, salt);
    } finally {
      this.hashing--;
    }
  }
  private issue(res: http.ServerResponse) {
    const token = crypto.randomBytes(32).toString("hex"),
      csrfToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    for (const [key, session] of this.sessions)
      if (session.expires <= now || session.idle <= now)
        this.sessions.delete(key);
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(crypto.createHash("sha256").update(token).digest("hex"), {
      csrfToken,
      expires: now + 8 * 3600000,
      idle: now + 3600000,
    });
    res.setHeader(
      "set-cookie",
      `${cookieName}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800`,
    );
    return { csrfToken };
  }
  private async save(value: string, create: boolean) {
    if (this.executionToken && constantEqual(value, this.executionToken))
      throw new AppError(
        400,
        "PASSWORD_ROLE_CONFLICT",
        "管理密码须与执行凭据不同",
      );
    const salt = crypto.randomBytes(32).toString("hex");
    const record: RecordData = {
      version: 1,
      algorithm: "scrypt",
      salt,
      hash: (await this.hash(value, salt)).toString("hex"),
    };
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    const file = await fs.open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } catch {
      await fs.unlink(temp).catch(() => {});
      throw new AppError(
        503,
        "AUTH_WRITE_FAILED",
        "密码未能保存，请检查数据目录后重试",
      );
    } finally {
      await file.close();
    }
    try {
      // Persist the no-secret migration marker first: a crash cannot re-enable a legacy token.
      await this.disableLegacy();
      if (create) await fs.link(temp, this.file);
      else await fs.rename(temp, this.file);
      await this.syncDirectory();
      this.record = record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new AppError(
          409,
          "ALREADY_INITIALIZED",
          "管理密码已设置，请登录",
        );
      throw new AppError(
        503,
        "AUTH_WRITE_FAILED",
        "密码未能保存，请检查数据目录后重试",
      );
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  async setup(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    input: { password?: unknown; confirmPassword?: unknown },
  ) {
    if (this.record || this.changing)
      throw new AppError(
        409,
        "ALREADY_INITIALIZED",
        "管理密码已设置或正在设置",
      );
    this.requireUi(req, true);
    if (this.legacy) {
      if (!this.session(req))
        throw new AppError(401, "UNAUTHORIZED", "请先登录现有管理入口");
      this.authenticate(req, true);
    }
    this.attempt(req);
    const value = password(input.password);
    if (value !== input.confirmPassword)
      throw new AppError(400, "PASSWORD_CONFIRM", "两次输入的密码不一致");
    this.changing = true;
    try {
      await this.save(value, true);
      this.sessions.clear();
      return this.issue(res);
    } finally {
      this.changing = false;
    }
  }
  async login(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    input: { password?: unknown },
  ) {
    this.requireUi(req);
    const key = this.attempt(req);
    const value =
      typeof input.password === "string" &&
      (!this.record || [...input.password].length <= 256)
        ? input.password
        : "";
    const valid = this.record
      ? constantEqual(
          (await this.hash(value, this.record.salt)).toString("hex"),
          this.record.hash,
        )
      : !!this.legacy && constantEqual(value, this.legacy);
    if (!valid || constantEqual(value, this.executionToken)) {
      this.failed(key);
      throw new AppError(401, "UNAUTHORIZED", "密码无效");
    }
    this.failures.delete(key);
    return this.issue(res);
  }
  logout(req: http.IncomingMessage, res: http.ServerResponse) {
    this.requireUi(req);
    const session = this.session(req);
    if (!session)
      throw new AppError(401, "UNAUTHORIZED", "管理会话无效，请登录");
    this.authenticate(req, true);
    for (const [key, value] of this.sessions)
      if (value === session) this.sessions.delete(key);
    res.setHeader(
      "set-cookie",
      `${cookieName}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return { ok: true };
  }
  async change(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    input: {
      currentPassword?: unknown;
      password?: unknown;
      confirmPassword?: unknown;
    },
  ) {
    this.requireUi(req);
    if (!this.session(req))
      throw new AppError(401, "UNAUTHORIZED", "管理会话无效，请登录");
    this.authenticate(req, true);
    const key = this.attempt(req);
    if (!this.record)
      throw new AppError(409, "NOT_INITIALIZED", "请先设置管理密码");
    if (this.changing)
      throw new AppError(409, "AUTH_CONFLICT", "密码正在更改，请稍后重试");
    this.changing = true;
    try {
      const current =
        typeof input.currentPassword === "string" &&
        [...input.currentPassword].length <= 256
          ? input.currentPassword
          : "";
      if (
        !constantEqual(
          (await this.hash(current, this.record.salt)).toString("hex"),
          this.record.hash,
        )
      ) {
        this.failed(key);
        throw new AppError(401, "UNAUTHORIZED", "密码无效");
      }
      const value = password(input.password);
      if (value !== input.confirmPassword)
        throw new AppError(400, "PASSWORD_CONFIRM", "两次输入的密码不一致");
      await this.save(value, false);
      this.sessions.clear();
      this.failures.delete(key);
      return this.issue(res);
    } finally {
      this.changing = false;
    }
  }
}
