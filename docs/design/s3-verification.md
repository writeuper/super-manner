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

## 4. 后续任务

| 任务 | 产出 | 关键约束 |
| --- | --- | --- |
| S3-03 逐条判定 | 每条验收标准的结论与说明 | 通过 / 不通过 / 无法判定 |
| S3-04 完成判定 | 工作项与目标两级 DoD | 存在"不通过"或"无法判定"时不得完成 |
| S3-05 验收视图 | 单页：目标、差异、证据、风险、待决 | 人无需追问即可决定 |

## 5. 测试映射

| 任务 | 测试 |
| --- | --- |
| S3-01 只含目标、标准与差异 | `verification.test.ts` · 验证上下文只含目标、标准与差异，不含实现过程 |
| S3-01 无工作区时拒绝 | `verification.test.ts` · 没有活跃工作区时不能构建验证上下文 |
| S3-02 证据含命令、环境、时间与哈希 | `evidence.test.ts` · 证据记录命令、环境、时间与哈希，他人可据此重跑 |
| S3-02 无工作区时拒绝 | `evidence.test.ts` · 没有活跃工作区时不能采集证据 |

## 6. 已知边界

| 边界 | 现状 | 去向 |
| --- | --- | --- |
| 未提交改动 | 验证上下文以已提交差异为主，未跟踪文件只出现在文件清单 | 要求 Builder 先提交 |
| 差异截断 | 超过 20000 字符截断并标注 | 需要时按文件分段 |
| 提示词版本 | 只记录哈希，不保存正文 | S3-05 验收视图可保存快照 |
| 证据输出 | 每条流只保留尾部 4000 字符，哈希基于保留内容 | 需要完整日志时另行落盘 |
| 证据来源 | 只重跑自检命令，不重新执行 Agent | 复杂验证由 S3-03 判定补充 |