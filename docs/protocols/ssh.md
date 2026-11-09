# SSH、SFTP、SCP 与增量文件同步

Abilock 的 SSH 适配器直接使用 SSH 协议库连接管理页面保存的目标和身份。它不会执行本机 `ssh`、读取 `~/.ssh`、接入 SSH agent、Keychain 或调用 `ProxyCommand` / `LocalCommand`。品牌为 Abilock，命令仅 `abl`。

## 在管理页面配置

创建 SSH 连接并保存非秘密配置，例如：

```json
{
  "host": "10.0.0.1",
  "port": 22,
  "username": "deploy",
  "remoteRoot": "/srv/application",
  "fileAccess": "readwrite",
  "allowShell": true
}
```

直接 SSH 不要求或校验主机指纹，也不提供首次连接确认。旧记录中的 `hostKeySHA256` 保留但忽略，无需重新保存或迁移凭据。此行为也适用于共用 SSH 连接的 PTY、SFTP、SCP 与增量同步；Git SSH 使用独立配置。

凭据仅在 UI 的秘密字段录入：`password`，或 `privateKey` 与可选 `passphrase`；两种身份不可同时配置。私钥是内容而不是 broker 本机文件路径。支持 SSH2 接受的常见 OpenSSH 密钥格式，包括 Ed25519、ECDSA、RSA 和加密私钥。使用私钥时仅向远端提交公钥及认证签名；使用密码时密码通过加密 SSH 认证协议交给配置地址的服务器，不进入远程命令参数或环境变量。连接不校验服务器主机密钥。

`remoteRoot` 必须为存在的远程规范绝对目录，其自身及从 `/` 开始的祖先均不能是符号链接。文件读写限制在此目录下；相对路径以它为根。`fileAccess` 默认 `read`，写入/删除需显式设为 `readwrite`。`allowShell` 默认 `true`，关闭后只允许文件功能。

管理配置可以选择独立的内网主机。正式连接拒绝 loopback、本机网卡地址、link-local、metadata、多播和无效 IP；DNS 解析所有地址都经过检查，实际 TCP 连接固定到一次解析结果。临时本机协议 fixture 仅在显式测试模式例外放行。目标与身份不能由运行参数改写；同 IP 对应多个身份时应使用明确别名。

普通命令和文件操作的 `timeoutMs` 从最终 DNS 解析之前开始计时；交互终端也能在 DNS 等待阶段取消。建立连接另有从 DNS 前开始的 15 秒总期限，覆盖解析与 SSH 握手，过期返回 `SSH_CONNECT_TIMEOUT`（504）。就绪后清除该握手期限，随后由原操作或终端会话的期限控制，不会把正常长命令/终端在连接后 15 秒切断。主动取消返回 `SSH_CANCELLED`（499）；代理服务提供的明确超时原因仍原样保留。操作取消会停止等待 DNS，迟到解析结果不会创建 socket 或 SSH 客户端；底层操作系统 DNS 查询可能继续完成，不能称作已经取消系统 resolver 本身。

## 测试连接

应用在已保存 SSH 的列表行和编辑窗口提供“测试连接”。它只检查连接与鉴权，成功或失败后关闭连接，不执行命令、打开 PTY 或读写文件，也不修改配置、手册及 revision。关闭 shell 权限不影响登录测试。

测试只使用保存的地址、账号和凭据；新建或有修改时先保存。测试同样不要求或校验主机指纹，忽略旧 `hostKeySHA256`，结果不声明已验证服务器身份。连接握手期限为 15 秒，包含 DNS；管理请求总体最多 30 秒。取消、关闭编辑窗口或切换连接会丢弃旧结果。测试结束时重新核对连接版本，期间被修改则要求重读，不显示旧版本成功。网络与鉴权错误返回固定说明，不回传原始服务器错误或凭据。

## 远程命令与交互终端

```sh
abl ssh DEPLOY 'uname -a'
abl ssh DEPLOY -- 'printf "%s\n" "hello world"'
printf '业务输入\n' | abl ssh DEPLOY -- cat
abl ssh DEPLOY
```

无命令时进入交互终端，支持 PTY、窗口 resize、输入、EOF 和 Ctrl-C 字节，保留远程退出码。远端是否按 Ctrl-C 中断任务由其终端程序决定。退出、客户端断开或取消会关闭通道和 SSH 连接。

普通 SSH 命令只在收到有效的 `exit-status` 时返回远端的 0–255 状态；通道直接关闭而没有有效退出状态时返回 255，并在 stderr 说明缺失状态。交互终端未收到退出状态时也返回失败，不将连接关闭当作命令成功。

