# S3 验证与验收设计

> 范围：P0 的验证上下文、证据、逐条判定、完成判定与验收视图
> 依赖：[S2 隔离执行设计](s2-execution.md)

## 1. 目标与边界

- 验证者独立于实现者：看不到 Builder 的会话、工具调用、思路与自评。
- 判断只依据目标、验收标准、工作项完成标准与代码差异。
- 证据可复现、可核对、可归属；有"不通过"或"无法判定"时不得判定完成。
- P0 不自动合并 PR，最终接受由人做出。

**非目标**：验证者自行修改实现；自动降低验收标准；跨仓库验证。

## 2. S3-01 独立验证上下文

`buildVerifierContext(db, { goalId, workItemId })` 生成一段验证提示词：

| 输入 | 来源 | 说明 |
| --- | --- | --- |
| 目标 | `getGoalOrThrow` | 标题、仓库、验收标准、约束 |
| 工作项 | 已批准计划 | 标题、完成标准、预算 |
| 差异 | 工作区 `git diff <base>` | 基线优先取目标 `baseBranch`，否则退回工作区基线 |
| 文件清单 | `git diff --name-only` + 未跟踪文件 | 去重排序 |

刻意不读取的内容：`builder.run_started` / `builder.run_finished` 的 stdout、stderr、自评，
以及任何 Agent 会话标识。隔离靠"不查询"实现，而不是靠提示词约束。

产物：

- `prompt`：给 Verifier 的完整输入；
- `promptHash`：sha256，进入审计，便于事后确认验证者看到的是哪一版上下文；
- `diffTruncated`：差异超过 20000 字符时截断并显式标注。

审计事件 `verifier.context_built` 记录工作项、分支、基线、文件清单、差异字节数与提示词哈希。

```bash
manner verify context --goal <goalId> --item build --by verifier-1
```

## 3. S3-02 证据采集

`collectEvidence(db, { goalId, workItemId, executor })` 在活跃工作区里重跑自检命令，把结果固化为证据：

| 字段 | 内容 |
| --- | --- |
| `name` / `command` / `args` | 自检名称与完整命令，默认识别 `typecheck`、`test` 脚本 |
| `cwd` | 工作区绝对路径 |
| `status` / `exitCode` | `succeeded`、`failed`、`timed_out`、`spawn_error` 与退出码 |
| `startedAt` / `endedAt` / `durationMs` | 起止时间与耗时 |
| `stdout` / `stderr` | 每条流保留尾部 4000 字符 |
| `hash` | `command + args + 记录中的输出` 的 sha256，可离线重算 |
| `env` | Node 版本、平台、架构、cwd、分支与 HEAD |

采集前校验已批准计划、工作项与活跃工作区；采集后追加 `verifier.evidence_collected`，
payload 同时保存工作区、分支、HEAD 与全部证据，便于只凭审计复核。

刻意不记录完整环境变量（可能含密钥），只保留与重跑相关的快照。

```bash
manner verify evidence --goal <goalId> --item build --by verifier-1
```

## 4. S3-03 逐条判定

`recordVerdicts(db, { goalId, workItemId, verdicts })` 把验证结论固化为审计事件：

| 字段 | 说明 |
| --- | --- |
| `criterion` | 必须是目标验收标准或工作项完成标准之一 |
| `result` | `passed`（通过）/ `failed`（不通过）/ `undetermined`（无法判定） |
| `note` | 判定依据，不允许为空 |
| `evidence` | 可选，引用最近一次证据采集里的 id 或哈希 |

校验规则：

- 每条标准恰好一条结论；缺条目、未知标准、重复判定都拒绝写入；
- 引用的证据必须存在于最近一次 `verifier.evidence_collected`；
- 任一校验失败时不写审计，判定与证据保持原样。

摘要包含总数、通过、不通过、无法判定；只有全部通过时 `complete` 才为 `true`。
历史判定不被覆盖：每次记录都是新审计事件，`getLatestVerdicts` 取最近一次，
S3-04 的完成判定据此与证据交叉核对。

```bash
manner verify judge --goal <goalId> --item build --file verdicts.json --by verifier-1
```

```json
{
  "verdicts": [
    { "criterion": "错误密码时展示提示文案", "result": "passed", "note": "差异中新增错误分支", "evidence": ["<evidenceId>"] },
    { "criterion": "覆盖失败路径", "result": "undetermined", "note": "测试未覆盖失败分支" }
  ]
}
```

## 5. S3-04 完成判定

`assessCompletion(db, { goalId })` 做工作项与目标两级 DoD：

| 级别 | 完成条件 |
| --- | --- |
| 工作项 | 有最近一次证据采集；证据绑定本轮提交与采集批次；逐条判定绑定同一 `collectionId` 且没有"不通过"或"无法判定"；证据 `head`、判定 `evaluatedHead`、最新提交检查点与推送 SHA 一致；builder 工作区无未提交改动且 HEAD 等于交付提交 |
| 目标 | 已批准计划里的全部工作项都完成 |

