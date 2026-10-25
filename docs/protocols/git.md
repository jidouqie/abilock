# Git：固定仓库、HTTPS 与 SSH

Abilock 已实际接入 Git smart-HTTPS 和 SSH pack 协议，提供 `clone`、`fetch`、`pull`、`push`，以及 broker 工作区内的 `commit`、`status`、`log`。macOS 使用 `/usr/bin/git`；Windows 完整安装包自带固定版本、SHA-256 校验的官方 MinGit 2.56.0.windows.2（x64/ARM64），仅运行受保护目录内的程序。不会读取调用者已有仓库、Git 全局配置、SSH 配置、SSH agent 或系统钥匙串。

Windows SSH 使用固定的 `Abilock.GitSsh.exe` 传输桥，不调用用户的 SSH 程序。上游凭据仍由 Node 执行器保管；桥只通过每次新建的本地端口和随机授权值传送 Git 数据，授权值保存在私有临时文件中，调用结束即删除。Windows x64 与 ARM64 的临时目录、假凭据和本地 HTTPS/SSH 协议测试，不代替专用账户下的完整安装隔离验收。

Git 工作区保存在服务的数据目录 `git-repositories/<连接别名>/<repoId>/tree`，与连接配置绑定。执行入口只能使用管理 UI 配好的连接别名及 clone 返回的 `repoId`。配置中的仓库目标、身份、主机指纹改变后，旧工作区拒绝继续使用，需重新 clone。HTTPS Basic 的 username、SSH 私钥的公开密钥指纹也参与绑定，密码不参与；换 SSH 私钥时保守要求重新 clone。此目录属于 broker；AI 的执行身份不应获得文件系统访问。

工作区不会自动过期。`abl git SELECTOR workspaces` 列出该连接的 repoId、是否绑定当前目标与身份（`current` / `stale`）及最近更新时间；`abl git SELECTOR drop REPO_ID` 在仓库锁内删除一个工作区，包括已不能继续使用的旧身份工作区，锁文件保留。删除连接会同时删除它的工作区，未推送的 broker 提交随之丢失；连接改名会把工作区移到新别名下，目标别名已有工作区时保留原目录不合并。

检出超过 1000 个文件或 20 MiB 时无法导出到本地。clone 超限不保留 broker 工作区；pull 或 commit 超限会把 broker 工作区恢复到操作前的提交并返回 `GIT_EXPORT`，本地目录和检出记录保持不变，因此不会出现 broker 已前进而本地落后、随后提交覆盖上游改动的情况。

## 管理 UI 配置

新建类型 `git` 的连接。以下 JSON 是配置，不含真实凭据。平台凭据仅在管理 UI 的秘密字段输入。

HTTPS 示例：

```json
{
  "transport": "https",
  "url": "https://github.com/organization/repository.git",
  "authType": "basic",
  "authorName": "Your Name",
  "authorEmail": "you@example.com"
}
```

`authType` 支持 `none`、`basic`、`bearer`。Basic 的秘密字段为 `username` 和 `password`，或 `username` 和 `token`；Bearer 使用 `token`，同时必须在公开配置中填写 `identity` 账户主体标识，例如 `organization-user`。Bearer 的真实账户主体由管理者确认，无法从任意厂商 token 自动证明；不能把另一个账户的 token 伪装为同一 identity。公共只读仓库可选 `none`。URL 必须是固定 HTTPS 仓库路径，不能含 username/password、query、fragment、编码路径或路径穿越。可在配置中提供公开的 `ca` PEM，为内网 Git 服务增加受信 CA；始终启用 TLS 验证，不提供 `insecure` 开关。

SSH 示例：

```json
{
  "transport": "ssh",
  "host": "git.example.com",
  "port": 22,
  "username": "git",
  "path": "organization/repository.git",
  "hostKeySha256": "SHA256:REPLACE_WITH_VERIFIED_HOST_KEY_FINGERPRINT"
}
```

