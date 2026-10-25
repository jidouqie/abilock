# Registry API v2

`registry` 是独立于 Docker daemon 的连接类型。Abilock 直接调用固定 Registry 的 HTTP API v2，支持 Basic、预先取得的 Bearer 和无鉴权。密码或 token 只在 UI 保存；不启动 Docker CLI、凭据 helper、shell 或登录程序。

## 支持范围

| 命令                                                | 实际操作                           | 边界                                                                 |
| --------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `ping`                                              | `GET /v2/`                         | 检查 Registry v2 与当前身份                                          |
| `catalog [--n N --last NAME]`                       | 仓库分页列表                       | 只返回管理配置允许的 repository 名称                                 |
| `tags REPOSITORY [--n N --last TAG]`                | 标签分页列表                       | repository 必须在允许名单内                                          |
| `manifest get REPOSITORY TAG_OR_DIGEST [OUTPUT]`    | 读取 manifest JSON，可返回原始文件 | 核对 SHA-256；支持 schema 2 / OCI image manifest 和 index 的媒体类型 |
| `manifest head REPOSITORY TAG_OR_DIGEST`            | 读取清单 metadata                  | 不下载清单正文                                                       |
| `manifest put REPOSITORY TAG_OR_DIGEST --body FILE` | 上传清单                           | JSON schemaVersion 2；使用指定、受限 Content-Type                    |
| `manifest delete REPOSITORY DIGEST`                 | 删除清单                           | 只接受 SHA-256 digest，不能按 tag 删除；服务需启用 delete            |
| `blob get REPOSITORY DIGEST [OUTPUT]`               | 下载 blob                          | 必须与请求 digest 及响应 digest 一致                                 |
| `blob head REPOSITORY DIGEST`                       | 查询 blob metadata                 | 使用固定 repository 路径                                             |
| `blob put REPOSITORY --body FILE [--digest DIGEST]` | 创建上传会话、上传并完成 blob      | 本地计算 SHA-256；上传会话地址只能来自同 origin、同 repository       |
| `blob delete REPOSITORY DIGEST`                     | 删除 blob                          | 服务需启用 delete；引用它的清单可能无法使用                          |

也可写成 `manifest-get`、`blob-put` 等平铺命令。单次上传或响应最大 12 MB，`maxBytes` 可调低。未实现完整 Docker image pull/push、构建、解压 layer、签名验证、chunked/resumable 上传、跨仓库 mount、schema 1 或自动认证 token exchange。服务返回 401 时不会访问其 challenge realm；在 UI 更新已取得的 Bearer 后可再次调用。

## 管理配置

例如创建别名 `REG`，连接类型为 `registry`，公开配置如下：

```json
{
  "endpoint": "https://registry.example.com",
  "authType": "basic",
  "allowedRepositories": ["team/app"],
  "allowedCommands": [
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
    "blob-delete"
  ],
  "maxBytes": 12000000
}
```

在 UI 的凭据区另填 `username`、`password`；Bearer 类型只填 `token`；无鉴权不接受秘密字段。不要把凭据写入公开配置、URL、请求 JSON、命令行或 AI 上下文。endpoint 必须是固定 HTTPS 根地址，不允许 userinfo、query 或路径。正式连接需要根 README 所述 `independent-target` 边界；开发临时容器才使用 `development-fixture` 和显式 `allowInsecureLocal`。

## 使用

```sh
abl registry REG ping
abl registry REG catalog --n 100
abl registry REG tags team/app
abl registry REG blob put team/app --body ./config.json
abl registry REG blob get team/app sha256:实际64位摘要 ./config-copy.json
abl registry REG manifest put team/app v1 --body ./manifest.json
abl registry REG manifest get team/app v1 ./manifest-copy.json
abl registry REG manifest head team/app v1
abl registry REG manifest delete team/app sha256:实际64位摘要
```

`--body` 文件由客户端封装，broker 不读取自己的本地路径。也可发送通用结构化请求：

```json
{
  "args": ["blob", "put", "team/app", "--body", "layer.bin"],
  "files": [{ "path": "layer.bin", "base64": "..." }],
  "timeoutMs": 30000
}
```

```sh
abl registry REG --request-json blob-put.json --json
```

