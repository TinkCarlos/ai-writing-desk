import {
  debugArticleMaxTokens,
  type ReasoningEffort,
  reasoningEffort,
} from "./effort.ts";
import { OpenAICompatibleLLM } from "@src/integrations/llm/providers/openai-compatible-llm.ts";
import { ProviderError } from "@src/core/errors/provider-error.ts";
import {
  assertNoPrivacy,
  fingerprint,
  localPrivacyReview,
  reviewArticle,
  reviewInput,
  reviseArticle,
} from "./editorial.ts";
import type { ArticleReview } from "./review-contract.ts";
import {
  brief,
  fetchNews,
  generate,
  InputError,
  object,
  renderArticle,
  sources,
  text,
} from "./workbench.ts";

const MODEL_FILE = new URL("../../temp/simple-model.json", import.meta.url);
const STATIC_DIR = new URL("../../../dist/dashboard/", import.meta.url);

interface Settings {
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

async function loadSettings(file: URL): Promise<Settings> {
  try {
    const data = object(JSON.parse(await Deno.readTextFile(file)));
    return {
      apiKey: text(data.apiKey, "API Key", 300, false),
      model: text(data.model, "模型名称", 100),
      reasoningEffort: reasoningEffort(),
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return {
      apiKey: Deno.env.get("DEEPSEEK_API_KEY")?.trim() ?? "",
      model: Deno.env.get("DEEPSEEK_MODEL")?.trim() || "deepseek-flash",
      reasoningEffort: reasoningEffort(),
    };
  }
}

async function readJson(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) {
    throw new InputError("请求必须使用 application/json");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new InputError("请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256000) throw new InputError("请求内容过大，请精简素材");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return object(JSON.parse(new TextDecoder().decode(buffer)));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("请求不是有效的 JSON");
  }
}

export async function createHandler(modelFile = MODEL_FILE) {
  let settings = await loadSettings(modelFile);
  const debugTokens = debugArticleMaxTokens();
  if (debugTokens !== null) {
    console.warn(
      `[联调开关] SIMPLE_DEBUG_ARTICLE_MAX_TOKENS=${debugTokens}：正文输出上限被临时压低，验完请去掉并重启`,
    );
  }
  let generating = false;
  let generation: { mode: string; attempt: number; startedAt: string } | null =
    null;
  let news: Awaited<ReturnType<typeof fetchNews>> | null = null;
  let newsRequest: ReturnType<typeof fetchNews> | null = null;
  const reviews = new Map<string, ArticleReview>();

  const json = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const port = url.port || "80";
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      req.headers.get("host") !== url.host
    ) {
      return json({ error: "只允许通过本机地址访问" }, 403);
    }
    if (req.method !== "GET" && req.headers.get("origin") !== url.origin) {
      return json({ error: "操作必须来自当前本地页面" }, 403);
    }
    try {
      if (url.pathname === "/api/simple/status" && req.method === "GET") {
        return json({
          configured: Boolean(settings.apiKey),
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          generation,
          ...(debugTokens !== null
            ? { debugArticleMaxTokens: debugTokens }
            : {}),
        });
      }
      if (url.pathname === "/api/simple/settings" && req.method === "POST") {
        if (generating) {
          return json({ error: "请等待本次生成完成后再修改模型" }, 409);
        }
        const data = await readJson(req);
        const key = text(data.apiKey, "API Key", 300, false);
        const model = text(data.model, "模型名称", 100);
        if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
          throw new InputError("模型名称格式不正确");
        }
        if (/\s/.test(key)) throw new InputError("API Key 不能包含空格或换行");
        const next: Settings = {
          apiKey: key || settings.apiKey,
          model,
          reasoningEffort: reasoningEffort(),
        };
        if (!next.apiKey) throw new InputError("请先填写 DeepSeek API Key");
        await Deno.mkdir(new URL(".", modelFile), { recursive: true });
        const pending = new URL("simple-model.pending.json", modelFile);
        await Deno.writeTextFile(pending, JSON.stringify(next), {
          mode: 0o600,
        });
        await Deno.chmod(pending, 0o600);
        await Deno.rename(pending, modelFile);
        settings = next;
        return json({
          configured: true,
          model,
          reasoningEffort: next.reasoningEffort,
        });
      }
      if (url.pathname === "/api/simple/news" && req.method === "GET") {
        if (news && Date.now() - Date.parse(news.fetchedAt) < 5 * 60000) {
          return json(news);
        }
        newsRequest ??= fetchNews();
        try {
          const result = await newsRequest;
          if (!result.articles.length) {
            return json({
              error: "AI 资讯源暂时不可用，请稍后刷新；也可手动输入主题和素材",
            }, 502);
          }
          news = result;
          return json(news);
        } finally {
          newsRequest = null;
        }
      }
      if (
        [
          "/api/simple/outline",
          "/api/simple/generate",
          "/api/simple/review",
          "/api/simple/revise",
        ].includes(
          url.pathname,
        ) && req.method === "POST"
      ) {
        const data = await readJson(req);
        const mode = url.pathname.endsWith("/outline")
          ? "outline"
          : url.pathname.endsWith("/review")
          ? "review"
          : url.pathname.endsWith("/revise")
          ? "revise"
          : "article";
        const input = mode === "outline" || mode === "article"
          ? brief(data, mode === "article")
          : null;
        const article = input ? null : reviewInput(data);
        if (mode === "article" && data.confirmed !== true) {
          throw new InputError("请先确认素材和大纲");
        }
        if (mode === "review") {
          const local = await localPrivacyReview(article!);
          if (local) return json(local);
        }
        assertNoPrivacy(input ?? article);
        const previousReview = mode === "revise"
          ? reviews.get(String(data.reviewFingerprint))
          : undefined;
        if (
          mode === "revise" &&
          (!previousReview ||
            previousReview.fingerprint !== await fingerprint(article!))
        ) throw new InputError("当前文章未评审或评审已失效，请重新评审");
        if (!settings.apiKey) {
          return json(
            { error: "尚未配置 DeepSeek API Key，请打开模型设置" },
            503,
          );
        }
        if (generating) {
          return json({ error: "已有生成任务进行中，请稍后再试" }, 409);
        }
        generating = true;
        generation = { mode, attempt: 1, startedAt: new Date().toISOString() };
        try {
          const llm = new OpenAICompatibleLLM({
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: settings.apiKey,
            model: settings.model,
            timeoutMs: 600000,
            maxAttempts: 1,
          });
          await llm.initialize();
          const result = mode === "review"
            ? await reviewArticle(llm, article!)
            : mode === "revise"
            ? await reviseArticle(llm, article!, previousReview!)
            : await generate(llm, input!, mode, (attempt) => {
              if (generation) generation.attempt = attempt;
            });
          if (mode === "review") {
            const review = result as ArticleReview;
            reviews.set(review.fingerprint, review);
            if (reviews.size > 20) reviews.delete(reviews.keys().next().value!);
          }
          console.info(JSON.stringify({
            event: "simple-generation",
            at: new Date().toISOString(),
            mode,
            model: result.model,
            reasoningEffort: settings.reasoningEffort,
            elapsedMs: "elapsedMs" in result ? result.elapsedMs : undefined,
            attempts: "attempts" in result ? result.attempts : undefined,
            usage: result.usage,
          }));
          return json(result);
        } finally {
          generating = false;
          generation = null;
        }
      }
      if (url.pathname === "/api/simple/render" && req.method === "POST") {
        const data = await readJson(req);
        return json({
          html: await renderArticle(
            text(data.title, "文章标题", 200),
            text(data.body, "正文", 30000),
            sources(data.sources),
            data.aiAssisted !== false,
          ),
        });
      }
      if (req.method === "GET") {
        if (url.pathname === "/") {
          return Response.redirect(
            `http://${url.hostname}:${port}/dashboard/simple.html`,
            302,
          );
        }
        const file = url.pathname === "/dashboard/simple.html"
          ? "simple.html"
          : /^\/dashboard\/assets\/[\w.-]+$/.test(url.pathname)
          ? url.pathname.slice("/dashboard/".length)
          : null;
        if (file) {
          const content = await Deno.readFile(new URL(file, STATIC_DIR));
          const type = file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
            ? "text/css"
            : "text/html";
          return new Response(content, {
            headers: {
              "Content-Type": `${type}; charset=utf-8`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            },
          });
        }
      }
      return json({ error: "接口或页面不存在" }, 404);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return json({ error: "页面未构建，请运行 deno task simple" }, 404);
      }
      if (error instanceof InputError) {
        return json({ error: error.message }, 400);
      }
      let message = error instanceof Error ? error.message : "请求失败";
      if (settings.apiKey) {
        message = message.replaceAll(settings.apiKey, "[隐藏]");
      }
      if (error instanceof ProviderError && error.kind === "auth") {
        message = "DeepSeek 鉴权失败，请检查 API Key";
      }
      console.error(`[simple] ${message}`);
      return json({ error: message }, 502);
    }
  };
}

export async function startSimpleServer() {
  const port = Number(Deno.env.get("SIMPLE_PORT") || 8000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("SIMPLE_PORT 必须为 1024～65535");
  }
  const handler = await createHandler();
  Deno.serve({
    hostname: "127.0.0.1",
    port,
    onListen: () => console.log(`AI 写作台：http://127.0.0.1:${port}`),
  }, handler);
}

if (import.meta.main) await startSimpleServer();
