import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEscalation, decideEscalation, sweepExpiredEscalations } from '../src/app/escalations.ts';
import { requestAction } from '../src/app/gateway.ts';
import { cancelGoal, createGoal } from '../src/app/goals.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { getGoal, listEscalations, listGrantsForGoal } from '../src/infra/store.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestDb,
  createTestGoal,
  defaultGoal,
  defaultPlan,
  setupApproved,
  submitDefaultPlan,
  verifierItem,
} from './helpers.ts';

test('缺少验收标准时只能保存草稿并列出缺失项', () => {
  const db = createTestDb();
  const goal = createGoal(db, defaultGoal({ acceptance: [] }), 'architect');

  assert.equal(goal.status, 'draft');
  assert.ok(goal.missing.includes('缺少验收标准'));
  assert.throws(() => submitDefaultPlan(db, goal.id), /目标信息不完整/);
});

test('计划预算超过目标预算时不能提交', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  assert.throws(
    () => submitPlan(db, goal.id, defaultPlan({ totalBudgetTokens: 3000 }), 'planner'),
    /超过目标预算/,
  );
  assert.equal(getGoal(db, goal.id)?.status, 'draft');
});

test('批准前重新校验预算，被篡改的计划不能批准', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitDefaultPlan(db, goal.id);

  const tampered = plan.workItems.map((item) => ({ ...item, budgetTokens: 5000 }));
  db.prepare('UPDATE plans SET work_items = ? WHERE id = ?').run(JSON.stringify(tampered), plan.id);

  assert.throws(() => approvePlan(db, plan.id, 'architect'), /超过计划预算/);
  assert.equal(listGrantsForGoal(db, goal.id).length, 0);
});

test('计划存在未决事项时不能批准', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(db, goal.id, defaultPlan({ pendingDecisions: ['是否允许修改 CI 配置'] }), 'planner');

  assert.throws(() => approvePlan(db, plan.id, 'architect'), /未决事项/);
  assert.equal(listGrantsForGoal(db, goal.id).length, 0);
});

test('批准计划之后才签发授权', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitDefaultPlan(db, goal.id);

  assert.equal(listGrantsForGoal(db, goal.id).length, 0);
  approvePlan(db, plan.id, 'architect');

  const grants = listGrantsForGoal(db, goal.id);
  assert.ok(grants.some((item) => item.subject === `goal:${goal.id}`));
  assert.ok(grants.some((item) => item.subject === BUILDER));
  assert.ok(grants.some((item) => item.subject === verifierItem().grant.subject));
  assert.equal(getGoal(db, goal.id)?.status, 'executing');
});

test('自治级别不足时拒绝签发，而不是降级放行', () => {
  const db = createTestDb();
  const goal = createTestGoal(db, { autonomy: 'A1' });
  const plan = submitPlan(db, goal.id, defaultPlan({ workItems: [builderItem()], totalBudgetTokens: 1000 }), 'planner');

  assert.throws(() => approvePlan(db, plan.id, 'architect'), /自治级别 A1 不允许动作/);
  assert.equal(listGrantsForGoal(db, goal.id).length, 0);
});

test('角色能力上限阻止 Builder 申请合并', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const item = builderItem({
    grant: { subject: BUILDER, actions: ['repo.read', 'pr.merge'], scope: { repos: [REPO] } },
  });
  const plan = submitPlan(db, goal.id, defaultPlan({ workItems: [item], totalBudgetTokens: 1000 }), 'planner');

  assert.throws(() => approvePlan(db, plan.id, 'architect'), /角色 builder 无权执行 pr.merge/);
});

test('授权内写入放行，未授予的合并直接拒绝且不出卡', () => {
  const { db, goal } = setupApproved();

  const write = requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.write',
    resource: { repo: REPO, branch: 'feature/sm-1', path: 'src/login.ts' },
  });
  assert.equal(write.outcome, 'allowed');

  const merge = requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'pr.merge',
    resource: { repo: REPO },
  });
  assert.equal(merge.outcome, 'denied');
  assert.equal(listEscalations(db, 'pending').length, 0);
});

