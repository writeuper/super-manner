import type { DatabaseSync } from 'node:sqlite';
import type { ExecutorStatus } from '../domain/executor.ts';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';

/** S2-06 只区分实现失败与环境失败；验证与外部失败留给 S4-04。 */
export type FailureKind = 'implementation' | 'environment';

/** 同一原因连续失败达到该次数后转人处理，避免无限重试。 */
export const MAX_SAME_CAUSE_FAILURES = 2;

export interface RetryState {
  sameCauseFailures: number;
  causeKey?: string;
  failureKind?: FailureKind;
  blocked: boolean;
  reason?: string;
}

interface RunFinishedPayload {
  workItemId?: string;
  status?: string;
  failureKind?: FailureKind;
  causeKey?: string;
}

/**
 * 从审计链推导重试状态。
 *
 * 从最近的 `builder.retry_cleared` 之后统计 `builder.run_finished`：环境失败不计入，
 * 也不打断同因计数；成功或换因会结束当前连续区间。审计只追加，历史失败不会被覆盖。
 */
export function assessBuilderRetry(
  db: DatabaseSync,
  goalId: string,
  workItemId: string,
): RetryState {
  const events = listAuditEvents(db, goalId)
    .filter((event) => {
      const payload = event.payload as { workItemId?: string };
      return (
        (event.type === 'builder.run_finished' || event.type === 'builder.retry_cleared') &&
        payload.workItemId === workItemId
      );
    })
    .reverse();

  let sameCauseFailures = 0;
  let causeKey: string | undefined;
  let failureKind: FailureKind | undefined;
  for (const event of events) {
    // 人工重置后只统计新产生的失败，重置本身不改写历史。
    if (event.type === 'builder.retry_cleared') break;
    const run = event.payload as RunFinishedPayload;
    if (run.status !== 'failed') break;
    if (run.failureKind === 'environment') continue;
    if (!run.causeKey) break;
    if (causeKey === undefined) {
      causeKey = run.causeKey;
      failureKind = run.failureKind;
    } else if (causeKey !== run.causeKey) {
      break;
    }
    sameCauseFailures += 1;
  }

  if (sameCauseFailures >= MAX_SAME_CAUSE_FAILURES) {
    return {
      sameCauseFailures,
      causeKey,
      failureKind,
      blocked: true,
      reason: `同一原因连续失败 ${sameCauseFailures} 次（${causeKey}），已转人工处理`,
    };
  }
  return { sameCauseFailures, causeKey, failureKind, blocked: false };
}

export interface ResetRetryInput {
  goalId: string;
  workItemId: string;
  actor?: string;
  reason?: string;
}

/**
 * 人工接手后重置重试计数。
 *
 * 只追加一条 `builder.retry_cleared`，历史失败与证据全部保留；
 * 之后的运行从零开始计数。
 */
export function resetBuilderRetry(
  db: DatabaseSync,
  input: ResetRetryInput,
  now = new Date(),
): RetryState {
  appendAudit(
    db,
    {
      actor: input.actor ?? 'human',
      type: 'builder.retry_cleared',
      goalId: input.goalId,
      payload: { workItemId: input.workItemId, reason: input.reason },
    },
    now.toISOString(),
  );
  return assessBuilderRetry(db, input.goalId, input.workItemId);
}

export interface FailedCheck {
  name: string;
  status: ExecutorStatus;
}

/** 常见网络/依赖不可达特征；命中时按环境失败处理，不消耗实现者重试次数。 */
const ENVIRONMENT_PATTERN =
  /reconnecting|request timed out|stream disconnected|error sending request|econnrefused|enotfound|etimedout|eai_again|network/i;

/**
 * 从一次运行结果推导失败类型与原因键。
 *
 * 超时、无法启动与网络类退出归为环境问题，不计入实现者失败次数；
 * 其余非零退出与自检不通过归为同一类实现失败。
 */
export function classifyRunFailure(
  agentStatus: ExecutorStatus,
  failedChecks: FailedCheck[],
  agentStderr = '',
): { failureKind: FailureKind; causeKey: string } | undefined {
  if (agentStatus !== 'succeeded') {
    if (agentStatus !== 'failed') {
      return { failureKind: 'environment', causeKey: `agent:${agentStatus}` };
    }
    return ENVIRONMENT_PATTERN.test(agentStderr)
      ? { failureKind: 'environment', causeKey: 'agent:environment' }
      : { failureKind: 'implementation', causeKey: 'agent:failed' };
  }

  const check = failedChecks[0];
  if (!check) return undefined;
  return check.status === 'failed'
    ? { failureKind: 'implementation', causeKey: `self-check:${check.name}` }
    : {
        failureKind: 'environment',
        causeKey: `self-check:${check.name}:${check.status}`,
      };
}