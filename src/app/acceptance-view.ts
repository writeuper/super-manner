import type { DatabaseSync } from 'node:sqlite';
import { appendAudit } from '../infra/audit.ts';
import { listEscalations } from '../infra/store.ts';
import { computeCompletion } from './completion.ts';
import { getBudgetStatus } from './budget.ts';
import { getLatestEvidence, type EvidenceRecord } from './evidence.ts';
import { getGoalOrThrow } from './goals.ts';
import { getApprovedPlan } from './plans.ts';
import { collectVerifierChange, type VerifierChange } from './verification.ts';
import { getLatestVerdicts, type VerdictRecord } from './verdicts.ts';

export interface AcceptanceViewInput {
  goalId: string;
  actor?: string;
}

export interface AcceptanceView {
  goalId: string;
  generatedAt: string;
  complete: boolean;
  html: string;
}

const RESULT_LABELS: Record<string, string> = {
  passed: '通过',
  failed: '不通过',
  undetermined: '无法判定',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function list(items: string[]): string {
  if (items.length === 0) return '<p class="muted">无</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function verdictTable(record: VerdictRecord | undefined): string {
  if (!record) return '<p class="muted">尚未记录逐条判定</p>';
  const rows = record.verdicts
    .map((verdict) => {
      const evidence = verdict.evidence.length > 0
        ? verdict.evidence.map((id) => `<code>${escapeHtml(id)}</code>`).join('<br>')
        : '<span class="muted">—</span>';
      return `<tr class="verdict-${verdict.result}">
        <td>${escapeHtml(verdict.criterion)}</td>
        <td class="result">${RESULT_LABELS[verdict.result] ?? escapeHtml(verdict.result)}</td>
        <td>${escapeHtml(verdict.note)}</td>
        <td>${evidence}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>标准</th><th>结论</th><th>说明</th><th>证据</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted">记录于 ${escapeHtml(record.recordedAt)}</p>`;
}

function evidenceTable(records: EvidenceRecord[] | undefined, collectedAt?: string): string {
  if (!records || records.length === 0) return '<p class="muted">尚无证据</p>';
  const rows = records
    .map(
      (record) => `<tr>
        <td>${escapeHtml(record.name)}</td>
        <td><code>${escapeHtml(record.command)} ${escapeHtml(record.args.join(' '))}</code></td>
        <td class="status-${record.status}">${record.status}${record.exitCode === null ? '' : ` (${record.exitCode})`}</td>
        <td>${record.durationMs} ms</td>
        <td><code>${escapeHtml(record.hash.slice(0, 16))}…</code></td>
      </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th>检查</th><th>命令</th><th>结果</th><th>耗时</th><th>哈希</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${collectedAt ? `<p class="muted">采集于 ${escapeHtml(collectedAt)}</p>` : ''}`;
}

function diffSection(change: VerifierChange | undefined): string {
  if (!change) return '<p class="muted">没有活跃工作区，无法展示差异</p>';
  return `<p>分支 <code>${escapeHtml(change.branch)}</code> · 基线 <code>${escapeHtml(change.baseBranch)}</code></p>
  <p>改动文件：${change.changedFiles.length > 0 ? change.changedFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ') : '<span class="muted">无</span>'}</p>
  <pre>${escapeHtml(change.diff || '（没有可展示的差异）')}</pre>
  ${change.diffTruncated ? '<p class="warn">差异过长已截断，未展示部分需要另行获取。</p>' : ''}`;
}

/**
 * 生成单页验收视图。
 *
 * 只读汇总目标、差异、证据、判定、风险与待决事项，让人无需追问即可决定接受或返工。
 */
export function buildAcceptanceView(
  db: DatabaseSync,
  input: AcceptanceViewInput,
  now = new Date(),
): AcceptanceView {
  const goal = getGoalOrThrow(db, input.goalId);
  const plan = getApprovedPlan(db, goal.id);
  if (!plan) throw new Error('目标没有已批准的计划，不能生成验收视图');
  const assessment = computeCompletion(db, goal.id, now);
  const budget = getBudgetStatus(db, goal.id);
  const pendingEscalations = listEscalations(db, 'pending')
    .filter((escalation) => escalation.goalId === goal.id)
    .map((escalation) => `待裁决：${escalation.action} · ${escalation.reason}`);
  const pendingItems = [...plan.pendingDecisions, ...pendingEscalations];

  const sections = plan.workItems
    .map((item) => {
      const completion = assessment.workItems.find((entry) => entry.workItemId === item.id);
      const verdicts = getLatestVerdicts(db, goal.id, item.id);
      const evidence = getLatestEvidence(db, goal.id, item.id);
      let change: VerifierChange | undefined;
      try {
        change = collectVerifierChange(db, { goalId: goal.id, workItemId: item.id });
      } catch {
        change = undefined;
      }
      const reasons = completion && completion.reasons.length > 0
        ? `<p class="warn">未完成原因：${escapeHtml(completion.reasons.join('；'))}</p>`
        : '<p class="ok">工作项完成判定通过</p>';
      const binding = [
        completion?.deliveryHead
          ? `交付提交 <code>${escapeHtml(completion.deliveryHead)}</code>`
          : '<span class="warn">未推送交付</span>',
        completion?.evidenceHead
          ? `证据提交 <code>${escapeHtml(completion.evidenceHead)}</code>`
          : '<span class="warn">无证据提交</span>',
        completion?.evaluatedHead
          ? `判定提交 <code>${escapeHtml(completion.evaluatedHead)}</code>`
          : '<span class="warn">判定未绑定提交</span>',
      ].join(' · ');

      return `<section>
        <h2>工作项 ${escapeHtml(item.id)} · ${escapeHtml(item.title)}</h2>
        <p>角色 <code>${escapeHtml(item.role)}</code> · 预算 ${item.budgetTokens} tokens</p>
        <p class="muted">${binding}</p>
        ${reasons}
        <h3>完成标准</h3>
        ${list(item.dod)}
        <h3>逐条判定</h3>
        ${verdictTable(verdicts)}
        <h3>证据</h3>
        ${evidenceTable(evidence?.evidence, evidence?.collectedAt)}
        <h3>差异</h3>
        ${diffSection(change)}
      </section>`;
    })
    .join('\n');

  const banner = assessment.goal.complete
    ? '<p class="banner ok">两级完成判定通过，可进入人工验收</p>'
    : `<p class="banner warn">尚未满足完成条件</p>${list(assessment.goal.reasons)}`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>验收视图 · ${escapeHtml(goal.title)}</title>
<style>
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px auto; max-width: 1100px; padding: 0 20px; color: #1f2328; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 32px; border-bottom: 1px solid #d8dee4; padding-bottom: 6px; }
  h3 { font-size: 14px; margin: 18px 0 6px; }
  code { background: #f6f8fa; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0; }
  th, td { border: 1px solid #d8dee4; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  pre { background: #f6f8fa; padding: 12px; overflow: auto; max-height: 480px; border-radius: 6px; font-size: 12px; }
  .muted { color: #6e7781; }
  .ok { color: #1a7f37; }
  .warn { color: #9a6700; }
  .banner { padding: 12px 16px; border-radius: 6px; font-weight: 600; }
  .banner.ok { background: #dafbe1; }
  .banner.warn { background: #fff8c5; }
  .result { white-space: nowrap; }
  .verdict-failed .result { color: #cf222e; font-weight: 600; }
  .verdict-undetermined .result { color: #9a6700; font-weight: 600; }
  .verdict-passed .result { color: #1a7f37; font-weight: 600; }
  .status-failed { color: #cf222e; }
  .status-timed_out, .status-spawn_error { color: #9a6700; }
  .status-succeeded { color: #1a7f37; }
</style>
</head>
<body>
<h1>${escapeHtml(goal.title)}</h1>
<p class="muted">${escapeHtml(goal.description)}</p>
<p>仓库 <code>${escapeHtml(goal.repo)}</code> · 基线 <code>${escapeHtml(goal.baseBranch)}</code> · 自治 ${
    escapeHtml(goal.autonomy)
  } · 预算 ${budget.usedTokens} / ${goal.budgetTokens} tokens</p>

${banner}

<h2>目标验收标准</h2>
${list(goal.acceptance)}

<h2>约束</h2>
${list(goal.constraints)}

${sections}

<section>
  <h2>风险</h2>
  ${list(plan.risks)}
  <h2>待决事项</h2>
  ${list(pendingItems)}
</section>

<p class="muted">生成于 ${escapeHtml(now.toISOString())} · 完成判定记录见审计事件 verifier.completion_assessed</p>
</body>
</html>`;

  appendAudit(
    db,
    {
      actor: input.actor ?? 'verifier',
      type: 'acceptance.view_built',
      goalId: goal.id,
      payload: {
        complete: assessment.goal.complete,
        reasons: assessment.goal.reasons,
        generatedAt: now.toISOString(),
      },
    },
    now.toISOString(),
  );

  return {
    goalId: goal.id,
    generatedAt: now.toISOString(),
    complete: assessment.goal.complete,
    html,
  };
}