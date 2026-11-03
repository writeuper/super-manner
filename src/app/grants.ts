import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isActionAllowedForRole } from '../domain/actions.ts';
import { assertAttenuated, autonomyAllows } from '../domain/policy.ts';
import type { Goal, Grant, GrantConstraints, GrantSpec, Plan } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { insertGrants } from '../infra/store.ts';

/**
 * 从已批准的计划签发授权。
 *
 * 两级结构：
 * - 根授权：subject 为 goal:<id>，代表目标本身的完整范围，用于衰减校验。
 * - 工作项授权：subject 为角色实例，只能比根授权更窄。
 */
export function issueGrantsForPlan(
  db: DatabaseSync,
  goal: Goal,
  plan: Plan,
  issuerId: string,
  now = new Date(),
): Grant[] {
  const at = now.toISOString();
  const actions = [...new Set(plan.workItems.flatMap((item) => item.grant.actions))];

  const rootSpec: GrantSpec = {
    actions,
    scope: { repos: [goal.repo] },
    constraints: { maxTokens: goal.budgetTokens },
  };
  const rootConstraints: GrantConstraints = rootSpec.constraints ?? {};

  const root: Grant = {
    id: randomUUID(),
    goalId: goal.id,
    subject: `goal:${goal.id}`,
    role: 'architect',
    actions: rootSpec.actions,
    scope: rootSpec.scope,
    constraints: rootConstraints,
    issuerId,
    status: 'active',
    createdAt: at,
  };

  const issued: Grant[] = [root];

  for (const item of plan.workItems) {
    for (const action of item.grant.actions) {
      if (!isActionAllowedForRole(item.role, action)) {
        throw new Error(`角色 ${item.role} 无权执行 ${action}（工作项：${item.id}）`);
      }
      if (!autonomyAllows(goal.autonomy, action)) {
        throw new Error(`自治级别 ${goal.autonomy} 不允许动作 ${action}（工作项：${item.id}）`);
      }
    }

    try {
      assertAttenuated(rootSpec, item.grant);
    } catch (error) {
      throw new Error(`工作项 ${item.id} 的授权范围越界：${(error as Error).message}`);
    }

    issued.push({
      id: randomUUID(),
      goalId: goal.id,
      workItemId: item.id,
      subject: item.grant.subject ?? `${item.role}-${item.id}`,
      role: item.role,
      actions: item.grant.actions,
      scope: item.grant.scope,
      constraints: item.grant.constraints ?? {},
      parentGrantId: root.id,
      issuerId,
      status: 'active',
      createdAt: at,
      expiresAt: item.grant.constraints?.expiresAt,
    });
  }

  insertGrants(db, issued);
  appendAudit(
    db,
    {
      actor: issuerId,
      type: 'grants.issued',
      goalId: goal.id,
      payload: {
        planId: plan.id,
        grants: issued.map((grant) => ({ id: grant.id, subject: grant.subject, actions: grant.actions })),
      },
    },
    at,
  );

  return issued;
}