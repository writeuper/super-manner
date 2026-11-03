import type { DatabaseSync } from 'node:sqlite';
import { assertGoalTransition, isTerminalGoal } from '../domain/state.ts';
import type { CreateGoalInput, Goal, GoalStatus } from '../domain/types.ts';
import { randomUUID } from 'node:crypto';
import { appendAudit } from '../infra/audit.ts';
import {
  getGoal,
  insertGoal,
  listEscalations,
  listWorkspaces,
  revokeGrantsForGoal,
  updateEscalation,
  updateGoal,
} from '../infra/store.ts';
import {
  getGoalCheckpoints,
  summarizeCheckpoints,
  type CheckpointSummary,
} from './checkpoints.ts';

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
  let expired = 0;
  if (revoked > 0) {
    appendAudit(db, { actor, type: 'grants.revoked', goalId, payload: { count: revoked, reason: '目标取消' } }, at);
  }

  for (const escalation of listEscalations(db, 'pending')) {
    if (escalation.goalId !== goalId) continue;
    expired += 1;
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

  const activeWorkspaces = listWorkspaces(db, { goalId, status: 'active' }).length;
  const updated: Goal = {
    ...goal,
    status: 'cancelled',
    pausedFrom: undefined,
    updatedAt: at,
  };
  updateGoal(db, updated);
  appendAudit(
    db,
    {
      actor,
      type: 'goal.cancelled',
      goalId,
      payload: {
        from: goal.status,
        revokedGrants: revoked,
        expiredEscalations: expired,
        activeWorkspaces,
      },
    },
    at,
  );
  return updated;
}

/** 允许暂停的阶段：执行、验证、等待人工裁决；验收决定阶段直接给结论，不暂停。 */
const PAUSABLE_STATUSES: GoalStatus[] = ['executing', 'verifying', 'blocked'];

export interface GoalLifecycleResult {
  goal: Goal;
  from: GoalStatus;
  to: GoalStatus;
  /** 暂停时已完成的写操作；恢复后据此跳过重复执行。 */
  completedWrites: CheckpointSummary[];
}

/**
 * 暂停目标。
 *
 * 只改目标状态，不吊销授权：暂停是可恢复的，恢复后沿用原授权；
 * 网关会把 paused 视为不可执行，因此暂停期间的写请求全部拒绝。
 */
export function pauseGoal(
  db: DatabaseSync,
  goalId: string,
  actor: string,
  reason = '',
  now = new Date(),
): GoalLifecycleResult {
  const goal = getGoalOrThrow(db, goalId);
  if (goal.status === 'paused') throw new Error('目标已处于暂停状态');
  if (!PAUSABLE_STATUSES.includes(goal.status)) {
    throw new Error(`目标当前状态不能暂停：${goal.status}`);
  }

  const at = now.toISOString();
  const completedWrites = summarizeCheckpoints(getGoalCheckpoints(db, goalId));
  const updated: Goal = {
    ...goal,
    status: 'paused',
    pausedFrom: goal.status,
    updatedAt: at,
  };
  updateGoal(db, updated);
  appendAudit(
    db,
    {
      actor,
      type: 'goal.paused',
      goalId,
      payload: { from: goal.status, reason, completedWrites },
    },
    at,
  );

  return { goal: updated, from: goal.status, to: 'paused', completedWrites };
}

/**
 * 恢复目标到暂停前的阶段。
 *
 * 恢复本身不重放任何动作；已完成的写操作由检查点标记，
 * Builder 再次被调用时会直接返回跳过，不重复改动工作区。
 */
export function resumeGoal(
  db: DatabaseSync,
  goalId: string,
  actor: string,
  reason = '',
  now = new Date(),
): GoalLifecycleResult {
  const goal = getGoalOrThrow(db, goalId);
  if (goal.status !== 'paused' || !goal.pausedFrom) {
    throw new Error(`目标当前状态不能恢复：${goal.status}`);
  }

  const at = now.toISOString();
  const target = goal.pausedFrom;
  assertGoalTransition('paused', target);
  const completedWrites = summarizeCheckpoints(getGoalCheckpoints(db, goalId));
  const updated: Goal = { ...goal, status: target, pausedFrom: undefined, updatedAt: at };
  updateGoal(db, updated);
  appendAudit(
    db,
    {
      actor,
      type: 'goal.resumed',
      goalId,
      payload: { from: 'paused', to: target, reason, completedWrites },
    },
    at,
  );

  return { goal: updated, from: 'paused', to: target, completedWrites };
}