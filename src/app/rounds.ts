import type { DatabaseSync } from 'node:sqlite';
import { listAuditEvents } from '../infra/audit.ts';

/** 当前返工轮次：首次为 1，每发生一次验收返工加 1。 */
export function reworkRound(db: DatabaseSync, goalId: string): number {
  let round = 1;
  for (const event of listAuditEvents(db, goalId)) {
    if (event.type !== 'acceptance.decided') continue;
    if ((event.payload as { decision?: string }).decision === 'rework') round += 1;
  }
  return round;
}