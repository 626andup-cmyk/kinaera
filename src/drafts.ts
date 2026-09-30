/**
 * Your friend's drafts (KINAERA_REBUILD.md, section 6.5): something they
 * work on across several turns before sending it.
 *
 * Drafts are **private**, like the journal (src/journal.ts): they have no
 * screen in the app, and their text never appears in any log. The app shows
 * only how many there are. `save_draft` writes or rewrites one,
 * `list_drafts` reads them, `post_draft` sends one (in its channel, or
 * another), after which it's an ordinary message, and `delete_draft` lets
 * one go.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

export interface Draft {
  id: string;
  title: string;
  content: string;
  /** Where they mean to post it (null: undecided). */
  channelId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  title: string;
  content: string;
  channel_id: string | null;
  created_at: string;
  updated_at: string;
}

const toDraft = (r: Row): Draft => ({
  id: r.id,
  title: r.title,
  content: r.content,
  channelId: r.channel_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Longest draft, and most drafts at once. */
export const DRAFT_LIMIT = 20_000;
export const DRAFTS_MAX = 30;

/** The short id your friend uses for a draft. */
export const draftId = (id: string) => id.slice(0, 6);

export class Drafts {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every draft, most recently worked on first. */
  all(): Draft[] {
    return (this.db.query("SELECT * FROM drafts ORDER BY updated_at DESC, rowid DESC").all() as Row[]).map(toDraft);
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n;
  }

  get(id: string): Draft {
    const row = this.db.query("SELECT * FROM drafts WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("draft");
    return toDraft(row);
  }

  /** A draft by the start of its id (as the friend sees it), with or without brackets. */
  find(short: string): Draft {
    const clean = short.trim().replace(/^\[|\]$/g, "");
    const match = clean ? this.all().filter((d) => d.id.startsWith(clean)) : [];
    if (match.length !== 1) throw new NotFoundError("draft");
    return match[0]!;
  }

  /** A new draft. */
  create(content: string, title = "", channelId: string | null = null): Draft {
    const text = clean(content);
    if (this.count() >= DRAFTS_MAX) throw new ValidationError(`You already have ${DRAFTS_MAX} drafts. Post or delete one first.`);
    const id = crypto.randomUUID();
    const now = this.now().toISOString();
    this.db
      .query("INSERT INTO drafts (id, title, content, channel_id, created_at, updated_at) VALUES ($id, $title, $content, $channelId, $now, $now)")
      .run({ id, title: title.trim().slice(0, 200), content: text, channelId, now });
    return this.get(id);
  }

  /** Rewrite a draft: its text, title or channel (whatever is given). */
  update(id: string, change: { content?: string; title?: string; channelId?: string | null }): Draft {
    const draft = this.get(id);
    this.db
      .query("UPDATE drafts SET content = $content, title = $title, channel_id = $channelId, updated_at = $now WHERE id = $id")
      .run({
        id,
        content: change.content !== undefined ? clean(change.content) : draft.content,
        title: change.title !== undefined ? change.title.trim().slice(0, 200) : draft.title,
        channelId: change.channelId !== undefined ? change.channelId : draft.channelId,
        now: this.now().toISOString(),
      });
    return this.get(id);
  }

  remove(id: string): void {
    this.db.query("DELETE FROM drafts WHERE id = $id").run({ id });
  }
}

function clean(content: string): string {
  const text = content.trim();
  if (!text) throw new ValidationError("A draft needs some text.");
  if (text.length > DRAFT_LIMIT) throw new ValidationError(`That's too long for a draft (${DRAFT_LIMIT} characters at most).`);
  return text;
}
