# Docker 与 Kubernetes

Abilock 直接实现固定远端的 HTTP API，不启动本机 `docker` / `kubectl`，不读取 Docker config、kubeconfig、keychain 或 credential plugin。以下是实际接入的命令子集；原生命令中未列出的参数会在发起请求前明确报错。

来源核对日期：2026-10-06。本文是本地调用上下文；更新本文不改变目标、凭据或资源策略。

## 连接与凭据

管理页创建 Docker 连接，config 示例：

```json
{
  "endpoint": "https://docker.example.com:2376",
  "apiVersion": "v1.47",
  "auth": "mtls",
  "trustedPrivate": false
}
```

`apiVersion` 是显式管理配置，默认 v1.47；远端版本不兼容会返回实际 HTTP 错误，不自动改版本。端点只接受 origin，无路径、查询、用户名或密码。管理员选择私网端点时需显式设置 `trustedPrivate: true`。正式执行还需连接顶层 `trustBoundary: "independent-target"`；这是一项部署约束及用户声明，不能替代真实隔离验收。

凭据只能在管理页填写。mTLS 使用 `cert`（PEM）、`key`（PEM），可选 `ca`（PEM）及加密私钥的 `passphrase`。Basic 使用 `username` / `password`，用于已有 HTTPS 反向代理的 Basic 鉴权；Docker Engine 原生远程 TLS 使用 mTLS。`auth: "none"` 只代表远端既有 HTTPS 身份策略无需额外请求头。`ca` 未设置时使用 Node 的默认信任库。服务端证书、hostname 和客户端证书均正常验证，没有跳过 TLS 验证开关。

管理页创建 Kubernetes 连接，config 示例：

```json
{
  "endpoint": "https://kubernetes.example.com:6443",
  "auth": "bearer",
  "namespace": "team",
  "namespaces": ["team"],
  "resources": [
    "pods",
    "services",
    "configmaps",
    "deployments",
    "statefulsets",
    "jobs"
  ],
  "trustedPrivate": false
}
```

Bearer 凭据为管理页的 `token`；mTLS 改为 `auth: "mtls"`，使用 `cert` / `key`。两者均可填写 `ca`；固定 TLS 目标、DNS pin 和证书验证仍生效。默认 namespace 为 `default`，未设置 `namespaces` 时只允许默认 namespace。未显式设置 `resources` 的旧连接沿用已接入的全部 namespaced 资源；管理页新建连接默认写入不含 `secrets` 的列表，需要读取 Secret 时由管理员显式勾选，避免集群中的长期密钥默认交给 AI。推荐显式缩小到业务所需范围。集群级资源必须显式加入白名单。

资源映射由代码维护：core/v1 的 pods、services、configmaps、secrets、persistentvolumeclaims、serviceaccounts、events；apps/v1 的 deployments、statefulsets、daemonsets、replicasets；batch/v1 的 jobs、cronjobs；networking.k8s.io/v1 的 ingresses、networkpolicies；以及显式可选的 namespaces、nodes、persistentvolumes、storageclasses。支持 `po/pod`、`svc/service`、`cm`、`deploy/deployment`、`sts`、`ds`、`rs`、`job`、`cj`、`ing` 等常用缩写；不接受用户传入任意 API path、API group 或 CRD 映射。

## Docker 已实现命令

| 命令                  | 参数/行为                                                         | Engine 请求                                           |
| --------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `version`             | 无附加参数，返回原生版本 JSON                                     | GET `/v1.47/version`                                  |
| `info`                | 仅返回 ServerVersion、OSType、Architecture 三个 string 字段       | GET `/v1.47/info`                                     |
| `ps`                  | `-a/--all`、`-q/--quiet`、重复 `-f/--filter key=value`、`--limit` | GET `/v1.47/containers/json`                          |
| `images` / `image ls` | all、quiet、filter                                                | GET `/v1.47/images/json`                              |
| `inspect`             | 一个或多个标识，`--type container`（默认）或 `image`              | GET container/image `/{id}/json`                      |
| `logs`                | 一容器，`--tail`、`--since`、`--until`、timestamps、details       | GET `/containers/{id}/logs`，解析 Docker multiplex 帧 |
| `start`               | 一个或多个容器                                                    | POST `/{id}/start`                                    |
| `stop` / `restart`    | 一个或多个容器，`-t/--time/--timeout` 秒                          | POST `/{id}/stop` 或 `restart`                        |
| `rm`                  | 一个或多个容器，`-f/--force`、`-v/--volumes`                      | DELETE `/{id}`                                        |
| `create`              | `--name`，stdin / 文件中的原生 ContainerCreate JSON，必须含 Image | POST `/containers/create`                             |

