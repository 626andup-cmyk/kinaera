/**
 * What happens around messages (stage 6): the tool log and comment
 * threads.
 *
 *   - **ToolLog** keeps every tool call your friend makes, with the
 *     arguments exactly as the model wrote them and what was sent back.
 *     The app shows each turn's actions under its messages, and the whole
 *     log per channel for troubleshooting.
 *   - **Comments** are notes on a message (or a highlighted part of one),
 *     in threads you both can reply to and resolve. They're out of
 *     character: your friend reads them as OOC notes, never as something
 *     the characters know.
 *
 * Proposals (actions your friend can't take alone) are in the inbox now:
 * see src/inbox.ts.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, PermissionError, ValidationError } from "./errors.ts";
import type { Author, Comment, CommentThread, ToolCallRecord } from "./types.ts";

// ---------------------------------------------------------------- tool log

interface ToolCallRow {
  id: string;
  channel_id: string;
  turn_id: string;
  round: number;
  name: string;
  arguments: string;
  result: string;
  status: "ok" | "error";
  summary: string;
  source: "native" | "text";
  profile: string | null;
  created_at: string;
}

/** Rows may carry extra columns (like `seq`); only the known ones are kept. */
function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    turnId: row.turn_id,
    round: row.round,
    name: row.name,
    arguments: row.arguments,
    result: row.result,
    status: row.status,
    summary: row.summary,
    source: row.source,
    profile: row.profile,
    createdAt: row.created_at,
  };
}

export class ToolLog {
  constructor(private readonly db: Database) {}

  add(record: Omit<ToolCallRecord, "id" | "createdAt">): ToolCallRecord {
    const full: ToolCallRecord = { ...record, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .query(
        `INSERT INTO tool_calls (id, channel_id, turn_id, round, name, arguments, result, status, summary, source, profile, created_at)
         VALUES ($id, $channelId, $turnId, $round, $name, $arguments, $result, $status, $summary, $source, $profile, $createdAt)`,
      )
      .run({ ...full });
    return full;
  }

  /** A channel's tool calls, oldest first (the newest `limit`). */
  forChannel(channelId: string, limit = 300): ToolCallRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT *, rowid AS seq FROM tool_calls WHERE channel_id = $channelId
                         ORDER BY created_at DESC, rowid DESC LIMIT $limit)
          ORDER BY created_at, seq`,
      )
      .all({ channelId, limit }) as ToolCallRow[];
    return rows.map(toToolCall);
  }

  /** One turn's tool calls, in order. */
  forTurn(turnId: string): ToolCallRecord[] {
    const rows = this.db
      .query("SELECT * FROM tool_calls WHERE turn_id = $turnId ORDER BY created_at, rowid")
      .all({ turnId }) as ToolCallRow[];
    return rows.map(toToolCall);
  }
}

// ---------------------------------------------------------------- comments

interface CommentRow {
  id: string;
  message_id: string;
  thread_id: string;
  author: Author;
  quote: string;
  note: string;
  resolved: number;
  created_at: string;
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    messageId: row.message_id,
    threadId: row.thread_id,
    author: row.author,
    quote: row.quote,
    note: row.note,
    createdAt: row.created_at,
  };
}

const MAX_NOTE = 5_000;

export class Comments {
  constructor(private readonly db: Database) {}

  /**
   * Start a thread on a message, optionally on a highlighted part of it.
   * Throws `NotFoundError` if the message doesn't exist.
   */
  start(author: Author, messageId: string, note: string, quote = ""): CommentThread {
    const exists = this.db.query("SELECT 1 FROM messages WHERE id = $messageId").get({ messageId });
    if (!exists) throw new NotFoundError("message");
    const id = crypto.randomUUID();
    this.insert({ id, messageId, threadId: id, author, quote: quote.trim().slice(0, 1000), note: checkNote(note) });
    return this.thread(id);
  }

  /** Reply in a thread. A reply reopens a resolved thread. */
  reply(author: Author, threadId: string, note: string): CommentThread {
    const thread = this.thread(threadId);
    this.db.transaction(() => {
      this.insert({
        id: crypto.randomUUID(),
        messageId: thread.messageId,
        threadId,
        author,
        quote: "",
        note: checkNote(note),
      });
      this.db.query("UPDATE comments SET resolved = 0 WHERE id = $threadId").run({ threadId });
    })();
    return this.thread(threadId);
  }

  /** Resolve (or reopen) a thread. Either of you can. */
  resolve(threadId: string, resolved = true): CommentThread {
    this.thread(threadId);
    this.db.query("UPDATE comments SET resolved = $resolved WHERE id = $threadId").run({ threadId, resolved: resolved ? 1 : 0 });
    return this.thread(threadId);
  }

  /**
   * Delete one of your own comments. Deleting a thread's first comment
   * deletes the whole thread.
   */
  delete(actor: Author, commentId: string): void {
    const row = this.db.query("SELECT * FROM comments WHERE id = $commentId").get({ commentId }) as CommentRow | null;
    if (!row) throw new NotFoundError("comment");
    if (row.author !== actor) throw new PermissionError("You can only delete your own comments.");
    if (row.thread_id === row.id) this.db.query("DELETE FROM comments WHERE thread_id = $id").run({ id: row.id });
    else this.db.query("DELETE FROM comments WHERE id = $id").run({ id: row.id });
  }

  /** One thread. Throws `NotFoundError` if there's no such thread. */
  thread(threadId: string): CommentThread {
    const rows = this.db
      .query("SELECT * FROM comments WHERE thread_id = $threadId ORDER BY created_at, rowid")
      .all({ threadId }) as CommentRow[];
    const first = rows.find((r) => r.id === threadId);
    if (!first) throw new NotFoundError("comment thread");
    return {
      id: first.id,
      messageId: first.message_id,
      quote: first.quote,
      resolved: first.resolved === 1,
      comments: rows.map(toComment),
    };
  }

  /** Every thread on a channel's messages, oldest first. */
  forChannel(channelId: string): CommentThread[] {
    const ids = this.db
      .query(
        `SELECT c.id FROM comments c JOIN messages m ON m.id = c.message_id
          WHERE m.channel_id = $channelId AND c.thread_id = c.id
            AND m.deleted_at IS NULL AND m.superseded_by IS NULL
          ORDER BY c.created_at, c.rowid`,
      )
      .all({ channelId }) as { id: string }[];
    return ids.map(({ id }) => this.thread(id));
  }

  /**
   * Find a thread by the short id your friend sees (its first 8
   * characters), within a channel.
   */
  findInChannel(channelId: string, shortId: string): CommentThread {
    const wanted = shortId.trim().replace(/^#/, "").toLowerCase();
    const match = this.forChannel(channelId).filter((t) => t.id.toLowerCase().startsWith(wanted));
    if (wanted === "" || match.length !== 1) throw new NotFoundError("comment thread");
    return match[0]!;
  }

  private insert(c: Omit<Comment, "createdAt">): void {
    this.db
      .query(
        `INSERT INTO comments (id, message_id, thread_id, author, quote, note, created_at)
         VALUES ($id, $messageId, $threadId, $author, $quote, $note, $now)`,
      )
      .run({ ...c, now: new Date().toISOString() });
  }
}

function checkNote(note: string): string {
  if (typeof note !== "string" || note.trim() === "") throw new ValidationError("A comment can't be empty.");
  if (note.length > MAX_NOTE) throw new ValidationError("That comment is too long.");
  return note.trim();
}
