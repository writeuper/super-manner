import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { getGoalCheckpoints } from '../src/app/checkpoints.ts';
import { extendBudget, getBudgetStatus } from '../src/app/budget.ts';
import { commitWorkspace, pushWorkspace } from '../src/app/delivery.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import {
  cancelGoal,
  getGoalOrThrow,
  pauseGoal,
  resumeGoal,
  setGoalStatus,
} from '../src/app/goals.ts';
import { runBuilder } from '../src/app/builder.ts';
import { requestAction } from '../src/app/gateway.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { createLocalExecutor } from '../src/infra/executor.ts';
import { listEscalations, listGrantsForGoal } from '../src/infra/store.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestGoal,
  createTestDb,
  createTestRepo,
  defaultGoal,
  setupApproved,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

class FakeExecutor implements Executor {
  readonly name = 'fake';
  calls: ExecutorRequest[] = [];
  private readonly handler: (request: ExecutorRequest) => Partial<ExecutorResult>;

  constructor(handler: (request: ExecutorRequest) => Partial<ExecutorResult> = () => ({})) {
    this.handler = handler;
  }

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    this.calls.push(request);
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

function builderInput(
  goalId: string,
  executor: Executor,
  repoDir: string,
  worktreeRoot: string,
) {
  return {
    goalId,
    workItemId: 'build',
    executor,
    repoDir,
    worktreeRoot,
    agent: { command: 'fake-agent' },
    selfChecks: [],
  };
}

test('暂停拒绝写操作，恢复后跳过已完成的写操作', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {};
  });
  const input = builderInput(goal.id, executor, repo.repoDir, join(repo.root, 'worktrees'));

  const first = await runBuilder(db, input);
  assert.equal(first.status, 'succeeded');
  const commit = commitWorkspace(db, { goalId: goal.id, workItemId: 'build', actor: BUILDER });
  assert.equal(commit.status, 'committed');

  const paused = pauseGoal(db, goal.id, 'human-1', '等待评审');
  assert.equal(paused.goal.status, 'paused');
  assert.equal(paused.from, 'executing');
  assert.deepEqual(
    paused.completedWrites.map((checkpoint) => checkpoint.kind),
    ['builder_run', 'commit'],
  );

  const denied = requestAction(db, {
    action: 'repo.write',
    subject: BUILDER,
    goalId: goal.id,
    resource: { repo: REPO, branch: first.branch },
  });
  assert.equal(denied.outcome, 'denied');
  assert.match(denied.reason, /paused/);

  const resumed = resumeGoal(db, goal.id, 'human-1', '评审结束');
  assert.equal(resumed.to, 'executing');
  assert.equal(resumed.goal.pausedFrom, undefined);

  const callsBefore = executor.calls.length;
  const skipped = await runBuilder(db, input);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.agent, null);
  assert.match(skipped.reason, /已完成写操作/);
  assert.equal(executor.calls.length, callsBefore);
  assert.deepEqual(skipped.changedFiles, ['src/login.ts']);

  const events = listAuditEvents(db, goal.id);
  assert.equal(events.filter((event) => event.type === 'builder.run_started').length, 1);
  assert.equal(events.filter((event) => event.type === 'builder.run_skipped').length, 1);
  assert.deepEqual(
    getGoalCheckpoints(db, goal.id).map((checkpoint) => checkpoint.kind),
    ['builder_run', 'commit'],
  );
});

test('验证阶段暂停后恢复到验证阶段', () => {
  const { db, goal } = setupApproved();
  setGoalStatus(db, getGoalOrThrow(db, goal.id), 'verifying', 'verifier-1');

  const paused = pauseGoal(db, goal.id, 'human-1');
  assert.equal(paused.from, 'verifying');
  assert.equal(paused.goal.status, 'paused');

  const resumed = resumeGoal(db, goal.id, 'human-1');
  assert.equal(resumed.to, 'verifying');
  assert.equal(getGoalOrThrow(db, goal.id).status, 'verifying');
});

test('出现不通过判定后，恢复不会跳过重试', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      const round = executor.calls.filter((call) => call.command === 'fake-agent').length;
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), `export const login = ${round};\n`);
    }
    return {};
  });
  const input = builderInput(goal.id, executor, repo.repoDir, join(repo.root, 'worktrees'));

  const first = await runBuilder(db, input);
  assert.equal(first.status, 'succeeded');

  commitWorkspace(db, { goalId: goal.id, workItemId: 'build' });
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  await collectEvidence(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [],
  });

  const criteria = [...defaultGoal().acceptance, ...builderItem().dod];
  recordVerdicts(db, {
    goalId: goal.id,
    workItemId: 'build',
    verdicts: criteria.map((criterion) => ({
      criterion,
      result: criterion === criteria[0] ? 'failed' : 'passed',
      note: criterion === criteria[0] ? '错误提示尚未实现' : '核对通过',
    })),
  });

  pauseGoal(db, goal.id, 'human-1');
  resumeGoal(db, goal.id, 'human-1');

  const second = await runBuilder(db, input);
  assert.equal(second.status, 'succeeded');
  assert.equal(executor.calls.filter((call) => call.command === 'fake-agent').length, 2);
});

