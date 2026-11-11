# ADR-0032: Narrow a file grant by every scope saved below it

- Status: Accepted (2026-11-11)

## Context

The file tools serve the saved scopes of two modules at once: the notes vault, and the local media folders `~/Downloads`, `~/Pictures` and `~/Documents`. The permission specification said that between a parent and a child scope the more specific one decides, but the file tools did not apply it. Each sandbox received its module's readable roots, and Node's permission flags cannot take a subtree out of a readable root. A vault saved with reading and writing off was therefore searched and read through a granted Documents folder above it. Production's vault lies under `~/Documents`, so that layout exists there.

Closing the gap needed a rule for cases the old sentence left open: scopes of different modules, two modules that save the same directory, a module that was never saved, and more than two levels of nesting.

## Options

1. **Through a grant, every saved scope that lies strictly below the grant and contains the path must allow the access, whichever module saved it.** A scope with reading and writing off closes its subtree. A read-only scope leaves its subtree readable and refuses writes there.
2. Across modules count only a closed scope, and let a read-only scope narrow only inside its own module — rejected. A granted media folder is always saved read-only, so under option 1 it refuses writes through a vault above it, for example a vault that is the home directory. Option 2 avoids that. But it gives one saved flag two meanings, depending on which module's grant is used, and it leaves "read-only below a read-write parent" a layout the settings page cannot produce. Where the vault lies below a media folder, as in production, both options behave the same.
3. Let two modules' scopes at the same directory narrow each other — rejected. Neither lies below the other, and each is an explicit grant of that directory for its own module. Taking the smaller of the two would remove the notes module's write access from a vault that is also a granted media folder.
4. Treat the directory of a module that was never saved as closed — rejected. An unsaved preselection is not a scope (failure mode 14 of the permission specification) and the store holds nothing for it, so the file tools would need the module definitions as a second source of authority. The owner closes a vault by saving it closed.
5. Let the most specific scope decide at every depth, so that a readable scope inside a closed one is also reachable through the grant above both — rejected. Search would have to walk into a closed directory to reach the readable one below it. Under option 1 search never enters a closed subtree, and the inner scope stays reachable through its own grant.

## Decision

We adopt **option 1**, specified as failure mode 4 of the [workflow module permissions specification](../specs/workflow-module-permissions.md).

The host computes, from what both modules have saved, the directories below each grant that are closed and those that are read-only. It gives them to every sandbox it creates, at a turn's binding and for a send snapshot. The sandbox worker decides per path, by the mechanism that keeps the service's own state outside every grant ([ADR-0029](0029-keep-service-state-outside-every-file-grant.md)). Find and grep omit a closed directory. A read, a send snapshot or a write that resolves into a closed directory, and a write into a read-only one, is refused with `local_file_permission_denied`.

Before each call the host checks that the scopes saved now narrow the addressed grant as they did when the turn was bound, and returns `local_file_permission_changed` otherwise. `files.read` gained this check together with the check of its grant's own revision, which the other file tools already made.

## Consequences

- Positive: a vault saved closed stays closed to the file tools under any grant above it, in private turns, group turns and Executor turns, for search, read, write and send.
- Positive: one rule covers both flags and both modules, and it is enforced where the service-state boundary already is.
- Negative: a granted media folder below a writable vault cannot be written through the vault's grant.
- Negative: once a scope below a grant is saved with different access under a running turn, that turn's later calls through the grant fail, also for paths outside that scope. A read through an earlier reference now fails after its grant's module is saved again, even when the save widened access.
- Neutral: where the vault lies below a read-only media folder and is itself readable, nothing changes: reads through the folder pass, and writes through it were already refused.
- Neutral: the local-image workflows scan a granted media folder through the image library, which is a separate path and does not apply saved scopes. This decision covers the `files.*` tools and the send snapshots taken from their references.

## Sources

- [Workflow module permissions specification](../specs/workflow-module-permissions.md), failure modes 4, 8, 9 and 14.
- [ADR-0029](0029-keep-service-state-outside-every-file-grant.md), for the enforcement in the sandbox worker.
- Dispatcher decisions on the owner's delegation, 2026-11-11: option 1, and the rejection of options 2 to 5.
- Reproduction on 8d4755a before the fix: with a vault saved closed below a granted Documents folder, a fixture private Weixin turn and a dispatched Executor each found the vault's files by name and by content and sent them.
