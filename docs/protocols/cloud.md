# 对象存储与 AWS

Abilock 用官方 AWS JavaScript SDK v3 发出签名请求，不启动 `aws`、`ossutil`、shell 或凭据 helper。Access Key、Secret Access Key、可选 Session Token 只在管理页面填写，执行端只选择连接和业务参数。

## 当前可用能力

| 连接 / 服务                      | 已实现命令                                                                                                  | 参数与边界                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `s3`：Amazon S3、S3 兼容服务     | `list-objects-v2`、`get-object`、`put-object`、`delete-object`、`head-object`、`copy-object`、`move-object` | 固定 endpoint、region、bucket 和可选 prefix；copy/move 只在同一桶及 prefix 范围内                  |
| `s3`：Cloudflare R2              | 上述对象命令                                                                                                | 官方 account endpoint，region 为 `auto`；不涉及 Workers 管理 API                                   |
| `s3`：Alibaba OSS 的 S3 兼容接口 | 上述对象命令                                                                                                | 官方 HTTPS 区域 endpoint，强制 virtual-hosted 地址；不声称覆盖 OSS 特有 API                        |
| `s3` 简写                        | `ls`、`get`、`put`、`rm`、`head`、`copy`、`mv`、`cp`                                                        | `cp source destination` 支持客户端文件上传、下载和同桶复制；`mv source destination` 只支持同桶移动 |
| `aws sts`                        | `get-caller-identity`                                                                                       | 只返回调用身份；不提供 AssumeRole、凭据导出或 profile 管理                                         |
| `aws ec2`                        | `describe-instances`、`start-instances`、`stop-instances`、`reboot-instances`                               | 原生 instance IDs；describe 支持 JSON filters、max-results、next-token；支持 dry-run               |
| `aws s3api`                      | 上述对象命令                                                                                                | 复用固定桶对象适配器；需管理配置明确启用 `s3api`                                                   |

其他 AWS 服务、Azure/GCP/阿里云通用 CLI 暂未接入。`sync`、`--recursive`、多段上传、批量删除、桶管理、ACL/KMS/SSE-C、预签名 URL、S3 Express、跨桶复制、AWS `--query` / 自动分页未实现，收到这些命令或参数时会明确拒绝。该模块保留已实现接口的原生参数，不能替代完整厂商 CLI。

## UI 配置

在连接管理选择 `s3`，例如保存以下公开配置；凭据在页面的秘密字段另填，不能放在此 JSON 或 CLI 参数中：

```json
{
  "provider": "s3",
  "endpoint": "https://s3.us-east-1.amazonaws.com",
  "region": "us-east-1",
  "bucket": "your-bucket-name",
  "prefix": "work/",
  "allowedCommands": [
    "list-objects-v2",
    "get-object",
    "put-object",
    "head-object",
    "delete-object",
    "copy-object",
    "move-object"
  ],
  "maxBytes": 12000000
}
```

`prefix` 为空表示整个固定桶；非空范围必须以 `/` 结尾。它限制 list/get/put/delete 以及 copy/move 的两端。bucket 不接受 URL、ARN 或含点名称，避免 SDK 切换目标或 TLS 主机名称歧义。`maxBytes` 限制每次上传及响应，默认和上限为 12 MB。

R2 使用 `provider: "r2"`、`region: "auto"`，endpoint 为 `https://<32位account-id>.r2.cloudflarestorage.com`。OSS 使用 `provider: "oss"`，例如 endpoint `https://oss-cn-hangzhou.aliyuncs.com`、region `cn-hangzhou`；SDK 实际连接固定的 `<bucket>.oss-cn-hangzhou.aliyuncs.com`。本版本只接受公开官方 OSS endpoint，不支持内网、加速、自定义域名或 jurisdiction R2 endpoint。

AWS 连接的公开配置：

```json
{
  "region": "us-east-1",
  "allowedServices": ["sts", "ec2", "s3api"],
  "bucket": "your-bucket-name",
  "prefix": "work/",
  "maxBytes": 12000000
}
```

