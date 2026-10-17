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
import { AI_DISCLOSURE, stripModelDisclosure } from "./privacy.ts";

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

function sequence(
  replies: { content: string; finish: string }[],
): LLMProvider & { calls: number } {
  const llm = {
    calls: 0,
    initialize: async () => {},
    refresh: async () => {},
    setModel: () => {},
    createChatCompletion: async () => {
      const reply = replies[Math.min(llm.calls, replies.length - 1)];
      llm.calls += 1;
      return {
        choices: [{
          message: { content: reply.content },
          finish_reason: reply.finish,
        }],
      };
    },
  };
  return llm;
}

Deno.test("正文思考耗尽且没写出内容时自动重试 1 次，并报告尝试次数", async () => {
  const llm = sequence([
    { content: "", finish: "length" },
    { content: '{"title":"标题","body":"正文"}', finish: "stop" },
  ]);
  const attempts: number[] = [];
  const result = await generate(llm, input, "article", (n) => attempts.push(n));
  assertEquals(llm.calls, 2);
  assertEquals(attempts, [1, 2]);
  assertEquals(result.attempts, 2);
  assertEquals(result.body, "正文");
});

Deno.test("重试后仍没写出正文时明确报错，不返回空正文", async () => {
  const llm = sequence([{ content: "", finish: "length" }]);
  await assertRejects(
    () => generate(llm, input, "article"),
    Error,
    "正文没写出来，可以再点一次生成",
  );
  assertEquals(llm.calls, 2);
});

Deno.test("已写出部分内容的截断不重试；大纲为空时同样重试 1 次", async () => {
  const partial = sequence([{ content: '{"title":"标题","body":"半', finish: "length" }]);
  await assertRejects(() => generate(partial, input, "article"), Error, "截断");
  assertEquals(partial.calls, 1);
  const partialOutline = sequence([{ content: '{"outline":"一、', finish: "length" }]);
  await assertRejects(() => generate(partialOutline, input, "outline"), Error, "截断");
  assertEquals(partialOutline.calls, 1);
  const outline = sequence([{ content: "", finish: "length" }]);
  await assertRejects(
    () => generate(outline, input, "outline"),
    Error,
    "大纲没写出来，可以再点一次生成",
  );
  assertEquals(outline.calls, 2);
  const recovered = sequence([
    { content: "", finish: "length" },
    { content: '{"outline":"大纲"}', finish: "stop" },
  ]);
  const result = await generate(recovered, input, "outline");
  assertEquals([recovered.calls, result.attempts, result.outline], [2, 2, "大纲"]);
});

Deno.test("导出只保留一处 AI 声明：去掉模型自写的声明短句，保留其余说明", async () => {
  const body =
    "正文第一段。\n\n来源：OpenAI 客户案例。本文由 AI 辅助整理，基于该页要点并加入作者分析，未独立复现。";
  assertEquals(
    stripModelDisclosure(body),
    "正文第一段。\n\n来源：OpenAI 客户案例。基于该页要点并加入作者分析，未独立复现。",
  );
  assertEquals(stripModelDisclosure("正文。\n\n（本文使用AI辅助创作）"), "正文。");
  assertEquals(stripModelDisclosure("本文讨论 AI 辅助编程的成本。"), "本文讨论 AI 辅助编程的成本。");
  const html = await renderArticle("标题", body, [], true);
  assertEquals(html.split(AI_DISCLOSURE).length - 1, 1);
  assert(!html.includes("本文由 AI 辅助整理"));
  assert(html.includes("未独立复现"));
});

Deno.test("联调开关只压低正文上限，不影响大纲", async () => {
  const saved = Deno.env.get("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS");
  Deno.env.set("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS", "512");
  try {
    for (const mode of ["outline", "article"] as const) {
      const llm = model(
        mode === "outline" ? '{"outline":"大纲"}' : '{"title":"标题","body":"正文"}',
      );
      const original = llm.createChatCompletion;
      llm.createChatCompletion = (messages, options) => {
        assertEquals(options?.max_tokens, mode === "outline" ? 16384 : 512);
        return original(messages, options);
      };
      await generate(llm, input, mode);
    }
  } finally {
    if (saved === undefined) Deno.env.delete("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS");
    else Deno.env.set("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS", saved);
  }
});
