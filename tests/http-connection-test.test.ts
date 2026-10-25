import assert from "node:assert/strict";
import { test, mock } from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import type http from "node:http";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { AppError, type SavedPlatform } from "../src/schema.js";
import { assertHTTPConnectionTestConsent, planHTTPConnectionTest, testHTTPConnection } from "../src/http-connection-test.js";

const fakeKey = "synthetic-provider-key-ONLY-20261025";
const modelList = { object: "list", data: [{ id: "synthetic-model", object: "model" }] };
const openRouterKey = { data: { label: "synthetic-key-label", limit: null, limit_remaining: null,
  usage: 0, is_free_tier: true } };
function platform(baseUrl = "https://api.openai.com/v1", auth: SavedPlatform["auth"] = { type: "bearer" }): SavedPlatform {
  return { alias: "SYNTHETIC", name: "Synthetic provider", baseUrl, auth, enabled: true,
    rules: [], allowInsecureLocal: false, description: "", revision: 1, updatedAt: new Date(0).toISOString() };
}
type FixtureOptions = { status?: number; body?: unknown; raw?: string; contentType?: string; encoding?: string; pending?: boolean; dns?: string };
async function fixture<T>(options: FixtureOptions, run: (observations: {
  calls: { url: URL; headers: http.OutgoingHttpHeaders; method: string | undefined; body: string }[];
  started: Promise<void>;
}) => Promise<T>) {
  const calls: { url: URL; headers: http.OutgoingHttpHeaders; method: string | undefined; body: string }[] = [];
  const requests: EventEmitter[] = [];
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const lookup = mock.method(dns, "lookup", async () => [{ address: options.dns ?? "1.1.1.1", family: 4 }]);
  const request = mock.method(https, "request", (
    url: URL, settings: https.RequestOptions, onResponse: (response: http.IncomingMessage) => void,
  ) => {
    const call = { url: new URL(url), headers: settings.headers as http.OutgoingHttpHeaders, method: settings.method, body: "" };
    calls.push(call);
    const req = new EventEmitter();
    requests.push(req);
    const stream = new PassThrough();
    const response = Object.assign(stream, { statusCode: options.status ?? 200,
      headers: { "content-type": options.contentType ?? "application/json", "content-encoding": options.encoding } }) as unknown as http.IncomingMessage;
    const abort = () => {
      if (stream.destroyed) return;
      req.emit("error", settings.signal?.reason);
      stream.destroy();
      req.emit("close");
    };
    settings.signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => {
      settings.signal?.removeEventListener("abort", abort);
      req.emit("close");
    });
    return Object.assign(req, {
      write: (body: Buffer) => {
        if (settings.method !== "POST") throw new Error("Read-only test must not have a request body");
        call.body += body.toString("utf8");
      },
      destroy: () => stream.destroy(),
      end: () => queueMicrotask(() => {
        start();
        if (settings.signal?.aborted) return;
        if (!options.pending) {
          onResponse(response);
          stream.end(options.raw ?? JSON.stringify(options.body ?? modelList));
        }
      }),
    }) as unknown as http.ClientRequest;
  });
  try { return await run({ calls, started }); }
  finally {
    for (const req of requests) req.emit("close");
    lookup.mock.restore();
    request.mock.restore();
  }
}
function execute(saved = platform(), signal = new AbortController().signal) {
  return testHTTPConnection({ platform: saved, secret: { value: fakeKey }, signal });
}

