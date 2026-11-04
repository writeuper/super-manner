import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentRole,
  GoldenTask,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookVersion,
  ProposalStatus,
} from '../domain/playbook.ts';

type Row = Record<string, unknown>;

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function goldenTaskFromRow(row: Row): GoldenTask {
  return {
    id: String(row.id),
    role: String(row.role) as AgentRole,
    title: String(row.title),
    prompt: String(row.prompt),
    criteria: parse<string[]>(row.criteria),
    createdAt: String(row.created_at),
  };
}

function proposalFromRow(row: Row): PlaybookProposal {
  return {
    id: String(row.id),
    role: String(row.role) as AgentRole,
    ...(row.base_version_id === null ? {} : { baseVersionId: String(row.base_version_id) }),
    ...(row.base_version === null ? {} : { baseVersion: Number(row.base_version) }),
    content: parse(row.content),
    rationale: String(row.rationale),
    ...(row.source_goal_id === null ? {} : { sourceGoalId: String(row.source_goal_id) }),
    createdBy: String(row.created_by),
    status: String(row.status) as ProposalStatus,
    ...(row.evaluation === null
      ? {}
      : { evaluation: parse<PlaybookEvaluation>(row.evaluation) }),
    createdAt: String(row.created_at),
    ...(row.decided_at === null ? {} : { decidedAt: String(row.decided_at) }),
    ...(row.decided_by === null ? {} : { decidedBy: String(row.decided_by) }),
    ...(row.decision_reason === null ? {} : { decisionReason: String(row.decision_reason) }),
  };
}

function versionFromRow(row: Row): PlaybookVersion {
  return {
    id: String(row.id),
    role: String(row.role) as AgentRole,
    version: Number(row.version),
    content: parse(row.content),
    status: String(row.status) as PlaybookVersion['status'],
    canaryPercent: Number(row.canary_percent),
    ...(row.source_proposal_id === null
      ? {}
      : { sourceProposalId: String(row.source_proposal_id) }),
    ...(row.metrics === null ? {} : { metrics: parse(row.metrics) }),
    createdAt: String(row.created_at),
    ...(row.activated_at === null ? {} : { activatedAt: String(row.activated_at) }),
    ...(row.retired_at === null ? {} : { retiredAt: String(row.retired_at) }),
  };
}

// ---------- Golden tasks ----------

