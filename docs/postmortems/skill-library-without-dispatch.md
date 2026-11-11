# A service without dispatch took every skill for unused

Date: 2026-11-11 (agent-teams ticket 17). Found by the independent review, before any delivery.

## Root cause

The Skill Library asks its host two questions: which profiles select a skill, and which versions a profile or a request still needs. `main.ts` answered both from team management and the dispatch records, and answered "none" when neither exists.

A service runs without them whenever no dispatch group is configured, while the team registry and the dispatch store keep their data for when dispatch is enabled again (agent-console::US-009). "None" then meant that every skill could be deleted and every superseded version removed:

- the start's own clean-up removed the version a failed request had been admitted with;
- a skill that a stored profile selects showed as unused and could be deleted;
- once dispatch was back, that team could not be saved, because its profile named a skill the library no longer had, and its Assignments failed.

## Why the existing checks did not catch it

- Every test of the wiring started the service with dispatch, and every test of the library gave it its answers directly. No test started the service without team management.
- The library's own safe answer existed and was tested: "cannot tell" removes nothing. Nothing asked which answer `main.ts` gives without dispatch. The comment beside the wiring said the library removes none until the records can be read; the code returned an empty set.

## Defenses

- Without dispatch the host answers "cannot tell" for needed versions, so nothing is removed, and reads the uses from the stored team definitions (skill-library spec, Implementation Decisions, "Uses" and "Version removal").
- A real-main case in `tests/skill-library.integration.test.ts` turns dispatch off and on again as the owner does. It asserts that the versions stay, that the stored profile's skill cannot be deleted, and that the retried request's Executor gets the version it was admitted with.
- `storedDefinitions` has a case of its own in `tests/team-registry.test.ts`.
- The first form of this defense read the stored definitions at the top level of the start, so a registry file that could not be opened stopped a service that needs it for nothing else. The second review found that. The read is now contained: such a service starts, treats every skill's uses as unknown, and deletes none. A second real-main case starts the service without dispatch twice, with no registry file and with one that is not a database.

## Boundaries

- A service that cannot read its stored definitions shows every skill as unused, and says why only when a deletion is refused.
- No version is removed for as long as dispatch stays off, however many re-imports are made meanwhile.
