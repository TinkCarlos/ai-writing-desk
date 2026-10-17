import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  MantineProvider,
  Modal,
  PasswordInput,
  Textarea,
  TextInput,
} from "@mantine/core";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  RefreshCw,
  Settings,
  Sparkles,
} from "lucide-react";
import "@mantine/core/styles.css";
import "./styles.css";
import "./simple.css";
import { SimpleReviewPanel } from "./components/simple-review-panel.tsx";
import type { ArticleReview } from "../../src/apps/simple/review-contract.ts";
import { AI_DISCLOSURE, scanPrivacy } from "../../src/apps/simple/privacy.ts";
import { RULE_VERSION } from "../../src/apps/simple/editorial-rules.ts";

interface Source {
  title: string;
  url: string;
  excerpt: string;
  publishedAt: string;
  source: string;
}
interface Draft {
  topic: string;
  material: string;
  outline: string;
  title: string;
  body: string;
  sources: Source[];
  aiAssisted: boolean;
}
interface News {
  articles: Source[];
  warnings: string[];
  fetchedAt: string;
}
interface Status {
  configured: boolean;
  model: string;
  reasoningEffort: "max" | "high";
}

const STORAGE_KEY = "trendpublish.simple.draft.v1";
const EMPTY: Draft = {
  topic: "",
  material: "",
  outline: "",
  title: "",
  body: "",
  sources: [],
  aiAssisted: false,
};

function restore(): { draft: Draft; error: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { draft: EMPTY, error: "" };
    const data = JSON.parse(raw);
    if (
      ["topic", "material", "outline", "title", "body"].some((key) =>
        typeof data[key] !== "string"
      ) ||
      !Array.isArray(data.sources) || data.sources.length > 5 ||
      data.sources.some((s: Source) =>
        !s || [s.title, s.url, s.excerpt, s.publishedAt, s.source].some((v) =>
          typeof v !== "string"
        ) || !/^https?:\/\//.test(s.url)
      )
    ) {
      throw new Error();
    }
    return {
      draft: {
        ...data,
        aiAssisted: typeof data.aiAssisted === "boolean"
          ? data.aiAssisted
          : Boolean(data.body),
      },
      error: "",
    };
  } catch {
    return {
      draft: EMPTY,
      error: "本机草稿无法恢复。请检查浏览器存储，开始编辑前可先保留原有数据。",
    };
  }
}

async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    `/api/simple/${path}`,
    data === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败，请稍后再试");
  return result;
}

