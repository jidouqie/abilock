# 操作关联：operationId 与 invocationId

Abilock 给操作增加可读取的关联元信息。业务输入、上游原生输出、目标约束和鉴权规则保持各自原有含义；不需要登记 AI 身份。

默认本地 CLI 通过一次性 worker 的 IPC 调用，无 HTTP 监听或后台服务；同样返回独立 `invocationId` / `operationId`。下文的响应头字段在本地模式作为 IPC 公开元信息传递，`operationIdSource: server` 也包含可信本地 worker 生成的编号。显式远程模式仍使用原 HTTP / WebSocket 传输。

## 三类 ID

| 字段           | 生命周期                                | 用途                               |
| -------------- | --------------------------------------- | ---------------------------------- |
| `invocationId` | 一次 CLI 启动、管理页面实例或服务运行时 | 关联同一程序运行期间发起的操作     |
| `operationId`  | 一次独立操作，或一场 SSH 交互终端会话   | 标记具体操作的结果、失败或终端消息 |
| `requestId`    | 一个 HTTP 请求或本地 IPC 请求           | 保留单次传输请求的排查标记         |

这些 ID 使用 UUID，不包含厂商凭据、用户密码、请求内容或调用者资料。`invocationId` 是程序运行实例的随机 UUID，不是操作系统 PID、AI 名称、用户 ID、设备 ID 或业务任务 ID。服务端生成自己的 `operationId`，调用者不能指定它。

完整 UUID 若与已知凭据精确相撞，会有界地重新选择并复验安全编号；公共 UUID 格式中与短凭据巧合的字符不会使编号失效。正常运行仍复用同一程序实例 ID。

每次启动 `abl`，客户端生成新的 `invocationId`。命令内部如果需要多次请求，就复用这个实例 ID，并给每次操作保留不同的操作 ID。管理页面在本次页面实例中复用一个实例 ID；刷新或重新打开后生成新的 ID。

未传入调用者实例元信息时，服务或 worker 内部直接调用使用该进程运行时生成的实例 UUID。服务重启后该 UUID 变化；同一运行时的各操作仍使用不同 `operationId`。默认关联到服务运行时，不表示识别出了具体调用者。

业务关联不依赖 HTTP keep-alive、连接复用、TCP 端口或连接是否断开。一条连接可以承载多个操作；一个程序实例也可以使用多个连接。上游视频任务 ID、Git `repoId`、数据库业务主键等仍是业务数据，不被替换成 Abilock ID。

## 读取关联信息

HTTP 响应头使用：

```text
x-abilock-invocation-id: 11111111-1111-4111-8111-111111111111
x-abilock-operation-id: 22222222-2222-4222-8222-222222222222
```

上面的值是说明用的合成示例。响应正文不会为了携带 ID 而改写成另一个业务格式：原始 JSON、SSE 和二进制仍按原方式输出。

JSON envelope 在顶层提供 `invocationId`、`operationId` 和 `operationIdSource`，保留 `requestId` 及原来的业务字段。例如，以下只展示关联字段：

```json
{
  "invocationId": "11111111-1111-4111-8111-111111111111",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "operationIdSource": "server",
  "requestId": "44444444-4444-4444-8444-444444444444"
}
```

`operationIdSource: server` 表示使用服务提供的操作 ID。服务未提供该信息时，CLI 可以生成本地后备 ID，并标为 `client`；它只能关联本地观察，不能证明服务已接受请求，也不能保证服务日志存在相同 ID。

请求日志另带 `completed` 和失败时的 `errorCode`。HTTP 已发送 200 后，若正文中途超时或断开，状态码仍为实际已发送值，日志会标明未完整完成及对应错误，不把截断流记成成功。日志回调本身的同步或异步失败不会改变业务结果。

```sh
abl list --json
abl doc ssh DEPLOY --json
abl api DS --file request.json --json
abl postgres PG 'SELECT 1' --abl-json
```

