# A named pipe called SKILL.md made a folder read wait without end

Date: 2026-11-11 (agent-teams ticket 17). Found by the second independent review, before any delivery.

## Root cause

The Skill Library walks an owner-supplied folder without opening anything but regular files: the walk learns each entry's type from the directory listing and only lists the entries that are neither files nor folders.

A fix after the first review made the library read the root SKILL.md before the walk, so that a large folder that is not a skill is refused at once. That read opened `<folder>/SKILL.md` without first learning what it is:

- Opening a named pipe for reading waits until some process opens it for writing. Nothing ever does.
- Each waiting open holds one of the process's four file-system threads. With four waiting, no other file call of the service answers.
- The page allows one request at a time and waits for its answer, so its buttons stopped working until a reload.

A socket at that place was refused as an unreadable folder instead of being listed.

## Why the existing checks did not catch it

- The case for entries that are neither files nor folders put its named pipe below the root, where only the walk meets it.
- The case that drove the new read's "not a file" branch used a folder named SKILL.md, which opens without waiting.
- The fix was checked against the finding it answered (refuse before reading the rest), not against the rule the walk already kept (never open what was not seen to be a regular file).

## Defenses

- The root SKILL.md is looked at without being opened, and read only when it is a regular file. Anything else is left to the walk, which lists it (skill-library spec, failure modes and "What a folder holds").
- Every open of a source file is made without waiting, and what was opened is checked to be a regular file before it is read. This covers a file that is replaced by a pipe after it was listed.
- `tests/skill-library.test.ts` has a case with a named pipe and one with a socket as the root SKILL.md. On the earlier code the first timed out and the second answered "unreadable folder".

## Boundaries

- A file replaced by a pipe or a link between being listed and being opened cannot be driven by a test; the open flags are its only guard.
- The same rule applies to any later code that reads files of an owner-supplied folder: learn the entry's type before opening it, and open without waiting.
