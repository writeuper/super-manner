import type { DatabaseSync } from 'node:sqlite';
import { isActionAllowedForRole } from '../domain/actions.ts';
import type { AgentRole, PlaybookContent } from '../domain/playbook.ts';
import type { Action, GrantScope } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { listGrantsForGoal } from '../infra/store.ts';
import { assertDependenciesComplete } from './dependencies.ts';
import { getGoalOrThrow } from './goals.ts';
import { ROLE_PLAYBOOKS } from './playbook-defaults.ts';
import { resolvePlaybook } from './playbooks.ts';
import { getApprovedPlan } from './plans.ts';

/** P0 只有三种执行角色的工作项；架构师负责目标与批准，不进入执行。 */
export type { AgentRole };

export type RolePlaybook = PlaybookContent;

export { ROLE_PLAYBOOKS };

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
  playbookVersionId?: string;
  playbookVersion?: number;
  playbookChannel: 'builtin' | 'stable' | 'canary';
}

export interface InstantiateRoleInput {
  goalId: string;
  workItemId: string;
  actor?: string;
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

  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能实例化角色');

  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  assertDependenciesComplete(db, goal.id, item, plan.workItems);

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

  const resolved = resolvePlaybook(db, item.role, item.id);
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
    playbook: resolved.content,
    ...(resolved.version === undefined
      ? {}
      : { playbookVersionId: resolved.version.id, playbookVersion: resolved.version.version }),
    playbookChannel: resolved.channel,
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
        playbookVersionId: instance.playbookVersionId ?? null,
        playbookChannel: instance.playbookChannel,
      },
    },
    now.toISOString(),
  );

  return instance;
}