```sh
abl docker DOCKER ps -a --filter label=team=web
abl docker DOCKER inspect web
abl docker DOCKER logs --tail 100 --since 10m web
abl docker DOCKER stop --time 20 web
abl docker DOCKER create --name web --abl-input container.json
abl docker DOCKER start web
```

`container.json` 是业务请求，不含 daemon 凭据，例如：

```json
{
  "Image": "nginx:alpine",
  "ExposedPorts": { "80/tcp": {} },
  "HostConfig": { "ReadonlyRootfs": true }
}
```

保留原生 ContainerCreate JSON，不做业务 DLP。镜像必须已在远端存在；本适配器未实现 image pull/build/push、registry login、registry auth header、credential helper、Compose、exec/attach/hijack、容器文件归档或本机 Unix socket。daemon 鉴权与 registry 鉴权是不同能力，此版本只实现前者。

Docker `since/until` 支持 Unix 秒、RFC3339 和单一 `Ns/Nm/Nh` 时长，转换后发送 Engine 时间参数；没有模拟全部 Go duration / 本地日期格式。`logs -f/--follow` 只进行有时限、有大小上限的远端 HTTP 读取：服务会等待响应完成后统一返回，未实现终端实时逐块显示；无限 follow 在超时后失败，可 Ctrl-C 取消。默认操作时限 30 秒，可通过结构化操作配置为最高 120 秒；返回上限 16 MiB。不得把它当作无限日志终端。

重复 start/stop 时 Engine 的 HTTP 304（已处于所需状态）视为成功。其他命令的 3xx 仍作为拒绝跟随的响应处理，rm 后重复 inspect 会明确报错。

`info` 的三个字段由生产适配器创建新对象后返回，不透传 daemon 的 RegistryConfig、代理、内部标签或其他字段；缺失字段或类型错误会明确失败。info 的非 2xx（含重定向）仅返回 HTTP 状态码和固定错误文案，不返回上游错误体或 Location。版本查询仍返回版本接口原生 JSON。

## Kubernetes 已实现命令