test('草稿目标不能暂停', () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  assert.throws(() => pauseGoal(db, goal.id, 'human-1'), /不能暂停/);
  assert.equal(getGoalOrThrow(db, goal.id).status, 'draft');
});

test('取消目标会级联停止授权、升级与后续运行', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {};
  });
  const input = builderInput(goal.id, executor, repo.repoDir, join(repo.root, 'worktrees'));

  const built = await runBuilder(db, input);
  assert.equal(built.status, 'succeeded');

  const escalated = requestAction(db, {
    action: 'repo.push',
    subject: BUILDER,
    goalId: goal.id,
    resource: { repo: REPO, branch: 'release/1.0' },
  });
  assert.equal(escalated.outcome, 'escalated');

  pauseGoal(db, goal.id, 'human-1');
  const cancelled = cancelGoal(db, goal.id, 'human-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pausedFrom, undefined);
  assert.ok(listGrantsForGoal(db, goal.id).every((grant) => grant.status === 'revoked'));
  assert.equal(
    listEscalations(db, 'pending').filter((escalation) => escalation.goalId === goal.id).length,
    0,
  );

  const cancelledEvent = listAuditEvents(db, goal.id).find((event) => event.type === 'goal.cancelled');
  assert.deepEqual(
    {
      from: (cancelledEvent?.payload as { from?: string }).from,
      expired: (cancelledEvent?.payload as { expiredEscalations?: number }).expiredEscalations,
      workspaces: (cancelledEvent?.payload as { activeWorkspaces?: number }).activeWorkspaces,
    },
    { from: 'paused', expired: 1, workspaces: 1 },
  );

  const callsBefore = executor.calls.length;
  await assert.rejects(() => runBuilder(db, input), /不能实例化角色/);
  assert.equal(executor.calls.length, callsBefore);

  assert.throws(
    () => commitWorkspace(db, { goalId: goal.id, workItemId: 'build', actor: BUILDER }),
    /不能实例化角色/,
  );
  assert.throws(
    () => pushWorkspace(db, { goalId: goal.id, workItemId: 'build', actor: BUILDER }),
    /不能实例化角色/,
  );

  const denied = requestAction(db, {
    action: 'repo.write',
    subject: BUILDER,
    goalId: goal.id,
    resource: { repo: REPO, branch: built.branch },
  });
  assert.equal(denied.outcome, 'denied');
  assert.match(denied.reason, /cancelled/);
});

test('Builder 记录 token 用量，耗尽时暂停升级但不压缩验证', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {};
  });
  const input = builderInput(goal.id, executor, repo.repoDir, join(repo.root, 'worktrees'));

  const result = await runBuilder(db, { ...input, tokenUsage: 2100 });
  assert.equal(result.status, 'succeeded');
  assert.equal(getGoalOrThrow(db, goal.id).status, 'paused');
  assert.equal(getBudgetStatus(db, goal.id).exhausted, true);

  const pending = listEscalations(db, 'pending').filter((item) => item.goalId === goal.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.action, 'spend.tokens');

  // 追加预算并恢复后，验证仍可正常记录，不因预算耗尽被跳过。
  extendBudget(db, goal.id, 1000, 'human-1');
  resumeGoal(db, goal.id, 'human-1', '预算已追加');
  commitWorkspace(db, { goalId: goal.id, workItemId: 'build' });
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  await collectEvidence(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [],
  });

  const criteria = [...defaultGoal().acceptance, ...builderItem().dod];
  const verdicts = recordVerdicts(db, {
    goalId: goal.id,
    workItemId: 'build',
    verdicts: criteria.map((criterion) => ({ criterion, result: 'passed', note: '核对通过' })),
  });
  assert.equal(verdicts.verdicts.length, criteria.length);
});

test('取消目标会终止已启动的 Agent 进程', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  const pending = runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: createLocalExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
    selfChecks: [],
  });

  const spawned = await waitForAudit(db, goal.id, 'builder.run_spawned');
  const runId = (spawned.payload as { runId: string }).runId;
  const pid = (spawned.payload as { pid: number }).pid;
  assert.ok(pid > 0);

  const cancelled = cancelGoal(db, goal.id, 'human-1');
  assert.equal(cancelled.status, 'cancelled');

  const result = await pending;
  assert.notEqual(result.status, 'succeeded');

  const terminated = listAuditEvents(db, goal.id).find((event) => event.type === 'agent.terminated');
  assert.ok(terminated);
  assert.equal((terminated.payload as { ok: boolean }).ok, true);
  assert.ok(
    listAuditEvents(db, goal.id).some(
      (event) =>
        event.type === 'builder.run_finished' &&
        (event.payload as { runId?: string }).runId === runId,
    ),
  );

  const cancelledEvent = listAuditEvents(db, goal.id).find((event) => event.type === 'goal.cancelled');
  assert.equal((cancelledEvent?.payload as { terminatedAgents?: number }).terminatedAgents, 1);
});