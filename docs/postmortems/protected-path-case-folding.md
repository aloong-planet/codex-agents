# Protected paths compared by case on a case-insensitive volume

## Failure and root cause

Found on 2026-11-08 in code review of ticket 24 (workflow-runs::CON-003), before release. The file tools refuse a set of protected locations: the service state, the configuration files, the Codex home and the LaunchAgent files. The sandbox worker compared candidate paths against that set as plain strings. On APFS, which is case-insensitive like the CI runner `macos-15`, one file has many spellings:

- A protected location that did not exist yet could be created under another spelling. A write to `LaunchAgents/SVC.PLIST` passed the check and created the file that launchd loads as `svc.plist`. A directory root such as `~/.openclaw` could be created as `.OPENCLAW`.
- A protected root configured in another case than the one on disk never matched. `canonicalProtectedPath` used `fs.realpathSync`, which keeps the case it is given. The worker uses `fs.promises.realpath`, which returns the on-disk case, so a `CODEX_HOME` written as `.Codex` left `.codex` fully readable.

Existing roots were safe when spelled the on-disk way, because the worker's real-path step normalized the candidate. The gap needed a root that was absent or configured in another case. The group-only protection that preceded ticket 24 had the same gap.

## Why existing checks did not catch it

Every boundary test built its protected set and its requests in the same spelling as the files on disk, and every protected root in those tests already existed. No test wrote a case variant, and none configured a root in another case. The difference between the two realpath APIs was never measured; reading the code made the comparison look exact.

## Defense now in place

- The worker folds denied roots and candidates (NFC normalization, lower case) for both the denied check and the filter that drops scopes inside the set. Folding can only widen what is refused.
- `canonicalProtectedPath` uses `fs.realpathSync.native`, which returns the on-disk case.
- `tests/local-file-tools.test.ts` "refuses every protected root …" now:
  - configures `Channel.json` for an on-disk `channel.json`;
  - adds a protected directory root that does not exist yet;
  - writes `LaunchAgents/SVC.PLIST` and `OPENCLAW/config.json`.

  It was red before each half of the fix and green after.

On a case-sensitive volume, folding also refuses a sibling that differs from a protected root only by case. This is accepted as failing closed.
