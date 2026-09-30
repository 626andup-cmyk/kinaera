# Rebuild stage 4: your friend's own things

Your friend now has things that are theirs: an identity they can rewrite, a self-page, a private journal, a say in how their context is built, and a practice channel where they try things out. This is sections 6.1, 6.2, 6.4, 6.9 and 6.13 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md). Most of it needs a profile that can use tools.

## Their page

Tap your friend at the bottom of the sidebar. Their page (`public/js/friend-self.js`) shows:

- **Who they are**, with their **tastes**, and a changelog of every version, marked with who wrote it.
- **Their self-page**: what they say about themselves, what their writing shows, and how they'd like feedback.
- **Their journal**, as counts only. It's private.
- **Orientation**, with a button to invite them to one.
- Buttons for **Settings…** (the old friend menu: name, avatar, colour, how they write), **What you've changed** and the **Check log**.

## Identity belongs to them

`src/identity.ts` keeps every version in `identity_versions`. The current one is also mirrored into the `friendPrompt` setting, so everything that read it before still works.

- `revise_identity({ identity?, tastes?, note? })`: they rewrite who they are, their tastes, or both.
- **Your changes are suggestions.** "Suggest a change" on their page, or editing "Who your friend is" in Settings, makes a suggestion. It's listed in their next turn, and they answer it with `review_identity_suggestion({ id, decision, reply? })`. It wakes them if the hard rules allow. Until they answer, you can withdraw it (from their page, or the inbox under "Waiting for…").
- `read_identity_history` shows them every version and suggestion.
- **Tastes** are what they love, what bores them, and what they'd never write. Arlo's are in `defaults/tastes.md`. "Surprise me" for a new friend now rolls tastes along with who they are. A friend made before this starts with empty tastes, which they can write themselves.

## The self-page

`src/selfpage.ts` holds four things:

- **What I say about myself** and **How I'd like feedback**: theirs to write (`write_self_page`).
- **The short version** (at most 600 characters): kept in their prompt every turn. It's also written with `write_self_page`.
- **What my writing shows**: notes, each from you or from a mirror pattern they kept (the mirror is stage 6). **Add a note** on their page sends a suggestion. They accept or decline it, with an optional reply shown beside it (`review_self_note`). They can dispute any note at any time (`dispute_self_note`).

**Edit markers** are a feedback preference too. If they turn them on (`write_self_page({ edit_markers: true })`), messages that someone edited show as "(edited by the user) …" in their prompt. They're off by default.

## The journal, and forgetting

`src/journal.ts`. The journal is private, and **its text never appears on any screen or in any log**:

- Journal tools are marked `private`. The tool log keeps that they ran, never their arguments or results. The console log says "(private)".
- "Preview prompt" and `read_prompt_manifest` replace entries with a placeholder.
- `check` can search it when asked (`sources: ["journal"]`). The check log then shows where a passage came from, never what it says.
- Their page shows only how many entries there are, and how many are kept.

Their standing notes tell them the truth about this: the text goes to the model providers that write their turns, to Jev when they check it, and to a consultant when they attach entries to `consult` (`defaults/standing.md`).

**Forgetting.** A turn's prompt has every entry they **kept**, plus their three newest, within about 2,500 characters. Older entries they didn't keep **fade**: the prompt says how many aren't shown, and `read_journal({ search? })` still finds them. The tools are `write_journal`, `read_journal`, `keep_journal_entry`, `edit_journal_entry` and `delete_journal_entry`.

**The weekly look back.** Once a week (the first a week after this version starts), a quiet turn in the practice channel shows them the week's entries, to keep, rewrite or let go of. It follows quiet hours, the cooldown and chattiness ("off" means no look back).

## Seeing their own prompt

- `read_prompt_manifest` lists each section of their context and its size. It also covers messages: how many are in full, what's summarized, and how many were left out. Then which journal entries are in, how long the short self-page is, and which notebook entries are pinned. It's built from the same prompt a turn sends. A line at the end of every prompt ("What's in front of you") gives the short version.
- `keep_verbatim({ quote })` keeps a moment in full when it scrolls out of the recent messages, instead of being summarized. There are **three slots per channel**. `release_verbatim` frees one. For anything else about their context, they `ask` you (kind "prompt").

## The practice channel and orientation

Every friend has a **practice channel**. It sits apart at the bottom of the sidebar. You can read it, but not write in it, edit it or delete it. Nothing in it feeds anything else:

- no summaries;
- it's left out of the channel list in other prompts, and out of mentions and digests;
- its sample notes (a **Practice** folder, from `defaults/practice.md`: Marrowby, Fen Aldous, the Lantern Fair) are pinned only there, and aren't in any other listing, prompt or check.

**Orientation** (`src/orientation.ts`, wording in `defaults/orientation.md`) is a turn of their own in the practice channel. It's an invitation to try their tools, with a guide listing only the steps whose tools they have. Nothing in it can be passed or failed. It happens:

