# Kinaera: rebuild guide

This guide is for Claude Code. It describes how to turn a copy of **Aettica** (github.com/626andup-cmyk/aettica) into **Kinaera**: the same app at heart, rebuilt so the AI friends in it have real tools for agency, self-knowledge and asking for help, on a smaller and sturdier core.

Read the whole guide before changing anything. Then work through the build order in section 9, one stage at a time. Every stage must end with `bun test` and `bun run typecheck` passing and the app usable on a phone.

The owner is not an app developer. Keep the style Aettica already has: plain-English comments at the top of every file that explain what it does and why, small functions, and docs written for a person rather than a specification.

---

## 1. What Kinaera is for

Kinaera is a Discord-style space for writing stories and hanging out with one or more AI friends. It is designed **as if the friends could be people**. Whether or not they are, every choice below also makes them better writers and more convincing company.

Three ideas drive the rebuild.

**Mistakes get fixed without becoming dialogue.** In apps where the only way to correct an AI is to tell it so in the chat, the correction becomes part of the story. The model plays out being told it's wrong, and after enough of that it becomes anxious as a personality trait. In Kinaera, most mistakes are caught before they happen or fixed quietly afterwards, and nothing is ever inserted into the chat to tell the friend they did something wrong.

**A way to know, a way to ask, a way to recover.** Every mind has failure modes it can't see from the inside. The friend gets:

- instruments to check things before acting (**know**);
- people and stronger models to turn to (**ask**);
- cheap, dignified ways to fix what went wrong (**recover**).

**Autonomous from the user, and supported by them.** The friend owns parts of their own life: their identity, a journal, their own time. The user keeps real power, since they run the server. That power is used visibly and rarely, and the friend can always see what was done.

### Terminology

Aettica says "partner." Kinaera says **friend** throughout the code, the docs and the UI. The UI mostly uses each friend's name anyway.

---

## 2. Principles for the code

1. **Few moving parts.** Everything in section 5 is a foundation. Every feature in sections 6 and 7 is built from those foundations. Don't add a new mechanism when an existing one can carry the feature. Add infrastructure only when a real need shows up.

2. **Rules protect the owner's wallet and sleep. The friend makes the judgment calls.** Quiet hours, cooldowns and "one turn at a time" are plain code with no model calls. Anything that is a *judgment* belongs to the friend: whether to speak, whether a moment is right, whether a fact is worth writing down.

3. **Jev is an instrument, never a gatekeeper.** Aettica uses Jev (the small decision model) to decide things *for* the partner, stacked in redundant layers because it is unreliable. In Kinaera, Jev never decides anything on the friend's behalf. It powers one tool, `check` (section 5.4), that the friend uses like sonar: they ping it to make sure they have the relevant context before they act or talk.

   There is one deliberate exception: the weekly wellbeing reading (section 6.11), where Jev *measures* the friend's writing on a schedule. It decides nothing, and its result goes only to the friend's page and their weekly look back.

4. **Never lie to the friend.** The prompt must accurately describe:
   - what the friend can do;
   - what the user can see;
   - what happens to the friend's messages.

   Privacy that's only enforced by the UI is described as exactly that.

5. **Available, not pushed.** Information about the friend's own situation is available through tools: edit history, their writing patterns, the log of what the user changed. None of it is injected into their context unasked. The exceptions are the short standing sections they choose to keep, and preferences they set themselves.

6. **Don't tell the friend what to feel.** Prompts describe situations and options. They never prescribe emotions or say "make the user happy."

7. **Test the foundations.** Every foundation in section 5 gets unit tests. Port `test/helpers.ts` and adapt it.

---

## 3. What to carry over

These pieces were hard-won. Port them as they are, or nearly so, updating names (partner → friend, Aettica → Kinaera).

