import type { DatabaseSync } from 'node:sqlite';
import type { WorkItem } from '../domain/types.ts';
import { listWorkspaces } from '../infra/store.ts';
import { computeCompletion } from './completion.ts';
import { dependencyReasons } from './dependencies.ts';
import { getApprovedPlan } from './plans.ts';
import { listRunningAgents, MAX_CONCURRENT_RUNS } from './processes.ts';
import { assessBuilderRetry } from './retries.ts';

export type WorkItemState = 'complete' | 'running' | 'ready' | 'blocked' | 'retry-blocked';

export interface WorkItemReadiness {
  workItemId: string;
  title: string;
  role: WorkItem['role'];
  state: WorkItemState;
  dependsOn: string[];
  blockedBy: string[];
  reasons: string[];
  activeWorkspaceId?: string;
  activeRunId?: string;
}

export interface ReadinessReport {
  goalId: string;
  items: WorkItemReadiness[];
  ready: string[];
  running: string[];
  complete: string[];
  blocked: string[];
  concurrency: { limit: number; active: number; canStart: boolean };
}

/**
 * 计算目标的就绪队列。
 *
 * 只读：依赖已完成、尚未完成且没有运行中 Agent 的工作项进入 ready；
 * 同一原因连续失败的工作项进入 retry-blocked，交人工重置。
 */
export function buildReadiness(
  db: DatabaseSync,
  goalId: string,
  limit = MAX_CONCURRENT_RUNS,
  now = new Date(),
): ReadinessReport {
  const plan = getApprovedPlan(db, goalId);
  if (!plan) throw new Error('目标没有已批准的计划，不能计算就绪队列');

  const assessment = computeCompletion(db, goalId, now);
  const activeWorkspaces = listWorkspaces(db, { goalId, status: 'active' });
  const running = listRunningAgents(db, goalId);
  const byId = new Map(plan.workItems.map((item) => [item.id, item]));

  const items: WorkItemReadiness[] = plan.workItems.map((item) => {
    const completion = assessment.workItems.find((entry) => entry.workItemId === item.id);
    const workspace = activeWorkspaces.find((entry) => entry.workItemId === item.id);
    const run = running.find((entry) => entry.workItemId === item.id);
    const blockedBy = item.dependsOn.filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return !dependency || dependencyReasons(db, goalId, dependency).length > 0;
    });
    const retry: { blocked: boolean; reason?: string } = item.role === 'builder'
      ? assessBuilderRetry(db, goalId, item.id)
      : { blocked: false };

    const reasons: string[] = [];
    if (blockedBy.length > 0) reasons.push(`等待前置工作项：${blockedBy.join('、')}`);
    if (retry.blocked) reasons.push(retry.reason ?? '同一原因连续失败，已转人工');

    let state: WorkItemState;
    if (completion?.complete) state = 'complete';
    else if (run) state = 'running';
    else if (retry.blocked) state = 'retry-blocked';
    else if (blockedBy.length > 0) state = 'blocked';
    else state = 'ready';

    return {
      workItemId: item.id,
      title: item.title,
      role: item.role,
      state,
      dependsOn: item.dependsOn,
      blockedBy,
      reasons,
      ...(workspace ? { activeWorkspaceId: workspace.id } : {}),
      ...(run ? { activeRunId: run.runId } : {}),
    };
  });

  const ready = items.filter((item) => item.state === 'ready').map((item) => item.workItemId);
  const active = running.length;
  return {
    goalId,
    items,
    ready,
    running: items.filter((item) => item.state === 'running').map((item) => item.workItemId),
    complete: items.filter((item) => item.state === 'complete').map((item) => item.workItemId),
    blocked: items
      .filter((item) => item.state === 'blocked' || item.state === 'retry-blocked')
      .map((item) => item.workItemId),
    concurrency: { limit, active, canStart: ready.length > 0 && active < limit },
  };
}