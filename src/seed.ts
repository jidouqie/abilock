import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./store.js";
import type { Platform } from "./schema.js";
export const presets: Platform[] = [
  {
    alias: "DS",
    name: "DeepSeek 开放 API",
    baseUrl: "https://api.deepseek.com",
    auth: { type: "bearer" },
    enabled: true,
    allowInsecureLocal: false,
    description: "聊天与原生参数；模型名称以当前官方文档和账号权限为准。",
    rules: [
      { method: "POST", path: "/chat/completions" },
      { method: "GET", path: "/models" },
    ],
  },
  {
    alias: "ARK",
    name: "火山方舟 / 豆包模型",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: { type: "bearer" },
    enabled: true,
    allowInsecureLocal: false,
    description:
      "方舟开发者服务：聊天、图片与异步视频任务。不能使用豆包消费端登录态。",
    rules: [
      { method: "POST", path: "/chat/completions" },
      { method: "POST", path: "/images/generations" },
      { method: "POST", path: "/contents/generations/tasks" },
      { method: "GET", path: "/contents/generations/tasks/*" },
      { method: "DELETE", path: "/contents/generations/tasks/*" },
    ],
  },
  {
    alias: "TTS",
    name: "百炼 Qwen-TTS · 北京",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    auth: { type: "bearer" },
    enabled: true,
    allowInsecureLocal: false,
    description: "非实时语音合成 HTTP / SSE 示例。地域与 Key 必须匹配。",
    rules: [
      {
        method: "POST",
        path: "/services/aigc/multimodal-generation/generation",
      },
    ],
  },
];
const documents = [
  {
    alias: "DS",
    file: "deepseek.md",
    title: "DeepSeek · 聊天原生参数",
    sourceUrl: "https://api-docs.deepseek.com/api/deepseek-api/",
  },
  {
    alias: "ARK",
    file: "ark-chat.md",
    title: "方舟 · Chat API",
    sourceUrl: "https://docs.volcengine.com/docs/ark/chat-api?lang=zh",
  },
  {
    alias: "ARK",
    file: "ark-image.md",
    title: "方舟 · 图片生成",
    sourceUrl:
      "https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
  },
  {
    alias: "ARK",
    file: "ark-video.md",
    title: "方舟 · 视频异步任务",
    sourceUrl:
      "https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh",
  },
  {
    alias: "TTS",
    file: "qwen-tts.md",
    title: "百炼 · Qwen-TTS HTTP",
    sourceUrl: "https://help.aliyun.com/zh/model-studio/qwen-tts-api",
  },
];
export async function seed(store: Store, root: string) {
  for (const p of presets) await store.save(p, undefined, false, 0);
  for (const d of documents)
    await store.saveDoc(
      d.alias,
      {
        title: d.title,
        sourceUrl: d.sourceUrl,
        markdown: await fs.readFile(
          path.join(root, "docs/providers", d.file),
          "utf8",
        ),
      },
      "manual",
    );
}
