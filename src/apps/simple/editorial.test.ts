import { assert, assertEquals, assertRejects } from "@std/assert";
import type { LLMProvider } from "@src/core/ports/llm.ts";
import { generate, renderArticle } from "./workbench.ts";
import {
  fingerprint,
  reviewArticle,
  type ReviewInput,
  reviseArticle,
} from "./editorial.ts";
import { REVIEW_CATEGORIES } from "./review-contract.ts";
import { AI_DISCLOSURE, scanPrivacy } from "./privacy.ts";
import { createHandler } from "./server.ts";
import {
  POLICY_REFERENCES,
  REVIEW_RULES,
  RULE_VERSION,
  WRITING_REFERENCES,
} from "./editorial-rules.ts";

const article: ReviewInput = {
  title: "AI 工具怎样验证",
  body: "## 看证据\n\n不是所有场景都能用。",
  material: "用户提供的来源说明：未测所有场景。",
  sources: [],
  aiAssisted: true,
};
const result = () => ({
  summary: "请人工核对",
  checks: Object.keys(REVIEW_CATEGORIES).map((category) => ({
    category,
    result: "not_found",
    note: "按提供材料检查，未发现明显问题",
  })),
  issues: [] as Array<Record<string, unknown>>,
});
function mock(raw: unknown, finish_reason = "stop") {
  let calls = 0;
  let system = "";
  let maxTokens: number | undefined;
  const llm: LLMProvider = {
    initialize: async () => {},
    refresh: async () => {},
    setModel: () => {},
    createChatCompletion: async (messages, options) => {
      calls++;
      system = messages[0].content;
      assertEquals(options?.reasoning_effort, "max");
      maxTokens = options?.max_tokens;
      return {
        model: "test-model",
        choices: [{ finish_reason, message: { content: JSON.stringify(raw) } }],
      };
    },
  };
  return {
    llm,
    calls: () => calls,
    system: () => system,
    maxTokens: () => maxTokens,
  };
}

Deno.test("隐私扫描只返回脱敏提示；真实敏感输入不发送模型", async () => {
  const secret = "sk-" + "a".repeat(32);
  const dirty = {
    ...article,
    body:
      `${article.body}\n${secret}\n13812345678\n110101199001011234\ntest@example.com`,
  };
  const stub = mock(result());
  const review = await reviewArticle(stub.llm, dirty);
  assertEquals(stub.calls(), 0);
  assertEquals(review.status, "local_only");
  assert(!JSON.stringify(review).includes(secret));
  assert(!JSON.stringify(review).includes("13812345678"));
  assertEquals(scanPrivacy(dirty.body).length, 4);
  await assertRejects(() =>
    generate(stub.llm, {
      topic: "AI",
      material: dirty.body,
      outline: "大纲",
      sources: [],
    }, "article")
  );
  assertEquals(stub.calls(), 0);
  await assertRejects(() => renderArticle("标题", dirty.body, [], true));
});

Deno.test("评审要覆盖六维，引用真实原句，不得用失败/缺维冒充通过", async () => {
  const raw = result();
  raw.issues.push({
    category: "style",
    severity: "medium",
    evidence: "不是所有场景都能用。",
    message: "建议具体化场景",
    suggestion: "用已有材料限定适用场景",
    ruleIds: ["E3"],
  });
  const stub = mock(raw);
  const review = await reviewArticle(stub.llm, article);
  // Review reasoning can exceed 16K with the full rule list; 32K keeps headroom.
  assertEquals(stub.maxTokens(), 32768);
  assertEquals(review.status, "completed");
  assertEquals(review.ruleVersion, RULE_VERSION);
  assertEquals(review.issues[0].ruleIds, ["E3"]);
  assertEquals(
    review.checks.find((item) => item.category === "style")?.result,
    "attention",
  );
  assertEquals(review.fingerprint, await fingerprint(article));
  assert(
    stub.system().includes("AI 模型") ||
      stub.system().includes("题材中心是 AI"),
  );
  assert(stub.system().includes("9 年软件测试"));
  assert(stub.system().includes("没有微信内部推荐规则"));
  assert(stub.system().includes("不能虚构"));
  await assertRejects(() =>
    reviewArticle(mock({ ...result(), checks: [] }).llm, article)
  );
  await assertRejects(() =>
    reviewArticle(mock(result(), "length").llm, article)
  );
  raw.issues[0].evidence = "原文里不存在的话";
  await assertRejects(() => reviewArticle(mock(raw).llm, article));
});