证据采集只针对待交付提交：工作区必须干净，HEAD 必须等于最新提交检查点；采集结果带 `collectionId` 与 `reworkRound`。判定必须绑定最新采集批次和当前轮次，换一批采集或返工后旧判定自动失效。完成判定在人工接受前会再次核对工作区状态。

返回每个工作项的标准数、通过数、不通过数、无法判定数、未完成原因与时间戳，
以及目标级结论。判定只读，不改变目标状态；接受或返工由 S3-06 的人工决定推进。

验证阶段由 `manner verify start` 开启。目标必须处于 `executing`，无前置依赖的 Builder 工作项必须有活跃工作区与提交检查点。下游 Builder 等前置工作项验证完成后，可以在目标处于 `verifying` 时开始。返工产生新提交后，证据仍指向旧提交时，完成判定会阻塞。

`manner verify submit --goal <id>` 在完成判定通过后将目标转为 `awaiting_acceptance`，出现在 `manner audit inbox` 中。人工验收前会重新计算完成判定。

每次判定都追加 `verifier.completion_assessed`，失败结论同样留痕，避免"重跑到绿"覆盖历史。

```bash
manner verify start --goal <goalId> --by verifier-1
manner verify completion --goal <goalId> --by verifier-1
manner verify submit --goal <goalId> --by verifier-1
```

## 6. S3-05 验收视图

`buildAcceptanceView(db, { goalId })` 生成一份自包含 HTML，供人直接做接受或返工决定：

| 区块 | 内容 |
| --- | --- |
| 头部 | 标题、描述、仓库、基线、自治级别、预算 |
| 结论 | 两级完成判定结果；未完成时列出阻塞原因 |
| 标准 | 目标验收标准与约束 |
| 工作项 | 角色、预算、完成标准、逐条判定（结论/说明/证据）、证据命令与哈希、工作区差异 |
| 风险与待决 | 计划风险；已批准计划的待决事项与尚未裁决的升级 |

视图只读，不改变任何状态；生成动作记 `acceptance.view_built`。默认输出到
`.manner/<goal 前 8 位>-acceptance.html`，可用 `--out` 指定位置。

```bash
manner verify view --goal <goalId> --out acceptance.html --by verifier-1
```

## 7. S3-06 验收决定

`decideAcceptance(db, { goalId, decision, reason, actor })` 由人给出最终结论，三种决定各自对应一条状态迁移：

| 决定 | 前置状态 | 结果 | 授权 |
| --- | --- | --- | --- |
| accept | verifying / awaiting_acceptance，且完成判定通过 | verifying → awaiting_acceptance → completed | 全部吊销 |
| rework | verifying / awaiting_acceptance | 回到 executing，Builder 可再次运行 | 保留 |
| close | executing / verifying / awaiting_acceptance / blocked | 走 `cancelGoal`，未决升级过期 | 全部吊销 |

规则：

- accept 前必须重新执行完成判定；不通过时抛出原因，状态保持不动，不允许"先接受再补证据"。
- rework 与 close 必须写明原因，避免事后无法解释为什么退回或关闭。
- rework 不删除历史证据与判定，只改目标状态；下一次 `builder run` 产生新的 Run，判定历史按追加顺序保留。
- 每次决定都追加 `acceptance.decided`，payload 含决定、原因、结束状态、完成结论与吊销授权数；close 的吊销数取自取消前的活跃授权数。

```bash
manner acceptance decide --goal <goalId> --decision accept --by human-1
manner acceptance decide --goal <goalId> --decision rework --reason "补充失败路径测试" --by human-1
manner acceptance decide --goal <goalId> --decision close --reason "需求取消" --by human-1
```

## 8. S3-07 端到端含返工

`test/e2e-rework.test.ts` 在同一个目标上串起完整闭环，验证返工不会覆盖历史：

| 阶段 | 动作 | 期望 |
| --- | --- | --- |
| 第一轮执行 | `builder run` 写入实现 | 产生第 1 个 Run |
| 第一轮验证 | `collectEvidence` + `recordVerdicts`（1 条不通过、1 条无法判定） | 完成判定阻塞并给出原因 |
| 返工 | `decideAcceptance(rework)` | 目标回到 executing，证据与判定保留 |
| 第二轮执行 | 再次 `builder run`，不重建工作区 | 复用同一 worktree，产生第 2 个 Run |
| 第二轮验证 | 重新采集证据并全部判定通过 | 完成判定通过 |
| 验收 | `decideAcceptance(accept)` | 目标 completed，授权全部吊销 |

断言直接读审计链：两轮各自留下 `verifier.evidence_collected` 与
`verifier.verdicts_recorded`，第一轮的"不通过 / 无法判定"仍在；`getLatestEvidence` /
`getLatestVerdicts` 取到第二轮记录，说明历史只追加、不覆盖。

## 9. 测试映射

