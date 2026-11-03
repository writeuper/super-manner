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