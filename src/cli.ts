#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cancelGoal, createGoal, getGoalOrThrow, pauseGoal, resumeGoal } from './app/goals.ts';
import { approvePlan, rejectPlan, submitPlan, type SubmitPlanInput } from './app/plans.ts';
import { decideEscalation, sweepExpiredEscalations } from './app/escalations.ts';
import { requestAction } from './app/gateway.ts';
import { instantiateRole } from './app/roles.ts';
import { cleanupWorkspace, createWorkspace } from './app/workspaces.ts';
import { runBuilder, type BuilderRunResult } from './app/builder.ts';
import { commitWorkspace, pushWorkspace } from './app/delivery.ts';
import { createPullRequest } from './app/pull-requests.ts';
import { resetBuilderRetry } from './app/retries.ts';
import { buildVerifierContext, startVerification } from './app/verification.ts';
import { collectEvidence } from './app/evidence.ts';
import { recordVerdicts, type VerdictInput } from './app/verdicts.ts';
import { assessCompletion } from './app/completion.ts';
import { buildAcceptanceView } from './app/acceptance-view.ts';
import { decideAcceptance, type AcceptanceDecision } from './app/acceptance.ts';
import { getGoalCheckpoints } from './app/checkpoints.ts';
import { extendBudget, getBudgetStatus, recordTokenUsage } from './app/budget.ts';
import { buildReview, generateReview } from './app/review.ts';
import {
  activateVersion,
  importGoldenTasks,
  promoteProposal,
  proposePlaybook,
  recordEvaluation,
  rejectProposal,
  rollbackPlaybook,
} from './app/playbooks.ts';
import { listInbox, queryTimeline } from './app/audit-query.ts';
import { isAction } from './domain/actions.ts';
import type { AgentRole, EvaluationResult, GoldenTask, PlaybookContent } from './domain/playbook.ts';
import type { AutonomyLevel, ResourceRef } from './domain/types.ts';
import { listAuditEvents, verifyAuditChain } from './infra/audit.ts';
import { openDatabase } from './infra/db.ts';
import { createLocalExecutor } from './infra/executor.ts';
import { listGoldenTasks, listProposals, listVersions } from './infra/playbook-store.ts';
import { tailText } from './infra/text.ts';
import {
  getGoal,
  listEscalations,
  listGrantsForGoal,
  listPlansForGoal,
  listWorkspaces,
} from './infra/store.ts';

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const push = (value: string): void => {
      const existing = flags.get(name);
      if (existing === undefined) flags.set(name, value);
      else if (Array.isArray(existing)) existing.push(value);
      else if (typeof existing === 'string') flags.set(name, [existing, value]);
      else flags.set(name, [value]);
    };
    if (equals !== -1) {
      push(raw.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      push(next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function one(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === 'string' ? value : undefined;
}

function many(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function bool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function required(args: ParsedArgs, name: string): string {
  const value = one(args, name);
  if (!value) throw new Error(`缺少参数 --${name}`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** 摘要输出：只保留尾部日志，避免把完整 Agent 输出刷到终端。 */
function printBuilderRun(result: BuilderRunResult): void {
  print({
    ...result,
    role: { id: result.role.id, role: result.role.role, subject: result.role.subject, actions: result.role.actions },
    agent: result.agent
      ? {
          status: result.agent.status,
          exitCode: result.agent.exitCode,
          durationMs: result.agent.durationMs,
          stdoutTail: tailText(result.agent.stdout, 1000),
          stderrTail: tailText(result.agent.stderr, 1000),
        }
      : null,
    selfChecks: result.selfChecks.map((check) => ({
      ...check,
      stdout: tailText(check.stdout, 500),
      stderr: tailText(check.stderr, 500),
    })),
  });
}

function printGoal(db: DatabaseSync, goalId: string): void {
  const goal = getGoalOrThrow(db, goalId);
  print({
    goal,
    plans: listPlansForGoal(db, goalId).map((plan) => ({ id: plan.id, version: plan.version, status: plan.status })),
    grants: listGrantsForGoal(db, goalId).map((grant) => ({
      id: grant.id,
      subject: grant.subject,
      actions: grant.actions,
      status: grant.status,
    })),
  });
}

const USAGE = `Super-Manner CLI

用法：
  manner init [--db <path>]
  manner goal new --title <t> --repo <owner/repo> [--base main] [--acceptance <a> ...]
                  [--budget 100000] [--autonomy A2] [--by <id>]
  manner goal show <goalId>
  manner goal cancel <goalId> --by <id>
  manner goal pause <goalId> --by <id> [--reason <text>]
  manner goal resume <goalId> --by <id> [--reason <text>]
  manner checkpoint list --goal <goalId>
  manner budget status --goal <goalId>
  manner budget record --goal <goalId> --tokens <n> [--item <id>] [--source builder_run|verification|other] [--by <id>]
  manner budget extend --goal <goalId> --tokens <n> --by <id>
  manner review show --goal <goalId>
  manner review generate --goal <goalId> [--by <id>]
  manner audit timeline [--goal <goalId>] [--actor <id>] [--action <type|action>] [--limit <n>]
  manner audit inbox [--goal <goalId>] [--action <kind|action>]
  manner plan submit <goalId> --file plan.json --by <id>
  manner plan approve <planId> --by <id>
  manner plan reject <planId> --by <id> --reason <text>
  manner grant list --goal <goalId>
  manner workspace create --goal <id> --item <workItemId> --repo-dir <path>
                          [--worktree-root <dir>] [--base <branch>] [--by <id>]
  manner workspace list [--goal <id>] [--active]
  manner workspace cleanup <workspaceId> [--delete-branch] [--force] [--by <id>]
  manner role instantiate --goal <id> --item <workItemId> [--by <id>]
  manner builder run --goal <id> --item <workItemId> [--repo-dir <path>] [--worktree-root <dir>]
                     [--agent codex] [--agent-arg <arg> ...] [--timeout <ms>] [--tokens <n>] [--by <id>]
                     （参数本身以 -- 开头时写成 --agent-arg=--sandbox）
  manner builder commit --goal <id> --item <workItemId> [--message <text>] [--by <id>]
  manner builder push --goal <id> --item <workItemId> [--remote origin] [--by <id>]
  manner builder pr --goal <id> --item <workItemId> [--title <text>] [--body <text>]
                     [--base <branch>] [--remote origin] [--by <id>]
  manner builder reset --goal <id> --item <workItemId> [--reason <text>] [--by <id>]
  manner verify start --goal <id> [--by <id>]
  manner verify context --goal <id> --item <workItemId> [--by <id>]
  manner verify evidence --goal <id> --item <workItemId> [--by <id>]
  manner verify judge --goal <id> --item <workItemId> --file verdicts.json [--by <id>]
  manner verify completion --goal <id> [--by <id>]
  manner verify view --goal <id> [--out <file>] [--by <id>]
  manner acceptance decide --goal <id> --decision accept|rework|close [--reason <text>] --by <id>
  manner escalation list [--pending]
  manner escalation decide <id> --by <id> --approve|--deny [--second <id>] [--reason <text>]
  manner escalation sweep
  manner auth request --goal <id> --subject <id> --action <action> [--repo r] [--branch b] [--path p] [--key k] [--host h]
  manner audit log [--goal <id>]
  manner audit verify
  manner playbook golden import --file golden.json --by <id>
  manner playbook golden list [--role <role>]
  manner playbook propose --role <role> --file playbook.json --by <id>
                          [--rationale <text>] [--goal <id>]
  manner playbook list [--role <role>]
  manner playbook evaluate <proposalId> --file results.json --by <id>
                          [--min-pass-rate 0.8] [--min-tasks 3]
  manner playbook promote <proposalId> --by <id> [--canary 10]
  manner playbook activate <versionId> --by <id>
  manner playbook versions [--role <role>]
  manner playbook rollback --role <role> --by <id> [--reason <text>]
  manner playbook reject <proposalId> --by <id> --reason <text>
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand, third] = args.positional;
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }

  const db = openDatabase(one(args, 'db') ?? process.env.MANNER_DB ?? './manner.db');

  try {
    switch (command) {
      case 'init':
        print({ ok: true, database: one(args, 'db') ?? process.env.MANNER_DB ?? './manner.db' });
        return;

      case 'goal': {
        if (subcommand === 'new') {
          const goal = createGoal(
            db,
            {
              title: one(args, 'title') ?? '',
              description: one(args, 'description') ?? '',
              repo: one(args, 'repo') ?? '',
              baseBranch: one(args, 'base') ?? 'main',
              acceptance: many(args, 'acceptance'),
              constraints: many(args, 'constraint'),
              budgetTokens: Number(one(args, 'budget') ?? 0),
              autonomy: (one(args, 'autonomy') ?? 'A2') as AutonomyLevel,
            },
            one(args, 'by') ?? 'architect',
          );
          print(goal);
          return;
        }
        if (subcommand === 'show' && third) {
          printGoal(db, third);
          return;
        }
        if (subcommand === 'cancel' && third) {
          print(cancelGoal(db, third, required(args, 'by')));
          return;
        }
        if (subcommand === 'pause' && third) {
          print(pauseGoal(db, third, required(args, 'by'), one(args, 'reason') ?? ''));
          return;
        }
        if (subcommand === 'resume' && third) {
          print(resumeGoal(db, third, required(args, 'by'), one(args, 'reason') ?? ''));
          return;
        }
        break;
      }

      case 'plan': {
        if (subcommand === 'submit') {
          const goalId = third;
          if (!goalId) throw new Error('缺少目标 id');
          const file = required(args, 'file');
          const input = JSON.parse(readFileSync(file, 'utf8')) as SubmitPlanInput;
          print(submitPlan(db, goalId, input, one(args, 'by') ?? 'planner'));
          return;
        }
        if (subcommand === 'approve') {
          const planId = third;
          if (!planId) throw new Error('缺少计划 id');
          print(approvePlan(db, planId, required(args, 'by')));
          return;
        }
        if (subcommand === 'reject') {
          const planId = third;
          if (!planId) throw new Error('缺少计划 id');
          print(rejectPlan(db, planId, required(args, 'by'), one(args, 'reason') ?? ''));
          return;
        }
        if (subcommand === 'list' && third) {
          print(listPlansForGoal(db, third));
          return;
        }
        break;
      }

      case 'grant': {
        if (subcommand === 'list') {
          print(listGrantsForGoal(db, required(args, 'goal')));
          return;
        }
        break;
      }

      case 'workspace': {
        if (subcommand === 'create') {
          print(
            createWorkspace(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              repoDir: required(args, 'repo-dir'),
              worktreeRoot: one(args, 'worktree-root'),
              baseBranch: one(args, 'base'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'list') {
          print(
            listWorkspaces(db, {
              goalId: one(args, 'goal'),
              status: bool(args, 'active') ? 'active' : undefined,
            }),
          );
          return;
        }
        if (subcommand === 'cleanup') {
          const workspaceId = third;
          if (!workspaceId) throw new Error('缺少工作区 id');
          print(
            cleanupWorkspace(db, workspaceId, {
              actor: one(args, 'by'),
              deleteBranch: bool(args, 'delete-branch'),
              force: bool(args, 'force'),
            }),
          );
          return;
        }
        break;
      }

      case 'role': {
        if (subcommand === 'instantiate') {
          print(
            instantiateRole(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        break;
      }

      case 'builder': {
        if (subcommand === 'run') {
          const timeout = one(args, 'timeout');
          const timeoutMs = timeout === undefined ? undefined : Number(timeout);
          if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            throw new Error(`--timeout 必须是正整数：${timeout}`);
          }
          const agentArgs = many(args, 'agent-arg');
          const result = await runBuilder(db, {
            goalId: required(args, 'goal'),
            workItemId: required(args, 'item'),
            executor: createLocalExecutor(),
            repoDir: one(args, 'repo-dir'),
            worktreeRoot: one(args, 'worktree-root'),
            agent: {
              command: one(args, 'agent') ?? 'codex',
              args:
                agentArgs.length > 0
                  ? agentArgs
                  : (one(args, 'agent') ?? 'codex') === 'codex'
                    ? ['exec', '--sandbox', 'workspace-write']
                    : [],
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
            tokenUsage: Number(one(args, 'tokens') ?? 0),
            actor: one(args, 'by'),
          });
          printBuilderRun(result);
          return;
        }
        if (subcommand === 'commit') {
          print(
            commitWorkspace(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              message: one(args, 'message'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'push') {
          print(
            pushWorkspace(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              remote: one(args, 'remote'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'pr') {
          print(
            await createPullRequest(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              executor: createLocalExecutor(),
              title: one(args, 'title'),
              body: one(args, 'body'),
              base: one(args, 'base'),
              remote: one(args, 'remote'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'reset') {
          print(
            resetBuilderRetry(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              reason: one(args, 'reason'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        break;
      }

      case 'verify': {
        if (subcommand === 'start') {
          print(
            startVerification(db, {
              goalId: required(args, 'goal'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'context') {
          print(
            buildVerifierContext(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'evidence') {
          print(
            await collectEvidence(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              executor: createLocalExecutor(),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'judge') {
          const input = JSON.parse(readFileSync(required(args, 'file'), 'utf8')) as {
            verdicts: VerdictInput[];
          };
          print(
            recordVerdicts(db, {
              goalId: required(args, 'goal'),
              workItemId: required(args, 'item'),
              verdicts: input.verdicts,
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'completion') {
          print(
            assessCompletion(db, {
              goalId: required(args, 'goal'),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'view') {
          const goalId = required(args, 'goal');
          const view = buildAcceptanceView(db, { goalId, actor: one(args, 'by') });
          const out = resolve(one(args, 'out') ?? `.manner/${goalId.slice(0, 8)}-acceptance.html`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, view.html, 'utf8');
          print({ goalId: view.goalId, complete: view.complete, generatedAt: view.generatedAt, out });
          return;
        }
        break;
      }

      case 'acceptance': {
        if (subcommand === 'decide') {
          const decision = required(args, 'decision');
          if (decision !== 'accept' && decision !== 'rework' && decision !== 'close') {
            throw new Error(`未知验收决定：${decision}`);
          }
          print(
            decideAcceptance(db, {
              goalId: required(args, 'goal'),
              decision: decision as AcceptanceDecision,
              reason: one(args, 'reason'),
              actor: required(args, 'by'),
            }),
          );
          return;
        }
        break;
      }

      case 'escalation': {
        if (subcommand === 'list') {
          print(listEscalations(db, bool(args, 'pending') ? 'pending' : undefined));
          return;
        }
        if (subcommand === 'decide') {
          const id = third;
          if (!id) throw new Error('缺少升级 id');
          print(
            decideEscalation(db, id, {
              approver: required(args, 'by'),
              approve: !bool(args, 'deny'),
              reason: one(args, 'reason'),
              secondApprover: one(args, 'second'),
            }),
          );
          return;
        }
        if (subcommand === 'sweep') {
          print({ expired: sweepExpiredEscalations(db) });
          return;
        }
        break;
      }

      case 'auth': {
        if (subcommand === 'request') {
          const action = required(args, 'action');
          if (!isAction(action)) throw new Error(`未知动作：${action}`);
          const resource: ResourceRef = {};
          const repo = one(args, 'repo');
          const branch = one(args, 'branch');
          const path = one(args, 'path');
          const key = one(args, 'key');
          const host = one(args, 'host');
          if (repo) resource.repo = repo;
          if (branch) resource.branch = branch;
          if (path) resource.path = path;
          if (key) resource.key = key;
          if (host) resource.host = host;
          print(
            requestAction(db, {
              goalId: required(args, 'goal'),
              subject: required(args, 'subject'),
              action,
              resource,
            }),
          );
          return;
        }
        break;
      }

      case 'checkpoint': {
        if (subcommand === 'list') {
          print(getGoalCheckpoints(db, required(args, 'goal')));
          return;
        }
        break;
      }

      case 'budget': {
        const goalId = required(args, 'goal');
        if (subcommand === 'status') {
          print(getBudgetStatus(db, goalId));
          return;
        }
        if (subcommand === 'record') {
          const source = one(args, 'source') ?? 'other';
          if (source !== 'builder_run' && source !== 'verification' && source !== 'other') {
            throw new Error(`未知的用量来源：${source}`);
          }
          print(
            recordTokenUsage(db, {
              goalId,
              workItemId: one(args, 'item'),
              source,
              tokens: Number(required(args, 'tokens')),
              actor: one(args, 'by'),
            }),
          );
          return;
        }
        if (subcommand === 'extend') {
          print(extendBudget(db, goalId, Number(required(args, 'tokens')), required(args, 'by')));
          return;
        }
        break;
      }

      case 'playbook': {
        if (subcommand === 'golden') {
          if (third === 'import') {
            const tasks = JSON.parse(readFileSync(required(args, 'file'), 'utf8')) as Array<
              Omit<GoldenTask, 'createdAt'>
            >;
            print(
              importGoldenTasks(db, {
                tasks: tasks.map((task) => ({ ...task, createdAt: '' })),
                actor: required(args, 'by'),
              }),
            );
            return;
          }
          if (third === 'list') {
            print(listGoldenTasks(db, one(args, 'role') as AgentRole | undefined));
            return;
          }
          throw new Error('用法：playbook golden import|list');
        }
        if (subcommand === 'propose') {
          const role = required(args, 'role') as AgentRole;
          const content = JSON.parse(readFileSync(required(args, 'file'), 'utf8')) as PlaybookContent;
          print(
            proposePlaybook(db, {
              role,
              content,
              rationale: required(args, 'rationale'),
              actor: required(args, 'by'),
              sourceGoalId: one(args, 'goal'),
            }),
          );
          return;
        }
        if (subcommand === 'list') {
          print(listProposals(db, one(args, 'role') as AgentRole | undefined));
          return;
        }
        if (subcommand === 'evaluate') {
          if (!third) throw new Error('用法：playbook evaluate <proposalId> --file results.json');
          const results = JSON.parse(readFileSync(required(args, 'file'), 'utf8')) as EvaluationResult[];
          const minPassRate = one(args, 'min-pass-rate');
          const minTasks = one(args, 'min-tasks');
          print(
            recordEvaluation(db, {
              proposalId: third,
              results,
              actor: required(args, 'by'),
              ...(minPassRate === undefined ? {} : { minPassRate: Number(minPassRate) }),
              ...(minTasks === undefined ? {} : { minTasks: Number(minTasks) }),
            }),
          );
          return;
        }
        if (subcommand === 'promote') {
          if (!third) throw new Error('用法：playbook promote <proposalId> --by <id> [--canary 10]');
          const canary = one(args, 'canary');
          print(
            promoteProposal(db, {
              proposalId: third,
              actor: required(args, 'by'),
              ...(canary === undefined ? {} : { canaryPercent: Number(canary) }),
            }),
          );
          return;
        }
        if (subcommand === 'activate') {
          if (!third) throw new Error('用法：playbook activate <versionId> --by <id>');
          print(activateVersion(db, { versionId: third, actor: required(args, 'by') }));
          return;
        }
        if (subcommand === 'versions') {
          print(listVersions(db, one(args, 'role') as AgentRole | undefined));
          return;
        }
        if (subcommand === 'rollback') {
          print(
            rollbackPlaybook(db, {
              role: required(args, 'role') as AgentRole,
              actor: required(args, 'by'),
              reason: one(args, 'reason'),
            }),
          );
          return;
        }
        if (subcommand === 'reject') {
          if (!third) throw new Error('用法：playbook reject <proposalId> --by <id> --reason <text>');
          print(
            rejectProposal(db, {
              proposalId: third,
              actor: required(args, 'by'),
              reason: required(args, 'reason'),
            }),
          );
          return;
        }
        break;
      }

      case 'review': {
        const goalId = required(args, 'goal');
        if (subcommand === 'show') {
          print(buildReview(db, goalId));
          return;
        }
        if (subcommand === 'generate') {
          print(generateReview(db, goalId, one(args, 'by') ?? 'human'));
          return;
        }
        break;
      }

      case 'audit': {
        if (subcommand === 'log') {
          print(listAuditEvents(db, one(args, 'goal')));
          return;
        }
        if (subcommand === 'verify') {
          print(verifyAuditChain(db));
          return;
        }
        if (subcommand === 'timeline') {
          const limit = one(args, 'limit');
          print(
            queryTimeline(db, {
              goalId: one(args, 'goal'),
              actor: one(args, 'actor'),
              subject: one(args, 'subject'),
              action: one(args, 'action'),
              limit: limit === undefined ? undefined : Number(limit),
            }),
          );
          return;
        }
        if (subcommand === 'inbox') {
          print(listInbox(db, { goalId: one(args, 'goal'), action: one(args, 'action') }));
          return;
        }
        break;
      }

      default:
        break;
    }

    throw new Error(`未知命令：${args.positional.join(' ')}`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${(error as Error).message}`);
  process.exitCode = 1;
});