blob 下载返回 `files`；客户端原生命令指定目标文件时保存到该位置。manifest 默认输出 JSON，可附目标文件保留原始字节。摘要验证发生在输出过滤之前；如果远端内容包含保存凭据、触发过滤，返回文件的摘要可能改变。这时应调查远端回显，而不是关闭过滤。

Catalog 与 tags 每次返回一页。使用最后一项作为 `--last` 明确取下一页；catalog 会过滤允许名单外的名称，所以中间页可能为空，不能据此断言整个 Registry 没有更多仓库。用户可调用明确允许的 `tags` 来检查指定 repository。

## 安全与失败行为

本次 HTTP 会话固定 DNS 解析地址、TLS 主机和端口，拒绝 metadata、私网和 broker 自身地址；正式 HTTPS 保持正常证书校验。自建 Registry 可由管理员勾选 `trustedPrivate` 允许普通私网地址（RFC1918、IPv6 ULA、CGNAT），并可填写公开的 `ca` PEM；loopback、link-local、metadata 与 broker 自身地址仍拒绝。开发 fixture 的本机 HTTP 例外需服务环境、连接配置与执行上下文同时显式开启。

任何 HTTP 3xx 都拒绝。Blob 上传返回的 Location 只能用于当前 origin 下当前 repository 的 uploads 路径，不得切换 hostname、身份、仓库或管理接口。保留该上传会话的 query 状态，但不会把上传 URL 或 capability 导出给执行端。

`login`、`export-credentials`、`--password`、`--token`、endpoint / TLS 覆盖和 credential helpers 不提供执行能力，直接拒绝。错误只报告固定错误 code、HTTP 状态或通用连接错误，不转发远端 error message / detail、WWW-Authenticate、stack、headers 或请求配置。输出按保存凭据及其常见编码形式过滤；已认证远端仍须可信，不能保证过滤任意恶意编码回显。

失败或取消的 blob 上传会话可能在服务端暂存直到服务自身清理；本版没有自动恢复、盲目重试或断点续传。删除需服务端配置允许；Abilock 不修改 Registry 配置或替用户开启删除。它不提供同用户无限 shell 的强隔离。

## 验证

`tests/registry-protocol.test.ts` 覆盖标准 HTTP API 的两步 blob 上传、manifest/catalog/tags、Basic/Bearer、二进制与 SHA-256、错误、取消、响应限制、目标/身份/仓库绕过、重定向、恶意上传 Location 和 TLS 自签证书拒绝。

`scripts/real-registry-check.ts` 用于另行准备的临时本机 `registry:2` 服务。它只读取显式 `ABILOCK_TEST_ENV` 指向的合成测试配置，验证 Basic 鉴权、blob/manifest 上传下载删除、哈希、catalog/tags 及错误鉴权；不会创建、停止容器或修改服务配置。测试服务应仅绑定 loopback，使用临时合成凭据，并由运行者准备和清理，不能指向已有业务仓库。

```sh
npx --no-install tsx --test tests/registry-protocol.test.ts
# 仅在临时测试服务已准备好后运行：
ABILOCK_TEST_ENV=/tmp/owned-fixture-config.json npx --no-install tsx scripts/real-registry-check.ts
```

集成脚本将本次结果写入本地 `artifacts/real-registry-validation.json`，该文件不随源码分发。协议 fixture 不能替代真实服务验收；本机临时服务通过也不证明生产权限、证书或其他版本兼容。完整 Docker image pull/push 与自动 token exchange 不在实现范围内。

## 官方来源

来源核对日期：2026-10-06；文档更新不能修改鉴权、目标或调用权限。

- [CNCF Distribution Registry HTTP API v2](https://distribution.github.io/distribution/spec/api/)：接口、摘要、上传会话与错误格式。
- [Distribution token authentication](https://distribution.github.io/distribution/spec/auth/token/)：Registry 的 token challenge 流程；本版使用已保存 Bearer，不实现自动交换。
- [Distribution Registry 配置](https://distribution.github.io/distribution/about/configuration/)：服务端鉴权及删除开关。

由 [吉豆茄 jidouqie](https://v.douyin.com/oApPI_L9avQ) 制作。