区域 endpoint 默认由服务和固定 region 构造，包括中国区域的 `amazonaws.com.cn`。可由管理页面的 `endpoints: {"sts": "...", "ec2": "...", "s3api": "..."}` 固定覆盖，执行参数不能覆盖。SDK 配置显式关闭默认凭据查找，固定签名、区域、重试和 endpoint 选项，不从用户的 AWS profile、凭据文件、metadata 或执行环境中寻找身份。

连接的 `trustBoundary` 应根据根 README 的隔离模型选择。正式连接需要 `independent-target`，并确认此身份的云操作权限不能控制 broker 本身的主机、容器、存储或密钥文件。该配置声明不能替代真实的独立部署。

## 调用示例

以下命令不会创建连接或收集密钥；先在 UI 保存 `OBJ` 和 `CLOUD`：

```sh
abl s3 OBJ ls --prefix work/ --max-keys 100
abl s3 OBJ cp ./photo.png s3://your-bucket-name/work/photo.png --content-type image/png
abl s3 OBJ cp s3://your-bucket-name/work/photo.png ./download.png
abl s3 OBJ head-object --key work/photo.png
abl s3 OBJ cp s3://your-bucket-name/work/photo.png s3://your-bucket-name/work/photo-copy.png
abl s3 OBJ mv s3://your-bucket-name/work/photo-copy.png s3://your-bucket-name/work/photo-moved.png
abl s3 OBJ delete-object --key work/photo-moved.png
abl aws CLOUD sts get-caller-identity
abl aws CLOUD ec2 describe-instances --instance-ids i-0123456789abcdef0 --filters '[{"Name":"tag:Name","Values":["worker"]}]' --max-results 10
abl aws CLOUD ec2 stop-instances --instance-ids i-0123456789abcdef0 --dry-run
abl aws CLOUD s3api put-object --key work/note.txt --body ./note.txt
abl aws CLOUD s3api get-object --key work/note.txt ./note-copy.txt
```

`ls/list-objects-v2` 和 `describe-instances` 每次返回一页；使用返回的 `NextContinuationToken` 或 `NextToken` 明确取下一页。EC2 `--dry-run` 的权限检查以厂商的 `DryRunOperation` / 拒绝错误返回，不能把它当成成功执行了停机。

上传文件由客户端 CLI 读取并封装，服务不能根据请求路径读取 broker 的磁盘。也可使用结构化封装；`put.json` 只含业务数据：

```json
{
  "args": [
    "put-object",
    "--key",
    "work/hello.txt",
    "--content-type",
    "text/plain"
  ],
  "input": "hello from Abilock\n",
  "timeoutMs": 30000
}
```

```sh
abl s3 OBJ --request-json put.json --json
abl s3 OBJ put-object --key work/hello.txt --abl-stdin
```

二进制上传可在 `files: [{"path":"upload.bin","base64":"..."}]` 中封装，并让 `--body upload.bin` 与该标签一致。下载返回 `files`，原生命令附有客户端目标文件时 CLI 保存结果；结构化 JSON 模式返回 base64，由调用方处理。broker 从不访问客户端文件路径。

`move-object` 使用先 CopyObject、再 DeleteObject。删除失败会返回 `CLOUD_MOVE_PARTIAL`；此时目标副本已存在、源对象可能仍保留，应核对后单独删除。没有事务、自动补偿或盲目重试。

## 安全与错误

目标只能由 UI 配置。每次操作检查全部 DNS 地址并固定本次连接地址，拒绝 metadata、loopback / 私网和目标更换；开发 fixture 是显式本机例外。自建 S3 兼容服务（`provider: "s3"`）可由管理员在连接选项中勾选 `trustedPrivate` 允许普通私网地址（RFC1918、IPv6 ULA、CGNAT），并可填写公开的 `ca` PEM；loopback、link-local、metadata 与 broker 自身地址仍拒绝，R2 / OSS 不接受这两个选项。HTTPS 使用正常证书校验，不接受 `--no-verify-ssl`。HTTP 3xx 不跟随，S3 跨区自动重定向关闭，最大尝试次数为 1。

