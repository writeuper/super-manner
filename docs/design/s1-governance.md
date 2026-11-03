# S1 治理内核设计

> 状态：已实现（2026-11-03）· 对应 FR-01 / FR-02 / FR-03 / FR-04 / FR-12 的底座
> 依据：[PRD v0.2](../prd-v0.2.html) · [P0 实现任务拆解](../p0-plan.md) 第 4 节

S1 不引入真实 Agent。执行器由脚本扮演，只负责发出动作请求；本文只描述"谁能做什么、越界怎么办、事后怎么查"这套治理机制。

## 1. 目标与非目标

**目标**

- 目标信息不完整时只落草稿，明确列出缺什么。
- 计划经人工批准后才产生授权，未批准时不存在任何可用权限。
- 所有动作请求经过唯一网关，判定为拒绝或升级时不产生副作用。
- 越界请求生成一次性升级卡片，批准一次只用一次。
- 目标取消后授权立即失效。
- 每个决定都能从只追加的审计链还原，并可校验未被篡改。

**非目标（留给后续切片）**

- 真实仓库读写、worktree 隔离与 PR 创建（S2）。
- 独立验证与证据采集（S3）。
- 预算实时计量、暂停恢复（S4）。
- 智能拆解计划：S1 的计划由脚本或人直接给出。

## 2. 分层与依赖规则

```text
src/
├── domain/   纯领域：动作词汇、类型、状态机、授权判定、衰减校验
├── infra/    SQLite 连接、仓储、只追加审计链
├── app/      目标、计划、授权签发、升级、工具网关
└── cli.ts    终端入口
```

依赖方向固定为 `cli → app → domain`、`app → infra → domain`。

- `domain` 不导入 `infra`/`app`，也不直接使用 `node:sqlite`。
- `new DatabaseSync()` 只出现在 `src/infra/db.ts`。
- 以上两条由 [architecture.test.ts](../../test/architecture.test.ts) 强制。

运行时零依赖：Node 22 原生类型剥离执行 `.ts`，存储使用内置 `node:sqlite`；`typescript` 与 `@types/node` 仅用于类型检查。

## 3. 数据模型

单库六张表，JSON 字段保存结构化数组或对象。

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `goals` | `status`、`missing`、`budget_tokens`、`autonomy` | 目标与验收标准 |
| `plans` | `goal_id`、`version`、`status`、`work_items` | 计划是授权的唯一来源 |
| `grants` | `subject`、`actions`、`scope`、`constraints`、`parent_grant_id` | 两级授权，子授权记录父授权 |
| `escalations` | `status`、`requires_second`、`expires_at` | 越界裁决卡片 |
| `approvals` | `resource_key`、`used_at` | 一次性通行证，消费后写 `used_at` |
| `audit` | `prev_hash`、`hash`、`payload` | 只追加哈希链 |

`schema` 由 `PRAGMA user_version` 管理，当前版本 1。开启 WAL 与 `busy_timeout`，P0 不做并发写优化。

## 4. 状态机

所有状态转换必须经过 `assertGoalTransition` / `assertPlanTransition`，非法转换直接抛错。

**Goal（9 态）**

```text
draft ──→ pending_confirmation ──→ executing ──→ verifying ──→ awaiting_acceptance ──→ completed
  │               │                    │            │                 │
  │               └──→ draft           ├──→ blocked │                 └──→ executing
  └──→ cancelled                       ├──→ failed  └──→ executing
                                       └──→ cancelled
```

补充规则：

- `blocked` 可回到 `executing`，也可终止为 `failed` / `cancelled`。
- 终态（`completed` / `cancelled` / `failed`）没有出边，取消与升级创建都会被拒绝。
- 升级超时只做一件事：把目标转为 `blocked`，不放行任何动作。

**Plan（4 态）**

```text
draft ──→ submitted ──→ approved
                └────→ rejected
```

S1 的计划提交即进入 `submitted`（`draft` 保留给后续草稿编辑），`rejected` 后目标回到 `draft` 可重新提交。

## 5. 授权模型

### 5.1 动作与角色上限

15 个动作是唯一词汇表：`repo.read/write/commit/push`、`pr.create/comment/review/merge`、`ci.rerun`、`release.deploy`、`secret.read`、`network.egress`、`spend.tokens`、`agent.spawn`、`grant.issue`。

签发时先检查角色能力上限：

| 角色 | 可申请动作 |
| --- | --- |
| architect | 全部 |
| planner | `repo.read`、`pr.comment`、`spend.tokens`、`agent.spawn` |
| builder | `repo.read/write/commit/push`、`pr.create`、`pr.comment`、`ci.rerun`、`spend.tokens` |
| verifier | `repo.read`、`pr.comment`、`pr.review`、`ci.rerun`、`spend.tokens` |
| observer | 无 |