HTTP 和协议的结构化结果携带关联元信息；协议的 `stdout`、`stderr`、`exitCode`、`data` 与 `files` 仍按原合同读取。

需要保留原始 stdout、SSE 或下载文件时，加 `--abl-trace`，关联信息写入 stderr：

```sh
abl api DS --file stream-request.json --abl-trace
abl api MEDIA --file download-request.json --output result.bin --abl-trace
abl ssh DEPLOY 'uname -a' --abl-trace
```

`--abl-trace` 是客户端关联输出选项，不是厂商参数，也不是显示秘密的 verbose 模式。管理页诊断把程序实例 ID 和操作 ID 单独显示，不把它们拼进上游业务响应。

## 聊天与终端

聊天快捷命令先读取已配置的聊天上下文，再发起实际 API 调用：

```sh
abl api DS chat '你好' --json --abl-trace
```

| 步骤           | invocationId         | operationId         |
| -------------- | -------------------- | ------------------- |
| 读取配置上下文 | 本次 CLI 实例 ID     | 上下文读取的独立 ID |
| 发起聊天调用   | 同一本次 CLI 实例 ID | 实际调用的新 ID     |

结果和关联输出按各自对应的操作读取，不把上下文读取成功当作上游聊天已经完成。

`abl ssh DEPLOY` 打开一场交互终端。终端的 ready、输出、退出、错误及控制消息关联同一会话操作 ID；不能为每个字符、resize 或数据帧生成新的业务操作。`direction` 区分 `client` 与 `server` 消息，双向 `sequence` 各自递增；它们用于区分会话内子消息，不是新的身份或新的操作 ID。

终端的实例 ID 在 WebSocket 握手时根据 `x-abilock-invocation-id` 请求头或服务运行时默认值确定，并在该会话内固定。初始化帧只能确认这个实例 ID，不能重新分配；独立终端客户端如需自己的实例 ID，应在握手请求头中提供，不能仅在初始化帧里声明。CLI 自动完成这些步骤。网关会暂存核心 WebSocket 尚未打开时收到的早期初始化消息，待连接打开后转发；这不会产生新操作或改变实例归属。

## 直接构造执行请求

独立程序直接调用执行端时，可在 Abilock 请求封装中提供 `trace: {invocationId}`。这里是请求封装的顶层元信息，不改变厂商 `body` 或原生协议参数：

```json
{
  "args": ["-c", "SELECT 1"],
  "trace": {
    "invocationId": "11111111-1111-4111-8111-111111111111"
  }
}
```

也可通过 `x-abilock-invocation-id` 请求头关联程序实例；管理页面使用这个请求头。CLI 自动生成并传递本次实例 ID，交给 `abl` 的请求文件/stdin 封装必须只保留原业务字段，手写顶层 `trace`、`invocationId` 或 `operationId` 会被拒绝。上面的 `trace` 示例只适用于独立程序直接构造执行端请求。客户端不能通过请求封装指定 `operationId`，也不能把身份、目标、鉴权或插件参数塞入 `trace`。

关联字段要求有效 UUID；同时提供请求头和 `trace.invocationId` 时，两者必须一致。它们只关联本次请求，不能从普通业务 payload 或复用连接推测实例归属。

## 关联信息的边界

ID 不提供调用者注册、任务所有权、独立身份认证、权限提升、幂等、自动重试或业务回滚。格式有效的 UUID 不能替代执行能力或管理会话，也不能据此确认哪个 AI 或用户发起了操作。

重开 CLI、重新发送同一请求或查询一个异步业务任务，都属于新的调用过程。操作 ID 不能用来判断上游是否已经产生副作用；断连、超时或取消后，仍要根据实际任务 ID、业务状态或返回结果确认，再决定下一步。没有新增后台任务恢复、操作历史查询或自动重试服务。

本页描述关联字段的合同，不把历史测试报告当作新代码的验收证据。当前验证范围以本次实际产生的报告为准；正式实例仍应按用户授权启动。浏览器交互未获允许时，只能报告静态检查和构建范围。
