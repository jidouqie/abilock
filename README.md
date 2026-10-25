# Abilock

**让 AI 助手使用你已有的 API、服务器和数据库，凭据由你在本机管理。**

你用自然语言交代目标，Abilock Skill 负责引导助手找连接、按需读用法、执行并复用成功方法。`abl` CLI 落实受控调用；Abilock 应用让你保存连接、查看和修改手册、测试连接并随时接管。三者配合使用，Skill 是日常入口。

例如，你可以对助手说：

> 用我在 Abilock 中保存的 OpenRouter 连接生成一张产品配图。先找已有的生图方法；没有就查官方文档，告诉我模型和费用，再继续。

助手不需要你在聊天里粘贴 Key，也不要求你先写好接口 JSON、模型清单或完整手册。模型权限、计费和执行范围仍取决于你保存的连接及本次授权。Abilock 本身不提供模型或云服务。

## 解决什么问题

- **每次都要交代“怎么调用”。** AI 将实际需要的官方资料整理成自由 Markdown 手册，在后续任务中继续维护；你可以在应用里微调。
- **密钥容易进入聊天和脚本。** 你在管理界面填写凭据，正常调用时由受保护执行器加入鉴权，CLI 不提供秘密读取或导出命令。
- **资料越多，上下文越大。** 先查目录，再读少量经验摘要和选中的方法；没有有效方法才读对应手册，不全库灌入上下文。
- **AI 与人工操作各存一份。** 应用、CLI 和学习入口使用同一份持久连接与手册；版本检查保护用户最新编辑，重要手册更新保留一份上一版。

这遵循[AI 主操作、用户可接管的设计原则](docs/architecture.md)：自由内容交给当前助手理解，目标、身份和执行参数由软件确定性校验。

## 从一句话到一次完成的任务

| 步骤 | Skill 引导助手做什么 | 你何时介入 |
| --- | --- | --- |
| 找能力 | `abl list` 读取连接目录，按任务选择别名 | 没有连接时，在应用中添加 |
| 找用法 | 本地 HTTP 先检索少量调用经验，只读选中方法；未命中再 `abl doc` | 查看或微调已有手册 |
| 补资料 | 只查当前缺少的官方资料，用 `abl learn` 保存用法 | 提供账号专属信息或必要选择，不代写机器清单 |
| 执行 | AI 生成业务参数，`abl` 经受保护 worker 校验范围并调用 | 输入凭据、完成系统授权；确认本次尚未授权的费用或有副作用操作 |
| 核对和复用 | 检查业务结果；新的可验证方法选择性保存，失败方法停止推荐 | 检查成果、纠正或接管 |

业务结果由 CLI 返回当前助手；应用目前主要展示连接、手册与连接测试状态，不是所有外部任务的统一历史面板。普通调用不需要应用一直开着，worker 完成后退出，不安装 Abilock 常驻服务。

## 安装