角色不符时在批准阶段直接失败，不会签发降级授权。

### 5.2 三态判定

`authorize(request, grants)` 是判定唯一入口，结果严格区分：

| 结果 | 条件 | 网关行为 |
| --- | --- | --- |
| `allow` | 存在覆盖该动作、未撤销未过期、资源在范围内的 Grant | 执行并记录 `auth.allowed` |
| `deny` | 没有该动作的 Grant，或 Grant 已撤销/过期 | 直接拒绝，**不出卡** |
| `escalate` | 有该动作的 Grant，但仓库/分支/路径/密钥/主机/额度越界 | 生成升级卡片，等待裁决 |

这条区分是治理的核心：无资格的人不应该用人情绕过，越界的人应该拿到明确的裁决入口。

### 5.3 资源范围检查

| 动作 | 必须匹配 |
| --- | --- |
| `repo.*` / `pr.*` / `ci.rerun` | `resource.repo ∈ scope.repos` |
| `repo.write/commit/push` | 分支存在且匹配 `scope.branches` 的 `*` 模式 |
| `repo.write/commit` | 路径位于 `scope.paths` 前缀之下 |
| `secret.read` | `scope.secretKeys` 非空，且 `resource.key` 精确命中 |
| `network.egress` | `scope.hosts` 非空，且 `resource.host` 精确命中 |
| `spend.tokens` | `resource.tokens ≤ constraints.maxTokens`（若设置） |

分支与路径只支持 `*` 通配符；空的分支/路径列表表示不额外限制。

### 5.4 两级授权与衰减

批准计划时签发两类 Grant：

- **根授权**：`subject = goal:<goalId>`，角色 `architect`，范围为目标仓库，`maxTokens` 为目标预算，代表目标本身的完整范围。
- **工作项授权**：`subject` 为角色实例，`parentGrantId` 指向根授权，只能更窄。

`assertAttenuated(parent, child)` 拒绝以下放大：

- 新增父授权没有的动作；
- 扩大仓库列表；
- 父授权限定分支/路径时，子授权缺失对应字段或模式更宽；
- 扩大 hosts / secretKeys；
- 延长有效期、提高 token 额度或合并次数。

### 5.5 自治级别

自治级别是硬上限，不是授权本身：

| 级别 | 允许的最高动作 |
| --- | --- |
| A1 | 只读、评论、复查、CI 重跑、token 消耗、agent 派生 |
| A2（默认） | A1 + `repo.write/commit/push`、`pr.create` |
| A3 | A2 + `pr.merge` |
| A4 | A3 + `release.deploy` |

即使计划里写了 `pr.merge`，A2 目标在批准阶段就会失败。

## 6. 工具网关

`requestAction(db, request, options)` 是所有动作的唯一入口，执行器必须先调用它，`denied` / `escalated` 时不得产生副作用。

```text
1. 目标不存在                         → denied
2. 目标处于 draft/pending/blocked/
   completed/cancelled/failed         → denied
3. authorize(...)
   ├─ allow    → 审计 auth.allowed    → allowed
   ├─ deny     → 审计 auth.denied     → denied
   └─ escalate → 查一次性 Approval
                 ├─ 命中 → 标记已用 → 审计 auth.allowed(oneTime) → allowed
                 └─ 未命中 → 创建升级 → 审计 auth.escalated → escalated
```

注意：`deny` 不生成升级卡片；`escalate` 才生成。网关本身不执行任何业务动作，只做判定与记账。

## 7. 升级与一次性通行证

创建升级时：

- 同一目标、主体、动作、资源键在待处理期间去重，避免重复出卡；
- 默认有效期 24 小时；
- `pr.merge`、`secret.read`、跨仓库写入标记 `requiresSecond`。

裁决时：

- 已处理或已超时的卡片不能再裁决；
- 需要第二人时，必须提供且不能与第一人相同；
- 批准写入一张 `approvals`，只包含动作与资源键；
- 拒绝只记录理由，不产生任何授权。

通行证由网关消费：首次命中 `used_at IS NULL` 的记录并立即标记，因此批准一次只放行一次；第二次请求会重新回到升级流程。

## 8. 取消与吊销顺序

`cancelGoal` 的顺序固定为：

1. 吊销该目标下所有 `active` Grant；
2. 将待处理升级标记为 `expired`；
3. 目标状态改为 `cancelled`。

顺序不能反。若先改状态后吊销，中途失败会留下仍然有效的授权；先吊销再改状态，最坏情况是目标暂时未取消，但权限已经收回。

## 9. 审计链

每条审计记录包含 `prev_hash`，哈希由 `prevHash + at + actor + type + payload` 计算：