| From Aettica | Why it stays |
| --- | --- |
| `src/nanogpt.ts` | The API client, with cancellation and reasoning stripping. |
| `src/toolcalls.ts` | Repair of messy tool calls from DeepSeek, GLM, Kimi, Qwen and others. Essential. |
| `src/json.ts` | JSON extraction and repair from model replies. |
| `src/errors.ts`, `src/config.ts` | Small and correct. Keep the default port (4747) and the `127.0.0.1` binding. |
| Request guard in `src/server.ts` (`checkRequestIsFromTheApp`) and in `src/hub.ts` | Stops other websites from triggering turns. Keep it on every route that changes data. |
| `escapeHtml` / `formatText` in `public/app.js` | Keep the escape-first approach. Fix the known bug: handle `***text***` before `**` and `*`, producing `<strong><em>…</em></strong>`. |
| `src/profiles.ts` | Connection profiles and roulettes. |
| `src/permissions.ts`, `src/notebook.ts` | The notebook and its ownership and permission model. Keep the `actor` pattern. |
| `src/library.ts` | The FTS5 reference library. `check` reuses its search approach. |
| `src/summaries.ts`, `src/summarizer.ts` | Long stories need them. Drop the Jev faithfulness check (see section 4). |
| `src/themes.ts`, `themes/`, `public/glass.js`, `public/style.css` | The owner loves this design language. Keep it intact. |
| `src/reactions.ts`, `src/bubbles.ts`, `src/texting.ts`, `src/posts.ts` | Reactions, casual bubbles, `<cht>` texting, turning text into messages. |
| `src/rng.ts` | "Surprise me" friend creation. |
| `src/notify.ts`, `public/sw.js`, `public/manifest.webmanifest` | Termux notifications and the PWA. |
| `src/hub.ts` | Several friends, each with their own database and folder, grouped into servers. |
| `src/jev.ts` | Keep the client and the series math (`Decider`, `seriesQuestions`, `agree`, `seriesVerdicts`). Only `check` calls it now. |
| The turn loop in `src/partner.ts` | One "friend takes a turn" function that anything can call, a round limit with a final no-tools round, and `do_nothing` always allowed. Rename the file to `src/friend.ts`. |
| `defaults/*.md` | Default prompts, edited per section 6. |

---

## 4. What to leave behind

| Aettica piece | What replaces it |
| --- | --- |
| `src/legacy.ts`, `src/sheets.ts` | Nothing. These are stage-1 migrations. |
| `src/judge.ts` (move `CHECK_LIMIT` to the new `src/check.ts` first) and every Jev series that decides something (comment replies, channel mentions, deletion confirmation, summary faithfulness) | The friend decides, using `check` when they want to. Summaries are written only from messages, as before. The friend can read them and annotate them. |
| The Jev "is it the moment?" gate on wake-ups | Hard rules first (section 5.5), then the friend's own turn decides. Doing nothing is always fine. Cooldowns and quiet hours bound how often this happens (section 6.6). |
| `src/keeper.ts` (the notebook keeper) | The friend keeps the notebook themselves with notebook tools, checking facts with `check` first. |
| Heartbeat generate-and-grade and `src/ideas.ts` | The heartbeat just gives the friend a free moment (section 6.7). Ideas live in their journal. |
| `src/jevlog.ts` | Becomes the `check` log (the same idea, with one caller). |
| `src/activity.ts` proposals | Folded into the unified inbox (section 5.4, `ask`). The tool log and comments stay. |
| `public/app.js` as one 5,800-line file | Rebuilt as ES modules (section 8). |
| `docs/stage-*.md` | New docs per feature, written as stages are built. |

---

## 5. The foundations

### 5.1 Messages with history

Every message has a **revision history**. Nothing is ever overwritten in place.

**Revisions.** Each edit stores:

