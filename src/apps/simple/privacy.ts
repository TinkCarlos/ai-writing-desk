export interface PrivacyFinding {
  kind: string;
  label: string;
  evidence: string;
}

const PATTERNS: Array<{ kind: string; label: string; pattern: RegExp }> = [
  {
    kind: "key",
    label: "密钥或访问令牌",
    pattern:
      /\bsk-[a-zA-Z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    kind: "credential",
    label: "凭证参数",
    pattern:
      /(?:api[_-]?key|access[_-]?token|app[_-]?secret|password|密码)\s*[=:：]\s*["']?[^\s"'&，。]{8,}/gi,
  },
  { kind: "phone", label: "手机号", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  {
    kind: "identity",
    label: "身份证号",
    pattern: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g,
  },
  {
    kind: "email",
    label: "邮箱地址",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "jwt",
    label: "JWT 令牌",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: "connection",
    label: "带密码的连接地址",
    pattern:
      /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@]+@[^\s]+/gi,
  },
];

// These are conservative hints, not an exhaustive privacy classifier.
export function scanPrivacy(value: string): PrivacyFinding[] {
  return PATTERNS.flatMap(({ kind, label, pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(value)
      ? [{ kind, label, evidence: `[疑似${label}已隐藏]` }]
      : [];
  });
}

export const AI_DISCLOSURE = "本文使用 AI 辅助创作。";

// The export step appends AI_DISCLOSURE itself. Remove only the model's own
// "本文由 AI 辅助整理" style clause so surrounding caveats stay intact.
const MODEL_DISCLOSURE =
  /[（(]?\s*本文(?:由|使用|借助|经|系)?\s*(?:AI|人工智能|ＡＩ)\s*(?:辅助|协助|参与)?\s*(?:整理|创作|生成|撰写|写作|完成|编写)\s*(?:而成)?\s*[)）]?\s*(?:[，,；;]\s*|[。.！!]\s*|$)/g;

export function stripModelDisclosure(body: string): string {
  return body.replace(MODEL_DISCLOSURE, "").replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trimEnd();
}
