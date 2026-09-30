/**
 * One person across many models (KINAERA_REBUILD.md, section 6.8). A
 * roulette means one friend written by several models; three things help
 * them stay themselves:
 *
 *   - **Voice anchors.** Each turn's prompt carries two or three short
 *     excerpts of their own earlier writing in this kind of channel (not
 *     the messages already in front of them). Posts they marked "this
 *     sounds like me" (`mark_my_voice`) come first; their most recent posts
 *     fill in. Posts they flagged "not me" are never anchors.
 *   - **"Not me" flags.** `flag_not_me` records a post that didn't sound
 *     like them, with a note, and the profile that wrote it. You see it on
 *     that message.
 *   - **Profile notes.** Their short notes on how writing on each profile
 *     feels (`write_profile_note`). The note on the profile writing this
 *     turn is in its prompt. If they'd like the roulette weighted
 *     differently, they ask (`ask`, kind "model"): the weights are yours.
 */

import type { Database } from "bun:sqlite";
import { ValidationError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { Channel, Message } from "./types.ts";

/** How many anchors a prompt carries, and how long each excerpt is at most. */
export const ANCHOR_COUNT = 3;
export const ANCHOR_LENGTH = 400;
/** How far back each channel is looked through for anchors. */
const ANCHOR_SCAN = 200;

export interface NotMeFlag {
  messageId: string;
  note: string;
  profile: string | null;
  createdAt: string;
}

export class Continuity {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------ voice

  /** Ids of the posts they marked as sounding like them. */
  voiceMarks(): Set<string> {
    return new Set((this.db.query("SELECT message_id FROM voice_marks").all() as { message_id: string }[]).map((r) => r.message_id));
  }

  markVoice(messageId: string, marked: boolean): void {
    if (marked) {
      this.db.query("INSERT OR IGNORE INTO voice_marks (message_id, created_at) VALUES ($messageId, $now)").run({ messageId, now: this.now().toISOString() });
    } else {
      this.db.query("DELETE FROM voice_marks WHERE message_id = $messageId").run({ messageId });
    }
  }

  // ----------------------------------------------------------- not me

  notMe(): Map<string, NotMeFlag> {
    const rows = this.db.query("SELECT * FROM not_me").all() as { message_id: string; note: string; profile: string | null; created_at: string }[];
    return new Map(rows.map((r) => [r.message_id, { messageId: r.message_id, note: r.note, profile: r.profile, createdAt: r.created_at }]));
  }

  /** Flag a post as not sounding like them (or take the flag back, with `note` null). */
  flagNotMe(message: Message, note: string | null): void {
    if (note === null) {
      this.db.query("DELETE FROM not_me WHERE message_id = $id").run({ id: message.id });
      return;
    }
    const clean = note.trim().slice(0, 1000);
    if (!clean) throw new ValidationError("Say what didn't sound like you: the user sees your note.");
    this.db
      .query(
        `INSERT INTO not_me (message_id, note, profile, created_at) VALUES ($id, $note, $profile, $now)
         ON CONFLICT (message_id) DO UPDATE SET note = excluded.note`,
      )
      .run({ id: message.id, note: clean, profile: message.profile ?? null, now: this.now().toISOString() });
  }

  // ---------------------------------------------------- profile notes

  profileNotes(): Map<string, { note: string; updatedAt: string }> {
    const rows = this.db.query("SELECT * FROM profile_notes").all() as { profile_id: string; note: string; updated_at: string }[];
    return new Map(rows.map((r) => [r.profile_id, { note: r.note, updatedAt: r.updated_at }]));
  }

  /** Their note on a profile (an empty note removes it). */
  writeProfileNote(profileId: string, note: string): void {
    const clean = note.trim().slice(0, 1000);
    if (!clean) {
      this.db.query("DELETE FROM profile_notes WHERE profile_id = $profileId").run({ profileId });
      return;
    }
    this.db
      .query(
        `INSERT INTO profile_notes (profile_id, note, updated_at) VALUES ($profileId, $note, $now)
         ON CONFLICT (profile_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run({ profileId, note: clean, now: this.now().toISOString() });
  }
}

/** Which "kind of writing" a channel is, for anchors: OOC, or roleplay in a mode. */
function voiceKind(channel: Channel, mode: Message["mode"] = null): string {
  return channel.kind === "rp" ? `rp:${mode ?? channel.mode}` : channel.kind;
}

/** An excerpt: the start of a post, cut at a sentence end if one is near. */
function excerpt(text: string): string {
  const clean = text.trim();
  if (clean.length <= ANCHOR_LENGTH) return clean;
  const cut = clean.slice(0, ANCHOR_LENGTH);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > ANCHOR_LENGTH / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * Voice anchors for a turn in `channel`: excerpts of their own posts in
 * this kind of channel, marked ones first, then the most recent, never the
 * ones already in the prompt (`exclude`) or flagged "not me", never from
 * the practice channel.
 */
export function voiceAnchors(store: Store, channel: Channel, exclude: Set<string>): { text: string; channel: string; marked: boolean }[] {
  if (channel.kind === "practice") return [];
  const kind = voiceKind(channel);
  const marks = store.continuity.voiceMarks();
  const flagged = store.continuity.notMe();
  const candidates = store
    .listChannels()
    .flatMap((c) =>
      store
        .getMessages(c.id)
        .slice(-ANCHOR_SCAN)
        .filter(
          (m) =>
            m.author === "friend" &&
            m.kind === "post" &&
            m.content.trim().length > 0 &&
            !exclude.has(m.id) &&
            !flagged.has(m.id) &&
            voiceKind(c, m.mode) === kind,
        )
        .map((m) => ({ message: m, channel: c.name })),
    )
    .sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
  const marked = candidates.filter((c) => marks.has(c.message.id));
  const rest = candidates.filter((c) => !marks.has(c.message.id));
  return [...marked, ...rest]
    .slice(0, ANCHOR_COUNT)
    .map((c) => ({ text: excerpt(c.message.content), channel: c.channel, marked: marks.has(c.message.id) }));
}
