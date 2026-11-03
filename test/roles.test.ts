import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instantiateRole } from '../src/app/roles.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { listGrantsForGoal, revokeGrantsForGoal } from '../src/infra/store.ts';
import { builderItem, createTestDb, createTestGoal, setupApproved } from './helpers.ts';

test('装载 builder 时能力与授权一致', () => {
  const { db, goal } = setupApproved();

  const instance = instantiateRole(db, { goalId: goal.id, workItemId: 'build' });

  assert.equal(instance.role, 'builder');
  assert.equal(instance.subject, 'builder-1');
  assert.deepEqual(instance.actions, builderItem().grant.actions);
  assert.deepEqual(instance.scope.repos, ['acme/demo']);
  assert.equal(instance.playbook.role, 'builder');
  assert.ok(instance.playbook.steps.length > 0);

  const events = listAuditEvents(db, goal.id).filter((event) => event.type === 'role.instantiated');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, 'builder-1');
});

test('装载 verifier 时读取自己的授权', () => {
  const { db, goal } = setupApproved();

  const instance = instantiateRole(db, { goalId: goal.id, workItemId: 'verify' });

  assert.equal(instance.role, 'verifier');
  assert.equal(instance.subject, 'verifier-1');
  assert.deepEqual(instance.actions, ['repo.read', 'pr.review', 'ci.rerun']);
});

test('授权动作超出角色上限时拒绝装载', () => {
  const { db, goal } = setupApproved();
  const grant = listGrantsForGoal(db, goal.id).find((candidate) => candidate.workItemId === 'build');
  assert.ok(grant);

  // 模拟脏数据：绕过签发校验把越权动作塞进授权。
  db.prepare('UPDATE grants SET actions = ? WHERE id = ?').run(
    JSON.stringify([...grant.actions, 'pr.merge']),
    grant.id,
  );

  assert.throws(
    () => instantiateRole(db, { goalId: goal.id, workItemId: 'build' }),
    /超出角色 builder 的能力上限/,
  );
});

test('授权被吊销后不能装载角色', () => {
  const { db, goal } = setupApproved();
  revokeGrantsForGoal(db, goal.id, new Date().toISOString(), '测试');

  assert.throws(
    () => instantiateRole(db, { goalId: goal.id, workItemId: 'build' }),
    /没有有效授权/,
  );
});

test('计划未经批准不能装载角色', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);

  assert.throws(
    () => instantiateRole(db, { goalId: goal.id, workItemId: 'build' }),
    /不能实例化角色/,
  );
});

test('不存在的工作项不能装载角色', () => {
  const { db, goal } = setupApproved();

  assert.throws(
    () => instantiateRole(db, { goalId: goal.id, workItemId: 'nope' }),
    /工作项不存在/,
  );
});