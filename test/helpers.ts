import type { DatabaseSync } from 'node:sqlite';
import { approvePlan, submitPlan, type SubmitPlanInput } from '../src/app/plans.ts';
import { createGoal } from '../src/app/goals.ts';
import type { CreateGoalInput, Goal, Plan, WorkItem } from '../src/domain/types.ts';
import { openDatabase } from '../src/infra/db.ts';
import { getGoal } from '../src/infra/store.ts';

export const REPO = 'acme/demo';
export const BUILDER = 'builder-1';
export const VERIFIER = 'verifier-1';

export function defaultGoal(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return {
    title: '为登录页增加错误提示',
    description: '当登录失败时展示明确错误信息',
    repo: REPO,
    baseBranch: 'main',
    acceptance: ['错误密码时展示提示文案', '不泄露账号是否存在'],
    constraints: ['不新增运行时依赖'],
    budgetTokens: 2000,
    autonomy: 'A2',
    ...overrides,
  };
}

export function createTestDb(): DatabaseSync {
  return openDatabase(':memory:');
}

export function createTestGoal(db: DatabaseSync, overrides: Partial<CreateGoalInput> = {}): Goal {
  return createGoal(db, defaultGoal(overrides), 'architect');
}

export function builderItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'build',
    title: '实现错误提示',
    role: 'builder',
    dependsOn: [],
    dod: ['改动通过类型检查', '覆盖失败路径'],
    budgetTokens: 1000,
    grant: {
      subject: BUILDER,
      actions: ['repo.read', 'repo.write', 'repo.commit', 'repo.push', 'pr.create'],
      scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
      constraints: {},
    },
    ...overrides,
  };
}

export function verifierItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'verify',
    title: '独立验证',
    role: 'verifier',
    dependsOn: ['build'],
    dod: ['逐条核对验收标准'],
    budgetTokens: 500,
    grant: {
      subject: VERIFIER,
      actions: ['repo.read', 'pr.review', 'ci.rerun'],
      scope: { repos: [REPO] },
      constraints: {},
    },
    ...overrides,
  };
}

export function defaultPlan(overrides: Partial<SubmitPlanInput> = {}): SubmitPlanInput {
  return {
    workItems: [builderItem(), verifierItem()],
    totalBudgetTokens: 1500,
    risks: ['错误提示可能影响现有快照测试'],
    pendingDecisions: [],
    ...overrides,
  };
}

export function submitDefaultPlan(db: DatabaseSync, goalId: string): Plan {
  return submitPlan(db, goalId, defaultPlan(), 'planner');
}

export function setupApproved(overrides: Partial<CreateGoalInput> = {}): {
  db: DatabaseSync;
  goal: Goal;
  plan: Plan;
} {
  const db = createTestDb();
  const goal = createTestGoal(db, overrides);
  const plan = submitDefaultPlan(db, goal.id);
  approvePlan(db, plan.id, 'architect');
  return { db, goal: getGoal(db, goal.id) as Goal, plan };
}