Deno.test("过期评审不得用于优化；建议稿不包含敏感信息且不是直接覆盖", async () => {
  const review = await reviewArticle(mock(result()).llm, article);
  const stub = mock({
    title: article.title,
    body: "## 看证据\n\n先用给定场景核对。",
    changes: ["限定场景"],
  });
  await assertRejects(() =>
    reviseArticle(stub.llm, { ...article, body: article.body + "变化" }, review)
  );
  assertEquals(stub.calls(), 0);
  const candidate = await reviseArticle(stub.llm, article, review);
  assertEquals(stub.maxTokens(), 16384);
  assertEquals(candidate.changes, ["限定场景"]);
  assertEquals(article.body, "## 看证据\n\n不是所有场景都能用。");
  await assertRejects(() =>
    reviseArticle(
      mock({ title: article.title, body: "联系 13812345678", changes: [] }).llm,
      article,
      review,
    )
  );
});

Deno.test("AI 辅助标识保留在排版中，手动稿不凭空声明 AI", async () => {
  assert(
    (await renderArticle(article.title, article.body, [], true)).includes(
      AI_DISCLOSURE,
    ),
  );
  assert(
    !(await renderArticle(article.title, article.body, [], false)).includes(
      AI_DISCLOSURE,
    ),
  );
});

Deno.test("生成提示词继承作者视角，AI 题材不被变成工作台教程", async () => {
  const stub = mock({
    title: "AI 验证",
    body: "## 看证据\n\n只解释已知事实。",
  });
  await generate(stub.llm, {
    topic: "AI 模型更新",
    material: "公开摘要",
    outline: "分析边界",
    sources: [],
  }, "article");
  assert(stub.system().includes("题材中心是 AI"));
  assert(stub.system().includes("不要把每个热点都改写成公众号创作"));
  assert(stub.system().includes("主要面向中国读者"));
  assert(stub.system().includes("不固定小标题数量"));
  assert(stub.system().includes("不规定口头禅数量"));
  assert(stub.system().includes("正常中文标点可以保留"));
  assert(!stub.system().includes("你正在以「数字生命卡兹克」的身份"));
});

Deno.test("依据可追溯：经验不冒充平台规定，未知编号与过期规则不接受", async () => {
  const basis = new Set(POLICY_REFERENCES.map((item) => item.id));
  assert(
    REVIEW_RULES.filter((rule) => rule.id.startsWith("P")).every((rule) =>
      basis.has(rule.basis as typeof POLICY_REFERENCES[number]["id"])
    ),
  );
  const raw = result();
  raw.issues.push({
    category: "platform",
    severity: "medium",
    evidence: "不是所有场景都能用。",
    message: "请检查依据",
    suggestion: "按出处核对",
    ruleIds: ["made-up"],
  });
  await assertRejects(
    () => reviewArticle(mock(raw).llm, article),
    Error,
    "依据编号无效",
  );
  raw.issues[0].ruleIds = ["E2"];
  await assertRejects(
    () => reviewArticle(mock(raw).llm, article),
    Error,
    "缺少公开依据",
  );
  raw.issues[0].ruleIds = ["P1"];
  const review = await reviewArticle(mock(raw).llm, article);
  assertEquals(review.issues[0].ruleIds, ["P1"]);
  raw.issues[0].category = "style";
  raw.issues[0].severity = "high";
  await assertRejects(
    () => reviewArticle(mock(raw).llm, article),
    Error,
    "表达建议不能当作高危",
  );
  const revision = mock({
    title: article.title,
    body: article.body,
    changes: [],
  });
  await assertRejects(() =>
    reviseArticle(revision.llm, article, { ...review, ruleVersion: "old" })
  );
  assertEquals(revision.calls(), 0);
});

Deno.test("新风险条款能返回可追溯意见，并传入误判与修订边界", async () => {
  const input = { ...article, body: "转发朋友圈并集赞后免费领取AI课程。" };
  const raw = result();
  raw.issues.push({
    category: "platform",
    severity: "medium",
    evidence: input.body,
    message: "领取权益与分享集赞绑定",
    suggestion: "取消分享和集赞条件",
    ruleIds: ["P8", "P9"],
  });
  const stub = mock(raw);
  const review = await reviewArticle(stub.llm, input);
  assertEquals(review.issues[0].ruleIds, ["P8", "P9"]);
  assertEquals(review.checks[0].result, "attention");
  assert(
    stub.system().includes(
      "ruleIds只允许：" + REVIEW_RULES.map((r) => r.id).join("、"),
    ),
  );
  assert(stub.system().includes("账号资质未提供写not_verified"));
  assert(stub.system().includes("有用可自愿分享’不等于利益诱导"));
  assert(stub.system().includes("商业关系未知写not_verified"));
  assert(stub.system().includes("不要求所有推广都在标题加‘广告’"));
  assert(stub.system().includes("不为去AI味删掉合规说明"));
  const revision = mock({ title: input.title, body: input.body, changes: [] });
  await reviseArticle(revision.llm, input, review);
  assert(
    revision.system().includes(
      "不得把专业建议、收益/疗效或广告风险简单改称个人经历",
    ),
  );
  assert(revision.system().includes("未知资质/商业关系不代填"));
});

