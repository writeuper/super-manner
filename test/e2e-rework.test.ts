import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideAcceptance } from '../src/app/acceptance.ts';
import { runBuilder } from '../src/app/builder.ts';
import { computeCompletion } from '../src/app/completion.ts';
import { collectEvidence, getLatestEvidence } from '../src/app/evidence.ts';
import { getGoalOrThrow } from '../src/app/goals.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { getLatestVerdicts, recordVerdicts, type VerdictRecord } from '../src/app/verdicts.ts';
import { startVerification } from '../src/app/verification.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { listAuditEvents } from '../src/infra/audit.ts';
import { listGrantsForGoal } from '../src/infra/store.ts';
import { builderItem, commitAndPush, createTestDb, createTestGoal, createTestRepo } from './helpers.ts';

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

async function build(
  db: ReturnType<typeof createTestDb>,
  goalId: string,
  repoDir: string,
  worktreeRoot: string,
  content: string,
): Promise<void> {
  await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor((request) => {
      if (request.command === 'fake-agent') {
        writeFileSync(join(request.cwd as string, 'src', 'login.ts'), content);
      }
      return {};
    }),
    repoDir,
    worktreeRoot,
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
}

async function collect(db: ReturnType<typeof createTestDb>, goalId: string) {
  return collectEvidence(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
}

function judge(
  db: ReturnType<typeof createTestDb>,
  goalId: string,
  results: Record<string, 'passed' | 'failed' | 'undetermined'>,
): VerdictRecord {
  return recordVerdicts(db, {
    goalId,
    workItemId: 'build',
    verdicts: [...ACCEPTANCE, ...DOD].map((criterion) => ({
      criterion,
      result: results[criterion] ?? 'passed',
      note: results[criterion] === 'passed' ? '依据差异与证据核对通过' : '当前改动未满足该标准',
    })),
  });
}

test('一次不通过后返工并通过，历史证据不被覆盖', async () => {
  const db = createTestDb();
  const goal = createTestGoal(db);
  const plan = submitPlan(
    db,
    goal.id,
    { workItems: [builderItem()], totalBudgetTokens: 1000, pendingDecisions: [] },
    'planner',
  );
  approvePlan(db, plan.id, 'architect');
  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  const worktreeRoot = join(repo.root, 'worktrees');

  // 第一轮：实现完成，但有标准不通过 / 无法判定。
  await build(db, goal.id, repo.repoDir, worktreeRoot, 'export const login = true;\n');
  commitAndPush(db, goal.id);
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  const firstEvidence = await collect(db, goal.id);
  judge(db, goal.id, {
    错误密码时展示提示文案: 'failed',
    覆盖失败路径: 'undetermined',
  });

  const blocked = computeCompletion(db, goal.id);
  assert.equal(blocked.goal.complete, false);
  assert.match(blocked.goal.reasons.join('\n'), /未完成/);

  const rework = decideAcceptance(db, {
    goalId: goal.id,
    decision: 'rework',
    reason: '补充错误提示并覆盖失败路径',
    actor: 'human-1',
  });
  assert.equal(rework.goalStatus, 'executing');
  assert.equal(rework.complete, false);

  // 第二轮：返工后重新实现、重新采集证据并全部判定通过。
  await build(db, goal.id, repo.repoDir, worktreeRoot, 'export const login = false;\n');
  commitAndPush(db, goal.id);
  startVerification(db, { goalId: goal.id, actor: 'verifier-1' });
  const secondEvidence = await collect(db, goal.id);
  judge(db, goal.id, {});

  const complete = computeCompletion(db, goal.id);
  assert.equal(complete.goal.complete, true, complete.goal.reasons.join('；'));

  const accepted = decideAcceptance(db, { goalId: goal.id, decision: 'accept', actor: 'human-1' });
  assert.equal(accepted.goalStatus, 'completed');
  assert.equal(accepted.complete, true);

  // 历史不被覆盖：两轮证据与判定都留在审计里，最新一次用于完成判定。
  const events = listAuditEvents(db, goal.id);
  const verdictEvents = events.filter((event) => event.type === 'verifier.verdicts_recorded');
  assert.equal(events.filter((event) => event.type === 'builder.run_started').length, 2);
  assert.equal(events.filter((event) => event.type === 'verifier.evidence_collected').length, 2);
  assert.equal(verdictEvents.length, 2);

  const firstVerdicts = verdictEvents[0]?.payload as VerdictRecord;
  const secondVerdicts = verdictEvents[1]?.payload as VerdictRecord;
  assert.equal(firstVerdicts.summary.failed, 1);
  assert.equal(firstVerdicts.summary.undetermined, 1);
  assert.equal(secondVerdicts.summary.failed, 0);
  assert.equal(secondVerdicts.summary.undetermined, 0);
  assert.equal(secondVerdicts.summary.passed, ACCEPTANCE.length + DOD.length);

  assert.equal(getLatestVerdicts(db, goal.id, 'build')?.id, secondVerdicts.id);
  assert.notEqual(getLatestEvidence(db, goal.id, 'build')?.evidence[0]?.id, firstEvidence.evidence[0]?.id);
  assert.notEqual(secondEvidence.evidence[0]?.id, firstEvidence.evidence[0]?.id);

  assert.equal(getGoalOrThrow(db, goal.id).status, 'completed');
  const grants = listGrantsForGoal(db, goal.id);
  assert.ok(grants.length > 0);
  assert.ok(grants.every((grant) => grant.status === 'revoked'));
});