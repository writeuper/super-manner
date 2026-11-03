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