命令遵循 OpenSSH 的远程 shell 语义：命令 operands 以空格合成远端命令，shell 解释只发生在配置的远端。需要保留空格、重定向或 shell 表达式时把表达式作为一个正确引号的参数。`ProxyCommand`、`LocalCommand`、`-F`、`-i`、`-o`、agent/X11/端口转发和目标/身份覆盖不是执行入口选项；不启动本机 shell 扩展。普通远程业务命令不做 DLP。

## SFTP

```sh
abl sftp DEPLOY ls .
abl sftp DEPLOY stat reports/result.json
abl sftp DEPLOY mkdir reports
abl sftp DEPLOY put ./result.json reports/result.json
abl sftp DEPLOY get reports/result.json ./downloaded.json
abl sftp DEPLOY rm reports/result.json
abl sftp DEPLOY rmdir reports
```

支持 `ls`、`stat`、`mkdir`、`rm`、`rmdir`、单文件 `put/get`。支持二进制内容、空格及 Unicode 文件名。目录删除要求为空，不能删除 `remoteRoot`。不接受 SFTP batch 内的本机 `!` 命令。文件路径拒绝父目录跳转、控制字符、反斜线和符号链接；路径的每个已存在祖先与末级都用 `lstat` 检查，即使链接仍指向 `remoteRoot` 内也会拒绝。缺失子目录通过逐级创建与重查处理，根及其祖先必须已经存在。

上传由 CLI 读取显式选定的业务文件并封装为 `{path,base64}`；broker 不读取调用者提供的本地文件路径。下载返回结构化文件内容，CLI 按调用者指定的目标落盘。broker 使用远端 `wx` 临时文件，OpenSSH 支持时以 `posix-rename` 扩展原子替换；不支持扩展时仅允许标准 rename 创建新文件，覆盖已有文件返回 `SSH_ATOMIC_OVERWRITE_REQUIRED` 并保留原文件，不能先删除原文件再尝试上传。此规则也适用于 SCP/rsync 的文件覆盖。中断时尽力清理本次临时文件。

读写与目录创建会在操作前后重查路径；这些是针对正常 SFTP 服务器的有限检查。SFTP v3 不提供 `openat`、目录句柄锁定或等价的全路径不跟随链接原语，因此不能保证对抗有权限同时交换祖先目录的恶意远端进程，亦不能把这些检查称作强隔离。远端应禁止不可信用户修改传输树的祖先；认证服务器仍属于可信边界。

## SCP

```sh
abl scp DEPLOY ./result.bin :reports/result.bin
abl scp DEPLOY :reports/result.bin ./downloaded.bin
abl scp DEPLOY -r ./bundle :releases/current
abl scp DEPLOY -r :releases/current ./downloaded-release
```

一端必须是 `:remotePath`，远程 host 和 username 从连接配置获取，不能在 operand 中改写。`-r` 传输普通文件目录；目录树由文件 manifest 构成，不保留空目录、符号链接、原 owner/mode/mtime。`-p`、旧版 SCP shell 协议、远端到远端复制和自定义 SSH 程序未实现，明确拒绝。这里的 SCP 功能使用 SFTP 传输，与现代 OpenSSH 的默认协议方向一致，但不是系统 `scp` 所有选项的透明替代。

## rsync 命令的受控增量同步

```sh
abl rsync DEPLOY -r ./bundle :releases/current
abl rsync DEPLOY --checksum --exclude='*.log' --exclude=cache/ ./bundle :releases/current
abl rsync DEPLOY --dry-run --delete ./bundle :releases/current
abl rsync DEPLOY --delete ./bundle :releases/current
abl rsync DEPLOY -r :releases/current ./downloaded-release
```

上传会实际读取远端文件内容比较；相同文件跳过，不同文件写入。`--checksum` 当前同样使用完整内容比较。`--dry-run` / `-n` 仅报告将改变/删除的文件，不写入；`--delete` 仅允许上传，删除目标树中 manifest 不含的普通文件，并保留 exclude 匹配项。它不会删除 CLI 的本地文件或远端空目录。

`--exclude=PATTERN` 和 `--exclude PATTERN` 支持简单 glob：`*`、`**`、`?`，无斜线模式匹配文件 basename，前导 `/` 从同步根匹配，末尾 `/` 排除该目录及子项。支持重复 exclude。字符类、花括号、转义及复杂 filter 规则明确拒绝。下载目录会传输匹配文件，不对 CLI 现有文件执行增量比较。

这是基于 SFTP 的真实 manifest 增量同步，**没有 rsync wire 协议、块级 delta 算法或完整原生 rsync 参数兼容**。不支持 `-e`、`--rsync-path`、压缩、ACL/xattr/硬链接/owner保留、守护进程 URL 或过滤脚本。不能用它声称替代大型备份系统的所有 rsync 行为。

每次文件操作最多 100 个文件、总计 12 MiB。目录树上传和下载统一最多 16 层子目录（以此次传输根为第 0 层，文件名不算目录层）；上传会先检查整份 manifest，17 层路径即使被 exclude 排除也会在任何写入前拒绝。远程命令文本输出上限 20 MiB。超限失败，不静默截断。原生大文件流式传输、空目录保留及断点续传是尚未实现的边界。

