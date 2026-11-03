import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideAcceptance } from '../src/app/acceptance.ts';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { getGoalOrThrow, setGoalStatus } from '../src/app/goals.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { listGrantsForGoal } from '../src/infra/store.ts';
import { builderItem, createTestDb, createTestGoal, createTestRepo } from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const ACCEPTANCE = ['错误密码时展示提示文案', '不泄露账号是否存在'];
const DOD = ['改动通过类型检查', '覆盖失败路径'];

class FakeExecutor implements Executor {
  readonly name = 'fake';
  private readonly handler: (request: ExecutorRequest) => Partial<ExecutorResult>;

  constructor(handler: (request: ExecutorRequest) => Partial<ExecutorResult> = () => ({})) {
    this.handler = handler;
  }

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    return {
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      ...this.handler(request),
    };
  }
}

function singleItemPlan(): { db: ReturnType<typeof createTestDb>; goalId: string } {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(db, goal.id, { workItems: [builderItem()], totalBudgetTokens: 1000 }, 'planner');
  approvePlan(db, plan.id, 'architect');
  return { db, goalId: goal.id };
}

async function verifiedBuild(db: ReturnType<typeof createTestDb>, goalId: string, pass = true): Promise<void> {
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor((request) => {
      if (request.command === 'fake-agent') {
        writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
      }
      return {};
    }),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  await collectEvidence(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [...ACCEPTANCE, ...DOD].map((criterion) => ({
      criterion,
      result: (pass ? 'passed' : 'failed') as 'passed' | 'failed',
      note: pass ? '复核通过' : '未满足标准',
    })),
  });
}

test('接受后目标完成、授权全部失效且不能再操作', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId);
  const before = listGrantsForGoal(db, goalId);
  assert.ok(before.length > 0);
  assert.ok(before.every((grant) => grant.status === 'active'));
  setGoalStatus(db, getGoalOrThrow(db, goalId), 'verifying', 'verifier-1');

  const record = decideAcceptance(db, { goalId, decision: 'accept', actor: 'human-1' });

  assert.equal(record.goalStatus, 'completed');
  assert.equal(record.complete, true);
  assert.equal(record.revokedGrants, before.length);
  assert.ok(listGrantsForGoal(db, goalId).every((grant) => grant.status === 'revoked'));

  const types = listAuditEvents(db, goalId).map((event) => event.type);
  assert.ok(types.includes('goal.status_changed'));
  assert.ok(types.includes('grants.revoked'));
  assert.ok(types.includes('acceptance.decided'));

  assert.throws(
    () => decideAcceptance(db, { goalId, decision: 'accept', actor: 'human-1' }),
    /不能做验收决定/,
  );
});

test('完成判定未通过时不能接受', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId, false);
  setGoalStatus(db, getGoalOrThrow(db, goalId), 'verifying', 'verifier-1');

  assert.throws(
    () => decideAcceptance(db, { goalId, decision: 'accept', actor: 'human-1' }),
    /完成判定未通过/,
  );
  assert.equal(getGoalOrThrow(db, goalId).status, 'verifying');
});

test('返工回到执行态，历史结论保留并可产生新 Run', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId, false);
  setGoalStatus(db, getGoalOrThrow(db, goalId), 'verifying', 'verifier-1');

  assert.throws(
    () => decideAcceptance(db, { goalId, decision: 'rework', actor: 'human-1' }),
    /必须说明原因/,
  );

  const record = decideAcceptance(db, {
    goalId,
    decision: 'rework',
    reason: '补充账号枚举测试',
    actor: 'human-1',
  });
  assert.equal(record.goalStatus, 'executing');
  assert.equal(getGoalOrThrow(db, goalId).status, 'executing');

  const failedVerdicts = listAuditEvents(db, goalId).filter(
    (event) => event.type === 'verifier.verdicts_recorded',
  );
  assert.equal(failedVerdicts.length, 1);

  await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor((request) => {
      if (request.command === 'fake-agent') {
        writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = false;\n');
      }
      return {};
    }),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.run_started').length,
    2,
  );
});

test('关闭目标会取消并吊销授权', async () => {
  const { db, goalId } = singleItemPlan();
  await verifiedBuild(db, goalId);
  setGoalStatus(db, getGoalOrThrow(db, goalId), 'verifying', 'verifier-1');

  const record = decideAcceptance(db, {
    goalId,
    decision: 'close',
    reason: '需求取消',
    actor: 'human-1',
  });

  assert.equal(record.goalStatus, 'cancelled');
  assert.equal(getGoalOrThrow(db, goalId).status, 'cancelled');
  assert.ok(listGrantsForGoal(db, goalId).every((grant) => grant.status === 'revoked'));
  assert.ok(
    listAuditEvents(db, goalId).some(
      (event) => event.type === 'acceptance.decided' && (event.payload as { decision: string }).decision === 'close',
    ),
  );
});