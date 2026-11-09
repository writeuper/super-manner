# P0 真实模型执行记录（2026-11-09）

> 结论：真实模型已通过 Codex CLI 与 Rootcloud 网关完成一次 Builder 执行：只修改 `README.md`、自检 1/1 通过、提交并推送。随后在同一分支完成验证、判定、验收与复盘，35 条审计事件校验通过。
>
> 边界：PR 尚未创建（本机没有 `gh`，浏览器未登录 GitHub）；验证判定由操作者依据独立验证上下文与证据逐条给出，不是独立 Verifier 模型。生产级 OS 隔离仍未实现。

## 1. 环境与边界

| 项 | 值 |
| --- | --- |
| 代码版本 | `super-manner` `feature/p0-closure` @ `76e8dda`（独立 worktree） |
| 运行环境 | macOS 26.4 · arm64 · Node v24.22.0 |
| Agent | Codex CLI `0.163.0`，独立 `CODEX_HOME`，`exec --sandbox workspace-write` |
| 模型 | 网关别名 `deepseek-flash`，通过 Rootcloud OpenAI-compatible 网关的 Responses API |
| 沙箱仓库 | `writeuper/super-manner-e2e`（私有），基线 `main` @ `ecc99fc` |
| 真实部分 | 模型调用、GitHub 仓库、分支、提交、推送、自检命令、证据、审计、人工验收 |
| 未执行部分 | PR 创建；生产环境发布；独立 Verifier 模型判定 |

网关探测请求中，`deepseek-flash` 被解析为 `svc/ack-dev`（`resolved_model_used`）；Builder 通过同一 provider 与模型别名调用。模型身份以网关路由结果为准。

## 2. 交付标识

| 项 | 值 |
| --- | --- |
| Goal | `7ff64413-4d08-4c8a-a4fd-9eb047a0af86` |
| Plan | `c4869919-a367-4825-b59d-856b885886ce`（v1，approved） |
| Builder Run | `d5f00de3-9158-43b7-9846-e36d3ec2154d` |
| Workspace | `270d6e24-d15c-4a04-9a33-390a74ae2401` |
| 分支 | `feature/sm-7ff64413-build` |
| 交付提交 / 推送 SHA | `f957e2384d7e4ffb0333530948d4f5a1af4e3f96` |
| 证据采集 | `87ba984e-d9a8-4ce1-b134-d6a75cb7bd4c` · `reworkRound=1` |
| 判定记录 | `9df46c4a-1080-4157-96cc-945bd3f54328` |
| 实际 token | 12,032（Codex 输出 `tokens used`，补记入预算） |
| 预算 | 目标 60,000 · 工作项 45,000 · 已用 12,032 · 剩余 47,968 |
| 审计 | 35 条事件，`audit verify` 通过 |

## 3. 链路结果

| 步骤 | 结果 |
| --- | --- |
| 目标与计划 | `draft` → `pending_confirmation` → `executing`，计划批准后签发 1 个 builder Grant |
| Builder 运行 | `succeeded`，18.3s；Agent 报告只改 `README.md`，未提交或推送 |
| 自检 | `npm run test` 通过，`node --test` 1 passed / 0 failed |
| 提交与推送 | `builder.committed` / `builder.pushed`，提交 SHA 与推送 SHA 一致 |
| 进入验证 | `verify start` 将目标从 `executing` 推进到 `verifying` |
| 验证上下文 | 只含目标、标准、分支与 diff；`changedFiles=[README.md]`，6 行新增；`promptHash=afd7c95b…` |
| 证据 | `npm run test`，证据哈希 `7a4b9cbf…`，HEAD 等于交付提交 |
| 判定 | 3/3 通过，绑定同一证据采集批次与轮次，`evaluatedHead=f957e23…` |
| 完成判定 | `goal.complete=true`；证据提交、判定提交、最新提交与推送 SHA 均为 `f957e23…` |
| 待验收 | `verify submit` → `awaiting_acceptance` |
| 人工接受 | `accept` → `completed`，吊销 2 个 Grant |
| 复盘 | 预算 12,032 / 60,000；失败 0；偏差 0；人工介入 2 |
| 审计 | 35 条事件，`audit verify` 通过 |

## 4. 证据与判定

证据命令：`npm run test`（工作目录为工单 worktree，分支 `feature/sm-7ff64413-build`，HEAD `f957e23…`）。

| 标准 | 结论 | 依据 |
| --- | --- | --- |
| `README.md` 包含二级标题 `## Real model execution record` | 通过 | 验证上下文 diff 显示该标题被新增 |
| 该段落包含 `deepseek-flash` 与 `2026-11-09` | 通过 | diff 中段落同时包含模型名与日期 |
| 不修改 `README.md` 之外的文件 | 通过 | `changedFiles` 仅 `README.md`；1 file changed, 6 insertions |

验证上下文刻意不读取 Builder 的会话、工具调用、思路或自评；判定只依据目标、验收标准、完成标准与 diff。判定由本次操作者逐条给出，并引用同一采集批次的证据。

## 5. 审计事件分布

