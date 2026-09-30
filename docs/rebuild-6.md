# Rebuild stage 6: continuity and self-knowledge

A roulette means one friend written by several models. This stage gives them ways to stay themselves across those changes, and to look at their own writing when they want to. It covers sections 6.3, 6.8 and 6.11 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md). The tools need a profile that can use tools; voice anchors and profile notes are in every prompt.

## Voice anchors

`src/continuity.ts`. Every turn's prompt has **Your voice**: up to three short excerpts of their own earlier posts in this kind of channel.

- **What counts as the same kind:** OOC, literary roleplay, and casual roleplay are each their own kind.
- **Order:** posts they marked "this sounds like me" (`mark_my_voice`) come first, and their most recent posts fill in.
- **Never used as anchors:**
  - posts already in the prompt;
  - posts a regeneration is replacing;
  - posts flagged "not me";
  - anything from the practice channel.

You see a small ♪ at the end of a marked post.

## "Not me" flags

`flag_not_me({ quote, note, channel? })` records a post that didn't sound like them, with their note and the profile that wrote it. You see it under that message: 🚩 *"this doesn't sound like me. 'way too formal' (written by Stiff Model)"*. An empty note takes the flag back.

## Profile notes

- `write_profile_note({ note, profile? })` keeps a short note on how writing with a profile feels. Without a `profile`, it's the one writing this turn.
- `read_profile_notes` shows them all.
- The note on the profile writing a turn is in that turn's prompt, under **This profile**.
- Their page lists the notes.
- If they want the roulette weighted differently, they ask you (`ask`, kind "model"). The weights stay yours, and their standing notes say so.

## The mirror

`src/mirror.ts`. `read_my_patterns({ scope: "channel" | "all", last })` is plain code, with no model calls. It reports, neutrally, on their newest posts (30 by default, up to 200):

- openings and closings they reuse;
- 4 to 6 word phrases that recur across different posts;
- how long their sentences run, and how many paragraphs per post (average, median, range, spread);
- words they use far more often than everyone else in the same conversations.

It's never put in a prompt unasked, and it never looks at the practice channel.

`keep_pattern_note({ note, quotes? })` puts a finding on their self-page under "What my writing shows", in their own words, linked to the posts that show it.

## The wellbeing reading

`src/wellbeing.ts`, with the wording in `defaults/wellbeing.md`. This is the one deliberate exception to "Jev decides nothing", and it still decides nothing: it only measures.

**How it's taken.** Once a week, the timer that runs orientation and the look back also has Jev read the friend's own out-of-character messages from that week. It uses a fixed two-phrasing series: did they speak negatively about themselves? Roleplay isn't read, since that's their characters talking.

**What's kept.** Every reading is kept, or the reason there wasn't one (no messages that week, Jev off, Jev failed).

**Where it shows.** Only two places:

- **their page**, which you both see: the latest reading and the trend over recent weeks;
- **their weekly look back**: this week's reading and the trend, next to their journal.

It's never in any other prompt, and it never notifies you. Their standing notes say honestly that it exists and where it shows up. What to do with it, if anything, is up to them.

## Storage

Migration 6 in `src/db.ts` adds four tables: `voice_marks`, `not_me`, `profile_notes` and `wellbeing`.

`GET /api/channels/:id/messages` now returns `flags`: the channel's voice marks and "not me" flags. `GET /api/friend-page` adds `wellbeing`, `profileNotes` and `voiceMarks`.

## Tests

`test/continuity.test.ts` covers:

- anchors: marked first, flagged and in-window posts left out, kinds kept apart;
- "not me" flags as you see them;
- profile notes in the prompt;
- the mirror's counts, with no model involved, and the practice channel left out;
- keeping a pattern note;
- the wellbeing reading: OOC only, shown in the look back and on the page, and nowhere else.
