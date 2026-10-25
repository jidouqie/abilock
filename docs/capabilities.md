# Abilock 能力与限制

本文描述当前代码已实现的受控子集，不等于原生工具的全部功能，也不保证任意厂商、模型、账户和版本都可调用。实际连接必须由用户在 UI 保存目标与身份；Skill 再按任务查目录、选用法并提交业务参数。

## 从目标到调用

1. `abl list --json` 或 `abl list --query "生图" --json` 发现已保存的能力。目录读取不连接厂商。
2. 本地 HTTP 先用 `abl experience search` 取少量摘要，命中后只读选中的 `experience get`。未命中、失效或检索故障时读取该连接的 `abl doc`；协议直接按需读取手册。
3. 手册是 AI 维护、人可微调的自由 Markdown。缺少必要用法时，助手读取相关官方资料，用 `abl learn` 保存；用户不必填写模型矩阵或机器清单。
4. 按本次授权执行，核对业务结果和真实产物。`configured` 只表示本地配置齐全；`saved` 只表示手册已保存，均不证明账户或模型权限。

UI 与 CLI 共享连接、手册及版本状态；修改冲突不会静默覆盖。调用经验独立保存，仍绑定当前连接上下文与规则。完整流程见 [Skill](../skills/abilock/SKILL.md)、[能力发现](discovery.md)和[调用经验](experience.md)。

## 协议范围

| 类型 | 已实现的业务子集 | 主要限制 |
| --- | --- | --- |
| HTTP / `abl api` | 固定 Base URL、已允许的方法与路径；None、Bearer、Header/Query Key、Basic；JSON、multipart、二进制、HTTP/SSE；原生异步任务提交与查询 | 不接受目标或鉴权覆盖、不跟随重定向；无通用 OAuth 续期、HTTP WebSocket、实时双向语音或任意任务后台调度 |
| SSH / `abl ssh` | 固定主机与身份；密码、私钥及 passphrase；远程命令、交互 PTY、resize/EOF、远端退出码 | 不加载本机 SSH 配置，不接受 ProxyCommand、LocalCommand、agent forwarding 或目标覆盖；普通直接 SSH 不校验主机指纹 |
| SFTP / SCP | ls、stat、mkdir、rm、rmdir、单文件 put/get；SCP 普通文件和目录双向传输；二进制及路径范围校验 | SCP 使用 SFTP 实现，不是传统 SCP shell 协议；无远程到远程、续传、owner/mode/mtime 保留 |
| rsync 子集 | SFTP manifest 同步、内容比较、checksum、dry-run、递归、简单 glob exclude、上传 delete | 无原生 rsync wire、块级 delta、复杂 filter、ACL/xattr/硬链接；下载不删除客户端文件 |
| PostgreSQL | 受控原生查询、写入与表/索引/视图 DDL；一次脚本内事务；`-c`、stdin、SQL 文件、`$1` 参数绑定 | 无交互 psql、跨调用事务、COPY/PROGRAM、文件/扩展入口、routine/compound/dynamic、Kerberos、客户端证书或游标流 |
| MySQL | 受控查询、写入与 DDL；多语句事务脚本；`-e`、stdin、SQL 文件、`?` 参数绑定 | 无交互 shell、source、LOAD DATA/XML/LOCAL、UDF/plugin、routine/compound/dynamic、跨调用事务或结果流 |
| Redis | 受控原生业务命令、业务 Lua、`-x` 二进制 stdin、`--pipe` RESP bulk 批次及二进制结果 | 无持续 pubsub/monitor、Cluster/Sentinel 自动发现、跨调用 MULTI/EXEC/WATCH、管理/凭据/模块/复制入口；pipe 是有界逐条执行 |
| Git SSH / HTTPS | 固定 origin 的 clone/fetch/ff-only pull/push；worker 内 commit/status/log；workspaces/drop；文件 manifest 导出 | 不接管客户端 `.git`，不接受 URL、helpers、hooks、SSH overrides；无交互冲突/rebase、LFS、递归 submodule；Git SSH 使用独立固定指纹 |
| S3 / R2 / OSS | 固定 bucket/prefix；list/get/put/head/delete/copy/move、cp 子集；AWS SDK SigV4；自建 S3 服务可显式配置信任内网与 CA | 无 sync/recursive、多段上传/续传、任意 endpoint/profile/凭据覆盖；不等于厂商全部 S3 扩展 |
| AWS | `sts get-caller-identity`；EC2 describe/start/stop/reboot instances；已接入的 `s3api` 对象命令 | 仅配置允许的服务和资源；无 configure/login/export-credentials、profiles、环境凭据链或任意 AWS 服务 |
| Docker Engine | version/info 的限定结果、ps/images/inspect/logs/start/stop/restart/rm/create；固定 API 版本、mTLS/HTTPS Basic | 不接入本机 socket、config、helper；无 exec/build/pull/push、login、任意 daemon 覆盖 |
| Registry v2 | ping/catalog/tags、manifest/blob get/head/put/delete、SHA-256 校验、同 origin 上传地址；Basic 或已有 Bearer | 无完整镜像 pull/push/build、自动 token exchange、schema1、分块续传或任意跳转 |
| Kubernetes | get/list/describe/create/apply/patch/delete/logs/scale/rollout restart；固定 namespaces/resources；JSON manifest；Bearer/mTLS | 无 exec、credential plugin、kubeconfig、watch、port-forward、任意 API group/CRD、YAML 解析或凭据/目标覆盖 |