`configure`、`export-credentials`、`presign`、`--profile`、`--endpoint-url`、`--region`、`--no-sign-request`、凭据参数、`credential_process` 和本地文件 URL 不存在执行能力，直接拒绝。错误只返回 SDK 错误名称和 HTTP 状态，不返还 SDK message、签名请求、stack 或请求配置。返回的文本、数据和文件对保存凭据的原文、URL / JSON / base64 形式做过滤。

过滤属于有限防护。已认证远端必须可信，恶意远端可以任意编码或改变凭据回显；不能把输出过滤称作对恶意远端的密码学隔离。同用户无限 shell 也没有强隔离。IAM / RAM 权限和对象存储端策略仍决定云端可操作范围；Abilock 不会自动创建或改变这些真实权限。

## 验证状态

`tests/cloud-protocol.test.ts` 使用官方 SDK 连接独立 HTTP 协议 fixture，验证 SigV4 HMAC、S3 路径/请求/响应、上传下载 SHA-256、STS/EC2 Query 序列化、错误、取消、大小限制、凭据过滤、目标/桶/prefix 绕过和重定向。HTTPS 自签名 fixture 验证正常证书校验会拒绝连接。fixture 私钥是公开的合成测试材料，没有生产用途。

未使用真实 AWS、OSS、R2 凭据，未连接真实云端。本地 fixture 成功不表示真实厂商权限、区域、网络和兼容细节已经全部验证。OSS/R2 当前是官方文档确认的兼容实现、配置校验与共享 SDK 路径验证，真实厂商集成未验。

`scripts/real-object-check.ts` 用于另行准备的临时本机 MinIO 服务。它只读取显式 `ABILOCK_TEST_ENV` 指向的合成测试配置，只连接 loopback 服务，用官方 SDK 准备测试桶并验证 list/put/get/head/cp/mv/delete、SHA-256 和错误鉴权。临时服务与合成凭据由运行者准备和清理，不能指向已有业务存储。

```sh
npx --no-install tsx --test tests/cloud-protocol.test.ts
# 仅在临时测试服务已准备好后运行：
ABILOCK_TEST_ENV=/tmp/owned-fixture-config.json npx --no-install tsx scripts/real-object-check.ts
```

集成结果写入本地 `artifacts/real-object-validation.json`，不随源码分发。以本次实际结果判断该环境是否通过；本机 S3 兼容服务通过也不证明 AWS、OSS、R2 的真实账户、权限或生产 TLS 已经验证。

## 官方来源

本页来源核对日期：2026-10-06。更新文档不能改变连接的凭据、目标或权限策略。

- [AWS SDK v3 client 配置、HTTP handler、重试与不跟随重定向](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html)
- [AWS S3 API CLI 命令参考](https://docs.aws.amazon.com/cli/latest/reference/s3api/)
- [AWS STS get-caller-identity](https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html)
- [AWS EC2 describe-instances：实例、filters、分页和 dry-run](https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-instances.html)
- [Cloudflare R2 官方 AWS SDK v3 示例：endpoint、region auto 与 Access Key](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [R2 S3 API 兼容矩阵](https://developers.cloudflare.com/r2/api/s3/api/)
- [Alibaba OSS S3 兼容范围及 virtual-hosted 限制](https://www.alibabacloud.com/help/en/oss/developer-reference/compatibility-with-amazon-s3)
- [Alibaba 官方 S3 客户端迁移至 OSS 的配置说明](https://www.alibabacloud.com/help/en/oss/developer-reference/migrate-data-from-amazon-s3-to-oss)

由 [吉豆茄 jidouqie](https://v.douyin.com/oApPI_L9avQ) 制作。
