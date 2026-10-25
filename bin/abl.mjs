#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { managementUrl, openConfigPage } from "./open-config.mjs";
import { openApplication } from "./app.mjs";
import { discoverMain } from "./discover.mjs";
import { experienceMain, captureExperienceResult } from "./experience.mjs";
import { chatRequest } from "./chat.mjs";
import requestLimits from "../request-limits.json" with { type: "json" };
import { requestProgress } from "./request-progress.mjs";
import { protocolDocument } from "./document.mjs";
import { nativeKinds } from "./native-kinds.mjs";
import { createCliTrace } from "./trace.mjs";
import { prepareOutput, saveOutput } from "./client-output.mjs";
import {
  brokerFetch,
  localBase,
  remoteExecution,
  localConfiguration,
  localTerminal,
} from "./local-transport.mjs";
import {
  safeManifestPath,
  validateManifestPaths,
  checkpointMarker,
  inspectOutputDestination,
  applyTrackedWorktree,
  collectSelectedFiles,
  readSelectedFile,
  commitCheckpoint,
  collectGitCommitFiles,
  digest,
} from "./client-files.mjs";
// Execution client only. Local credentials stay inside the one-shot execution component.
const help = `Abilock · abl — 用连接别名执行原生业务操作
  abl app [--json]                         打开桌面应用
  abl config [--json]                      临时配置页面，Ctrl+C 结束
  abl list [--json] [--query TEXT]           已配置能力与简要说明
  abl platforms [--json]                   HTTP 平台
  abl connections [--json]                  协议连接
  abl doc ALIAS [--json]                   HTTP 文档
  abl learn ALIAS --source URL [--json]     获取公开文档
  abl learn ALIAS --file interfaces.json [--json]  保存 AI 整理的用法
  abl doc KIND SELECTOR [--json]           协议上下文与能力边界
  abl api ALIAS --file request.json [--json | --output result.bin]
  abl api ALIAS --stdin [--json | --output result.bin]
  abl api ALIAS chat TEXT [--json]           使用已保存的聊天接口
  abl api ALIAS ... --abl-progress          每 30 秒在 stderr 显示等待/接收状态
  abl api ALIAS --file request.json --json --experience [--method-id UUID]
                                             为本次调用收集非秘密方法验证证据
  abl experience search --query TEXT [--alias ALIAS] [--limit 1..5] [--json]
  abl experience get ALIAS ID [--previous] [--json] 按需读取方法或仅供恢复参考的上一版
  abl experience evidence ALIAS ID [--json]  查看本机执行器的验证证据
  abl experience learn ALIAS --file method.json [--json]  从证据保存方法（最多 16 KiB）
  abl experience status [--offset N] [--limit 1..20] [--json]  分页查看经验状态与容量
  abl experience mark ALIAS ID --status stale|archived --revision N --reason REASON [--json]
  abl experience remove ALIAS ID --revision N [--json]  移出检索并保留受限恢复记录
  abl ssh SELECTOR [-- COMMAND ARG ...]     无命令时进入交互终端
  abl sftp SELECTOR ls|stat|mkdir|rm|rmdir|put|get ...
  abl scp SELECTOR [-r] LOCAL :REMOTE       或 :REMOTE LOCAL
  abl rsync SELECTOR [-r|--recursive] [--dry-run|--checksum|--delete] LOCAL :REMOTE
  abl postgres|mysql SELECTOR "SQL"           单字符串 SQL
  abl postgres|psql|mysql|redis SELECTOR [原生命令参数 ...]
  abl git|s3|aws|docker|registry|kubectl SELECTOR [受支持原生命令参数 ...]
  abl registry SELECTOR catalog|tags|manifest|blob [原生子集参数 ...]
  abl git SELECTOR clone [--branch BRANCH] [LOCAL_DIR]
  abl git SELECTOR commit REPO_ID -m MESSAGE --abl-directory LOCAL_DIR
  abl git SELECTOR pull REPO_ID [--abl-directory LOCAL_DIR]
  abl git SELECTOR workspaces | drop REPO_ID  列出或删除 broker 中的 Git 工作区
  abl KIND SELECTOR --request-json operation.json [--json]
  abl KIND SELECTOR --request-stdin [--json]

abl 是唯一可执行入口。别名或唯一 IP 选择连接；同 IP 多身份由服务拒绝猜测。
HTTP --file / --stdin 封装示例（方法、路径和 body 按已配置说明替换）：
{"method":"POST","path":"/allowed-path","body":{"prompt":"业务输入"}}
--request-json / --request-stdin 封装：{args:[],input?:string,files?:[{path,base64}],timeoutMs?:number}。
协议命令中 --abl-input FILE / --abl-stdin 提供原生文本输入，--abl-json 输出固定 envelope；--json 放在 --request-json/--request-stdin 后也可用。
显式 -- 后是原生业务参数；--abl-* 包装选项及旧兼容名放在 -- 前。分隔符不豁免服务端的目标、鉴权或扩展限制。
CLI 保留受控子集内的参数，具体支持范围先读取 abl doc KIND SELECTOR。
默认本地命令通过一次性执行程序调用，结束即退出，无监听端口或后台服务。
HTTP API 默认及最大等待 7 分钟；请求文件 timeoutMs 可设置更短期限。
macOS 首次 config 由系统请求一次管理员授权安装权限隔离；日常命令按需执行，不常驻。
config 临时启动本机管理页；密码和平台凭据只能在用户界面输入，没有读取/导出入口。
非秘密地址：ABILOCK_ADMIN_URL / ABILOCK_ENDPOINT。
显式远程模式使用 ABILOCK_ENDPOINT / ABILOCK_EXEC_TOKEN，执行令牌不是上游凭据。
--abl-trace 仅在 stderr 显示本次命令和服务操作编号；不会向业务输出插入编号。
参数不接受秘密、目标或鉴权覆盖；聊天快捷命令使用已保存的接口和模型。
文件传输仅读取明确选择的普通文件；文件响应用本地路径保存，不能覆盖符号链接。
退出码：0 成功，2 输入错误，3 服务/连接错误，4 上游错误，130 取消。不自动重试。
吉豆茄 jidouqie · https://v.douyin.com/oApPI_L9avQ
`;
let modeJson = false;
const trace = createCliTrace();
function responseHeader(response, suffix) {
  return (
    response.headers.get(`x-abilock-${suffix}`) ??
    response.headers.get(`x-coi-${suffix}`)
  );
}
function fail(code, message, exitCode = 2) {
  if (modeJson) trace.json({ ok: false, error: { code, message } });
  else process.stderr.write(`${code}: ${message}\n`);
  trace.notice();
  process.exitCode = exitCode;
}
function wrapperArguments(args) {
  const separator = args.indexOf("--");
  return separator < 0 ? args : args.slice(0, separator);
}
async function main() {
  const legacyFlags = new Map([
    ["--pvo-json", "--abl-json"],
    ["--pvo-input", "--abl-input"],
    ["--pvo-stdin", "--abl-stdin"],
    ["--pvo-directory", "--abl-directory"],
  ]);
  const raw = process.argv.slice(2),
    separator = raw.indexOf("--");
  const args = raw.map((arg, index) =>
    separator < 0 || index < separator ? (legacyFlags.get(arg) ?? arg) : arg,
  );
  // Old product names stay accepted for existing setups; say so once on stderr
  // so they can be migrated before support is removed.
  if (
    raw.some(
      (arg, index) =>
        (separator < 0 || index < separator) && legacyFlags.has(arg),
    ) ||
    Object.keys(process.env).some((name) => /^(?:PERMIVELO|COI)_/.test(name))
  )
    process.stderr.write(
      "提示：PERMIVELO_*/COI_* 环境变量和 --pvo-* 参数是旧名称兼容写法，请改用 ABILOCK_* 与 --abl-*。\n",
    );
  const wrappers = wrapperArguments(args);
  modeJson = wrappers.includes("--json") || wrappers.includes("--abl-json");
  const traceFlags = wrappers.filter((arg) => arg === "--abl-trace").length;
  if (traceFlags > 1) return fail("USAGE", "--abl-trace 不可重复");
  if (traceFlags) {
    args.splice(args.indexOf("--abl-trace"), 1);
    trace.show(true);
  }
  if (!args.length || args[0] === "help" || args[0] === "--help") {
    process.stdout.write(help);
    return;
  }
  let command = args.shift();
  if (command === "api") command = "call";
  if (command === "doc") command = "docs";
  if (command === "app") {
    if(args.length>1||(args.length===1&&args[0]!=="--json"))return fail("USAGE","app only accepts --json");
    try {
      await openApplication();
      if(modeJson)trace.json({ok:true,event:"application-launch-requested"});
    }catch(error){return fail(error.code??"APPLICATION_START",error.message,error.exit??3);}
    return;
  }
  if (command === "learn") return learnMain(args);
  if (command === "experience") return experienceMain(args, fail, trace);
  if (command === "list" || command === "discover") {
    await discoverMain(args, executionAccess, fail, trace);
    return;
  }
  if (command === "config") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
      return fail("USAGE", "config 只接受 --json；密码与平台凭据请在页面输入");
    const explicitAdmin =
      process.env.ABILOCK_ADMIN_URL ??
      process.env.PERMIVELO_ADMIN_URL ??
      process.env.COI_ADMIN_URL;
    if (explicitAdmin === undefined && !remoteExecution()) {
      try {
        process.exitCode = await localConfiguration({ json: modeJson });
      } catch (error) {
        return fail(
          error.code ?? "LOCAL_CONFIGURATION",
          error.message,
          error.exit ?? 3,
        );
      }
      return;
    }
    let url;
    try {
      url = managementUrl(
        process.env.ABILOCK_ADMIN_URL ??
          process.env.PERMIVELO_ADMIN_URL ??
          process.env.COI_ADMIN_URL,
      );
    } catch {
      return fail(
        "ADMIN_URL",
        "管理地址需为无认证信息的 loopback HTTP 或 HTTPS 根地址",
      );
    }
    try {
      await openConfigPage(url);
    } catch {
      return fail("BROWSER", "无法打开管理页面，请手动访问已配置的管理地址", 3);
    }
    if (modeJson) trace.json({ ok: true, data: { url, opened: true } });
    else process.stdout.write(`已打开管理页面：${url}\n`);
    trace.notice();
    return;
  }
  if (
    command === "connections" ||
    nativeKinds.has(command) ||
    (command === "docs" &&
      args.length >= 2 &&
      nativeKinds.has(args[0]) &&
      !args[1].startsWith("--"))
  ) {
    await nativeMain(command, args);
    return;
  }
  const alias = command === "platforms" ? undefined : args.shift();
  if (
    !["platforms", "docs", "call"].includes(command) ||
    (alias && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias))
  )
    return fail("USAGE", "请使用 abl --help");
  let chatText;
  if (command === "call" && args[0] === "chat") {
    args.shift();
    chatText = args.shift();
    if (
      !chatText ||
      chatText.startsWith("--") ||
      Buffer.byteLength(chatText) > 20 * 1024 * 1024
    )
      return fail(
        "USAGE",
        "chat 需要一个非空文字参数，可追加 --json、--abl-progress",
      );
  }
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      !["--json", "--file", "--stdin", "--output", "--abl-progress", "--experience", "--method-id"].includes(
        key,
      ) ||
      flags.has(key)
    )
      return fail("USAGE", "未知或重复选项");
    if (["--file", "--output", "--method-id"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) return fail("USAGE", "选项缺少值");
      flags.set(key, value);
    } else flags.set(key, true);
  }
  if (command !== "platforms" && !alias) return fail("USAGE", "需要平台别名");
  if (command !== "call" && [...flags.keys()].some((x) => x !== "--json"))
    return fail("USAGE", "该命令只接受 --json");
  if (flags.has("--json") && flags.has("--output"))
    return fail("USAGE", "--json 与 --output 不可同时使用");
  if (flags.has("--method-id") && (!flags.has("--experience") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(flags.get("--method-id"))))
    return fail("USAGE", "--method-id 需要 --experience 及有效方法编号");
  if (
    chatText !== undefined &&
    [...flags.keys()].some((x) => !["--json", "--abl-progress"].includes(x))
  )
    return fail(
      "USAGE",
      "chat 只接受文字、--json、--abl-progress；接口与模型由 Skill 整理官方文档",
    );
  let outputPlan;
  if (flags.has("--output")) {
    try {
      outputPlan = await prepareOutput(flags.get("--output"));
    } catch {
      return fail("FILE_OUTPUT", "输出路径不安全或无效，请选择普通业务文件", 2);
    }
  }
  let input;
  if (command === "call" && chatText === undefined) {
    if (flags.has("--file") === flags.has("--stdin"))
      return fail("USAGE", "请选择 --file 或 --stdin");
    let raw;
    try {
      raw = flags.has("--file")
        ? await readSelectedText(flags.get("--file"), 20 * 1024 * 1024)
        : await new Promise((resolve, reject) => {
            let s = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => {
              s += c;
              if (s.length > 20 * 1024 * 1024) {
                reject(new Error());
                process.stdin.destroy();
              }
            });
            process.stdin.on("end", () => resolve(s));
            process.stdin.on("error", reject);
          });
      if (Buffer.byteLength(raw) > 20 * 1024 * 1024) throw new Error();
      input = JSON.parse(raw);
      trace.assertInput(input);
    } catch (error) {
      if (error.code === "TRACE_INPUT")
        return fail(error.code, error.message, 2);
      return fail("INVALID_INPUT", "无法读取有效 JSON 请求文件/stdin");
    }
  }
  const collectExperience = command === "call" && (flags.has("--experience") || input?.experience !== undefined);
  if (collectExperience) {
    if (!flags.has("--json")) return fail("USAGE", "经验验证需要 --json，以便独立报告调用结果与经验状态");
    if (remoteExecution()) return fail("LOCAL_EXPERIENCE", "经验验证仅支持本机执行器；本次未调用上游", 3);
    if (flags.has("--experience")) {
      if (input.experience !== undefined) return fail("USAGE", "经验选项请只在命令行或请求文件中提供一次");
      input.experience = { capture: true, ...(flags.has("--method-id") ? { methodId: flags.get("--method-id") } : {}) };
    }
  }
  let access;
  try {
    access = executionAccess();
  } catch (error) {
    return fail(error.code, error.message, error.exit ?? 2);
  }
  const { base, token } = access;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  let timer = setTimeout(
    () => controller.abort(),
    command === "call" && chatText === undefined
      ? requestLimits.httpClientTimeoutMs
      : requestLimits.metadataClientTimeoutMs,
  );
  timer.unref();
  let progress;
  try {
    if (chatText !== undefined) {
      input = await chatRequest(
        base,
        token,
        alias,
        chatText,
        controller.signal,
        trace,
      );
      clearTimeout(timer);
      controller.signal.throwIfAborted();
      timer = setTimeout(
        () => controller.abort(),
        requestLimits.httpClientTimeoutMs,
      );
      timer.unref();
    }
    progress = requestProgress({
      enabled:
        command === "call" &&
        (flags.has("--abl-progress") || process.stderr.isTTY === true),
    });
    const route =
      command === "platforms"
        ? "/v1/platforms"
        : command === "docs"
          ? `/v1/context/${alias}`
          : `/v1/call/${alias}`;
    trace.reset();
    const res = progress.wrap(
      await brokerFetch(new URL(route, base), {
        method: command === "call" ? "POST" : "GET",
        headers: trace.headers({
          authorization: `Bearer ${token}`,
          ...(input ? { "content-type": "application/json" } : {}),
        }),
        body: input ? JSON.stringify(trace.envelope(input)) : undefined,
        signal: controller.signal,
        redirect: "error",
      }),
    );
    trace.response(res);
    const status = res.status,
      requestId = responseHeader(res, "request-id"),
      type = res.headers.get("content-type") ?? "";
    if (command !== "call") {
      const value = await res.json();
      trace.verifyBody(value);
      if (!res.ok) {
        if (modeJson)
          trace.json({
            ok: false,
            status,
            requestId,
            error: value.error,
          });
        else
          fail(
            value.error?.code ?? "SERVICE_ERROR",
            value.error?.message ?? "服务错误",
            3,
          );
        process.exitCode = 3;
        return;
      }
      if (modeJson) trace.json({ ok: true, status, requestId, data: value });
      else if (command === "platforms")
        for (const p of value.platforms)
          process.stdout.write(
            `${p.alias}\t${p.name}\t${p.enabled ? "启用" : "停用"}\t${p.hasSecret ? "已配置鉴权" : "未配置/无需鉴权"}\n`,
          );
      else {
        process.stdout.write(
          `# ${value.platform.alias} · ${value.platform.name}\n\nBase URL: ${value.platform.baseUrl}\n允许接口: ${JSON.stringify(value.platform.rules)}\n\n`,
        );
        for (const d of value.docs)
          process.stdout.write(
            `## ${d.title}\n来源: ${d.sourceUrl}\n更新时间: ${d.updatedAt}\n\n${d.markdown}\n\n`,
          );
      }
      return;
    }
    if (flags.has("--json")) {
      const bytes = Buffer.from(await res.arrayBuffer());
      let data, encoding;
      if (type.includes("json")) {
        try {
          data = JSON.parse(bytes.toString());
          encoding = "json";
        } catch {
          data = bytes.toString();
          encoding = "utf8";
        }
      } else if (/^(text\/|application\/xml)/.test(type)) {
        data = bytes.toString();
        encoding = "utf8";
      } else {
        data = bytes.toString("base64");
        encoding = "base64";
      }
      let experience;
      if (collectExperience) {
        const receiptController = new AbortController();
        const receiptTimer = setTimeout(() => receiptController.abort(), 5000);
        receiptTimer.unref();
        try {
          experience = await captureExperienceResult(alias, res.headers.get("x-abilock-experience-id"), { signal: receiptController.signal });
        } finally { clearTimeout(receiptTimer); }
        if (experience.status === "unavailable")
          process.stderr.write("经验验证信息暂不可用；原调用结果保留，请按需读取连接手册。\n");
      }
      trace.json({
        ok: res.ok,
        status,
        requestId,
        contentType: type,
        encoding,
        data,
        ...(experience ? { experience } : {}),
      });
    } else if (flags.has("--output") && res.ok) {
      await saveOutput(
        outputPlan,
        () => Readable.fromWeb(res.body),
        controller.signal,
      );
      process.stderr.write(`已保存响应：${flags.get("--output")}\n`);
    } else {
      if (res.body)
        await pipeline(Readable.fromWeb(res.body), process.stdout, {
          signal: controller.signal,
        });
    }
    if (!res.ok)
      process.exitCode =
        responseHeader(res, "response-kind") === "upstream"
          ? 4
          : status === 400 || status === 415
            ? 2
            : 3;
  } catch (e) {
    if (
      [
        "CONFIG_REQUIRED",
        "CONTEXT_ACCESS",
        "FILE_OUTPUT",
        "TRACE_CONTEXT",
        "TRACE_INPUT",
        "LOCAL_RUNTIME_REQUIRED",
        "LOCAL_EXECUTION",
      ].includes(e.code)
    )
      return fail(e.code, e.message, e.exit ?? 2);
    if (e.name === "AbortError")
      return fail("CANCELLED", "请求已取消或超时", 130);
    fail("CONNECTION", "连接或响应读取失败；不会自动重试", 3);
  } finally {
    clearTimeout(timer);
    progress?.stop();
  }
}
async function learnMain(args) {
  const alias = args.shift();
  if (!alias || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(alias))
    return fail("USAGE", "learn 需要连接别名");
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--source", "--file", "--json"].includes(flag) || options.has(flag))
      return fail("USAGE", "learn 只接受 --source 或 --file，以及 --json");
    if (flag === "--json") options.set(flag, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        return fail("USAGE", "learn 选项缺少值");
      options.set(flag, value);
    }
  }
  if (options.has("--source") === options.has("--file"))
    return fail("USAGE", "learn 请选择 --source 或 --file");
  if (remoteExecution())
    return fail(
      "LOCAL_LEARN",
      "整理用法请使用本地 CLI，不通过远程管理接口写入",
      3,
    );
  let payload;
  try {
    if (options.has("--source"))
      payload = { kind: "source", sourceUrl: options.get("--source") };
    else {
      const manifest = JSON.parse(
        await readSelectedText(options.get("--file"), 20 * 1024 * 1024),
      );
      trace.assertInput(manifest);
      payload = { kind: "manifest", manifest };
    }
  } catch {
    return fail("INVALID_INPUT", "无法读取公开用法文件");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(cancel, requestLimits.metadataClientTimeoutMs);
  timer.unref();
  try {
    trace.reset();
    const response = await brokerFetch(
      new URL(`/v2/learn/${alias}`, localBase),
      {
        method: "POST",
        headers: trace.headers({ "content-type": "application/json" }),
        body: JSON.stringify(trace.envelope(payload)),
        signal: controller.signal,
      },
    );
    trace.response(response);
    const value = await response.json();
    trace.verifyBody(value);
    if (response.ok && payload.kind === "manifest" && value.docsExportStatus?.status === "pending")
      process.stderr.write("已保存；Markdown 副本待重建，下次配置或保存时自动重试，无需重复导入。\n");
    if (!response.ok) {
      if (modeJson)
        trace.json({ ok: false, status: response.status, error: value.error });
      else
        fail(
          value.error?.code ?? "LEARN_FAILED",
          value.error?.message ?? "接口整理失败",
          3,
        );
      process.exitCode = response.status === 400 ? 2 : 3;
    } else if (modeJson)
      trace.json({ ok: true, status: response.status, data: value });
    else if (options.has("--source"))
      process.stdout.write(value.markdown + "\n");
    else process.stdout.write(`已保存 ${alias} 的用法\n`);
  } catch (error) {
    if (controller.signal.aborted)
      return fail("CANCELLED", "接口整理已取消", 130);
    fail(
      error.code ?? "LEARN_FAILED",
      error.code ? error.message : "接口整理失败；不会自动重试",
      3,
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
const clientLimit = 10 * 1024 * 1024;
function executionAccess() {
  if (!remoteExecution())
    return { base: new URL(localBase), token: "local-cli-no-network" };
  const value =
    process.env.ABILOCK_ENDPOINT ??
    process.env.PERMIVELO_ENDPOINT ??
    process.env.COI_ENDPOINT ??
    "http://127.0.0.1:4318";
  let base;
  try {
    base = new URL(value);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      !["http:", "https:"].includes(base.protocol) ||
      (base.protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
    )
      throw new Error();
  } catch {
    throw Object.assign(
      new Error("执行地址需为无认证信息的 loopback HTTP 或 HTTPS 根地址"),
      { code: "ENDPOINT" },
    );
  }
  const token =
    process.env.ABILOCK_EXEC_TOKEN ??
    process.env.PERMIVELO_EXEC_TOKEN ??
    process.env.COI_EXEC_TOKEN;
  if (!token)
    throw Object.assign(
      new Error("未配置服务执行能力令牌；请配置 ABILOCK_EXEC_TOKEN"),
      { code: "EXECUTION_ACCESS", exit: 3 },
    );
  return { base, token };
}
function selectorSafe(value) {
  // URL/user identity syntax never becomes an execution destination.
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    !value.startsWith("-") &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9_.:[\]-]+$/.test(value) &&
    !value.includes("/") &&
    !value.includes("@")
  );
}
async function inputJson(file) {
  let raw;
  if (file) raw = await readSelectedText(file, 20 * 1024 * 1024);
  else {
    const parts = [];
    let size = 0;
    for await (const part of process.stdin) {
      size += part.length;
      if (size > 20 * 1024 * 1024) throw new Error();
      parts.push(part);
    }
    raw = Buffer.concat(parts).toString();
  }
  if (Buffer.byteLength(raw) > 20 * 1024 * 1024) throw new Error();
  const value = JSON.parse(raw);
  trace.assertInput(value);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) => !["args", "input", "files", "timeoutMs"].includes(key),
    ) ||
    !Array.isArray(value.args) ||
    value.args.length > 200 ||
    value.args.some((arg) => typeof arg !== "string" || arg.length > 100000) ||
    (value.input !== undefined && typeof value.input !== "string") ||
    (value.timeoutMs !== undefined &&
      (!Number.isInteger(value.timeoutMs) ||
        value.timeoutMs < 100 ||
        value.timeoutMs > requestLimits.protocolMaxTimeoutMs))
  )
    throw new Error();
  if (
    value.files !== undefined &&
    (!Array.isArray(value.files) ||
      value.files.length > 100 ||
      value.files.some(
        (file) =>
          !file ||
          Object.keys(file).some((key) => !["path", "base64"].includes(key)) ||
          !safeManifestPath(file.path) ||
          typeof file.base64 !== "string",
      ))
  )
    throw new Error();
  if (value.files !== undefined) validateManifestPaths(value.files);
  return value;
}
const collectFiles = collectSelectedFiles;
async function checkLocalParents(target) {
  const absolute = path.resolve(target),
    root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        const systemAlias =
          process.platform === "darwin" &&
          ["/var", "/tmp"].includes(current) &&
          (await fs.realpath(current)) === `/private${current}`;
        if (!systemAlias) throw new Error("symlink");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function saveReturnedFiles(
  files,
  destination,
  directory,
  signal,
  git = false,
) {
  if (!Array.isArray(files) || files.length > (git ? 1000 : 100))
    throw new Error();
  validateManifestPaths(files, git);
  const root = path.resolve(destination),
    seen = new Set();
  let size = 0;
  const prepared = [];
  for (const file of files) {
    if (
      !safeManifestPath(file.path) ||
      typeof file.base64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.base64,
      )
    )
      throw new Error();
    const bytes = Buffer.from(file.base64, "base64");
    size += bytes.length;
    if (size > (git ? 20 * 1024 * 1024 : clientLimit)) throw new Error();
    if (!directory && files.length !== 1) throw new Error();
    const relative =
      directory && !git && file.path.startsWith(`${path.basename(root)}/`)
        ? file.path.slice(path.basename(root).length + 1)
        : file.path;
    const dest = directory ? path.resolve(root, relative) : root;
    if (directory && (!dest.startsWith(`${root}${path.sep}`) || dest === root))
      throw new Error();
    if (seen.has(dest.toLowerCase())) throw new Error();
    seen.add(dest.toLowerCase());
    await inspectOutputDestination(dest);
    try {
      const stat = await fs.lstat(dest);
      if (!stat.isFile()) throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    prepared.push({ dest, bytes });
  }
  if (directory)
    validateManifestPaths(
      prepared.map(({ dest }) => ({ path: path.relative(root, dest) })),
      git,
    );
  const plans = [];
  for (const { dest, bytes } of prepared)
    plans.push({
      plan: await prepareOutput(dest, { createParents: true }),
      bytes,
    });
  for (const { plan, bytes } of plans)
    await saveOutput(plan, Readable.from([bytes]), signal);
}
async function saveGitWorktree(files, destination, operation, selector, data) {
  return applyTrackedWorktree(
    files,
    destination,
    operation.args[0],
    selector,
    data,
  );
}

async function updateGitCheckpoint(
  directory,
  operation,
  selector,
  data,
  trackedFiles,
  expectedCheckpointHash,
  signal,
) {
  signal?.throwIfAborted();
  const root = path.resolve(directory),
    marker = await checkpointMarker(root);
  await checkLocalParents(marker);
  const markerBytes = await readSelectedFile(marker);
  if (digest(markerBytes) !== expectedCheckpointHash)
    throw new Error("Git checkpoint changed during commit");
  const previous = JSON.parse(markerBytes.toString("utf8"));
  const record = commitCheckpoint(
    previous,
    trackedFiles,
    selector,
    data,
    operation.args[1],
  );
  if (!record) return false;
  const temp = `${marker}.${process.pid}.part`;
  try {
    await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    signal?.throwIfAborted();
    if (!(await readSelectedFile(marker)).equals(markerBytes))
      throw new Error("Git checkpoint changed during commit");
    signal?.throwIfAborted();
    await fs.rename(temp, marker);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
  return true;
}
async function prepareGit(args, selector, wrapperLength = args.length) {
  let destination, commitDirectory, commitCheckpointHash;
  const localIndex = args.slice(0, wrapperLength).indexOf("--abl-directory");
  if (localIndex >= 0) {
    if (
      localIndex + 1 >= wrapperLength ||
      !args[localIndex + 1] ||
      args[localIndex + 1].startsWith("--") ||
      args.slice(0, wrapperLength).filter((arg) => arg === "--abl-directory")
        .length !== 1
    )
      throw new Error();
    destination = args[localIndex + 1];
    args.splice(localIndex, 2);
  }
  const command = args[0];
  if (command === "clone") {
    const positional = [];
    for (let i = 1; i < args.length; i++) {
      if (["--branch", "-b", "--depth"].includes(args[i])) i++;
      else if (!args[i].startsWith("-")) positional.push(i);
    }
    if (positional.length > 1 || (positional.length && destination))
      throw new Error();
    if (positional.length) {
      destination = args[positional[0]];
      args.splice(positional[0], 1);
    }
    destination ??= selector;
    if (destination.includes("://") || destination.includes("@"))
      throw new Error();
  } else if (command === "pull") destination ??= selector;
  else if (destination && command !== "commit") throw new Error();
  const operation = { args };
  if (command === "commit" && destination) {
    commitDirectory = destination;
    const collected = await collectGitCommitFiles(
      destination,
      selector,
      args[1],
    );
    operation.files = collected.files;
    operation.deletions = collected.deletions;
    commitCheckpointHash = collected.checkpointHash;
    destination = undefined;
  }
  if (command === "clone") {
    await checkLocalParents(path.resolve(destination));
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || (await fs.readdir(destination)).length)
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    operation,
    destination,
    directory: true,
    commitDirectory,
    commitCheckpointHash,
  };
}
async function prepareTransfer(command, original) {
  const args = [...original],
    recursive =
      command === "rsync" ||
      args.includes("-r") ||
      args.includes("--recursive");
  let destination,
    directory = recursive;
  if (command === "sftp") {
    if (args[0] === "put") {
      if (args.length !== 3) throw new Error();
      const upload = await collectFiles(args[1], false);
      args[1] = upload.label;
      return { operation: { args: ["sftp", ...args], files: upload.files } };
    }
    if (args[0] === "get") {
      if (args.length !== 3) throw new Error();
      destination = args[2];
      args[2] = path.basename(destination);
    }
    return {
      operation: { args: ["sftp", ...args] },
      destination,
      directory: false,
    };
  }
  const operandIndices = [],
    patterns = [];
  for (let i = 0; i < args.length; i++) {
    if (command === "rsync" && args[i] === "--exclude") {
      if (!args[i + 1]) throw new Error();
      patterns.push(args[++i]);
      continue;
    }
    if (command === "rsync" && args[i].startsWith("--exclude=")) {
      patterns.push(args[i].slice(10));
      continue;
    }
    if (!args[i].startsWith("-")) operandIndices.push({ value: args[i], i });
  }
  if (operandIndices.length !== 2) throw new Error();
  const [source, dest] = operandIndices;
  if (source.value.startsWith(":") === dest.value.startsWith(":"))
    throw new Error();
  if (source.value.startsWith(":")) {
    destination = dest.value;
    args[dest.i] = path.basename(destination);
    return { operation: { args: [command, ...args] }, destination, directory };
  }
  const upload = await collectFiles(source.value, recursive, patterns);
  args[source.i] = upload.label;
  directory = upload.directory;
  return {
    operation: { args: [command, ...args], files: upload.files },
    directory,
  };
}
async function readSelectedBytes(source) {
  if (source !== "-")
    return Buffer.from(
      (await collectFiles(source, false)).files[0].base64,
      "base64",
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > clientLimit) throw new Error();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readSelectedText(source, maxBytes = clientLimit) {
  if (source === "-") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > maxBytes) throw new Error();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  }
  return (await readSelectedFile(source, { maxBytes })).toString("utf8");
}
async function prepareNativeInput(
  command,
  original,
  wrapperLength = original.length,
) {
  const args = [...original],
    wrappers = args.slice(0, wrapperLength);
  let input, files, destination;
  const selected = wrappers.indexOf("--abl-input"),
    stdin = wrappers.indexOf("--abl-stdin");
  if (
    (selected >= 0 && stdin >= 0) ||
    wrappers.filter((arg) => arg === "--abl-input").length > 1 ||
    wrappers.filter((arg) => arg === "--abl-stdin").length > 1
  )
    throw new Error();
  let source;
  if (selected >= 0) {
    source = wrappers[selected + 1];
    if (!source || source.startsWith("--")) throw new Error();
    args.splice(selected, 2);
  } else if (stdin >= 0) {
    source = "-";
    args.splice(stdin, 1);
  }
  if (command === "redis" && ["-x", "--pipe"].includes(args[0])) {
    if (source === undefined && !process.stdin.isTTY) source = "-";
    if (source === undefined) throw new Error();
    return {
      operation: {
        args,
        files: [
          {
            path: "-",
            base64: (await readSelectedBytes(source)).toString("base64"),
          },
        ],
      },
      directory: false,
    };
  }
  if (source !== undefined) input = await readSelectedText(source);

  if (
    ["postgres", "psql", "mysql", "kubectl", "kubernetes"].includes(command)
  ) {
    const names = ["postgres", "psql", "mysql"].includes(command)
      ? ["-f", "--file"]
      : ["-f", "--filename"];
    const valueFlags = ["postgres", "psql", "mysql"].includes(command)
      ? ["-c", "--command", "-e", "--execute", "--params"]
      : [
          "-n",
          "--namespace",
          "--field-manager",
          "--dry-run",
          "-p",
          "--patch",
          "--type",
        ];
    const references = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (valueFlags.includes(arg)) {
        index++;
        continue;
      }
      const equals = names.find(
        (name) => name.startsWith("--") && arg.startsWith(`${name}=`),
      );
      if (!names.includes(arg) && !equals) continue;
      const source = equals ? arg.slice(equals.length + 1) : args[index + 1];
      if (!source || (source.startsWith("-") && source !== "-"))
        throw new Error();
      references.push({ index, source, equals });
      if (!equals) index++;
    }
    if (references.length > 1) throw new Error();
    const reference = references[0];
    if (reference) {
      const { index, source, equals } = reference;
      if (input !== undefined && source !== "-") throw new Error();
      if (input === undefined) input = await readSelectedText(source);
      if (equals) args[index] = `${equals}=-`;
      else args[index + 1] = "-";
    }
  }
  const objectArgs =
    command === "s3"
      ? args
      : command === "aws" && args[0] === "s3api"
        ? args.slice(1)
        : null;
  if (objectArgs) {
    const start = command === "aws" ? 1 : 0,
      verb = objectArgs[0];
    if (verb === "cp" && command === "s3") {
      if (objectArgs.length !== 3) throw new Error();
      const source = objectArgs[1],
        target = objectArgs[2];
      const sourceRemote = source.startsWith("s3://"),
        targetRemote = target.startsWith("s3://");
      if (!sourceRemote && targetRemote) {
        const upload = await collectFiles(source, false);
        args[1] = upload.label;
        files = upload.files;
      } else if (sourceRemote && !targetRemote) {
        destination = target;
        args[2] = path.basename(target);
      } else if (!sourceRemote && !targetRemote) throw new Error();
    } else if (["put", "put-object"].includes(verb)) {
      const index = args.indexOf("--body");
      if (index >= 0) {
        if (!args[index + 1]) throw new Error();
        const upload = await collectFiles(args[index + 1], false);
        args[index + 1] = upload.label;
        files = upload.files;
      } else if (
        verb === "put" &&
        objectArgs.length === 3 &&
        !objectArgs[1].startsWith("-")
      ) {
        // Short syntax mirrors the broker: key then explicit local source.
        const upload = await collectFiles(objectArgs[2], false);
        args[start + 2] = upload.label;
        files = upload.files;
      }
    } else if (["get", "get-object"].includes(verb)) {
      const positions = [];
      for (let i = start + 1; i < args.length; i++) {
        if (args[i].startsWith("--")) {
          if (!args[i].includes("=")) i++;
        } else positions.push(i);
      }
      const outIndex = positions.at(-1);
      if (
        outIndex !== undefined &&
        (positions.length >= 2 || args.includes("--key"))
      ) {
        destination = args[outIndex];
        args[outIndex] = path.basename(destination);
      }
    }
  }
  if (command === "registry") {
    const nested = ["manifest", "blob"].includes(args[0]);
    const verb = nested ? `${args[0]}-${args[1]}` : args[0];
    if (["manifest-put", "blob-put"].includes(verb)) {
      const index = args.indexOf("--body");
      if (index >= 0) {
        if (!args[index + 1]) throw new Error();
        const upload = await collectFiles(args[index + 1], false);
        args[index + 1] = upload.label;
        files = upload.files;
      }
    } else if (["manifest-get", "blob-get"].includes(verb)) {
      const positions = [];
      for (let i = nested ? 2 : 1; i < args.length; i++) {
        if (args[i].startsWith("--")) {
          if (!args[i].includes("=")) i++;
        } else positions.push(i);
      }
      if (positions.length === 3) {
        const index = positions[2];
        destination = args[index];
        args[index] = path.basename(destination);
      }
    }
  }
  if (
    input === undefined &&
    !process.stdin.isTTY &&
    ((command === "ssh" && args.length) ||
      (["postgres", "psql", "mysql"].includes(command) &&
        !args.some(
          (arg) =>
            ["-c", "--command", "-e", "--execute", "-f", "--file"].includes(
              arg,
            ) || /^--(?:command|execute|file)=/.test(arg),
        )))
  ) {
    const text = await readSelectedText("-");
    if (text.length) input = text;
  }
  return {
    operation: {
      args,
      ...(input !== undefined ? { input } : {}),
      ...(files ? { files } : {}),
    },
    destination,
    directory: false,
  };
}
function rejectCredentialArguments(command, args) {
  // Remote SSH command arguments are business data. SSH transport flags are not
  // parsed here; the broker supplies transport policy and never invokes local ssh.
  if (command === "ssh") return;
  // Redis operands after its command are business values, even when they look
  // like transport flags. The broker still validates the actual command/options.
  if (command === "redis") args = args.slice(0, args[0] === "-x" ? 2 : 1);
  const common =
    /^--(?:username|user|password|passwd|token|secret|secret-key|access-key|access-key-id|secret-access-key|session-token|private-key|identity|identity-file|credential|credentials|kubeconfig|client-key|client-certificate)(?:=|$)/i;
  if (
    args.some((value) => common.test(value)) ||
    ((command === "postgres" || command === "psql") &&
      args.some((arg) => arg === "-W" || /^postgres(?:ql)?:\/\//i.test(arg))) ||
    (command === "mysql" &&
      args.some((arg) => /^-p.+/.test(arg) || arg === "-p")) ||
    (command === "redis" &&
      args.some((arg) => arg === "-a" || /^rediss?:\/\//i.test(arg)))
  )
    throw Object.assign(
      new Error("凭据只能在管理页面输入，执行参数不接受凭据"),
      { code: "CREDENTIAL_ARGUMENT" },
    );
}
async function terminal(base, token, selector) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return fail(
      "TTY_REQUIRED",
      "交互 SSH 需要本地 TTY；自动化请提供远程命令或 operation JSON",
    );
  const { default: WebSocket } = await import("ws");
  trace.reset();
  const url = new URL(
    `/v2/terminal/ssh/${encodeURIComponent(selector).replaceAll("%3A", ":").replaceAll("%5B", "[").replaceAll("%5D", "]")}`,
    base,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket =
    base.origin === new URL(localBase).origin
      ? await localTerminal(
          selector,
          trace.headers({ authorization: `Bearer ${token}` }),
        )
      : new WebSocket(url, {
          headers: trace.headers({ authorization: `Bearer ${token}` }),
          followRedirects: false,
          maxPayload: 1024 * 1024,
        });
  const previousRaw = process.stdin.isRaw;
  let opened = false,
    finished = false,
    ready = false;
  let clientSequence = 0;
  function sendFrame(value) {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          ...value,
          direction: "client",
          sequence: ++clientSequence,
        }),
      );
  }
  await new Promise((resolve) => {
    const handshake = setTimeout(() => {
      fail("TERMINAL_TIMEOUT", "终端握手超时", 3);
      cleanup(3);
    }, 15000);
    function cleanup(code) {
      if (finished) return;
      finished = true;
      clearTimeout(handshake);
      if (process.stdin.isTTY && ready) process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdin.off("data", data);
      process.stdin.off("end", eof);
      process.stdout.off("resize", resize);
      process.off("SIGTERM", terminate);
      process.off("SIGINT", terminate);
      if (opened && ready) process.stdout.write("\r\n");
      process.exitCode = code;
      socket.close();
      resolve();
    }
    function data(bytes) {
      sendFrame({ type: "data", data: bytes.toString("base64") });
    }
    function eof() {
      sendFrame({ type: "eof" });
    }
    function resize() {
      if (ready)
        sendFrame({
          type: "resize",
          rows: Math.min(200, Math.max(2, process.stdout.rows ?? 24)),
          cols: Math.min(500, Math.max(2, process.stdout.columns ?? 80)),
        });
    }
    function terminate() {
      cleanup(130);
    }
    socket.once("open", () => {
      opened = true;
      sendFrame({
        type: "init",
        trace: { invocationId: trace.invocationId },
      });
      process.once("SIGTERM", terminate);
      process.once("SIGINT", terminate);
    });
    socket.on("message", (bytes) => {
      if (finished) return;
      let frame;
      try {
        frame = JSON.parse(bytes.toString());
        trace.frame(frame);
      } catch {
        fail("TERMINAL_PROTOCOL", "终端收到无效帧", 3);
        cleanup(3);
        return;
      }
      if (!ready && !["ready", "error"].includes(frame.type)) {
        fail("TERMINAL_PROTOCOL", "终端尚未就绪，拒绝其他操作帧", 3);
        cleanup(3);
        return;
      }
      if (frame.type === "ready" && !ready) {
        ready = true;
        clearTimeout(handshake);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", data);
        process.stdin.once("end", eof);
        process.stdout.on("resize", resize);
        resize();
      } else if (frame.type === "data" && typeof frame.data === "string")
        process.stdout.write(Buffer.from(frame.data, "base64"));
      else if (frame.type === "exit" && Number.isInteger(frame.code))
        cleanup(frame.code >= 0 && frame.code <= 255 ? frame.code : 3);
      else if (frame.type === "error") {
        fail(
          typeof frame.code === "string" ? frame.code : "TERMINAL_ERROR",
          "终端连接失败或被策略拒绝",
          3,
        );
        cleanup(3);
      }
    });
    socket.once("error", () => {
      fail("CONNECTION", "终端连接失败；不会自动重试", 3);
      cleanup(3);
    });
    socket.once("close", () => cleanup(3));
  });
}
async function nativeMain(command, args) {
  const documentMode = command === "docs";
  const initialWrappers = wrapperArguments(args);
  modeJson =
    command === "connections" || command === "docs"
      ? initialWrappers.includes("--json")
      : initialWrappers.includes("--abl-json");
  let selector, kind;
  if (command === "docs") {
    command = args.shift();
    kind = nativeKinds.get(command);
    selector = args.shift();
  } else if (command !== "connections") {
    kind = nativeKinds.get(command);
    selector = args.shift();
  }
  if (command !== "connections" && !selectorSafe(selector))
    return fail(
      "SELECTOR",
      "连接选择器需为别名或唯一 IP；目标/身份只在管理页面配置",
    );
  let operation,
    destination,
    directory,
    commitDirectory,
    commitCheckpointHash,
    contextOnly = !kind || documentMode;
  const separator = args.indexOf("--"),
    wrappers = wrapperArguments(args),
    native = separator < 0 ? [] : args.slice(separator + 1);
  try {
    if (contextOnly) {
      if (args.some((arg) => arg !== "--json") || args.length > 1)
        return fail("USAGE", "该命令只接受 --json");
    } else if (
      wrappers.includes("--request-json") ||
      wrappers.includes("--request-stdin")
    ) {
      if (separator >= 0) throw new Error();
      const fileIndex = args.indexOf("--request-json"),
        stdinIndex = args.indexOf("--request-stdin");
      if (fileIndex >= 0 === stdinIndex >= 0) throw new Error();
      const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
      if (fileIndex >= 0 && (!file || file.startsWith("--"))) throw new Error();
      const expected = file ? ["--request-json", file] : ["--request-stdin"];
      if (
        args.length === expected.length + 1 &&
        ["--json", "--abl-json"].includes(args.at(-1))
      ) {
        modeJson = true;
        args.pop();
      }
      if (args.join("\0") !== expected.join("\0")) throw new Error();
      operation = await inputJson(file);
      trace.assertInput(operation);
      rejectCredentialArguments(command, operation.args);
    } else {
      if (wrappers.includes("--abl-json")) {
        if (wrappers.filter((arg) => arg === "--abl-json").length !== 1)
          throw new Error();
        wrappers.splice(wrappers.indexOf("--abl-json"), 1);
      }
      args = [...wrappers, ...native];
      let wrapperLength = wrappers.length;
      if (
        ["mysql", "postgres", "psql"].includes(command) &&
        args.length === 1 &&
        !args[0].startsWith("-")
      ) {
        args.unshift(command === "mysql" ? "-e" : "-c");
        wrapperLength++;
      }
      if (["sftp", "scp", "rsync"].includes(command))
        ({ operation, destination, directory } = await prepareTransfer(
          command,
          args,
        ));
      else if (command === "git")
        ({
          operation,
          destination,
          directory,
          commitDirectory,
          commitCheckpointHash,
        } = await prepareGit(args, selector, wrapperLength));
      else
        ({ operation, destination, directory } = await prepareNativeInput(
          command,
          args,
          wrapperLength,
        ));
      rejectCredentialArguments(command, operation.args);
    }
  } catch (error) {
    return fail(
      error.code ?? "INVALID_INPUT",
      error.code ? error.message : "无法解析操作 JSON/传输文件/命令参数",
    );
  }
  let access;
  try {
    access = executionAccess();
  } catch (error) {
    return fail(error.code, error.message, error.exit ?? 2);
  }
  const { base, token } = access;
  if (!contextOnly && command === "ssh" && !operation.args.length)
    return terminal(base, token, selector);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(cancel, requestLimits.metadataClientTimeoutMs);
  timer.unref();
  try {
    const route =
      command === "connections"
        ? "/v2/connections"
        : contextOnly
          ? `/v2/context/${kind}/${encodeURIComponent(selector).replaceAll("%3A", ":").replaceAll("%5B", "[").replaceAll("%5D", "]")}`
          : `/v2/run/${kind}/${encodeURIComponent(selector).replaceAll("%3A", ":").replaceAll("%5B", "[").replaceAll("%5D", "]")}`;
    trace.reset();
    const response = await brokerFetch(new URL(route, base), {
      method: contextOnly ? "GET" : "POST",
      redirect: "error",
      signal: controller.signal,
      headers: trace.headers({
        authorization: `Bearer ${token}`,
        ...(!contextOnly ? { "content-type": "application/json" } : {}),
      }),
      body: !contextOnly
        ? JSON.stringify(trace.envelope(operation))
        : undefined,
    });
    trace.response(response);
    const value = await response.json();
    trace.verifyBody(value);
    const payload = value.result ?? value;
    if (!response.ok) {
      if (modeJson)
        trace.json({
          ok: false,
          status: response.status,
          requestId: responseHeader(response, "request-id"),
          error: value.error ?? {
            code: "SERVICE_ERROR",
            message: "服务错误",
          },
        });
      else
        fail(
          value.error?.code ?? "SERVICE_ERROR",
          value.error?.message ?? "服务错误",
          response.status === 400 ? 2 : 3,
        );
      process.exitCode = response.status === 400 ? 2 : 3;
      return;
    }
    if (destination && payload.exitCode === 0 && payload.files) {
      try {
        if (command === "git")
          await saveGitWorktree(
            payload.files,
            destination,
            operation,
            selector,
            payload.data,
          );
        else
          await saveReturnedFiles(
            payload.files,
            destination,
            !!directory,
            controller.signal,
          );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return fail(
          error?.code === "GIT_WORKTREE_RECOVERY"
            ? "GIT_WORKTREE_RECOVERY"
            : "FILE_OUTPUT",
          error?.code === "GIT_WORKTREE_RECOVERY"
            ? "Git 本地更新的安全恢复未完成；请保留所选目录下 .abl-worktree-*/recovery.json 及原 tracked 备份，并人工核对本地改动"
            : command === "git"
              ? "Git 检出保存失败；请核对本地文件与记录，不自动重试；pull 前请先 commit 本地改动"
              : "响应文件路径不安全或保存失败",
          3,
        );
      }
    }
    if (commitDirectory && payload.exitCode === 0) {
      try {
        controller.signal.throwIfAborted();
        const updated = await updateGitCheckpoint(
          commitDirectory,
          operation,
          selector,
          payload.data,
          payload.files,
          commitCheckpointHash,
          controller.signal,
        );
        if (!updated)
          process.stderr.write(
            "远端 commit 已完成；服务未返回实际 tracked 完整清单，本地检出记录保持原样。后续 pull 可能需重新获取检出。\n",
          );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return fail(
          "GIT_CHECKPOINT",
          "远端 commit 已完成，但本地检出记录更新失败；请保留 repoId 并重新获取检出",
          3,
        );
      }
    }
    if (modeJson)
      trace.json({
        ok: contextOnly || payload.exitCode === 0,
        status: response.status,
        requestId: responseHeader(response, "request-id"),
        data: value,
      });
    else if (command === "connections")
      for (const c of value.connections ?? [])
        process.stdout.write(
          `${c.alias}\t${c.kind}\t${c.name}\t${c.enabled ? "启用" : "停用"}\n`,
        );
    else if (contextOnly) process.stdout.write(protocolDocument(value));
    else {
      if (payload.stdout) process.stdout.write(payload.stdout);
      if (payload.stderr) process.stderr.write(payload.stderr);
      if (
        ["failed", "cancelled"].includes(payload.batch?.status) &&
        Array.isArray(payload.batch.items)
      ) {
        const labels = {
          completed: "已完成",
          failed: "失败",
          unknown: "结果未知",
          "not-started": "未开始",
        };
        process.stderr.write("\n批次结果：\n");
        for (const item of payload.batch.items) {
          if (
            !Number.isSafeInteger(item?.index) ||
            item.index < 0 ||
            typeof item.target !== "string" ||
            typeof item.status !== "string" ||
            !Object.hasOwn(labels, item.status)
          )
            continue;
          // Targets come from the service's redaction boundary. JSON quoting
          // prevents control characters from altering the terminal summary;
          // never interpolate raw exception messages or caller credentials.
          process.stderr.write(
            `${item.index + 1}. ${JSON.stringify(item.target)}：${labels[item.status]}\n`,
          );
        }
      }
      if (payload.data !== undefined && !payload.stdout)
        process.stdout.write(JSON.stringify(payload.data, null, 2) + "\n");
      if (payload.files && !destination)
        process.stdout.write(JSON.stringify({ files: payload.files }) + "\n");
      if (destination && payload.exitCode === 0)
        process.stderr.write("响应文件已保存。\n");
    }
    if (!contextOnly && payload.exitCode !== 0)
      process.exitCode =
        command === "ssh" &&
        Number.isInteger(payload.exitCode) &&
        payload.exitCode >= 0 &&
        payload.exitCode <= 255
          ? payload.exitCode
          : 4;
  } catch (error) {
    if (["TRACE_CONTEXT", "TRACE_INPUT"].includes(error.code))
      return fail(error.code, error.message, error.exit ?? 2);
    fail(
      error.name === "AbortError" ? "CANCELLED" : "CONNECTION",
      error.name === "AbortError"
        ? "请求已取消或超时"
        : "连接或响应读取失败；不会自动重试",
      error.name === "AbortError" ? 130 : 3,
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
main().catch(() => fail("CLIENT_ERROR", "客户端执行失败", 3));
