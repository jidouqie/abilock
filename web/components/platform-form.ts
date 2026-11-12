type Rule = { method: string; path: string };
type CapabilityNote = {
  name: string;
  summary: string;
  tags: string[];
  input: string;
  output: string;
  method?: string;
  path?: string;
};
export type Platform = {
  alias: string;
  note?: string;
  name: string;
  baseUrl: string;
  description: string;
  documentationUrl?: string | null;
  learnedDocumentationUrl?: string | null;
  capabilityNotes?: CapabilityNote[];
  chat?: { method: "POST"; path: string; model: string } | null;
  auth: { type: string; name?: string; adapter?: string };
  rules: Rule[];
  enabled: boolean;
  allowInsecureLocal: boolean;
  hasSecret?: boolean;
  revision?: number;
  updatedAt?: string;
};

export const blankPlatform: Platform = {
  alias: "",
  note: "",
  name: "",
  baseUrl: "",
  description: "",
  auth: { type: "bearer" },
  rules: [],
  enabled: true,
  allowInsecureLocal: false,
};

export function authIdentity(auth: Platform["auth"]) {
  return JSON.stringify([
    auth.type,
    auth.name?.trim() ?? "",
    auth.adapter ?? "",
  ]);
}

// Send only writable fields. Public read metadata and learned document IDs are
// never part of an authenticated connection write.
export function platformWrite(
  edit: Platform,
  original: Platform | null,
  credentials: { secret?: string; username?: string } = {},
) {
  const secret = credentials.secret ?? "";
  const username = credentials.username ?? "";
  const authChanged =
    !!original && authIdentity(edit.auth) !== authIdentity(original.auth);
  const fixedChanged =
    !!original && (edit.baseUrl.trim() !== original.baseUrl || authChanged);
  // An API may be saved before its credential is supplied. Changing an
  // existing authentication identity still requires a complete replacement.
  const secretRequired = edit.auth.type !== "none" && authChanged;
  if (secretRequired && !secret) throw new Error("请填写密钥");
  if (edit.auth.type === "basic" && username && !secret)
    throw new Error("请填写密码");
  if (edit.auth.type === "basic" && secret && !username)
    throw new Error("请填写账号");
  const auth: Platform["auth"] = {
    type: edit.auth.type,
    ...(["header", "query"].includes(edit.auth.type)
      ? { name: edit.auth.name?.trim() }
      : {}),
    ...(edit.auth.type === "adapter" ? { adapter: edit.auth.adapter } : {}),
  };
  const platform = {
    alias: edit.alias.trim(),
    note: edit.note?.trim() ?? "",
    name: original?.name ?? edit.alias.trim(),
    baseUrl: edit.baseUrl.trim(),
    documentationUrl: edit.documentationUrl?.trim() || null,
    auth,
    enabled: edit.enabled,
    allowInsecureLocal: edit.allowInsecureLocal,
    description: fixedChanged ? "" : edit.description,
    rules: fixedChanged ? [] : edit.rules,
    capabilityNotes: fixedChanged ? [] : (edit.capabilityNotes ?? []),
    chat: fixedChanged ? null : (edit.chat ?? null),
  };
  return {
    platform,
    expectedRevision: original?.revision ?? 0,
    ...(secret
      ? {
          secret:
            edit.auth.type === "basic"
              ? { username, password: secret }
              : { value: secret },
        }
      : {}),
    clearSecret: edit.auth.type === "none" && !!original?.hasSecret,
  };
}
