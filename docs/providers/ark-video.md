# 方舟视频异步任务

官方来源：https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh  
核验日期：2026-10-06。公开创建任务正文已核验，未提交真实付费任务。

视频生成通过异步任务完成。ARK 固定 `/api/v3` 目标，Bearer 由服务注入。提交使用 `POST /contents/generations/tasks`，查询使用 `GET /contents/generations/tasks/{task_id}`。

```json
{
  "method": "POST",
  "path": "/contents/generations/tasks",
  "body": {
    "model": "YOUR_CURRENT_VIDEO_MODEL",
    "content": [{ "type": "text", "text": "阳光照进森林，镜头缓缓向前" }]
  }
}
```

取得原生任务 ID 后：

```json
{ "method": "GET", "path": "/contents/generations/tasks/YOUR_TASK_ID" }
```

任务状态和结果字段按官方原生响应读取。项目不静默重复提交、也没有后台任务调度。取消本机等待并不等于厂商任务取消；如需删除任务，使用已配置的 DELETE 同一任务路径并核对官方行为。

结果 URL 可能有时效，不自动跟随/下载或透传原 API 凭据。模型及媒体参数以最新文档为准。
