import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { cancelGoal } from '../src/app/goals.ts';
import { buildReadiness } from '../src/app/orchestration.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { createLocalExecutor } from '../src/infra/executor.ts';
import {
  builderItem,
  commitAndPush,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultGoal,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

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
      stdout: 'ok',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      ...this.handler(request),
    };
  }
}

async function waitForAudit(
  db: ReturnType<typeof createTestDb>,
  goalId: string,
  type: string,
  timeoutMs = 5000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = listAuditEvents(db, goalId).find((candidate) => candidate.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待审计事件超时：${type}`);
}

test('就绪队列在依赖完成后放行下游工作项', async () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    {
      workItems: [builderItem(), builderItem({ id: 'follow-up', dependsOn: ['build'], budgetTokens: 1000 })],
      totalBudgetTokens: 2000,
    },
    'planner',
  );
  approvePlan(db, plan.id, 'architect');

  const initial = buildReadiness(db, goal.id);
  assert.deepEqual(initial.ready, ['build']);
  assert.deepEqual(initial.blocked, ['follow-up']);
  assert.equal(initial.concurrency.canStart, true);

  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  await runBuilder(db, {
    goalId: goal.id,
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
  commitAndPush(db, goal.id);
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  await collectEvidence(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  recordVerdicts(db, {
    goalId: goal.id,
    workItemId: 'build',
    verdicts: [...defaultGoal().acceptance, ...builderItem().dod].map((criterion) => ({
      criterion,
      result: 'passed' as const,
      note: '上游工作项已验收',
    })),
  });

  const after = buildReadiness(db, goal.id);
  assert.deepEqual(after.complete, ['build']);
  assert.deepEqual(after.ready, ['follow-up']);
  assert.deepEqual(after.blocked, []);
});

test('并发上限阻止同一目标同时启动第二个 Agent', async () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    { workItems: [builderItem({ id: 'a' }), builderItem({ id: 'b' })], totalBudgetTokens: 2000 },
    'planner',
  );
  approvePlan(db, plan.id, 'architect');

  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const worktreeRoot = join(repo.root, 'worktrees');
  const pending = runBuilder(db, {
    goalId: goal.id,
    workItemId: 'a',
    executor: createLocalExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot,
    agent: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
    selfChecks: [],
  });

  await waitForAudit(db, goal.id, 'builder.run_spawned');
  const report = buildReadiness(db, goal.id);
  assert.deepEqual(report.running, ['a']);
  assert.ok(report.ready.includes('b'));
  assert.equal(report.concurrency.active, 1);
  assert.equal(report.concurrency.canStart, false);

  const second = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'b',
    executor: new FakeExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot,
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  assert.equal(second.status, 'blocked');
  assert.match(second.reason ?? '', /并发上限/);

  const duplicate = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'a',
    executor: new FakeExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot,
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  assert.equal(duplicate.status, 'blocked');
  assert.match(duplicate.reason ?? '', /已有运行中的 Agent/);

  cancelGoal(db, goal.id, 'human-1');
  const first = await pending;
  assert.notEqual(first.status, 'succeeded');
});