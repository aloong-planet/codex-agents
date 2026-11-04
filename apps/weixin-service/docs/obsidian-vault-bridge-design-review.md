# Obsidian `demo` Vault bridge design review

## Review result

Approved after tightening five design points before implementation.

1. **Do not grant App Server generic workspace access to the Vault.** The existing thread
   keeps its current sandbox and approval policy. Only the four dynamic functions cross the
   boundary, so a model cannot turn a note request into shell or patch access.
2. **Separate the two permissions.** Enabling WeChat auto-reply must not silently authorize
   note writes. Vault authorization is a second visible, persisted switch.
3. **Avoid blind update.** A path plus content is insufficient because the user can edit the
   note in Obsidian between read and write. Update therefore requires the revision returned
   by read and fails on mismatch.
4. **Do not mistake atomic replacement for a perfect cross-process transaction.** The module
   checks identity, size, and modification time again before rename, but Obsidian and this
   direct filesystem bridge share no lock protocol. The UI and reply must describe the
   mechanism as conflict-aware, not race-free.
5. **Keep discovery non-sensitive.** Search returns paths only and skips hidden directories;
   bodies are disclosed only by an explicit read call. Public HTTP state exposes neither
   paths inside the Vault nor note content.
6. **Do not rely on prompt intent as authorization.** The original WeChat text produces a
   per-turn operation allow-list in the host. An enabled Vault plus a read-only message still
   cannot create or update a note.

## Failure-path audit

- Restart with legacy state: default disabled, no accidental authority expansion.
- Permission persistence failure: no in-memory enable, HTTP error visible.
- Missing Vault or `.obsidian`: tool fails closed; chat remains available.
- Malformed dynamic call: stable failure response; App Server turn can continue.
- Traversal, hidden path, non-Markdown path, symlink: rejected before content access.
- Existing note on create: refused without overwrite.
- Concurrent edit on update: revision or metadata mismatch prevents replacement.
- Tool output or server error: no absolute root, credential, token, or stack trace returned.
- App Server restart: experimental dynamic tools are persisted with the dedicated thread;
  tool host still gates every invocation using restored local authorization.
- Restart before the first turn: the precise missing-rollout response creates a replacement;
  broader resume failures are not swallowed.
- iLink send failure after a successful note write: no automatic retry and no second write;
  transcript truthfully marks the outbound failure.

## Deferred work

Obsidian Local REST API, an in-Vault companion plugin, attachments, deletes, renames, cloud
sync confirmation, and multi-Vault selection are deliberately outside this first vertical
slice. They need new trust and concurrency decisions rather than incidental expansion here.
