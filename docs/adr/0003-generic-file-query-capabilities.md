# ADR-0003: Separate generic file discovery, content search, and reading

- 状态: 已被 ADR-0007 取代

## Context

The first note-send workflow put title/path matching, body fallback, file reading, and note-specific opaque handles behind `notes.search` and `notes.read`. That closed the first Obsidian slice, but it makes every future local-file module repeat search behavior and leaves `grep` and `read` conceptually blurred.

Codex, Claude Code, and Grok Build all expose local lexical discovery rather than requiring a vector index. Their concrete surfaces differ, but the stable boundary is the same: find paths, grep contents, and read a selected file are separate operations. The project additionally requires install-time directory grants, opaque references, durable workflows, and no execution of user files.

## Decision

Introduce a module-agnostic local-file query module with reusable host primitives:

- `files.find@1`: search authorized file names and relative paths only.
- `files.grep@1`: search authorized text-file contents without returning full file bodies.
- `files.read@1`: read one previously resolved file into a private content sidecar and return only an opaque content handle plus integrity metadata.
- `files.locate@1`: workflow composition that runs `find` first and invokes `grep` only when name/path discovery has no candidates. It lets reviewed durable templates preserve the title/path-first policy without duplicating orchestration in every domain Provider.
- `files.authorized_scopes@1`: intersect a reviewed local-directory catalog with current read grants and return only opaque scope IDs.

New natural-language file workflows use `files.resolve@1` as their stable workflow seam. Its isolated
Resolver Agent receives the original request and host-bound scope/extension references, and can call only
`files.find/files.grep`. The host executes deterministic search and sorting, records each result set, and
accepts only candidate refs from that recorded set. The Agent never supplies paths, module IDs, permissions,
accounts, targets or effect arguments.

Search results contain an opaque `fileHandle`, safe display name/path, match source, bounded score/count metadata, expiry, and an explicit `truncated` signal. They never contain absolute paths, context tokens, or full body text.

The new note-send workflow becomes:

`files.resolve -> input_gate -> weixin.send_file`

The new local-image workflow becomes:

`files.authorized_scopes -> files.resolve -> input_gate -> media.prepare_image -> weixin.send_image`

It never calls `files.read`. Content Q&A and future updates must explicitly call `files.read` after selection.

Generic file capabilities receive a literal `moduleId` and `scopeId` from a reviewed workflow template. The engine freezes the matching permission snapshot and rechecks the same module/scope before every invocation. A model cannot provide or replace the module binding. File execution remains absent from the capability catalog.

No vector database or embedding model is introduced. `find` uses bounded Unicode-normalized path/name matching; `grep` uses bounded lexical text matching. The Intent Planner only classifies the workflow intent. The Resolver Agent emits bounded `nameTerms`, `pathTerms`, `contentTerms`, scope refs and supported sort enums through bound tools. `files.locate` and its one-shot query rewrite remain compatibility behavior for old frozen workflows, not the new natural-language planning path. The host does not maintain a stop-word deletion list.

## Consequences

- Notes, local media, and later file modules can share one safe query implementation.
- `grep` cannot silently become a full-file read, and sending an existing file does not place its contents in model context or workflow SQLite.
- Permission snapshots must support a trusted literal module binding instead of a capability descriptor hard-coded to one module.
- Existing note-specific capabilities and `files.locate` remain registered for frozen-run compatibility; new note-file and local-image workflows use `files.resolve`.
- Search remains lexical. Conceptual queries with no filename/path/content term overlap require Agent query rewriting or user clarification, not embeddings.

## Follow-up decision

ADR-0005 and ADR-0006 replace only the new-intent entry point: the main Weixin Codex turn selects `files.send`. The internal File Resolver continues to call the `files.find`, `files.grep`, and `files.read` capabilities defined here; their responsibility split is unchanged.