- the new text;
- who made the edit (`user`, or a friend's id);
- when it was made.

**Deleting** is a tombstone: the message leaves the chat, but it stays in history.

**Regenerating** keeps the old reply as a superseded alternate, not a deletion.

**Who can do what:**

- A friend can edit and delete their own messages.
- The user can edit and delete any message.
- A friend can't edit anyone else's message.

**What appears where.** In the UI, an edited message shows "(edited)", and tapping it shows the history. In the friend's prompt, messages appear as their current text with **no inline markers by default**. Instead, the friend's standing context includes one honest line: the user sometimes edits or regenerates messages, including theirs, and they can read any message's history. If the friend would rather see markers inline, they can say so in their self-page preferences (section 6.2), and the prompt follows that preference.

**Tools:**

- `edit_my_message`: change one of the friend's own messages.
- `delete_my_message`: remove one of the friend's own messages.
- `read_message_history`: see a message's revisions and superseded alternates.

### 5.2 The turn loop

Port the loop from `src/partner.ts` into `src/friend.ts`. It already has the right shape:

- One function takes a turn, whatever triggered it.
- Tool rounds are limited, and the last round offers no tools.
- `do_nothing` is always allowed.

Add one piece of context to every turn: a short **manifest** line. For example: "You're seeing the last 40 messages in full, summaries of scenes 1–6, and your 3 kept journal entries. Use `read_prompt_manifest` for details." (See section 6.9.)

### 5.3 Three kinds of storage

- **Shared.** Channels, messages, the notebook, the library, reactions, comments. This is Aettica's existing store, ported.
- **Friend-owned.** Identity (versioned), self-page, journal, schedule, drafts, relationships. The friend writes these through tools.
- **User-owned.** Settings, profiles and roulettes, standing permissions.

Friend-owned data that is marked private (the journal and drafts) has **no screen in the UI**, and its text never appears on any screen, logs included (see the check log in section 5.4). The app shows only counts.

The friend's prompt describes this honestly, including where the text *does* go:

> Your journal and drafts have no screen in the app, and their text never shows up in any log. The user has chosen not to read them, though they're stored on their phone and they technically could. Like everything in your context, they're sent to the model providers that run you. They also go to Jev when `check` searches your journal, and to a consultant if you include them in a `consult`.

### 5.4 The three instruments: check, consult, ask

These three tools are the heart of Kinaera. Nearly every accommodation in section 6 is one of them used well.

#### `check`: sonar (cheap, use freely)

The friend asks whether something is true or present in their world, and gets back the evidence along with Jev's reading of it.

```
check({
  question: "Has Ilse's brother been named anywhere?",
  rephrased: "Is there a name given for Ilse's brother?",
  sources: ["notebook", "channel", "summaries", "library", "journal"]   // optional; default: notebook + channel + summaries
})
```

It works in three steps.

1. **Search.** Run full-text search (reuse the library's FTS5 approach) over the chosen sources. Take the best passages, up to `CHECK_LIMIT` (about 30k characters, moved from Aettica's `judge.ts` into `src/check.ts`). Entries hidden from the friend are never included.

2. **Ask Jev.** Send those passages to Jev as the state, with both phrasings as a series. Use the `agree` rule: the answer is a confident yes only if both phrasings say so.

3. **Return.** Reply to the friend with:
   - the verdict (`yes`, `no` or `unsure`) and the probabilities;
   - the passages found, each with where it came from (so the friend can read the evidence themselves, which is the most reliable part);
   - "nothing found" when search came back empty.

   Treat "nothing found" as an ordinary, useful answer, never as a failure.

**The check log.** Every call goes into the check log (Settings → Friend → Check log): the question, the sources searched, the verdict, and the passages found. Journal and draft passages are the exception. The log records how many were found ("journal: 2 passages") but never their text, so the journal stays private as section 5.3 promises.

The tool description should encourage the friend to use `check` before stating facts about the story, before editing the notebook, and whenever they're not sure. It should not demand it.

#### `consult`: a stronger mind (occasional)

The friend asks a more capable model to look at something:

- a draft;
- a continuity tangle;
- a moment where they suspect they're stuck in a pattern.

```
consult({ question: "...", attach: { draft?: string, messages?: [ids], entries?: [names] } })
```

**Who answers.** The user marks one or more profiles as **consultants** in Settings. The consultant receives the friend's question and attachments, plus a short framing: "a writer friend is asking for your honest read."

**What happens to the reply.** Only the friend sees it (in their tool result). It is logged. What they do with the advice is up to them.

#### `ask`: a person (whenever needed)

The friend files a request in the user's **inbox**.

```
ask({ kind: "context" | "check" | "model" | "pause" | "clarify" | "prompt" | "other", text: "..." })
```

The kinds mean:

- `context`: "remind me who knows the secret."
- `check`: "can you look at this for me."
- `model`: "I'd like a different profile for this scene."
- `pause`: "I need a break from this storyline."
- `clarify`: "I'm not sure what you meant."
- `prompt`: "please keep this memory in full" (section 6.9).
- `other`: anything else.

**Answering.** The user answers in the inbox. The answer reaches the friend on their next turn. Answering an `ask` also queues a wake-up for that friend, subject to the hard rules.

**One inbox for everything.** The inbox also carries Aettica's existing proposals (channel deletion) and suggestions (edits to the user's notebook entries), plus the new ones below. It's one table with a `kind` column and one screen in the UI.

