/**
 * Your friend's identity: who they are, and their tastes. It belongs to
 * them (KINAERA_REBUILD.md, section 6.1).
 *
 * It's written when they're made, by "Surprise me" or by you. After that:
 *
 *   - **They revise it** with `revise_identity`. Every version is kept.
 *   - **Your edits are suggestions.** Changing it in the app sends them a
 *     suggestion, which they accept or decline on their next turn (with a
 *     reply, if they like). The same idea as notebook suggestions.
 *   - **Everyone can see the changelog**, with who wrote each version.
 *
 * The **tastes** section is what they love, what bores them, and what
 * they'd never write. It's seeded when they're made and grows with them:
 * it's their defence against drifting into agreeing with everything.
 *
 * The current identity is also kept in the `friendPrompt` setting, so the
 * rest of the app (the friend menu, copying settings to a new friend) keeps
 * reading it from one place.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Author } from "./types.ts";

export type IdentityStatus = "accepted" | "pending" | "declined" | "withdrawn";

export interface IdentityVersion {
  id: number;
  identity: string;
  tastes: string;
  /** Who wrote this version. */
  author: Author;
  /** Why, in their words (or yours, for a suggestion). */
  note: string;
  status: IdentityStatus;
  /** Your friend's reply to a suggestion of yours. */
  reply: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface Row {
  id: number;
  identity: string;
  tastes: string;
  author: Author;
  note: string;
  status: IdentityStatus;
  reply: string | null;
  created_at: string;
  resolved_at: string | null;
}

const toVersion = (r: Row): IdentityVersion => ({
  id: r.id,
  identity: r.identity,
  tastes: r.tastes,
  author: r.author,
  note: r.note,
  status: r.status,
  reply: r.reply,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

/** Longest identity or tastes, in characters. */
export const IDENTITY_LIMIT = 8000;

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  if (value.length > IDENTITY_LIMIT) throw new ValidationError(`${field} is too long (${IDENTITY_LIMIT} characters at most).`);
  return value.trim();
}

export class Identity {
  constructor(
    private readonly db: Database,
    /** Keeps the `friendPrompt` setting in step with the current identity. */
    private readonly mirror: (identity: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The current identity: the newest accepted version (`null` before the first). */
  current(): IdentityVersion | null {
    const row = this.db.query("SELECT * FROM identity_versions WHERE status = 'accepted' ORDER BY id DESC LIMIT 1").get() as Row | null;
    return row ? toVersion(row) : null;
  }

  /** Every version and suggestion, oldest first: the changelog. */
  history(): IdentityVersion[] {
    return (this.db.query("SELECT * FROM identity_versions ORDER BY id").all() as Row[]).map(toVersion);
  }

  get(id: number): IdentityVersion {
    const row = this.db.query("SELECT * FROM identity_versions WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("identity version");
    return toVersion(row);
  }

  /**
   * Where it starts: the identity your friend was made with. Replaces
   * anything there (only used when they're made).
   */
  begin(identity: string, tastes: string): IdentityVersion {
    this.db.transaction(() => {
      this.db.query("DELETE FROM identity_versions").run();
      this.insert({ identity: text(identity, "identity"), tastes: text(tastes, "tastes"), author: "user", note: "Who they were made as.", status: "accepted" });
    })();
    this.mirror(identity.trim());
    return this.current()!;
  }

  /** Your friend rewrites their identity, their tastes, or both. */
  revise(change: { identity?: string; tastes?: string; note?: string }): IdentityVersion {
    const now = this.current();
    const identity = change.identity !== undefined ? text(change.identity, "identity") : (now?.identity ?? "");
    const tastes = change.tastes !== undefined ? text(change.tastes, "tastes") : (now?.tastes ?? "");
    if (!identity) throw new ValidationError("Your identity can't be empty.");
    if (now && identity === now.identity && tastes === now.tastes) throw new ValidationError("That's the same as your current identity.");
    const id = this.insert({ identity, tastes, author: "friend", note: (change.note ?? "").trim().slice(0, 1000), status: "accepted" });
    this.mirror(identity);
    return this.get(id);
  }

  /** You suggest a change. Your friend accepts or declines it. */
  suggest(change: { identity?: string; tastes?: string; note?: string }): IdentityVersion {
    const now = this.current();
    const identity = change.identity !== undefined ? text(change.identity, "identity") : (now?.identity ?? "");
    const tastes = change.tastes !== undefined ? text(change.tastes, "tastes") : (now?.tastes ?? "");
    if (!identity) throw new ValidationError("An identity can't be empty.");
    if (now && identity === now.identity && tastes === now.tastes) throw new ValidationError("That's the same as their current identity.");
    const id = this.insert({ identity, tastes, author: "user", note: (change.note ?? "").trim().slice(0, 1000), status: "pending" });
    return this.get(id);
  }

  /** Your suggestions waiting for your friend, oldest first. */
  pending(): IdentityVersion[] {
    return (this.db.query("SELECT * FROM identity_versions WHERE status = 'pending' ORDER BY id").all() as Row[]).map(toVersion);
  }

  /**
   * Your friend accepts or declines a suggestion, with an optional reply.
   * Accepting makes it their current identity.
   */
  review(id: number, decision: "accept" | "decline", reply?: string): IdentityVersion {
    const version = this.get(id);
    if (version.status !== "pending") throw new ValidationError("That suggestion has already been dealt with.");
    this.db
      .query("UPDATE identity_versions SET status = $status, reply = $reply, resolved_at = $now WHERE id = $id")
      .run({ id, status: decision === "accept" ? "accepted" : "declined", reply: reply?.trim().slice(0, 1000) || null, now: this.now().toISOString() });
    // An accepted suggestion becomes the newest version: it goes to the end.
    if (decision === "accept") {
      const newId = this.insert({ ...version, status: "accepted" });
      this.db.query("UPDATE identity_versions SET resolved_at = $now, reply = $reply WHERE id = $newId").run({
        newId,
        now: this.now().toISOString(),
        reply: reply?.trim().slice(0, 1000) || null,
      });
      this.db.query("DELETE FROM identity_versions WHERE id = $id").run({ id });
      this.mirror(version.identity);
      return this.get(newId);
    }
    return this.get(id);
  }

  /** You take a suggestion back before they've reviewed it. */
  withdraw(id: number): void {
    const version = this.get(id);
    if (version.status !== "pending") throw new ValidationError("That suggestion has already been dealt with.");
    this.db.query("UPDATE identity_versions SET status = 'withdrawn', resolved_at = $now WHERE id = $id").run({ id, now: this.now().toISOString() });
  }

  private insert(v: { identity: string; tastes: string; author: Author; note: string; status: IdentityStatus; createdAt?: string }): number {
    const result = this.db
      .query(
        `INSERT INTO identity_versions (identity, tastes, author, note, status, created_at)
         VALUES ($identity, $tastes, $author, $note, $status, $now)`,
      )
      .run({ identity: v.identity, tastes: v.tastes, author: v.author, note: v.note, status: v.status, now: v.createdAt ?? this.now().toISOString() });
    return Number(result.lastInsertRowid);
  }
}
