import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendAudit, listAuditEvents, verifyAuditChain } from '../src/infra/audit.ts';
import { createTestDb, createTestGoal } from './helpers.ts';

test('空库的审计链通过校验', () => {
  const db = createTestDb();
  assert.deepEqual(verifyAuditChain(db), { ok: true, checked: 0 });
});

test('追加事件后链条连续，校验计数正确', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);

  assert.equal(verifyAuditChain(db).ok, true);
  const events = listAuditEvents(db, goal.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'goal.created');
  assert.equal(events[0]?.prevHash, '');
  assert.equal(verifyAuditChain(db).checked, 1);
});

test('篡改载荷会被审计链发现', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  appendAudit(db, { actor: 'architect', type: 'goal.updated', goalId: goal.id });

  const events = listAuditEvents(db);
  const first = events[0];
  assert.ok(first);
  db.prepare('UPDATE audit SET payload = ? WHERE id = ?').run(JSON.stringify({ hacked: true }), first.id);

  const result = verifyAuditChain(db);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, first.id);
});

test('删除中间事件会立刻断开链条', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  appendAudit(db, { actor: 'architect', type: 'goal.updated', goalId: goal.id });
  appendAudit(db, { actor: 'architect', type: 'goal.updated', goalId: goal.id });

  const events = listAuditEvents(db);
  const middle = events[1];
  assert.ok(middle);
  db.prepare('DELETE FROM audit WHERE id = ?').run(middle.id);

  const result = verifyAuditChain(db);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, events[2]?.id);
});