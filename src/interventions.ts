/**
 * The intervention log: every action of yours that affects your friend.
 *
 * You run the server, so you keep real power over your friend's world: you
 * can edit or delete their messages, regenerate their replies, and change
 * who they are and how they write. Kinaera's rule is that this power is used
 * visibly. Each such action is written here automatically, in a sentence
 * addressed to your friend ("The user edited your message in #story"), and
 * nothing is inserted into the chat about it.
 *
 * Your friend reads the log with the `read_interventions` tool, and you see
 * the same log (Friend menu → What you've changed).
 *
 * Kinds so far:
 *
 *   - `edit`, `delete`: one of your friend's messages
 *   - `regenerate`: their reply, replaced by a new one (the old one is kept)
 *   - `clear`: every message in a channel
 *   - `settings`: their name, look, or how they write
 *   - `ask`: your answer to something they asked (or setting it aside)
 */

import type { Database } from "bun:sqlite";

export type InterventionKind = "edit" | "delete" | "regenerate" | "clear" | "settings" | "ask";

export interface Intervention {
  id: string;
  at: string;
  kind: InterventionKind;
  /** What happened, in a sentence addressed to your friend. */
  summary: string;
  channelId: string | null;
  messageId: string | null;
}

interface InterventionRow {
  id: string;
  at: string;
  kind: InterventionKind;
  summary: string;
  channel_id: string | null;
  message_id: string | null;
}

const toIntervention = (r: InterventionRow): Intervention => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  summary: r.summary,
  channelId: r.channel_id,
  messageId: r.message_id,
});

export class Interventions {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Write one down. */
  add(entry: { kind: InterventionKind; summary: string; channelId?: string | null; messageId?: string | null }): Intervention {
    const id = crypto.randomUUID();
    const at = this.now().toISOString();
    this.db
      .query(
        `INSERT INTO interventions (id, at, kind, summary, channel_id, message_id)
         VALUES ($id, $at, $kind, $summary, $channelId, $messageId)`,
      )
      .run({ id, at, kind: entry.kind, summary: entry.summary, channelId: entry.channelId ?? null, messageId: entry.messageId ?? null });
    return { id, at, kind: entry.kind, summary: entry.summary, channelId: entry.channelId ?? null, messageId: entry.messageId ?? null };
  }

  /** The newest entries, newest first. */
  recent(limit = 50): Intervention[] {
    const rows = this.db.query("SELECT * FROM interventions ORDER BY at DESC, rowid DESC LIMIT $limit").all({ limit }) as InterventionRow[];
    return rows.map(toIntervention);
  }
}
