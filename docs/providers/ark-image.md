# 方舟图片生成

官方来源：https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh  
核验日期：2026-10-06。官方入口与代表路径已核验；公开抓取页面可能依赖 JavaScript，不能将页面壳视为字段全部确认。

预置 ARK 允许 `POST /images/generations`，目标继承方舟 `/api/v3`，不共用消费端豆包登录态。下面为原生请求形态样例，使用前需核对当前模型支持的参数：

```json
{
  "method": "POST",
  "path": "/images/generations",
  "body": {
    "model": "YOUR_CURRENT_IMAGE_MODEL",
    "prompt": "一只坐在窗边的猫",
    "size": "1024x1024",
    "response_format": "url"
  }
}
```

响应 JSON 原样返回。若厂商返回临时结果 URL，本项目不会自动携带原 API Key 下载此 URL；由用户另行处理或在管理页面配置固定下载能力。若接口提供 Base64 结果，AI 可从原生响应读取并保存。

未进行真实图片生成验证；不保证占位模型或示例尺寸对所有当前模型有效。抓取失败可手动导入官方 Markdown。
