import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildAcceptanceView } from '../src/app/acceptance-view.ts';
import { runBuilder } from '../src/app/builder.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { builderItem, commitAndPush, createTestDb, createTestGoal, createTestRepo } from './helpers.ts';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const RISK = '错误提示可能影响现有快照测试';

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
  const plan = submitPlan(
    db,
    goal.id,
    {
      workItems: [builderItem()],
      totalBudgetTokens: 1000,
      risks: [RISK],
      pendingDecisions: [],
    },
    'planner',
  );
  approvePlan(db, plan.id, 'architect');
  return { db, goalId: goal.id };
}

async function buildWithFakeAgent(db: ReturnType<typeof createTestDb>, goalId: string): Promise<void> {
  const repo = createTestRepo({ bareRemote: true });
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
  commitAndPush(db, goalId);
  startVerification(db, { goalId, actor: 'verifier-1' });
}

test('验收视图汇总目标、差异、证据、风险与待决，并标注可验收', async () => {
  const { db, goalId } = singleItemPlan();
  await buildWithFakeAgent(db, goalId);

  const evidence = await collectEvidence(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [...['错误密码时展示提示文案', '不泄露账号是否存在'], '改动通过类型检查', '覆盖失败路径'].map(
      (criterion) => ({
        criterion,
        result: 'passed' as const,
        note: '复核通过',
        evidence: [evidence.evidence[0]?.id as string],
      }),
    ),
  });

  const view = buildAcceptanceView(db, { goalId, actor: 'verifier-1' }, new Date('2026-11-03T12:00:00.000Z'));

  assert.equal(view.complete, true);
  assert.equal(view.generatedAt, '2026-11-03T12:00:00.000Z');
  assert.match(view.html, /<title>验收视图 · 为登录页增加错误提示<\/title>/);
  assert.match(view.html, /错误密码时展示提示文案/);
  assert.match(view.html, /不新增运行时依赖/);
  assert.match(view.html, /src\/login\.ts/);
  assert.match(view.html, /fake-typecheck/);
  assert.match(view.html, /证据/);
  assert.match(view.html, /可进入人工验收/);
  assert.match(view.html, new RegExp(RISK));
  assert.match(view.html, /待决事项/);
  assert.match(view.html, /通过/);

  const event = listAuditEvents(db, goalId).find((item) => item.type === 'acceptance.view_built');
  assert.ok(event);
  assert.equal((event.payload as { complete: boolean }).complete, true);
});

test('未完成时视图列出阻塞原因', async () => {
  const { db, goalId } = singleItemPlan();
  await buildWithFakeAgent(db, goalId);

  const view = buildAcceptanceView(db, { goalId });

  assert.equal(view.complete, false);
  assert.match(view.html, /尚未满足完成条件/);
  assert.match(view.html, /没有逐条判定/);
  assert.match(view.html, /没有可复用的证据/);
  assert.match(view.html, /尚未记录逐条判定/);
});