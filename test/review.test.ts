import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordTokenUsage } from '../src/app/budget.ts';
import { createEscalation, decideEscalation } from '../src/app/escalations.ts';
import { requestAction } from '../src/app/gateway.ts';
import { getGoalOrThrow, pauseGoal, resumeGoal } from '../src/app/goals.ts';
import { buildReview, generateReview } from '../src/app/review.ts';
import { appendAudit, listAuditEvents, verifyAuditChain } from '../src/infra/audit.ts';
import { BUILDER, REPO, setupApproved } from './helpers.ts';

test('复盘按偏差、介入、拒绝、升级与失败汇总审计', () => {
  const { db, goal } = setupApproved();

  recordTokenUsage(db, { goalId: goal.id, source: 'other', tokens: 500 });
  pauseGoal(db, goal.id, 'human-1', '等待确认');
  resumeGoal(db, goal.id, 'human-1', '确认完成');

  const denied = requestAction(db, {
    action: 'repo.write',
    subject: 'stranger',
    goalId: goal.id,
    resource: { repo: REPO, branch: 'feature/x', path: 'src/login.ts' },
  });
  assert.equal(denied.outcome, 'denied');

  const escalation = createEscalation(db, {
    goalId: goal.id,
    subject: BUILDER,
    action: 'pr.merge',
    resource: { repo: REPO },
    reason: '需要合并 PR',
  });
  decideEscalation(db, escalation.id, {
    approver: 'human-1',
    approve: false,
    reason: '先补测试',
    secondApprover: 'human-2',
  });

  appendAudit(db, {
    actor: BUILDER,
    type: 'builder.run_finished',
    goalId: goal.id,
    payload: {
      workItemId: 'build',
      status: 'failed',
      failureKind: 'implementation',
      causeKey: 'agent:failed',
    },
  });
  appendAudit(db, {
    actor: 'verifier-1',
    type: 'verifier.verdicts_recorded',
    goalId: goal.id,
    payload: {
      workItemId: 'build',
      summary: { total: 2, passed: 1, failed: 1, undetermined: 0 },
    },
  });

  const before = listAuditEvents(db, goal.id).length;
  const review = buildReview(db, goal.id);

  assert.deepEqual(review.budget, { budgetTokens: 2000, usedTokens: 500, remainingTokens: 1500 });
  assert.equal(review.status, 'executing');
  assert.ok(review.deviations.some((entry) => entry.type === 'goal.paused'));
  assert.ok(review.interventions.some((entry) => entry.type === 'goal.resumed'));
  assert.ok(review.denials.some((entry) => entry.type === 'auth.denied'));
  assert.ok(review.denials.some((entry) => entry.type === 'escalation.denied'));
  assert.ok(review.failures.some((entry) => entry.summary.includes('implementation')));
  assert.ok(review.failures.some((entry) => entry.summary.includes('判定未通过')));
  assert.deepEqual(
    review.escalations.map((item) => [item.action, item.status, item.decisionReason]),
    [['pr.merge', 'denied', '先补测试']],
  );
  assert.match(review.notes.join(''), /不生成改进提案/);

  assert.equal(listAuditEvents(db, goal.id).length, before);
});

test('生成复盘只追加审计，不修改目标状态', () => {
  const { db, goal } = setupApproved();
  recordTokenUsage(db, { goalId: goal.id, source: 'other', tokens: 200 });
  const updatedAt = getGoalOrThrow(db, goal.id).updatedAt;

  const review = generateReview(db, goal.id, 'human-1');

  assert.equal(review.goalId, goal.id);
  assert.equal(review.budget.usedTokens, 200);
  assert.equal(getGoalOrThrow(db, goal.id).updatedAt, updatedAt);
  assert.equal(getGoalOrThrow(db, goal.id).status, 'executing');

  const generated = listAuditEvents(db, goal.id).filter((event) => event.type === 'review.generated');
  assert.equal(generated.length, 1);
  assert.equal((generated[0]?.payload as { goalId: string }).goalId, goal.id);
  assert.equal(verifyAuditChain(db).ok, true);
});

test('不存在的目标不能生成复盘', () => {
  const { db } = setupApproved();
  assert.throws(() => buildReview(db, 'missing'), /目标不存在/);
});