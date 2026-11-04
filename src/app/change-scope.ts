import type { DatabaseSync } from 'node:sqlite';
import { authorize } from '../domain/policy.ts';
import { appendAudit } from '../infra/audit.ts';
import { listActiveGrantsForSubject } from '../infra/store.ts';
import { requestAction } from './gateway.ts';

export interface ChangeScopeInput {
  goalId: string;
  subject: string;
  repo: string;
  branch: string;
  files: string[];
  actor?: string;
}

export interface ChangeScopeViolation {
  /** 不在任何有效授权路径内的改动文件。 */
  files: string[];
  outcome: 'denied' | 'escalated';
  reason: string;
  escalationId?: string;
}

/** 只做判定，不产生副作用；用于需要先看结果的调用方。 */
export function findOutOfScopeFiles(
  db: DatabaseSync,
  input: ChangeScopeInput,
  now = new Date(),
): string[] {
  const grants = listActiveGrantsForSubject(db, input.goalId, input.subject);
  return input.files.filter((file) => {
    const result = authorize(
      {
        action: 'repo.write',
        subject: input.subject,
        goalId: input.goalId,
        resource: { repo: input.repo, branch: input.branch, path: file },
      },
      grants,
      now,
    );
    return result.decision !== 'allow';
  });
}

/**
 * 改动范围校验：Agent 已经写下的文件必须在有效授权路径内。
 *
 * 越界改动一律阻断后续交付，并写入审计；如果动作本身有授权、只是路径越界，
 * 会经网关生成升级卡片交人裁决，而不是静默失败。
 */
export function enforceChangeScope(
  db: DatabaseSync,
  input: ChangeScopeInput,
  now = new Date(),
): ChangeScopeViolation | null {
  if (input.files.length === 0) return null;
  const outside = findOutOfScopeFiles(db, input, now);
  if (outside.length === 0) return null;

  const at = now.toISOString();
  appendAudit(
    db,
    {
      actor: input.actor ?? input.subject,
      type: 'change.scope_violation',
      goalId: input.goalId,
      subject: input.subject,
      payload: {
        repo: input.repo,
        branch: input.branch,
        files: outside.slice(0, 50),
        total: outside.length,
      },
    },
    at,
  );

  // 只针对第一个越界文件走网关：动作有授权但资源越界时生成一张升级卡片，
  // 没资格时直接拒绝。其余文件记在同一份审计里，避免卡片刷屏。
  const gate = requestAction(
    db,
    {
      action: 'repo.write',
      subject: input.subject,
      goalId: input.goalId,
      resource: { repo: input.repo, branch: input.branch, path: outside[0] },
    },
    { now },
  );

  // 并发或时间窗口导致的判定变化：网关放行时不再阻断。
  if (gate.outcome === 'allowed') return null;

  return {
    files: outside,
    outcome: gate.outcome,
    reason: gate.reason,
    ...(gate.escalationId === undefined ? {} : { escalationId: gate.escalationId }),
  };
}