```text
hash = sha256(prevHash \n at \n actor \n type \n JSON.stringify(payload))
```

- 只提供追加与查询接口，服务层没有更新/删除路径。
- `verifyAuditChain` 从头重算，断链时返回 `ok:false` 与第一个异常事件 id。
- 记录的事件类型包括：`goal.created`、`goal.status_changed`、`goal.cancelled`、`plan.submitted`、`plan.approved`、`plan.rejected`、`grants.issued`、`grants.revoked`、`escalation.created`、`escalation.approved`、`escalation.denied`、`escalation.expired`、`auth.allowed`、`auth.denied`、`auth.escalated`。

## 10. CLI 与计划文件

```bash
# 初始化
manner init --db ./manner.db

# 提交目标（缺验收标准时会存为草稿）
manner goal new --title "为登录页增加错误提示" --repo acme/demo \
  --acceptance "错误密码时展示提示文案" --acceptance "不泄露账号是否存在" \
  --budget 2000 --autonomy A2 --by architect

# 提交并批准计划
manner plan submit <goalId> --file plan.json --by planner
manner plan approve <planId> --by architect

# 发起动作请求
manner auth request --goal <goalId> --subject builder-1 --action repo.write \
  --repo acme/demo --branch feature/sm-1 --path src/login.ts

# 处理升级
manner escalation list --pending
manner escalation decide <id> --by architect --approve
manner escalation sweep

# 审计
manner audit log --goal <goalId>
manner audit verify
```

`plan.json` 与 `Plan.workItems` 同构：

```json
{
  "totalBudgetTokens": 1500,
  "risks": ["错误提示可能影响现有快照测试"],
  "pendingDecisions": [],
  "workItems": [
    {
      "id": "build",
      "title": "实现错误提示",
      "role": "builder",
      "dependsOn": [],
      "dod": ["改动通过类型检查", "覆盖失败路径"],
      "budgetTokens": 1000,
      "grant": {
        "subject": "builder-1",
        "actions": ["repo.read", "repo.write", "repo.commit", "repo.push", "pr.create"],
        "scope": {
          "repos": ["acme/demo"],
          "branches": ["feature/sm-*"],
          "paths": ["src/"]
        },
        "constraints": {}
      }
    },
    {
      "id": "verify",
      "title": "独立验证",
      "role": "verifier",
      "dependsOn": ["build"],
      "dod": ["逐条核对验收标准"],
      "budgetTokens": 500,
      "grant": {
        "subject": "verifier-1",
        "actions": ["repo.read", "pr.review", "ci.rerun"],
        "scope": { "repos": ["acme/demo"] },
        "constraints": {}
      }
    }
  ]
}
```

## 11. 出口场景与测试映射

| # | 出口场景 | 测试 |
| --- | --- | --- |
| 1 | 缺验收标准只能存草稿并列出缺失项 | `flow.test.ts` · 缺少验收标准时只能保存草稿并列出缺失项 |
| 2 | 预算超限不得批准 | `flow.test.ts` · 计划预算超过目标预算时不能提交 / 批准前重新校验预算 |
| 3 | 批准后才签发 Grant | `flow.test.ts` · 批准计划之后才签发授权 |
| 4 | 授权内 `repo.write` 放行；未授予的 `pr.merge` 直接拒绝且不出卡 | `flow.test.ts` · 授权内写入放行，未授予的合并直接拒绝且不出卡 |
| 5 | 推送到非自有分支触发升级；批准仅一次有效 | `flow.test.ts` · 推送非自有分支触发升级，批准后仅一次有效 |
| 6 | Builder 请求 `secret.read` 直接拒绝 | `flow.test.ts` · Builder 读取密钥无资格，直接拒绝且不出卡 |
| 7 | 升级超时转阻塞且不放行 | `flow.test.ts` · 升级超时转为阻塞且不放行 |
| 8 | 取消后所有 Grant 失效 | `flow.test.ts` · 取消目标后所有授权失效 |
| 9 | 任一决定可由审计还原 | `flow.test.ts` · 审计链能还原每个决定；`audit.test.ts` |

此外，`policy.test.ts` 覆盖判定表本身，`architecture.test.ts` 守住分层与数据库入口。

## 12. 已知边界

| 边界 | 现状 | 去向 |
| --- | --- | --- |
| 真实执行器 | 未接入，动作请求由测试/CLI 发起 | S2 |
| 预算计量 | 只校验计划额度，不累计实际 token | S4 |
| 暂停/恢复 | 未实现 | S4 |
| 房间与唤醒 | 用工作项状态与 CLI 替代 | P1 |
| 多进程并发 | 单写队列，未做跨进程协调 | 视需要 |
| 失败重试 | 无自动重试与失败分类 | S2 / S4 |