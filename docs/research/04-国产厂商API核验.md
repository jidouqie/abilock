# 国内厂商的实际 API 产品核验

日期：2026-10-06 UTC。只读取公开官方资料，没有登录、开通产品、试调接口或查询用户凭据。这里确认的是产品/API 文档存在及协议形态，不代表任意用户已拥有所需权限。

## 优先接入的真实产品

| 厂商 / 产品 | 本次确认 | 鉴权与适配判断 | 官方证据 |
| --- | --- | --- | --- |
| DeepSeek 开放 API | 有开发平台和聊天 API；官方首页目前列出 OpenAI/Anthropic 兼容形态 | Bearer API Key，适合第一条固定 HTTP 调用；不要把旧模型名称永久写死 | [调用入口](https://api-docs.deepseek.com/)、[鉴权](https://api-docs.deepseek.com/api/deepseek-api/) |
| 火山方舟 / 豆包模型服务 | 官方 API 目录确有 Chat、图片、视频、向量化；Chat 正文确认实际 endpoint | 使用方舟开放服务鉴权；保存模型 ID/endpoint、地区和产品类型。不要拿消费端豆包登录态代替 | [Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)、[API Key 文档入口](https://docs.volcengine.com/docs/ark/api-key?lang=zh) |
| 火山方舟视频生成 | 已读创建任务 API 正文；创建为异步，后续查询取得结果 | `submit` 和 `status` 两个动作，不把视频生成硬塞为同步聊天调用 | [创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) |
| 火山方舟图片 / 多模态向量 | Chat 页的官方 API 目录列出独立产品入口 | 已确认目录存在；图片和向量详情的抓取不稳定，不声称已核验其全部字段/当前模型列表 | [图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[多模态向量化](https://docs.volcengine.com/docs/ark/multimodal-vectorization-api?lang=zh) |
| 腾讯混元开放服务 / TokenHub | 混元兼容 API 和 Key 管理正文可读；官方提示功能逐步迁移到 TokenHub | 混元兼容接口用 API Key；旧混元与新 TokenHub 的入口/Key 不应混同。以用户选择的具体服务文档登记 | [混元兼容调用](https://cloud.tencent.com/document/product/1729/111007)、[Key 管理及迁移说明](https://cloud.tencent.com/document/product/1729/111008)、[腾讯官方 TokenHub 公告](https://www.tencent.com/tencent-unveils-hy3-preview-model-enhances-agent-capabilities-and-real-world-usability/) |
| 阿里云百炼 / DashScope | 正文确认 API Key、地域独立接入；有标准和 OpenAI 兼容 API | 连接记录必须保存地域/业务空间；不同地域 Key 与地址不可混用 | [获取与配置 Key](https://help.aliyun.com/zh/model-studio/get-api-key) |
| 百炼文本向量 | 已读同步向量 API 的字段与兼容接口 | 适合第一条非聊天验证；保存模型、维度和地区/空间绑定，而不把一份旧 URL 用于所有空间 | [文本向量同步 API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api) |
| 百炼 Qwen-TTS | 已读非实时 TTS HTTP 请求/响应说明 | Bearer Key；有音色、文字、音频结果和流式模式。先选非实时 HTTP，避免第一轮处理复杂双向协议 | [Qwen-TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api) |
| 百炼 Paraformer | 官方文档提供实时 ASR 接入和事件协议 | 语音识别是独立能力，不保证普通聊天网关支持其完整协议；要增加小 worker | [Paraformer](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-api-reference/)、[模型接入方式](https://help.aliyun.com/zh/model-studio/paraformer-realtime-model-access) |
| 百炼万相视频 | 文生视频 API 正文可读，属于独立生成接口 | 异步任务与结果获取；不硬编码某次调研的模型价格、名称或配额 | [文生视频 API](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference) |
| 腾讯云 CVM 等云 API | 官方签名 v3 文档明确 SecretId/SecretKey、TC3-HMAC-SHA256，并推荐 SDK | 用可信后台官方 SDK 签名；静态 Header 注入不能替代动态签名 | [云 API 签名 v3](https://cloud.tencent.com/document/api/213/30654) |

火山 Chat 正文与视频正文通过直接公开 HTTP 读取核验，浏览工具对这些新文档有时只能返回 JS 页面壳。因此不能把“浏览抓取失败”写成“厂商不存在 API”，也不能把 `200 OK` 写成“字段已验证”。证据状态见 [来源与核验记录](05-来源与核验记录.md)。

## 元宝消费端不作为 API 连接

本次没有发现可据以接入“腾讯元宝消费端通用 API”的官方开发者文档；不能将其列为可配置的通用 API 厂商。这不等于证明腾讯未来不会推出相应能力。

已经确认的腾讯开发者产品是混元开放服务及迁移目的 TokenHub，二者与元宝 App/网页产品不同。也不能从“元宝能选择某模型”推导出同一消费账号、会员或网页登录 Cookie 可以调用该模型的开发 API。接入清单只写用户实际开通的 API 产品名称，不抓取消费端 Cookie、逆向私有接口或把 App 订阅视为 API 额度。

同理，豆包消费端与火山方舟模型服务要分别命名；一个可调用中心连接应记录 API 产品，而不是仅记录聊天 App 品牌。

## 豆包语音：确认入口，细节继续核验

公开数字文档链接已重定向至新版豆包语音文档，包含以下真实产品入口：

- [大模型语音合成 HTTP 单向流式 V3](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)
- [录音文件识别标准版 API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelrecordingfilerecognitionstandardversionAPI?lang=zh)

本次多数读取只得到 JS 页面壳，未完整核验新版本请求头、App/资源标识、计费产品与流式协议。因此**不把旧版 Access Token/AppID 或方舟 Key 擅自套到新语音接口**。正式适配时先补齐指定版本文档；当前可用百炼 Qwen-TTS 的已读 HTTP 文档验证胶水层，再扩展豆包语音。

## 能复用的三类预设

| 类别 | 示例 | 可复用部分 | 必须保留的厂商差异 |
| --- | --- | --- | --- |
| OpenAI 兼容模型 API | DeepSeek、方舟 Chat、混元兼容、百炼部分模型 | HTTP 请求/流式基础、Bearer 注入、schema 基础 | 支持参数、模型 ID、地区/空间、错误和模型下线 |
| 独立媒体/向量 API | Qwen-TTS、Paraformer、Seedance/万相任务、向量化 | 固定鉴权、文件结果、submit/status 框架 | WebSocket/二进制、音色/资源、任务生命周期、返回格式 |
| 签名云 API / SSH | CVM 查询、服务器状态 | 连接别名与动作映射 | SDK 签名、主机指纹、远端账号权限、预设动作 |

“兼容 OpenAI”只能说明某组接口形态相近，不能推导出该厂商全部媒体、云服务或鉴权形式都已兼容。

## 第一轮建议选什么

先做 **DeepSeek 风格 Bearer + mock 上游**，验证服务端注入与反例；下一轮真实试点可选 **用户已有 API 产品中的一个聊天接口 + 百炼向量或 Qwen-TTS**。再做方舟视频任务、具体 OAuth、SSH 预设动作和云签名。

不先追加几十个品牌。新增厂商通常只需要一份可信 preset 和少量非标准协议适配器；是否需要大型模型网关，由实际路由需求决定。
