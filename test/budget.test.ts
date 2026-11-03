import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extendBudget, getBudgetStatus, recordTokenUsage } from '../src/app/budget.ts';
import { getGoalOrThrow, resumeGoal } from '../src/app/goals.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { listEscalations } from '../src/infra/store.ts';
import { setupApproved } from './helpers.ts';

test('预算内累计 token 用量，不改变目标状态', () => {
  const { db, goal } = setupApproved();

  recordTokenUsage(db, {
    goalId: goal.id,
    workItemId: 'build',
    source: 'builder_run',
    tokens: 1200,
  });
  const status = recordTokenUsage(db, {
    goalId: goal.id,
    workItemId: 'build',
    source: 'builder_run',
    tokens: 300,
  });

  assert.deepEqual(status.status, {
    budgetTokens: 2000,
    usedTokens: 1500,
    remainingTokens: 500,
    exhausted: false,
  });
  assert.equal(status.paused, false);
  assert.equal(status.escalation, undefined);
  assert.equal(getGoalOrThrow(db, goal.id).status, 'executing');
  assert.equal(
    listAuditEvents(db, goal.id).filter((event) => event.type === 'budget.consumed').length,
    2,
  );
});

test('预算耗尽暂停目标并创建一个 spend.tokens 升级', () => {
  const { db, goal } = setupApproved();

  recordTokenUsage(db, { goalId: goal.id, source: 'builder_run', tokens: 1500 });
  const exhausted = recordTokenUsage(db, { goalId: goal.id, source: 'builder_run', tokens: 600 });

  assert.equal(exhausted.status.exhausted, true);
  assert.equal(exhausted.status.remainingTokens, 0);
  assert.equal(exhausted.paused, true);
  assert.equal(getGoalOrThrow(db, goal.id).status, 'paused');
  assert.equal(getGoalOrThrow(db, goal.id).pausedFrom, 'executing');
  assert.equal(getBudgetStatus(db, goal.id).usedTokens, 2100);

  const pending = listEscalations(db, 'pending').filter((item) => item.goalId === goal.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.action, 'spend.tokens');
  assert.equal(exhausted.escalation?.id, pending[0]?.id);

  const again = recordTokenUsage(db, { goalId: goal.id, source: 'other', tokens: 10 });
  assert.equal(again.paused, false);
  assert.equal(again.escalation?.id, pending[0]?.id);
  assert.equal(
    listAuditEvents(db, goal.id).filter((event) => event.type === 'goal.paused').length,
    1,
  );
  assert.equal(
    listEscalations(db, 'pending').filter((item) => item.goalId === goal.id).length,
    1,
  );
});

test('追加预算后可恢复执行，验证不受预算限制', () => {
  const { db, goal } = setupApproved();
  recordTokenUsage(db, { goalId: goal.id, source: 'builder_run', tokens: 2100 });
  assert.equal(getGoalOrThrow(db, goal.id).status, 'paused');

  const extended = extendBudget(db, goal.id, 500, 'human-1');
  assert.equal(extended.budgetTokens, 2500);

  const resumed = resumeGoal(db, goal.id, 'human-1', '已追加预算');
  assert.equal(resumed.to, 'executing');
  assert.deepEqual(getBudgetStatus(db, goal.id), {
    budgetTokens: 2500,
    usedTokens: 2100,
    remainingTokens: 400,
    exhausted: false,
  });

  assert.throws(
    () => recordTokenUsage(db, { goalId: goal.id, source: 'other', tokens: 0 }),
    /必须是正数/,
  );
  assert.throws(() => extendBudget(db, goal.id, -1, 'human-1'), /必须是正数/);
});