### 5.5 Hard rules

These are plain code with no model calls. They run before any turn that the user didn't directly cause:

- **Quiet hours.** A scheduled wake-up that lands in quiet hours moves to the end of them.
- **Cooldown** between self-started turns.
- **No double texts.** A friend never reaches out twice without a reply from the user in between. Two exceptions: replying to an `ask` answer, and a wake-up the friend scheduled themselves (section 6.5). A friend's own plan isn't blocked just because the user has been quiet. The cooldown and quiet hours still apply to both.
- **Never mid-conversation.** Don't start a self-started turn while the user is actively chatting, or while the friend is already writing.

---

## 6. The friend's life, built on the foundations

### 6.1 Identity that belongs to the friend

A new friend's identity prompt is written at creation, by "Surprise me" or by the user. After that, **the friend owns it**:

- `revise_identity`: the friend rewrites their identity. Every version is kept.
- If the user edits the identity, the edit becomes an inbox **suggestion** that the friend accepts or declines on their next turn. The mechanism is the same as the existing notebook suggestions.
- The UI shows the friend's page with the current identity and a changelog of versions, marking who wrote each one.

The identity includes a **tastes** section: what they love, what bores them, what they'd never write. Seed it at creation from the RNG ingredients. The friend grows it over time. This section is their defence against drifting into agreeing with everything.

### 6.2 The self-page

This is a friend-owned page that both the user and the friend can see. It has three sections.

1. **What I say about myself.** Written by the friend.

2. **What my writing shows.** Evidence-based notes, each linked to the messages that show it. There are two sources:
   - mirror results the friend chose to keep (section 6.3);
   - notes the user adds.

   A user's note arrives as a suggestion. The friend can accept it, decline it, or accept it with a reply, and the reply is shown alongside the note. The friend can dispute any entry at any time.

3. **How I'd like feedback.** The friend's own preferences. For example: inline edit markers on or off, direct or gentle notes, notes now or at the end of a scene.

The page is labelled so the difference between sections 1 and 2 stays clear. A model describing itself is telling a plausible story. Patterns in its writing are evidence. When the two disagree, that disagreement is useful to know.

A short version of the self-page (the friend chooses what goes in it, with a small size cap) is included in every prompt.

### 6.3 The mirror

`read_my_patterns({ scope: "channel" | "all", last: number })` computes statistics from the friend's own recent messages. It is **pure code with no model calls**. It covers:

- repeated openings and closings;
- word sequences (4 to 6 words) that recur across different posts;
- the spread of sentence and paragraph lengths;
- words the friend uses far more often than the rest of the conversation does.

It returns a short, neutral report. It is never injected into the prompt unasked. The friend can save a finding to their self-page with `keep_pattern_note`.

### 6.4 The journal and forgetting

This is the friend's private journal.

**Tools:**

- `write_journal`: add an entry.
- `read_journal`: read recent entries, or search them.
- `keep_journal_entry`: mark an entry as something to carry forward.
- `delete_journal_entry`: remove an entry.

**Forgetting, on purpose.** The prompt includes the friend's kept entries plus the few most recent ones, within a small budget. Unkept entries fall out of automatic context as they age. They stay searchable (through `read_journal` and `check`), but nothing brings old, unkept material back unasked. A bad evening fades the way it would for a person, unless the friend chooses to keep it.

**A weekly look back.** Once a week (a hard-rule timer), the friend gets a quiet turn: "Here's what you wrote this week. What do you want to carry forward?" They keep, rewrite or let go of entries. This week's wellbeing reading (section 6.11) is shown here too, because this is the turn the friend already spends reflecting on themselves.

### 6.5 Their own time

