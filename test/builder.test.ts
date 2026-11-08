import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectSelfChecks, runBuilder } from '../src/app/builder.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { resetBuilderRetry, classifyRunFailure } from '../src/app/retries.ts';
import type { Executor, ExecutorRequest, ExecutorResult, ExecutorStatus } from '../src/domain/executor.ts';
import type { WorkItem } from '../src/domain/types.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { listCheckpointsForGoal, listEscalations } from '../src/infra/store.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultPlan,
  setupApproved,
} from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** 记录调用并按需返回结果的假执行器，避免测试依赖真实模型 CLI。 */
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

function approvedWithBuilderItem(item: WorkItem): { db: ReturnType<typeof createTestDb>; goalId: string } {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(db, goal.id, defaultPlan({ workItems: [item] }), 'planner');
  approvePlan(db, plan.id, 'architect');
  return { db, goalId: goal.id };
}

test('Builder 在授权工作区内运行 Agent、自检并采集差异', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);

  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      assert.match(request.stdin ?? '', /## 工作项/);
      assert.match(request.stdin ?? '', /不要提交（commit）/);
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
      return { stdout: '已新增登录错误提示' };
    }
    return { stdout: `${request.command} ok` };
  });

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [
      { name: 'typecheck', command: 'fake-typecheck' },
      { name: 'test', command: 'fake-test' },
    ],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.reason, '执行成功，自检通过（2/2）');
  assert.deepEqual(result.changedFiles, ['src/login.ts']);
  assert.deepEqual(
    result.selfChecks.map((check) => check.name),
    ['typecheck', 'test'],
  );
  assert.equal(result.role.role, 'builder');
  assert.equal(executor.calls[0]?.command, 'fake-agent');
  assert.ok(executor.calls[0]?.cwd?.startsWith(join(repo.root, 'worktrees')));

  const types = listAuditEvents(db, goal.id).map((event) => event.type);
  assert.ok(types.includes('builder.run_started'));
  assert.ok(types.includes('builder.run_finished'));
});

test('没有 repo.write 授权时不启动 Agent', async () => {
  const { db, goalId } = approvedWithBuilderItem(
    builderItem({
      grant: {
        subject: BUILDER,
        actions: ['repo.read'],
        scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
        constraints: {},
      },
    }),
  );
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor();

  const result = await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
  });

  assert.equal(result.status, 'denied');
  assert.match(result.reason, /没有覆盖该动作的授权/);
  assert.equal(executor.calls.length, 0);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'builder.run_denied').length,
    1,
  );
});

test('Agent 失败时不运行自检并返回失败原因', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-agent'
      ? { status: 'failed', exitCode: 2, stderr: '模型无法完成' }
      : {},
  );

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /模型执行失败：failed/);
  assert.equal(result.selfChecks.length, 0);
  assert.equal(executor.calls.length, 1);
});

test('自检失败时整体判定为失败', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-typecheck'
      ? { status: 'failed', exitCode: 1, stderr: '类型错误' }
      : { stdout: 'ok' },
  );

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /自检未通过：typecheck/);
});

test('没有活跃工作区且未提供仓库路径时拒绝运行', async () => {
  const { db, goal } = setupApproved();
  await assert.rejects(
    () =>
      runBuilder(db, {
        goalId: goal.id,
        workItemId: 'build',
        executor: new FakeExecutor(),
        agent: { command: 'fake-agent' },
      }),
    /没有活跃工作区/,
  );
});

test('同一原因连续失败两次后转人工', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-agent' ? { status: 'failed', exitCode: 1, stderr: '断言失败' } : {},
  );
  const input = {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
  };

  const first = await runBuilder(db, input);
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'implementation');
  assert.equal(first.retry.blocked, false);

  const second = await runBuilder(db, input);
  assert.equal(second.status, 'failed');
  assert.equal(second.retry.sameCauseFailures, 1);

  const third = await runBuilder(db, input);
  assert.equal(third.status, 'blocked');
  assert.match(third.reason, /同一原因连续失败 2 次/);
  assert.equal(third.agent, null);
  assert.equal(executor.calls.length, 2);

  const events = listAuditEvents(db, goal.id);
  assert.equal(events.filter((event) => event.type === 'builder.run_finished').length, 2);
  assert.equal(events.filter((event) => event.type === 'builder.retry_blocked').length, 1);
});