指纹必须是经过可信渠道核对的真实 SHA256 指纹，示例中的占位值不能使用。秘密字段为 `privateKey`，必要时另加 `passphrase`；也支持 `password`。不使用 agent forwarding、ProxyCommand、LocalCommand、用户 known_hosts 或用户 SSH 配置；主机密钥不匹配即失败。路径可为绝对路径，也可为 SSH 账户下的相对仓库路径，仅允许安全 ASCII 字符。

管理 UI 的连接信任边界必须准确：目标 SSH 账户、Git hooks 及仓库管理员不能有权读取 broker 的服务数据、管理凭据或主加密密钥。把 Git 服务指向 broker 自身或共享其秘密文件系统，会破坏隔离；本地协议测试仅为显式 development-fixture。尚未部署独立身份或容器的同用户本地开发模式不构成强隔离。

## 调用

品牌为 Abilock，命令仅 `abl`。Git 操作参数保留常见 Git 名称，但仓库由别名固定，后续操作以 broker 的 `repoId` 选择工作区。命令不得携带平台密码或私钥。

```sh
abl git GH clone --branch main --depth=1 --abl-directory ./repository
abl git GH fetch REPO_ID --prune
abl git GH pull REPO_ID --ff-only --abl-directory ./repository
abl git GH commit REPO_ID -m "Update documentation" --abl-directory ./repository
abl git GH push REPO_ID HEAD:main
abl git GH status REPO_ID --short
abl git GH log REPO_ID --oneline -n 10
```

`REPO_ID` 替换为 clone 返回的 32 位十六进制标识。`--abl-directory` 是客户端本地文件选择参数，由 CLI 处理，不会成为原生 Git 参数。clone、pull、成功的 commit 返回值含不包括 `.git` 的完整实际跟踪文件清单 `files`，以及 `data.filesAreFullManifest=true`；commit 的文件通过结构化 `files:[{path,base64}]` 上传。Git add 仍遵守 `.gitignore`，所以提交时上传的 ignored/untracked 文件不一定被跟踪；客户端必须以响应的实际 tracked 清单建立删除检查点，不能把全部上传文件当作跟踪文件，旧响应缺少完整清单时应保守保留本地文件。调用程序也可直接提交这种 JSON，而不拼接 shell。

本地删除已跟踪文件后，`commit --abl-directory` 从原 v2 检出记录生成 `deletions:[{path,sha256}]`，其中摘要是上次导出的内容。执行器在仓库锁内核对每个路径仍被跟踪、内容摘要未变、路径内没有符号链接或硬链接，再删除明确声明的普通文件；未列入 `deletions` 的文件保留。摘要不一致会在上传或删除前拒绝整次操作。旧 v1 记录不能授权删除，需先同步成 v2 检出记录。成功返回完整清单且原记录未被并发修改时才更新 checkpoint；取消或请求失败保留原记录。

允许参数：

| 命令   | 允许的原生参数                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| clone  | `--branch/-b`、`--branch=...`、`--depth N/--depth=N`、`--single-branch`、`--no-tags`、`--quiet/-q`、`--no-checkout`    |
| fetch  | `--prune`、`--tags`、`--no-tags`、`--depth`、`--quiet/-q`、一个分支/ref                                                |
| pull   | `--ff-only`、`--quiet/-q`、一个分支/ref；始终限定 fast-forward                                                         |
| push   | `--dry-run/-n`、`--force-with-lease`、`--set-upstream/-u`、`--quiet/-q`、安全分支或 `HEAD:branch` refspec；默认 `HEAD` |
| commit | `-m/--message`；文件由结构化 files 提供，作者由管理配置固定                                                            |
| status | `--short/-s`、`--porcelain`                                                                                            |
| log    | `--oneline`、`--no-decorate`、`-n/--max-count N`，最多 100 条                                                          |