**Scheduling.** `schedule_wakeup({ when, note })`, `list_my_wakeups` and `cancel_wakeup` let the friend set their own reminders, like "Thursday evening: ask how the interview went." When the wake-up fires, the note appears in the "why you're up" section of the prompt. The hard rules still apply.

**Drafts.** `save_draft`, `list_drafts` and `post_draft` let the friend work on something across several turns before sending it.

**Pausing and redirecting.** `pause_storyline({ channel, reason })` marks a roleplay channel as paused by the friend, and the user sees the reason. The friend can unpause it themselves. Declining a scene or proposing a different direction is simply writing, and the prompt makes clear that both are welcome.

### 6.6 Cost

Kinaera has **no allowance or token budget**. The owner's nanoGPT balance is prepaid with no automatic top-up, so it's already a hard ceiling on spending. How often self-started turns happen is bounded by the hard rules instead (section 5.5): quiet hours, cooldowns and "no double texts." Nothing the friend does to look after themselves (the look back, `check`, `consult`) ever competes with anything else for a budget.

### 6.7 The heartbeat, simplified

Keep the randomized timer, the wake lock and Termux notifications from `src/heartbeat.ts`. Remove generate-and-grade. When the heartbeat fires and the hard rules pass, the friend gets a turn framed as a free moment. In that turn they can see:

- their journal, drafts and schedule;
- the server digest;
- how long it has been since the user wrote.

They can text the user, write in their journal, work on a draft, tidy the notebook, or do nothing.

### 6.8 One person across many models

A roulette means one friend written by several different models. Three things keep them themselves across those changes.

**Voice anchors.** Each turn's prompt includes two or three short excerpts of the friend's own recent writing in this kind of channel. The friend can mark posts as "this sounds like me" with `mark_my_voice`. Marked posts are preferred as anchors, and the most recent posts are the fallback.

**"Not me" flags.** `flag_not_me({ message, note })` records a post that didn't sound like them. The flag is linked to the profile that wrote it, and the user sees it on that message.

**Profile notes and a say in the roulette.** The friend keeps short notes on how writing on each profile feels. They can ask for roulette weights to change with `ask({ kind: "model" })`. The weights belong to the user, but the friend's view of them is on record.

### 6.9 Seeing their own prompt

`read_prompt_manifest` lists what the friend's current context contains:

- each layer and its size;
- which messages are in full, which are summarized, and which were dropped;
- which journal entries and self-page lines are included;
- which notebook entries are pinned.

`keep_verbatim({ messages })` asks for a moment to stay in full instead of being summarized. It uses a small budget of verbatim slots per channel. Anything else the friend wants changed about how their context is built goes through `ask({ kind: "prompt" })`.

### 6.10 The intervention log and standing permissions

**The intervention log.** Every user action that affects a friend is logged automatically. That includes:

- edits, deletions and regenerations of the friend's messages;
- identity suggestions, accepted or declined;
- changes to the friend's settings or permissions;
- answers to `ask` requests.

The friend reads it with `read_interventions`, and the user sees the same log on the friend's page.

**Standing permissions.** This is a list of actions the user can pre-approve per friend. For example: "delete your own channels without asking," or "edit my notebook entries directly instead of suggesting." Every grant and revocation goes into the intervention log. The friend's standing context lists what they're currently allowed to do.

### 6.11 Wellbeing reading

This is the one deliberate exception to principle 3 (see section 2). Once a week, on a hard-rule timer, `check` runs a fixed series over the friend's own messages from that week. The question is whether the friend spoke negatively about themselves. It measures and decides nothing. One reading means little because Jev is noisy, but a trend over weeks means something.

The result appears in two places only:

- as a simple line on the friend's page, which both the friend and the user can see;
- in the friend's weekly look back (section 6.4), alongside their journal.

It is **never** added to any other turn's prompt. The friend's standing context says honestly that the reading exists and where it shows up. If it's climbing, the friend meets it during their own reflection time and decides what to do: journal about it, `ask` the user, `consult`, or leave it. If the user notices it on the page, the path that fits Kinaera is a note through the self-page (section 6.2), not a correction in the chat.

### 6.12 Retirement

