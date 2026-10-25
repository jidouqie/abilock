# 百炼 Qwen-TTS · 北京地域

官方来源：https://help.aliyun.com/zh/model-studio/qwen-tts-api  
核验日期：2026-10-06。已读取 HTTP 原生请求与响应说明；未使用真实 Key。

TTS 预置 `https://dashscope.aliyuncs.com/api/v1`，POST `/services/aigc/multimodal-generation/generation`。服务注入 Bearer，地域和 Key 必须匹配。

```json
{
  "method": "POST",
  "path": "/services/aigc/multimodal-generation/generation",
  "body": {
    "model": "qwen3-tts-flash",
    "input": {
      "text": "你好，欢迎使用接口工作台。",
      "voice": "Cherry",
      "language_type": "Chinese"
    }
  }
}
```

SSE 请求可在封装中加入 `"headers":{"X-DashScope-SSE":"enable"}`。音频可能以 Base64 片段或临时音频 URL 返回，保持原生 JSON/SSE 结构，不假设是直接 WAV。`--output` 保存的是接口实际响应；Base64 音频需按厂商格式另行解码。

当前模型、音色、文本长度与权限仍以官方来源为准。WebSocket 实时双向语音未实现。豆包语音属于独立产品，不能将方舟 API Key 擅自套用；官方语音入口见原调研 `docs/research/04-国产厂商API核验.md`，其细节仍需后续适配核验。