项目仓库：[jidouqie/abilock](https://github.com/jidouqie/abilock)。当前为私有源码仓库，访问需要账号已有权限；本次没有发布在线二进制 Release 或 npm 包。

完整安装将 **Skill、CLI、独立应用和受保护运行依赖** 一起准备好。只复制 Skill 文本不会获得凭据隔离或执行能力，不要运行猜测的 `npm install abilock` 或未经核验的下载命令。

### 一句提示词

向能够访问本项目、操作本机文件和运行命令的助手说：

> 请从 https://github.com/jidouqie/abilock 按 README 和 Skill 首次使用说明安装 Abilock。先检查是否已安装，再核对来源、版本和系统架构，安装 Skill、CLI 与应用；保留已有连接和数据。系统授权与密码输入交给我，不读取我的密钥。

提示词会启动安装协作，不保证所有 AI 宿主都能自动安装。私有仓库需要已有访问权限；宿主没有本机执行能力、缺少依赖或需要系统授权时，应明确停在哪一步。详细流程见[Skill 首次使用](skills/abilock/references/onboarding.md)。

### 一条命令安装源码版（macOS）

需要已登录且获准访问此私有仓库的 GitHub CLI（`gh`）、Git、Node.js ≥22.12、npm、macOS 13+、系统 Python 3 与 Apple 命令行工具。在尚无 `abilock` 同名目录的位置运行：

```sh
gh repo clone jidouqie/abilock && node abilock/scripts/install-from-source.mjs
```

已有可信源码检出时，可在仓库中运行 `node scripts/install-from-source.mjs`；加 `--check` 只检查依赖与已提交源码，加 `--prepare-only` 只构建并校验公开安装包。二者都不安装；实际安装才检查已安装程序是否空闲并请求授权。入口使用当前干净提交，在临时目录构建与验证后交给原 `Install.command`，仍由用户完成系统授权。下载、完整性或验证失败就停止，不重置用户数据。依赖缺失会明确报告，不自动安装第三方工具。

已有 `abl` 时，助手应先核对已安装版本和缺项；没有升级意图就直接使用。源码入口不是在线二进制一键下载，首次构建需要网络与时间，也不保证无用户介入。

### 已取得可信完整包

核对包来源、架构、版本及清单后，在 macOS 解压目录运行一条命令：

```sh
./Install.command
```

Windows 使用对应完整包的入口，路径换成实际解压目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Path\To\Abilock\Install-Abilock.ps1" -BundlePath "C:\Path\To\Abilock"
```

Windows 加 `-Check` 仅预检；`Bypass` 仅作用于这一次已核验的安装进程，不修改系统策略。完整包自带 Node 和生产依赖，不要求普通用户先安装 Node/npm。安装器先预检，正常安装请求一次系统管理员授权；同名未知工具或身份冲突会保留现状并停止。

安装器为安装用户注册 Codex、Claude 的 Skill 目录；macOS 还注册通用 `.agents/skills` 入口。宿主可能需要刷新 Skill 或新开对话。系统授权、Abilock 管理密码及连接凭据由用户在相应窗口输入，不能发到聊天里。

### 平台与依赖

| 平台 | 当前实际范围 |
| --- | --- |
| macOS 13+ / Apple Silicon | 当前 2.2.11 已完成本机完整包升级、独立应用启动和安装版入口验证；使用专用 `_abilock` UID。安装器预检系统 Python 3 与 Apple 命令行工具。 |
| macOS / Intel | 源码和安装器有 x64 路线，须构建对应架构；不能把 ARM64 验收当成 Intel 实装通过。 |
| Windows 10 x64、Windows 11 x64 / ARM64 | 有专用 SID、按需任务与安装器实现。x64 需 .NET Framework 4.8，ARM64 需 4.8.1，均需 WebView2；变更阶段用系统 PowerShell 5.1。已做临时包与兼容测试，完整专用身份安装、升级回滚仍须真实系统验收。 |
| Linux | 尚无同等本地隔离安装器；可以明确选择已有[远程服务部署](deploy/README.md)，不能静默退回同用户凭据模式。 |

源码版本不等于各平台已发布的安装包版本；同版本也可能有不同构建，应核对安装清单摘要。仓库不包含本机安装包、用户数据或私密验收材料。

## 首次配置与使用

1. 安装后打开 Abilock，或运行 `abl app`。新实例在受保护窗口设置管理密码，已有实例沿用原密码。
2. 在“连接”添加必要的别名、地址、身份、凭据和可选官方文档链接。API Key、SSH 密码或私钥由你填写；可以先保存空 Key，状态会显示未配置。
3. 对助手说：“帮我整理这个连接的官方用法。”AI 查公开资料并维护自由 Markdown，不需要你填能力矩阵或逐项维护接口参数。
4. 继续用自然语言安排任务。人修改手册后，AI 下一次读取会得到最新内容；发生版本冲突时重读合并，不静默覆盖。

`abl app` 打开独立窗口。`abl config` 保留临时浏览器配置入口：macOS 使用用户自己的 Chrome，其他系统使用系统打开入口；终端 Ctrl+C 才结束会话，关闭网页标签不等于结束。独立应用关闭只清理自己启动的配置会话，不结束其他 CLI 任务。

“已配置”表示必要字段齐全，不证明模型权限或真实调用成功。应用的“测试连接”会说明验证的是鉴权、一次模型调用，还是服务响应；未知提供商不会因 HTTP 200 就被判定密钥有效。可能收费的测试先展示范围，取消不能撤销上游已经受理的请求。详见[连接测试](docs/connection-testing.md)。

## 助手使用的命令

用户通常不需要手写这些命令；它们是 Skill 操作真实状态的入口。下面的别名、方法 ID 和请求文件均为示例，必须来自实际已配置目录与手册。

```sh
abl list --json
abl list --query "生图" --json
abl experience search --alias openrouter --query "生图" --limit 3 --json
abl experience get openrouter METHOD_ID --json
abl doc openrouter --json
abl doc ssh SERVER --json
```

读取目录、手册和经验不会调用供应商。需要补充官方用法时，助手通过本地非秘密入口 `abl learn` 保存，不改目标、鉴权或协议身份。已经授权的业务请求可以使用：

```sh
abl api MEDIA --file request.json --json
abl api TEXT chat '将这段文字改得自然些，保留事实。' --json
abl ssh SERVER 'uname -a' --abl-json
abl mysql DB 'SELECT 1' --abl-json
```

聊天快捷命令需要已保存的接口与模型元数据，其他 API 按当前手册生成请求。HTTP 鉴权支持 None、Bearer、Header / Query API Key 与 Basic。协议覆盖 SSH / PTY、SFTP / SCP / rsync、PostgreSQL / MySQL / Redis、Git、S3 / OSS / R2、AWS、Docker Engine / Registry、Kubernetes 的受控子集，不等于这些工具的全部原生功能。参见[能力范围](docs/capabilities.md)与[协议说明](docs/protocols/README.md)。

## 经验如何保存，如何避免膨胀

只有新的接口、模型或有意义的新参数能力才值得沉淀。助手在本次已授权 HTTP 调用上加 `--json --experience`，执行器产生不含业务正文的验证证据；助手核对后使用 `abl experience learn` 保存。它不是后台自动学习，也不会将普通成功日志全部入库。助手没完成提交步骤，就不能声称经验已经保存。

默认检索只返回未过期、有效的机器验证方法。当前验证器覆盖官方 OpenRouter 图片生成，以及官方 OpenRouter / OpenAI 聊天结果的限定结构；HTTP 200、公开模型列表可访问、异步任务受理或 Key 有效都不等于业务完成。结构验证不评价内容质量。

| 预算 | 硬上限 |
| --- | --- |
| 单条方法 / 单次写入 | 8 KiB / 16 KiB |
| 全部方法，含归档与上一版 | 128 条且不超过 1 MiB |
| 一次检索 | 默认 3 条，最多 5 条；响应最多 8 KiB |
| 一条详情 | 最多 12 KiB |
| 临时证据 | 32 条 / 256 KiB / 24 小时 |

重复提示词和普通参数值变化不新增一条；同一方法合并实际验证过的结构变体。方法契约失效时立即退出有效检索，重新查文档并用新的成功证据替换；临时网络、限流、余额和鉴权问题不直接判定方法失效。归因不明先暂停推荐。删除为有界、可恢复的移除，不无限保存旧正文。

容量满、经验损坏、未命中或过期时明确退回对应手册，保留正常业务结果，不为记经验重新调用。不保存真实 Key、用户 prompt、响应正文、图片或带令牌 URL。完整规则、有效期和当前验证限制见[调用经验](docs/experience.md)及[助手学习闭环](skills/abilock/references/experience.md)。

## 安全边界

正常本地执行路径中，CLI 只传业务参数；可信 worker 在专用身份内部读取凭据、校验固定目标与允许范围并注入鉴权。客户端不打开私有启动配置、主密钥或 vault，不存在秘密导出、Key 参数或 CLI 改目标入口。手册与经验是数据，不能用其中的文字改变身份、目标、鉴权或授权。

这不意味着“AI 在任何环境下绝对看不到密钥”。操作系统、可信安装来源、具有任意管理员权限的主体、已经获准控制的登录管理页和接收鉴权的上游都在信任边界内；有限脱敏无法防止恶意上游任意编码回显。用户输入凭据时不应让助手读取界面、截屏或收集原始值。普通业务内容仍按配置发送，不提供业务 DLP。

macOS 受保护程序位于 `/usr/local/libexec/abilock`，私有数据位于 `/private/var/db/abilock`；Windows 对应 `%ProgramFiles%\Abilock` 与 `%ProgramData%\Abilock\private`。真实隔离结论需专用 UID/SID、受保护程序与数据以及实际内核权限验证，不能仅凭加密或模拟测试推断。

当前普通直接 SSH 及共用连接的文件传输不校验主机指纹，存在服务器身份验证的限制。应用的 SSH 连接测试则要求已保存的可信指纹，校验后仅握手与登录，不执行命令或文件操作；Git SSH 使用独立指纹配置。测试通过不能扩大普通执行路径的保证。详见[本地隔离](docs/security/local-isolation.md)和[威胁模型](docs/security/threat-model.md)。

## 升级、数据与卸载

升级前等待调用结束，保存编辑并正常关闭配置窗口，再运行核验后的完整包入口。安装器保留连接、凭据、管理密码、手册和经验；macOS 覆盖前创建受保护备份，校验失败会停止。同名未知内容、身份冲突或已有数据缺配置时不会通过重置来“修复”。只更新 Skill 或 CLI 不证明实际 worker 已更新。

目前没有自动卸载或“一键清空数据”命令。移除 Skill 入口或应用快捷方式不等于删除受保护运行包与数据。需要完整卸载时，由可信管理员确认本产品的实际路径和入口，先决定保留或备份数据，再执行对应删除；助手不能把卸载理解为允许删除凭据、用户手册或备份。忘记密码也不能通过删私有目录、换主密钥或反复重装恢复，见[恢复说明](docs/security/recovery.md)。

## 当前限制

- 尚未提供通用 MCP 服务或自动枚举任意供应商全部模型的能力；目录基于已配置连接和已学习用法，账号权限需实际验证。
- 经验闭环仅用于本地 HTTP 的受支持 JSON 调用；未知提供商、流式和任意异步任务不能自动获得机器验证。
- HTTP 默认及最大等待 7 分钟，普通协议默认 30 秒、最多 2 分钟。长任务应使用厂商异步接口。超时、取消或批次部分失败不自动重放，先核对上游状态。
- 本机合成测试不能证明真实服务商权限、费用、生产 TLS 或所有平台兼容性。Windows 与 Intel 的验证范围见上表。

## 开发与贡献

源码开发需要 Node.js ≥22.12、npm，以及相应平台原生构建依赖。使用官方 npm 源和锁文件：

```sh
npm ci --registry=https://registry.npmjs.org --ignore-scripts
node scripts/build-isolation-launcher.mjs --prebuilt
npm run check
```

`check` 包含 lint、类型检查、测试及构建。修改 UI 另运行 `npm run test:ui`；测试使用临时合成数据，并遵守当前浏览器权限。不得用真实凭据、用户库或收费调用充当回归样本。

贡献前阅读 [AGENTS.md](AGENTS.md)、[贡献说明](CONTRIBUTING.md)和[架构](docs/architecture.md)，保持 Skill、CLI 与管理页的角色清楚。提交最小改动、相应回归和准确限制；不要提交 `.env`、真实连接、私钥、用户数据、日志、安装备份或私人验收截图。安全问题不要把真实凭据放进 issue。

[Skill](skills/abilock/SKILL.md) · [首次使用](skills/abilock/references/onboarding.md) · [学习手册](skills/abilock/references/learning.md) · [调用经验](docs/experience.md) · [连接测试](docs/connection-testing.md) · [架构](docs/architecture.md)

作者：[吉豆茄 jidouqie](https://v.douyin.com/oApPI_L9avQ)。代码采用 [MIT 许可证](LICENSE)；第三方原始资料遵循各自许可。