test("provider plans require exact official authority, base prefix and saved authentication", async () => {
  for (const base of ["https://api.openai.com/v1", "https://api.openai.com", "https://api.deepseek.com",
    "https://openrouter.ai", "https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/",
    "https://api.siliconflow.cn/v1", "https://dashscope-intl.aliyuncs.com/api/v1", "https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1"]) {
    const plan = planHTTPConnectionTest(platform(base));
    assert.equal(plan.supported, true, base);
    assert.equal(plan.billing, "none");
    assert.equal(plan.model, null);
    assert.equal(plan.method, "GET");
  }
  for (const base of ["https://api.openai.com.example.net/v1", "https://api.openai.com:8443/v1", "https://api.openai.com/proxy/v1",
    "https://api.openai.com/v1?target=other", "https://user:password@api.openai.com/v1", "https://api.openai.com/v1#fragment",
    "http://api.openai.com/v1", "https://api.openai.com/v1%2f", "http://127.0.0.1:9999/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://api.deepseek.com/v1",
    "https://openrouter.ai.example.net/api/v1", "https://openrouter.ai:8443/api/v1", "https://openrouter.ai/proxy/api/v1",
    "https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1?target=other", "https://openrouter.ai/api/v1%2f",
    "https://eu.openrouter.ai/api/v1", "http://openrouter.ai/api/v1"]) {
    assert.equal(planHTTPConnectionTest(platform(base)).supported, false, base);
  }
  assert.equal(planHTTPConnectionTest(platform(undefined, { type: "none" })).supported, false);
  assert.equal(planHTTPConnectionTest(platform(undefined, { type: "header", name: "X-Api-Key" })).supported, false);
  assert.equal(planHTTPConnectionTest(platform("https://openrouter.ai/api/v1", { type: "none" })).supported, false);
  assert.equal(planHTTPConnectionTest(platform("https://openrouter.ai/api/v1", { type: "header", name: "X-Api-Key" })).supported, false);
  assert.equal(planHTTPConnectionTest(platform("https://api.anthropic.com/v1", { type: "header", name: "x-api-key" })).supported, true);
  assert.equal(planHTTPConnectionTest(platform("https://generativelanguage.googleapis.com/v1beta", { type: "query", name: "key" })).supported, true);
  await fixture({}, async ({ calls }) => {
    const result = await execute(platform("https://unknown.example/v1"));
    assert.equal(result.status, "unsupported");
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
  });
});

