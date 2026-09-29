# Rebuild step 1a: copy and rename

This is the first step of turning Aettica into Kinaera (see [KINAERA_REBUILD.md](../KINAERA_REBUILD.md), section 9). It changes names only. Kinaera behaves exactly as Aettica did.

## What was done

- Every file from Aettica (commit `c82b018`) was copied in, apart from `LICENSE`, which Kinaera already had (it's the same AGPL text).
- Names were changed everywhere: in the code, the prompts, the docs, the page and the tests.
  - Aettica → Kinaera, and aettica → kinaera (so the database file is now `data/kinaera.db`).
  - partner → friend, in every form: `partnerId` → `friendId`, `HubPartner` → `HubFriend`, and so on.
  - Three files were renamed to match: `src/partner.ts` → `src/friend.ts`, `defaults/partner.md` → `defaults/friend.md`, `docs/partners.md` → `docs/friends.md`.
- Four sentences read oddly after the swap because they already said "friend" once, for example "You're the user's roleplay friend … You're friends." They were reworded so they say the same thing without repeating it:
  - the out-of-character framing in `src/prompt.ts`;
  - the "Surprise me" instruction in `src/rng.ts`;
  - the heartbeat comment in `src/heartbeat.ts`;
  - one line in `DESIGN.md`.

## Things worth knowing

- **Stored names changed too.** Messages written by the friend are saved with the author `"friend"` rather than `"partner"`. Because Kinaera starts with fresh data, nothing needs migrating. Old Aettica data will come across through the importer in stage 8, which will have to translate these names.
- **`src/legacy.ts` no longer reads old Aettica stage-1 chats correctly**, since those say `"partner"`. It is removed in step 1b anyway.
- **The old `docs/stage-*.md` files are Aettica's history** with the names changed, so they say "Kinaera" about work that happened in Aettica. They are replaced in step 1b.

## Checked

- `bun test`: 481 tests pass, the same number as in Aettica.
- `bun run typecheck`: clean.
- The server starts, and the app loads at phone size with no errors in the browser console.
