# 火山方舟 / 豆包 Chat API

官方来源：https://docs.volcengine.com/docs/ark/chat-api?lang=zh  
核验日期：2026-10-06。公开 Chat 正文确认 endpoint；未使用真实账号试调。

ARK 使用 `https://ark.cn-beijing.volces.com/api/v3`，POST `/chat/completions`，Bearer 注入由服务完成。模型名称或推理接入点 ID 由用户实际开通的方舟产品决定。豆包 App 账号和网页登录态不能替代方舟 API Key。

```json
{
  "method": "POST",
  "path": "/chat/completions",
  "body": {
    "model": "YOUR_ARK_MODEL_OR_ENDPOINT_ID",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": false
  }
}
```

按当前官方文档添加原生多模态或工具参数，不做跨厂商字段改写。`stream:true` 的 HTTP/SSE 可透传；客户端取消会断开上游连接，但不能保证撤销已提交业务。

地区、模型权限和具体原生参数需用户对照官方文档确认。Key 管理来源：https://docs.volcengine.com/docs/ark/api-key?lang=zh 。