- **when they're made**: a new friend's first turn of their own;
- **when they ask**: `start_orientation({ focus? })`;
- **when you invite them** (their page): inviting gives them a turn soon (like a suggestion to review, if the hard rules allow), where they're told. Calling `start_orientation` then is a yes; not calling it that turn is a no;
- **when a profile joins a roulette**: they're told once that a new model may be writing as them, and offered an orientation. It isn't started for them.

**How a turn of orientation works.** The whole orientation is one turn. They call tools one after another, with room for 12 rounds instead of the usual 6, and it ends when they stop. They don't have to write a message at all. A message is saved only when a turn ends, so if they write one, a short **second part** follows straight on (no cooldown) where they can try `edit_my_message` on it. The look back gets the same room.

Asks made during an orientation are marked "(orientation)" in your inbox. Orientation and the look back are started by a timer (`Rhythms`, checked every minute). They follow quiet hours and the cooldown, but not "no double texts" or "never mid-conversation", because they message no one. Their cooldown counts from their last turn of their own, not from wake-ups that wrote to you, so an orientation doesn't wait an hour behind the turn where they accepted. No phone notification is sent for them.

**Telling where it stands.** Their page says, and keeps it up to date while open:

- what happened to your invitation, in plain words. For example:
  - they were given a turn to answer, or couldn't be (and why);
  - they answered without calling `start_orientation`;
  - the turn was written by a profile that can't use tools. They aren't told on such a turn, since they couldn't answer, and the invitation keeps waiting;
- whether they're invited and haven't answered yet;
- whether they've said yes and it's waiting to start, and what's holding it (quiet hours, the cooldown, a profile without tools);
- whether it's running now;
- how the last one went and when, plus what they said to your last invitation.

**Open #practice** takes you there. The practice channel also gets an unread dot when they write in it, and orientations are listed under Settings → Recent wake-ups. Every wake-up a rule stops is now printed in the server's log (`[wake] review skipped: …`), and so is what happened to an invitation (`[orientation] …`).

Drafts and scheduling your own wake-ups are part of the guide's orientation, but they arrive in stage 5.

## Acting on one channel from another

This isn't in the guide. You asked for it after stage 4. What's said in one channel can lead your friend to write in another:

- `post_in_channel({ channel, text, new_scene? })` posts in another channel. It works from any turn, a wake-up included, and besides their reply here. Examples: asking you something in #ooc about a story, or opening a scene in #story after planning it in #ooc. In a roleplay channel it's a post as their characters, in that scene's style, and `new_scene` starts a new scene first. In OOC it's texts, as usual. Their reply in the channel they're in is still separate.
- `read_recent_messages({ channel, count? })` reads another channel's newest messages first. `read_channel_summary` gives the longer view.

**Limits:**

- It can't be used on the channel they're in: there, they just reply.
- It's once per channel per turn.
- It's refused while they're already writing in that channel.
- It's never from or into the practice channel.

**What you see and get:**

- The tool line under their message says where they posted. The other channel gets its unread dot.
- If the app isn't open, you get a phone notification, as for a wake-up.
- A wake-up that only posts elsewhere counts as writing to you, so "no double texts" still holds.

## Storage and API

Migration 4 in `src/db.ts` makes these changes:

- `channels` allows the kind `practice`;
- new tables: `identity_versions`, `self_page`, `self_notes`, `journal` and `verbatim`;
- `notebook_folders.practice` and `inbox.orientation`.

`store.listChannels()` leaves the practice channel out, and `store.practiceChannel()` returns it.

New routes:

| Route | What it does |
| --- | --- |
| `GET /api/friend-page` | identity, changelog, self-page, journal counts, orientation state, your waiting suggestions |
| `POST /api/identity/suggestions` | suggest `{ identity?, tastes?, note? }` |
| `POST /api/identity/suggestions/:id/withdraw` | take one back |
| `POST /api/self-page/notes` | suggest a note `{ text, messageIds? }` |
| `POST /api/self-page/notes/:id/withdraw` | take one back |
| `POST /api/orientation/invite` | invite them to an orientation |

`GET /api/state` also returns `practice` (the practice channel) and `waiting` (your suggestions waiting for them). `PUT /api/settings` with a changed `friendPrompt` returns the `suggestion` it made, instead of saving the change. `/api/friend/random` returns `tastes` as well.

## Tests

`test/self.test.ts` covers:

- identity versions and suggestions;
- the self-page and edit markers;
- the journal's privacy in the tool log, the preview, the friend page and check;
- forgetting;
- verbatim slots and the manifest;
- the practice channel's isolation;
- orientation on creation, on request, by invitation and for a new profile;
- the weekly look back.

`test/elsewhere.test.ts` covers `post_in_channel` and `read_recent_messages`.
