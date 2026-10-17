import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { LLMProvider } from "@src/core/ports/llm.ts";
import { RsshubScraper } from "@src/integrations/fetch/providers/rsshub-scraper.ts";
import {
  brief,
  fetchNews,
  generate,
  InputError,
  renderArticle,
  sources,
} from "./workbench.ts";
import { createHandler } from "./server.ts";

const input = {
  topic: "测试主题",
  material: "测试素材：模型输出必须有来源。",
  outline: "一、介绍事实\n二、说明限制",
  sources: [],
};

function model(content: string, finish = "stop"): LLMProvider {
  return {
    initialize: async () => {},
    refresh: async () => {},
    setModel: () => {},
    createChatCompletion: async () => ({
      choices: [{ message: { content }, finish_reason: finish }],
    }),
  };
}

Deno.test("正文需要素材和大纲；来源数量及链接在边界检查", () => {
  assertThrows(() => brief({ ...input, material: "" }), InputError);
  assertThrows(() => brief({ ...input, outline: "" }, true), InputError);
  assertThrows(() => sources(Array(6).fill({})), InputError);
  assertThrows(
    () =>
      sources([{
        title: "不安全链接",
        url: "javascript:alert(1)",
        excerpt: "",
        publishedAt: "",
        source: "",
      }]),
    InputError,
  );
  assertEquals(brief(input, true).outline, input.outline);
});

Deno.test("生成不把空输出、截断或模型异常伪装成成功", async () => {
  await assertRejects(
    () =>
      generate(
        model('{"title":"标题","body":"正文"}', "length"),
        input,
        "article",
      ),
    Error,
    "截断",
  );
  await assertRejects(
    () => generate(model('{"title":"标题","body":""}'), input, "article"),
    Error,
  );
  const failing = model("");
  failing.createChatCompletion = () => Promise.reject(new Error("模型不可用"));
  await assertRejects(
    () => generate(failing, input, "article"),
    Error,
    "模型不可用",
  );
  assertEquals(
    (await generate(model('{"outline":"待确认大纲"}'), input, "outline"))
      .outline,
    "待确认大纲",
  );
});

Deno.test("排版使用真实模板，转义 HTML 并保留来源", async () => {
  const html = await renderArticle(
    "<script>标题</script>",
    "## 小标题\n\n**加粗**\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>",
    [{
      title: "原文",
      url: "https://example.com/source",
      excerpt: "",
      publishedAt: "",
      source: "test",
    }],
  );
  assert(
    html.includes("<strong>加粗</strong>") ||
      html.includes('font-weight:700;color:#111111;">加粗'),
  );
  assert(html.includes("来源资料"));
  assert(html.includes("https://example.com/source"));
  assert(!html.includes("<script>"));
  assert(!html.includes("<img"));
  assert(html.includes("&lt;script&gt;"));
});

Deno.test("RSS 不把缺失日期伪装成当前时间；部分断源仍可读取", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (request) =>
    String(request).includes("huggingface")
      ? Promise.reject(new Error("测试断源"))
      : Promise.resolve(
        new Response(
          "<rss><channel><item><title>测试资讯</title><link>https://example.com/news</link><description>&lt;p&gt;来源摘要&lt;/p&gt;</description></item></channel></rss>",
          { headers: { "Content-Type": "application/rss+xml" } },
        ),
      );
  try {
    const raw = await new RsshubScraper().scrape(
      "https://example.com/feed.xml",
    );
    assertEquals(raw[0].publishDate, "");
    const result = await fetchNews();
    assertEquals(result.articles.length, 1);
    assertEquals(result.articles[0].excerpt, "来源摘要");
    assertEquals(result.warnings.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("只有标题的 RSS 条目不冒充正文素材", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        "<rss><channel><item><title>仅标题</title><link>https://example.com/item</link></item></channel></rss>",
      ),
    );
  try {
    const [item] = await new RsshubScraper().scrape(
      "https://example.com/feed.xml",
    );
    assertEquals(item.content, "");
    assertThrows(
      () =>
        brief({
          ...input,
          material: "",
          sources: [{
            title: item.title,
            url: item.url,
            excerpt: item.content,
            publishedAt: "",
            source: "test",
          }],
        }),
      InputError,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("本地 API 拒绝跨站写入，确认前不生成，密钥只留服务端", async () => {
  const dir = await Deno.makeTempDir();
  const file = new URL(`file://${dir}/simple-model.json`);
  await Deno.writeTextFile(
    file,
    JSON.stringify({ apiKey: "", model: "deepseek-chat" }),
  );
  const handler = await createHandler(file);
  const post = (
    path: string,
    body: unknown,
    origin = "http://127.0.0.1:8000",
  ) =>
    handler(
      new Request(`http://127.0.0.1:8000/api/simple/${path}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:8000",
          origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  try {
    assertEquals(
      (await post("settings", {}, "https://untrusted.example")).status,
      403,
    );
    assertEquals(
      (await post("generate", { ...input, confirmed: false })).status,
      400,
    );
    assertEquals(
      (await post("generate", { ...input, confirmed: true })).status,
      503,
    );
    const saved = await post("settings", {
      apiKey: "test-only-no-live-calls",
      model: "deepseek-chat",
    });
    assertEquals(saved.status, 200);
    assertEquals(await saved.json(), {
      configured: true,
      model: "deepseek-chat",
      reasoningEffort: "max",
    });
    const status = await handler(
      new Request("http://127.0.0.1:8000/api/simple/status", {
        headers: { host: "127.0.0.1:8000" },
      }),
    );
    assert(!(await status.text()).includes("test-only"));
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(
      (await post("settings", { apiKey: "", model: "deepseek-chat" })).status,
      200,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(file)).apiKey,
      "test-only-no-live-calls",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("大纲与正文均使用 max 思考，保留思考和最终内容的输出空间", async () => {
  for (const mode of ["outline", "article"] as const) {
    const llm = model(
      mode === "outline"
        ? '{"outline":"大纲"}'
        : '{"title":"标题","body":"正文"}',
    );
    const original = llm.createChatCompletion;
    llm.createChatCompletion = (messages, options) => {
      assertEquals(options?.thinking, { type: "enabled" });
      assertEquals(options?.reasoning_effort, "max");
      assertEquals(options?.max_tokens, mode === "outline" ? 16384 : 32768);
      assertEquals(options?.maxAttempts, 1);
      return original(messages, options);
    };
    const result = await generate(llm, input, mode);
    assertEquals(result.reasoningEffort, "max");
  }
});
