export const REVIEW_CATEGORIES = {
  platform: "平台内容风险",
  privacy: "隐私与敏感信息",
  fact: "事实与证据",
  style: "作者风格与自然表达",
  readability: "标题与阅读体验",
  rights: "引用与 AI 标识",
} as const;

export type ReviewCategory = keyof typeof REVIEW_CATEGORIES;
export interface ReviewIssue {
  category: ReviewCategory;
  severity: "low" | "medium" | "high" | "blocker";
  evidence: string;
  message: string;
  suggestion: string;
  ruleIds: string[];
}
export interface ArticleReview {
  status: "completed" | "local_only";
  ruleVersion: string;
  summary: string;
  checks: Array<
    {
      category: ReviewCategory;
      result: "attention" | "not_found" | "not_verified";
      note: string;
    }
  >;
  issues: ReviewIssue[];
  reviewedAt: string;
  fingerprint: string;
  model: string | null;
  usage: { total_tokens?: number } | null;
  elapsedMs: number;
}
