import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listInbox, queryTimeline } from '../src/app/audit-query.ts';
import { createEscalation } from '../src/app/escalations.ts';
import { requestAction } from '../src/app/gateway.ts';
import { getGoalOrThrow, setGoalStatus } from '../src/app/goals.ts';
import { appendAudit, listAuditEvents } from '../src/infra/audit.ts';
import { approvePlan } from '../src/app/plans.ts';
import {
  BUILDER,
  REPO,
  createTestGoal,
  setupApproved,
  submitDefaultPlan,
} from './helpers.ts';

test('时间线可按目标、人、动作过滤并保留时间顺序', () => {
  const { db, goal } = setupApproved();
  const otherGoal = createTestGoal(db);

  appendAudit(db, {
    actor: BUILDER,
    type: 'builder.run_finished',
    goalId: goal.id,
    payload: { workItemId: 'build', status: 'failed' },
  });
  appendAudit(db, { actor: 'human-1', type: 'plan.approved', goalId: goal.id });
  requestAction(db, {
    action: 'repo.write',
    subject: 'stranger',
    goalId: goal.id,
    resource: { repo: REPO, branch: 'feature/x', path: 'src/login.ts' },
  });
  appendAudit(db, { actor: 'human-1', type: 'note', goalId: otherGoal.id });

  const byGoal = queryTimeline(db, { goalId: goal.id });
  assert.ok(byGoal.length > 0);
  assert.ok(byGoal.every((event) => event.goalId === goal.id));

  const byActor = queryTimeline(db, { goalId: goal.id, actor: 'human-1' });
  assert.equal(byActor.length, 1);
  assert.equal(byActor[0]?.type, 'plan.approved');

  const byPayloadAction = queryTimeline(db, { goalId: goal.id, action: 'repo.write' });
  assert.equal(byPayloadAction.length, 1);
  assert.equal(byPayloadAction[0]?.type, 'auth.denied');

  const byType = queryTimeline(db, { goalId: goal.id, action: 'builder.run_finished' });
  assert.equal(byType.length, 1);

  const recent = queryTimeline(db, { goalId: goal.id, limit: 2 });
  assert.equal(recent.length, 2);
  assert.equal(recent[1]?.type, 'auth.denied');
  assert.ok((recent[0]?.at ?? '') <= (recent[1]?.at ?? ''));
});

test('待我处理队列汇总待审计划、待裁决升级与待验收目标', () => {
  const { db, goal } = setupApproved();

  const draftGoal = createTestGoal(db);
  submitDefaultPlan(db, draftGoal.id);

  const escalation = createEscalation(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'pr.merge',
    resource: { repo: REPO },
    reason: '需要合并 PR',
  });

  const acceptanceGoal = createTestGoal(db);
  const acceptedPlan = submitDefaultPlan(db, acceptanceGoal.id);
  approvePlan(db, acceptedPlan.id, 'architect');
  let current = getGoalOrThrow(db, acceptanceGoal.id);
  current = setGoalStatus(db, current, 'verifying', 'verifier-1');
  setGoalStatus(db, current, 'awaiting_acceptance', 'verifier-1');

  const before = listAuditEvents(db).length;
  const inbox = listInbox(db);
  assert.deepEqual(
    inbox.map((item) => item.kind).sort(),
    ['acceptance', 'escalation', 'plan_review'],
  );

  const planItems = listInbox(db, { action: 'plan_review' });
  assert.deepEqual(planItems.map((item) => item.goalId), [draftGoal.id]);

  const escalationItems = listInbox(db, { action: 'pr.merge' });
  assert.equal(escalationItems.length, 1);
  assert.equal(escalationItems[0]?.reason, '需要合并 PR');
  assert.equal(escalationItems[0]?.requiresSecond, true);

  assert.deepEqual(
    listInbox(db, { action: 'acceptance' }).map((item) => item.goalId),
    [acceptanceGoal.id],
  );
  assert.equal(listInbox(db, { goalId: acceptanceGoal.id }).length, 1);

  assert.equal(listAuditEvents(db).length, before);
  assert.equal(escalation.status, 'pending');
});

test('过期升级不进入待办队列', () => {
  const { db, goal } = setupApproved();
  createEscalation(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'pr.merge',
    resource: { repo: REPO },
    reason: '需要合并 PR',
  });

  assert.equal(listInbox(db).length, 1);
  assert.equal(listInbox(db, {}, new Date(Date.now() + 48 * 60 * 60 * 1000)).length, 0);
});