test('推送非自有分支触发升级，批准后仅一次有效', () => {
  const { db, goal } = setupApproved();
  const push = {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.push' as const,
    resource: { repo: REPO, branch: 'main' },
  };

  const first = requestAction(db, push);
  assert.equal(first.outcome, 'escalated');
  const firstEscalation = first.escalationId;
  assert.ok(firstEscalation);

  // 同一请求在待处理期间不会重复出卡。
  const duplicated = requestAction(db, push);
  assert.equal(duplicated.outcome, 'escalated');
  assert.equal(duplicated.escalationId, firstEscalation);

  decideEscalation(db, firstEscalation, { approver: 'architect', approve: true });

  const second = requestAction(db, push);
  assert.equal(second.outcome, 'allowed');
  assert.equal(second.oneTime, true);

  // 通行证消费后回到升级，而不是永久放行。
  const third = requestAction(db, push);
  assert.equal(third.outcome, 'escalated');
  assert.notEqual(third.escalationId, firstEscalation);
});

test('Builder 读取密钥无资格，直接拒绝且不出卡', () => {
  const { db, goal } = setupApproved();
  const result = requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'secret.read',
    resource: { repo: REPO, key: 'DEPLOY_KEY' },
  });

  assert.equal(result.outcome, 'denied');
  assert.equal(listEscalations(db, 'pending').length, 0);
});

test('需要第二人确认的动作缺少第二人时不能批准', () => {
  const { db, goal } = setupApproved();
  const escalation = createEscalation(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'pr.merge',
    resource: { repo: REPO, prNumber: 12 },
    reason: '合并前需要双人确认',
  });

  assert.equal(escalation.requiresSecond, true);
  assert.throws(() => decideEscalation(db, escalation.id, { approver: 'architect', approve: true }), /第二人/);
  assert.throws(
    () => decideEscalation(db, escalation.id, { approver: 'architect', approve: true, secondApprover: 'architect' }),
    /不能与第一人相同/,
  );

  const approved = decideEscalation(db, escalation.id, {
    approver: 'architect',
    approve: true,
    secondApprover: 'reviewer-2',
  });
  assert.equal(approved.status, 'approved');
});

test('升级超时转为阻塞且不放行', () => {
  const { db, goal } = setupApproved();
  const now = new Date();
  const push = {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.push' as const,
    resource: { repo: REPO, branch: 'main' },
  };

  const pending = requestAction(db, push, { now, escalationTtlMs: 1000 });
  assert.equal(pending.outcome, 'escalated');
  const pendingEscalation = pending.escalationId;
  assert.ok(pendingEscalation);

  const expired = sweepExpiredEscalations(db, new Date(now.getTime() + 2000));
  assert.equal(expired, 1);
  assert.equal(getGoal(db, goal.id)?.status, 'blocked');
  assert.throws(() => decideEscalation(db, pendingEscalation, { approver: 'architect', approve: true }), /已处理/);

  const after = requestAction(db, push);
  assert.equal(after.outcome, 'denied');
});

test('取消目标后所有授权失效', () => {
  const { db, goal } = setupApproved();
  const before = requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.read',
    resource: { repo: REPO },
  });
  assert.equal(before.outcome, 'allowed');

  cancelGoal(db, goal.id, 'architect');

  assert.ok(listGrantsForGoal(db, goal.id).every((item) => item.status === 'revoked'));
  const after = requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.read',
    resource: { repo: REPO },
  });
  assert.equal(after.outcome, 'denied');
});

test('审计链能还原每个决定并通过校验', () => {
  const { db, goal } = setupApproved();

  requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.write',
    resource: { repo: REPO, branch: 'feature/sm-1', path: 'src/login.ts' },
  });
  requestAction(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'repo.push',
    resource: { repo: REPO, branch: 'main' },
  });

  const types = new Set(listAuditEvents(db, goal.id).map((event) => event.type));
  for (const expected of ['goal.created', 'plan.submitted', 'grants.issued', 'auth.allowed', 'auth.escalated']) {
    assert.ok(types.has(expected), `缺少审计事件：${expected}`);
  }
});