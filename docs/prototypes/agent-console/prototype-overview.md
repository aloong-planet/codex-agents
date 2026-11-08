# Agent workspace overview

## Question

Can an owner understand the relationships among conversations, channel bot identities, working agents and storage, then follow received information through assignment, execution and reporting?

This is a read-only presentation prototype. Roles and isolation boundaries reflect the current system. All processing records, times, results, filenames and readiness indicators are synthetic examples. It does not read production messages, credentials or financial records and makes no network requests or state-changing service calls.

## Structure basis

The relationship map is the primary entry and fills the viewport. Compact nodes represent conversations, channel identities, agents and stores. Selecting a node opens a right-hand drawer with two tabs: related records (the default for every new node or drawer opening), and relationships/storage. The records tab contains a single-row filter bar and inline record details. The search field fills the remaining space beside two compact, content-sized status selectors; the relationships/storage tab contains the node description, paths and related-node links. Switching tabs preserves the current search and expanded record. Clicking blank space outside the drawer dismisses it, while clicking another graph node selects that node and clicking a map control performs its own action. The close control is an accessible SVG icon button; Escape remains available. Each record expands inline with the outcome first, followed by original input and storage links. Its processing timeline is expandable, keeping the result immediately visible without forcing the full execution log into view. Each record summary has two rows: title and disclosure action first, then responsible agent, business status, report delivery, time and reference. Long titles truncate in the compact summary and appear in full inside the expanded details. Responsibility and delivery remain visible together. Related-node links stay within the same drawer and provide a return action. There is no page navigation or below-map record list.

At every width the drawer overlays the map from the right over a scrim, and the map keeps its size underneath. On phones the drawer fills the workspace, and the underlying map becomes inert until the drawer closes. The drawer content and zoomed canvas scroll independently, so the page remains one viewport. Fit and zoom controls keep small nodes inspectable. A global records button opens the same drawer without a selected node.

The map distinguishes a bot identity from the agent that performs work. Group roles share business memory but retain separate execution sessions. Sam coordinates; one specialist executes each request. Ordinary private conversations remain a separate existing personal-assistant flow. Penny has its own private conversation and financial stores, and no edge into group dispatch.

Penny exposes only status, responsibilities and storage locations. No amounts, transaction body, screenshot, finance record count or per-transaction financial history appears in the overview or search dataset. The owner uses the dedicated Penny conversation for bookkeeping details.

Storage names and representative locations are user-facing inventory details explicitly requested for this screen. Scope placeholders describe isolation without exposing account identifiers. Shared database files do not imply shared authority: group tasks and work are still scoped to their originating conversation.

The console shell, color tokens, record styling and drawer styling use the shared `agent-console` visual block.

## Demo scaffolding

- The floating `Demo ·` bar marks the synthetic data and changes only processing-list loading results: populated, loading, empty and failed. These controls are not part of the design and must not be implemented in the product.
- Readiness labels are presentation examples, not a live service health check.
- The retry button demonstrates loading recovery only. It does not retry a task or send a message.
- All changes stay in page memory; only the shared demo harness retains reader docking preferences.

## Uncovered dimensions

- Chinese interface copy and light appearance only. Per the project capability declaration, i18n and theming are disabled; their related checks are skipped. macOS distribution does not apply to this non-client prototype.
- At phone widths the map is intentionally pannable at a legible minimum scale; a full-width detail drawer provides the same information without a separate mobile page.
- No production inventory aggregation, new privacy permission, historical timeline backfill, file opening, task mutation, export or live refresh is implemented.
- Current public Penny state only exposes readiness and generic errors. Group state exposes jobs and notice status, but a complete timeline and channel-wide unified record list would require a dedicated read projection before implementation.
- The close icon uses the official Lucide X SVG paths inline, inheriting currentColor. There was no centralized icon-button module to reuse; the new icon box is 28px square with a 16px SVG, matching the existing drawer action height. Legacy prototype icon-bearing markup outside this screen was not exhaustively audited and remains unchanged.

## Invalidated conclusions

- **Layout.** The flat, left-to-right role layout and this page's header-only shell are not the current management-interface direction; the current console uses the agent-link style sidebar shell. The collapsible team tree and the leader private-chat entry are represented in `prototype-team-structures.html`.
- **Group frame and memory node.** The map's group frame label 「同群共享业务记忆 · 执行会话各自独立」 and the 「群共享业务记忆 · 群内角色共用」 store node no longer hold. Only Sam reads the group business memory. Leaders and executors see only their brief plus their own memory scope; executors created from the same capability profile share one scope.
- **Alice, Bill and Jack.** Their drawer descriptions, which say each independently handles requests and shares group business memory, no longer hold. They are team leaders who divide each request into assignments for task-created executors.

ADR-0026, ADR-0027 and `prototype-team-structures.html` are authoritative for these points. The rest of this page remains a reference for the existing system inventory and its privacy and storage boundaries.
