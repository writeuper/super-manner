# S4 生命周期与归档设计

> 范围：P0 的暂停恢复、取消吊销、预算计量、失败分类、复盘与审计查询
> 依赖：[S2 隔离执行设计](s2-execution.md)、[S3 验证与验收设计](s3-verification.md)

## 1. 目标与边界

- 生命周期操作只改状态与记录，不重写历史。
- 暂停可恢复，恢复后不重复已完成的写操作；取消不可恢复并吊销授权。
- 检查点只记录"已经发生的写操作"，不是计划，也不是新的执行入口。

**非目标**：中断正在执行的 Agent 进程（由取消场景的级联停止处理）；自动生成改进提案（P1）。

## 2. S4-01 暂停与恢复

### 2.1 状态与转换

`GoalStatus` 增加 `paused`，并在目标上增加 `pausedFrom` 记录暂停前的阶段：

| 当前状态 | 允许暂停 | 恢复目标 |
| --- | --- | --- |
| `executing` | 是 | `executing` |
| `verifying` | 是 | `verifying` |
| `blocked` | 是 | `blocked` |
| `draft` / `pending_confirmation` / `awaiting_acceptance` | 否 | — |
| `paused` / `completed` / `cancelled` / `failed` | 否 | — |

暂停不吊销授权：授权与目标生命周期解耦，恢复后继续沿用。网关把 `paused` 归入不可执行状态，
因此暂停期间的 `repo.write` 等动作直接拒绝，不会产生副作用。

### 2.2 检查点

写操作完成后追加一条检查点与一条 `checkpoint.recorded` 审计：

| kind | 触发点 | 载荷 |
| --- | --- | --- |
| `builder_run` | Builder 运行成功 | 工作区、分支、改动文件、差异统计 |
| `commit` | 提交成功 | 提交 sha、分支、文件清单、提交信息 |
| `push` | 推送成功 | 远端、分支 |

检查点只追加，不提供更新与删除入口。`auditId` 指向对应的审计事件，用于判断检查点之后是否出现返工。

### 2.3 恢复与跳过

`assessRepeatWrite(db, goalId, workItemId)` 在 Builder 启动前判断：

1. 取该工作项最近一条检查点；
2. 若其后的审计里出现"判定不通过"或"验收返工"，说明工作被重新打开，正常执行；
3. 否则返回跳过，Builder 直接返回 `skipped`，不装载 Agent、不产生新的写操作。

跳过仍写入 `builder.run_skipped` 审计，并携带检查点 id 与原因，便于事后核对"为什么没有重跑"。

### 2.4 CLI

```bash
manner goal pause <goalId> --by <id> [--reason <text>]
manner goal resume <goalId> --by <id> [--reason <text>]
manner checkpoint list --goal <goalId>
```

### 2.5 测试映射

| 用例 | 验证点 |
| --- | --- |
| 暂停拒绝写操作，恢复后跳过已完成的写操作 | 网关拒绝、恢复回到执行态、Builder 返回 `skipped`、Agent 未被再次调用、审计只有一次 `run_started` |
| 验证阶段暂停后恢复到验证阶段 | `pausedFrom` 正确恢复 |
| 出现不通过判定后，恢复不会跳过重试 | 返工信号解除跳过，产生第二个 Run |
| 草稿目标不能暂停 | 非法转换被拒绝且状态不变 |

## 3. S4-02 取消与吊销

`cancelGoal` 是单向操作，按"目标 → 授权 → 升级 → 运行"的顺序级联停止：

| 层级 | 处理 | 结果 |
| --- | --- | --- |
| 目标 | 状态置为 `cancelled`，清空 `pausedFrom` | 暂停中的目标也可取消，之后不能恢复 |
| 授权 | 吊销该目标全部授权 | 任何动作都先因目标状态或授权失效被拒绝 |
| 升级 | 该目标所有待决升级置为 `expired` | 不会在取消后被人误批 |
| 运行 | 角色实例化与网关都拒绝 `cancelled` | Builder、commit、push 都不会再产生副作用 |

工作区不随取消删除：其中的改动与证据仍可供复盘使用，但所有写入口都已关闭。
审计 `goal.cancelled` 记录取消前状态、吊销授权数、过期升级数与活跃工作区数。

### 3.1 测试映射

| 用例 | 验证点 |
| --- | --- |
| 取消目标会级联停止授权、升级与后续运行 | 授权全吊销、升级过期、`pausedFrom` 清空、Builder/commit/push 均被拒绝且 Agent 未被调用 |

## 4. S4-03 预算计量

P0 只按 token 计量，不折算金额：价格随模型与渠道变化，折算结果不可审计，因此金额不在本轮计算。

### 4.1 计量口径

`token_usage` 表按目标累计，来源固定为 `builder_run`、`verification`、`other`：

| 入口 | 来源 | 说明 |
| --- | --- | --- |
| `builder run --tokens <n>` | `builder_run` | Agent 自报用量，记在该次 Run 上 |
| `budget record --source verification` | `verification` | 验证侧补记 |
| `budget record --source other` | `other` | 人工补记 |

