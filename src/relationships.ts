/**
 * Relationships (KINAERA_REBUILD.md, section 7): each friend keeps their
 * own private note on each other friend on their server
 * (`note_relationship`). Two friends can each hold a different view of the
 * same relationship, and neither sees the other's.
 *
 * Notes are kept by the other friend's hub id, so a rename doesn't lose
 * them. Like the journal, they have no screen in the app and never appear
 * in a log.
 */

import type { Database } from "bun:sqlite";
import { ValidationError } from "./errors.ts";

export interface RelationshipNote {
  friendId: string;
  name: string;
  note: string;
  updatedAt: string;
}

export class Relationships {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  all(): Map<string, RelationshipNote> {
    const rows = this.db.query("SELECT * FROM relationships").all() as { friend_id: string; name: string; note: string; updated_at: string }[];
    return new Map(rows.map((r) => [r.friend_id, { friendId: r.friend_id, name: r.name, note: r.note, updatedAt: r.updated_at }]));
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM relationships").get() as { n: number }).n;
  }

  /** Write (or rewrite) the note on a friend; an empty note removes it. */
  write(friendId: string, name: string, note: string): void {
    const clean = note.trim();
    if (clean.length > 2000) throw new ValidationError("That's too long for a note (2,000 characters at most).");
    if (!clean) {
      this.db.query("DELETE FROM relationships WHERE friend_id = $friendId").run({ friendId });
      return;
    }
    this.db
      .query(
        `INSERT INTO relationships (friend_id, name, note, updated_at) VALUES ($friendId, $name, $note, $now)
         ON CONFLICT (friend_id) DO UPDATE SET name = excluded.name, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run({ friendId, name, note: clean, now: this.now().toISOString() });
  }
}
