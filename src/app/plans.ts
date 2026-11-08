import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Goal, Plan, WorkItem } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { getGoal, getPlan, insertPlan, listPlansForGoal, updatePlan } from '../infra/store.ts';
import { getGoalOrThrow, setGoalStatus } from './goals.ts';
import { issueGrantsForPlan } from './grants.ts';

/** 目标当前生效的计划：批准后的最新一版。 */
export function getApprovedPlan(db: DatabaseSync, goalId: string): Plan | undefined {
  return listPlansForGoal(db, goalId)
    .filter((plan) => plan.status === 'approved')
    .at(-1);
}

export interface SubmitPlanInput {
  workItems: WorkItem[];
  totalBudgetTokens: number;
  risks?: string[];
  pendingDecisions?: string[];
}

function assertAcyclicDependencies(items: WorkItem[]): void {
  const dependencies = new Map(items.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      throw new Error(`工作项依赖存在循环：${[...path, id].join(' -> ')}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of items) visit(item.id, []);
}

function validatePlanInput(goal: Goal, input: SubmitPlanInput): void {
  if (goal.missing.length > 0) {
    throw new Error(`目标信息不完整，不能提交计划：${goal.missing.join('；')}`);
  }
  if (!input.workItems || input.workItems.length === 0) {
    throw new Error('计划至少需要一个工作项');
  }
  const ids = new Set<string>();
  for (const item of input.workItems) {
    if (!item.id || ids.has(item.id)) throw new Error(`工作项 id 缺失或重复：${item.id}`);
    ids.add(item.id);
    if (!Number.isInteger(item.budgetTokens) || item.budgetTokens <= 0) {
      throw new Error(`工作项 ${item.id} 的预算必须为正整数`);
    }
    if (item.dod.length === 0) throw new Error(`工作项 ${item.id} 缺少完成标准`);
    if (item.grant.actions.length === 0) throw new Error(`工作项 ${item.id} 没有申请任何动作`);
  }
  for (const item of input.workItems) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`工作项 ${item.id} 依赖不存在的工作项：${dependency}`);
    }
  }
  assertAcyclicDependencies(input.workItems);
  const sum = input.workItems.reduce((total, item) => total + item.budgetTokens, 0);
  if (sum > input.totalBudgetTokens) {
    throw new Error(`工作项预算合计 ${sum} 超过计划预算 ${input.totalBudgetTokens}`);
  }
  if (input.totalBudgetTokens > goal.budgetTokens) {
    throw new Error(`计划预算 ${input.totalBudgetTokens} 超过目标预算 ${goal.budgetTokens}`);
  }
}

export function submitPlan(
  db: DatabaseSync,
  goalId: string,
  input: SubmitPlanInput,
  actor: string,
  now = new Date(),
): Plan {
  const goal = getGoalOrThrow(db, goalId);
  if (goal.status !== 'draft') throw new Error(`只有草稿态目标可以提交计划，当前：${goal.status}`);
  validatePlanInput(goal, input);

  const plan: Plan = {
    id: randomUUID(),
    goalId,
    version: listPlansForGoal(db, goalId).length + 1,
    status: 'submitted',
    workItems: input.workItems,
    totalBudgetTokens: input.totalBudgetTokens,
    risks: input.risks ?? [],
    pendingDecisions: input.pendingDecisions ?? [],
    createdAt: now.toISOString(),
  };

  insertPlan(db, plan);
  appendAudit(
    db,
    {
      actor,
      type: 'plan.submitted',
      goalId,
      payload: {
        planId: plan.id,
        version: plan.version,
        totalBudgetTokens: plan.totalBudgetTokens,
        workItems: plan.workItems.map((item) => ({ id: item.id, role: item.role, actions: item.grant.actions })),
      },
    },
    now.toISOString(),
  );

  setGoalStatus(db, goal, 'pending_confirmation', actor, now);
  return plan;
}

/**
 * 批准计划是授权产生的唯一入口。
 * 所有校验必须在签发任何 Grant 之前完成，避免"批了一半"。
 */
export function approvePlan(db: DatabaseSync, planId: string, actor: string, now = new Date()): Plan {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error(`计划不存在：${planId}`);
  if (plan.status !== 'submitted') throw new Error(`只有已提交的计划可以批准，当前：${plan.status}`);

  const goal = getGoalOrThrow(db, plan.goalId);
  if (goal.status !== 'pending_confirmation') {
    throw new Error(`目标不在待确认状态，当前：${goal.status}`);
  }
  if (plan.pendingDecisions.length > 0) {
    throw new Error(`计划仍有未决事项，不能批准：${plan.pendingDecisions.join('；')}`);
  }

  const sum = plan.workItems.reduce((total, item) => total + item.budgetTokens, 0);
  if (sum > plan.totalBudgetTokens) {
    throw new Error(`工作项预算合计 ${sum} 超过计划预算 ${plan.totalBudgetTokens}`);
  }
  if (plan.totalBudgetTokens > goal.budgetTokens) {
    throw new Error(`计划预算 ${plan.totalBudgetTokens} 超过目标预算 ${goal.budgetTokens}`);
  }

  // 先校验可转换与授权范围，再落库；任何失败都不会留下授权。
  issueGrantsForPlan(db, goal, plan, actor, now);

  const approved: Plan = { ...plan, status: 'approved', decidedAt: now.toISOString(), decidedBy: actor };
  updatePlan(db, approved);
  appendAudit(
    db,
    { actor, type: 'plan.approved', goalId: goal.id, payload: { planId: plan.id, totalBudgetTokens: plan.totalBudgetTokens } },
    now.toISOString(),
  );

  setGoalStatus(db, goal, 'executing', actor, now);
  return approved;
}

export function rejectPlan(db: DatabaseSync, planId: string, actor: string, reason: string, now = new Date()): Plan {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error(`计划不存在：${planId}`);
  if (plan.status !== 'submitted') throw new Error(`只有已提交的计划可以拒绝，当前：${plan.status}`);

  const goal = getGoalOrThrow(db, plan.goalId);
  const rejected: Plan = {
    ...plan,
    status: 'rejected',
    decidedAt: now.toISOString(),
    decidedBy: actor,
    rejectionReason: reason,
  };
  updatePlan(db, rejected);
  appendAudit(
    db,
    { actor, type: 'plan.rejected', goalId: goal.id, payload: { planId: plan.id, reason } },
    now.toISOString(),
  );

  setGoalStatus(db, goal, 'draft', actor, now);
  return rejected;
}