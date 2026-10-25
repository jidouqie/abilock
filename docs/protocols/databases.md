# PostgreSQL、MySQL 与 Redis

更新及官方资料核对：2026-10-06。Abilock 使用 `pg`、`mysql2`、`redis` 的真实协议客户端，服务按管理配置建立连接、注入凭据。它不启动 `psql`、`mysql` 或 `redis-cli` 本机进程，也不加载用户的 `.pgpass`、数据库配置文件或环境中的连接信息。密码只在管理页面填写；下面的命令和 JSON 都没有密码。

| 连接类型   | 实际能力                                                                                                                                                           | 暂未提供                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `postgres` | 下文限定语句范围内的原生查询、业务写入与表/索引/视图等 DDL、单次脚本事务、`-c`/`--command`、上传 SQL 脚本或 stdin、`$1` 参数绑定、JSON 行及字段结果                | 过程/触发器/动态 SQL、交互式 psql、跨调用事务、COPY 流、游标结果流、Kerberos、客户端证书                       |
| `mysql`    | 下文限定语句范围内的原生查询、业务写入与表/索引/视图等 DDL、单次脚本事务、多语句脚本、`-e`/`--execute`、上传 SQL 脚本或 stdin、`?` 参数绑定、JSON 行/字段/影响行数 | 过程/触发器/event/动态 SQL、交互式 mysql、本机 `source`、LOAD DATA LOCAL、跨调用事务、游标结果流、客户端证书   |
| `redis`    | 单条原生业务命令，字符串/哈希/列表/集合/有序集合/Streams 等由服务端支持的命令；`-x` 追加 stdin；`--pipe` RESP bulk-string 命令批次；二进制值以 base64 无损返回     | 持续订阅/monitor、Cluster/Sentinel 自动发现与重定向、跨调用事务状态、MULTI/EXEC/WATCH、管理/凭据/模块/复制命令 |

事务必须全部位于一次 SQL 输入中；每次调用独立连接并在完成、取消或超时后关闭。Redis `--pipe` 保留 RESP 输入格式与命令顺序，当前逐条等待响应，返回每条结果；它不是 Redis CLI 的高吞吐导入性能实现，也不会在失败后重试或补偿已经完成的业务写入。

## 管理配置

通过 UI 创建连接，将 `kind` 选为 `postgres`、`mysql` 或 `redis`，填写固定连接信息。配置为严格字段集合，不能附加驱动选项、连接 URI、`rejectUnauthorized: false` 或客户端配置文件路径。

PostgreSQL/MySQL 配置示例（仅占位，不会创建实际持续访问）：

```json
{
  "host": "database.example.com",
  "port": 5432,
  "user": "application_role",
  "database": "business",
  "tls": true
}
```

MySQL 常见端口为 3306。Redis 配置如下：

```json
{
  "host": "redis.example.com",
  "port": 6379,
  "username": "application_role",
  "database": 0,
  "tls": true
}
```

`tls` 省略时为 `true`。TLS 同时检查证书链与服务器身份，不自动降级为明文或关闭验证。私有 CA 可在管理配置的 `ca` 字段填 PEM 证书正文，不是本机文件路径。连接按管理目标解析并固定一次 IP，TLS 仍验证管理配置中的 DNS 身份。

`serverName` 可显式指定管理可信的 TLS DNS 身份，用于固定 IP 与证书 DNS 名不同的情况。**MySQL 的 IP 目标启用 TLS 时必须配置 `serverName`**：当前 mysql2 版本的 DNS 身份校验路径与 IP 路径不同，Abilock 拒绝把该情况当作已经完整验证的 IP TLS 连接。可改用证书 DNS 名作为 `host`。PostgreSQL、Redis 支持证书 IP 身份校验。

只有用户在管理页明确设置 `tls: false` 时才使用传统明文数据库传输；这是可见的显式配置，不是默认选项。TLS 无法连通时不会尝试这一模式。测试 fixtures 只在显式开发本地模式中使用明文随机 loopback 端口及合成密码。

