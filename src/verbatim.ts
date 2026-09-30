/**
 * Moments kept in full (`keep_verbatim`, KINAERA_REBUILD.md section 6.9).
 *
 * Long channels are remembered through summaries: older messages are
 * folded into them and leave the prompt. Your friend can ask for a few
 * moments to stay in full instead, up to `VERBATIM_SLOTS` per channel. A
 * kept message that has scrolled out of the recent messages is still sent
 * in full, under "Moments you kept in full".
 */

import type { Database } from "bun:sqlite";
import { ValidationError } from "./errors.ts";

/** How many messages each channel can keep in full. */
export const VERBATIM_SLOTS = 3;

export class Verbatim {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The ids kept in full in a channel, oldest kept first. */
  ids(channelId: string): string[] {
    const rows = this.db
      .query(
        `SELECT v.message_id FROM verbatim v JOIN messages m ON m.id = v.message_id
          WHERE v.channel_id = $channelId AND m.deleted_at IS NULL AND m.superseded_by IS NULL
          ORDER BY m.seq`,
      )
      .all({ channelId }) as { message_id: string }[];
    return rows.map((r) => r.message_id);
  }

  /** Keep a message in full. Throws if the channel's slots are all used. */
  keep(channelId: string, messageId: string): void {
    const kept = this.ids(channelId);
    if (kept.includes(messageId)) return;
    if (kept.length >= VERBATIM_SLOTS) {
      throw new ValidationError(
        `This channel's ${VERBATIM_SLOTS} slots for moments kept in full are all used. Let one go with release_verbatim first, or ask the user (ask, kind "prompt").`,
      );
    }
    this.db.query("INSERT INTO verbatim (channel_id, message_id, created_at) VALUES ($channelId, $messageId, $now)").run({
      channelId,
      messageId,
      now: this.now().toISOString(),
    });
  }

  /** Let a kept moment go back to being summarized. */
  release(channelId: string, messageId: string): boolean {
    return this.db.query("DELETE FROM verbatim WHERE channel_id = $channelId AND message_id = $messageId").run({ channelId, messageId }).changes > 0;
  }
}