function date(value: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "发布时间未知";
}

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [initial] = useState(restore);
  const [draft, setDraft] = useState(initial.draft);
  const [storageError, setStorageError] = useState(initial.error);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [news, setNews] = useState<News | null>(null);
  const [newsBusy, setNewsBusy] = useState(false);
  const [newsError, setNewsError] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [html, setHtml] = useState("");
  const [renderedInput, setRenderedInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("deepseek-flash");
  const [settingsError, setSettingsError] = useState("");
  const [generationInfo, setGenerationInfo] = useState("");
  const [review, setReview] = useState<ArticleReview | null>(null);
  const [reviewedInput, setReviewedInput] = useState("");
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [candidate, setCandidate] = useState<
    { title: string; body: string; changes: string[] } | null
  >(null);
  const [previousDraft, setPreviousDraft] = useState<Draft | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busyStart, setBusyStart] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const renderInput = JSON.stringify({
    title: draft.title,
    body: draft.body,
    sources: draft.sources,
    aiAssisted: draft.aiAssisted,
  });
  const previewReady = Boolean(html && renderInput === renderedInput);
  const getReviewInput = (value: Draft) => ({
    title: value.title,
    body: value.body,
    material: value.material,
    sources: value.sources,
    aiAssisted: value.aiAssisted,
  });
  const currentReviewInput = JSON.stringify(getReviewInput(draft));
  const reviewCurrent = Boolean(
    review && review.ruleVersion === RULE_VERSION &&
      reviewedInput === currentReviewInput,
  );
  const privacyFindings = scanPrivacy(currentReviewInput);
  const highRisk = reviewCurrent &&
    review!.issues.some((issue) =>
      issue.severity === "high" || issue.severity === "blocker"
    );
  const exportReady = previewReady && reviewCurrent &&
    review?.status === "completed" && !highRisk &&
    privacyFindings.length === 0 && exportConfirmed;

  useEffect(() => {
    setExportConfirmed(false);
  }, [currentReviewInput]);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setBusyStart(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [error]);

  const busyLabel: Record<string, string> = {
    outline: "正在生成大纲",
    article: "正在生成正文",
    review: "正在评审当前稿",
    revise: "正在生成建议稿",
    render: "正在排版",
    settings: "正在保存模型设置",
  };
  const busySeconds = busy
    ? Math.max(0, Math.round((now - busyStart) / 1000))
    : 0;
  const slowStep = ["article", "review", "revise", "outline"].includes(busy);

  async function runReview(value: Draft) {
    setBusy("review");
    setError("");
    setMessage("");
    setReview(null);
    setReviewedInput("");
    const snapshot = JSON.stringify(getReviewInput(value));
    try {
      const result = await api<ArticleReview>("review", JSON.parse(snapshot));
      setReview(result);
      setReviewedInput(snapshot);
      setExportConfirmed(false);
      setMessage(
        result.status === "local_only"
          ? "本地扫描发现疑似隐私，请先脱敏。"
          : "评审完成，请逐项检查意见和待核实事项。",
      );
    } catch (err) {
      setError(
        `评审未完成，正文已保留：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBusy("");
    }
  }

  async function suggestRevision() {
    if (!reviewCurrent || review?.status !== "completed" || busy) return;
    setBusy("revise");
    setError("");
    try {
      setCandidate(
        await api("revise", {
          ...getReviewInput(draft),
          reviewFingerprint: review.fingerprint,
        }),
      );
    } catch (err) {
      setError(
        `建议稿未生成，原稿已保留：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBusy("");
    }
  }

  async function applyCandidate() {
    if (!candidate) return;
    const next = {
      ...draft,
      title: candidate.title,
      body: candidate.body,
      aiAssisted: true,
    };
    setPreviousDraft(draft);
    setDraft(next);
    setCandidate(null);
    await runReview(next);
  }

  function markdown(value: Draft) {
    const refs = value.sources.map((item) => `- [${item.title}](${item.url})`)
      .join("\n");
    return `# ${value.title}\n\n${value.body}${
      refs ? `\n\n## 来源资料\n\n${refs}` : ""
    }${value.aiAssisted ? `\n\n${AI_DISCLOSURE}` : ""}`;
  }

  useEffect(() => {
    if (initial.error) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      setStorageError("");
    } catch {
      setStorageError(
        "草稿未能保存到本机。请先导出 Markdown，避免关闭页面后丢失。 ",
      );
    }
  }, [draft, initial.error]);

  useEffect(() => {
    api<Status>("status").then((value) => {
      setStatus(value);
      setModel(value.model);
    })
      .catch(() => setError("本地服务连接失败，请确认服务仍在运行后刷新页面"));
    void refreshNews();
  }, []);

  useEffect(() => {
    globalThis.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function update(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (["topic", "material", "outline"].includes(field)) {
      if (confirmed) setConfirmReset(true);
      setConfirmed(false);
    }
    setMessage("");
  }

  async function refreshNews() {
    setNewsBusy(true);
    setNewsError("");
    try {
      setNews(await api<News>("news"));
    } catch (err) {
      setNewsError(err instanceof Error ? err.message : String(err));
    } finally {
      setNewsBusy(false);
    }
  }

  function toggleSource(source: Source) {
    const exists = draft.sources.some((item) => item.url === source.url);
    if (!exists && draft.sources.length === 5) {
      setError("最多选择 5 条素材，请先移除一条");
      return;
    }
    setDraft((current) => ({
      ...current,
      topic: current.topic || source.title.slice(0, 200),
      sources: exists
        ? current.sources.filter((item) => item.url !== source.url)
        : [...current.sources, source],
    }));
    if (confirmed) setConfirmReset(true);
    setConfirmed(false);
    setError("");
  }

  async function write(mode: "outline" | "article") {
    if (busy) return;
    if (!draft.topic.trim()) {
      setError("请先填写文章主题");
      return;
    }
    if (!draft.material.trim() && !draft.sources.some((item) => item.excerpt)) {
      setError("请选择带摘要的资讯，或填写可引用的素材");
      return;
    }
    if (mode === "article" && (!confirmed || !draft.outline.trim())) {
      setError("请填写并确认素材和大纲");
      return;
    }
    if (
      (mode === "outline" ? draft.outline : draft.body) &&
      !confirm(
        mode === "outline"
          ? "重新生成将替换当前大纲，继续吗？"
          : "重新生成将替换当前正文。需要保留时，请先导出 Markdown。继续吗？",
      )
    ) return;
    setBusy(mode);
    setError("");
    setMessage("");
    try {
      const result = await api<
        {
          outline?: string;
          title?: string;
          body?: string;
          usage: { total_tokens?: number } | null;
          elapsedMs: number;
          model: string | null;
          reasoningEffort: "max" | "high";
        }
      >(mode === "outline" ? "outline" : "generate", { ...draft, confirmed });
      if (mode === "outline") {
        setDraft((current) => ({ ...current, outline: result.outline! }));
        setConfirmed(false);
        setMessage("大纲已生成，请检查素材与章节后确认。");
      } else {
        const next = {
          ...draft,
          title: result.title!,
          body: result.body!,
          aiAssisted: true,
        };
        setDraft(next);
        setStep(2);
        setMessage("初稿已生成，正在评审；正文已保留。");
        await runReview(next);
      }
      setGenerationInfo(
        `${result.model || status?.model} · max · ${
          (result.elapsedMs / 1000).toFixed(1)
        } 秒${
          result.usage?.total_tokens != null
            ? ` · ${result.usage.total_tokens} tokens`
            : " · 用量未返回"
        }`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  async function render() {
    if (busy) return;
    setBusy("render");
    setError("");
    setMessage("");
    try {
      const result = await api<{ html: string }>(
        "render",
        JSON.parse(renderInput),
      );
      setHtml(result.html);
      setRenderedInput(renderInput);
      setMessage("排版已更新；完成当前稿评审与人工检查后可复制或导出 HTML。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  async function copy() {
    if (!exportReady) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([markdown(draft)], {
            type: "text/plain",
          }),
        }),
      ]);
      setMessage("已复制排版内容，请在公众号编辑器粘贴并检查效果。");
      setError("");
    } catch {
      setError("浏览器未允许复制富文本，请导出 HTML，或在预览中选择内容复制。");
    }
  }

  async function saveSettings() {
    setBusy("settings");
    setSettingsError("");
    try {
      const value = await api<Status>("settings", { apiKey: key, model });
      setStatus(value);
      setKey("");
      setSettingsOpen(false);
      setMessage("模型配置已保存。生成大纲或正文时才会调用 DeepSeek。");
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  const visibleNews = (news?.articles ?? []).filter((item) =>
    `${item.title} ${item.excerpt} ${item.source}`.toLowerCase().includes(
      query.toLowerCase(),
    )
  ).sort((a, b) => Number(!a.excerpt) - Number(!b.excerpt));
  const filename = (draft.title || draft.topic || "AI文章").replace(
    /[\\/:*?"<>|]/g,
    "_",
  ).slice(0, 60);

  return (
    <div className="simple-app">
      <header className="simple-header">
        <a href="/" className="simple-brand">
          TrendPublish <span>AI 写作台</span>
        </a>
        <Group gap="sm">
          <Badge variant="light" color={status?.configured ? "green" : "gray"}>
            {status?.configured
              ? `${status.model} · ${status.reasoningEffort}`
              : "DeepSeek 待配置"}
          </Badge>
          <Button
            variant="default"
            leftSection={<Settings size={16} />}
            onClick={() => {
              setSettingsError("");
              setSettingsOpen(true);
            }}
            disabled={Boolean(busy)}
          >
            模型设置
          </Button>
        </Group>
      </header>

      <main className="simple-main">
        <div className="simple-intro">
          <h1>把 AI 资讯写成自己的文章</h1>
          <p>选好素材，确认大纲，完成一篇可编辑、可排版的公众号初稿。</p>
        </div>
        <nav className="simple-steps" aria-label="写作步骤">
          {["找热点", "素材与大纲", "编辑与排版"].map((label, i) => (
            <button
              type="button"
              key={label}
              aria-current={step === i ? "step" : undefined}
              onClick={() => {
                setStep(i);
                setError("");
                setMessage("");
              }}
              disabled={Boolean(busy)}
            >
              <span>{i + 1}</span>
              {label}
            </button>
          ))}
        </nav>
        {storageError && (
          <Alert color="red" title="本机保存异常" mb="md">{storageError}</Alert>
        )}
        {error && (
          <div ref={errorRef}>
            <Alert
              color="red"
              role="alert"
              mb="md"
              withCloseButton
              onClose={() => setError("")}
            >
              {error}
            </Alert>
          </div>
        )}
        {busy && busyLabel[busy] && (
          <div className="simple-busy" role="status" aria-live="polite">
            <span className="simple-busy-dot" aria-hidden="true" />
            {busyLabel[busy]}… 已用 {busySeconds} 秒
            {slowStep && (
              <span className="simple-busy-note">
                {busy === "review"
                  ? "评审可能需要 3～4 分钟，正文已保存，请勿关闭页面"
                  : busy === "revise"
                  ? "建议稿可能需要几分钟，原稿不会被覆盖，请勿关闭页面"
                  : "模型生成中，请勿关闭页面"}
              </span>
            )}
          </div>
        )}
        {message && (
          <Alert
            color="blue"
            role="status"
            mb="md"
            withCloseButton
            onClose={() => setMessage("")}
          >
            {message}
          </Alert>
        )}
        {!status?.configured && (
          <div className="simple-model-note">
            AI 生成需要 DeepSeek API
            Key。你仍可浏览资讯、手动编辑和排版。<button
              type="button"
              onClick={() => setSettingsOpen(true)}
              disabled={Boolean(busy)}
            >
              配置模型 <ArrowRight size={14} />
            </button>
          </div>
        )}

        {step === 0 && (
          <section className="simple-panel">
            <div className="simple-section-heading">
              <div>
                <h2 ref={heading} tabIndex={-1}>AI 热点与资讯</h2>
                <p>
                  OpenAI、Hugging Face 公开
                  RSS，按发布时间排列；不是平台热度榜。
                </p>
              </div>
              <Button
                variant="default"
                leftSection={<RefreshCw size={16} />}
                loading={newsBusy}
                onClick={refreshNews}
              >
                刷新资讯
              </Button>
            </div>
            <div className="simple-news-toolbar">
              <TextInput
                aria-label="筛选资讯"
                placeholder="搜索标题、内容或来源"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              <span>
                {news
                  ? `${visibleNews.length} 条 · 最近获取 ${
                    date(news.fetchedAt)
                  }`
                  : "正在读取公开来源…"}
              </span>
            </div>
            {newsError && (
              <Alert color="red" mb="md">
                {newsError}
                {news && "；下方保留上次读取的资讯。"}
              </Alert>
            )}
            {news?.warnings.map((warning) => (
              <Alert color="yellow" mb="sm" key={warning}>{warning}</Alert>
            ))}
            {!visibleNews.length && (
              <div className="simple-empty">
                {newsBusy
                  ? "正在读取 AI 资讯…"
                  : newsError
                  ? "可重试刷新，或直接输入主题和素材开始写作。"
                  : query
                  ? "没有匹配的资讯，试试其他关键词。"
                  : "暂无资讯，可手动输入主题和素材。"}
              </div>
            )}
            <div className="simple-news-list">
              {visibleNews.map((source) => {
                const selected = draft.sources.some((item) =>
                  item.url === source.url
                );
                return (
                  <article
                    className={`simple-news-item ${selected ? "selected" : ""}`}
                    key={source.url}
                  >
                    <div>
                      <div className="simple-source-meta">
                        <strong>{source.source}</strong>
                        <time dateTime={source.publishedAt}>
                          {date(source.publishedAt)}
                        </time>
                        {!source.excerpt && (
                          <Badge size="xs" color="gray" variant="light">
                            需补素材
                          </Badge>
                        )}
                      </div>
                      <h3>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      </h3>
                      <p>
                        {source.excerpt.slice(0, 220) ||
                          "此来源未提供摘要，请查看原文后补充素材。"}
                        {source.excerpt.length > 220 ? "…" : ""}
                      </p>
                    </div>
                    <Button
                      variant={selected ? "light" : "default"}
                      leftSection={selected ? <Check size={15} /> : undefined}
                      onClick={() => toggleSource(source)}
                      disabled={Boolean(busy) ||
                        (!selected && draft.sources.length >= 5)}
                    >
                      {selected ? "已加入 · 移除" : "加入素材"}
                    </Button>
                  </article>
                );
              })}
            </div>
            <div className="simple-actions simple-actions-sticky">
              <span>
                已选 {draft.sources.length} / 5 条素材
                {draft.sources.length === 0 && " · 不选也可以直接手动输入主题"}
              </span>
              <Button
                rightSection={<ArrowRight size={16} />}
                variant={draft.sources.length ? "filled" : "default"}
                onClick={() => setStep(1)}
              >
                {draft.sources.length ? "整理素材与大纲" : "手动输入主题"}
              </Button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="simple-panel">
            <div className="simple-section-heading">
              <div>
                <h2 ref={heading} tabIndex={-1}>先确定这篇文章怎么写</h2>
                <p>检查来源摘要，补充事实，再生成或手写大纲。</p>
              </div>
              <Button
                variant="subtle"
                leftSection={<ArrowLeft size={16} />}
                onClick={() => setStep(0)}
                disabled={Boolean(busy)}
              >
                返回选题
              </Button>
            </div>
            <fieldset disabled={Boolean(busy)} className="simple-fieldset">
              <TextInput
                label="文章主题"
                maxLength={200}
                description="最多 200 个字符"
                value={draft.topic}
                onChange={(e) => update("topic", e.currentTarget.value)}
                placeholder="例如：这个 AI 工具更新，能解决什么实际问题？"
              />
              <div className="simple-source-box">
                <div className="simple-label">
                  已选来源 · {draft.sources.length} 条
                </div>
                {!draft.sources.length && (
                  <p>
                    尚未选择资讯。可以返回热点添加，或在下方填写自己的素材。
                  </p>
                )}
                {draft.sources.map((source) => (
                  <details key={source.url}>
                    <summary>{source.title}</summary>
                    <p>{source.excerpt || "没有摘要，请查阅原文补充材料。"}</p>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      查看原文
                    </a>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => toggleSource(source)}
                    >
                      移除此素材
                    </Button>
                  </details>
                ))}
              </div>
              <Textarea
                label="补充素材"
                description="最多 16000 个字符。可粘贴原文摘录、自己的判断和链接；链接不会自动抓取全文。"
                rows={5}
                maxLength={16000}
                value={draft.material}
                onChange={(e) => update("material", e.currentTarget.value)}
                placeholder="哪些事实可以引用？哪些是你的观点？没有来源支持的内容请标注待核实。"
              />
              <div className="simple-outline-label">
                <span>文章大纲</span>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<Sparkles size={14} />}
                  loading={busy === "outline"}
                  disabled={!status?.configured || Boolean(busy)}
                  onClick={() => write("outline")}
                >
                  AI 生成大纲
                </Button>
              </div>
              <Textarea
                aria-label="文章大纲"
                description="可直接手写或修改，最多 6000 个字符。"
                rows={9}
                maxLength={6000}
                value={draft.outline}
                onChange={(e) => update("outline", e.currentTarget.value)}
                placeholder="写作角度、章节安排，以及需要核实或补充的信息。"
              />
              <Checkbox
                label="我已检查素材与大纲，确认按此生成正文"
                checked={confirmed}
                onChange={(e) => {
                  setConfirmed(e.currentTarget.checked);
                  if (e.currentTarget.checked) setConfirmReset(false);
                }}
                disabled={!draft.outline.trim()}
              />
              {confirmReset && !confirmed && (
                <p className="simple-hint" role="status">
                  主题、素材或大纲已修改，请重新检查并勾选确认，才能生成正文。
                </p>
              )}
            </fieldset>
            <div className="simple-actions">
              <span>
                {generationInfo
                  ? `上次生成：${generationInfo}`
                  : "生成会调用你的 DeepSeek 账户并产生费用"}
              </span>
              <Group>
                <Button
                  variant="default"
                  disabled={Boolean(busy)}
                  onClick={() => setStep(2)}
                >
                  手动写正文
                </Button>
                <Button
                  leftSection={<Sparkles size={16} />}
                  loading={busy === "article"}
                  disabled={!status?.configured || !confirmed ||
                    !draft.outline.trim() || Boolean(busy)}
                  onClick={() => write("article")}
                >
                  确认并生成正文
                </Button>
              </Group>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="simple-panel">
            <div className="simple-section-heading">
              <div>
                <h2 ref={heading} tabIndex={-1}>编辑与自动排版</h2>
                <p>检查事实、修改措辞，使用简洁公众号模板预览。</p>
              </div>
              <Button
                variant="subtle"
                leftSection={<ArrowLeft size={16} />}
                onClick={() => setStep(1)}
                disabled={Boolean(busy)}
              >
                返回大纲
              </Button>
            </div>
            <p className="simple-style-note">
              写作定位：面向中国读者的 AI 公众号文章 · 测试老兵视角 · 自然中文 ·
              不编造亲测
            </p>
            {privacyFindings.length > 0 && (
              <Alert color="red" mb="md">
                本地发现疑似{privacyFindings.map((item) => item.label).join(
                  "、",
                )}。请先脱敏，再生成、评审或导出。
              </Alert>
            )}
            <div className="simple-editor-grid">
              <fieldset disabled={Boolean(busy)} className="simple-fieldset">
                <TextInput
                  label="文章标题"
                  maxLength={200}
                  value={draft.title}
                  onChange={(e) => update("title", e.currentTarget.value)}
                  placeholder="填写文章标题"
                />
                <Textarea
                  label="正文"
                  description="支持 ## 小标题、空行分段、**加粗**，最多 30000 个字符。"
                  rows={20}
                  maxLength={30000}
                  value={draft.body}
                  onChange={(e) => update("body", e.currentTarget.value)}
                  placeholder="在这里编辑正文，也可以直接粘贴自己的文章进行排版。"
                />
                <div className="simple-editor-meta">
                  <span>{draft.body.length} 字符</span>
                  <span>
                    {storageError ? "本机保存异常" : "草稿自动保存在当前浏览器"}
                  </span>
                </div>
                <Button
                  loading={busy === "render"}
                  disabled={!draft.title.trim() || !draft.body.trim() ||
                    privacyFindings.length > 0 ||
                    Boolean(busy)}
                  onClick={render}
                >
                  {html ? "更新排版预览" : "生成排版预览"}
                </Button>
                {previousDraft && (
                  <Button
                    variant="subtle"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (
                        confirm(
                          "恢复上次应用建议稿之前的原稿？当前修改会被替换。",
                        )
                      ) {
                        setDraft(previousDraft);
                        setPreviousDraft(null);
                        setReview(null);
                        setReviewedInput("");
                        setMessage("已恢复应用建议稿之前的原稿，请重新评审。");
                      }
                    }}
                  >
                    恢复应用建议稿前的原稿
                  </Button>
                )}
              </fieldset>
              <div className="simple-preview">
                <div className="simple-preview-heading">
                  <strong>公众号排版预览</strong>
                  <span>
                    {previewReady
                      ? "已更新"
                      : html
                      ? "正文已修改，请更新预览"
                      : "等待排版"}
                  </span>
                </div>
                {html
                  ? <iframe title="公众号文章预览" sandbox="" srcDoc={html} />
                  : (
                    <div className="simple-empty">
                      填写标题与正文后，点击“生成排版预览”。
                    </div>
                  )}
                <div className="simple-checklist" aria-label="交付前检查">
                  <strong>
                    {exportReady
                      ? "检查都已完成，可以复制或导出"
                      : "复制 / 导出 HTML 前还差："}
                  </strong>
                  <ul>
                    {[
                      {
                        done: previewReady,
                        label: "排版预览是当前正文",
                        todo: html
                          ? "点「更新排版预览」"
                          : "点「生成排版预览」",
                      },
                      {
                        done: privacyFindings.length === 0,
                        label: "没有疑似隐私信息",
                        todo: "先按上方红色提示脱敏",
                      },
                      {
                        done: reviewCurrent && review?.status === "completed",
                        label: "当前稿已完成评审",
                        todo: "去评审",
                        jump: true,
                      },
                      {
                        done: reviewCurrent && review?.status === "completed" &&
                          !highRisk,
                        label: "没有高风险问题",
                        todo: "查看评审意见",
                        jump: true,
                      },
                      {
                        done: exportConfirmed,
                        label: "已人工检查评审、待核实事项与 AI 标识",
                        todo: "勾选下方确认",
                      },
                    ].map((item) => (
                      <li key={item.label} className={item.done ? "done" : ""}>
                        <span aria-hidden="true">{item.done ? "✓" : "○"}</span>
                        {item.label}
                        {!item.done && (item.jump
                          ? (
                            <button
                              type="button"
                              onClick={() =>
                                document.getElementById("simple-review")
                                  ?.scrollIntoView({ behavior: "smooth" })}
                            >
                              {item.todo}
                            </button>
                          )
                          : <em>{item.todo}</em>)}
                      </li>
                    ))}
                  </ul>
                  <Checkbox
                    label="我已检查当前评审、待核实事项与 AI 标识"
                    checked={exportConfirmed}
                    disabled={!reviewCurrent ||
                      review?.status !== "completed" ||
                      highRisk || Boolean(busy)}
                    onChange={(e) =>
                      setExportConfirmed(e.currentTarget.checked)}
                  />
                </div>
                <Group gap="xs">
                  <Button
                    variant="default"
                    leftSection={<Copy size={15} />}
                    disabled={!exportReady || Boolean(busy)}
                    onClick={copy}
                  >
                    复制到公众号
                  </Button>
                  <Button
                    variant="default"
                    leftSection={<Download size={15} />}
                    disabled={!exportReady || Boolean(busy)}
                    onClick={() => {
                      download(
                        `${filename}.html`,
                        `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
                          draft.aiAssisted
                            ? '<meta name="generator" content="TrendPublish AI-assisted">'
                            : ""
                        }</head><body>${html}</body></html>`,
                        "text/html;charset=utf-8",
                      );
                      setMessage("HTML 已交给浏览器下载。");
                    }}
                  >
                    导出 HTML
                  </Button>
                  <Button
                    variant="subtle"
                    leftSection={<Download size={15} />}
                    disabled={!draft.body.trim() ||
                      privacyFindings.length > 0 ||
                      Boolean(busy)}
                    onClick={() => {
                      download(
                        `${filename}.md`,
                        markdown(draft),
                        "text/markdown;charset=utf-8",
                      );
                      setMessage("Markdown 已交给浏览器下载。");
                    }}
                  >
                    备份 Markdown
                  </Button>
                </Group>
                <p className="simple-caption">
                  Markdown 不受上述检查限制，可随时备份。发布时请使用公众号的 AI
                  内容声明功能。
                </p>
              </div>
            </div>
            <div id="simple-review" />
            <SimpleReviewPanel
              review={review}
              current={reviewCurrent}
              busy={busy}
              canReview={Boolean(draft.title.trim() && draft.body.trim())}
              onReview={() => runReview(draft)}
              onRevise={suggestRevision}
            />
            <div className="simple-actions">
              <span>
                {generationInfo || "保留自己的修改，发布前核对来源与事实。"}
              </span>
            </div>
          </section>
        )}
        <footer className="simple-footer">
          本地工作台 · 热点来源保留原文链接 · 内容发布前需人工审核
        </footer>
      </main>

      <Modal
        opened={Boolean(candidate)}
        onClose={() => setCandidate(null)}
        title="修改建议稿 · 应用前比较"
        size="xl"
        centered
      >
        {candidate && (
          <div className="simple-settings">
            <Alert color="blue">
              建议稿尚未覆盖原稿。应用后会重新评审，AI 辅助标识保留。
            </Alert>
            <ul>
              {candidate.changes.map((change, index) => (
                <li key={index}>{change}</li>
              ))}
            </ul>
            <div className="simple-editor-grid">
              <div>
                <TextInput label="原稿标题" value={draft.title} readOnly />
                <Textarea
                  label="原稿正文"
                  value={draft.body}
                  readOnly
                  rows={18}
                />
              </div>
              <div>
                <TextInput
                  label="建议稿标题"
                  value={candidate.title}
                  readOnly
                />
                <Textarea
                  label="建议稿正文"
                  value={candidate.body}
                  readOnly
                  rows={18}
                />
              </div>
            </div>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCandidate(null)}>
                保留原稿
              </Button>
              <Button onClick={applyCandidate}>应用建议稿并复审</Button>
            </Group>
          </div>
        )}
      </Modal>

      <Modal
        opened={settingsOpen}
        onClose={() => {
          if (!busy) {
            setSettingsOpen(false);
            setKey("");
          }
        }}
        title="DeepSeek 模型设置"
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <div className="simple-settings">
          <p>密钥仅保存在本机服务，不写入浏览器草稿。保存配置不会调用模型。</p>
          <TextInput
            label="模型名称"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
            disabled={Boolean(busy)}
            maxLength={100}
          />
          <TextInput
            label="思考强度"
            value={status?.reasoningEffort ?? "max"}
            readOnly
            description={`大纲、正文、评审和建议稿均开启思考模式，当前使用 ${
              status?.reasoningEffort ?? "max"
            } 强度；由本机服务的 SIMPLE_REASONING_EFFORT 设置，重启后生效。`}
          />
          <PasswordInput
            label="API Key"
            description={status?.configured
              ? "留空保留已保存的 Key；填写可更换。"
              : "填写你在 DeepSeek 平台申请的 Key。"}
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            autoComplete="off"
            maxLength={300}
            disabled={Boolean(busy)}
          />
          <a
            href="https://platform.deepseek.com/api_keys"
            target="_blank"
            rel="noreferrer"
          >
            打开 DeepSeek 密钥管理
          </a>
          {settingsError && (
            <Alert color="red" role="alert">{settingsError}</Alert>
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={Boolean(busy)}
              onClick={() => {
                setSettingsOpen(false);
                setKey("");
              }}
            >
              取消
            </Button>
            <Button
              loading={busy === "settings"}
              onClick={saveSettings}
              disabled={Boolean(busy)}
            >
              保存配置
            </Button>
          </Group>
        </div>
      </Modal>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider
    theme={{
      primaryColor: "blue",
      defaultRadius: "md",
      fontFamily: 'Inter, "PingFang SC", system-ui, sans-serif',
    }}
  >
    <App />
  </MantineProvider>,
);
