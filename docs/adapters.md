# 可信鉴权适配器

已实现的固定注入覆盖 None、Bearer、Header API Key、Query API Key、Basic。OAuth、腾讯 TC3、火山签名等动态机制未实现；UI 可登记 adapter ID，执行时若未注册会返回 `ADAPTER_UNAVAILABLE`。

在服务可信源码中实现 `AuthAdapter` 并在服务启动模块导入注册代码：

```ts
import { registerAdapter } from "./adapters.js";
registerAdapter({
  name: "my-reviewed-signature",
  protectedHeaders: ["Authorization", "X-Signature", "X-Date"],
  protectedQuery: ["signature", "access_key"],
  async apply({ secret, url, method, body, headers }) {
    // 根据当前厂商官方协议签名；secret 只在服务进程中使用。
    // headers['x-signature'] = trustedSign(secret, url, method, body);
    // 不打印、不返回 secret，不允许更改已配置的目标。
    void secret;
    void url;
    void method;
    void body;
    void headers;
    throw new Error("请实现并测试当前官方协议");
  },
});
```

此示意没有被默认注册，也不会假装支持签名。适配器必须列出保护字段，通过可信用户代码审查与测试。不允许从配置、调用 JSON 或 Markdown 动态 import 模块、执行 shell 或调整目标策略。SDK 可在服务内使用；不能要求 AI 取得 SecretKey。

OAuth 需要另外实现用户授权入口、refresh token 保管/刷新与并发控制，本版没有授权 UI，也不支持把 OAuth ID 当作 Bearer 参数冒充。需要该能力时按具体厂商追加受信实现。

## 多协议适配器

HTTP特殊鉴权沿用本文件接口。Abilock 2.0 的协议适配器单独实现 `Adapter.validate` / `Adapter.run`，注册于 `src/protocols/index.ts`；配置与秘密字段分开，秘密只保存在服务Store，执行端严格使用 `{args,input,files,timeoutMs}` 业务封装，不接受target/credentials。每个适配器必须解析受控参数、固定最终DNS目标、核验TLS/SSH指纹、禁止重定向、清理取消资源、约束文件/输出并对错误脱敏。只靠UI独立目标声明不构成隔离。AWS SigV4是已实现的固定官方SDK子集；自动OAuth及任意签名插件仍未实现。