结算发生在动作之后：本轮已经产生的消耗不会被回滚。每次记录都写 `budget.consumed` 审计，
包含本次与累计用量，目标结束前可完整还原。

### 4.2 耗尽处理

累计用量达到目标预算时：

1. 若目标处于 `executing` / `verifying` / `blocked`，暂停目标（复用 S4-01，保留 `pausedFrom`）；
2. 创建一条 `spend.tokens` 升级，选项为"追加预算并恢复 / 取消目标"；
3. 写 `budget.exhausted` 审计。

升级与暂停都是幂等的：后续补记用量不会重复暂停或重复建卡。恢复不是自动的——
人工需 `budget extend` 追加预算后显式 `goal resume`。验证与验收不因预算耗尽被跳过或压缩，
验收视图展示已用 / 预算 token 数，仅作展示。

### 4.3 CLI

```bash
manner budget status --goal <goalId>
manner budget record --goal <goalId> --tokens <n> [--item <id>] [--source builder_run|verification|other] [--by <id>]
manner budget extend --goal <goalId> --tokens <n> --by <id>
```

### 4.4 测试映射

| 用例 | 验证点 |
| --- | --- |
| 预算内累计 token 用量，不改变目标状态 | 累计值、剩余额度与审计条数正确 |
| 预算耗尽暂停目标并创建一个 spend.tokens 升级 | 目标暂停、升级唯一、重复记录不重复暂停 |
| 追加预算后可恢复执行，验证不受预算限制 | 预算上限提高、恢复到执行态、非法用量被拒绝 |
| Builder 记录 token 用量，耗尽时暂停升级但不压缩验证 | Run 正常结束、目标暂停、判定仍可记录 |
## 5. S4-04 失败分类与恢复策略

失败按原因分为四类，只有"实现"失败消耗实现者重试次数。分类在运行结束时写入
`builder.run_finished` 审计的 `failureKind` 与 `causeKey` 字段，判定失败则写入判定记录。

### 5.1 分类口径

| 类型 | 判定依据 | 恢复动作 |
| --- | --- | --- |
| `implementation` | Agent 非零退出且非网络/外部错误；自检命令返回失败；判定有"不通过"；执行成功但无改动 | `retry`：由实现者重试 |
| `verification` | 判定只有"无法判定"，没有"不通过" | `rework`：补齐证据或重新判定 |
| `environment` | Agent 超时、无法启动、网络类 stderr；自检超时或无法启动 | `retry`：环境恢复后重试 |
| `external` | 凭据、鉴权、配额、限流、5xx、远端拒绝（含保护分支）等 stderr | `escalate`：等待外部恢复或人工处理 |

外部错误优先于环境错误判断：`401` / `403` / `429` / `quota` 等特征明确指向外部服务，
不应被当作本地网络抖动反复重试。

### 5.2 计数与转人工

`assessBuilderRetry` 从审计链倒推同因连续失败：

- 只统计 `failureKind` 为 `implementation` 的运行；环境、外部与验证失败既不计入，也不打断同因区间；
- 不同 `causeKey` 结束当前区间；
- 同一原因连续失败两次后返回 `blocked`，Builder 不再调用 Agent，转人工处理；
- 人工处理后追加 `builder.retry_cleared`，历史失败保留，计数从零开始。

### 5.3 测试映射

| 用例 | 验证点 |
| --- | --- |
| 运行失败分为实现、环境与外部三类 | 普通非零退出、超时、网络 stderr、鉴权 stderr 与成功的分类 |
| 自检不通过属于实现失败，自检无法运行属于环境失败 | 自检状态映射正确 |
| 判定不通过归为实现问题，只有无法判定才归为验证问题 | 逐条判定归类 |
| 恢复策略只有实现失败消耗实现者重试次数 | 四类的计数标记与恢复动作 |
| 环境与外部失败不计入实现者次数，也不打断同因计数 | 混合失败后只累计实现失败，第二次同因失败才转人工 |

## 6. S4-05 复盘记录

复盘是目标结束后的只读汇总，回答"实际发生了什么、人在哪里介入、哪些请求被拒绝、
升级如何裁决、失败原因是什么、预算用了多少"。P0 不生成改进提案，也不回写目标或授权。

### 6.1 生成方式

| 命令 | 行为 |
| --- | --- |
| `manner review show --goal <id>` | 从审计与用量表即时汇总，不写任何记录 |
| `manner review generate --goal <id> --by <id>` | 汇总后追加 `review.generated` 审计，留作当时快照 |

生成复盘不改变目标状态、授权、升级或预算；审计链保持只追加。

### 6.2 内容口径

