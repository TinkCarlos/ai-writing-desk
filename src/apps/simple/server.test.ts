// HTTP 契约测试：只覆盖不调用模型的路径（守卫、校验、错误码、返回结构）。
// 模型返回内容的解析由 editorial.test.ts / workbench.test.ts 用 mock 覆盖。
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { createHandler } from "./server.ts";
import { REVIEW_CATEGORIES } from "./review-contract.ts";
import { RULE_VERSION } from "./editorial-rules.ts";

const ORIGIN = "http://127.0.0.1:8000";
const SOURCE = {
  title: "OpenAI 发布新模型",
  url: "https://openai.com/news/example",
  excerpt: "官方博客介绍了新模型的能力。",
  publishedAt: "2026-10-16",
  source: "OpenAI",
};
const ARTICLE = {
  title: "一次 Agent 开发的复盘",
  body: "这是一段用于契约测试的正文。",
  material: "",
  sources: [SOURCE],
  aiAssisted: true,
};

async function setup() {
  const saved = Deno.env.get("DEEPSEEK_API_KEY");
  Deno.env.delete("DEEPSEEK_API_KEY");
  const dir = await Deno.makeTempDir();
  const handler = await createHandler(
    new URL(`file://${dir}/simple-model.json`),
  );
  if (saved !== undefined) Deno.env.set("DEEPSEEK_API_KEY", saved);
  return { handler, dir };
}

function call(
  handler: (req: Request) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; host?: string; origin?: string | null; contentType?: string } = {},
) {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers = new Headers({ host: init.host ?? "127.0.0.1:8000" });
  if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.body !== undefined) headers.set("content-type", init.contentType ?? "application/json");
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

async function errorOf(res: Response, status: number) {
  assertEquals(res.status, status);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const data = await res.json();
  assertEquals(Object.keys(data), ["error"]);
  assertEquals(typeof data.error, "string");
  return data.error as string;
}

Deno.test("status 返回 configured/model/reasoningEffort/generation/ruleVersion", async () => {
  const { handler } = await setup();
  const res = await call(handler, "/api/simple/status");
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(Object.keys(data).sort(), ["configured", "generation", "model", "reasoningEffort", "ruleVersion"]);
  // 页面据此判断评审是否过期，必须与后端启动时加载的规则版本一致，而不是前端打包时的常量。
  assertEquals(typeof data.ruleVersion, "string");
  assertEquals(data.ruleVersion, RULE_VERSION);
  assertEquals(data.configured, false);
  assertEquals(data.generation, null);
  assertEquals(typeof data.model, "string");
});

Deno.test("非本机 Host 返回 403", async () => {
  const { handler } = await setup();
  await errorOf(await call(handler, "/api/simple/status", { host: "evil.example" }), 403);
});

Deno.test("POST 缺少同源 Origin 返回 403", async () => {
  const { handler } = await setup();
  await errorOf(await call(handler, "/api/simple/render", { body: {}, origin: null }), 403);
  await errorOf(await call(handler, "/api/simple/render", { body: {}, origin: "http://evil.example" }), 403);
});

Deno.test("未知接口返回 404", async () => {
  const { handler } = await setup();
  await errorOf(await call(handler, "/api/simple/nope"), 404);
});

Deno.test("非 JSON 请求返回 400", async () => {
  const { handler } = await setup();
  const msg = await errorOf(
    await call(handler, "/api/simple/render", { body: ARTICLE, contentType: "text/plain" }),
    400,
  );
  assertMatch(msg, /application\/json/);
});

Deno.test("render 返回 { html }，包含标题和来源", async () => {
  const { handler } = await setup();
  const res = await call(handler, "/api/simple/render", { body: ARTICLE });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(Object.keys(data), ["html"]);
  assert(data.html.includes("来源资料"));
});

Deno.test("render：来源超过 5 条、或含手机号，返回 400", async () => {
  const { handler } = await setup();
  await errorOf(
    await call(handler, "/api/simple/render", { body: { ...ARTICLE, sources: Array(6).fill(SOURCE) } }),
    400,
  );
  await errorOf(
    await call(handler, "/api/simple/render", { body: { ...ARTICLE, body: "联系 13812345678" } }),
    400,
  );
});

