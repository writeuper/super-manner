import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Goal, WorkItem } from '../domain/types.ts';
import { appendAudit } from '../infra/audit.ts';
import { listChangedFiles, refExists, runGit } from '../infra/git.ts';
import { findActiveWorkspace } from '../infra/store.ts';
import { getGoalOrThrow } from './goals.ts';
import { getApprovedPlan } from './plans.ts';

/** 差异过长时截断，避免验证提示词失控；截断会显式标注。 */
export const MAX_DIFF_CHARS = 20000;

export interface BuildVerifierContextInput {
  goalId: string;
  workItemId: string;
  actor?: string;
}

export interface VerifierContext {
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  baseBranch: string;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  /** 验证者可见的全部信息；不含 Builder 的会话、工具日志或自评。 */
  prompt: string;
  promptHash: string;
}

export interface VerifierChange {
  goalId: string;
  workItemId: string;
  workspaceId: string;
  branch: string;
  baseBranch: string;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
}

function changedFilesAgainst(workspacePath: string, baseBranch: string): string[] {
  const tracked = runGit(['diff', '--name-only', baseBranch], { cwd: workspacePath }).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [...new Set([...tracked, ...listChangedFiles(workspacePath)])].sort();
}

function diffAgainst(workspacePath: string, baseBranch: string): string {
  const result = runGit(['diff', baseBranch], { cwd: workspacePath });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** 只取工作区的分支与差异，供验证上下文与验收视图复用。 */
export function collectVerifierChange(
  db: DatabaseSync,
  input: { goalId: string; workItemId: string },
): VerifierChange {
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能构建验证上下文');
  const item = plan.workItems.find((candidate) => candidate.id === input.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  const workspace = findActiveWorkspace(db, goal.id, item.id);
  if (!workspace) {
    throw new Error(`工作项 ${item.id} 没有活跃工作区，无法获取待验证的差异`);
  }

  const baseBranch = refExists(workspace.path, goal.baseBranch)
    ? goal.baseBranch
    : workspace.baseBranch;
  const files = changedFilesAgainst(workspace.path, baseBranch);
  const fullDiff = diffAgainst(workspace.path, baseBranch);
  const truncated = fullDiff.length > MAX_DIFF_CHARS;
  const diff = truncated ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n…（已截断）` : fullDiff;

  return {
    goalId: goal.id,
    workItemId: item.id,
    workspaceId: workspace.id,
    branch: workspace.branch,
    baseBranch,
    changedFiles: files,
    diff,
    diffTruncated: truncated,
  };
}

function buildPrompt(
  goal: Goal,
  item: WorkItem,
  branch: string,
  baseBranch: string,
  files: string[],
  diff: string,
  truncated: boolean,
): string {
  const acceptance = goal.acceptance.map((line) => `- ${line}`).join('\n');
  const constraints = goal.constraints.length > 0
    ? goal.constraints.map((line) => `- ${line}`).join('\n')
    : '- 无额外约束';
  const dod = item.dod.map((line) => `- ${line}`).join('\n');
  const fileList = files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '- 无改动';
  const diffBody = diff.length > 0 ? diff : '（没有可展示的差异）';

  return `你是 Super-Manner 的 Verifier，请独立判断这个工作项是否达到验收标准。

## 你看不到什么
你没有实现过程记录：没有 Builder 的对话、工具调用、思路或自评。下面是你可用的全部信息。
如果信息不足以判断，请如实给出"无法判定"，不要猜测。

## 目标
标题：${goal.title}
仓库：${goal.repo}
验收标准：
${acceptance}
约束：
${constraints}

## 工作项
id：${item.id}
标题：${item.title}
完成标准：
${dod}

## 改动
分支：${branch}
基线：${baseBranch}
文件：
${fileList}

\`\`\`diff
${diffBody}
\`\`\`

${truncated ? '注意：差异过长已截断，未展示部分需要另行获取。\n' : ''}
## 输出
逐条对照验收标准给出结论：通过 / 不通过 / 无法判定，并说明依据。
不要修改代码，不要复用实现者的结论，也不要自行降低验收标准。`;
}

/**
 * 构建独立验证上下文。
 *
 * 只从目标、计划与工作区差异取数，刻意不读 Builder 的会话与审计日志，
 * 保证"验证者看不到实现过程"是结构上的事实，而不是提示词里的口头约定。
 */
export function buildVerifierContext(
  db: DatabaseSync,
  input: BuildVerifierContextInput,
  now = new Date(),
): VerifierContext {
  const change = collectVerifierChange(db, {
    goalId: input.goalId,
    workItemId: input.workItemId,
  });
  const goal = getGoalOrThrow(db, change.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能构建验证上下文');
  const item = plan.workItems.find((candidate) => candidate.id === change.workItemId);
  if (!item) throw new Error(`工作项不存在于已批准计划：${input.workItemId}`);

  const prompt = buildPrompt(
    goal,
    item,
    change.branch,
    change.baseBranch,
    change.changedFiles,
    change.diff,
    change.diffTruncated,
  );
  const promptHash = createHash('sha256').update(prompt).digest('hex');

  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'verifier.context_built',
      goalId: goal.id,
      subject: item.grant.subject,
      payload: {
        workItemId: item.id,
        workspaceId: change.workspaceId,
        branch: change.branch,
        baseBranch: change.baseBranch,
        changedFiles: change.changedFiles,
        diffBytes: Buffer.byteLength(change.diff),
        diffTruncated: change.diffTruncated,
        promptHash,
      },
    },
    now.toISOString(),
  );

  return {
    goalId: goal.id,
    workItemId: item.id,
    workspaceId: change.workspaceId,
    branch: change.branch,
    baseBranch: change.baseBranch,
    changedFiles: change.changedFiles,
    diff: change.diff,
    diffTruncated: change.diffTruncated,
    prompt,
    promptHash,
  };
}