正式连接需要确认 `independent-target` 信任边界；私有网络地址可作为管理员固定目标。服务会拒绝 broker 本机网卡、loopback、metadata/link-local 和特殊网络地址。数据库账号只应覆盖业务数据库，权限不能读写或管理 broker 的文件、进程、主机、容器或集群。同用户无限 shell、与 broker 共用主机和权限的超级用户数据库都不构成强隔离。可信安装器的本地执行身份隔离不替代远端数据库自身的权限与部署边界。

`independent-target` 是管理员的部署声明，代码不能据此证明数据库实际独立。管理配置的 `database` 选择连接的初始业务库；可访问哪些 schema/表、其他数据库或已有函数由服务器角色授权决定。请在独立数据库上使用最小业务角色：不授予 PostgreSQL superuser、服务器文件/程序角色或不必要的扩展/函数执行权限；不授予 MySQL FILE、mysql 系统库写入、安装组件/UDF 或不必要的 routine/trigger/event 权限。已有 SECURITY DEFINER 函数、视图、触发器与远程引擎的副作用也须在该数据库中管理。项目不会自动设置真实数据库权限或审计用户的实际角色。

PostgreSQL 运行需要 UI 中的非空密码，避免驱动回退读取 `.pgpass`。身份 `user` 和 `database` 取自管理配置。Redis 可在管理页配置 ACL 用户名和密码；默认用户也可只填密码。用户名和密码不会接受命令行覆盖。

## 调用示例

连接别名由用户管理，例如 `PG`、`MYSQL` 和 `CACHE`。单字符串 SQL 可用 `abl postgres PG 'SELECT 1'` 或 `abl mysql MYSQL 'SELECT 1'`；也保留以下原生参数形式：

```sh
abl postgres PG -c 'SELECT id, status FROM orders ORDER BY id LIMIT 20'
abl postgres PG --command 'UPDATE orders SET status = $1 WHERE id = $2 RETURNING id' --params '["complete",42]'
abl mysql MYSQL -e 'SELECT id, status FROM orders ORDER BY id LIMIT 20'
abl mysql MYSQL --execute 'UPDATE orders SET status = ? WHERE id = ?' --params '["complete",42]'
abl redis CACHE SET greeting hello
abl redis CACHE GET greeting
abl redis CACHE -x SET document < business.txt
```

`--params` 是数组 JSON。PostgreSQL 按原生 `$1` 占位符发 Parse/Bind，MySQL 按原生 `?` 占位符发 prepare/execute；不会把参数拼接为 SQL。不要把业务参数的密钥或密码写到命令行；平台登录凭据始终由管理 UI 保存。

SQL 脚本可用 stdin：

```sh
abl postgres PG -f - < migration.sql
abl mysql MYSQL < migration.sql
```

也可通过通用 `--request-json` 上传文件正文，文件名只与本次上传匹配，服务不会读取 broker 的本机路径：

```json
{
  "args": ["-f", "business.sql"],
  "files": [{ "path": "business.sql", "base64": "U0VMRUNUIDQyOw==" }],
  "timeoutMs": 30000
}
```

Redis 原生 RESP 批次可使用 `abl redis CACHE --pipe < commands.resp`，输入要求 RESP arrays of bulk strings，不接受内联命令、嵌套数组或 RESP 响应。每批最多 10,000 条命令，每条最多 10,000 个参数。先校验整个批次再连接；发现被拒绝的命令时不会部分执行此前命令。

Redis 二进制 stdin 用 `--request-json` 提交 `files` 的 base64，`path` 固定为 `-`：

```json
{
  "args": ["-x", "SET", "binary-document"],
  "files": [{ "path": "-", "base64": "AP+ADQpB" }],
  "timeoutMs": 30000
}
```

