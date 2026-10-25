# Git 连接测试依据（2026-10-25）

本轮只核对官方资料，验证使用仓库内合成凭据与临时 loopback 服务，没有连接真实仓库。

- [Git HTTP protocol：引用发现](https://git-scm.com/docs/http-protocol)：smart HTTP 使用固定仓库下的 `GET info/refs?service=git-upload-pack` 读取引用公告。实现只允许这一条 GET，核对内容类型、服务声明、pkt-line 和引用格式，不跟随重定向，不发送 pack RPC。
- [Git protocol-common：pkt-line](https://git-scm.com/docs/protocol-common)：响应使用四位十六进制长度及 flush 标记。探针限制为 1 MiB；超限、截断、HTML 或不匹配的协议格式均报告未验证。

HTTPS 探针沿用保存的仓库地址、鉴权与 CA，以及既有 DNS/地址边界；不创建工作区、不启动本机 Git 或 helper、不改仓库。成功仅说明该 Git 读取接口可达：公开仓库可能忽略凭据，不能据此断言密钥有效或具备写权限。

Git SSH 沿用其独立保存的 `hostKeySha256`，通过严格的 SSH 连接测试完成主机身份与登录鉴权。握手后退出，不打开 session、执行 `git-upload-pack`、访问文件或建立转发；成功不代表该仓库可读写。未知或变化的主机密钥拒绝连接，不自动接受或修改保存记录。

本地验证包括有效与空仓库引用公告、HTTP 401/403/404/429、任意 200/HTML、畸形/截断/超限响应、重定向拒绝、TLS 校验、取消无重试、SSH 正确及变化的 pin、无远端 channel，以及响应中不返回合成凭据、引用或对象 ID。完整 Git 现有 transport/security 回归同时通过；这不替代真实服务商验收。
