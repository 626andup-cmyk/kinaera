# Rebuild stage 3: the instruments

Your friend now has three instruments for knowing, asking and getting help: `check`, `ask` and `consult` (section 5.4 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md)). All three need a profile that can use tools.

## check: sonar

Your friend asks whether something is true or present in their world, in two phrasings:

```
check({ question: "Has Ilse's brother been named anywhere?",
        rephrased: "Is there a name given for Ilse's brother?",
        sources: ["notebook", "channel", "summaries", "library"] })   // optional
```

`src/check.ts` does three things:

1. **Search.** It searches each source with full-text search: the notebook as your friend sees it (entries hidden from them are never searched), this channel's messages, every channel's summaries and, if asked, the library. It takes the best passages from each source in turn, up to 30,000 characters. The library has its own search index. For the others, a throwaway index is built for each check.
2. **Jev reads them.** Jev gets the passages, with both phrasings as questions. It's a confident "yes" only if both phrasings say so, a confident "no" only if both do, and "unsure" otherwise. The confidence line is Settings → Jev → "How sure Jev has to be".
3. **Your friend gets both** the reading and the passages themselves, each with where it came from. "Nothing found" is returned as an ordinary answer. If Jev is off or unreachable, the passages still come back without a reading.

Jev decides nothing here. `check` is Jev's only job in Kinaera now.

**The check log** (Friend menu → Check log, or Settings → Jev → Check log) lists every check: the question, where your friend looked, the reading, and the passages. The old Jev log is gone. Passages from private places (the journal and drafts, from stage 4) will show where they came from, never what they say, in the check log and in the tool log alike.

## ask: a person

```
ask({ kind: "context" | "check" | "model" | "pause" | "clarify" | "prompt" | "other", text: "..." })
```

The ask goes to your **inbox** (the tray button), with a box to answer it or a button to set it aside. Your answer reaches your friend on their next turn, whatever the channel. It's under "What you've asked of the user", marked "New:" until it has been in a turn once, and it stays there for a day. Answering also gives them a turn of their own (a wake-up), if the hard rules allow. That wake-up is exempt from "no double texts", since they're replying to you. Your answers, and asks you set aside, go in the intervention log too.

**The unified inbox.** Asks and your friend's proposals (deleting a channel) are now one table, `inbox` (`src/inbox.ts`). Existing proposals were moved into it. One deliberate difference from the guide: **notebook suggestions stay in the notebook's own table**, because they belong to their entries (deleting an entry deletes its suggestions). They're still shown in the same inbox screen. Stage 4's new suggestions (identity, self-page notes) will use the inbox table.

## consult: a stronger mind

```
consult({ question: "...", draft?: "...", messages?: ["a few words from each"], entries?: ["names"], consultant?: "name" })
```

In **Settings → Profiles**, tick **Consultant** on one or more profiles. `consult` is only offered once there is one. The consultant gets your friend's question and what they attached, with a short framing from `defaults/instruments.md` ("A writer friend is asking for your honest read…"). Its reply goes only to your friend. The tool log shows that they consulted, and what they asked, but not the answer. The tool's description tells your friend exactly that.

**One consult per turn.** This is a plain rule, to protect your balance (principle 2). A second consult in the same turn is explained and refused.

## Being honest about what you can see

Two new standing notes, in `defaults/standing.md`:

- The user can see which tools your friend uses and what they return (under messages, and in the tool log), except where a tool says otherwise, and can read the check log.
- `consult` says its reply is private from you, and it is: the tool log keeps only that it happened.

The instruments' own wording (the "nothing found" note, the reading note, "It's in the user's inbox", the consultant's framing) is in `defaults/instruments.md`.

## Storage and API

Migration 3 in `src/db.ts` makes these changes:

- `check_log` replaces `jev_log`.
- `inbox` replaces `proposals`, with the proposals copied across.
- `profiles` gets `consultant`.

| Route | What |
| --- | --- |
| `GET /api/checks` | The check log |
| `GET /api/inbox` | Open asks and proposals, and recent ones |
| `POST /api/inbox/:id/answer` | Answer an ask (`{answer}`) |
| `POST /api/inbox/:id/dismiss` | Set an ask aside |
| `POST /api/inbox/:id/approve`, `/deny` | Decide a proposal |

`/api/proposals` and `/api/jev/log` are gone. `/api/state` has `inbox` instead of `proposals`.

Tools can now take time: `runTool` is asynchronous. A tool's outcome can also carry a `logResult`, which the tool log keeps instead of what the model saw (used for consult replies now, and for private passages in stage 4).

## Checked

- `bun run typecheck`: clean.
- `bun test`: 473 tests pass. 20 are new in `test/instruments.test.ts`:
  - searching (by source, hidden entries left out, the character limit);
  - Jev's reading (both phrasings must agree; nothing found means no Jev call; Jev off or failing);
  - the check tool and its log, including private passages never being stored;
  - asks, from waiting to answered to delivered once and then forgotten after a day, and set aside;
  - the answer wake-up getting past "no double texts";
  - proposals in the inbox, and old proposals migrated;
  - consult (offered only with a consultant; the framing and attachments; once per turn; failures explained; the reply kept out of the tool log);
  - the tools note in the prompt.
- In a phone-sized browser, against a fake model that uses the tools, with no console errors: a check shows up in the check log with its reading, an ask shows in the inbox with a badge and can be answered, and a profile can be marked as a consultant.

## Not tested with real models yet

The fake nanoGPT in the tests answers however it's told to. Jev's real answers to check questions, and how real models choose to use `check`, `ask` and `consult`, need a live test.
