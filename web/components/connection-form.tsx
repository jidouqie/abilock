import { useState, type ReactNode } from "react";
import type { ConnectionKind } from "../../src/protocol-kinds.js";
import { FieldLabel } from "./field-label.js";

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
  note?: string;
  advanced?: boolean;
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
          {
            key: "passphrase",
            label: "私钥密码",
            advanced: true,
            note: "仅加密私钥需要填写。创建私钥时未设置密码，请留空。",
          },
        ];
  }
  if (["postgres", "mysql", "redis"].includes(connection.kind))
    return [
      {
        key: "password",
        label: "密码",
        ...(connection.kind === "postgres" ? { required: true } : {}),
      },
    ];
  if (["s3", "aws"].includes(connection.kind))
    return [
      { key: "accessKeyId", label: "Access Key ID", required: true },
      { key: "secretAccessKey", label: "Secret Access Key", required: true },
      {
        key: "sessionToken",
        label: "临时会话令牌",
        advanced: true,
        note: "仅使用临时访问凭据时填写 Session Token。",
      },
    ];
  if (auth === "bearer")
    return [
      { key: "token", label: "Token", required: true },
      ...(connection.kind === "kubernetes"
        ? [
            {
              key: "ca",
              label: "CA 证书",
              multiline: true,
              advanced: true,
              note: "仅使用自签名证书或私有 CA 的服务需要填写 PEM 证书。",
            },
          ]
        : []),
    ];
  if (auth === "basic")
    return [
      { key: "username", label: "账号", required: true },
      { key: "password", label: "密码", required: true },
      ...(connection.kind === "docker"
        ? [
            {
              key: "ca",
              label: "CA 证书",
              multiline: true,
              advanced: true,
              note: "仅使用自签名证书或私有 CA 的服务需要填写 PEM 证书。",
            },
          ]
        : []),
    ];
  if (auth === "mtls")
    return [
      { key: "cert", label: "客户端证书", multiline: true, required: true },
      { key: "key", label: "私钥", multiline: true, required: true },
      {
        key: "ca",
        label: "CA 证书",
        multiline: true,
        advanced: true,
        note: "仅使用自签名证书或私有 CA 的服务需要填写 PEM 证书。",
      },
      {
        key: "passphrase",
        label: "私钥密码",
        advanced: true,
        note: "仅加密私钥需要填写。创建私钥时未设置密码，请留空。",
      },
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
function isIpTarget(host: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host))
    return host
      .split(".")
      .every((part) => Number(part) <= 255 && String(Number(part)) === part);
  const [address, zone, ...extra] = host.split("%");
  if (
    !address.includes(":") ||
    !/^[0-9a-fA-F:.]+$/.test(address) ||
    extra.length ||
    (zone !== undefined && !/^[0-9a-zA-Z.:-]+$/.test(zone))
  )
    return false;
  try {
    return new URL(`http://[${address}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

export function ConnectionFields({
  connection,
  onChange,
  identity,
  onIdentityChange,
  section = "all",
}: {
  connection: Connection;
  onChange: (connection: Connection) => void;
  identity: string;
  onIdentityChange: (identity: string) => void;
  section?: "basic" | "advanced" | "all";
}) {
  const config = connection.config;
  const renderFields = (basic: ReactNode, advanced: ReactNode) => {
    if (section === "basic") return basic;
    if (section === "advanced") return advanced;
    return (
      <>
        {basic}
        <details>
          <summary>更多选项</summary>
          <div className="option-fields">{advanced}</div>
        </details>
      </>
    );
  };
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
      note?: string;
    } = {},
  ) => (
    <label key={key}>
      <FieldLabel required={options.required}>{label}</FieldLabel>
      <input
        aria-label={label}
        type={options.type ?? "text"}
        value={typeof config[key] === "string" ? (config[key] as string) : ""}
        required={options.required}
        maxLength={options.maxLength ?? 1000}
        placeholder={options.placeholder}
        onChange={(event) => change(key, event.target.value)}
      />
      {options.note && <small className="field-note">{options.note}</small>}
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
        placeholder={`留空使用 ${key === "port" && connection.kind === "git" ? 22 : defaults[connection.kind][key]}`}
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
        CA 证书（可选）
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
  const tlsEnabled = config.tls !== false;
  const host = typeof config.host === "string" ? config.host : "";
  const mysqlTlsNameRequired =
    connection.kind === "mysql" && tlsEnabled && isIpTarget(host);
  const tlsOptions = (
    <>
      {check("tls", "TLS", true)}
      {tlsEnabled && (
        <>
          {!mysqlTlsNameRequired &&
            text("serverName", "TLS 证书域名（可选）", {
              placeholder: "仅连接地址与证书域名不同时填写",
              maxLength: 253,
            })}
          <label>
            CA 证书（可选）
            <textarea
              value={String(config.ca ?? "")}
              rows={3}
              maxLength={100000}
              placeholder="仅使用自签名证书或私有 CA 时填写 PEM 证书"
              onChange={(event) => change("ca", event.target.value)}
            />
          </label>
        </>
      )}
    </>
  );
  if (connection.kind === "ssh")
    return renderFields(
      <>
        {text("host", "主机", {
          required: true,
          placeholder: "ssh.example.com",
        })}
        {text("username", "账号", { required: true, maxLength: 128 })}
        {sshIdentity}
      </>,
      <>
        {number("port", "端口")}
        {text("remoteRoot", "目录", { placeholder: "留空使用 /" })}
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
      </>,
    );
  if (["postgres", "mysql", "redis"].includes(connection.kind))
    return renderFields(
      <>
        {text("host", "主机", {
          required: true,
          placeholder: "db.example.com",
        })}
        {connection.kind !== "redis" && (
          <>
            {text("database", "数据库", { required: true, maxLength: 128 })}
            {text("user", "账号", { required: true, maxLength: 128 })}
          </>
        )}
        {mysqlTlsNameRequired &&
          text("serverName", "TLS 证书域名", {
            required: true,
            placeholder: "使用 IP 连接且启用 TLS 时，填写证书中的域名",
            maxLength: 253,
          })}
      </>,
      <>
        {number("port", "端口")}
        {connection.kind === "redis" && (
          <>
            {text("username", "账号（可选）", {
              placeholder: "仅使用指定 ACL 用户时填写",
              maxLength: 128,
            })}
            {number("database", "数据库编号", 2147483647, 0)}
          </>
        )}
        {tlsOptions}
      </>,
    );
  if (connection.kind === "git") {
    const ssh = config.transport === "ssh";
    return renderFields(
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
            {text("username", "账号", { required: true })}
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
      </>,
      <>
        {ssh && number("port", "端口")}
        {text("authorName", "提交作者（可选）", {
          placeholder: "Abilock",
          maxLength: 100,
        })}
        {text("authorEmail", "提交邮箱（可选）", {
          type: "email",
          placeholder: "abilock@localhost.invalid",
          maxLength: 200,
        })}
        {!ssh && (
          <label>
            CA 证书（可选）
            <textarea
              value={String(config.ca ?? "")}
              rows={3}
              maxLength={200000}
              onChange={(event) => change("ca", event.target.value)}
            />
          </label>
        )}
      </>,
    );
  }
  if (connection.kind === "s3")
    return renderFields(
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
                    ([key]) =>
                      value === "s3" || !["trustedPrivate", "ca"].includes(key),
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
          placeholder: "平台提供的 HTTPS Endpoint",
        })}
        <div className={config.provider === "r2" ? undefined : "field-row"}>
          {config.provider !== "r2" &&
            text("region", "区域", { required: true })}
          {text("bucket", "桶", { required: true })}
        </div>
      </>,
      <>
        {text("prefix", "对象前缀（可选）", {
          placeholder: "例如 project/",
          note: "留空表示整个桶；填写时以 / 结尾。",
        })}
        {choices("allowedCommands", "命令", objectCommands, objectCommands)}
        {(config.provider ?? "s3") === "s3" && privateServiceOptions}
      </>,
    );
  if (connection.kind === "aws") {
    const endpoints = config.endpoints as Record<string, string> | undefined;
    const services = Array.isArray(config.allowedServices)
      ? (config.allowedServices as string[])
      : [];
    return renderFields(
      <>
        {text("region", "区域", { required: true })}
        <div className="services-field">
          <FieldLabel required>服务</FieldLabel>
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
      </>,
      <>
        {services.map((service) => (
          <label key={service}>
            {service.toUpperCase()} 地址
            <input
              type="url"
              value={endpoints?.[service] ?? ""}
              placeholder="留空使用官方地址"
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
          text("prefix", "对象前缀（可选）", {
            placeholder: "例如 project/",
            note: "留空表示整个桶；填写时以 / 结尾。",
          })}
        {services.includes("s3api") &&
          choices("allowedCommands", "S3 命令", objectCommands, objectCommands)}
      </>,
    );
  }
  if (connection.kind === "registry")
    return renderFields(
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
      </>,
      <>
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
      </>,
    );
  if (connection.kind === "docker")
    return renderFields(
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
      </>,
      <>
        {text("apiVersion", "API 版本", { placeholder: "v1.47" })}
        {check("trustedPrivate", "内网连接")}
      </>,
    );
  return renderFields(
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
    </>,
    <>
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
    </>,
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
      <FieldLabel required={required}>{label}</FieldLabel>
      <input
        aria-label={label}
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
