import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { runBuilder } from '../src/app/builder.ts';
import { listInbox } from '../src/app/audit-query.ts';
import { collectEvidence } from '../src/app/evidence.ts';
import { createGoal } from '../src/app/goals.ts';
import { approvePlan, submitPlan } from '../src/app/plans.ts';
import { recordVerdicts } from '../src/app/verdicts.ts';
import type { Executor, ExecutorRequest, ExecutorResult } from '../src/domain/executor.ts';
import { openDatabase } from '../src/infra/db.ts';
import { getGoal } from '../src/infra/store.ts';
import { builderItem, commitAndPush, createTestRepo, defaultGoal } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

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

function runCli(dbPath: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args, '--db', dbPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function approvedGoal(dbPath: string): Promise<string> {
  const db = openDatabase(dbPath);
  const goal = createGoal(db, defaultGoal(), 'architect');
  const plan = submitPlan(
    db,
    goal.id,
    { workItems: [builderItem()], totalBudgetTokens: 1000, pendingDecisions: [] },
    'planner',
  );
  approvePlan(db, plan.id, 'architect');
  db.close();
  return goal.id;
}

test('CLI 可以从执行态进入验证态，判定通过后进入人工验收队列', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manner-cli-'));
  tempRoots.push(root);
  const dbPath = join(root, 'manner.db');
  const goalId = await approvedGoal(dbPath);

  const repo = createTestRepo({ bareRemote: true });
  tempRoots.push(repo.root);
  const db = openDatabase(dbPath);
  await runBuilder(db, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    repoDir: repo.repoDir,
    worktreeRoot: join(repo.root, 'worktrees'),
    agent: { command: 'fake-agent' },
    selfChecks: [],
  });
  commitAndPush(db, goalId);
  db.close();

  const readiness = runCli(dbPath, ['orchestrate', 'ready', '--goal', goalId]);
  assert.equal(readiness.code, 0, readiness.stderr);
  assert.deepEqual(JSON.parse(readiness.stdout).ready, ['build']);

  const result = runCli(dbPath, ['verify', 'start', '--goal', goalId, '--by', 'verifier-1']);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { status: string; workItems: string[] };
  assert.equal(payload.status, 'verifying');
  assert.deepEqual(payload.workItems, ['build']);

  const reopened = openDatabase(dbPath);
  assert.equal(getGoal(reopened, goalId)?.status, 'verifying');
  reopened.close();

  const again = runCli(dbPath, ['verify', 'start', '--goal', goalId, '--by', 'verifier-1']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /不能进入验证/);

  const submit = ['verify', 'submit', '--goal', goalId, '--by', 'verifier-1'];
  const incomplete = runCli(dbPath, submit);
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.stderr, /完成判定未通过/);

  const verifying = openDatabase(dbPath);
  await collectEvidence(verifying, {
    goalId,
    workItemId: 'build',
    executor: new FakeExecutor(),
    checks: [{ name: 'typecheck', command: 'fake-typecheck' }],
  });
  recordVerdicts(verifying, {
    goalId,
    workItemId: 'build',
    verdicts: [...defaultGoal().acceptance, ...builderItem().dod].map((criterion) => ({
      criterion, result: 'passed', note: '已核对',
    })),
  });
  verifying.close();

  const submitted = runCli(dbPath, submit);
  assert.equal(submitted.code, 0, submitted.stderr);
  assert.equal(JSON.parse(submitted.stdout).status, 'awaiting_acceptance');
  assert.equal(runCli(dbPath, submit).stdout, submitted.stdout);
  const awaiting = openDatabase(dbPath);
  assert.equal(listInbox(awaiting, { goalId })[0]?.kind, 'acceptance');
  awaiting.close();

  const accepted = runCli(dbPath, ['acceptance', 'decide', '--goal', goalId, '--decision', 'accept', '--by', 'human']);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).goalStatus, 'completed');
});

test('CLI 在缺少工作区或提交时拒绝进入验证', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manner-cli-'));
  tempRoots.push(root);
  const dbPath = join(root, 'manner.db');
  const goalId = await approvedGoal(dbPath);

  const result = runCli(dbPath, ['verify', 'start', '--goal', goalId, '--by', 'verifier-1']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /不能进入验证/);
  assert.match(result.stderr, /没有活跃工作区/);
  assert.match(result.stderr, /没有提交检查点/);
});