GET、ECHO 等 bulk-string 结果为 `{ "type": "bytes", "base64": "…" }`，有效 UTF-8 时还提供 `utf8` 字段。二进制不会经 UTF-8 替换损坏。RESP 批次本身也可以同样上传 `files`。普通单条命令中的 `-h` 等字符串在命令名之后按业务参数处理；命令名前的连接、凭据和客户端选项会拒绝。

SQL 输出统一 JSON，不模拟原生终端表格。可接受常见无害格式标志 `-A/-t/-X/-q` 和 `-B/-N`，输出仍是 JSON。每次调用最长 120 秒，由统一请求验证控制；结果 JSON 最大 16 MiB。驱动当前在内存中收集结果，**16 MiB 是返回限制，不是流式堆内存上限**；大查询应在原生 SQL/Redis SCAN 中分页。取消或超时会关闭连接，已经提交的写入可能完成，服务不会自动重试。

## SQL 兼容范围、入口防御与错误

当前默认执行入口是保守语句分类：仅将下列形态作为业务 SQL 交给对应厂商解析，不承诺接受任意 SQL。保留厂商正文与参数，不将业务内容改写成自建查询语言。

- 查询/写入：`SELECT`、普通 `WITH [RECURSIVE] … AS (…)` CTE 后的查询/写入、`INSERT/UPDATE/DELETE`，以及厂商实际支持的 `MERGE/REPLACE/VALUES/TABLE`。CTE 的 SEARCH/CYCLE 等未识别包装暂不支持。
- DDL：普通 `CREATE/ALTER/DROP TABLE/INDEX/VIEW/SCHEMA/DATABASE/SEQUENCE`，适用方言中的 TEMP/TEMPORARY/UNLOGGED 表、UNIQUE 索引及 PostgreSQL MATERIALIZED VIEW；MySQL `RENAME TABLE`。PostgreSQL `CREATE SCHEMA` 仅支持完整简单头部：schema 名、可选 `IF NOT EXISTS` 和 `AUTHORIZATION` 角色，也支持仅 `AUTHORIZATION` 的原生形态；任何无分号内嵌 `schema_element`（包括 TABLE/VIEW/INDEX/SEQUENCE/TRIGGER/GRANT）整体拒绝。需要创建其他对象时请提交分号分开的独立支持语句。未知 DDL 对象或 DEFINER/ALGORITHM 等未识别前缀拒绝。
- 事务：同一次调用中的 `BEGIN [WORK|TRANSACTION]`、`START TRANSACTION`、支持的 isolation/read-only 等选项、`COMMIT/END/ROLLBACK`、savepoint 及 release。`BEGIN ATOMIC` 和存储程序 compound 块不属于事务兼容范围。
- 检查/会话：`SHOW/DESCRIBE/DESC`、已识别选项后的查询 `EXPLAIN`、`SET/RESET`（固定词法模式例外）、`TRUNCATE/ANALYZE/VACUUM/REINDEX`。仍以厂商方言、服务器权限和语法为准；分类器不是完整语法解析器。

创建/改变 stored procedure/function/trigger/event、通过 `CALL` 调用过程、`DO`、过程式 `IF/WHILE/LOOP/DECLARE`、SQL 文本的 `PREPARE/EXECUTE/DEALLOCATE` 和未知管理/compound 构造不支持，连接前报 `DB_SQL_STATEMENT_UNSUPPORTED` 或 `DB_DYNAMIC_SQL_DENIED`。普通表达式中的既有函数调用仍受下面的已知入口检查及服务器权限约束。不会仅在每个分号后检查 `PREPARE` 首词，让 `IF … THEN PREPARE` 或过程包装进入执行。驱动 `--params` 的原生 Parse/Bind 或 prepare/execute 协议继续支持。