test('人工重置后可以继续重试，历史仍保留', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) =>
    request.command === 'fake-agent' ? { status: 'failed', exitCode: 1 } : {},
  );
  const input = {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
  };

  await runBuilder(db, input);
  await runBuilder(db, input);
  assert.equal((await runBuilder(db, input)).status, 'blocked');

  const reset = resetBuilderRetry(db, {
    goalId: goal.id,
    workItemId: 'build',
    actor: 'human',
    reason: '已调整实现方案',
  });
  assert.equal(reset.blocked, false);
  assert.equal(reset.sameCauseFailures, 0);

  const next = await runBuilder(db, input);
  assert.equal(next.status, 'failed');
  assert.equal(executor.calls.length, 3);

  const events = listAuditEvents(db, goal.id);
  assert.equal(events.filter((event) => event.type === 'builder.run_finished').length, 3);
  assert.equal(events.filter((event) => event.type === 'builder.retry_cleared').length, 1);
});

test('环境失败不计入同因次数', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const statuses: ExecutorStatus[] = ['spawn_error', 'spawn_error', 'failed', 'failed'];
  const executor = new FakeExecutor((request) => {
    if (request.command !== 'fake-agent') return {};
    const status = statuses.shift() ?? 'succeeded';
    return { status, exitCode: status === 'failed' ? 1 : null };
  });
  const input = {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
  };

  assert.equal((await runBuilder(db, input)).failureKind, 'environment');
  assert.equal((await runBuilder(db, input)).failureKind, 'environment');
  assert.equal((await runBuilder(db, input)).status, 'failed');
  const fourth = await runBuilder(db, input);
  assert.equal(fourth.status, 'failed');
  assert.equal(fourth.retry.sameCauseFailures, 1);

  const fifth = await runBuilder(db, input);
  assert.equal(fifth.status, 'blocked');
  assert.equal(executor.calls.length, 4);
});

test('不同失败原因不会累积', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  let agentStatus: ExecutorStatus = 'failed';
  let checkStatus: ExecutorStatus = 'succeeded';
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      return { status: agentStatus, exitCode: agentStatus === 'failed' ? 1 : 0 };
    }
    return { status: checkStatus, exitCode: checkStatus === 'failed' ? 1 : 0 };
  });
  const input = {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  };

  assert.equal((await runBuilder(db, input)).failureKind, 'implementation');

  agentStatus = 'succeeded';
  checkStatus = 'failed';
  const second = await runBuilder(db, input);
  assert.equal(second.status, 'failed');
  assert.equal(second.failureKind, 'implementation');

  agentStatus = 'failed';
  checkStatus = 'succeeded';
  const third = await runBuilder(db, input);
  assert.equal(third.status, 'failed');
  assert.notEqual(third.status, 'blocked');
  assert.equal(executor.calls.filter((call) => call.command === 'fake-agent').length, 3);
});

test('改动超出授权路径时阻断运行并生成升级卡片', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor((request) => {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'README.md'), '# 越界改动\n');
      return { stdout: '改完了' };
    }
    return {};
  });

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.changedFiles, ['README.md']);
  assert.deepEqual(result.scopeViolation?.files, ['README.md']);
  assert.equal(result.scopeViolation?.outcome, 'escalated');
  assert.ok(result.scopeViolation?.escalationId);
  assert.match(result.reason, /改动超出授权范围：README\.md/);
  assert.equal(result.failureKind, 'implementation');
  assert.equal(
    listAuditEvents(db, goal.id).filter((event) => event.type === 'change.scope_violation').length,
    1,
  );
  assert.equal(listEscalations(db, 'pending').length, 1);
  assert.equal(
    listCheckpointsForGoal(db, goal.id).filter((checkpoint) => checkpoint.kind === 'builder_run').length,
    0,
  );
});

test('网络类退出归为环境失败', () => {
  assert.deepEqual(
    classifyRunFailure('failed', [], 'ERROR: stream disconnected before completion'),
    { failureKind: 'environment', causeKey: 'agent:environment' },
  );
  assert.deepEqual(classifyRunFailure('failed', [], '断言失败'), {
    failureKind: 'implementation',
    causeKey: 'agent:failed',
  });
});

test('Agent 成功但没有改动时视为失败', async () => {
  const { db, goal } = setupApproved();
  const repo = createTestRepo();
  tempRoots.push(repo.root);
  const executor = new FakeExecutor();

  const result = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor,
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'implementation');
  assert.equal(result.retry.sameCauseFailures, 0);
  assert.match(result.reason, /没有产生任何改动/);
});

test('自检命令按 package.json 与锁文件探测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manner-checks-'));
  tempRoots.push(dir);
  assert.deepEqual(detectSelfChecks(dir), []);

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test', lint: 'eslint .' } }),
  );
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  assert.deepEqual(detectSelfChecks(dir), [
    { name: 'typecheck', command: npm, args: ['run', 'typecheck'] },
    { name: 'test', command: npm, args: ['run', 'test'] },
  ]);

  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.deepEqual(
    detectSelfChecks(dir).map((check) => check.command),
    [pnpm, pnpm],
  );
});