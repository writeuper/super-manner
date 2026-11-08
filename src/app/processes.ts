import type { DatabaseSync } from 'node:sqlite';
import { appendAudit, listAuditEvents } from '../infra/audit.ts';
import { terminateProcess } from '../infra/process.ts';

export interface RunningAgent {
  runId: string;
  pid: number;
  workItemId?: string;
}

/** P1 的默认并发上限：同一目标同时只跑一个 Agent。 */
export const MAX_CONCURRENT_RUNS = 1;

/**
 * 从审计链还原仍然存活的 Agent 进程。
 *
 * 以 run_spawned 出现、run_finished 消失为准；不依赖内存状态，
 * 因此另开一个 CLI 进程执行取消也能找到目标进程。
 */
export function listRunningAgents(db: DatabaseSync, goalId: string): RunningAgent[] {
  const running = new Map<string, RunningAgent>();
  for (const event of listAuditEvents(db, goalId)) {
    const payload = event.payload as { runId?: unknown; pid?: unknown; workItemId?: unknown };
    if (typeof payload.runId !== 'string') continue;
    if (event.type === 'builder.run_spawned' && typeof payload.pid === 'number') {
      running.set(payload.runId, {
        runId: payload.runId,
        pid: payload.pid,
        ...(typeof payload.workItemId === 'string' ? { workItemId: payload.workItemId } : {}),
      });
    } else if (event.type === 'builder.run_finished') {
      running.delete(payload.runId);
    }
  }
  return [...running.values()];
}

export interface TerminateAgentsResult {
  terminated: number;
  pids: number[];
}

/** 终止目标下所有仍在运行的 Agent，并逐个写入审计。 */
export function terminateRunningAgents(
  db: DatabaseSync,
  goalId: string,
  actor: string,
  now = new Date(),
): TerminateAgentsResult {
  const agents = listRunningAgents(db, goalId);
  const at = now.toISOString();
  const pids: number[] = [];

  for (const agent of agents) {
    const result = terminateProcess(agent.pid);
    if (result.ok) pids.push(agent.pid);
    appendAudit(
      db,
      {
        actor,
        type: 'agent.terminated',
        goalId,
        payload: {
          runId: agent.runId,
          workItemId: agent.workItemId,
          pid: agent.pid,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        },
      },
      at,
    );
  }

  return { terminated: pids.length, pids };
}