| 分类 | 来源事件 | 说明 |
| --- | --- | --- |
| 偏差 | `plan.rejected`、`acceptance.decided(rework)`、`goal.paused`、`budget.exhausted` | 偏离一次通过路径的事件 |
| 人工介入 | 计划批准、验收决定、暂停/恢复、升级裁决、预算追加、重置重试 | 人做出判断的时间点 |
| 拒绝 | `plan.rejected`、`auth.denied`、`builder.*_denied`、`escalation.denied` | 治理边界实际生效的证据 |
| 升级 | `escalation.created` 及其批准/拒绝/过期 | 保留原因、裁决与理由 |
| 失败 | `builder.run_finished(failed)`、判定不通过、完成判定不通过 | 带失败分类与原因键 |

同一事件可以出现在多个分类中（例如验收返工既是偏差也是人工介入），分类只是观察视角，
不复制或改写原始审计。预算部分给出额度、已用与剩余 token。

### 6.3 测试映射

| 用例 | 验证点 |
| --- | --- |
| 复盘按偏差、介入、拒绝、升级与失败汇总审计 | 五类内容、预算、升级裁决与只读性 |
| 生成复盘只追加审计，不修改目标状态 | 追加 `review.generated`、目标状态与 `updatedAt` 不变、审计链有效 |
| 不存在的目标不能生成复盘 | 明确报错 |

## 7. S4-06 审计查询与待办

审计只追加，但人需要能按自己的视角读：一条目标的时间线，以及"现在等我做什么"。

### 7.1 时间线

`manner audit timeline` 在审计链上做只读筛选，结果保持时间升序：

| 参数 | 匹配规则 |
| --- | --- |
| `--goal <id>` | 只取该目标的审计 |
| `--actor <id>` | 审计事件的执行者 |
| `--subject <id>` | 事件关联的授权主体 |
| `--action <value>` | 事件类型，或载荷中的动作（如 `repo.write`、`pr.merge`） |
| `--limit <n>` | 只保留最近 N 条，仍按升序输出 |

筛选不重排、不改写事件；需要校验完整性时使用既有的 `audit verify`。

### 7.2 待我处理队列

`manner audit inbox` 聚合三类待办，不做状态变更：

| 类型 | 来源 | 说明 |
| --- | --- | --- |
| `plan_review` | 状态为 `submitted` 的计划 | 等待批准或拒绝 |
| `escalation` | 状态为 `pending` 且未过期的升级 | 带动作、原因、到期时间与是否需要第二人 |
| `acceptance` | 状态为 `awaiting_acceptance` 的目标 | 等待人工验收 |

升级过期后不再进入队列，由 `escalation sweep` 统一标记过期，避免待办长期悬挂。
队列按创建时间升序，可用 `--goal` 或 `--action` 收窄；`--action` 对升级按动作匹配，
对计划与验收按类型匹配。

### 7.3 测试映射

| 用例 | 验证点 |
| --- | --- |
| 时间线可按目标、人、动作过滤并保留时间顺序 | 目标/执行者/载荷动作/事件类型/最近 N 条 |
| 待我处理队列汇总待审计划、待裁决升级与待验收目标 | 三类聚合、动作过滤、只读性 |
| 过期升级不进入待办队列 | 到期后不再出现在待办中 |

## 8. S4-07 P0 验收演练

演练用真实目标、真实 SQLite 与临时 git 远端走完整旅程，执行层用脚本化 Executor 保证可重复；
真实模型执行已在 S2-07 验证。用例位于 `test/journey.test.ts`。

### 8.1 旅程步骤

| 步骤 | 断言 |
| --- | --- |
| 目标录入、提交并批准计划 | 计划为 approved，Grant 已签发 |
| 暂停与恢复 | 状态 `executing → paused → executing` |
| Builder 实现与自检 | 运行成功，改动为 `src/login.ts` |
| 提交并推送 | commit / push 成功，检查点依次为 `builder_run`、`commit`、`push` |
| 采集证据并逐条判定 | 验收标准与 DoD 全部通过 |
| 完成判定与验收视图 | 目标 `complete=true`，视图含标准与差异 |
| 人工接受 | 目标 completed，全部 Grant 吊销 |
| 生成复盘 | 预算 120/2000、无失败、暂停记为偏差、接受记为介入 |
| 时间线与待办 | 可按人查到暂停与复盘；终态后队列为空 |
| 审计完整性 | `verifyAuditChain` 通过，推送记录存在 |

### 8.2 场景覆盖

| 需求分组 | 覆盖用例 |
| --- | --- |
| 第 4 节 S1 出口场景 | `policy.test.ts`、`flow.test.ts`、`escalations` 相关用例 |
| 第 5 节 S2 隔离执行 | `workspaces`、`executor`、`builder`、`delivery`、`e2e-rework` |
| 第 6 节 S3 验证验收 | `verification`、`evidence`、`verdicts`、`completion`、`acceptance`、`e2e-rework` |
| 第 7 节 S4 生命周期 | `lifecycle`、`budget`、`failures`、`review`、`audit-query`、`journey` |

`pnpm test` 全量通过即认为第 4、5、6、7 节场景全过。
