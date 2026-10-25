# 协议连接测试核对（2026-10-25）

本记录对应工作区 2.2.11 的新管理页探针；不是安装版、真实服务、真实凭据或计费验收。

| 类型 | 固定测试 | 结果范围 |
|---|---|---|
| SSH | 已保存主机指纹 + 登录握手，随即关闭 | 主机身份、登录；不打开命令/文件/转发通道 |
| PostgreSQL / MySQL | `SELECT 1 AS abilock_probe` | 数据库会话与常量查询；服务器免密配置时不证明密码有效 |
| Redis | `PING` | 已配置会话与 PONG；不访问业务键 |
| Git HTTPS | 固定仓库 smart refs 公告 | Git 协议可达；公开仓库不证明密钥有效 |
| Git SSH | 保存的 Git 主机指纹 + 登录握手 | 主机身份和登录，仓库权限未测 |
| S3 / OSS / R2 | 保存桶/前缀的 `ListObjectsV2`，`MaxKeys=1` | 单次列表权限/协议响应；不下载内容、不跟随分页；先明确确认潜在请求费 |
| AWS | 已允许 STS 的 `GetCallerIdentity` | 官方 STS 的身份响应；自定义 STS 只标兼容服务可达，其他服务权限与余额未测 |
| Docker | 保存 API 版本的 `GET /version` | Docker 版本格式响应；公开端点不证明凭据/操作权限 |
| Registry | 已允许的 `GET /v2/` + 版本响应头 | V2 协议；可能匿名访问，不证明仓库权限或密钥有效 |
| Kubernetes | 固定命名空间首个允许的非秘密资源，单页 `limit=1` | 对该资源的只读访问；不跟随分页，不请求 Secret/ConfigMap，不代表所有资源权限 |

所有计划由代码确定，不能通过业务正文覆盖目标、身份、路径或范围。未保存、停用、范围不适用、未知提供商、缺可信 SSH 指纹时不发起业务探测。新路由只接受 expectedRevision 与可选 allowBillable；接收完整请求后重新读取状态，测试完成再比对完整原记录（包括同名删除重建），网络期间不持有写锁。并行窗口和旧 SSH 路由共用按别名的测试锁。超时/取消不重试。返回结果只保留固定说明与分类，不返回账号身份、资源元信息或远端错误正文。

## 官方资料

- [AWS STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)：只读身份响应；不要求特定 IAM 权限。
- [S3 ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)：列表权限、MaxKeys、Prefix 和响应；HTTP 200 本身不保证有效协议响应。
- [Docker Engine API v1.45](https://docs.docker.com/reference/api/engine/version/v1.45/)：Engine 版本接口。实际路径仍使用连接中保存的 API 版本。
- [CNCF Distribution HTTP API V2](https://distribution.github.io/distribution/spec/api/)：基础 `/v2/` 检查与版本头；鉴权和授权具有独立语义。
- [Kubernetes API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)：列表 limit/continue；探针不会读取后续页。
- [Kubernetes authentication](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)：身份认证与访问权限需要分别判断。
- Git 的资料与安全边界另见 [Git 探针记录](git-connection-test.md)。

Redis 官方 PING 页面本轮抓取超时；本轮只沿用已有 Redis 适配器的 PING 操作，未将抓取失败描述为新文档证据。

## 验证证据

`tests/connection-test.test.ts` 使用临时 Store、合成密码、loopback HTTP/SDK 响应器验证计划覆盖、固定只读参数、任意 200 误判、401/403/429、AWS SDK 实际错误分类、S3 显式确认、Kubernetes 单页范围、秘密正文丢弃、管理/执行角色、重复请求、取消、revision 变更和慢上传期间修改。数据库命令通过适配器 stub 检查；它不替代真实数据库或认证机制验收。

`tests/git-connection-test.test.ts`、`tests/ssh-connection-test*.test.ts` 与已有 Cloud/Container 安全回归另行覆盖 TLS、固定目标、重定向、SSH 指纹、通道数量和取消。所有证据都是合成测试，不代表任一真实提供商已经连接成功。
