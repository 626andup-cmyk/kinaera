/**
 * Your friend's private journal (KINAERA_REBUILD.md, section 6.4).
 *
 * **Private.** The journal has no screen in the app: you see only how many
 * entries there are. Its text is never written to any log (the tool log
 * and the check log record that it was used, never what it says), and the
 * prompt preview leaves it out. Your friend's prompt says so honestly,
 * including where the text *does* go: to the model providers that run
 * them, to Jev when `check` searches it, and to a consultant if they
 * attach it to a `consult`.
 *
 * **Forgetting, on purpose.** Each prompt carries the entries your friend
 * chose to keep, then the few newest, within `JOURNAL_BUDGET` characters.
 * Older entries they didn't keep fall out of that as they age. They stay
 * searchable (`read_journal`, `check`), but nothing brings them back
 * unasked. A bad evening fades the way it would for a person, unless they
 * keep it.
 *
 * **Once a week**, a look back: your friend gets a quiet turn with what they
 * wrote that week, to keep, rewrite or let go of entries (src/wakeups.ts,
 * reason "lookback").
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

/** How much of the journal a prompt carries, in characters. */
export const JOURNAL_BUDGET = 2500;

/** How many of the newest (unkept) entries a prompt carries. */
export const JOURNAL_RECENT = 3;

/** The longest entry, in characters. */
export const ENTRY_LIMIT = 4000;

export interface JournalEntry {
  id: string;
  content: string;
  /** Carried forward: in every prompt. */
  kept: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  content: string;
  kept: number;
  created_at: string;
  updated_at: string;
}

const toEntry = (r: Row): JournalEntry => ({ id: r.id, content: r.content, kept: r.kept === 1, createdAt: r.created_at, updatedAt: r.updated_at });

/** The short id your friend uses for an entry: its first 6 characters. */
export const shortId = (id: string) => id.slice(0, 6);

export class Journal {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every entry, oldest first. */
  all(): JournalEntry[] {
    return (this.db.query("SELECT * FROM journal ORDER BY created_at, rowid").all() as Row[]).map(toEntry);
  }

  /** How many entries, and how many are kept: all the app ever shows. */
  counts(): { entries: number; kept: number } {
    const row = this.db.query("SELECT COUNT(*) AS entries, COALESCE(SUM(kept), 0) AS kept FROM journal").get() as { entries: number; kept: number };
    return { entries: row.entries, kept: row.kept };
  }

  get(id: string): JournalEntry {
    const row = this.db.query("SELECT * FROM journal WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("journal entry");
    return toEntry(row);
  }

  /** Find an entry by its short id. */
  find(short: string): JournalEntry {
    const wanted = short.trim().toLowerCase();
    const match = this.all().filter((e) => wanted && e.id.toLowerCase().startsWith(wanted));
    if (match.length !== 1) throw new NotFoundError("journal entry");
    return match[0]!;
  }

  write(content: string): JournalEntry {
    const clean = checkText(content);
    const id = crypto.randomUUID();
    const now = this.now().toISOString();
    this.db.query("INSERT INTO journal (id, content, kept, created_at, updated_at) VALUES ($id, $content, 0, $now, $now)").run({ id, content: clean, now });
    return this.get(id);
  }

  rewrite(id: string, content: string): JournalEntry {
    this.get(id);
    this.db.query("UPDATE journal SET content = $content, updated_at = $now WHERE id = $id").run({ id, content: checkText(content), now: this.now().toISOString() });
    return this.get(id);
  }

  keep(id: string, kept: boolean): JournalEntry {
    this.get(id);
    this.db.query("UPDATE journal SET kept = $kept, updated_at = $now WHERE id = $id").run({ id, kept: kept ? 1 : 0, now: this.now().toISOString() });
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.query("DELETE FROM journal WHERE id = $id").run({ id });
  }

  /** Entries written since a time, oldest first (for the weekly look back). */
  since(iso: string): JournalEntry[] {
    return (this.db.query("SELECT * FROM journal WHERE created_at >= $iso ORDER BY created_at, rowid").all({ iso }) as Row[]).map(toEntry);
  }

  /**
   * What a prompt carries: kept entries first (oldest first), then the few
   * newest unkept ones, within `JOURNAL_BUDGET`. The rest has faded.
   */
  forPrompt(): { entries: JournalEntry[]; faded: number } {
    const all = this.all();
    const kept = all.filter((e) => e.kept);
    const recent = all.filter((e) => !e.kept).slice(-JOURNAL_RECENT);
    const chosen: JournalEntry[] = [];
    let total = 0;
    for (const entry of [...kept, ...recent]) {
      if (total + entry.content.length > JOURNAL_BUDGET) continue;
      chosen.push(entry);
      total += entry.content.length;
    }
    chosen.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { entries: chosen, faded: all.length - chosen.length };
  }
}

function checkText(content: string): string {
  const clean = typeof content === "string" ? content.trim() : "";
  if (!clean) throw new ValidationError("A journal entry needs some text.");
  if (clean.length > ENTRY_LIMIT) throw new ValidationError(`A journal entry is ${ENTRY_LIMIT} characters at most.`);
  return clean;
}
