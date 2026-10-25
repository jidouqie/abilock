# 2.2.11 API 连接测试依据

核对日期：2026-10-25。此记录保留本轮官方接口调研及实现边界。实际实现见 `src/http-connection-test.ts`。本轮没有读取真实凭据，没有调用任何真实服务商接口，也没有产生模型费用；验证使用假的 DNS/HTTPS 响应与合成密钥。

## 测试含义

管理页的测试使用代码内固定的官方只读接口。调用不依赖手册内容，也不写入或扩大业务接口规则。目标必须匹配确切的官方 HTTPS 主机、端口、已保存的基础路径及鉴权类型；不将自定义代理、兼容网关或相似域名识别成原厂。协议响应的结构、错误信封及 HTTP 状态均须检查。仅收到 HTTP 200、HTML 或任意 JSON 不算鉴权通过。

返回“只读接口鉴权已通过”只涵盖当前凭据对该只读接口的权限，不保证生成模型、其他接口、余额或套餐可用。模型目录不发起推理，不发送提示词，不选择模型，不产生生成费用。余额查询只在本地检查可用状态，数值不返回 UI 或日志。

## 官方证据与适配

| 提供商 | 保存地址范围与只读请求 | 鉴权及响应依据 | 实现边界 |
|---|---|---|---|
| OpenAI | `api.openai.com`，根路径或 `/v1`；`GET /v1/models` | [官方 List models](https://developers.openai.com/api/reference/resources/models/methods/list) 的 Bearer 示例及 `object: list`、模型数组 | 仅 Bearer；验证列表结构，不调用模型 |
| OpenRouter | `openrouter.ai`，根路径或 `/api/v1`；`GET /api/v1/key` | [Get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)、[Limits](https://openrouter.ai/docs/api_reference/limits) 明确要求 Bearer，并返回当前密钥的 `data` 对象 | 核对 `label`、`is_free_tier`、`usage`、`limit`、`limit_remaining` 类型；额度为零或负数单独报告。标签、用户信息和额度数值均不进入结果。仅支持已核验的主站，不推断 EU 端点具有相同账户接口 |
| DeepSeek | `api.deepseek.com` 根路径使用 `GET /user/balance` | [账户余额](https://api-docs.deepseek.com/api/get-user-balance/)、[首次调用](https://api-docs.deepseek.com/) | 核对 `is_available` 与余额结构；不足时报告鉴权通过但余额不足。保存为 `/v1` 的地址暂不支持；不跳出其基础路径访问账户接口 |
| Anthropic | `api.anthropic.com`，根路径或 `/v1`；`GET /v1/models?limit=1` | [官方 List Models](https://platform.claude.com/docs/en/api/models/list)、[API overview](https://platform.claude.com/docs/en/api/overview) | Bearer 或已保存的 `x-api-key`；按官方示例发送 `anthropic-version: 2026-10-21`。该值是请求版本，并非网页更新时间。校验 `data` 模型数组与 `has_more`。没有添加工作区身份配置；需要指定工作区的密钥可能得到权限/协议错误 |
| Google Gemini | `generativelanguage.googleapis.com`，根路径或 `/v1beta`；`GET /v1beta/models?pageSize=1` | [官方 Models API](https://ai.google.dev/api/models)、[API key 使用方式](https://ai.google.dev/gemini-api/docs/api-key) | 仅已保存的 `key` 查询参数或 `x-goog-api-key`；核对模型资源列表，不发起 `generateContent` |
| SiliconFlow | `api.siliconflow.cn`，根路径或 `/v1`；`GET /v1/models` | [官方 List Models](https://docs.siliconflow.cn/docs/api/models-get) 明确要求 Bearer，并列出模型数组响应 | 不用已退役的 `/user/info`；[官方更新公告](https://docs.siliconflow.cn/docs/release-notes/overview) 记录该接口于 2026-08-14 停止服务 |
| 阿里云百炼 | 文档列出的 DashScope 及指定地域工作区主机，根路径或 `/api/v1`；`GET /api/v1/models?page_no=1&page_size=1` | [官方查询模型列表](https://help.aliyun.com/zh/model-studio/list-models) 的 Bearer 要求及 `success`、`output.total`、`output.models` 响应；[地域域名](https://help.aliyun.com/zh/model-studio/regions) | 不跨地域换主机，不把 `/compatible-mode/v1` 重写到路径外。该兼容路径暂不支持此只读测试 |

火山方舟的[官方鉴权说明](https://www.volcengine.com/docs/ark/base-url-and-authentication)区分模型调用与管控接口的鉴权。没有把管控面接口或猜测的 `/models` 用于数据面 API Key。最初的只读适配不包含方舟；2026-10-25 增加北京地域的显式选择模型、单次生成与费用确认，依据见[豆包专项](doubao-connection-test.md)。自定义服务、其他未适配地址、非标准鉴权及未核验基础路径仍返回“暂无已核验的只读测试方案”，不发网络请求。不能把“OpenAI 兼容”当作其模型列表一定鉴权的证据。

DeepSeek 当前[模型列表文档](https://api-docs.deepseek.com/api/list-models/)列出响应形状，但本轮取得的内容没有明确列出该目录的鉴权要求。因此不使用模型列表证明 DeepSeek 密钥有效，也不由聊天接口的 `/v1` 兼容性推断账户接口路径。此项属于保守未适配范围。

OpenRouter 当前官方接口是 `/api/v1/key`，本轮不使用旧 `/auth/key`。不把公共模型目录当作密钥有效的证据；[credits 接口](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)要求管理密钥，不能用来验证普通模型 API Key。`/key` 的额度反映密钥限制，不证明整个账户余额、组织预算或某个模型可用。测试不选择模型、不发送提示词，仅查询密钥元信息，生成费用上限为 0；这不是所有未来接口价格永久免费的承诺。未来[聊天调用](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)可能按模型及提供商收费，须另行确定模型与总预算。空密钥在请求开始前拒绝；页面沿用“未配置/请先保存凭据”的禁测状态。

只读适配的测试结果 `model` 为空，费用层次表示没有发起生成。豆包新增方案的初始模型为空，由用户从核验名单选择并确认后才执行一次；成功结果包含此次选择的模型，验证层次为 `generation`。其他服务不自动提供计费回退。没有真实凭据传输或收费验收；请求和 token 限制不能假装人民币账单硬上限。

## 错误与资源边界

- 401/已知鉴权错误、403/权限、402/余额额度、429/限流、响应格式、DNS/TLS/网络、目标重定向、超时和取消分别使用静态分类；不回传服务商正文、错误文本、账号信息、响应头或密钥片段。
- 沿用固定 DNS 结果与网络目标校验。只发一次 GET，不跟随重定向，不自动重试，不运行鉴权插件，不接受调用方指定目标、方法、路径、模型或正文。
- 30 秒上限覆盖 DNS、连接和响应体；响应最多 1 MiB，拒绝非预期编码。取消会销毁连接；读取结果后也主动关闭响应。
- `tests/http-connection-test.test.ts` 验证各提供商形状、HTTP 200 错误正文、权限/余额/限流分类、未知服务不请求、固定路径、重复请求计数、取消、超时原因、重定向、超大响应、DNS 边界和秘密不进入结果。全部为 mock，不代表真实商家连通、余额、权限或计费验收。
