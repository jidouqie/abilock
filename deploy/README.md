# 显式远程部署模板

本文描述用户明确选择远程模式时的部署模板，不是本地 Skill 安装的必需步骤，也不是已经完成的部署。模板需经用户审阅后在可信服务身份或独立主机上使用。不要给 AI 同宿主用户无限 shell、Docker socket 或 core 的目录/环境；否则容器本身不构成保护。

npm 包携带这份说明和无秘密模板，便于审阅其中的边界。实际构建需要包含根 `package-lock.json` 的完整源码工作区；npm 的安装包不携带该锁文件，不能把包内模板视为已可直接构建的独立部署包。本文的部署命令只适用于满足这些条件并完成初始化方案的源码工作区。

## 最小边界

```text
用户浏览器 ── 本机/SSH 隧道 ── core:4317 /admin
AI / abl ── TLS 执行入口 ── execution-gateway ── core:4318 /v1 ── 可信厂商 API
                                      执行令牌          主密钥 + 上游秘密
```

core 的持久卷只挂给 core；网关不导入 Store、不知道管理凭据/主密钥，只接受明确允许的执行只读、说明书、业务调用及 SSH 终端路由。core 的管理端即使收到执行令牌也返回 401。compose 的 core-private 是 internal 网络；AI 不能加入它。outbound 只给 core，以便请求公开厂商 API。execution 为 AI 可接入的专用网络；如 AI 另在沙箱容器，用户需显式将其接入 execution，不能接入其他两个网络。

## 用户操作

Abilock 仅使用 `ABILOCK_*` 环境变量。默认持久目录 `~/.abilock` 是服务身份的私有数据目录，CLI 不读取它；继续使用旧数据时由可信用户设置 `ABILOCK_DATA_DIR` 指向原位置，不自动搬迁。由用户先在可信服务环境参照 `.env.example` 配置 `.env`，自行保管主密钥与执行能力令牌。管理密码仅在 UI 设置，新实例不需要 `ABILOCK_ADMIN_TOKEN`，没有默认密码。本模板不生成真实凭据。不要将服务 `.env` 交给 AI。

**先规划首次设置路径，不能直接把宿主端口映射当作初始化流程。** 首次设置或密码恢复检查 core 实际看到的 loopback socket、Host 和 Origin；`ABILOCK_ISOLATED_BIND=1` 不会豁免。容器发布 `127.0.0.1:4317:4317` 后，宿主浏览器的连接通常从容器网桥到达，不满足该检查。模板没有可信容器内浏览器或 bootstrap 工具，不能保证新建容器启动后可从宿主首次设置密码，也不能用 curl/API 脚本代替 UI 或放松检查。

优先在独立主机/可信服务身份的本机 loopback UI 完成初设，再由可信用户依据实际网络、数据存储和访问控制设计隔离部署；若采用容器，须具备可信容器内 loopback 浏览器 UI 能力，并自行验证初始化、登录和恢复路径。迁移已有数据必须保留完整数据目录、原主密钥和 `admin-auth.v2`。模板没有提供可直接替代上述步骤的自动容器初始化方案。

以下命令仅作为经过用户审阅、完成初始化方案后管理模板的参考，本模板默认只把管理/网关端口发布到宿主 loopback：

```sh
docker compose --env-file .env -f deploy/compose.yaml config
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

`config` 会显示展开的秘密，必须只在用户可信终端执行，不要发输出给 AI。命令示例不证明部署成功；需要对实际身份、权限、网络和初始化路径另行验收。

独立主机：管理页面可通过用户自己的 SSH 隧道连接 4317；AI 只连接用户部署的 HTTPS 执行网关。外部 TLS、主机访问控制由用户部署流程配置。不要把管理端反向代理到 AI 可访问的同一入口。

当前管理服务和 UI 登录只实现 HTTP 同源流程；CLI 对 `ABILOCK_ADMIN_URL` 接受 HTTPS 仅是公开地址校验，不表示已经支持 HTTPS 管理反向代理。管理入口应使用受控本机/SSH loopback 访问，HTTPS 执行网关由部署环境另行配置。

同机受限身份：必须由用户确认并设置服务身份、文件权限、沙箱网络与进程访问边界。本远程模板不自动创建用户、修改权限或启动系统服务；它与 macOS/Windows 的本地受保护安装器不同。仅运行两个本机端口不能满足强隔离。

## 验证证据与限制

`tests/isolation.test.ts` 验证执行网关的路由白名单、执行令牌不能登录管理端、源码不读取 Store/admin/master 以及 compose 网关无持久卷/admin/master 配置。该测试使用 loopback mock，不是实际 Docker/OS 权限验收。

部署后用户仍需从真实 AI 身份验证：看不到服务文件/环境/进程，不能访问管理/core 网络或 Docker socket，执行端正常，管理凭据与执行凭据不能互换。没有完成这些条件前，不称为强隔离。

管理密码遗忘时由可信用户停止服务，备份完整数据后重命名 `admin-auth.json`，保留 `admin-auth.v2`、配置和主密钥，再从真正满足 loopback 条件的 UI 重新设置。这个流程仅适用于显式服务部署，不适用于 macOS 本地隔离 CLI。不要删迁移标记，不提供 CLI 重置，也不要把恢复过程或认证值发送给 AI。参见[密码与数据恢复](../docs/security/recovery.md)。

作者：[吉豆茄 jidouqie](https://v.douyin.com/oApPI_L9avQ)。

## 多协议新增边界

Abilock支持受控原生协议子集，见[能力矩阵](../docs/capabilities.md)和各协议文档。管理身份声明independent-target只表示对接目标承诺，不会创建OS隔离。实际连接DNS固定后拒绝broker本机IP、loopback、link-local、metadata；远端内网业务服务可用，必须与broker管理身份隔离。SSH shell/数据库高权限/Docker daemon/Kubernetes/Git server不能读取broker的文件、环境或进程。不能以字段勾选宣称强隔离。

仅信任实际接收鉴权的业务服务；有限输出脱敏无法防止恶意receiver任意重新编码秘密。Git压缩pack/checkout/本地工作区、终端队列和原生协议仍需可信worker的CPU/内存/磁盘/进程配额；模板未部署资源隔离。SSH不提供本机ProxyCommand/LocalCommand/agent，Git隔绝全局config/hooks/helper/filter，数据库拒绝本机元命令与LOCAL INFILE，AWS不读profile/不导出credentials，Kubernetes不执行kubeconfig插件，Docker不调用credential helper。

协议测试的临时 Docker 环境使用合成凭据、loopback 和专属标签，仅验证协议行为；不能据此推断本远程模板已完成 AI/服务隔离部署。源码测试与实际部署验收应分别记录。