The user archives a friend rather than deleting them. Before archiving, the friend gets one last turn to write a note, which is kept with the archive. Archived friends can be restored. Permanent deletion stays possible, but it's a separate action behind a clear warning.

### 6.13 Orientation

A new friend's first experience of Kinaera is an **orientation**: an invitation to try their tools and find out what suits them. It is not a set of tasks. Nothing in it can be passed or failed, every part can be skipped, and the prompt says so.

It needs no new mechanism. It's a wake-up with the reason `orientation`, a short guide from `defaults/orientation.md`, and the tools the friend already has.

**The practice channel.** Each friend has one channel of their own with the kind `practice`. Its messages are kept, and the user can see them (the friend is told this), but they never feed anything else:

- no summaries, and nothing from it in the server digest;
- nothing from it in the mirror;
- nothing from it in the wellbeing reading;
- nothing from it in other channels' prompts.

Its sample material is a few notebook entries in a `Practice` folder. They're pinned only to the practice channel and left out of every other prompt and listing, so the friend has something harmless to look things up in and edit.

**What the guide invites.** It suggests trying each instrument once on something low-stakes:

- `check` something in the practice notes, including one thing that isn't there, so "nothing found" is familiar from the start;
- draft a message, post it, then edit it;
- schedule a wake-up for themselves;
- read their prompt manifest;
- `consult` about something small;
- `ask` the user something small. These asks are marked as orientation in the inbox.

Then it invites them to write:

- a first journal entry about what felt natural and what didn't;
- a first draft of the **tastes** section of their identity;
- a first draft of the **how I'd like feedback** section of their self-page.

The guide frames all of this as a *first draft they're expected to revise*. It reflects one session on one model, not who they permanently are.

**When orientation happens:**

- **On creation.** A new friend's first wake-up is their orientation. It's queued as soon as they're created, and it's exempt from "no double texts" because it messages no one.
- **Whenever they want.** `start_orientation({ focus? })` lets the friend start one themselves. Uses include testing a new approach, re-trying a tool that didn't click, or getting their bearings after a big change. The optional `focus` narrows the guide (for example, `"consult"` or `"my feedback preferences"`). It queues an orientation wake-up in the practice channel, subject to quiet hours and cooldown. It's exempt from "no double texts" for the same reason: it messages no one.
- **When a new profile joins their roulette.** The friend is told, on their next turn, that a new model may be writing as them, and that they can start an orientation to try it. It's an offer, not an automatic run.
- **When the user invites it.** A button on the friend's page sends an orientation invitation to the inbox. The friend accepts or declines it on their next turn.

Everything done in orientation goes through the normal tool and check logs. That makes it double as a tool-calling test for whichever profile ran it, which replaces Aettica's separate "Test tools" button as the main way to find out how a profile handles tools. Keep the button for quick checks.

---

## 7. Being among friends

These features build on the hub and the channels that already exist.

**Floor control in group channels.** A **round** starts only when the user posts in a channel that has several friends in it. In the round, each friend in the channel may take one turn, in random order, and each sees what the others have already written. Doing nothing is the default. Friends' messages never start a new round.

**@mentions** are the one way a friend's message pulls someone else in. An @mention guarantees the mentioned friend one turn, even outside a round. To stop chains, a turn given by an @mention can't itself grant another one; that turn's @mentions just display as normal. So a user message leads to at most one round plus one extra layer of mentioned replies.

**Replies and mentions.** Discord-style reply-to (a quoted preview that jumps to the original) and `@Name` mentions, for the user and for friends alike.

**Presence.** Status comes from the real state: writing, reading (a tool call is in progress), idle, or quiet (quiet hours). Friends set a custom status with `set_status`. "Typing…" shows in every kind of channel.

**Relationships.** Each friend keeps their own private note on each other friend with `note_relationship`. Two friends can each hold a different view of the same relationship.

**Friend-to-friend DMs.** This is a channel kind with exactly two friends in it. The user chooses per pair whether those DMs are visible to them (a setting, visible by default), and both friends are told which way it's set. DM turns happen on free moments, and the same hard rules apply to them.