Deno.test("发文前自测要点只作编辑建议；官方条款可追溯且不误伤正常写法", async () => {
  const policy = new Set(POLICY_REFERENCES.map((item) => item.id));
  const writing = new Set(WRITING_REFERENCES.map((item) => item.id));
  for (const rule of REVIEW_RULES) {
    const pool: Set<string> = rule.id.startsWith("P") ? policy : writing;
    assert(pool.has(rule.basis), `${rule.id} 依据不可追溯`);
  }
  for (const id of policy) {
    assert(
      REVIEW_RULES.some((rule) => rule.basis === id),
      `${id} 未被任何检查项使用`,
    );
  }
  const input = {
    ...article,
    title: "最强AI写作课",
    body:
      "不转不是中国人！学会这套AI写作课就月入过万，全网最佳。\n\n随着AI的不断发展，我们来聊聊。",
  };
  const raw = result();
  raw.issues.push(
    {
      category: "platform",
      severity: "high",
      evidence: "不转不是中国人！",
      message: "以夸张话术胁迫转发",
      suggestion: "删去转发要求，改为说明适合谁读",
      ruleIds: ["P8"],
    },
    {
      category: "platform",
      severity: "high",
      evidence: "学会这套AI写作课就月入过万",
      message: "培训课程作确定性收益承诺",
      suggestion: "删去收益承诺，写清课程内容与限制",
      ruleIds: ["P11", "P10"],
    },
    {
      category: "readability",
      severity: "medium",
      evidence: "随着AI的不断发展，我们来聊聊。",
      message: "开头热场，读者不知道本文讲什么",
      suggestion: "第一段直接写要回答的具体问题",
      ruleIds: ["E5"],
    },
  );
  const stub = mock(raw);
  const review = await reviewArticle(stub.llm, input);
  assertEquals(review.ruleVersion, RULE_VERSION);
  assertEquals(review.issues.map((item) => item.ruleIds[0]), [
    "P8",
    "P11",
    "E5",
  ]);
  const system = stub.system();
  assert(system.includes("不转不是中国人"));
  assert(system.includes("仅在依P9已判断为商业广告时适用"));
  assert(system.includes("允许推荐不等于会被推荐"));
  assert(system.includes("不要求每300字一个刺激点"));
  assert(system.includes("不制造愤怒或焦虑"));
  assert(system.includes("‘震惊’等单词本身不等于违规"));
  assert(system.includes("不能仅凭‘转发’‘关注’字眼判违规"));
  const onlyExperience = result();
  onlyExperience.issues.push({
    category: "platform",
    severity: "medium",
    evidence: "不转不是中国人！",
    message: "转发话术",
    suggestion: "删去",
    ruleIds: ["E7"],
  });
  await assertRejects(
    () => reviewArticle(mock(onlyExperience).llm, input),
    Error,
    "缺少公开依据",
  );
  const pacing = result();
  pacing.issues.push({
    category: "readability",
    severity: "high",
    evidence: "随着AI的不断发展，我们来聊聊。",
    message: "缺少刺激点",
    suggestion: "补金句",
    ruleIds: ["E6"],
  });
  await assertRejects(
    () => reviewArticle(mock(pacing).llm, input),
    Error,
    "表达建议不能当作高危",
  );
});

Deno.test("无模型配置也能本地报隐私；伪造/丢失评审不能触发修订", async () => {
  const dir = await Deno.makeTempDir();
  const file = new URL(`file://${dir}/settings.json`);
  await Deno.writeTextFile(
    file,
    JSON.stringify({ apiKey: "", model: "deepseek-flash" }),
  );
  const handler = await createHandler(file);
  const post = (path: string, data: unknown) =>
    handler(
      new Request(`http://127.0.0.1:8000/api/simple/${path}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:8000",
          origin: "http://127.0.0.1:8000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      }),
    );
  try {
    const response = await post("review", {
      ...article,
      body: "联系 13812345678",
    });
    assertEquals(response.status, 200);
    const body = await response.text();
    assert(!body.includes("13812345678"));
    assert(body.includes("local_only"));
    assertEquals(
      (await post("revise", { ...article, reviewFingerprint: "forged" }))
        .status,
      400,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
