# Obsidian `demo` Vault bridge design

## Goal and acceptance boundary

Extend the dedicated Codex App Server WeChat service with an explicitly authorized local
Markdown bridge for the Obsidian Vault named `demo`. A WeChat user can ask the already
authorized dedicated Codex target to search, read, create, or update a Markdown note. The
service must report the real local result and must never imply that Obsidian Sync completed.

The production Vault root is fixed to `/Users/loong_zhou/Documents/demo/demo`. The web page
shows only the Vault name, never its absolute path. This feature does not use OpenClaw, does
not modify the Tencent plugin, and does not send any message during automated verification.

## Deep-module boundary

`DirectMarkdownVault` owns every filesystem detail behind four narrow operations:

- `search(query)` returns bounded matching Markdown paths.
- `read(path)` returns content and its SHA-256 revision.
- `create(path, content)` creates a new Markdown note and refuses overwrite.
- `update(path, content, expectedSha256)` replaces an existing note only when the caller's
  revision still matches.

`VaultDynamicToolHost` exposes those operations as App Server dynamic functions and owns the
single authorization switch. `CodexConversation` only knows a generic `DynamicToolHost`
interface: tool definitions at `thread/start`, and request dispatch for `item/tool/call`.
All existing command, patch, permission, user-input, and MCP approval requests remain denied.
The App Server initialize request opts into `experimentalApi`, which is required for dynamic
tools by the installed protocol.

## Safety invariants

1. The root is fixed by trusted server startup code, not a browser or model argument.
2. Only relative POSIX paths ending in `.md` are accepted. Empty paths, absolute paths,
   backslashes, NUL, dot segments, traversal, and any hidden path component are rejected.
3. Existing path components and files must not be symbolic links. Nested directory creation
   walks one component at a time and rechecks each component.
4. Search never enters hidden directories, returns at most 20 results, and does not return
   note bodies.
5. A note is at most 1 MiB and tool content input is at most 100,000 UTF-8 bytes.
6. Create uses exclusive creation. Update requires a caller-supplied SHA-256 revision and
   rechecks file identity/size/time immediately before an atomic same-directory rename.
7. Delete, rename, attachment access, arbitrary extension access, and `.obsidian` access do
   not exist in the public interface.
8. Dynamic tools return structured, redacted success/failure text; they never expose the
   absolute Vault root or stack traces.
9. The Vault bridge starts disabled, is enabled/disabled separately from WeChat auto-reply,
   and the choice is stored in the existing private 0600 state file.
10. Enabling the bridge is not sufficient for a write. At the start of each serialized WeChat
    turn, the host derives a conservative allow-list from the original message: it must name
    a Vault/note/file concept and an explicit search/read/create/update action. The allow-list
    is cleared at turn completion, and one action cannot escalate to another.

## User-operation state paths

### Page load and service restart

- Old state without `vaultWriteEnabled` loads as disabled.
- New state restores the switch. The public page shows `demo` and the current permission.
- A saved task created before its first turn may have no rollout yet. Only the exact
  `no rollout found for thread id` response falls back to a replacement dedicated task;
  active-writer and all other resume errors remain failures.
- A missing or invalid Vault is reported through tool failure without leaking its path; it
  does not prevent ordinary chat.

### Enable or disable

- Clicking enable persists permission before the in-memory tool host is enabled.
- If persistence fails, permission remains unchanged and the HTTP request fails.
- Clicking disable persists disabled before changing the host. In-flight filesystem calls
  that already passed the gate may finish; future calls fail closed.

### Incoming WeChat message

- Unauthorized targets and duplicate messages remain ignored by the existing service.
- Ordinary chat does not require a tool.
- The prompt permits a Vault tool only when the message explicitly asks to search, read,
  create, or modify a note. Ambiguous intent must lead to clarification, not a write.
- The dynamic tool host independently enforces the operation allow-list from the original
  WeChat text, so prompt noncompliance still fails closed.
- Tool disabled or rejected: Codex explains that the page permission is required.
- Create collision or update conflict: no overwrite occurs; Codex reports the conflict and
  asks the user to retry after reading the latest note.
- A successful tool call is followed by one normal Codex text reply through the message's
  captured iLink context. Existing no-retry outbound behavior is unchanged.

## Dynamic tool contract

Function names use a dedicated prefix and JSON-schema object arguments:

- `obsidian_search_markdown`: `{ query }`
- `obsidian_read_markdown`: `{ path }`
- `obsidian_create_markdown`: `{ path, content }`
- `obsidian_update_markdown`: `{ path, content, expectedSha256 }`

Tool output is an App Server `inputText` content item containing compact JSON. Reads return
the relative path, note content, and revision; writes return the relative path and new
revision. Failures set `success: false` and return a stable Chinese error category.

## Verification

- Unit: path rejection, hidden/symlink rejection, search bounds, exclusive create, revision
  conflict, real update, authorization gate, dynamic tool result redaction.
- Integration: thread start advertises definitions and a real `item/tool/call` reaches the
  host while all other App Server requests remain denied.
- Service/store/HTTP: backward-compatible state, permission persistence, public redaction,
  and explicit enable/disable endpoints.
- Browser E2E: the page displays `demo`, enables and disables permission with visible
  feedback in fixture mode.
- Full lint, typecheck, unit/integration tests, build, and Playwright E2E.
- Final real closure is user-assisted: enable the target and Vault permission, then send one
  explicit WeChat instruction. No automated test sends a WeChat message or edits the real
  Vault through Codex.