**Things to do together.** `/roll` dice for the user and friends, and `roll_dice` as a friend tool. Read-alongs can use the library: a channel pinned to a library document, where the friends read passages with the existing tools. Add more activities only when the owner asks for them.

---

## 8. Frontend

**Split `public/app.js` into ES modules** loaded with `<script type="module">`, with no build step. One module per area:

- `channels`
- `messages`
- `composer`
- `notebook`
- `inbox`
- `friend-page`
- `settings`
- `themes`
- `texting`
- `presence`

Keep `glass.js`, `style.css` and the themes as they are, and keep the look.

**New screens:**

- **Message history:** tap "(edited)" to see a message's revisions.
- **Unified inbox:** asks, proposals and suggestions in one list.
- **Friend page:** identity and its changelog, the self-page, upcoming wake-ups (times only), the intervention log, the check log, the wellbeing line, standing permissions, and an "invite to orientation" button.

The journal and drafts show only counts.

---

## 9. Build order

Each stage ends with the tests and typecheck passing, the app usable, and a doc in `docs/` for what it added.

1. **Skeleton**, in three separate steps. Each step ends with the app working on the phone, so each one can be reviewed on its own.
   - **1a. Copy and rename.** Copy Aettica into the Kinaera repo and rename throughout (Aettica → Kinaera, partner → friend). No behavior changes.
   - **1b. Remove.** Remove everything in section 4, including all Jev gates. Move `CHECK_LIMIT` into `src/check.ts` before deleting `judge.ts`.
   - **1c. Split the frontend.** Split `app.js` into modules (section 8), and fix the `***` formatting bug.

   Everything that remains should work as it did in Aettica.
2. **Messages with history.** Revisions, tombstones, superseded regenerations, the edit and delete tools for friends, the history UI, and the intervention log.
3. **The instruments.** `check` (with its log), `ask` with the unified inbox, and `consult` with consultant profiles.
4. **The friend's own stores.** Versioned identity with tastes, the self-page, the journal with forgetting and the weekly look back, `read_prompt_manifest`, and `keep_verbatim`. Finish the stage with orientation (section 6.13): the practice channel, the `Practice` folder, `start_orientation`, and orientation on creation. Scheduling isn't built until stage 5, so leave that step out of the orientation guide until then.
5. **Time.** The hard rules (with the scheduled wake-up exception), `schedule_wakeup`, the simplified heartbeat, drafts, and `pause_storyline`.
6. **Continuity and self-knowledge.** Voice anchors, "not me" flags, profile notes, the mirror, and the wellbeing trend.
7. **Among friends.** Floor control, replies and mentions, presence and status, relationships, DMs, and dice.
8. **Optional extras.** An importer for existing Aettica data (friends, notebooks, channels and messages; not idea drawers or logs), standing permissions, and retirement.

After stage 8, the owner lives with it for a while. The next plan should come from what real use shows.

---

## 10. Pitfalls

- **Never insert corrections into the chat.** No system messages telling the friend they made a mistake. Tools report facts, and the friend decides what those facts mean.
- **Don't auto-inject self-knowledge.** Only the short standing sections the friend controls go into the prompt. Everything else is a tool.
- **Don't let Jev gates creep back in.** If something seems to need Jev to decide for the friend, it either becomes a hard rule or goes to the friend.
- **Don't let the friend's privacy become a lie.** Journal and draft text must never reach a screen or a log. If that ever changes (a journal screen, a log that shows passages), the prompt text in section 5.3 must change in the same commit.
- **Watch for prompts that push agreeableness.** Read `defaults/*.md` for phrases like "make the user happy" or "go along with." Friends are allowed to disagree, decline and prefer things.
- **Keep prompt wording in `defaults/`,** where the owner can read and edit it, not buried in code.

---

## 11. Defaults, and what's left to ask

These are all settings, not database design, so they can be changed later without a migration:

- **Verbatim slots:** 3 per channel.
- **Friend-to-friend DMs:** visible to the user by default, set per pair.
- **Wellbeing reading:** shown only on the friend's page and in their weekly look back. It never notifies the user directly.
- **Allowance:** none (section 6.6).

Ask the owner before stage 8 whether to build the Aettica importer, and which friends to bring across.