| 命令                         | 支持范围与语义                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get` / `list` / `describe`  | resource `[name]` 或 resource/name，`-n`、selector、field-selector、limit/chunk-size、`-o json`；返回原生 JSON，describe 当前也是资源 JSON，不模拟 kubectl 人类可读事件摘要 |
| `create -f -`                | JSON 对象、对象数组或 kind List；POST 对应资源集合                                                                                                                          |
| `apply -f -`                 | Server-Side Apply；PATCH `application/apply-patch+yaml`，JSON 是合法 YAML；field-manager 默认 abilock，force-conflicts、server dry-run 可用                                 |
| `delete resource/name`       | DELETE 携带 DeleteOptions；grace-period、cascade 可用；不自动等待远端最终消失                                                                                               |
| `patch resource/name`        | strategic（默认）、merge、json；stdin JSON 或 `-p/--patch`；禁止改变 name/namespace/kind/apiVersion                                                                         |
| `logs pod` / `logs pod/name` | container、tail、since（Ns/Nm/Nh）、since-time、timestamps、previous；固定 Pod log 子资源                                                                                   |
| `scale`                      | deployment/statefulset/replicaset，必须 replicas；PATCH scale 子资源                                                                                                        |
| `rollout restart`            | deployment/statefulset/daemonset，PATCH Pod 模板 restartedAt 注解；不等待 rollout 完成                                                                                      |

```sh
abl kubectl KUBE get pods -n team -l app=web -o json
abl kubectl KUBE describe deployment/web
abl kubectl KUBE create -f pod.json
abl kubectl KUBE apply -f deployment.json --server-side --field-manager abilock
abl kubectl KUBE patch deployment/web --type merge --abl-input patch.json
abl kubectl KUBE scale deployment/web --replicas 2
abl kubectl KUBE logs pod/web -c main --tail 100 --since 5m
abl kubectl KUBE rollout restart deployment/web
abl kubectl KUBE delete pod/web --grace-period 20 --cascade background
```

资源集合的 `get/list/describe` 会读取 `metadata.continue`，直到完整列表结束；`--limit` 与 `--chunk-size` 都表示每页大小（1 至 10000），不是最终条目数上限。后页保持相同目标、选择器和页大小，continue 作为不透明查询值编码。结果合并所有 items，保留同一 resourceVersion，移除失效的 continue/remainingItemCount。单资源查询不分页。每次列表共用一次 timeout（覆盖 DNS 解析、每页传输和合并），取消适用于任何页；所有页接收数据累计最多 16 MiB、最多 100 页。重复 continue、资源版本变化、无效列表/JSON、任意后页 HTTP 错误、超时或取消均失败，不把此前页面作为部分成功返回。服务器返回过期 continue（如 HTTP 410）不会自动切换快照或重试，用户可重新查询。

CLI 只读取用户明确选择的普通业务 JSON 文件并转换为 stdin 输入；适配器不会读取本机文件或 URI。当前不解析 YAML、不读取目录、不运行 Kustomize。manifest 的 kind/apiVersion 必须匹配代码资源映射，namespace 必须在配置白名单；未填 namespace 时自动填默认值，显式 `-n` 与 manifest 不一致时拒绝。名称必须是安全 DNS 标识。多个 manifest 先全部通过身份策略校验，再按顺序提交；这是多个独立请求，不是事务，远端错误后停止，已成功提交的资源不会自动回滚。

未接入：watch、exec/attach、port-forward、proxy、credential exec plugin、config/context、API discovery/CRD、client-side apply、jsonpath/go-template/yaml 输出、server URL/header/token 覆盖、impersonation、用户自定义本地工具。`logs -f` 与 Docker 一样只支持有界缓冲读取及取消，尚未实现实时终端流。

## 多项结果

Docker `inspect/start/stop/restart/rm` 的多个目标、Kubernetes `create/apply` 的多个 manifest 按顺序调用，共用本次时限与累计响应大小上限。任一项失败、断线、超时或取消后停止后续项目，已完成的操作不会回滚，也不会自动重试。

结果保留此前的 `stdout/stderr/data`，另带 `batch.status`（`completed`、`failed` 或 `cancelled`）与 `batch.items`。每项包含原输入的从 0 开始的 `index`、已清洗的 `target` 及以下状态：

| 状态 | 含义 |
|---|---|
| `completed` | 已收到成功响应 |
| `failed` | 已收到失败响应，或在发送前失败 |
| `unknown` | 请求可能已经发出，未取得可确认的最终结果 |
| `not-started` | 尚未开始 |

已知退出码与固定错误摘要记录在对应项；原始网络异常不会输出。中断前的响应数据仍保留，正常单项调用不增加批次结构。普通 CLI 文本会列出失败/取消批次的全部目标和状态，`--abl-json` 则完整返回结构，不额外打印摘要。

先查询 `unknown` 项的真实状态，再按用户授权处理未完成项；不能因为整批退出码非零就重复已完成的写入。这里描述多个资源操作；同一列表分页必须完整，因此后页失败仍不返回部分列表。

## 执行边界

endpoint、身份和 namespace/resource 策略来自管理配置。CLI 不能覆盖 `--host`、`--config`、`--context`、`--server`、`--kubeconfig`、`--token`、CA/key 路径、TLS 开关或原始 URL；未识别参数在联网前拒绝。客户端 DNS 解析后固定本次连接 IP，TLS 仍按原 hostname 校验；不跟随 3xx，不转发 Location，响应需为 identity 编码。输出过滤管理凭据的原文及已知 URL/JSON/Base64 编码、完整 Basic/Bearer 值；有限过滤不保证识别任意转换或业务端人为编码。

**不得把 Docker 连接指向运行 broker 的 daemon，也不得把 Kubernetes 连接授予读取/修改 broker 所在集群的 namespace、Node、卷或可挂载 broker 秘密的工作负载的权限。** Docker 管理能力及 Kubernetes 工作负载能力可能读取所在主机/集群文件，输出过滤不能建立隔离。应把 broker 独立部署于执行目标之外，并用远端 RBAC/独立身份限权。namespace/resource 白名单与 `independent-target` 声明是附加限制，不能证明同集群或同用户无限 shell 已强隔离。安装本地受保护执行器不会自动隔离远端 daemon 或集群；这些部署关系和权限仍需单独验收。

HTTP loopback 只在显式本地 fixture 模式可用。协议 fixture 不证明真实 Kubernetes 集群的 RBAC、admission、版本兼容或业务工作负载成功。

## 验证与官方来源

定向 `npx --no-install tsx --test tests/container-protocol.test.ts` 使用独立 Node HTTP 服务记录请求方法/路径/query/body，使用临时 OpenSSL 合成 CA/服务器/客户端证书与真实 Node TLS 握手。验证 Engine 请求、Docker 二进制日志帧、Kubernetes SSA/patch/scale/delete 语义，拒绝身份/目标/namespace/插件覆盖，4xx 输出过滤，重定向不跟随，取消/超时和 CA/mTLS 错误。该测试还覆盖生产 info 字段投影、Basic 完整组合值与裸 Base64、两页完整合并及重复查询、selector/continue 编码、后页失败/版本变化/重复 token/100 页限制、累计 16 MiB、全局超时与 DNS 取消。批次回归覆盖先成功、后断线/超时/取消、后续未开始，正常 HTTP 失败、发起前失败、累计预算与状态保留。它证明协议请求及本机 TLS 行为，未证明远端实际 Docker/Kubernetes 版本、Admission/RBAC 或业务工作负载成功。

`scripts/real-docker-check.ts` 是需明确授权后才运行的临时 Engine 集成检查：`abl → 临时 broker → mTLS loopback 测试代理 → 固定 Docker Unix socket`。代理只接受本次专属标签的固定 Redis 创建请求、标签列表，以及由它创建并核对标签的容器 ID 的生命周期/日志操作；不读取或改变既有用户容器。脚本在 finally 清理自身额外容器，并把本次证据与清理状态写入本地 artifacts，这些运行文件不随源码分发。

运行者应先确认现有 Docker 环境、所需本地镜像与临时操作授权，再运行该集成脚本；不能为了补一次测试擅自部署、拉取镜像或管理既有容器。以本次实际结果判断是否通过。本机代理集成不证明远端 daemon 原生 TLS、独立部署关系或真实 Kubernetes 集群已经验收。

- [Docker Engine API v1.47 官方参考](https://docs.docker.com/reference/api/engine/version/v1.47/)：交互式参考依赖 JavaScript；已用正常 TLS 只读下载[官方 OpenAPI YAML](https://docs.docker.com/reference/api/engine/version/v1.47.yaml)并核对本文 12 个 Engine endpoint（含 version/info）、日志的 stdout/stderr/since/until/timestamps/follow/tail 参数。文件 443768 字节，SHA-256 `9108f0595ed0b53a833459ddf50f5c0da498e78b53604bfaad02df5618366629`。spec 未列 details，该参数另经 [Moby v27.3.1 官方日志路由源码](https://raw.githubusercontent.com/moby/moby/v27.3.1/api/server/router/container/container_routes.go)核对；不是用自定义 fixture 代替上游协议文档。
- [Docker daemon TLS 保护](https://docs.docker.com/engine/security/protect-access/)：远程 daemon 的 TLS / 客户端证书方式。
- [Docker logs](https://docs.docker.com/reference/cli/docker/container/logs/)：日志及时间参数语义；本实现保留明确列出的参数子集。
- [Kubernetes API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)：资源集合路径、JSON/merge/strategic/apply PATCH 类型，以及 JSON 可用于 apply-patch+yaml 的协议说明。
- [Kubernetes Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)：服务器端字段管理和冲突语义。
- [Kubernetes v1.35.0 官方 OpenAPI JSON](https://raw.githubusercontent.com/kubernetes/kubernetes/v1.35.0/api/openapi-spec/swagger.json)：已独立核对 Pod/Deployment 集合及对象、Pod log 和 Deployment scale 的路径与 GET/POST/PATCH/DELETE 方法。文件 3846687 字节，SHA-256 `483500149ee52ce5753d75f5639101d985bb4f5e902cc05b1ba7627465d62446`。这不等于已验证真实集群版本、所有资源 admission 或 RBAC。
- [kubectl 官方参考](https://kubernetes.io/docs/reference/kubectl/)：原生命令入口；原生全部功能超出本文实际接入范围。

项目署名：[吉豆茄 jidouqie](https://v.douyin.com/oApPI_L9avQ)。
