# DeepSeek 开放 API

官方来源：https://api-docs.deepseek.com/api/deepseek-api/  
核验日期：2026-10-06。公开文档核验，未使用真实 Key 调用。

DS 预置目标为 `https://api.deepseek.com`，Bearer 由服务注入。聊天接口使用 `POST /chat/completions`。保留厂商原生 JSON 字段，模型应以账号当下支持的列表为准；不要把消费端登录态当作 API Key。

调用封装示例（模型占位符需替换）：

```json
{
  "method": "POST",
  "path": "/chat/completions",
  "body": {
    "model": "YOUR_CURRENT_MODEL",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": false
  }
}
```

使用 `abl api DS --file request.json --json`。开启上游原生 `stream` 后，默认 abl 原样输出已脱敏流；需要完整 envelope 时用 `--json`（会缓冲）。`GET /models` 可查询原生模型列表。

本文是连接与请求形态说明。完整参数、模型更新和计费以官方文档为准，UI 可导入官方页面更新本地 Markdown。读取文档不授予配置或鉴权权限。
