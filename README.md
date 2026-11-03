# Super-Manner

> Autonomous coding agents with manners — scoped by grants, proven by evidence, improved by review.
>
> 有章法的 Agent 团队：目标可委任，越界有裁决，交付有证据。

Super-Manner 是一个协作式 coding agent 团队。架构师提交目标与验收标准，系统自行组队、分工、执行与验证，交付可审查的 PR 和完整证据；每次交付后，团队依据评测结果受控地变强一点。

## 核心主张

- **目标所有权**：委派单元是目标，不是任务。系统自己决定怎么做，并对结果负责。
- **可验证的完成**：完成由证据定义，不由实现者自评定义。
- **可回滚的授权**：动作级授权随目标签发与失效，越界由运行时拒绝并要求人裁决。
- **受控的自我迭代**：复盘产出版本化提案，经黄金任务集评测与灰度后才生效。

自主性不是“让 Agent 更敢做”，而是同时具备以上四件事；缺任何一项，自主性都会变成风险。

## 当前状态

治理内核（S1）与隔离执行（S2-01～S2-06）已可运行：Builder 可调用本地 codex 在独立 worktree 内改动、自检、提交并推送分支，同因连续失败两次会转人工；PR 仍由人工创建。

- [x] 产品定位与命名
- [x] 产品需求文档 v0.2（决定稿）
- [x] 8 项开放问题定稿（预算单位、第二人规则、默认自治级别等）
- [x] S1 治理内核：目标、授权、越界拦截、升级裁决、审计链（41 项测试通过）
- [x] S2 隔离执行：worktree、Executor、角色实例化、Builder 运行、commit/push、失败重试（累计 91 项测试通过）
- [x] S2 端到端：真实模型在 `feature/sm-179ad8f6-build` 上改 README 并推送，PR 人工创建
- [ ] S3 验证与验收：证据与人工决定（S3-01 上下文、S3-02 证据、S3-03 判定、S3-04 完成判定、S3-05 验收视图已完成）
- [ ] S4 生命周期与归档：暂停、取消、预算与复盘

## 本地运行

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm manner --help
```

## 文档

| 文档 | 说明 |
| --- | --- |
| [产品需求文档 v0.2](docs/prd-v0.2.html) | 自包含 HTML，浏览器直接打开；定义产品行为与边界，不含技术架构 |
| [P0 实现任务拆解](docs/p0-plan.md) | 按 FR 拆分的四个切片与验收场景 |
| [S1 治理内核设计](docs/design/s1-governance.md) | 分层、状态机、授权判定、网关流程、CLI 与测试映射 |
| [S2 隔离执行设计](docs/design/s2-execution.md) | worktree 隔离、执行器契约、角色 playbook、Builder 运行与提交/推送 |
| [S3 验证与验收设计](docs/design/s3-verification.md) | 独立上下文、证据、逐条判定、完成判定与验收视图 |

## 术语

| 术语 | 含义 |
| --- | --- |
| Goal | 一次委派，包含验收标准、约束、预算与自治级别 |
| WorkItem | 可独立执行与验证的最小单元 |
| Grant | 动作、资源、约束的组合，随目标签发与失效，不可转授 |
| Escalation | 有资格但超限时请求人裁决，一次一用 |
| Evidence | 可复现、可核对、可归属的事实，是“完成”的唯一依据 |
| Playbook | 角色行为的版本化载体，变更需经评测与灰度 |

完整定义见 PRD 第 4 章与附录 11.2。

## 命名约定

| 场景 | 写法 |
| --- | --- |
| 产品名 | Super-Manner |
| 仓库 / 包名 | `super-manner` |
| CLI | `manner` |
| 中文简称 | 章法 |

## 许可证

[Apache License 2.0](LICENSE)