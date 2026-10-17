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
    `SIMPLE_REASONING_EFFORT 只能是 ${REASONING_EFFORTS.join(" 或 ")}，当前是 "${raw}"`,
  );
}
