# A skill copied into an Executor's home was not read by its model

Date: 2026-11-11 (agent-teams ticket 17). Found while the feature was being built, before any delivery.

## Root cause

The plan for per-profile skills was to copy each selected skill into the Executor's runtime home (ADR-0027, skill-library::REQ-002). That makes the Codex App Server list the skill, and no more:

- The App Server shows the model one line per skill of the runtime's home: its name, its description and the path of its SKILL.md.
- It puts the SKILL.md's text into a turn only when the turn's text names the skill with `$name`, or the turn carries the skill as an input item.
- An ordinary Codex session opens the listed file with the shell. An Executor has no shell and no file tool that reaches its runtime home.

With the copy alone, an Executor's model would only ever have seen a skill's name and description.

## Why the existing checks did not catch it

- The measurements behind ADR-0027 asked whether a host skill could get into a runtime. Every turn they captured for a runtime's own skill named it with `$` or carried it as an item, except one plain turn. That turn's result, no SKILL.md in the request, stayed in the measurement's working record and reached neither the ADR nor the spec.
- The acceptance test planned for "loads only the skills its profile selects" was the content of the created home. A home that holds the right files passes it whether or not a model reads them.
- The fixture App Server ignores skills, so no fixture-mode test could tell the two apart.

## Defenses

- Each Executor turn carries every skill written into its home as a skill input item (skill-library spec, Implementation Decisions, "Runtime home").
- The case on the installed App Server, "an Executor runtime created with its profile's skills offers exactly those" in `tests/isolated-model-runtime.test.ts`, asserts both halves: a turn that neither names nor carries the skill holds none of its SKILL.md, and the turn as the host sends it holds it.
- Real main records the input items of each Executor turn, and `tests/skill-library.integration.test.ts` asserts the skill item on each.
- The real-model suite has a scenario whose Executor result must show a mark that only the SKILL.md asks for.

## Boundaries

- The installed-App-Server case is opt-in, because CI has no Codex executable: rerun `pnpm test:isolated-runtime` after a Codex upgrade.
- A SKILL.md the App Server refuses to list is not put into a turn even when the turn carries it. Two refused shapes are refused at import; any other is not detected (skill-library spec, failure modes).
- Only SKILL.md reaches the model. A skill's other files are copied, and an Executor cannot read them.
