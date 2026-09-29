# Rebuild stage 2: messages with history

Nothing is ever overwritten in place any more. Every edit keeps the versions before it, deleting leaves a tombstone, and a regenerated reply is kept as an alternate. Your friend can fix their own mistakes quietly, and everything you do to their messages or their identity is written down where they can read it. See section 5.1 and section 6.10 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md).

## Using it

- **"(edited)"** next to a message's time: tap it to see every version of the text, who wrote each one, and when.
- **"↻ 2"** on a reply you regenerated: it has replaced one earlier reply. Tap it to read the earlier ones. (Two regenerations make "↻ 3", and so on.)
- **Deleting** a message takes it out of the chat and out of your friend's prompts, but it's kept. **Clear messages** in channel settings does the same for every message in the channel.
- **Friend menu → What you've changed**: the intervention log. It lists everything you've done that affects your friend, newest first. Your friend can read the same log.

## What your friend can do

With a profile that can use tools, your friend gets four new tools:

| Tool | What it does |
| --- | --- |
| `edit_my_message` | Changes one of their own earlier messages in this channel (the latest, or one they quote). Every version is kept. |
| `delete_my_message` | Takes one of their own messages out of the chat. It's kept in history. |
| `read_message_history` | Shows any message's versions, and the replies it replaced. |
| `read_interventions` | Reads the intervention log. |

They can't edit or delete your messages. You can edit and delete anyone's.

## What your friend is told

Messages appear in the prompt with their **current text and no markers**. Every turn also gets one honest note under **"Good to know"**: the user sometimes edits or regenerates messages, including theirs, and they can read any message's history. (Without tools, the note leaves out the tools.)

The wording is in `defaults/standing.md`, one `## name` section per note, where you can read and edit it. Keep it true: the prompt must never describe something the app doesn't do. `src/wording.ts` reads it fresh on every turn.

Stage 4 adds the self-page. There, your friend will be able to ask for markers on edited messages instead.

## The intervention log

`src/interventions.ts`. Each entry is one sentence addressed to your friend, written automatically:

| When | Entry |
| --- | --- |
| You edit one of their messages (or a scene break they made) | "The user edited your message in #story." |
| You delete one | "The user deleted your message in #story: "…"" |
| You regenerate their reply | "The user regenerated your reply in #story (with …). The earlier one is kept as an alternate." |
| You clear a channel with their messages in it | "The user cleared every message in #story." |
| You change their name, avatar, colour, identity, any of their writing prompts, or texting | "The user changed how you write in literary scenes." |

Your own messages, and your friend's own edits, aren't interventions, so they aren't logged. Nothing about any of this is ever inserted into the chat.

## How it's stored

Migration 2 in `src/db.ts`:

- `messages` gets `edited_by`, `deleted_at`, `deleted_by` and `superseded_by` (the turn id of the reply that replaced it).
- `message_revisions`: each version of an edited message. The first edit also saves the original, so a message with no rows here was never edited.
- `interventions`: the log.

In `src/store.ts`, `getMessages`, `lastMessage` and the other chat queries only return live messages, meaning not deleted and not replaced. `getMessage` and `history` see everything. Summaries are marked out of date when a message they cover is edited, deleted or replaced, exactly as before.

## API

- `GET /api/messages/:id/history`: `{ message, revisions, alternates }`.
- `GET /api/interventions`: the log, newest first.
- `PATCH` and `DELETE /api/messages/:id` now answer 404 for a message that's already deleted or replaced.

## Checked

- `bun run typecheck`: clean.
- `bun test`: 453 tests pass, 19 of them new in `test/history.test.ts`. They cover versions and who wrote them, tombstones leaving the chat and the prompt, two regenerations in a row, what is and isn't logged, each tool (including one used in a real turn), the prompt's note (and no markers), the API, and reading wording files.
- In a phone-sized browser: sending, regenerating and editing a reply shows "(edited) ↻ 2", the history shows all three versions in order, and the intervention log lists the edit and the regeneration. There were no console errors.
