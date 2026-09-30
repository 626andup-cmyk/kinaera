/**
 * The self-page: a page your friend owns, which you can both see
 * (KINAERA_REBUILD.md, section 6.2). It has three sections, labelled so the
 * difference between the first two stays clear:
 *
 *   1. **What I say about myself.** Written by your friend. A model
 *      describing itself is telling a plausible story.
 *   2. **What my writing shows.** Notes, each linked to the messages that
 *      show it: patterns your friend chose to keep (the mirror, stage 6),
 *      and notes you add. Yours arrive as suggestions they accept (maybe
 *      with a reply, shown beside it) or decline, and they can dispute any
 *      note at any time. Patterns are evidence; when they and section 1
 *      disagree, that's useful to know.
 *   3. **How I'd like feedback.** Their preferences: direct or gentle,
 *      now or at the end of a scene, and whether edited messages carry a
 *      marker in their prompt (`editMarkers`).
 *
 * A short version (`standing`), which your friend writes and keeps under
 * `STANDING_LIMIT` characters, goes in every prompt. Nothing else from the
 * page is put in front of them unasked.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

/** The short version in every prompt: at most this many characters. */
export const STANDING_LIMIT = 600;

/** The longest a section can be. */
const SECTION_LIMIT = 6000;

export type SelfSection = "says" | "feedback" | "standing";

export interface SelfNote {
  id: string;
  text: string;
  /** "user": a note you added; "mirror": a pattern your friend kept. */
  source: "user" | "mirror";
  /** The messages that show it. */
  messageIds: string[];
  status: "pending" | "accepted" | "declined" | "withdrawn";
  /** Your friend's reply when accepting (or declining) your note. */
  reply: string | null;
  /** Your friend disputing the note, in their words. */
  dispute: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SelfPageView {
  says: string;
  feedback: string;
  standing: string;
  /** Whether edited messages carry a marker in their prompt. */
  editMarkers: boolean;
  /** Notes that are on the page (accepted), and yours waiting for them. */
  notes: SelfNote[];
}

interface NoteRow {
  id: string;
  text: string;
  source: SelfNote["source"];
  message_ids: string;
  status: SelfNote["status"];
  reply: string | null;
  dispute: string | null;
  created_at: string;
  resolved_at: string | null;
}

const toNote = (r: NoteRow): SelfNote => ({
  id: r.id,
  text: r.text,
  source: r.source,
  messageIds: JSON.parse(r.message_ids),
  status: r.status,
  reply: r.reply,
  dispute: r.dispute,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

export class SelfPage {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private value(key: string): string {
    return (this.db.query("SELECT value FROM self_page WHERE key = $key").get({ key }) as { value: string } | null)?.value ?? "";
  }

  private set(key: string, value: string): void {
    this.db.query("INSERT INTO self_page (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run({ key, value });
  }

  /** The whole page, as you both see it. */
  view(): SelfPageView {
    return {
      says: this.value("says"),
      feedback: this.value("feedback"),
      standing: this.value("standing"),
      editMarkers: this.editMarkers(),
      notes: this.notes().filter((n) => n.status === "accepted" || n.status === "pending"),
    };
  }

  /** Your friend writes one of their sections. */
  write(section: SelfSection, text: string): void {
    if (!["says", "feedback", "standing"].includes(section)) throw new ValidationError('The section must be "says", "feedback" or "standing".');
    const clean = text.trim();
    const limit = section === "standing" ? STANDING_LIMIT : SECTION_LIMIT;
    if (clean.length > limit) throw new ValidationError(`That's ${clean.length} characters; this section holds ${limit}.`);
    this.set(section, clean);
  }

  /** Whether edited messages carry a marker in their prompt (their preference; off unless they ask). */
  editMarkers(): boolean {
    return this.value("edit_markers") === "on";
  }

  setEditMarkers(on: boolean): void {
    this.set("edit_markers", on ? "on" : "off");
  }

  // ---------------------------------------------------------------- notes

  /** Every note, oldest first. */
  notes(): SelfNote[] {
    return (this.db.query("SELECT * FROM self_notes ORDER BY created_at, rowid").all() as NoteRow[]).map(toNote);
  }

  getNote(id: string): SelfNote {
    const row = this.db.query("SELECT * FROM self_notes WHERE id = $id").get({ id }) as NoteRow | null;
    if (!row) throw new NotFoundError("note");
    return toNote(row);
  }

  /** Find a note by the start of its id (the short id your friend sees). */
  findNote(shortId: string): SelfNote {
    const wanted = shortId.trim().toLowerCase();
    const match = this.notes().filter((n) => wanted && n.id.toLowerCase().startsWith(wanted));
    if (match.length !== 1) throw new NotFoundError("note");
    return match[0]!;
  }

  /** You add a note on what their writing shows. It waits for them. */
  suggestNote(text: string, messageIds: string[] = []): SelfNote {
    return this.addNote(text, "user", messageIds, "pending");
  }

  /** Your friend keeps a pattern the mirror found (stage 6). */
  keepPattern(text: string, messageIds: string[] = []): SelfNote {
    return this.addNote(text, "mirror", messageIds, "accepted");
  }

  private addNote(text: string, source: SelfNote["source"], messageIds: string[], status: SelfNote["status"]): SelfNote {
    const clean = text.trim();
    if (!clean) throw new ValidationError("A note needs some text.");
    if (clean.length > 2000) throw new ValidationError("A note is 2,000 characters at most.");
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO self_notes (id, text, source, message_ids, status, created_at, resolved_at)
         VALUES ($id, $text, $source, $ids, $status, $now, $resolved)`,
      )
      .run({ id, text: clean, source, ids: JSON.stringify(messageIds.slice(0, 20)), status, now: this.now().toISOString(), resolved: status === "accepted" ? this.now().toISOString() : null });
    return this.getNote(id);
  }

  /** Notes of yours waiting for your friend. */
  pendingNotes(): SelfNote[] {
    return this.notes().filter((n) => n.status === "pending");
  }

  /** Your friend accepts (maybe with a reply) or declines one of your notes. */
  reviewNote(id: string, decision: "accept" | "decline", reply?: string): SelfNote {
    const note = this.getNote(id);
    if (note.status !== "pending") throw new ValidationError("That note has already been dealt with.");
    this.db
      .query("UPDATE self_notes SET status = $status, reply = $reply, resolved_at = $now WHERE id = $id")
      .run({ id, status: decision === "accept" ? "accepted" : "declined", reply: reply?.trim().slice(0, 1000) || null, now: this.now().toISOString() });
    return this.getNote(id);
  }

  /** Your friend disputes a note on their page, any time. (Empty text takes the dispute back.) */
  dispute(id: string, text: string): SelfNote {
    const note = this.getNote(id);
    if (note.status !== "accepted") throw new ValidationError("Only notes on the page can be disputed.");
    this.db.query("UPDATE self_notes SET dispute = $dispute WHERE id = $id").run({ id, dispute: text.trim().slice(0, 1000) || null });
    return this.getNote(id);
  }

  /** You take back a note before they've reviewed it. */
  withdrawNote(id: string): void {
    const note = this.getNote(id);
    if (note.status !== "pending") throw new ValidationError("That note has already been dealt with.");
    this.db.query("UPDATE self_notes SET status = 'withdrawn', resolved_at = $now WHERE id = $id").run({ id, now: this.now().toISOString() });
  }
}
