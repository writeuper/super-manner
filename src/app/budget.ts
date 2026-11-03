import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isTerminalGoal } from '../domain/state.ts';
import type { Escalation, Goal, GoalStatus, TokenUsage, UsageSource } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { insertTokenUsage, listTokenUsageForGoal, updateGoal } from '../infra/store.ts';
import { createEscalation } from './escalations.ts';
import { getGoalOrThrow, pauseGoal } from './goals.ts';

/** 预算只按 token 计量；金额不在 P0 计算，避免引入不可信的价格表。 */
export interface BudgetStatus {
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  exhausted: boolean;
}

const PAUSABLE: GoalStatus[] = ['executing', 'verifying', 'blocked'];

export function getBudgetStatus(db: DatabaseSync, goalId: string): BudgetStatus {
  const goal = getGoalOrThrow(db, goalId);
  const usedTokens = listTokenUsageForGoal(db, goalId).reduce(
    (total, usage) => total + usage.tokens,
    0,
  );
  const remainingTokens = Math.max(goal.budgetTokens - usedTokens, 0);
  return {
    budgetTokens: goal.budgetTokens,
    usedTokens,
    remainingTokens,
    exhausted: usedTokens >= goal.budgetTokens,
  };
}

export interface RecordUsageInput {
  goalId: string;
  workItemId?: string;
  runId?: string;
  source: UsageSource;
  tokens: number;
  actor?: string;
}

export interface RecordUsageResult {
  usage: TokenUsage;
  status: BudgetStatus;
  /** 本次记录让预算首次耗尽时为 true。 */
  paused: boolean;
  escalation?: Escalation;
}

/**
 * 记录一次 token 消耗。
 *
 * 用量超过目标预算时暂停目标并创建 spend.tokens 升级，等待人追加预算；
 * 验证与验收不因预算耗尽而被跳过或压缩。
 */
export function recordTokenUsage(
  db: DatabaseSync,
  input: RecordUsageInput,
  now = new Date(),
): RecordUsageResult {
  if (!Number.isFinite(input.tokens) || input.tokens <= 0) {
    throw new Error('token 用量必须是正数');
  }

  getGoalOrThrow(db, input.goalId);
  const at = now.toISOString();
  const usage: TokenUsage = {
    id: randomUUID(),
    goalId: input.goalId,
    source: input.source,
    tokens: input.tokens,
    createdAt: at,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
  insertTokenUsage(db, usage);

  const status = getBudgetStatus(db, input.goalId);
  appendAudit(
    db,
    {
      actor: input.actor ?? 'system',
      type: 'budget.consumed',
      goalId: input.goalId,
      payload: {
        usageId: usage.id,
        workItemId: input.workItemId,
        runId: input.runId,
        source: input.source,
        tokens: input.tokens,
        usedTokens: status.usedTokens,
        budgetTokens: status.budgetTokens,
      },
    },
    at,
  );

  if (!status.exhausted) return { usage, status, paused: false };

  const goal = getGoalOrThrow(db, input.goalId);
  let paused = false;
  if (PAUSABLE.includes(goal.status)) {
    pauseGoal(db, input.goalId, 'system', '预算耗尽', now);
    paused = true;
  }

  const escalation = isTerminalGoal(goal.status)
    ? undefined
    : createEscalation(
        db,
        {
          goalId: input.goalId,
          subject: 'system',
          action: 'spend.tokens',
          resource: { repo: goal.repo, branch: 'budget' },
          reason: `预算耗尽：已用 ${status.usedTokens} / ${status.budgetTokens} tokens`,
          impact: '继续实现需要追加预算；验证与验收不受影响，不得为省预算压缩验证',
          options: ['追加预算并恢复', '取消目标'],
          recommendation: '追加预算',
        },
        now,
      );

  appendAudit(
    db,
    {
      actor: 'system',
      type: 'budget.exhausted',
      goalId: input.goalId,
      payload: {
        usedTokens: status.usedTokens,
        budgetTokens: status.budgetTokens,
        escalationId: escalation?.id,
        paused,
      },
    },
    at,
  );

  return { usage, status, paused, ...(escalation ? { escalation } : {}) };
}

/** 人工追加预算；不自动恢复目标，恢复仍需显式 resume。 */
export function extendBudget(
  db: DatabaseSync,
  goalId: string,
  extraTokens: number,
  actor: string,
  now = new Date(),
): Goal {
  if (!Number.isFinite(extraTokens) || extraTokens <= 0) {
    throw new Error('追加预算必须是正数');
  }
  const goal = getGoalOrThrow(db, goalId);
  if (isTerminalGoal(goal.status)) throw new Error(`目标已结束，不能追加预算：${goal.status}`);

  const at = now.toISOString();
  const updated: Goal = { ...goal, budgetTokens: goal.budgetTokens + extraTokens, updatedAt: at };
  updateGoal(db, updated);
  appendAudit(
    db,
    {
      actor,
      type: 'budget.extended',
      goalId,
      payload: { from: goal.budgetTokens, to: updated.budgetTokens, added: extraTokens },
    },
    at,
  );
  return updated;
}