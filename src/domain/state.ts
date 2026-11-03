import type { GoalStatus, PlanStatus } from './types.ts';

/**
 * 目标状态机。
 *
 * 所有状态变更必须走这里，服务层不允许直接赋值 status。
 * 目的：越权路径可以通过"非法转换被拒绝"在测试里暴露出来。
 */
const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ['pending_confirmation', 'cancelled'],
  pending_confirmation: ['executing', 'draft', 'cancelled'],
  executing: ['verifying', 'blocked', 'paused', 'cancelled', 'failed'],
  blocked: ['executing', 'paused', 'cancelled', 'failed'],
  verifying: ['awaiting_acceptance', 'executing', 'blocked', 'paused', 'cancelled', 'failed'],
  paused: ['executing', 'verifying', 'blocked', 'cancelled'],
  awaiting_acceptance: ['completed', 'executing', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['submitted', 'rejected'],
  submitted: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!canTransitionGoal(from, to)) {
    throw new Error(`非法目标状态转换：${from} -> ${to}`);
  }
}

export function assertPlanTransition(from: PlanStatus, to: PlanStatus): void {
  if (!PLAN_TRANSITIONS[from].includes(to)) {
    throw new Error(`非法计划状态转换：${from} -> ${to}`);
  }
}

/** 可以继续推进的目标状态（用于待办与统计）。 */
export function isTerminalGoal(status: GoalStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}