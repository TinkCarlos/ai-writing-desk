// 思考强度的唯一来源：SIMPLE_REASONING_EFFORT=max|high，默认 max。
// 评审、建议稿、大纲、正文都从这里取值；改完需重启服务生效。
export const REASONING_EFFORTS = ["max", "high"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export function reasoningEffort(): ReasoningEffort {
  const raw = Deno.env.get("SIMPLE_REASONING_EFFORT")?.trim().toLowerCase();
  if (!raw) return "max";
  if ((REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return raw as ReasoningEffort;
  }
  throw new Error(
    `SIMPLE_REASONING_EFFORT 只能是 ${
      REASONING_EFFORTS.join(" 或 ")
    }，当前是 "${raw}"`,
  );
}

// 仅供联调：SIMPLE_DEBUG_ARTICLE_MAX_TOKENS 把正文输出上限临时压低，用来在实跑里
// 触发“思考耗尽、正文为空 → 自动重试”路径。不设时为 null，正文用 32768。
// 设了以后正文基本必然失败，验完必须去掉并重启。
export function debugArticleMaxTokens(): number | null {
  const raw = Deno.env.get("SIMPLE_DEBUG_ARTICLE_MAX_TOKENS")?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 64 || value > 32768) {
    throw new Error(
      `SIMPLE_DEBUG_ARTICLE_MAX_TOKENS 必须是 64～32768 的整数，当前是 "${raw}"`,
    );
  }
  return value;
}