PostgreSQL 另拒绝 psql 元命令/本机 shell、连接 URI/主机/用户名/密码覆盖、COPY（包括 PROGRAM 与本机 `\copy`）、已知 `pg_read_*file/pg_ls_*/pg_stat_file/pg_file_*` 与 adminpack 文件入口、`lo_import/lo_export`、dblink 函数族、LOAD、query-to-XML 动态入口和创建外部服务器/扩展等形态。MySQL 拒绝客户端 shell/source/defaults 文件、LOAD DATA/XML、LOAD_FILE、OUTFILE/DUMPFILE、`CREATE [AGGREGATE] FUNCTION [IF NOT EXISTS] … SONAME`、插件/组件安装与可执行注释。不支持的入口会在网络连接前报固定代码。MySQL 即使收到恶意服务端主动发出的 LOCAL INFILE 请求，也不会读取 broker 文件；客户端不启用 LOCAL_FILES 且不提供文件读取工厂。

这些是有限语法兼容和已知入口防御，不能证明每条已接受 SQL 的所有数据库侧效果。普通查询可以调用未识别的已有函数，写入可以触发现有 trigger，视图/远程引擎也可能封装其他操作；客户端过滤器无法替代独立数据库部署和最小权限，更不能把超级用户数据库变成安全 SQL 沙箱。普通业务字符串和列名中的 `SONAME`、`PREPARE`、`dblink` 等不会仅因文本内容被拒，普通业务数据不做 DLP。

Redis 拒绝 AUTH/HELLO/ACL/CONFIG/MODULE、复制、MIGRATE、CLUSTER/SENTINEL、CLIENT、SELECT 和订阅/monitor 等管理或持续连接命令。数据库号只来自管理配置。普通远程业务写入按用户授权执行，不做业务数据 DLP。服务端权限仍由数据库角色/Redis ACL 控制；这套客户端入口过滤不是完整 SQL/Lua 语言沙箱或数据库授权替代品。

词法处理区分数据库方言：MySQL `--` 只有后接空白或控制字符才算注释；PostgreSQL 普通字符串不把反斜线当转义，只有 `E'…'` 使用反斜线转义，并处理跨换行相邻字符串、双写标识符引号及 ASCII dollar quote。PG `U&` Unicode 字符串/标识符、非 ASCII dollar 标签和 `UESCAPE` 不支持并明确拒绝，不能用它们隐藏文件函数。PG 会话固定 `standard_conforming_strings=on` 和 UTF8；MySQL 会话固定 utf8mb4，并从服务端默认 sql_mode 中移除 ANSI_QUOTES/NO_BACKSLASH_ESCAPES，保留其他模式。改变这些词法模式/编码的 SQL 在连接前拒绝。

驱动错误不原样返回 SQL、连接详情、服务端消息或堆栈。`DB_OPERATION_FAILED` 额外附带固定分类，供调用方判断如何修正：`category`（`auth`、`permission`、`connection`、`tls`、`undefined_object`、`syntax`、`constraint`、`data`、`transaction`、`resource`、`command`、`unknown`）、5 位 `sqlState`（PostgreSQL SQLSTATE、MySQL SQLSTATE）、MySQL `errno`，以及驱动常量或 Redis 错误前缀 `driverCode`（如 `ER_PARSE_ERROR`、`ECONNREFUSED`、`WRONGTYPE`）。这些都是格式受限的代码，不含服务器消息文本，同时写入 stderr 摘要。常用错误包括 `DB_ARGUMENT_DENIED`、`DB_CLIENT_META_COMMAND_DENIED`、`DB_LOCAL_EXTENSION_DENIED`、`DB_COMMAND_DENIED`、`DB_RESP_INPUT_INVALID`、`DB_LOCAL_TARGET_DISABLED`、`DB_TLS_SERVERNAME_REQUIRED`、`DB_CREDENTIALS_MISSING`、`DB_OPERATION_FAILED`、`DB_TIMEOUT`、`DB_CANCELLED`、`DB_OUTPUT_LIMIT`。API 层会继续按保管凭据统一过滤响应；对完全不可信服务器产生的任意编码和衍生结果不承诺绝对过滤。

## 验证与官方来源

