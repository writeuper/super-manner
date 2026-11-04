import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commitWorkspace, pushWorkspace } from '../src/app/delivery.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { createPullRequest } from '../src/app/pull-requests.ts';
import { createWorkspace } from '../src/app/workspaces.ts';
import type { Action } from '../src/domain/actions.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import type { Workspace } from '../src/domain/types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { listAuditEvents } from '../src/infra/audit.ts';
import {
  BUILDER,
  REPO,
  builderItem,
  createTestDb,
  createTestGoal,
  createTestRepo,
  defaultPlan,
  type TestRepo,
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

interface Fixture {
  db: DatabaseSync;
  goalId: string;
  repo: TestRepo;
  workspace: Workspace;
}

function setup(options: { actions?: Action[]; pushed?: boolean } = {}): Fixture {
  const actions = options.actions ?? ['repo.read', 'repo.write', 'repo.commit', 'repo.push', 'pr.create'];
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    defaultPlan({
      workItems: [
        builderItem({
          grant: {
            subject: BUILDER,
            actions,
            scope: { repos: [REPO], branches: ['feature/sm-*'], paths: ['src/'] },
            constraints: {},
          },
        }),
      ],
    }),
    'planner',
  );
  approvePlan(db, plan.id, 'architect');

  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  const workspace = createWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
  });

  if (options.pushed !== false) {
    writeFileSync(join(workspace.path, 'src', 'login.ts'), 'export const login = true;\n');
    commitWorkspace(db, { goalId: goal.id, workItemId: 'build' });
    pushWorkspace(db, { goalId: goal.id, workItemId: 'build' });
  }

  return { db, goalId: goal.id, repo, workspace };
}

test('用 gh 创建 PR 并记录审计', async () => {
  const { db, goalId, workspace } = setup();
  const executor = new FakeExecutor(() => ({
    stdout: 'Creating pull request for feature/sm-1 into main\nhttps://github.com/acme/demo/pull/42\n',
  }));

  const result = await createPullRequest(db, {
    goalId,
    workItemId: 'build',
    executor,
  });

  assert.equal(result.status, 'created');
  assert.equal(result.url, 'https://github.com/acme/demo/pull/42');
  assert.equal(result.branch, workspace.branch);
  assert.equal(result.base, 'main');
  assert.equal(executor.calls.length, 1);
  const call = executor.calls[0];
  assert.ok(call);
  assert.equal(call.command, 'gh');
  assert.deepEqual(call.args?.slice(0, 6), [
    'pr',
    'create',
    '--repo',
    REPO,
    '--base',
    'main',
  ]);
  assert.ok(call.args?.includes(workspace.branch));

  const created = listAuditEvents(db, goalId).filter((event) => event.type === 'pr.created');
  assert.equal(created.length, 1);
  const [createdEvent] = created;
  assert.ok(createdEvent);
  assert.equal((createdEvent.payload as { url: string }).url, result.url);
});

test('重复创建返回已有 PR，不重复调用 gh', async () => {
  const { db, goalId } = setup();
  const executor = new FakeExecutor(() => ({
    stdout: 'https://github.com/acme/demo/pull/7\n',
  }));

  await createPullRequest(db, { goalId, workItemId: 'build', executor });
  const second = await createPullRequest(db, { goalId, workItemId: 'build', executor });

  assert.equal(second.status, 'existing');
  assert.equal(second.url, 'https://github.com/acme/demo/pull/7');
  assert.equal(executor.calls.length, 1);
});

test('未获 pr.create 授权时拒绝且不调用 gh', async () => {
  const { db, goalId } = setup({ actions: ['repo.read', 'repo.write', 'repo.commit', 'repo.push'] });
  const executor = new FakeExecutor();

  const result = await createPullRequest(db, { goalId, workItemId: 'build', executor });

  assert.equal(result.status, 'denied');
  assert.equal(executor.calls.length, 0);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'pr.created').length,
    0,
  );
});

test('分支未推送时阻断，不调用 gh', async () => {
  const { db, goalId } = setup({ pushed: false });
  const executor = new FakeExecutor();

  const result = await createPullRequest(db, { goalId, workItemId: 'build', executor });

  assert.equal(result.status, 'blocked');
  assert.match(result.reason ?? '', /尚未推送/);
  assert.equal(executor.calls.length, 0);
});

test('gh 失败时保留输出并记录失败审计', async () => {
  const { db, goalId } = setup();
  const executor = new FakeExecutor(() => ({
    status: 'failed',
    exitCode: 1,
    stderr: 'gh: Not authenticated',
  }));

  const result = await createPullRequest(db, { goalId, workItemId: 'build', executor });

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? '', /Not authenticated/);
  assert.equal(
    listAuditEvents(db, goalId).filter((event) => event.type === 'pr.create_failed').length,
    1,
  );
});