各适配器仍会检查本次参数；表内命令不能授权任意资源。详见 [SSH/文件](protocols/ssh.md)、[数据库](protocols/databases.md)、[Git](protocols/git.md)、[对象存储/AWS](protocols/cloud.md)、[Registry](protocols/registry.md)、[Docker/Kubernetes](protocols/containers.md)及[HTTP 预设](providers/README.md)。

## 管理与连接测试

UI 提供连接编辑、搜索、启停、手册维护、上一版查看和连接测试。`abl app` 打开独立窗口；`abl config` 打开临时浏览器配置页。凭据与管理密码由用户填写，没有默认管理密码，也没有读取、导出或修改秘密的 CLI。

测试区分鉴权通过、模型调用通过、服务响应和未验证。API 优先使用已适配的官方只读接口；需要模型调用或可能产生对象存储费用时，先明确测试范围并确认。公共列表可达、HTTP 200 或网络握手不等于密钥有效。

SSH 连接测试要求保存可信来源的测试用指纹，只验证握手与鉴权，不运行远端命令或文件操作；未知或变化的指纹拒绝。它不改变普通直接 SSH 的兼容行为。修改、取消、导航和配置版本变化会作废旧测试结果。详细范围见[连接测试](connection-testing.md)。

## 经验、历史与容量

普通成功日志不会自动变成经验。加载 Skill 的助手在新接口、模型或有意义的新参数能力成功后，依据受保护执行器的非秘密证据提交方法。当前机器验证仅覆盖代码内指定的 OpenRouter 生图，以及 OpenRouter/OpenAI 聊天结果；未知提供商、异步受理、SSE 或单纯 HTTP 200 不能冒充业务验证成功。

经验不保存真实 Key、用户 prompt、响应正文、图片或带令牌 URL。只换提示词不新增记录。单条方法最多 8 KiB，单次写入最多 16 KiB；方法及保留历史合计最多 128 条且不超过 1 MiB。检索默认 3 条、最多 5 条且不超过 8 KiB；选中详情最多 12 KiB。

确定失效的方法立即退出有效检索，重新学习且业务验证成功后才能替代；不确定失败先暂停。网络、限流、余额或鉴权问题不直接证明方法错误。移除是受容量约束的可恢复操作，最多保留一份上一版，不自动永久清空。容量满或经验故障时明确报告并回到手册，不改变已完成调用的结果、不重发业务。

## 调用限额与失败

- HTTP 请求封装最多 20 MiB，解码正文最多 10 MiB，响应最多 100 MiB；默认及最大等待 420000 毫秒。CLI 额外留取消收尾时间，不延长厂商请求。
- 普通协议默认 30000、最大 120000 毫秒。数据库 JSON 结果最多 16 MiB，不代表驱动流式内存上限；查询应自行分页。
- 普通 CLI 上传/传输最多 100 文件、10 MiB；Git 检出下载最多 1000 文件、20 MiB，commit 上传仍是 100 文件、10 MiB。文件逐项原子保存，不把整个目录当作事务。
- 显式业务文件读取拒绝凭据路径、硬链接和祖先符号链接，只有 macOS 标准 `/tmp`、`/var` 链接例外；读前后检查不能替代同用户无限 shell 的操作系统隔离。
- 超时、取消和断线可能发生在远端已受理之后。先查询状态或任务 ID，再决定下一步；不自动重放写入或整批任务。
- SSH 保留远端 0–255 退出码；其他协议的非零业务结果通常为 CLI 退出码 4。按稳定错误代码与封装结果区分输入、策略、连接和业务失败。

## 平台和验证范围

macOS 使用专用 UID 与受保护程序，Windows 实现使用专用 SID、受限管道和按需任务；Linux 没有同等本地安装器。当前可用安装入口、实际验收平台与源码依赖见 [README](../README.md)。只有客户端、受保护 worker 和 Skill 都升级后，才能报告新行为在安装版生效。

仓库中的自动化测试覆盖本地合成服务、协议报文、输入边界与状态处理。`npm run check` 运行 lint、类型检查、测试和构建；界面检查另运行 `npm run test:ui`。合成测试及一次本机安装不证明用户的真实 Key、模型权限、生产 TLS、云账户或任意操作系统版本均可用。真实服务验证需要独立、明确的目标与授权。

`independent-target` 声明、地址检查、TLS 和输出过滤只是具体控制。管理员、操作系统、可信安装源、已登录管理页和实际接收鉴权的上游属于信任区域；恶意上游任意编码回显无法普遍过滤。执行目标不得管理 worker 的主机、秘密文件、进程、Docker socket 或所在集群。普通业务数据按配置发送，不增加业务 DLP。详见[本地隔离](security/local-isolation.md)、[威胁模型](security/threat-model.md)和[显式部署模板](../deploy/README.md)。

原始方案及官方资料核验保留于 [research](research/README.md)，属于历史调研，不代替当前代码与实际验收。