test("official read-only result proves only authentication and contains no returned provider data", async () => {
  const saved = platform();
  const before = structuredClone(saved);
  await fixture({ body: { ...modelList, metadata: { echoedKey: fakeKey } } }, async ({ calls }) => {
    const controller = new AbortController();
    const result = await execute(saved, controller.signal);
    assert.equal(result.status, "verified");
    assert.equal(result.level, "authentication");
    assert.match(result.message, /未验证模型调用/);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
    assert.equal(JSON.stringify(result).includes("synthetic-model"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, "https://api.openai.com/v1/models");
    assert.equal(calls[0].headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(calls[0].method, "GET");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  assert.deepEqual(saved, before, "Testing must not write business rules or saved configuration");
});

test("each provider checks its documented response structure and preserves its authentication", async () => {
  const cases = [
    { saved: platform("https://api.anthropic.com", { type: "header", name: "X-Api-Key" }),
      body: { data: [{ id: "fake-model", type: "model" }], has_more: false }, path: "/v1/models", query: "limit", header: "x-api-key" },
    { saved: platform("https://generativelanguage.googleapis.com/v1beta", { type: "query", name: "key" }),
      body: { models: [{ name: "models/fake" }] }, path: "/v1beta/models", query: "pageSize", header: null },
    { saved: platform("https://api.siliconflow.cn/v1"), body: modelList, path: "/v1/models", query: null, header: "authorization" },
    { saved: platform("https://openrouter.ai/api/v1"), body: openRouterKey, path: "/api/v1/key", query: null, header: "authorization" },
    { saved: platform("https://api.deepseek.com"), body: { is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }] },
      path: "/user/balance", query: null, header: "authorization" },
    { saved: platform("https://dashscope-intl.aliyuncs.com/api/v1"),
      body: { success: true, code: null, output: { models: [{ model: "synthetic-model" }], total: 1 } },
      path: "/api/v1/models", query: "page_size", header: "authorization" },
  ];
  for (const example of cases) await fixture({ body: example.body }, async ({ calls }) => {
    assert.equal((await execute(example.saved)).status, "verified");
    assert.equal(calls[0].url.origin, new URL(example.saved.baseUrl).origin);
    assert.equal(calls[0].url.pathname, example.path);
    if (example.query) assert.equal(calls[0].url.searchParams.get(example.query), "1");
    if (example.header) assert.ok(calls[0].headers[example.header]);
    else assert.equal(calls[0].url.searchParams.get("key"), fakeKey);
  });
});

test("OpenRouter checks the current key once without exposing key labels or implying model access", async () => {
  const saved = platform("https://openrouter.ai/api/v1");
  const plan = planHTTPConnectionTest(saved);
  assert.equal(plan.path, "/api/v1/key");
  assert.equal(plan.provider, "OpenRouter");
  assert.match(plan.message, /当前密钥鉴权/);
  await fixture({ body: { data: { ...openRouterKey.data, label: fakeKey, creator_user_id: "synthetic-owner" } } }, async ({ calls }) => {
    const result = await execute(saved);
    assert.equal(result.status, "verified");
    assert.equal(result.level, "authentication");
    assert.match(result.message, /未验证模型调用、余额或其他接口权限/);
    assert.equal(result.model, null);
    assert.equal(result.billing, "none");
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
    assert.equal(JSON.stringify(result).includes("synthetic-owner"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, "https://openrouter.ai/api/v1/key");
    assert.equal(calls[0].headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(calls[0].method, "GET");
  });
  for (const body of [{ ok: true }, modelList, { data: {} },
    { data: { ...openRouterKey.data, is_free_tier: "true" } },
    { data: { ...openRouterKey.data, usage: "0" } },
    { data: { ...openRouterKey.data, limit_remaining: "10" } },
    { data: { ...openRouterKey.data, limit: -1 } },
    { data: { ...openRouterKey.data, label: "" } }]) {
    await fixture({ body }, async () => {
      await assert.rejects(execute(saved), { code: "CONNECTION_TEST_PROTOCOL" });
    });
  }
  for (const limit_remaining of [0, -1]) await fixture({ body: { data: { ...openRouterKey.data, limit: 1, limit_remaining } } }, async ({ calls }) => {
    await assert.rejects(execute(saved), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "CONNECTION_TEST_BALANCE");
      assert.match(error.message, /鉴权已通过/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

test("OpenRouter without a saved key never starts a request or reports verification", async () => {
  await fixture({ body: openRouterKey }, async ({ calls }) => {
    await assert.rejects(testHTTPConnection({ platform: platform("https://openrouter.ai/api/v1"),
      secret: { value: "" }, signal: new AbortController().signal }), { code: "CONNECTION_TEST_CONFIG" });
    assert.equal(calls.length, 0);
  });
});

test("HTTP 200 and error-shaped JSON never imply a valid key", async () => {
  for (const body of [{ ok: true }, { object: "list", data: ["fake"] }, { error: { code: "unknown", message: fakeKey }, ...modelList },
    { code: 20012, message: fakeKey }, { success: false, ...modelList }, null]) {
    await fixture({ raw: JSON.stringify(body) }, async () => {
      await assert.rejects(execute(), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "CONNECTION_TEST_PROTOCOL");
        assert.equal(error.message.includes(fakeKey), false);
        return true;
      });
    });
  }
  await fixture({ raw: `<html>${fakeKey}</html>`, contentType: "text/html" }, async () => {
    await assert.rejects(execute(), { code: "CONNECTION_TEST_PROTOCOL" });
  });
});

test("provider auth, permissions, credit and rate limits are distinct static errors without retries", async () => {
  const examples = [
    { status: 401, body: { message: fakeKey }, code: "AUTH" },
    { status: 403, body: { message: fakeKey }, code: "PERMISSION" },
    { status: 402, body: { message: fakeKey }, code: "BALANCE" },
    { status: 429, body: { error: { code: "insufficient_quota", message: fakeKey } }, code: "BALANCE" },
    { status: 429, body: { error: { code: "rate_limit_error", message: fakeKey } }, code: "RATE_LIMIT" },
    { status: 200, body: { error: { code: "invalid_api_key", message: fakeKey } }, code: "AUTH" },
    { status: 503, body: { message: fakeKey }, code: "PROTOCOL" },
  ];
  for (const example of examples) await fixture(example, async ({ calls }) => {
    await assert.rejects(execute(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, `CONNECTION_TEST_${example.code}`);
      assert.equal(error.message.includes(fakeKey), false);
      return true;
    });
    assert.equal(calls.length, 1);
  });
  await fixture({ body: { is_available: false, balance_infos: [] } }, async () => {
    await assert.rejects(execute(platform("https://api.deepseek.com")), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "CONNECTION_TEST_BALANCE");
      assert.match(error.message, /鉴权已通过/);
      return true;
    });
  });
});

test("redirect, compression, oversize response and unsafe DNS stop without forwarding or leaking", async () => {
  for (const options of [
    { status: 302, raw: fakeKey, code: "TARGET" },
    { encoding: "gzip", raw: fakeKey, code: "PROTOCOL" },
    { raw: "x".repeat(1024 * 1024 + 1), code: "PROTOCOL" },
    { dns: "169.254.169.254", code: "TARGET" },
  ]) await fixture(options, async ({ calls }) => {
    await assert.rejects(execute(), { code: `CONNECTION_TEST_${options.code}` });
    assert.equal(calls.length, options.dns ? 0 : 1);
  });
});

test("cancel and deadline finish one attempt and release signal listeners", async () => {
  for (const timedOut of [false, true]) await fixture({ pending: true }, async ({ calls, started }) => {
    const controller = new AbortController();
    const pending = execute(platform(), controller.signal);
    const rejected = assert.rejects(pending, { code: timedOut ? "CONNECTION_TEST_TIMEOUT" : "CONNECTION_TEST_CANCELLED" });
    await started;
    controller.abort(timedOut ? new AppError(504, "CONNECTION_TEST_TIMEOUT", fakeKey) : new Error(fakeKey));
    await rejected;
    assert.equal(calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  await fixture({}, async ({ calls }) => {
    const controller = new AbortController();
    controller.abort(new Error(fakeKey));
    await assert.rejects(execute(platform(), controller.signal), { code: "CONNECTION_TEST_CANCELLED" });
    assert.equal(calls.length, 0);
  });
});

const doubaoMini = "doubao-seed-2-0-mini-260428";
const doubaoLite = "doubao-seed-2-0-lite-260428";
const doubao = () => platform("https://ark.cn-beijing.volces.com/api/v3");
const generationResponse = (model = doubaoMini) => ({
  id: "synthetic-generation-id", object: "chat.completion", model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
  usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
});
const generate = (options: { model?: string; allowBillable?: boolean; signal?: AbortSignal; key?: string } = {}) =>
  testHTTPConnection({ platform: doubao(), secret: { value: options.key ?? fakeKey },
    signal: options.signal ?? new AbortController().signal, model: options.model, allowBillable: options.allowBillable });

test("Doubao generation plan uses only verified Beijing data-plane and model choices without default selection", () => {
  const plan = planHTTPConnectionTest(doubao());
  assert.equal(plan.supported, true);
  assert.equal(plan.provider, "豆包 · 火山方舟");
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, "/api/v3/chat/completions");
  assert.equal(plan.level, "generation");
  assert.equal(plan.billing, "possible");
  assert.equal(plan.model, null);
  assert.deepEqual(plan.generation?.models.map((item) => item.id), [doubaoMini, doubaoLite]);
  assert.equal(plan.generation?.maxRequests, 1);
  assert.equal(plan.generation?.maxOutputTokens, 16);
  assert.equal(plan.generation?.thinking, "disabled");
  assert.match(plan.generation?.costNote ?? "", /不是金额硬上限/);
  // Callers cannot mutate the server's allowlist through a returned plan.
  plan.generation!.models[0].id = "invented-model";
  assert.equal(planHTTPConnectionTest(doubao()).generation?.models[0].id, doubaoMini);
  for (const base of ["https://ark.cn-beijing.volces.com", "http://ark.cn-beijing.volces.com/api/v3",
    "https://ark.cn-beijing.volces.com:8443/api/v3", "https://ark.cn-shanghai.volces.com/api/v3",
    "https://ark.cn-beijing.volcengineapi.com/api/v3", "https://ark.cn-beijing.volces.com/api/coding",
    "https://ark.cn-beijing.volces.com/api/v3/models", "https://ark.cn-beijing.volces.com/proxy/api/v3",
    "https://ark.cn-beijing.volces.com/api/v3?model=other", "https://ark.cn-beijing.volces.com.example.org/api/v3"]) {
    assert.equal(planHTTPConnectionTest(platform(base)).supported, false, base);
  }
  assert.equal(planHTTPConnectionTest(platform(doubao().baseUrl, { type: "header", name: "X-Api-Key" })).supported, false);
});

test("Doubao refuses missing consent, unknown model, empty key and disabled connection before network", async () => {
  assert.throws(() => assertHTTPConnectionTestConsent(platform(), { model: doubaoMini, allowBillable: true }), { code: "CONNECTION_TEST_CONFIG" });
  await fixture({}, async ({ calls }) => {
    await assert.rejects(testHTTPConnection({ platform: platform(), secret: { value: fakeKey },
      signal: new AbortController().signal, model: doubaoMini, allowBillable: true }), { code: "CONNECTION_TEST_CONFIG" });
    assert.equal(calls.length, 0);
  });
  for (const model of [undefined, "", "doubao-seed-2-0-mini", "ep-synthetic", "invented-model", `${doubaoMini}\n`]) {
    assert.throws(() => assertHTTPConnectionTestConsent(doubao(), { model, allowBillable: true }), { code: "CONNECTION_TEST_CONFIG" });
    await fixture({}, async ({ calls }) => {
      await assert.rejects(generate({ model, allowBillable: true }), { code: "CONNECTION_TEST_CONFIG" });
      assert.equal(calls.length, 0);
    });
  }
  for (const allowBillable of [undefined, false]) {
    assert.throws(() => assertHTTPConnectionTestConsent(doubao(), { model: doubaoMini, allowBillable }), { code: "CONNECTION_TEST_CONSENT" });
    await fixture({}, async ({ calls }) => {
      await assert.rejects(generate({ model: doubaoMini, allowBillable }), { code: "CONNECTION_TEST_CONSENT" });
      assert.equal(calls.length, 0);
    });
  }
  await fixture({}, async ({ calls }) => {
    await assert.rejects(generate({ model: doubaoMini, allowBillable: true, key: "" }), { code: "CONNECTION_TEST_CONFIG" });
    await assert.rejects(testHTTPConnection({ platform: { ...doubao(), enabled: false }, secret: { value: fakeKey },
      signal: new AbortController().signal, model: doubaoMini, allowBillable: true }), { code: "CONNECTION_TEST_CONFIG" });
    assert.equal(calls.length, 0);
  });
});

test("Doubao sends one fixed minimal request for the selected model and returns no provider content", async () => {
  for (const model of [doubaoMini, doubaoLite]) await fixture({ body: {
    ...generationResponse(model), id: fakeKey,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: fakeKey } }],
  } }, async ({ calls }) => {
    const saved = doubao();
    const before = structuredClone(saved);
    const result = await testHTTPConnection({ platform: saved, secret: { value: fakeKey },
      signal: new AbortController().signal, model, allowBillable: true });
    assert.equal(result.status, "verified");
    assert.equal(result.success, true);
    assert.equal(result.level, "generation");
    assert.equal(result.model, model);
    assert.equal(result.billing, "possible");
    assert.match(result.message, /一次最小生成/);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
    assert.equal("usage" in result, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(calls[0].headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), {
      model, messages: [{ role: "user", content: "Reply OK." }],
      max_completion_tokens: 16, thinking: { type: "disabled" }, stream: false, service_tier: "default",
    });
    assert.deepEqual(saved, before);
  });
});

test("Doubao never accepts an arbitrary 200, mismatched model, rejected content or invalid token usage", async () => {
  for (const body of [modelList, { ok: true }, generationResponse(doubaoLite),
    { ...generationResponse(), usage: undefined },
    { ...generationResponse(), usage: { prompt_tokens: 10, completion_tokens: 17, total_tokens: 27 } },
    { ...generationResponse(), usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 99 } },
    { ...generationResponse(), choices: [] },
    { ...generationResponse(), choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "blocked" } }] },
    { ...generationResponse(), choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] },
    { ...generationResponse(), error: { message: fakeKey } }]) await fixture({ body }, async ({ calls }) => {
      await assert.rejects(generate({ model: doubaoMini, allowBillable: true }), { code: "CONNECTION_TEST_PROTOCOL" });
      assert.equal(calls.length, 1);
    });
});

