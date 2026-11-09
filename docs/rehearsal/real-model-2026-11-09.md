# P0 真实模型执行记录（2026-11-09）

> 结论：真实模型 `ali/deepseek-v4.1-flash-1017` 已通过 Codex CLI 与 4090 网关完成一次 Builder 执行：只修改 `README.md`、自检 1/1 通过、提交并推送。随后在同一分支完成验证、判定、验收与复盘，35 条审计事件校验通过。
>
> 模型变更：本次记录最初使用 `deepseek-flash` 跑过一次（旧沙箱 PR #2）；按指定模型替换为 `ali/deepseek-v4.1-flash-1017` 后重跑，以下以最终运行为准。旧 PR #2 已关闭。
>
> 边界：沙箱 PR #3 已创建并合并（merge commit `01c2839`）；验证判定由操作者依据独立验证上下文与证据逐条给出，不是独立 Verifier 模型。生产级 OS 隔离仍未实现。

## 1. 环境与边界

| 项 | 值 |
| --- | --- |
| 代码版本 | `super-manner` `feature/p0-closure` @ `76e8dda`（独立 worktree） |
| 运行环境 | macOS 26.4 · arm64 · Node v24.22.0 |
| Agent | Codex CLI `0.163.0`，独立 `CODEX_HOME`，`exec --sandbox workspace-write` |
| 模型 | `ali/deepseek-v4.1-flash-1017`，4090 网关，Responses API |
| 网关路由 | `provider=ali`，`resolved_model_used=deepseek-v4.1-flash-1017` |
| 沙箱仓库 | `writeuper/super-manner-e2e`（私有），基线 `main` @ `ecc99fc` |
| 真实部分 | 模型调用、GitHub 仓库、分支、提交、推送、自检命令、证据、审计、人工验收 |
| 未执行部分 | 沙箱 PR #3 创建（GitHub 表单限流）；生产环境发布；独立 Verifier 模型判定 |

## 2. 交付标识

| 项 | 值 |
| --- | --- |
| Goal | `223deb44-b1db-440d-80d6-44a8d1e1d771` |
| Plan | `0cbc72ac-0da5-4368-96b0-69f34f01c2ae`（v1，approved） |
| Builder Run | `9707ea02-fecf-4c84-aa40-a06ec59143a2` |
| Workspace | `dc742a84-94c3-45e0-b456-dbb93f632e46` |
| 分支 | `feature/sm-223deb44-build` |
| 交付提交 / 推送 SHA | `c90d82b43f09d1ddd39083844b963808b4a8c7ba` |
| 证据采集 | `c794bc2f-14c2-4b89-a360-28c578c02b14` · `reworkRound=1` |
| 证据记录 | `8bc35b34-f5db-4750-8efb-c0beeede5ef4` · 哈希 `bc23053b…` |
| 判定记录 | `42d2cd2c-21e9-42c8-affb-a0b9c8241a60` |
| 实际 token | 2,299（Codex 输出 `tokens used`，补记入预算） |
| 预算 | 目标 60,000 · 工作项 45,000 · 已用 2,299 · 剩余 57,701 |
| 审计 | 35 条事件，`audit verify` 通过 |

## 3. 链路结果

| 步骤 | 结果 |
| --- | --- |
| 目标与计划 | `draft` → `pending_confirmation` → `executing`，计划批准后签发 1 个 builder Grant |
| Builder 运行 | `succeeded`，7.4s；Agent 报告只改 `README.md`，未提交或推送 |
| 自检 | `npm run test` 通过，`node --test` 1 passed / 0 failed |
| 提交与推送 | `builder.committed` / `builder.pushed`，提交 SHA 与推送 SHA 一致 |
| 进入验证 | `verify start` 将目标从 `executing` 推进到 `verifying` |
| 验证上下文 | 只含目标、标准、分支与 diff；`changedFiles=[README.md]`，6 行新增；`promptHash=c2a6403d…` |
| 证据 | `npm run test`，HEAD 等于交付提交，证据哈希 `bc23053b…` |
| 判定 | 3/3 通过，绑定同一证据采集批次与轮次，`evaluatedHead=c90d82b…` |
| 完成判定 | `goal.complete=true`；证据提交、判定提交、最新提交与推送 SHA 均为 `c90d82b…` |
| 待验收 | `verify submit` → `awaiting_acceptance` |
| 人工接受 | `accept` → `completed`，吊销 2 个 Grant |
| 复盘 | 预算 2,299 / 60,000；失败 0；偏差 0；人工介入 2 |
| 审计 | 35 条事件，`audit verify` 通过 |

