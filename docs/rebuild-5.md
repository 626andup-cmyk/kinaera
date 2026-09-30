# Rebuild stage 5: time

Your friend now has time of their own: wake-ups they plan, drafts they work on across turns, a free moment on the heartbeat, and a way to pause a storyline. This is sections 5.5, 6.5 and 6.7 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md). All of it needs a profile that can use tools.

## Wake-ups they set themselves

`src/schedule.ts`.

- `schedule_wakeup({ when, note, channel? })` sets a wake-up. Times are the phone's local time: "in 3 hours", "tomorrow 9am", "thursday 19:00", or "2026-10-08T19:00". It can be at most 60 days ahead, with up to 20 waiting at once.
- `list_my_wakeups` shows them, and `cancel_wakeup({ id })` takes one back.
- Every tool turn's prompt has **Your time**: the time now (so "tomorrow" means something) and their waiting wake-ups, with their notes.

When one is due, the timer (`Rhythms`, every minute) gives them a turn with the reason **scheduled**. It happens in the channel they named, or their usual OOC channel, and their note is in "Why you're up".

**The hard rules still apply**, with the exception from the guide:

- **Never held back by the double-text limit.** A friend's own plan isn't blocked just because you've been quiet.
- **Everything else still holds:** chattiness ("off" means no), quiet hours, the cooldown, and "never mid-conversation". A wake-up a rule stops stays waiting and fires as soon as the rules allow. That's how one that lands in quiet hours moves to their end.

**Their page** lists upcoming wake-ups by time only (the notes are theirs), and the next heartbeat.

## Drafts

`src/drafts.ts`. Drafts are **private**, like the journal:

- they have no screen in the app, and their text never appears in any log;
- the preview prompt replaces their titles;
- their page shows only how many there are.

The standing note about the journal now covers drafts too, and says that a posted draft becomes an ordinary message.

The tools:

- `save_draft({ text, title?, channel?, id? })` starts a draft, or rewrites one given its `id`.
- `list_drafts` reads them.
- `delete_draft` lets one go.
- `post_draft({ id, channel?, new_scene? })` posts it straight away, mid-turn: in the channel it's for, the one named, or this one. It's an ordinary message from then on, and the draft is gone.

Because a draft posted here is saved mid-turn, **it can be edited in the same turn**. Orientation now uses this: draft, post, then `edit_my_message`, all in one turn. (Without drafts, the short second part from stage 4 still does it.)

`check` can search drafts (`sources: ["drafts"]`), privately, like the journal. Every tool turn lists their drafts by title under **Your drafts**.

## The heartbeat, a free moment

The heartbeat itself was already simplified: no generate-and-grade, no Jev. What changed is how the turn is framed (`defaults/time.md`): a free moment that's theirs. They can text you, write in their journal, work on a draft, tidy the notebook, or do nothing. Their journal, drafts and schedule are all in front of them, with the server digest and how long it's been since you wrote.

## Pausing a storyline

- `pause_storyline({ channel?, reason })` marks a roleplay channel as paused by them, with their reason, and `resume_storyline` picks it back up.
- You see the reason above where you write in that channel. It's their word on it, not a lock: you can still write there.
- Their prompt in that channel says it's paused, and the channel list marks it "paused by you".
- Roleplay prompts now say plainly that declining a scene, pausing it, or proposing a different direction is simply writing, and welcome (`defaults/time.md`, "declining").

## Also in this stage

- **Orientation** has two new steps: drafting (draft, post, edit) and scheduling a wake-up. The guide asked for scheduling to wait until this stage.
- **Wake-ups:** your friend can reach out twice without hearing back, never a third time (you asked for this). Writing in the practice channel doesn't count as reaching out.
- **Heartbeat:** it can be as short as every 5 minutes, with options for 10, 15 and 30 minutes and every hour.

## Storage

Migration 5 in `src/db.ts` makes these changes:

- `schedule` (their wake-ups);
- `drafts`;
- `channels.paused_reason` and `channels.paused_at`.

## Tests

`test/time.test.ts` covers:

- reading times;
- scheduling, listing and cancelling;
- a scheduled wake-up firing with its note, past the double-text limit and after quiet hours;
- drafts' privacy, rewriting, posting elsewhere, and posting here then editing in the same turn;
- pausing, resuming, and the declining note.
