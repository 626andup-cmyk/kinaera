# Rebuild step 1b: remove

This step removes everything section 4 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md) leaves behind: the stage-1 migrations and every place where Jev (the small decision model) decided something on your friend's behalf. What's left works as it did in Aettica, except that those decisions now belong to your friend, or to plain rules.

## What went

| Gone | What happens instead |
| --- | --- |
| `src/legacy.ts` (importing a stage-1 chat) and `src/sheets.ts` (reading character sheets) | Nothing. The example character is read from `defaults/character.md` by a few lines in `src/store.ts` (`defaultCharacter`). |
| `src/judge.ts`: Jev's double-checks | Each one is now your friend's call, or gone (below). `CHECK_LIMIT` moved to `src/check.ts`, where `check` will be built in stage 3. |
| The Jev "is it the moment?" gate on wake-ups | The hard rules (chattiness, quiet hours, cooldown, never twice without you writing, not mid-conversation), then your friend's own turn. Doing nothing is always fine. |
| `src/keeper.ts`, the notebook keeper | Your friend keeps the notebook themselves, with the notebook tools. |
| The heartbeat's generate-and-grade, and `src/ideas.ts` (the idea drawer) | The heartbeat just gives your friend a free moment (a wake-up with the reason "heartbeat"). |
| Settings: "Double-check with Jev", "Notebook keeper", "Check every", and the idea drawer | Nothing. |
| `docs/stage-*.md`, `docs/jev-audit.md`, `docs/notebook-keeper.md` | These were Aettica's history. They're still in the [Aettica repository](https://github.com/626andup-cmyk/aettica/tree/main/docs), and `DESIGN.md` links there. New docs are written as each rebuild step is built. |

### Where each Jev check went

- **Comment replies.** Aettica asked Jev whether your comment on your *own* message invited a reply. Now your friend always gets the turn. The prompt tells them that it may be a note you left for yourself, and that leaving it is fine (`do_nothing`, or `[nothing]` without tools).
- **Deleting an entry.** Your friend's own entries are deleted when they ask, as with any other tool.
- **Editing your entries.** Your friend edits your entries directly only where you've set the entry (or its folder) to let them. Otherwise it's a suggestion, as the notebook's permissions already say.
- **Summary faithfulness.** Summaries are written from the messages only, as before, without a second check.
- **Channel mentions in OOC.** A channel named in the conversation, even as a bare word ("story"), gets its fuller summary in the prompt. Your friend can tell whether it's relevant.

## What stayed, for now

- **Jev itself** (`src/jev.ts`: the client and the series maths), **Test Jev** and the **Jev log**. Nothing calls Jev on its own any more. In stage 3, `check` becomes its only caller and the Jev log becomes the check log.
- **Proposals** (asking you to approve deleting a channel). They move into the unified inbox in stage 3.

## The database

Kinaera doesn't open Aettica's databases (the stage 8 importer will read them instead), so Aettica's 13 upgrade steps were folded into **one starting layout** in `src/db.ts`. It is Aettica's final layout without the keeper's and the idea drawer's tables, and with the wake-up outcome "declined" (Jev said no) gone. A new database still starts with one connection profile that writes both roleplay and OOC.

## Checked

- `bun run typecheck`: clean.
- `bun test`: 431 tests pass. The tests of removed code went with it. The heartbeat, wake-up and comment tests were rewritten for the new behaviour, and all of them check that no Jev call is made.
- In a phone-sized browser: the app loads with no console errors, the Settings dialog opens and saves, and "Beat now" gives your friend a turn.