## 4. 证据与判定

证据命令：`npm run test`（工作目录为工单 worktree，分支 `feature/sm-223deb44-build`，HEAD `c90d82b…`）。

| 标准 | 结论 | 依据 |
| --- | --- | --- |
| `README.md` 包含二级标题 `## Real model execution record` | 通过 | 验证上下文 diff 显示该标题被新增 |
| 该段落包含 `ali/deepseek-v4.1-flash-1017` 与 `2026-11-09` | 通过 | diff 中段落同时包含模型名与日期 |
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
| 模型调用 | 真实：Codex CLI → 4090 网关 → `ali/deepseek-v4.1-flash-1017` |
| Agent 工具循环 | 真实：Codex `exec` 在 worktree 内执行 shell 与文件修改 |
| 仓库、分支、提交、推送 | 真实：私有 GitHub 沙箱仓库 |
| 自检与证据 | 真实：`npm run test` 在工作区重跑并记录哈希 |
| 验证判定 | 操作者依据独立上下文逐条给出，非独立 Verifier 模型 |
| 验收决定 | 以 `human-1` 记录，由本次操作者模拟人工验收 |
| 沙箱 PR #3 | 已创建并合并：PR #3，merge commit `01c2839`；`main` 已包含 ali 记录 |
| 旧沙箱 PR #2 | `deepseek-flash` 首次记录，已关闭并标记 superseded |
| 生产发布 | 未执行；P0 明确排除自动发布 |

## 7. 遗留

1. **PR 状态**：沙箱 PR #3 已创建并合并（`main` @ `01c2839`）；旧 PR #2 已关闭并标记 superseded。
2. **代码分支未合并**：本次运行基于 `feature/p0-closure`，该分支仍未合入 `main`。
3. **单仓库、单目标**：未覆盖跨仓库、多工作项并行与冲突处理。
4. **隔离边界**：super-manner 目前提供 worktree 与动作授权，不是 OS 级沙箱；生产环境仍需专用执行账户或容器隔离。
5. **Token 记账**：Builder 运行时以 `--tokens 0` 启动，运行结束后从 Codex 输出解析 2,299 并补记 `budget.consumed`。

## 8. 复现路径

```bash
# 1. 独立运行目录与代码
git worktree add --detach <run>/code origin/feature/p0-closure
git clone git@github.com:writeuper/super-manner-e2e.git <run>/repo

# 2. 独立 DB
export MANNER_DB=<run>/state/manner.db
manner init --db "$MANNER_DB"

# 3. 目标与计划
manner goal new --title "在 README 记录一次 ali/deepseek-v4.1-flash-1017 真实模型执行" \
  --repo writeuper/super-manner-e2e --base main \
  --acceptance "README.md 包含二级标题 ## Real model execution record" \
  --acceptance "该段落包含 ali/deepseek-v4.1-flash-1017 与 2026-11-09" \
  --constraint "只修改 README.md" --budget 60000 --autonomy A2 --by architect
manner plan submit <goalId> --file plan.json --by planner
manner plan approve <planId> --by architect

# 4. 真实模型 Builder（Codex 使用独立 CODEX_HOME；密钥只走环境变量）
export CODEX_HOME=<run>/codex-home
export ALI_API_KEY=<gateway-key>
manner builder run --goal <goalId> --item build \
  --repo-dir <run>/repo --worktree-root <run>/worktrees \
  --agent codex --timeout 900000 --tokens 0 --by builder-1

# 5. 提交、推送、验证、验收、复盘
manner budget record --goal <goalId> --tokens 2299 --item build --source builder_run --by builder-1
manner builder commit --goal <goalId> --item build --message "docs: record real model execution (ali deepseek-v4.1-flash-1017)" --by builder-1
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

`CODEX_HOME` 中的 provider 配置使用 `wire_api = "responses"`、`env_key = "ALI_API_KEY"`，不把密钥写入仓库或运行记录。

## 9. 运行产物

本次运行的 DB、worktree、验收 HTML、审计 JSON 与命令输出位于本机：

```text
super-manner/.tmp/real-model-2026-11-09-ali/
├── artifacts/   # goal/plan/builder/evidence/judge/acceptance/audit JSON 与 acceptance.html
├── code/        # p0-closure 运行代码
├── repo/        # sandbox 仓库克隆
├── state/       # manner.db
└── worktrees/   # 工单 worktree
```

`.tmp/` 已在 `.gitignore` 中，运行产物不纳入仓库；本文只记录可复核的标识、命令与哈希。