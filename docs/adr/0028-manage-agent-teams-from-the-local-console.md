# ADR-0028: Manage agent teams, MCP servers and skills from the local console

- Status: Accepted (2026-11-07)

## Context

Teams, their leaders' Feishu identities, responsibilities and agent profiles are fixed, restart-applied local configuration that must contain the four default roles, and every dispatch group shares the same roster. The owner wants to add, edit and remove teams for a particular group from the local console. The Coordinator's roster and the other leaders' knowledge of the group must follow those changes. The owner also wants to maintain MCP servers and skills in the console and attach them to executor profiles.

## Options

1. **Team, MCP and skill management pages in the local console. Teams are defined once and bound to groups, and saved changes apply to new requests. MCP servers are registered in an MCP Catalog, skills are imported into a Skill Library, and team profiles attach entries from both.**
2. Keep restart-applied local configuration. Rejected by the owner because adding a team should not need a file edit and a restart.
3. Define teams separately in each group. Rejected by the owner because the same team would need several configurations and possibly several Feishu applications.
4. Apply changes only after a restart. Rejected by the owner because a restart interrupts work in progress.
5. Attach MCP servers only from a list registered in local configuration. Recommended and considered, but the owner chose to register them in the console for convenience. As a result, the console can start local programs.
6. Create MCP servers inline on the team page. Replaced by the owner's choice of a dedicated MCP management page, so that registration and attachment are separate steps, each confirmed.
7. Upload, paste or author skills through the page, including text-only skills. Rejected by the owner: skills are imported only from local folders.
8. Confirm an MCP grant only at registration, or only at attachment. Rejected by the owner; both steps are confirmed.
9. Delete an MCP server or skill that profiles use and detach it automatically. Rejected by the owner; it must be unbound first.
10. Refuse to remove a team with active work, or remove it and cancel that work. Rejected by the owner in favour of draining.
11. Keep the default teams fixed and only allow additions. Rejected by the owner: Alice, Bill and Jack are ordinary teams.

## Decision

We adopt **option 1**.

### Team definition

The overview page links to a team-management page in the local console. A team definition holds:

- the leader's name and Feishu application;
- its responsibility, which forms its entry in the Team Directory;
- the leader's instructions;
- its executor profiles: instructions, host-tool allowlist, attached MCP servers and selected skills;
- the dispatch groups it is bound to.

### Roster and changes

- A team is defined once and bound to groups. A group's roster is the set of teams bound to it.
- The Coordinator is fixed for every dispatch group; only its responsibility text and instructions are editable.
- Alice, Bill and Jack can be edited and removed like any other team.
- A saved change applies to new requests. Requests already started keep the team, profile, MCP and skill definitions they started with. Revocations are the exception and take effect at the next call (ADR-0027).
- Binding a team to a group, or removing it, makes the Coordinator post an announcement in that group and updates every Team Leader's Team Directory for the group. A Team Directory holds names and responsibilities only.

### Removing a team

1. The Coordinator stops dispatching to the team immediately.
2. Active assignments finish, and the team's leader closes them.
3. The team is then unbound.

History keeps the team's identity and records.

### MCP Catalog

- MCP servers are registered and maintained on an MCP management page that follows the owner's agent-link MCP settings:
  - local programs (stdio: command, arguments, working directory, environment variables) or Streamable HTTP addresses (URL and headers, or OAuth client_credentials, optionally presenting the token with DPoP);
  - secret values that can only be written, never read back;
  - an optional macOS sandbox per local program;
  - a per-call timeout, a trusted switch for tool annotations, and an enable switch;
  - per-tool disabling;
  - pinned tool definitions, so that new or changed tools wait for the owner's review;
  - tools that require human interaction are never provided;
  - import of an `mcpServers` JSON document; imported servers are untrusted and unattached.
- Registration additionally requires the owner to confirm the exact command or address. This step goes beyond agent-link.
- Attaching a registered server to a profile on the team page is a separate explicit owner grant to the agents using that profile (ADR-0027).

### Skill Library

- Skills are imported from local folders on a skill management page, which lists every imported file.
- The console does not author or edit skill content. An import is a copy, so a changed folder takes effect only when it is imported again.
- Profiles select skills from this library.

### Shared rules for catalog entries

- An MCP server or skill that any profile uses cannot be deleted until it is unbound.
- The team page links to both management pages.
- The console stays local and separate from the public event ingress.

## Consequences

- Positive:
  - Teams join or leave a group without code changes or a restart.
  - The Coordinator's roster and every leader's Team Directory stay consistent with the bindings.
  - Each MCP server and skill is maintained once and reused across profiles, and every grant of an MCP server to a profile is visible and confirmed.
- Negative:
  - Because the console can register MCP servers, it can start arbitrary local programs and becomes a high-authority surface. Three prerequisites must be in place before these pages ship: owner authentication of the console, confirmation of each registration and attachment, and an audit trail of configuration changes.
  - The pages receive application secrets and MCP credentials, and must never display or log them back.
  - Applying changes on save requires a per-request snapshot of the team, profile, MCP and skill definitions.
  - A removed team may still own scheduled tasks or waiting work bound to its bot identity. Its scheduled tasks must be moved to another team or deleted before the removal completes, and work waiting for its requester keeps the removal pending ([team-management specification](../specs/team-management.md)).
  - Changing a skill means editing its folder and importing it again.
  - As in agent-link, MCP tool calls are not confirmed one by one. Pinning, never providing human-interaction tools, per-profile attachment and the audit log replace per-call confirmation. Operations that need a person must be marked by the server for human interaction.
- Neutral:
  - Onboarding a leader uses Feishu's one-click agent-application creation by QR scan, or an existing application entered by hand. Admin review and group membership settings can still require manual action; see the onboarding research note.
  - The agent dispatch specification's statement that no management screen is introduced must be rewritten.
  - Runtime isolation of profiles follows ADR-0027.

## Sources

- Owner decisions of 2026-11-07:
  - teams defined once and bound per group;
  - changes applied on save, with requests in progress unchanged;
  - Coordinator announcements and a Team Directory for leaders;
  - draining removal;
  - Alice, Bill and Jack editable and removable, with the Coordinator fixed.
- Owner decisions of 2026-11-08:
  - QR onboarding;
  - dedicated MCP and skill management pages;
  - skills imported only from local folders;
  - MCP confirmation at both registration and attachment;
  - catalog entries in use must be unbound before deletion.
- The owner's agent-link project at `/Users/loong_zhou/playground/multi-agent`: README section 「MCP（外部工具服务）」, FEATURES section 28, `agent-link/mcp.ts` (configuration shape) and `agent-link/web.html` (MCP settings page).
- Onboarding research note: `~/research/codex-weixin-agent-team/feishu-onboarding.md`, from official Feishu documentation read on 2026-11-07.
- `apps/weixin-service/src/feishu-agent-config.ts`: the required default roles and the fixed roster size.
- [Agent dispatch specification](../specs/agent-dispatch.md): implementation decisions on restart-applied configuration and the absence of a management screen.
- [ADR-0026](0026-coordinate-group-work-through-isolated-teams.md) and [ADR-0027](0027-bind-host-enforced-agent-profiles.md).
