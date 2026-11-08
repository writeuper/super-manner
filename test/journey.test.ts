import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideAcceptance } from '../src/app/acceptance.ts';
import { buildAcceptanceView } from '../src/app/acceptance-view.ts';
import { listInbox, queryTimeline } from '../src/app/audit-query.ts';
import { getGoalCheckpoints } from '../src/app/checkpoints.ts';
import { computeCompletion } from '../src/app/completion.ts';
import { commitWorkspace, pushWorkspace } from '../src/app/delivery.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { getGoalOrThrow, pauseGoal, resumeGoal } from '../src/app/goals.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { buildReview, generateReview } from '../src/app/review.ts';
import { runBuilder } from '../src/app/builder.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents, verifyAuditChain } from '../src/infra/audit.ts';
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

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    if (request.command === 'fake-agent') {
      writeFileSync(join(request.cwd as string, 'src', 'login.ts'), 'export const login = true;\n');
    }
    return {
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
    };
  }
}

test('P0 完整旅程：计划、暂停恢复、实现、推送、验证、验收与复盘', async () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    {
      workItems: [builderItem()],
      totalBudgetTokens: 1000,
      risks: ['错误提示可能影响现有快照测试'],
      pendingDecisions: [],
    },
    'planner',
  );
  const approved = approvePlan(db, plan.id, 'architect');
  assert.equal(approved.status, 'approved');
  assert.ok(listGrantsForGoal(db, goal.id).length > 0);

  pauseGoal(db, goal.id, 'human-1', '先确认文案');
  assert.equal(getGoalOrThrow(db, goal.id).status, 'paused');
  resumeGoal(db, goal.id, 'human-1', '文案确认完成');
  assert.equal(getGoalOrThrow(db, goal.id).status, 'executing');

  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  const worktreeRoot = join(repo.root, 'worktrees');

  const run = await runBuilder(db, {
    goalId: goal.id,
    workItemId: 'build',
    executor: new FakeExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot,
    agent: { command: 'fake-agent' },
    selfChecks: [{ name: 'typecheck', command: 'fake-typecheck' }],
    tokenUsage: 120,
  });
  assert.equal(run.status, 'succeeded', run.reason);
  assert.deepEqual(run.changedFiles, ['src/login.ts']);

  const committed = commitWorkspace(db, {
    goalId: goal.id,
    workItemId: 'build',
    message: 'feat: show login error',
  });
  assert.equal(committed.status, 'committed');
  const pushed = pushWorkspace(db, { goalId: goal.id, workItemId: 'build' });
  assert.equal(pushed.status, 'pushed');

  const checkpoints = getGoalCheckpoints(db, goal.id);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.kind),
    ['builder_run', 'commit', 'push'],
  );

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
    verdicts: [...ACCEPTANCE, ...DOD].map((criterion) => ({
      criterion,
      result: 'passed' as const,
      note: '依据差异与证据核对通过',
    })),
  });
  const completion = computeCompletion(db, goal.id);
  assert.equal(completion.goal.complete, true, completion.goal.reasons.join('；'));

  const view = buildAcceptanceView(db, { goalId: goal.id });
  assert.match(view.html, /错误密码时展示提示文案/);
  assert.match(view.html, /src\/login\.ts/);

  const accepted = decideAcceptance(db, {
    goalId: goal.id,
    decision: 'accept',
    reason: '验收标准与证据一致',
    actor: 'human-1',
  });
  assert.equal(accepted.goalStatus, 'completed');
  assert.ok(listGrantsForGoal(db, goal.id).every((grant) => grant.status === 'revoked'));

  const review = generateReview(db, goal.id, 'human-1');
  assert.equal(review.status, 'completed');
  assert.equal(review.budget.usedTokens, 120);
  assert.equal(review.budget.remainingTokens, 1880);
  assert.deepEqual(review.failures, []);
  assert.ok(review.deviations.some((entry) => entry.type === 'goal.paused'));
  assert.ok(review.interventions.some((entry) => entry.type === 'acceptance.decided'));

  const timeline = queryTimeline(db, { goalId: goal.id, actor: 'human-1' });
  assert.ok(timeline.some((event) => event.type === 'goal.paused'));
  assert.ok(timeline.some((event) => event.type === 'review.generated'));
  assert.deepEqual(listInbox(db, { goalId: goal.id }), []);

  assert.equal(verifyAuditChain(db).ok, true);
  assert.ok(listAuditEvents(db, goal.id).some((event) => event.type === 'builder.pushed'));
  assert.equal(buildReview(db, goal.id).status, 'completed');
});