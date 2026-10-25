import { useState } from "react";
import type { ConnectionKind } from "../../src/protocol-kinds.js";

export type { ConnectionKind };
export type Connection = {
  alias: string;
  note?: string;
  name: string;
  kind: ConnectionKind;
  enabled: boolean;
  description: string;
  documentationUrl?: string | null;
  learnedDocumentationUrl?: string | null;
  config: Record<string, unknown>;
  trustBoundary?: "independent-target" | "development-fixture";
  hasSecret?: boolean;
  revision?: number;
  capabilityNotes?: {
    name: string;
    summary: string;
    tags: string[];
    input: string;
    output: string;
    method?: string;
    path?: string;
  }[];
};
export const connectionLabels: Record<ConnectionKind, string> = {
  ssh: "SSH",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  git: "Git",
  s3: "S3 / OSS / R2",
  aws: "AWS",
  docker: "Docker",
  registry: "Registry",
  kubernetes: "Kubernetes",
};
export const categoryLabels = [
  "全部",
  "API",
  "SSH",
  "数据库",
  "存储",
  "云",
  "其他",
] as const;
export type Category = (typeof categoryLabels)[number];
// Namespaced Kubernetes resources the service allows when a stored connection
// has no explicit list. New connections start without Secret access; an
// administrator can still select it explicitly.
const kubernetesNamespaced = [
  "pods",
  "services",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "serviceaccounts",
  "events",
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
  "cronjobs",
  "ingresses",
  "networkpolicies",
];
export const newKubernetesResources = kubernetesNamespaced.filter(
  (resource) => resource !== "secrets",
);
export function category(kind: ConnectionKind | "api"): Category {
  if (kind === "api") return "API";
  if (kind === "ssh") return "SSH";
  if (["postgres", "mysql", "redis"].includes(kind)) return "数据库";
  if (kind === "s3") return "存储";
  if (kind === "aws") return "云";
  return "其他";
}
const defaults: Record<ConnectionKind, Record<string, unknown>> = {
  ssh: {
    host: "",
    port: 22,
    username: "",
    remoteRoot: "/",
    fileAccess: "read",
    allowShell: true,
  },
  postgres: { host: "", port: 5432, user: "", database: "", tls: true },
  mysql: { host: "", port: 3306, user: "", database: "", tls: true },
  redis: { host: "", port: 6379, database: 0, tls: true },
  git: { transport: "https", url: "", authType: "basic" },
  s3: {
    provider: "s3",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "",
  },
  aws: {
    region: "us-east-1",
    allowedServices: ["sts", "ec2"],
    endpoints: {},
    prefix: "",
  },
  docker: {
    endpoint: "",
    auth: "mtls",
    apiVersion: "v1.47",
    trustedPrivate: false,
  },
  kubernetes: {
    endpoint: "",
    auth: "bearer",
    namespace: "default",
    trustedPrivate: false,
    resources: newKubernetesResources,
  },
  registry: { endpoint: "", authType: "basic", allowedRepositories: [] },
};
export function blankConnection(kind: ConnectionKind): Connection {
  return {
    alias: "",
    note: "",
    name: "",
    kind,
    enabled: true,
    description: "",
    documentationUrl: null,
    config: structuredClone(defaults[kind]),
  };
}
export function address(connection: Connection) {
  for (const key of ["endpoint", "url", "host"]) {
    const value = connection.config[key];
    if (typeof value === "string")
      return key === "host" && connection.config.port
        ? `${value}:${connection.config.port}`
        : value;
  }
  return typeof connection.config.region === "string"
    ? connection.config.region
    : "—";
}
export function needsCredential(connection: Connection) {
  if (["mysql", "redis"].includes(connection.kind)) return false;
  return (connection.config.auth ?? connection.config.authType) !== "none";
}
function authMethod(connection: Connection) {
  return String(
    connection.config.auth ??
      connection.config.authType ??
      (connection.kind === "git" || connection.kind === "registry"
        ? "basic"
        : connection.kind === "docker"
          ? "mtls"
          : connection.kind === "kubernetes"
            ? "bearer"
            : ""),
  );
}
type SecretField = {
  key: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
};
export function credentialFields(
  connection: Connection,
  sshIdentity: string,
): SecretField[] {
  const auth = authMethod(connection);
  if (auth === "none") return [];
  if (
    connection.kind === "ssh" ||
    (connection.kind === "git" && connection.config.transport === "ssh")
  ) {
    if (sshIdentity === "keep") return [];
    return sshIdentity === "password"
      ? [{ key: "password", label: "密码", required: true }]
      : [
          { key: "privateKey", label: "私钥", required: true, multiline: true },
          { key: "passphrase", label: "口令" },
        ];
  }
  if (["postgres", "mysql", "redis"].includes(connection.kind))
    return [{ key: "password", label: "密码" }];
  if (["s3", "aws"].includes(connection.kind))
    return [
      { key: "accessKeyId", label: "ID", required: true },
      { key: "secretAccessKey", label: "密钥", required: true },
      { key: "sessionToken", label: "令牌" },
    ];
  if (auth === "bearer")
    return [
      { key: "token", label: "Token", required: true },
      ...(connection.kind === "kubernetes"
        ? [{ key: "ca", label: "CA", multiline: true }]
        : []),
    ];
  if (auth === "basic")
    return [
      { key: "username", label: "账号", required: true },
      { key: "password", label: "密码", required: true },
      ...(connection.kind === "docker"
        ? [{ key: "ca", label: "CA", multiline: true }]
        : []),
    ];
  if (auth === "mtls")
    return [
      { key: "cert", label: "证书", multiline: true, required: true },
      { key: "key", label: "私钥", multiline: true, required: true },
      { key: "ca", label: "CA", multiline: true },
      { key: "passphrase", label: "口令" },
    ];
  return [];
}
export function validateCredentials(
  connection: Connection,
  secrets: Record<string, string>,
  sshIdentity: string,
  original?: Connection | null,
) {
  const authChanged =
    !!original && authMethod(connection) !== authMethod(original);
  const transportChanged =
    !!original && connection.config.transport !== original.config.transport;
  const ssh =
    connection.kind === "ssh" ||
    (connection.kind === "git" && connection.config.transport === "ssh");
  const replacing =
    Object.values(secrets).some(Boolean) ||
    !connection.hasSecret ||
    authChanged ||
    transportChanged ||
    (ssh && sshIdentity !== "keep");
  if (
    ssh &&
    sshIdentity === "keep" &&
    (!connection.hasSecret || transportChanged)
  )
    throw new Error("请选择密码或私钥");
  if (!replacing) return;
  for (const field of credentialFields(connection, sshIdentity))
    if (field.required && !secrets[field.key])
      throw new Error(`请填写${field.label}`);
}
export function connectionWrite(
  connection: Connection,
  original: Connection | null,
  secrets: Record<string, string>,
  sshIdentity: string,
) {
  validateCredentials(connection, secrets, sshIdentity, original);
  if (!connection.alias.trim()) throw new Error("请填写别名");
  if (
    connection.kind === "aws" &&
    (!Array.isArray(connection.config.allowedServices) ||
      !connection.config.allowedServices.length)
  )
    throw new Error("请选择服务");
  const fields = credentialFields(connection, sshIdentity);
  const credentials = Object.fromEntries(
    fields
      .filter((field) => secrets[field.key])
      .map((field) => [field.key, secrets[field.key]]),
  );
  const clearSecret =
    authMethod(connection) === "none" && !!original?.hasSecret;
  return {
    connection: {
      alias: connection.alias.trim(),
      note: connection.note?.trim() ?? "",
      name: original?.name ?? connection.alias.trim(),
      kind: connection.kind,
      enabled: connection.enabled,
      description: connection.description,
      documentationUrl: connection.documentationUrl?.trim() || null,
      config: connection.config,
      ...(connection.trustBoundary
        ? { trustBoundary: connection.trustBoundary }
        : {}),
      ...(connection.capabilityNotes
        ? { capabilityNotes: connection.capabilityNotes }
        : {}),
    },
    expectedRevision: original?.revision ?? 0,
    ...(Object.keys(credentials).length ? { secret: credentials } : {}),
    clearSecret,
  };
}
export function ConnectionFields({
  connection,
  onChange,
  identity,
  onIdentityChange,
}: {
  connection: Connection;
  onChange: (connection: Connection) => void;
  identity: string;
  onIdentityChange: (identity: string) => void;
}) {
  const config = connection.config;
  const change = (key: string, value: unknown) => {
    const next = { ...config };
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...connection, config: next });
  };
  const text = (
    key: string,
    label: string,
    options: {
      required?: boolean;
      placeholder?: string;
      type?: string;
      maxLength?: number;
    } = {},
  ) => (
    <label key={key}>
      {label}
      <input
        type={options.type ?? "text"}
        value={typeof config[key] === "string" ? (config[key] as string) : ""}
        required={options.required}
        maxLength={options.maxLength ?? 1000}
        placeholder={options.placeholder}
        onChange={(event) => change(key, event.target.value)}
      />
    </label>
  );
  const number = (key: string, label: string, max = 65535, min = 1) => (
    <label key={key}>
      {label}
      <input
        type="number"
        value={typeof config[key] === "number" ? (config[key] as number) : ""}
        min={min}
        max={max}
        required
        onChange={(event) =>
          change(
            key,
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
      />
    </label>
  );
  const select = (
    key: string,
    label: string,
    choices: [string, string][],
    fallback: string,
    callback?: (value: string) => void,
  ) => (
    <label key={key}>
      {label}
      <select
        aria-label={label}
        value={String(config[key] ?? fallback)}
        onChange={(event) =>
          callback
            ? callback(event.target.value)
            : change(key, event.target.value)
        }
      >
        {choices.map(([value, title]) => (
          <option value={value} key={value}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
  const check = (key: string, label: string, fallback = false) => (
    <label key={key} className="check">
      <input
        type="checkbox"
        checked={
          typeof config[key] === "boolean" ? (config[key] as boolean) : fallback
        }
        onChange={(event) => change(key, event.target.checked)}
      />
      {label}
    </label>
  );
  const list = (
    key: string,
    label: string,
    required = false,
    placeholder?: string,
  ) => (
    <ArrayField
      key={`${connection.kind}:${key}`}
      label={label}
      value={Array.isArray(config[key]) ? (config[key] as string[]) : []}
      placeholder={placeholder}
      required={required}
      onChange={(value) => change(key, value.length ? value : undefined)}
    />
  );
  const choices = (
    key: string,
    label: string,
    values: string[],
    fallback: string[],
  ) => (
    <label key={key}>
      {label}
      <select
        aria-label={label}
        multiple
        size={Math.min(values.length, 6)}
        value={
          Array.isArray(config[key]) ? (config[key] as string[]) : fallback
        }
        onChange={(event) =>
          change(
            key,
            Array.from(event.target.selectedOptions, (option) => option.value),
          )
        }
      >
        {values.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
  const objectCommands = [
    "list-objects-v2",
    "get-object",
    "put-object",
    "delete-object",
    "head-object",
    "copy-object",
    "move-object",
  ];
  const kubeNamespaced = kubernetesNamespaced;
  // Self-hosted S3-compatible services and registries on a private network:
  // explicit trust plus an optional public CA certificate.
  const privateServiceOptions = (
    <>
      {check("trustedPrivate", "内网连接")}
      <label>
        CA
        <textarea
          value={String(config.ca ?? "")}
          rows={3}
          maxLength={100000}
          placeholder="可选，自建服务的 CA 证书"
          onChange={(event) => change("ca", event.target.value)}
        />
      </label>
    </>
  );
  const sshIdentity = (
    <label>
      鉴权
      <select
        aria-label="鉴权"
        value={identity}
        onChange={(event) => onIdentityChange(event.target.value)}
      >
        {connection.hasSecret && <option value="keep">保留</option>}
        <option value="password">密码</option>
        <option value="privateKey">私钥</option>
      </select>
    </label>
  );
  const tlsOptions = (
    <>
      {check("tls", "TLS", true)}
      {text("serverName", "TLS 域名", { placeholder: "可选" })}
      <label>
        CA
        <textarea
          value={String(config.ca ?? "")}
          rows={3}
          maxLength={100000}
          onChange={(event) => change("ca", event.target.value)}
        />
      </label>
    </>
  );
  if (connection.kind === "ssh")
    return (
      <>
        {text("host", "主机", {
          required: true,
          placeholder: "ssh.example.com",
        })}
        <div className="field-row">
          {number("port", "端口")}
          {text("username", "账号", { required: true, maxLength: 128 })}
        </div>
        {sshIdentity}
        <label>
          测试用主机指纹
          <input
            value={String(config.hostKeySHA256 ?? "")}
            maxLength={60}
            placeholder="SHA256:…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => change("hostKeySHA256", event.target.value.trim())}
          />
          <small className="field-note">连接测试必填。请从服务器管理员等可信渠道取得；不会自动信任未知或变化的主机。</small>
        </label>
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {text("remoteRoot", "目录", { required: true })}
            {select(
              "fileAccess",
              "文件",
              [
                ["read", "只读"],
                ["readwrite", "读写"],
              ],
              "read",
            )}
            {check("allowShell", "执行命令", true)}
          </div>
        </details>
      </>
    );
  if (["postgres", "mysql", "redis"].includes(connection.kind))
    return (
      <>
        {text("host", "主机", {
          required: true,
          placeholder: "db.example.com",
        })}
        <div className="field-row">
          {number("port", "端口")}
          {connection.kind === "redis"
            ? number("database", "数据库", 2147483647, 0)
            : text("database", "数据库", { required: true, maxLength: 128 })}
        </div>
        {connection.kind === "redis"
          ? text("username", "账号", { placeholder: "可选", maxLength: 128 })
          : text("user", "账号", { required: true, maxLength: 128 })}
        <details>
          <summary>选项</summary>
          <div className="option-fields">{tlsOptions}</div>
        </details>
      </>
    );
  if (connection.kind === "git") {
    const ssh = config.transport === "ssh";
    return (
      <>
        {select(
          "transport",
          "连接",
          [
            ["https", "HTTPS"],
            ["ssh", "SSH"],
          ],
          "https",
          (value) => {
            onChange({
              ...connection,
              config:
                value === "ssh"
                  ? {
                      transport: "ssh",
                      host: "",
                      port: 22,
                      username: "git",
                      path: "",
                      hostKeySha256: "",
                      ...(config.authorName
                        ? { authorName: config.authorName }
                        : {}),
                      ...(config.authorEmail
                        ? { authorEmail: config.authorEmail }
                        : {}),
                    }
                  : {
                      transport: "https",
                      url: "",
                      authType: "basic",
                      ...(config.authorName
                        ? { authorName: config.authorName }
                        : {}),
                      ...(config.authorEmail
                        ? { authorEmail: config.authorEmail }
                        : {}),
                    },
            });
            onIdentityChange("password");
          },
        )}
        {ssh ? (
          <>
            {text("host", "主机", { required: true })}
            <div className="field-row">
              {number("port", "端口")}
              {text("username", "账号", { required: true })}
            </div>
            {text("path", "仓库", {
              required: true,
              placeholder: "org/repo.git",
            })}
            {text("hostKeySha256", "主机指纹", {
              required: true,
              placeholder: "SHA256:…",
            })}
            {sshIdentity}
          </>
        ) : (
          <>
            {text("url", "仓库", {
              required: true,
              type: "url",
              placeholder: "https://git.example.com/org/repo.git",
            })}
            {select(
              "authType",
              "鉴权",
              [
                ["basic", "Basic"],
                ["bearer", "Bearer"],
                ["none", "无"],
              ],
              "basic",
            )}
            {config.authType === "bearer" &&
              text("identity", "身份", {
                required: true,
                placeholder: "固定账号或组织",
              })}
          </>
        )}
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {text("authorName", "作者", {
              placeholder: "Abilock",
              maxLength: 100,
            })}
            {text("authorEmail", "邮箱", {
              type: "email",
              placeholder: "abilock@localhost.invalid",
              maxLength: 200,
            })}
            {!ssh && (
              <label>
                CA
                <textarea
                  value={String(config.ca ?? "")}
                  rows={3}
                  maxLength={200000}
                  onChange={(event) => change("ca", event.target.value)}
                />
              </label>
            )}
          </div>
        </details>
      </>
    );
  }
  if (connection.kind === "s3")
    return (
      <>
        {select(
          "provider",
          "平台",
          [
            ["s3", "S3"],
            ["oss", "OSS"],
            ["r2", "R2"],
          ],
          "s3",
          (value) =>
            onChange({
              ...connection,
              config: {
                // Private-network trust and a custom CA apply only to self-hosted S3.
                ...Object.fromEntries(
                  Object.entries(config).filter(
                    ([key]) => value === "s3" || !["trustedPrivate", "ca"].includes(key),
                  ),
                ),
                provider: value,
                region:
                  value === "r2"
                    ? "auto"
                    : config.region === "auto"
                      ? "us-east-1"
                      : (config.region ?? "us-east-1"),
              },
            }),
        )}
        {text("endpoint", "地址", {
          required: true,
          type: "url",
          placeholder: "https://s3.us-east-1.amazonaws.com",
        })}
        <div className="field-row">
          {text("region", "区域", { required: true })}
          {text("bucket", "桶", { required: true })}
        </div>
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {text("prefix", "目录", { placeholder: "可选，以 / 结尾" })}
            {choices("allowedCommands", "命令", objectCommands, objectCommands)}
            {(config.provider ?? "s3") === "s3" && privateServiceOptions}
          </div>
        </details>
      </>
    );
  if (connection.kind === "aws") {
    const endpoints = config.endpoints as Record<string, string> | undefined;
    const services = Array.isArray(config.allowedServices)
      ? (config.allowedServices as string[])
      : [];
    return (
      <>
        {text("region", "区域", { required: true })}
        <div className="services-field">
          <span>服务</span>
          {[
            ["sts", "STS"],
            ["ec2", "EC2"],
            ["s3api", "S3"],
          ].map(([value, label]) => (
            <label className="check" key={value}>
              <input
                type="checkbox"
                checked={services.includes(value)}
                onChange={(event) =>
                  change(
                    "allowedServices",
                    event.target.checked
                      ? [...services, value]
                      : services.filter((item) => item !== value),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
        {services.includes("s3api") && text("bucket", "桶", { required: true })}
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {services.map((service) => (
              <label key={service}>
                {service.toUpperCase()} 地址
                <input
                  type="url"
                  value={endpoints?.[service] ?? ""}
                  placeholder="官方地址"
                  maxLength={1000}
                  onChange={(event) => {
                    const next = { ...endpoints };
                    if (event.target.value) next[service] = event.target.value;
                    else delete next[service];
                    change("endpoints", next);
                  }}
                />
              </label>
            ))}
            {services.includes("s3api") &&
              text("prefix", "目录", { placeholder: "可选，以 / 结尾" })}
            {services.includes("s3api") &&
              choices(
                "allowedCommands",
                "S3 命令",
                objectCommands,
                objectCommands,
              )}
          </div>
        </details>
      </>
    );
  }
  if (connection.kind === "registry")
    return (
      <>
        {text("endpoint", "地址", {
          required: true,
          type: "url",
          placeholder: "https://registry.example.com",
        })}
        {select(
          "authType",
          "鉴权",
          [
            ["basic", "Basic"],
            ["bearer", "Bearer"],
            ["none", "无"],
          ],
          "basic",
        )}
        {list("allowedRepositories", "仓库", true, "org/image，多个用逗号分隔")}
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {choices(
              "allowedCommands",
              "命令",
              [
                "ping",
                "catalog",
                "tags",
                "manifest-get",
                "manifest-head",
                "manifest-put",
                "manifest-delete",
                "blob-get",
                "blob-head",
                "blob-put",
                "blob-delete",
              ],
              [
                "ping",
                "catalog",
                "tags",
                "manifest-get",
                "manifest-head",
                "manifest-put",
                "manifest-delete",
                "blob-get",
                "blob-head",
                "blob-put",
                "blob-delete",
              ],
            )}
            {privateServiceOptions}
          </div>
        </details>
      </>
    );
  if (connection.kind === "docker")
    return (
      <>
        {text("endpoint", "地址", {
          required: true,
          type: "url",
          placeholder: "https://docker.example.com:2376",
        })}
        {select(
          "auth",
          "鉴权",
          [
            ["mtls", "mTLS"],
            ["basic", "Basic"],
            ["none", "无"],
          ],
          "mtls",
        )}
        <details>
          <summary>选项</summary>
          <div className="option-fields">
            {text("apiVersion", "API 版本", { placeholder: "v1.47" })}
            {check("trustedPrivate", "内网连接")}
          </div>
        </details>
      </>
    );
  return (
    <>
      {text("endpoint", "地址", {
        required: true,
        type: "url",
        placeholder: "https://cluster.example.com:6443",
      })}
      {select(
        "auth",
        "鉴权",
        [
          ["bearer", "Bearer"],
          ["mtls", "mTLS"],
        ],
        "bearer",
      )}
      {text("namespace", "命名空间", { required: true })}
      <details>
        <summary>选项</summary>
        <div className="option-fields">
          {list("namespaces", "命名空间范围", false, "可选，多个用逗号分隔")}
          {choices(
            "resources",
            "资源",
            [
              ...kubeNamespaced,
              "namespaces",
              "nodes",
              "persistentvolumes",
              "storageclasses",
            ],
            kubeNamespaced,
          )}
          {check("trustedPrivate", "内网连接")}
        </div>
      </details>
    </>
  );
}
function ArrayField({
  label,
  value,
  placeholder,
  required,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder?: string;
  required?: boolean;
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  return (
    <label>
      {label}
      <input
        value={draft}
        placeholder={placeholder}
        required={required}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value.split(/[\s,，]+/).filter(Boolean));
        }}
      />
    </label>
  );
}