所有命令固定使用 `origin`。不接受仓库 URL、本地 Git 目录、`-c`、`config`、credential helper、SSH override、`--upload-pack/--receive-pack`、模板目录、hook、子模块递归或任意 exec 参数。尚未实现 rebase/冲突交互处理、checkout/branch/tag 管理、LFS、递归子模块、Git 协议与 file 协议、任意原生 Git 扩展。不能把这些功能写成已支持。

上传与导出的 Git 文件清单仅支持 ASCII 相对文件名。服务和客户端都预检大小写等价、逐组件目录拼写、文件/目录前缀及 `.git`、`.abilock-worktree.json`（及可识别的旧 checkpoint）保留名变体，无法无损表示的清单整次拒绝，不假定本机文件系统大小写敏感。Unicode Git 文件名和仅大小写改名暂不支持，后者可检出到新空目录。普通 SFTP/SCP 传输仍保留 NFC Unicode。

旧 v1 checkpoint 可能把 ignored 业务文件误记为 tracked，既不能授权缺项删除，也不能授权同名覆盖。v1 迁移只采纳内容相同的文件，不重写其 inode、权限或字节；同名不同内容整批在写入前拒绝，需选择新的空目录获取检出。迁移中断时恢复其他本轮输出与旧记录，采纳文件及未知业务文件保持。

客户端 pull 先全量检查旧 v2 跟踪哈希、checkpoint 和业务冲突，再在私有暂存目录保存受影响的旧文件；仅移除受控空目录，支持跟踪文件与目录双向转换。一般写入故障恢复原内容及旧 checkpoint。并发改动使安全恢复失败时，保留 `.abl-worktree-*/recovery.json` 与原备份供可信用户处理，避免覆盖未知业务文件。进程崩溃及同用户任意并发下仍不保证全文件系统事务；broker 已完成的 ff pull 或远端副作用不因本地恢复自动撤销。这些转换与故障只运行既有纯临时 FS 测试，没有执行 CLI Git mock 或原生 Git 专项。

## 隔离与限额

原生 Git 使用清洁环境、专属 HOME、关闭用户全局及系统配置，每次操作重写 broker 仓库配置；HTTPS 网络操作只读取 broker 为本次桥生成的专属临时配置。禁用本地 hooks、fsmonitor、外部属性配置、maintenance、自动 GC、credential helpers 和子模块递归；原生参数经过允许列表解析，禁止 config/URL/SSH 覆盖。启用 HFS/NTFS 名称保护。工作区文件只能是安全相对路径，不能写入 `.git` 或跟随符号链接。元数据含符号链接、硬链接、特殊文件、alternate object store 或其他 worktree 路径即拒绝；config/HEAD/binding 使用 nofollow 普通文件读取与写入。原生 checkout 使用 `core.symlinks=false`，链接作为普通文本导出，子模块不遍历。

HTTPS Git 子进程连接临时 loopback smart-HTTP 桥，由 Node 服务固定目标、一次解析后绑定地址、校验 TLS 并注入 Authorization。最终解析地址直接检查 broker 网卡、自身和 loopback 地址；仅显式 development-fixture 在本地测试模式例外。每次桥生成独立 256 位随机能力值；所有请求必须携带此 Header 才被接受，能力不写入 URL、argv、日志或结果。服务在专属 0700 临时目录的 0600 Git 配置中把 Header 限定到本次 loopback 仓库 URL，Git 子进程只获得这项短期调用能力，仍不持有上游凭据。桥不向真实上游转发这个能力 Header，关闭时删除配置；文本输出和文件导出同时过滤该能力值的常见编码。

clone/fetch/pull 的桥仅允许 upload-pack，push 的桥仅允许 receive-pack；commit/status/log 不创建网络桥。method、标准 Git 路径和完整 query 必须精确匹配，拒绝全部重定向。能访问 loopback 端口的其他本机进程，也必须知道随机能力才能使用桥，端口可达本身不授予平台身份。同用户无限 shell 可读取专属临时配置并借用当前操作能力，拥有系统抓包/调试权限的进程也不在此能力控制的强隔离保证内；正式隔离仍需独立服务身份与网络、文件系统边界。