export function insertGoldenTask(db: DatabaseSync, task: GoldenTask): void {
  db.prepare(
    `INSERT INTO playbook_golden_tasks (id, role, title, prompt, criteria, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(task.id, task.role, task.title, task.prompt, JSON.stringify(task.criteria), task.createdAt);
}

export function getGoldenTask(db: DatabaseSync, id: string): GoldenTask | undefined {
  const row = db.prepare('SELECT * FROM playbook_golden_tasks WHERE id = ?').get(id) as
    | Row
    | undefined;
  return row ? goldenTaskFromRow(row) : undefined;
}

export function listGoldenTasks(db: DatabaseSync, role?: AgentRole): GoldenTask[] {
  const rows = (
    role === undefined
      ? db.prepare('SELECT * FROM playbook_golden_tasks ORDER BY role, id').all()
      : db.prepare('SELECT * FROM playbook_golden_tasks WHERE role = ? ORDER BY id').all(role)
  ) as Row[];
  return rows.map(goldenTaskFromRow);
}

// ---------- Proposals ----------

export function insertProposal(db: DatabaseSync, proposal: PlaybookProposal): void {
  db.prepare(
    `INSERT INTO playbook_proposals
       (id, role, base_version_id, base_version, content, rationale, source_goal_id,
        created_by, status, evaluation, created_at, decided_at, decided_by, decision_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    proposal.id,
    proposal.role,
    proposal.baseVersionId ?? null,
    proposal.baseVersion ?? null,
    JSON.stringify(proposal.content),
    proposal.rationale,
    proposal.sourceGoalId ?? null,
    proposal.createdBy,
    proposal.status,
    proposal.evaluation === undefined ? null : JSON.stringify(proposal.evaluation),
    proposal.createdAt,
    proposal.decidedAt ?? null,
    proposal.decidedBy ?? null,
    proposal.decisionReason ?? null,
  );
}

export function getProposal(db: DatabaseSync, id: string): PlaybookProposal | undefined {
  const row = db.prepare('SELECT * FROM playbook_proposals WHERE id = ?').get(id) as
    | Row
    | undefined;
  return row ? proposalFromRow(row) : undefined;
}

export function listProposals(db: DatabaseSync, role?: AgentRole): PlaybookProposal[] {
  const rows = (
    role === undefined
      ? db.prepare('SELECT * FROM playbook_proposals ORDER BY created_at, id').all()
      : db
          .prepare('SELECT * FROM playbook_proposals WHERE role = ? ORDER BY created_at, id')
          .all(role)
  ) as Row[];
  return rows.map(proposalFromRow);
}

export function updateProposalEvaluation(
  db: DatabaseSync,
  id: string,
  evaluation: PlaybookEvaluation,
): void {
  db.prepare('UPDATE playbook_proposals SET evaluation = ?, status = ? WHERE id = ?').run(
    JSON.stringify(evaluation),
    'evaluated',
    id,
  );
}

export function decideProposal(
  db: DatabaseSync,
  id: string,
  decision: { status: ProposalStatus; actor: string; reason: string; at: string },
): void {
  db.prepare(
    `UPDATE playbook_proposals
     SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?
     WHERE id = ?`,
  ).run(decision.status, decision.at, decision.actor, decision.reason, id);
}

// ---------- Versions ----------

export function insertVersion(db: DatabaseSync, version: PlaybookVersion): void {
  db.prepare(
    `INSERT INTO playbook_versions
       (id, role, version, content, status, canary_percent, source_proposal_id, metrics,
        created_at, activated_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.id,
    version.role,
    version.version,
    JSON.stringify(version.content),
    version.status,
    version.canaryPercent,
    version.sourceProposalId ?? null,
    version.metrics === undefined ? null : JSON.stringify(version.metrics),
    version.createdAt,
    version.activatedAt ?? null,
    version.retiredAt ?? null,
  );
}

export function getVersion(db: DatabaseSync, id: string): PlaybookVersion | undefined {
  const row = db.prepare('SELECT * FROM playbook_versions WHERE id = ?').get(id) as
    | Row
    | undefined;
  return row ? versionFromRow(row) : undefined;
}

export function listVersions(db: DatabaseSync, role?: AgentRole): PlaybookVersion[] {
  const rows = (
    role === undefined
      ? db.prepare('SELECT * FROM playbook_versions ORDER BY role, version').all()
      : db.prepare('SELECT * FROM playbook_versions WHERE role = ? ORDER BY version').all(role)
  ) as Row[];
  return rows.map(versionFromRow);
}

export function findActiveVersion(
  db: DatabaseSync,
  role: AgentRole,
): PlaybookVersion | undefined {
  const row = db
    .prepare("SELECT * FROM playbook_versions WHERE role = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
    .get(role) as Row | undefined;
  return row ? versionFromRow(row) : undefined;
}

export function findCanaryVersion(
  db: DatabaseSync,
  role: AgentRole,
): PlaybookVersion | undefined {
  const row = db
    .prepare("SELECT * FROM playbook_versions WHERE role = ? AND status = 'canary' ORDER BY version DESC LIMIT 1")
    .get(role) as Row | undefined;
  return row ? versionFromRow(row) : undefined;
}

export function nextVersionNumber(db: DatabaseSync, role: AgentRole): number {
  const row = db
    .prepare('SELECT MAX(version) AS max_version FROM playbook_versions WHERE role = ?')
    .get(role) as Row;
  return Number(row.max_version ?? 0) + 1;
}

export function retireVersion(db: DatabaseSync, id: string, at: string): void {
  db.prepare("UPDATE playbook_versions SET status = 'retired', retired_at = ? WHERE id = ?").run(
    at,
    id,
  );
}

export function markVersionCanary(
  db: DatabaseSync,
  id: string,
  percent: number,
): void {
  db.prepare(
    "UPDATE playbook_versions SET status = 'canary', canary_percent = ? WHERE id = ?",
  ).run(percent, id);
}

export function markVersionActive(db: DatabaseSync, id: string, at: string): void {
  db.prepare(
    "UPDATE playbook_versions SET status = 'active', canary_percent = 100, activated_at = ?, retired_at = NULL WHERE id = ?",
  ).run(at, id);
}