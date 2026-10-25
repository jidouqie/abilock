# 参与开发

先读 [AGENTS.md](AGENTS.md)、[架构](docs/architecture.md) 和对应模块说明。软件以 Skill 为主要使用入口：助手组织任务，CLI 负责确定性执行，应用提供同一份状态的查看、修改和接管。不要把模型能理解的业务内容变成用户必须填写的复杂表单。

## 本地检查

当前完整源码构建入口面向 macOS。需要 Node.js ≥22.12、npm、Python 3、Apple Command Line Tools；完整安装与开发检查是两件事。

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
node scripts/build-isolation-launcher.mjs --prebuilt
npm run check
```

原生程序由源码构建，不提交 `native/prebuilt` 或已生成的 App。界面改动还需 `npm run test:ui`，使用本机 Google Chrome 和隔离合成数据。Windows 修改需要目标 Windows 环境的编译与相应 PowerShell 测试；macOS 的静态检查不能代替 Windows 实装验收。

测试用临时目录、合成凭据和明确拥有的本地服务。不要读取真实凭据库、账户配置或其他项目的秘密，不用真实供应商调用替代回归。安装测试另行授权，不能通过测试脚本静默安装、重置或删除数据。

## 提交范围

- 源码、测试、公开示例、Skill 和必要文档可提交。
- 用户连接、真实地址、凭据、日志、备份、验收截图、安装回执及全部 `artifacts/` 留在本地。
- 官方资料保留来源与日期；研究原文在 `docs/research/`，不要将历史调研写成当前已实现功能。
- 变更目标、鉴权、权限、IPC 或脱敏逻辑时运行相关安全回归。新增能力说明其实际支持范围、失败语义和未验证项。
- 保留锁文件，使用 npm 官方源；不以关闭校验、清空数据或重试未知结果掩盖失败。

Pull request 说明实际问题、最终行为、验证结果与剩余限制。不要把 mock 成功、HTTP 200、启动请求或旧版本报告当作真实业务完成。