```text
goal.created 1 · plan.submitted 1 · plan.approved 1 · goal.status_changed 5
grants.issued 1 · grants.revoked 1 · role.instantiated 3 · workspace.created 1
auth.allowed 3 · builder.run_started 1 · builder.run_spawned 1 · builder.run_finished 1
checkpoint.recorded 3 · builder.committed 1 · builder.pushed 1 · budget.consumed 1
verification.started 1 · verifier.context_built 1 · verifier.evidence_collected 1
verifier.verdicts_recorded 1 · verifier.completion_assessed 1 · acceptance.submitted 1
acceptance.view_built 1 · acceptance.decided 1 · review.generated 1
```

## 6. 真实与替身

| 项 | 状态 |
| --- | --- |
| 模型调用 | 真实：Codex CLI → Rootcloud 网关 → `deepseek-flash` |
| Agent 工具循环 | 真实：Codex `exec` 在 worktree 内执行 shell 与文件修改 |
| 仓库、分支、提交、推送 | 真实：私有 GitHub 沙箱仓库 |
| 自检与证据 | 真实：`npm run test` 在工作区重跑并记录哈希 |
| 验证判定 | 操作者依据独立上下文逐条给出，非独立 Verifier 模型 |
| 验收决定 | 以 `human-1` 记录，由本次操作者模拟人工验收 |
| PR 创建 | 未执行：本机无 `gh`，浏览器未登录 GitHub |
| 生产发布 | 未执行；P0 明确排除自动发布 |

## 7. 遗留

1. **PR 创建待补**：分支已推送，比较页为
   `https://github.com/writeuper/super-manner-e2e/compare/main...feature/sm-7ff64413-build?expand=1`。
   创建 PR 需要 GitHub 登录或可用 token；本次没有执行。
2. **代码分支未合并**：本次运行基于 `feature/p0-closure`，该分支仍未合入 `main`。
3. **单仓库、单目标**：未覆盖跨仓库、多工作项并行与冲突处理。
4. **隔离边界**：super-manner 目前提供 worktree 与动作授权，不是 OS 级沙箱；生产环境仍需专用执行账户或容器隔离。
5. **Token 记账**：Builder 运行时以 `--tokens 0` 启动，运行结束后从 Codex 输出解析 12,032 并补记 `budget.consumed`；未把估算值冒充实际用量。

## 8. 复现路径

```bash
# 1. 独立运行目录与代码
git worktree add --detach <run>/code origin/feature/p0-closure
git clone git@github.com:writeuper/super-manner-e2e.git <run>/repo

# 2. 独立 DB
export MANNER_DB=<run>/state/manner.db
manner init --db "$MANNER_DB"

# 3. 目标与计划
manner goal new --title "在 README 记录一次真实模型执行" \
  --repo writeuper/super-manner-e2e --base main \
  --acceptance "README.md 包含二级标题 ## Real model execution record" \
  --acceptance "该段落包含 deepseek-flash 与 2026-11-09" \
  --constraint "只修改 README.md" --budget 60000 --autonomy A2 --by architect
manner plan submit <goalId> --file plan.json --by planner
manner plan approve <planId> --by architect

# 4. 真实模型 Builder（Codex 使用独立 CODEX_HOME；密钥只走环境变量）
export CODEX_HOME=<run>/codex-home
export ROOTCLOUD_API_KEY=<gateway-key>
manner builder run --goal <goalId> --item build \
  --repo-dir <run>/repo --worktree-root <run>/worktrees \
  --agent codex --timeout 900000 --tokens 0 --by builder-1

# 5. 提交、推送、验证、验收、复盘
manner budget record --goal <goalId> --tokens 12032 --item build --source builder_run --by builder-1
manner builder commit --goal <goalId> --item build --message "docs: record real model execution (deepseek-flash)" --by builder-1
manner builder push --goal <goalId> --item build --by builder-1
manner verify start --goal <goalId> --by verifier-1
manner verify context --goal <goalId> --item build --by verifier-1
manner verify evidence --goal <goalId> --item build --by verifier-1
manner verify judge --goal <goalId> --item build --file verdicts.json --by verifier-1
manner verify completion --goal <goalId> --by verifier-1
manner verify submit --goal <goalId> --by verifier-1
manner acceptance decide --goal <goalId> --decision accept --by human-1
manner review generate --goal <goalId> --by human-1
manner audit verify
```

`CODEX_HOME` 中的 provider 配置使用 `wire_api = "responses"`、`env_key = "ROOTCLOUD_API_KEY"`，不把密钥写入仓库或运行记录。

## 9. 运行产物

本次运行的 DB、worktree、验收 HTML、审计 JSON 与命令输出位于本机：

```text
super-manner/.tmp/real-model-2026-11-09/
├── artifacts/   # goal/plan/builder/evidence/judge/acceptance/audit JSON 与 acceptance.html
├── code/        # p0-closure 运行代码
├── repo/        # sandbox 仓库克隆
├── state/       # manner.db
└── worktrees/   # 工单 worktree
```

`.tmp/` 已在 `.gitignore` 中，运行产物不纳入仓库；本文只记录可复核的标识、命令与哈希。