Deno.test("review：含隐私时本地拦截，返回 local_only 的完整 ArticleReview，不需要 Key", async () => {
  const { handler } = await setup();
  const res = await call(handler, "/api/simple/review", { body: { ...ARTICLE, body: "联系 13812345678" } });
  assertEquals(res.status, 200);
  const r = await res.json();
  assertEquals(
    Object.keys(r).sort(),
    ["checks", "elapsedMs", "fingerprint", "issues", "model", "reviewedAt", "ruleVersion", "status", "summary", "usage"],
  );
  assertEquals(r.status, "local_only");
  assertEquals(typeof r.ruleVersion, "string");
  assertEquals(r.checks.map((c: { category: string }) => c.category).sort(), Object.keys(REVIEW_CATEGORIES).sort());
  assert(r.issues.length > 0);
  for (const issue of r.issues) {
    assertEquals(issue.category, "privacy");
    assert(["low", "medium", "high", "blocker"].includes(issue.severity));
    assert(Array.isArray(issue.ruleIds));
    for (const k of ["evidence", "message", "suggestion"]) assertEquals(typeof issue[k], "string");
  }
});

Deno.test("review：内容干净但未配置 Key，返回 503", async () => {
  const { handler } = await setup();
  const msg = await errorOf(await call(handler, "/api/simple/review", { body: ARTICLE }), 503);
  assertMatch(msg, /API Key/);
});

Deno.test("revise：没有对应评审时返回 400，要求重新评审", async () => {
  const { handler } = await setup();
  const msg = await errorOf(
    await call(handler, "/api/simple/revise", { body: { ...ARTICLE, reviewFingerprint: "missing" } }),
    400,
  );
  assertMatch(msg, /重新评审/);
});

Deno.test("generate：未确认大纲返回 400", async () => {
  const { handler } = await setup();
  const msg = await errorOf(
    await call(handler, "/api/simple/generate", {
      body: { topic: "Agent", material: "素材", outline: "一、开头", sources: [SOURCE] },
    }),
    400,
  );
  assertMatch(msg, /确认/);
});

Deno.test("outline：只有链接没有摘要和素材时返回 400", async () => {
  const { handler } = await setup();
  await errorOf(
    await call(handler, "/api/simple/outline", {
      body: { topic: "Agent", material: "", sources: [{ ...SOURCE, excerpt: "" }] },
    }),
    400,
  );
});

Deno.test("SIMPLE_REASONING_EFFORT=high 时 status 返回 high", async () => {
  const saved = Deno.env.get("SIMPLE_REASONING_EFFORT");
  Deno.env.set("SIMPLE_REASONING_EFFORT", "high");
  try {
    const { handler } = await setup();
    const data = await (await call(handler, "/api/simple/status")).json();
    assertEquals(data.reasoningEffort, "high");
  } finally {
    if (saved === undefined) Deno.env.delete("SIMPLE_REASONING_EFFORT");
    else Deno.env.set("SIMPLE_REASONING_EFFORT", saved);
  }
});

Deno.test("SIMPLE_REASONING_EFFORT 填了不支持的值，启动时直接报错", async () => {
  const saved = Deno.env.get("SIMPLE_REASONING_EFFORT");
  Deno.env.set("SIMPLE_REASONING_EFFORT", "low");
  try {
    await assertRejects(() => setup(), Error, "SIMPLE_REASONING_EFFORT");
  } finally {
    if (saved === undefined) Deno.env.delete("SIMPLE_REASONING_EFFORT");
    else Deno.env.set("SIMPLE_REASONING_EFFORT", saved);
  }
});

Deno.test("联调开关 SIMPLE_DEBUG_ARTICLE_MAX_TOKENS：设了会在 status 里亮出来，非法值启动报错", async () => {
  const saved = Deno.env.get("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS");
  try {
    Deno.env.set("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS", "512");
    const { handler } = await setup();
    const data = await (await call(handler, "/api/simple/status")).json();
    assertEquals(data.debugArticleMaxTokens, 512);
    for (const bad of ["abc", "10", "40000", "1.5"]) {
      Deno.env.set("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS", bad);
      await assertRejects(() => setup(), Error, "SIMPLE_DEBUG_ARTICLE_MAX_TOKENS");
    }
  } finally {
    if (saved === undefined) Deno.env.delete("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS");
    else Deno.env.set("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS", saved);
  }
});
