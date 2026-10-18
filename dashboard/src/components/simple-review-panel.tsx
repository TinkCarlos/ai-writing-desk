import React from "react";
import { Alert, Badge, Button, Group } from "@mantine/core";
import { ClipboardCheck, Sparkles } from "lucide-react";
import {
  type ArticleReview,
  REVIEW_CATEGORIES,
} from "../../../src/apps/simple/review-contract.ts";
import {
  POLICY_REFERENCES,
  REVIEW_RULES,
  RULE_VERSION,
  RULES_CHECKED_AT,
  WRITING_REFERENCES,
} from "../../../src/apps/simple/editorial-rules.ts";

export function SimpleReviewPanel(
  { review, current, referenceOnly, failureReason, busy, canReview, onReview, onRevise }: {
    review: ArticleReview | null;
    current: boolean;
    /** Latest attempt failed: show the kept review as reference only. */
    referenceOnly?: boolean;
    /** Backend reason for the failed attempt, e.g. "truncated". */
    failureReason?: string;
    busy: string;
    canReview: boolean;
    onReview: () => void;
    onRevise: () => void;
  },
) {
  return (
    <section className="simple-review" aria-label="文章评审">
      <div className="simple-section-heading">
        <div>
          <h2>文章评审</h2>
          <p>检查证据、平台风险和自然表达。阅读建议不能预测推荐量。</p>
        </div>
        <Group gap="xs">
          <Button
            variant="default"
            leftSection={<ClipboardCheck size={16} />}
            loading={busy === "review"}
            disabled={!canReview || Boolean(busy)}
            onClick={onReview}
          >
            {review ? "重新评审当前稿" : "评审当前文章"}
          </Button>
          <Button
            variant="light"
            leftSection={<Sparkles size={16} />}
            loading={busy === "revise"}
            disabled={!current || review?.status !== "completed" ||
              Boolean(busy)}
            onClick={onRevise}
          >
            按评审生成建议稿
          </Button>
        </Group>
      </div>
      {busy === "review" && (
        <Alert color="blue" role="status">
          正在独立评审，正文已保留。评审也会消耗模型额度。
        </Alert>
      )}
      {!review && failureReason && busy !== "review" && (
        <Alert color="red" mb="md">
          {failureReason === "truncated"
            ? "评审没跑完，结果被截断了，不能当作评审通过。再评一次约消耗同样的额度。"
            : "评审没有完整结束，不能当作评审通过。"}
          <Button
            size="xs"
            variant="light"
            color="red"
            ml="sm"
            disabled={!canReview || Boolean(busy)}
            onClick={onReview}
          >
            重新评审
          </Button>
        </Alert>
      )}
      {review
        ? (
          <>
            {referenceOnly
              ? (
                <Alert color="yellow" mb="md">
                  本次评审未完成，下方是上一次完整评审，仅供参考，不能用于导出。
                  {failureReason === "truncated"
                    ? "本次评审结果被截断，再评一次约消耗同样的额度。"
                    : ""}
                  <Button
                    size="xs"
                    variant="light"
                    color="yellow"
                    ml="sm"
                    disabled={!canReview || Boolean(busy)}
                    onClick={onReview}
                  >
                    重新评审
                  </Button>
                </Alert>
              )
              : !current && (
                <Alert color="yellow" mb="md">
                  文章、素材、来源或评审规则已变化，下方是旧版本评审，不能用于当前稿。
                </Alert>
              )}
            <p className="simple-review-summary">{review.summary}</p>
            <div className="simple-review-checks">
              {review.checks.map((check) => (
                <div key={check.category}>
                  <div>
                    <strong>{REVIEW_CATEGORIES[check.category]}</strong>
                    <Badge
                      color={check.result === "attention" ? "orange" : "gray"}
                      variant="light"
                    >
                      {check.result === "attention"
                        ? "需处理"
                        : check.result === "not_verified"
                        ? "待人工核实"
                        : "本次未发现明显问题"}
                    </Badge>
                  </div>
                  <p>{check.note}</p>
                </div>
              ))}
            </div>
            <ol className="simple-review-issues">
              {review.issues.map((issue, i) => (
                <li key={i}>
                  <div>
                    <strong>{issue.message}</strong>
                    <Badge
                      color={issue.severity === "high" ||
                          issue.severity === "blocker"
                        ? "red"
                        : "gray"}
                    >
                      {issue.severity === "high" || issue.severity === "blocker"
                        ? "优先处理"
                        : "改进建议"}
                    </Badge>
                  </div>
                  <blockquote>{issue.evidence}</blockquote>
                  <p>{issue.suggestion}</p>
                  {issue.ruleIds?.length > 0 && (
                    <p className="simple-caption">
                      依据：{REVIEW_RULES.filter((rule) =>
                        issue.ruleIds.includes(rule.id)
                      ).map((rule) => {
                        const source = [
                          ...POLICY_REFERENCES,
                          ...WRITING_REFERENCES,
                        ].find((item) => item.id === rule.basis)!;
                        return (
                          <span key={rule.id}>
                            {rule.id} ·{" "}
                            {rule.id.startsWith("P") ? "公开资料" : "编辑经验"}
                            {" "}
                            ·{" "}
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {source.title}
                            </a>
                            {" "}
                          </span>
                        );
                      })}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            <p className="simple-caption">
              {review.status === "local_only"
                ? "仅完成本地隐私扫描，未向模型发送内容。"
                : `${review.model ?? "AI"} · max · ${
                  (review.elapsedMs / 1000).toFixed(1)
                } 秒 · ${review.usage?.total_tokens ?? "未返回"} tokens`}
            </p>
          </>
        )
        : !busy && (
          <p className="simple-caption">
            生成正文后自动评审；手动稿也可以单独评审。未完成评审不视为已通过。
          </p>
        )}
      <details className="simple-review-basis">
        <summary>评审依据与范围</summary>
        <p>
          本次规则版本 {RULE_VERSION}，核对日期{" "}
          {RULES_CHECKED_AT}。P 类参考公开资料，E
          类是写作/运营经验。微信运营规范与推荐运营规范为动态文档，本版按核对日读取的官方页整理，发布仍以后台最新规则和提示为准。
        </p>
        <ul>
          {POLICY_REFERENCES.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>
              <span>· {item.publishedAt} · {item.level}</span>
            </li>
          ))}
        </ul>
        <p>
          写作与运营参考：保留你的测试视角，借鉴具体问题、过程证据和叙事节奏；不套用他人身份与经历。高赞及运营经验文章仅供观察，不能推导爆款或处罚公式。
        </p>
        <ul>
          {WRITING_REFERENCES.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>{" "}
              · {item.level}
            </li>
          ))}
        </ul>
        <ul>
          {REVIEW_RULES.map((rule) => (
            <li key={rule.id}>
              <strong>
                {rule.id} ·{" "}
                {rule.id.startsWith("P") ? "公开资料检查" : "编辑经验"}
              </strong>：{rule.instruction}
            </li>
          ))}
        </ul>
        <p>
          无法核验完整版权授权、所有敏感信息或微信内部推荐机制；没有“保证合规”“包过审”“AI含量”或“推流分”。
        </p>
      </details>
    </section>
  );
}