SQL 分类与入口防御回归在 `tests/database-sql-lexer.test.ts`，覆盖 PostgreSQL / MySQL 方言、quoted 标识与业务字符串、动态 SQL / UDF / 文件入口、CTE、DDL、事务及 `CREATE SCHEMA` 简单头部。`tests/database-protocol.test.ts` 使用真实客户端连接合成线协议服务：PostgreSQL v3、MySQL 4.1 与 RESP3。它验证查询和参数报文、错误鉴权、取消/超时、结果上限、目标覆盖、秘密回显过滤、默认 TLS 失败关闭与恶意 LOCAL INFILE 空响应。这些 fixture 不执行完整数据库语义。

```sh
npx --no-install tsx --test tests/database-sql-lexer.test.ts tests/database-protocol.test.ts
```

`scripts/real-database-check.ts` 供另行准备的临时 PostgreSQL、MySQL、Redis 服务使用，验证实际查询、参数、事务、二进制与错误行为。它仅接受显式 `ABILOCK_TEST_ENV` 指向的临时 JSON 配置，不发现用户账户。配置中的地址须为 loopback，密码须为合成值；脚本会创建和清理测试表、键、过程及公开 marker 文件，必要时在测试库暂装内置 adminpack/dblink 并清理新增扩展，已有扩展保留。UDF 语法检查使用不存在的合成 `.so` 名，不装实际库。

```sh
# 仅在专属临时服务已准备好后运行，不能指向已有业务数据库：
ABILOCK_TEST_ENV=/tmp/owned-fixture-config.json npx --no-install tsx scripts/real-database-check.ts
```

测试服务的创建、随机 loopback 端口和最终清理由运行者管理；脚本不会执行 Docker run/pull/stop。测试角色的 FILE/contrib 权限只用于合成语义检查，不是生产推荐权限。结果写入本地 artifacts，不随源码分发；必须按本次执行结果和源码版本判断，不能以旧报告或协议 fixture 代替当前真实服务验收。此集成入口显式使用临时 loopback 明文连接，不能证明生产 TLS、证书身份、真实账号权限或全部数据库版本已验收。

官方/项目维护方资料：

- [PostgreSQL psql 参数与元命令](https://www.postgresql.org/docs/current/app-psql.html)、[COPY 的客户端/服务端文件与 PROGRAM 语义](https://www.postgresql.org/docs/current/sql-copy.html)、[PostgreSQL 消息格式](https://www.postgresql.org/docs/current/protocol-message-formats.html)。
- [node-postgres 原生参数查询](https://node-postgres.com/features/queries)、[node-postgres TLS](https://node-postgres.com/features/ssl)。
- [MySQL2 查询与 prepared statements](https://sidorares.github.io/node-mysql2/docs)、[MySQL2 连接配置](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-connection)、[MySQL LOAD DATA LOCAL 安全说明](https://dev.mysql.com/doc/refman/8.4/en/load-data-local-security.html)、[MySQL 协议基础](https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basics.html)。
- [MySQL 8.4 可加载 UDF 与 AGGREGATE/SONAME 语法](https://dev.mysql.com/doc/refman/8.4/en/create-function-loadable.html)、[MySQL compound/stored-program 语法](https://dev.mysql.com/doc/refman/8.4/en/sql-compound-statements.html)、[PostgreSQL 16 adminpack 文件写入函数](https://www.postgresql.org/docs/16/adminpack.html)、[PostgreSQL dblink 连接/查询入口](https://www.postgresql.org/docs/current/contrib-dblink-function.html)。
- [PostgreSQL 16 CREATE SCHEMA 简单头部及可内嵌 schema_element 的官方语法](https://www.postgresql.org/docs/16/sql-createschema.html)。
- [Redis Node.js 连接与 TLS](https://redis.io/docs/latest/develop/clients/nodejs/connect/)、[Redis 命令目录](https://redis.io/docs/latest/commands/)、[Redis RESP 协议](https://redis.io/docs/latest/develop/reference/protocol-spec/)。