| 任务 | 测试 |
| --- | --- |
| S3-01 只含目标、标准与差异 | `verification.test.ts` · 验证上下文只含目标、标准与差异，不含实现过程 |
| S3-01 无工作区时拒绝 | `verification.test.ts` · 没有活跃工作区时不能构建验证上下文 |
| 验证阶段入口 | `cli.test.ts` · CLI 可以从执行态进入验证态 |
| 验证阶段守卫 | `verification.test.ts` · 执行阶段不能做验证动作 |
| S3-02 证据含命令、环境、时间与哈希 | `evidence.test.ts` · 证据记录命令、环境、时间与哈希，他人可据此重跑 |
| S3-02 无工作区时拒绝 | `evidence.test.ts` · 没有活跃工作区时不能采集证据 |
| S3-03 覆盖全部标准并保留历史 | `verdicts.test.ts` · 逐条判定覆盖全部标准并保留历史 |
| S3-03 校验条目与说明 | `verdicts.test.ts` · 缺条目、未知标准、重复与空说明都被拒绝 |
| S3-03 证据引用校验 | `verdicts.test.ts` · 引用不存在的证据被拒绝 |
| S3-04 两级 DoD | `completion.test.ts` · 证据与逐条判定齐备时才判定完成 |
| S3-04 不通过不得完成 | `completion.test.ts` · 有"不通过"或"无法判定"时不得完成，改判后以最新一次为准 |
| S3-04 任一工作项未完成即阻塞目标 | `completion.test.ts` · 任一工作项缺证据或缺判定时目标不得完成 |
| S3-04 证据时效 | `completion.test.ts` · 证据之后出现新提交时不得完成；返工后未重新采集证据不得完成 |
| S3-04 采集批次绑定 | `completion.test.ts` · 同一提交重新采集证据后必须重新判定 |
| S3-04 返工轮次绑定 | `completion.test.ts` · 返工但提交未变化时，上一轮证据与判定不得完成验收 |
| S3-04 工作区洁净 | `completion.test.ts` · 工作区存在未提交改动时不得完成 |
| S3-02 采集前洁净 | `evidence.test.ts` · 工作区存在未提交改动时不能采集证据 |
| S3-06 验收前复查 | `acceptance.test.ts` · 提交验收后仍会重新检查完成条件 |
| S3-05 视图汇总与可验收标注 | `acceptance-view.test.ts` · 验收视图汇总目标、差异、证据、风险与待决，并标注可验收 |
| S3-05 未完成时列出阻塞原因 | `acceptance-view.test.ts` · 未完成时视图列出阻塞原因 |
| S3-06 接受后完成并吊销授权 | `acceptance.test.ts` · 接受后目标完成、授权全部失效且不能再操作 |
| S3-06 完成判定不通过不得接受 | `acceptance.test.ts` · 完成判定未通过时不能接受 |
| S3-06 返工保留历史并产生新 Run | `acceptance.test.ts` · 返工回到执行态，历史结论保留并可产生新 Run |
| S3-06 关闭取消目标 | `acceptance.test.ts` · 关闭目标会取消并吊销授权 |
| S3-07 返工闭环 | `e2e-rework.test.ts` · 一次不通过后返工并通过，历史证据不被覆盖 |

## 10. 已知边界

| 边界 | 现状 | 去向 |
| --- | --- | --- |
| 未提交改动 | 证据采集与完成判定都会拒绝有未提交改动的工作区 | 需要时支持显式快照 |
| 差异截断 | 超过 20000 字符截断并标注 | 需要时按文件分段 |
| 提示词版本 | 只记录哈希，不保存正文 | S3-05 验收视图可保存快照 |
| 证据输出 | 每条流只保留尾部 4000 字符，哈希基于保留内容 | 需要完整日志时另行落盘 |
| 证据来源 | 只重跑自检命令，不重新执行 Agent | 复杂验证由 S3-03 判定补充 |
| 判定录入 | 由验证者（人或 Agent）产出 JSON 后写入，不在服务内自动调用模型 | S3-07 端到端可编排调用 |
| 判定粒度 | 以标准文本为键，跨来源同文标准合并为一条 | 需要区分来源时改结构化 id |
| 完成判定 | `verify completion` 查询结果，`verify submit` 将通过的目标交给人工验收 | `acceptance decide` 记录最终决定 |
| 验收决定入口 | 只提供 CLI，需要人显式执行；没有推送通知或超时自动决定 | 需要时接 IM 卡片或工作流 |
| 返工后的证据 | 旧证据与旧判定保留；采集批次与返工轮次绑定，换批或返工后必须重新采集并重新判定 | 追加顺序保留，collectionId / reworkRound 不匹配即阻塞 |
| 证据时效 | 已绑定采集批次、返工轮次、证据/判定/最新提交/推送 SHA；采集与验收都会拒绝未提交改动 | 需要时补完整工作区快照 |
| 验收视图 | 单文件 HTML，无脚本；未跟踪文件的改动内容不展示 | 需要时内嵌完整差异或附件 |
| 返工闭环 | 由测试串起 `builder run` / 验证 / 验收决定，CLI 仍是分步入口 | 需要时补一键脚本 |
| 视图审计 | 只记录结论与生成时间，不保存 HTML 快照 | 需要归档时把文件纳入产物 |
