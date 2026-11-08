# ADR-0027: Bind a host-enforced profile to each agent

- Status: Accepted (2026-11-08)

## Context

ADR-0026 requires the Coordinator, each Team Leader and each Executor to have its own instructions, tools, MCP servers, skills, memory and context, while Executors are created per Assignment. Today all specialists share one host tool control, one group memory scope and a prompt tail written in code; roles differ only by one configured responsibility text. Group runtimes disable inherited plugins, skill search and host skill discovery (ADR-0023), so per-agent MCP servers and skills need an explicit, controlled source.

## Options

1. **Local Agent Profiles for the Coordinator, each Team Leader and each team's Executor presets, enforced by the host beneath prompts.** An Executor inherits exactly one preset. The host writes a profile's skills into the agent's own isolated runtime. MCP servers are connected and held by the host service, never by an agent runtime, and reach agents only as proxy tools.
2. Express roles only in prompts over a shared tool catalog and memory, as today. Rejected because ADR-0023 already rejected prompt-only isolation: any agent could still call another domain's tools or recall its results.
3. One Executor profile per team. Rejected by the owner because different kinds of work in one team need different instructions and tools.
4. Team Leaders compose each Executor's capabilities per Assignment. Rejected by the owner because a model would choose authority combinations that are hard to audit and test.
5. Limit MCP servers to capabilities inside existing module permissions. Rejected by the owner because work such as operating marketplace sites would be impossible, which makes per-agent MCP servers pointless.
6. Executors keep no memory beyond their Assignment. Rejected by the owner in favour of memory shared among Executors created from the same profile in the same conversation.
7. Let each agent's Codex runtime start the MCP servers its profile lists. Rejected in favour of the owner's agent-link design: the runtime would hold the servers' credentials, MCP programs would run under agent sandbox restrictions, and calls could not be re-checked against the caller.
8. Re-enable host plugin and skill discovery for group runtimes. Rejected because every agent would inherit the owner's private integrations, contrary to ADR-0023.
9. Use Codex's built-in multi-agent feature inside one runtime (not recorded): a common alternative that was not evaluated and stays disabled in isolated runtimes. Reconsider only if its per-agent configuration boundaries are shown to match option 1.

## Decision

We adopt **option 1**.

Profiles and authority:

- Profiles are managed in the local console (ADR-0028). A saved change applies to new requests. Requests already started keep the leaders and profiles they started with. Revoking capability is the exception: unbinding an MCP server, disabling a server or tool, removing a host tool from a profile and narrowing module permissions take effect at the next call of every request, including running ones.
- A team presets one or more Executor profiles. A Team Leader chooses one when it creates an Executor and cannot add capability to it.
- Creating an Executor never widens authority: the Executor receives exactly its preset. Capability beyond module permissions arises only when the owner configures an MCP server in a profile, and it applies only to agents using that profile. Profiles attach MCP servers from the console's MCP Catalog and select skills from its Skill Library (ADR-0028).
- An agent's effective host tools are the intersection of its profile's allowlist and current module permissions. The Coordinator and Team Leaders receive no side-effecting tools.
- Domain instructions exist only in the owning profile. Shared code adds only domain-neutral safety rules.

Runtimes and sessions:

- Each running agent has its own isolated runtime home and its own HOME inside it, and Codex's bundled skills are disabled. The host writes only that profile's skills into that home; host plugins and the other disabled features stay off.
- MCP servers follow the owner's agent-link design:
  - The host service connects and holds every MCP server in the MCP Catalog.
  - An agent receives proxy tools named `mcp__<server>__<tool>` only for the servers its profile attaches.
  - Every call goes through the host, which re-checks the caller's profile instead of trusting the agent. A call must be allowed both by the request's snapshot and by the current configuration.
  - Agents never see MCP credentials, and MCP programs never receive model keys.
- Each Executor has its own session. Coordinator and Team Leader sessions remain keyed by agent, conversation and access revision.
- Runtimes are pooled with idle release and a concurrency limit. An ended Executor's runtime is released while its records remain. Persisted thread identities let Coordinator and Team Leader sessions resume after their runtime was released.

Memory scopes:

| Agent | Memory scope |
|---|---|
| Coordinator | The group memory. |
| Team Leader | Keyed by conversation and leader. |
| Executor | One scope shared by all Executors created from the same profile in the same conversation. Each Executor's own process and result are also kept as records of its Assignment. |

## Consequences

- Positive:
  - One agent's tools, MCP servers, skills and instructions cannot reach an agent with a different profile.
  - Adding a kind of Executor, or changing one, becomes configuration and credentials rather than code.
- Negative:
  - The owner maintains a profile for every agent and Executor preset.
  - Every isolated runtime costs memory and start-up time (evidence (b)). MCP servers do not add to it, because the host holds one connection per server.
  - An MCP server in a profile is a new owner grant outside module permissions. The specification's rule that roles never enable browser accounts or shell execution (agent-dispatch::CON-003) therefore becomes a per-profile owner decision.
  - Shared Executor memory lets one Assignment's process influence later Assignments that use the same profile in that conversation.
- Neutral: the decision was accepted once two checks held on the pinned Codex App Server (Sources):
  - (a) it loads skills from a per-agent home while host skills, bundled skills and plugins stay out. Skipping host skill discovery alone did not achieve this; a runtime's own HOME and disabled bundled skills did;
  - (b) the per-runtime memory and start-up cost, which sizes the pool.

## Sources

- [ADR-0023](0023-isolate-feishu-group-authority.md): isolated group runtimes; prompt-only isolation rejected.
- [ADR-0026](0026-coordinate-group-work-through-isolated-teams.md) and [ADR-0028](0028-manage-agent-teams-from-the-local-console.md).
- Owner decisions on 2026-11-07:
  - preset Executor profiles per team;
  - shared memory among same-profile Executors;
  - MCP capability only through explicit owner configuration.
- `apps/weixin-service/src/isolated-model-runtime.ts`: disabled runtime features, the runtime's own HOME and disabled bundled skills.
- Evidence (a), 2026-11-08, Codex `0.167.0-alpha.3.2`, against a loopback fake model endpoint. With the real HOME, an isolated runtime listed 40 skills: 1 of its own, 34 from `~/.agents/skills` (7 of them symbolic links) and 5 bundled. It injected a host skill's instructions when the turn named it with `$`. With its own HOME and bundled skills disabled, it listed and injected only its own skills, and the copied login still reached the endpoint. `pnpm --filter @aloong-planet/codex-weixin-service test:isolated-runtime` (`apps/weixin-service/tests/isolated-model-runtime.test.ts`) repeats the check for every runtime kind.
- Evidence (b), 2026-11-08, Codex `0.167.0-alpha.3.2`, 30 starts: a thread was ready in a median 0.16 s (maximum 0.23 s); a runtime used about 80 MiB idle and at most 120 MiB.
- The owner's agent-link project at `/Users/loong_zhou/playground/multi-agent`: README section 「MCP（外部工具服务）」, FEATURES section 28 and `agent-link/mcp.ts` (host-managed MCP connections and proxy tools).
- `apps/weixin-service/src/main.ts`: one tool control for every specialist and one group memory scope.
- `apps/weixin-service/src/agent-dispatch-executor.ts`: shared prompt tail and runtime map.
