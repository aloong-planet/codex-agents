# Codex-Weixin 项目规则

## 每次改动后的测试与真实微信验收

每次修改代码、配置、运行行为或文档后都必须执行与改动相称的验证，并记录结果。只要改动影响微信入站、回复、工作流、文件/媒体外发或用户可见状态，必须额外执行模拟微信入口回归。

1. 先运行针对性测试；失败就修复并重复运行，直到通过。
2. 合并或交付前运行项目完整门禁：lint、typecheck、单元/集成测试和 E2E。不得用旧结果代替本次改动后的结果。
3. 微信行为回归必须通过 fixture 专用入口驱动与生产一致的入站链路，不得直接调用 Provider 或手工修改 Run。记录测试使用的完整微信口令、实际助手回复、Run 状态、关键步骤、effect 和脱敏 outbox。
4. 测试报告必须在请求用户验收前发给用户，至少包含：
   - 改动范围与版本/工作树；
   - 测试命令；
   - 微信模拟口令；
   - 实际回复原文；
   - Run、步骤、effect、outbox 结果；
   - lint/typecheck/unit/E2E 数量与结论；
   - 未验证项和下一步真实微信操作。
5. 自动化全部成功只能标记为“自动化候选通过”。只有用户在真实微信发送相同口令、观察到相同回复和副作用并明确确认后，才能标记为“真实微信验收通过”。
6. 未经用户在场确认，不自动执行真实微信测试发送。渠道 accepted 与手机实际收到必须分开报告；发送结果 unknown 时禁止自动重发。
7. 纯文档或不影响微信行为的改动仍须报告验证结果；报告中的“微信模拟口令”和“实际回复”写明“不适用（无运行行为变化）”，不得伪造交互结果。

每轮施工在 `docs/.workings/<slug>/test-report.md` 保存同一份测试报告，使用 `docs/testing/test-report-template.md` 的结构。

Cross-skill project facts are declared in the repository-root `capabilities.toml`.

Group invocation, memory, model recovery, file access, pending continuation and scheduled delivery must preserve the conversation/requester boundaries in [ADR-0023](docs/adr/0023-isolate-feishu-group-authority.md).

Isolated model runtimes are created only from `ISOLATED_RUNTIME_KINDS` and started only through `spawnIsolatedAppServer`, so each one is offered only its host's grant, as described in [ADR-0030](docs/adr/0030-offer-isolated-runtimes-only-granted-tools.md).

Once an Executor's runtime is released, its home keeps only its thread rollouts, so anything else a runtime needs must be written again whenever the runtime is created, as described in [ADR-0031](docs/adr/0031-compact-executor-runtime-homes-to-their-rollouts.md).

Every page and API of the local service must stay behind owner authorization and the local-Host rule in [agent-console::CON-001](docs/specs/agent-console.md); the public event ingress never routes to it.

Deployments and file-tool acceptance must use the Node version pinned in CI; changing that version requires real permission-worker write and recovery validation, as described in [agent dispatch runtime decisions](docs/specs/agent-dispatch.md#implementation-decisions).

Financial state, attachments, execution history and reply destinations must remain owner-bound and separate from general personal memory and group dispatch under [ADR-0025](docs/adr/0025-isolate-private-financial-authority.md).

In vitest tests, a wait on another process starting, stopping or reporting is bounded by at least the smaller of `processWaitLimitMs` and its case's own limit, never by the 1 s default of `expect.poll` or `vi.waitFor`, a product timer that starts when a child is spawned is held until that child reports ready, and a wall-clock product deadline a case sets must not fall due before the step it must precede ([why](apps/weixin-service/tests/support/process-wait.ts)).

Tests signal process groups only through `signalProcessGroup` in [process-group.ts](apps/weixin-service/tests/support/process-group.ts).

## Agent skills

### Issue tracker

Tickets are maintained as local files. See `docs/agents/issue-tracker.md`.

### Documentation layout

This repository uses one `docs/CONTEXT.md`. See `docs/agents/docs-layout.md`.
