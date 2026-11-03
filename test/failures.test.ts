import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessBuilderRetry,
  classifyRunFailure,
  classifyVerdicts,
  recoveryFor,
  type FailureKind,
} from '../src/app/retries.ts';
import { appendAudit } from '../src/infra/audit.ts';
import { BUILDER, setupApproved } from './helpers.ts';

test('运行失败分为实现、环境与外部三类', () => {
  assert.deepEqual(classifyRunFailure('failed', [], 'AssertionError: 期望登录失败提示'), {
    failureKind: 'implementation',
    causeKey: 'agent:failed',
  });
  assert.deepEqual(classifyRunFailure('timed_out', []), {
    failureKind: 'environment',
    causeKey: 'agent:timed_out',
  });
  assert.deepEqual(classifyRunFailure('failed', [], 'Error: stream disconnected before completion'), {
    failureKind: 'environment',
    causeKey: 'agent:environment',
  });
  assert.deepEqual(classifyRunFailure('failed', [], 'HTTP 401 Unauthorized: invalid api key'), {
    failureKind: 'external',
    causeKey: 'agent:external',
  });
  assert.equal(classifyRunFailure('succeeded', []), undefined);
});

test('自检不通过属于实现失败，自检无法运行属于环境失败', () => {
  assert.deepEqual(classifyRunFailure('succeeded', [{ name: 'test', status: 'failed' }]), {
    failureKind: 'implementation',
    causeKey: 'self-check:test',
  });
  assert.deepEqual(classifyRunFailure('succeeded', [{ name: 'test', status: 'timed_out' }]), {
    failureKind: 'environment',
    causeKey: 'self-check:test:timed_out',
  });
});

test('判定不通过归为实现问题，只有无法判定才归为验证问题', () => {
  assert.equal(
    classifyVerdicts([{ result: 'passed' }, { result: 'passed' }]),
    undefined,
  );
  assert.equal(
    classifyVerdicts([{ result: 'passed' }, { result: 'undetermined' }]),
    'verification',
  );
  assert.equal(
    classifyVerdicts([{ result: 'undetermined' }, { result: 'failed' }]),
    'implementation',
  );
});

test('恢复策略只有实现失败消耗实现者重试次数', () => {
  const kinds: FailureKind[] = ['implementation', 'verification', 'environment', 'external'];
  assert.deepEqual(
    kinds.map((kind) => {
      const strategy = recoveryFor(kind);
      return [kind, strategy.countsAgainstImplementer, strategy.action];
    }),
    [
      ['implementation', true, 'retry'],
      ['verification', false, 'rework'],
      ['environment', false, 'retry'],
      ['external', false, 'escalate'],
    ],
  );
});

test('环境与外部失败不计入实现者次数，也不打断同因计数', () => {
  const { db, goal } = setupApproved();
  const workItemId = 'build';
  const record = (failureKind: FailureKind, causeKey: string) => {
    appendAudit(db, {
      actor: BUILDER,
      type: 'builder.run_finished',
      goalId: goal.id,
      payload: { workItemId, status: 'failed', failureKind, causeKey },
    });
  };

  record('implementation', 'agent:failed');
  record('external', 'agent:external');
  record('environment', 'agent:environment');

  const first = assessBuilderRetry(db, goal.id, workItemId);
  assert.equal(first.sameCauseFailures, 1);
  assert.equal(first.blocked, false);

  record('implementation', 'agent:failed');
  const blocked = assessBuilderRetry(db, goal.id, workItemId);
  assert.equal(blocked.sameCauseFailures, 2);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason ?? '', /转人工/);
});