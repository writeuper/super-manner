import type { DatabaseSync } from 'node:sqlite';
import { isActionAllowedForRole } from '../domain/actions.ts';
import type { Action, GrantScope, Plan, WorkItem } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { listGrantsForGoal, listPlansForGoal } from '../infra/store.ts';
import { getGoalOrThrow } from './goals.ts';

/** P0 只有三种执行角色的工作项；架构师负责目标与批准，不进入执行。 */
export type AgentRole = WorkItem['role'];

export interface RolePlaybook {
  role: AgentRole;
  name: string;
  objective: string;
  steps: string[];
  boundaries: string[];
}

/**
 * 角色契约（playbook）。
 *
 * 描述角色做什么、按什么顺序做、不能做什么。
 * 动作权限不写在这里，一律以 Grant 为准，避免两处真相。
 */
export const ROLE_PLAYBOOKS: Record<AgentRole, RolePlaybook> = {
  planner: {
    role: 'planner',
    name: '规划者',
    objective: '把目标拆成可独立执行与验证的工作项，并给出预算、风险与待决事项。',
    steps: [
      '阅读目标、验收标准、约束与自治级别',
      '按验收标准拆解工作项，标注角色、依赖与完成标准',
      '为每个工作项申请最小必要授权，预算合计不超过目标预算',
      '列出风险与待决事项，提交计划等待人工批准',
    ],
    boundaries: ['不直接写代码', '不申请超出角色能力上限的动作', '未批准的计划不产生任何授权'],
  },
  builder: {
    role: 'builder',
    name: '实现者',
    objective: '在授权范围内完成一个工作项的代码改动并自检。',
    steps: [
      '读取目标、计划与工作项授权',
      '在独立 worktree 内先读后写，写操作前经工具网关',
      '运行类型检查与相关测试，记录失败原因',
      '把改动提交到自有分支，登记产物供验证使用',
    ],
    boundaries: ['不读取密钥', '不合并 PR', '不越出授权的仓库、分支与路径', '不修改授权外的文件'],
  },
  verifier: {
    role: 'verifier',
    name: '验证者',
    objective: '独立判断工作项是否满足验收标准，不采信实现者的自评。',
    steps: [
      '只读取目标、改动差异、验收标准与已有证据',
      '逐条核对验收标准，必要时运行命令复现',
      '记录命令、输出摘要、环境、时间与哈希',
      '给出通过 / 不通过 / 无法判定，并说明理由',
    ],
    boundaries: ['不复用实现者会话', '不修改实现', '不自行降低验收标准'],
  },
};

export interface RoleInstance {
  id: string;
  goalId: string;
  workItemId: string;
  role: AgentRole;
  subject: string;
  grantId: string;
  actions: Action[];
  scope: GrantScope;
  maxTokens?: number;
  playbook: RolePlaybook;
}

export interface InstantiateRoleInput {
  goalId: string;
  workItemId: string;
  actor?: string;
}

function approvedPlan(db: DatabaseSync, goalId: string): Plan | undefined {
  return listPlansForGoal(db, goalId)
    .filter((plan) => plan.status === 'approved')
    .at(-1);
}

/**
 * 按工作项契约装载角色实例。
 *
 * 装载前校验三件事：
 * 1. 目标处于执行/验证阶段，且计划已批准；
 * 2. 工作项有活跃授权；
 * 3. 授权里的每个动作都在角色能力上限内，范围也覆盖目标仓库。
 *
 * 这样"角色能力与其 Grant 一致"不是约定，而是装载时的硬校验。
 */
export function instantiateRole(
  db: DatabaseSync,
  input: InstantiateRoleInput,
  now = new Date(),
): RoleInstance {
  const goal = getGoalOrThrow(db, input.goalId);
  if (goal.status !== 'executing' && goal.status !== 'verifying') {
    throw new Error(`目标当前状态不能实例化角色：${goal.status}`);
  }

  const plan = approvedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能实例化角色');

  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  const grant = listGrantsForGoal(db, goal.id).find(
    (candidate) => candidate.workItemId === item.id && candidate.status === 'active',
  );
  if (!grant) throw new Error(`工作项 ${item.id} 没有有效授权，不能实例化角色`);
  if (grant.role !== item.role) {
    throw new Error(`工作项 ${item.id} 的角色 ${item.role} 与授权角色 ${grant.role} 不一致`);
  }

  for (const action of grant.actions) {
    if (!isActionAllowedForRole(item.role, action)) {
      throw new Error(`授权动作 ${action} 超出角色 ${item.role} 的能力上限（工作项：${item.id}）`);
    }
  }
  if (!grant.scope.repos.includes(goal.repo)) {
    throw new Error(`工作项 ${item.id} 的授权范围不包含目标仓库 ${goal.repo}`);
  }

  const playbook = ROLE_PLAYBOOKS[item.role];
  const instance: RoleInstance = {
    id: `role:${goal.id.slice(0, 8)}-${item.id}`,
    goalId: goal.id,
    workItemId: item.id,
    role: item.role,
    subject: grant.subject,
    grantId: grant.id,
    actions: grant.actions,
    scope: grant.scope,
    maxTokens: grant.constraints.maxTokens,
    playbook,
  };

  appendAudit(
    db,
    {
      actor: input.actor ?? 'system',
      type: 'role.instantiated',
      goalId: goal.id,
      subject: grant.subject,
      payload: {
        role: item.role,
        workItemId: item.id,
        grantId: grant.id,
        actions: grant.actions,
      },
    },
    now.toISOString(),
  );

  return instance;
}