import type { DatabaseSync } from 'node:sqlite';
import type { GoalStatus } from '../domain/types.ts';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { getEscalation, getGoal, listTokenUsageForGoal } from '../infra/store.ts';

/** 复盘中的一条记录，直接对应审计事件，避免二次解释。 */
export interface ReviewEntry {
  at: string;
  actor: string;
  type: string;
  summary: string;
}

export interface ReviewEscalation {
  id: string;
  action: string;
  reason: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedAt?: string;
  decisionReason?: string;
}

/**
 * 目标复盘记录。
 *
 * 只读汇总审计与用量表：偏差、人工介入、拒绝、升级与失败。
 * P0 不生成改进提案，也不修改目标状态；需要留存时由 generateReview 追加一条审计。
 */
export interface ReviewRecord {
  goalId: string;
  title: string;
  status: GoalStatus;
  generatedAt: string;
  budget: {
    budgetTokens: number;
    usedTokens: number;
    remainingTokens: number;
  };
  deviations: ReviewEntry[];
  interventions: ReviewEntry[];
  denials: ReviewEntry[];
  escalations: ReviewEscalation[];
  failures: ReviewEntry[];
  notes: string[];
}

type Payload = Record<string, unknown>;

function payloadOf(event: { payload: unknown }): Payload {
  return (event.payload ?? {}) as Payload;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reasonSuffix(reason: string): string {
  return reason.length > 0 ? `：${reason}` : '';
}

/**
 * 汇总目标复盘。
 *
 * 各分类是对同一批审计的不同视角，允许一条事件同时出现在多个分类里
 * （例如验收返工既是偏差也是人工介入）；分类不改变原始记录。
 */
export function buildReview(db: DatabaseSync, goalId: string, now = new Date()): ReviewRecord {
  const goal = getGoal(db, goalId);
  if (!goal) throw new Error(`目标不存在：${goalId}`);

  const events = listAuditEvents(db, goalId);
  const deviations: ReviewEntry[] = [];
  const interventions: ReviewEntry[] = [];
  const denials: ReviewEntry[] = [];
  const failures: ReviewEntry[] = [];
  const escalations = new Map<string, ReviewEscalation>();

  const add = (target: ReviewEntry[], event: (typeof events)[number], summary: string) => {
    target.push({ at: event.at, actor: event.actor, type: event.type, summary });
  };

  for (const event of events) {
    const payload = payloadOf(event);
    switch (event.type) {
      case 'plan.rejected': {
        const summary = `计划被拒绝${reasonSuffix(text(payload.reason))}`;
        add(deviations, event, summary);
        add(denials, event, summary);
        break;
      }
      case 'plan.approved':
        add(interventions, event, `计划批准（预算 ${Number(payload.totalBudgetTokens)} tokens）`);
        break;
      case 'goal.paused':
        add(deviations, event, `目标暂停${reasonSuffix(text(payload.reason))}`);
        add(interventions, event, `人工暂停${reasonSuffix(text(payload.reason))}`);
        break;
      case 'goal.resumed':
        add(interventions, event, `恢复目标到 ${text(payload.to)}${reasonSuffix(text(payload.reason))}`);
        break;
      case 'budget.exhausted':
        add(
          deviations,
          event,
          `预算耗尽：已用 ${Number(payload.usedTokens)} / ${Number(payload.budgetTokens)} tokens`,
        );
        break;
      case 'budget.extended':
        add(interventions, event, `追加预算：${Number(payload.from)} → ${Number(payload.to)} tokens`);
        break;
      case 'builder.retry_cleared':
        add(interventions, event, `重置重试计数${reasonSuffix(text(payload.reason))}`);
        break;
      case 'auth.denied': {
        const request = payload.request as { action?: string } | undefined;
        add(denials, event, `动作被拒绝：${request?.action ?? '未知动作'}（${text(payload.reason)}）`);
        break;
      }
      case 'builder.run_denied':
        add(denials, event, `运行被拒绝${reasonSuffix(text(payload.reason))}`);
        break;
      case 'builder.commit_denied':
        add(denials, event, `提交被拒绝${reasonSuffix(text(payload.reason))}`);
        break;
      case 'builder.push_denied':
        add(denials, event, `推送被拒绝${reasonSuffix(text(payload.reason))}`);
        break;
      case 'acceptance.decided': {
        const decision = text(payload.decision);
        add(interventions, event, `验收决定：${decision}${reasonSuffix(text(payload.reason))}`);
        if (decision === 'rework') {
          add(deviations, event, `验收返工${reasonSuffix(text(payload.reason))}`);
        }
        break;
      }
      case 'escalation.created': {
        const id = text(payload.escalationId);
        escalations.set(id, {
          id,
          action: text(payload.action),
          reason: getEscalation(db, id)?.reason ?? '',
          createdAt: event.at,
          status: 'pending',
        });
        break;
      }
      case 'escalation.approved':
      case 'escalation.denied':
      case 'escalation.expired': {
        const id = text(payload.escalationId);
        const existing = escalations.get(id);
        const status = event.type === 'escalation.approved' ? 'approved' : event.type === 'escalation.denied' ? 'denied' : 'expired';
        if (existing) {
          existing.status = status;
          existing.decidedAt = event.at;
          existing.decisionReason = text(payload.reason);
        } else {
          escalations.set(id, {
            id,
            action: text(payload.action),
            reason: '',
            createdAt: event.at,
            status,
            decidedAt: event.at,
            decisionReason: text(payload.reason),
          });
        }
        if (event.type === 'escalation.approved') {
          add(interventions, event, `升级获批：${text(payload.action)}${reasonSuffix(text(payload.reason))}`);
        }
        if (event.type === 'escalation.denied') {
          const summary = `升级被拒：${text(payload.action)}${reasonSuffix(text(payload.reason))}`;
          add(interventions, event, summary);
          add(denials, event, summary);
        }
        break;
      }
      case 'builder.run_finished': {
        if (payload.status !== 'failed') break;
        const kind = text(payload.failureKind) || '未分类';
        const cause = text(payload.causeKey);
        add(failures, event, `实现运行失败（${kind}）${cause ? `：${cause}` : ''}`);
        break;
      }
      case 'verifier.verdicts_recorded': {
        const summary = payload.summary as { failed?: number; undetermined?: number } | undefined;
        if (!summary || ((summary.failed ?? 0) === 0 && (summary.undetermined ?? 0) === 0)) break;
        add(
          failures,
          event,
          `判定未通过：${summary.failed ?? 0} 条不通过，${summary.undetermined ?? 0} 条无法判定`,
        );
        break;
      }
      case 'verifier.completion_assessed': {
        const result = payload.goal as { complete?: boolean; reasons?: string[] } | undefined;
        if (!result || result.complete !== false) break;
        add(failures, event, `完成判定未通过：${(result.reasons ?? []).join('；')}`);
        break;
      }
      default:
        break;
    }
  }

  const usedTokens = listTokenUsageForGoal(db, goalId).reduce((total, usage) => total + usage.tokens, 0);

  return {
    goalId,
    title: goal.title,
    status: goal.status,
    generatedAt: now.toISOString(),
    budget: {
      budgetTokens: goal.budgetTokens,
      usedTokens,
      remainingTokens: Math.max(goal.budgetTokens - usedTokens, 0),
    },
    deviations,
    interventions,
    denials,
    escalations: [...escalations.values()],
    failures,
    notes: [
      'P0 复盘只汇总已发生的记录，不生成改进提案或变更建议。',
      '所有条目来自只追加的审计与用量表，生成复盘不修改目标状态。',
    ],
  };
}

/** 生成并留存复盘：追加一条 review.generated 审计，记录即为当时快照。 */
export function generateReview(
  db: DatabaseSync,
  goalId: string,
  actor = 'human',
  now = new Date(),
): ReviewRecord {
  const record = buildReview(db, goalId, now);
  appendAudit(
    db,
    { actor, type: 'review.generated', goalId, payload: record },
    now.toISOString(),
  );
  return record;
}