SSH Git 子进程使用固定服务端 helper，helper 只通过临时 Unix socket 收发 Git 字节。broker 使用 ssh2 鉴权并验证固定 SHA256 主机密钥，仅执行绑定仓库的 `git-upload-pack` 或 `git-receive-pack`；helper 和 Git 子进程不接收私钥、密码或 passphrase。socket 和临时 helper 在操作结束后删除。临时本机桥在同一用户身份下仍不能防御有无限 shell 权限的进程，它可发现或访问临时能力；强隔离依赖独立服务身份和文件系统边界。

每条网络输入/输出流限 64 MiB；Git 文本输出限 20 MiB；单次上传总量限 20 MiB，受统一操作 schema 限制最多 100 个文件；clone/pull 导出最多 1000 个普通文件和 20 MiB；Git 元数据最多 20000 项。新 clone 的异常工作区会清理，已有工作区的错误不保证撤销已完成的修改。一个 repoId 同时只允许一项操作：跨进程内核锁覆盖元数据检查、上传、删除、原生命令及导出，其他请求收到 `GIT_BUSY`；进程退出释放锁，不需要后台服务，锁文件保留以保持固定 inode。取消会结束 Git 子进程及传输，并等待退出后清理，已完成的远端 push 不保证撤销。

网络与导出限额不等于完整仓库磁盘或内存额度。压缩 Git pack 可以解压为更大对象，原生 clone/pull 在导出检查前可能完成 checkout；服务进程还没有操作系统级磁盘/内存配额。当前安装器不设置这些操作系统资源配额，不能声称已防止所有压缩对象资源耗尽。

输出过滤原始秘密及常见 URL、JSON、base64 形式，也覆盖完整 Basic 值和导出文件中的直接秘密字节。任意编码、分片变形或恶意远端主动提取凭据，不能靠有限模式过滤保证消除；目标及其执行账户必须处于可信、独立边界。

## 验证与官方文档

`tests/git-protocol.test.ts` 使用临时合成凭据、真实 Git 程序与本机 bare 仓库，覆盖 HTTPS/SSH 的 clone/fetch/pull/commit/push、鉴权失败、TLS 与主机指纹拒绝、重定向、目标/配置/helper 覆盖、取消以及 hooks/fsmonitor/filter 不执行。`tests/git-security-review.test.ts` 覆盖 metadata symlink/hardlink 与 commondir 边界；`tests/git-bridge-policy.test.ts` 检查临时桥的授权策略。文件检出、删除和恢复行为另见 `tests/git-delete-pure.test.ts`、`tests/git-workspaces.test.ts` 及 CLI 文件检查测试。

```sh
npx --no-install tsx --test tests/git-protocol.test.ts tests/git-security-review.test.ts tests/git-bridge-policy.test.ts tests/git-workspaces.test.ts
```

这些检查使用本机临时服务与合成仓库，不连接用户 GitHub/GitLab 仓库，也不使用真实仓库凭据。源码中的测试不等于当前环境已经运行通过；以当前提交的实际测试结果为准。临时目录中的协议成功不能证明生产远端权限、账户隔离、磁盘配额或全部平台安装行为已经验证。

官方链接（2026-10-06 核对）：[Git 命令和环境](https://git-scm.com/docs/git)、[Git 配置](https://git-scm.com/docs/git-config)、[Git clone](https://git-scm.com/docs/git-clone)、[Git fetch](https://git-scm.com/docs/git-fetch)、[Git pull](https://git-scm.com/docs/git-pull)、[Git push](https://git-scm.com/docs/git-push)、[Git HTTP backend](https://git-scm.com/docs/git-http-backend)、[ssh2 官方实现与主机校验接口](https://github.com/mscdex/ssh2)。

新检出使用 `.abilock-worktree.json`；已有导出工作区的旧 `.permivelo-worktree.json` 可按同样文件与哈希校验继续识别，并保留原标记。不会批量搜索、迁移或修改用户工作区，也不读取其他真实项目。
