# 豆包 / 火山方舟连接测试核验

核验日期：2026-10-25。仅阅读公开官方资料；没有读取真实凭据、访问用户账号或发起真实鉴权、生成、收费请求。本记录对应本地合成回归，不证明任何实际账号已开通模型。

## 鉴权与只读替代方案

当前连接使用北京方舟数据面 `https://ark.cn-beijing.volces.com/api/v3`，普通 API Key 以 Bearer 发送。模型及接入点管理属于另一个管控面，不能将该 Key 当作 AK/SK，不能为了测试偷偷更换目标地址或鉴权种类。[Base URL 及鉴权](https://www.volcengine.com/docs/ark/base-url-and-authentication)

官方 `ListModelActivations` 能查询模型开通、价格及额度，但文档明确只接受 Access Key；`ListModelRateLimit` 同样如此。此处不增加 AK/SK 凭据，不调用这些管控接口。[查询模型开通列表](https://ark.volcengine.com/region:cn-beijing/docs/list-model-activations-api.md)、[查询模型限流](https://ark.volcengine.com/region:cn-beijing/docs/list-model-rate-limit-api.md)

官方另有 `POST /api/v3/tokenization`，使用 API Key、模型 ID 和文本，返回分词结果。它可作为限定分词接口的鉴权验证思路，但不是公开模型目录，也不证明生成权限。此次读取的页面没有明确该接口的免费承诺或下述型号的支持清单，因此本轮没有将其当作通用免费探针，也没有据此断言方舟不存在其他鉴权接口。[分词 API](https://www.volcengine.com/docs/ark/tokenization-api)

本轮提供用户明确选择模型后的一次最小生成测试；不查询公开 `/models` 来冒充凭据有效，不自动挑选模型，不使用未核实的自定义推理接入点或其他地域。

## 已核实的候选型号与费用

两个具体 ID 均列在官方模型列表中，支持文本生成。名单表示官方提供该型号，不代表当前账户已有权限。用户需要从这两个选项中明确选择；没有默认型号。[官方模型列表](https://www.volcengine.com/docs/ark/model-list)

| 模型 ID | 显示名称 | 输入，元 / 百万 token | 输出，元 / 百万 token |
| --- | --- | ---: | ---: |
| `doubao-seed-2-0-mini-260428` | Doubao Seed 2.0 Mini | 0.2 | 2.0 |
| `doubao-seed-2-0-lite-260428` | Doubao Seed 2.0 Lite | 0.6 | 3.6 |

表格取自 2026-10-25 官方“在线推理（常规）”、非音频文本输入 `[0, 32K]` 区间，不混用低延迟、低优或批量价格。固定请求的输出部分最多 16 token，按表格计算分别不超过 0.000032 / 0.0000576 元；还需加上服务商实际计算的输入费用。该计算只是公开价格下的估算，不能当成账户金额硬上限；实际结算受账户、现价及服务商规则影响。[模型价格](https://www.volcengine.com/docs/ark/model-pricing)

## 固定请求与确认边界

仅精确支持保存的 HTTPS 北京域名、默认端口、`/api/v3` 前缀和 Bearer 鉴权。界面只提交列表中的 `model`、本次费用确认和当前 revision；不允许自定义提示词、请求体、路径、域名、请求数或输出限制。模型选择不写回连接配置、文档或执行规则。

请求在可信 worker 内部加入已保存凭据，固定为：

```json
{
  "model": "<用户明确选择的上述具体模型 ID>",
  "messages": [{ "role": "user", "content": "Reply OK." }],
  "max_completion_tokens": 16,
  "thinking": { "type": "disabled" },
  "stream": false,
  "service_tier": "default"
}
```

目标为 `POST /api/v3/chat/completions`。`service_tier: default` 指定常规档；不启动工具、联网、图片、音频或长会话。`max_completion_tokens` 包含回答及思维链，不能与 `max_tokens` 同传；官方给出的范围为 1–65536。[Chat API](https://www.volcengine.com/docs/ark/chat-api)

官方上下文说明：250528 及以后版本的大语言模型默认支持 `max_completion_tokens`，有单列例外；这里两个型号不属例外。[上下文管理](https://www.volcengine.com/docs/ark/context-management)

这两个具体型号均支持关闭思考；本轮固定 `thinking.type: disabled`，避免默认思考消耗。[深度思考](https://www.volcengine.com/docs/ark/deep-thinking)

费用确认在准备上游鉴权之前检查，执行器再次检查；服务原有的本地脱敏上下文仍由可信 worker 管理。未知或未选型号、缺少确认、空密钥、停用连接都不会发请求。请求最多一次，30 秒超时，取消中止本地等待；不自动重试、切型号或降级请求。请求一旦发出，取消或超时不能证明服务商没有受理、生成或计费。

## 成功与错误判定

成功要求 JSON 为 `chat.completion`，返回模型与选定模型一致，只有一条 assistant 文本回答，结束原因为正常结束或达到长度限制，usage 为非负整数且合计一致，生成输出在 1–16 token 内。官方将响应 `model` 定义为实际使用的模型名称及版本，`total_tokens` 为输入加输出；因此返回不同型号（包括服务商降级型号）不会被当作所选型号通过。任意 HTTP 200、模型目录、空正文、错误 JSON或超限用量均不能报告通过。结果不返回上游内容、请求 ID、token 用量、凭据或账户信息，仅说明所选模型的一次调用成功。

错误仅检查固定结构化代码，不展示原始错误信息：[官方错误码](https://www.volcengine.com/docs/ark/error-codes)

| 上游状态 / 代码 | 本地分类 |
| --- | --- |
| 401 / `AuthenticationError` | 鉴权失败 |
| 403 / `AccountOverdueError` | 余额 / 计费状态 |
| 403 / `AccessDenied` | 权限 |
| 404 / `ModelNotOpen` | 模型未开通 |
| 404 / `InvalidEndpointOrModel.NotFound` | 模型不存在或无权访问，不能断定 Key 无效 |
| 404 / `InvalidEndpointOrModel.ModelIDAccessDisabled` | 当前账号不允许直接模型 ID，需在控制台核对 |
| 429 / `QuotaExceeded` | 额度耗尽或限制 |
| 429 / RPM、TPM 代码 | 限流 |
| 其他接口拒绝、异常响应 | 协议异常 |
| DNS、TLS、连接失败 | 网络问题 |

## 验证边界

`tests/http-connection-test.test.ts` 使用合成密钥、mock DNS 和 HTTPS，无真实服务请求。覆盖精确目标、两个型号、固定请求体、确认守卫、缺密钥、停用、取消、超时、重定向、私网解析、模型不一致、非生成 HTTP 200、输出上限、鉴权 / 权限 / 余额 / 额度 / 限流分类，以及上游回显秘密不进入结果和错误。

真实账户的 Key、模型权限、余额、最终账单和服务可用性均未实测。真实调用须先明确具体型号、接收方、凭据传输用途和费用接受范围；本研究与合成回归不构成该调用授权。
