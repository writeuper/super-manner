import type { DatabaseSync } from 'node:sqlite';
import { assertGoalTransition, isTerminalGoal } from '../domain/state.ts';
import type { CreateGoalInput, Goal } from '../domain/types.ts';
import { randomUUID } from 'node:crypto';
import { appendAudit } from '../infra/audit.ts';
import {
  getGoal,
  insertGoal,
  listEscalations,
  revokeGrantsForGoal,
  updateEscalation,
  updateGoal,
} from '../infra/store.ts';

export function validateGoal(input: CreateGoalInput): string[] {
  const missing: string[] = [];
  if (!input.title?.trim()) missing.push('缺少目标标题');
  if (!input.repo?.trim()) missing.push('缺少目标仓库');
  if (!input.acceptance || input.acceptance.length === 0) missing.push('缺少验收标准');
  if (!Number.isInteger(input.budgetTokens) || input.budgetTokens <= 0) missing.push('预算必须为正整数');
  return missing;
}

export function createGoal(db: DatabaseSync, input: CreateGoalInput, actor: string, now = new Date()): Goal {
  const missing = validateGoal(input);
  const at = now.toISOString();
  const goal: Goal = {
    id: randomUUID(),
    title: input.title?.trim() ?? '',
    description: input.description?.trim() ?? '',
    repo: input.repo?.trim() ?? '',
    baseBranch: input.baseBranch?.trim() || 'main',
    acceptance: input.acceptance ?? [],
    constraints: input.constraints ?? [],
    budgetTokens: input.budgetTokens,
    autonomy: input.autonomy ?? 'A2',
    status: 'draft',
    missing,
    createdAt: at,
    updatedAt: at,
  };

  insertGoal(db, goal);
  appendAudit(
    db,
    {
      actor,
      type: 'goal.created',
      goalId: goal.id,
      payload: { title: goal.title, repo: goal.repo, budgetTokens: goal.budgetTokens, autonomy: goal.autonomy, missing },
    },
    at,
  );

  return goal;
}

export function getGoalOrThrow(db: DatabaseSync, goalId: string): Goal {
  const goal = getGoal(db, goalId);
  if (!goal) throw new Error(`目标不存在：${goalId}`);
  return goal;
}

export function setGoalStatus(db: DatabaseSync, goal: Goal, next: Goal['status'], actor: string, now = new Date()): Goal {
  assertGoalTransition(goal.status, next);
  const updated: Goal = { ...goal, status: next, updatedAt: now.toISOString() };
  updateGoal(db, updated);
  appendAudit(
    db,
    {
      actor,
      type: 'goal.status_changed',
      goalId: goal.id,
      payload: { from: goal.status, to: next },
    },
    now.toISOString(),
  );
  return updated;
}

/**
 * 取消是唯一可以随时触发的终止动作：
 * 先吊销授权，再处理未决升级，最后改目标状态。
 * 顺序不能反，否则中间失败会留下仍然有效的授权。
 */
export function cancelGoal(db: DatabaseSync, goalId: string, actor: string, now = new Date()): Goal {
  const goal = getGoalOrThrow(db, goalId);
  if (isTerminalGoal(goal.status)) throw new Error(`目标已结束，无法取消：${goal.status}`);

  const at = now.toISOString();
  const revoked = revokeGrantsForGoal(db, goalId, at, '目标取消');
  if (revoked > 0) {
    appendAudit(db, { actor, type: 'grants.revoked', goalId, payload: { count: revoked, reason: '目标取消' } }, at);
  }

  for (const escalation of listEscalations(db, 'pending')) {
    if (escalation.goalId !== goalId) continue;
    updateEscalation(db, {
      ...escalation,
      status: 'expired',
      decidedAt: at,
      decisionReason: '目标取消',
    });
    appendAudit(
      db,
      { actor, type: 'escalation.expired', goalId, payload: { escalationId: escalation.id, reason: '目标取消' } },
      at,
    );
  }

  const updated: Goal = { ...goal, status: 'cancelled', updatedAt: at };
  updateGoal(db, updated);
  appendAudit(db, { actor, type: 'goal.cancelled', goalId, payload: { revokedGrants: revoked } }, at);
  return updated;
}