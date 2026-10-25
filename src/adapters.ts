import type { Platform, Secret } from "./schema.js";
import { AppError } from "./schema.js";
export type AuthContext = {
  platform: Platform;
  secret: Secret;
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
};
// Trusted server extension point. Never loads modules/commands supplied in a call or document.
export interface AuthAdapter {
  name: string;
  protectedHeaders: string[];
  protectedQuery: string[];
  apply(ctx: AuthContext): void | Promise<void>;
}
export const adapters = new Map<string, AuthAdapter>();
export function registerAdapter(adapter: AuthAdapter) {
  if (adapters.has(adapter.name)) throw new Error("重复适配器");
  adapters.set(adapter.name, adapter);
}
export function adapterFor(p: Platform) {
  if (p.auth.type !== "adapter") return undefined;
  const a = adapters.get(p.auth.adapter!);
  if (!a)
    throw new AppError(
      422,
      "ADAPTER_UNAVAILABLE",
      "该适配器尚未实现/安装；不会伪装为已支持",
    );
  return a;
}
export async function inject(ctx: AuthContext) {
  const { platform: p, secret: s, headers, url } = ctx;
  switch (p.auth.type) {
    case "none":
      return;
    case "bearer":
      if (!s.value) break;
      headers.authorization = `Bearer ${s.value}`;
      return;
    case "header":
      if (!s.value) break;
      headers[p.auth.name!.toLowerCase()] = s.value;
      return;
    case "query":
      if (!s.value) break;
      url.searchParams.set(p.auth.name!, s.value);
      return;
    case "basic":
      if (s.username === undefined || s.password === undefined) break;
      headers.authorization = `Basic ${Buffer.from(`${s.username}:${s.password}`).toString("base64")}`;
      return;
    case "adapter":
      await adapterFor(p)!.apply(ctx);
      return;
  }
  throw new AppError(
    422,
    "SECRET_NOT_CONFIGURED",
    "该平台尚未由管理员配置鉴权",
  );
}