test("Doubao distinguishes authentication, model permission, balance, quota and rate-limit failures with no retry or upstream details", async () => {
  const failures = [
    { status: 401, providerCode: "AuthenticationError", code: "AUTH" },
    { status: 403, providerCode: "AccessDenied", code: "PERMISSION" },
    { status: 403, providerCode: "AccountOverdueError", code: "BALANCE" },
    { status: 404, providerCode: "ModelNotOpen", code: "MODEL_PERMISSION" },
    { status: 404, providerCode: "InvalidEndpointOrModel.NotFound", code: "MODEL_PERMISSION" },
    { status: 404, providerCode: "InvalidEndpointOrModel.ModelIDAccessDisabled", code: "MODEL_PERMISSION" },
    { status: 404, providerCode: "PathNotFound", code: "PROTOCOL" },
    { status: 429, providerCode: "QuotaExceeded", code: "BALANCE" },
    { status: 429, providerCode: "RateLimitExceeded.EndpointRPMExceeded", code: "RATE_LIMIT" },
    { status: 429, providerCode: "ModelAccountTpmRateLimitExceeded", code: "RATE_LIMIT" },
    { status: 503, providerCode: "InternalServiceError", code: "PROTOCOL" },
  ];
  for (const item of failures) await fixture({ status: item.status,
    body: { error: { code: item.providerCode, message: fakeKey, request_id: fakeKey } } }, async ({ calls }) => {
    await assert.rejects(generate({ model: doubaoMini, allowBillable: true }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, `CONNECTION_TEST_${item.code}`);
      assert.equal(error.message.includes(fakeKey), false);
      assert.equal(error.message.includes("未调用模型"), false);
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

test("Doubao cancellation, timeout, redirect and unsafe DNS stop one generation without replay", async () => {
  for (const timedOut of [false, true]) await fixture({ pending: true }, async ({ calls, started }) => {
    const controller = new AbortController();
    const pending = generate({ model: doubaoMini, allowBillable: true, signal: controller.signal });
    const rejected = assert.rejects(pending, { code: timedOut ? "CONNECTION_TEST_TIMEOUT" : "CONNECTION_TEST_CANCELLED" });
    await started;
    controller.abort(timedOut ? new AppError(504, "CONNECTION_TEST_TIMEOUT", fakeKey) : new Error(fakeKey));
    await rejected;
    assert.equal(calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  for (const options of [{ status: 302, code: "TARGET" }, { dns: "169.254.169.254", code: "TARGET" },
    { raw: "<html>not a model</html>", contentType: "text/html", code: "PROTOCOL" }]) await fixture(options, async ({ calls }) => {
      await assert.rejects(generate({ model: doubaoMini, allowBillable: true }), { code: `CONNECTION_TEST_${options.code}` });
      assert.equal(calls.length, options.dns ? 0 : 1);
    });
});