## 凭据边界与验证证据

文件下载、stdout/stderr 和交互流会过滤该连接秘密的原文、URL/Base64/JSON 常见形式，过滤可跨网络分块并保留无关二进制字节。过滤可能改变与秘密恰好相同的业务内容；它不保证任意恶意认证端使用任意编码变换后绝对无法回传秘密。配置地址的认证服务器属于可信边界。

**远端必须独立于 broker 的主机、存储、身份与权限边界。** SSH 用户不能通过共享挂载、远程权限或容器/集群管理权读到 broker 的环境、内存或密钥目录。`remoteRoot` 仅约束文件适配器，不是远程 shell jail；普通远程 shell 可以访问该远程用户本来拥有的路径。管理配置中的独立目标声明也不是已经部署的强隔离证明。同用户无限本机 shell 和未隔离的 broker 部署仍不能声称保护真实秘密；本任务未改变系统身份、权限或部署。

复跑 `npm test -- --test-name-pattern SSH` 不适用于 npm 脚本的参数位置；直接运行下面命令覆盖整个模块：

```sh
npx --no-install tsx --test tests/ssh-protocol.test.ts tests/ssh-connection-test.test.ts tests/ssh-connection-test-endpoint.test.ts tests/ssh-connection-test-ui.test.ts
```

测试覆盖命令/stdin/非零及缺失退出状态、加密私钥认证、无指纹与旧错误指纹兼容、身份与本机扩展攻击、取消/超时、PTY resize/Ctrl-C/EOF/非零退出、SFTP/SCP 二进制/目录/Unicode路径、root 内外的祖先符号链接、根目录链接祖先、16/17 层上传与下载边界、只读攻击、秘密跨chunk过滤、增量/排除/删除与 dry-run、合成密钥生成的确定性回归，以及挂起 DNS 的操作超时/取消、15 秒连接期限、abort 监听清理、迟到结果零 socket 的纯合成负测。连接测试另覆盖无命令/文件通道、鉴权失败、错误脱敏、管理权限、严格请求体、版本冲突及界面结果状态。实际结果以本轮检查记录为准。

测试 fixture 发现 `ssh2@1.17.0` 的 Ed25519 密钥生成器会错误地剥除公钥的前导零字节，偶发生成不足 32 字节、被其自身解析器拒绝的 OpenSSH 公钥。fixture 仅对此已识别的生成格式错误最多重新生成 16 次，其他错误立即失败；确定性回归验证成功重生成、上限和未吞掉其他错误，并检查 1024 组新合成密钥。产品代码不生成密钥，没有对用户私钥增加重试或放宽解析；历史失败记录保留。

测试分两种：`ssh2.Server` fixture 通过真实 SSH/SFTP 网络协议但服务器文件系统是合成内存实现；另一个测试在这台 Mac 的现有 `/usr/sbin/sshd` 上使用临时目录、合成主机/身份密钥和独立配置，验证真实 OpenSSH 的 exec、SFTP、root 内祖先链接读写拒绝、SCP 目录与 rsync 增量。16/17 层边界与 root 外链接等新增攻击用例目前使用前一种协议 fixture，不能称作全部已经在真实远端文件系统验收。没有访问真实远端，没有读取用户 SSH/keychain/cloud 配置，没有安装或改系统 sshd。PTY 控制行为目前只在 SSH2 fixture 验证；未做真实远端 shell、浏览器交互或生产隔离部署验收。

## 官方来源

2026-10-06 核验：[ssh2 项目官方 API 文档](https://github.com/mscdex/ssh2)、[OpenSSH ssh 手册](https://man.openbsd.org/ssh)、[OpenSSH sftp 手册](https://man.openbsd.org/sftp)、[OpenSSH scp 手册](https://man.openbsd.org/scp)、[rsync 官方手册](https://download.samba.org/pub/rsync/rsync.1)。这些手册用于协议和原生命令语义参照；Abilock 的实际支持范围以上表述为准。

包内CLI普通传输更保守：100文件、10MiB；服务12MiB上限不提高客户端上限。系统OpenSSH验证了exec/SFTP/SCP目录/rsync manifest增量；交互PTY/resize/Ctrl-C/EOF/非零退出使用SSH2线协议fixture，CLI另用真实临时本地PTY与WebSocketfixture，并非系统OpenSSH交互PTY成功证据。

连接后的 exec、SFTP 子系统和 PTY shell 回调等待也响应取消；SFTP 每项请求在发出前检查信号，挂起回调被取消后不会继续下一项远端请求。晚到通道关闭，文件流取消时销毁。该行为只结束后续工作，已经完成的远端写入或命令副作用不保证撤销。
