/**
 * The inbox: what your friend asks of you.
 *
 * Two kinds of thing arrive here:
 *
 *   - **Asks** (the `ask` tool): your friend turning to you, a person, for
 *     something. Each has a kind, so you know what it's about:
 *
 *       context   "remind me who knows the secret"
 *       check     "can you look at this for me"
 *       model     "I'd like a different profile for this scene"
 *       pause     "I need a break from this storyline"
 *       clarify   "I'm not sure what you meant"
 *       prompt    "please keep this memory in full"
 *       other     anything else
 *
 *     You answer in the inbox, or dismiss it. Your answer reaches your
 *     friend on their next turn, whatever the channel, and answering also
 *     gives them a turn of their own, if the hard rules allow
 *     (src/wakeups.ts).
 *
 *   - **Proposals**: things your friend can't do alone, which you approve
 *     or deny. For now that's deleting a channel.
 *
 * Notebook suggestions are shown in the same inbox in the app, but are
 * stored with the notebook (src/notebook.ts), because they belong to their
 * entries.
 *
 * "Delivered" means an outcome (your answer, or how a proposal went) has
 * been in one of your friend's turns. Until then, every turn carries it.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

export const ASK_KINDS = ["context", "check", "model", "pause", "clarify", "prompt", "other"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** What each kind of ask is for, in a few words (for the tool, and the app). */
export const ASK_KIND_NAMES: Record<AskKind, string> = {
  context: "context: something you need to know or be reminded of",
  check: "check: asking the user to look at something",
  model: "model: a different profile for something",
  pause: "pause: a break from a storyline",
  clarify: "clarify: you're not sure what the user meant",
  prompt: "prompt: how your context is built, like keeping a memory in full",
  other: "other: anything else",
};

export type InboxStatus = "open" | "answered" | "dismissed" | "approved" | "denied";

export interface InboxItem {
  id: string;
  kind: "ask" | "delete_channel";
  /** For asks. */
  askKind: AskKind | null;
  /** What they asked, or why they propose it. */
  text: string;
  /** For proposals: what it's about, and its name at the time. */
  targetId: string | null;
  targetName: string | null;
  /** The channel it came from, if any. */
  channelId: string | null;
  status: InboxStatus;
  /** Your answer to an ask. */
  answer: string | null;
  /** Asked during an orientation (marked as such in your inbox). */
  orientation: boolean;
  createdAt: string;
  resolvedAt: string | null;
  deliveredAt: string | null;
}

interface InboxRow {
  id: string;
  kind: InboxItem["kind"];
  ask_kind: AskKind | null;
  text: string;
  target_id: string | null;
  target_name: string | null;
  channel_id: string | null;
  status: InboxStatus;
  answer: string | null;
  orientation: number;
  created_at: string;
  resolved_at: string | null;
  delivered_at: string | null;
}

const toItem = (r: InboxRow): InboxItem => ({
  id: r.id,
  kind: r.kind,
  askKind: r.ask_kind,
  text: r.text,
  targetId: r.target_id,
  targetName: r.target_name,
  channelId: r.channel_id,
  status: r.status,
  answer: r.answer,
  orientation: r.orientation === 1,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  deliveredAt: r.delivered_at,
});

/** Longest ask or answer, in characters. */
const MAX_TEXT = 4000;

export class Inbox {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(id: string): InboxItem {
    const row = this.db.query("SELECT * FROM inbox WHERE id = $id").get({ id }) as InboxRow | null;
    if (!row) throw new NotFoundError("inbox item");
    return toItem(row);
  }

  /** Everything still waiting for you, oldest first. */
  open(): InboxItem[] {
    return (this.db.query("SELECT * FROM inbox WHERE status = 'open' ORDER BY created_at, rowid").all() as InboxRow[]).map(toItem);
  }

  /** The newest items, open or not, newest first (for the app). */
  recent(limit = 50): InboxItem[] {
    return (this.db.query("SELECT * FROM inbox ORDER BY created_at DESC, rowid DESC LIMIT $limit").all({ limit }) as InboxRow[]).map(toItem);
  }

  // ---------------------------------------------------------------- asks

  /** Your friend asks you something. */
  ask(askKind: AskKind, text: string, channelId: string | null, orientation = false): InboxItem {
    if (!ASK_KINDS.includes(askKind)) throw new ValidationError(`"kind" must be one of: ${ASK_KINDS.join(", ")}.`);
    const clean = text.trim();
    if (!clean) throw new ValidationError("An ask needs some text.");
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO inbox (id, kind, ask_kind, text, channel_id, orientation, created_at)
         VALUES ($id, 'ask', $askKind, $text, $channelId, $orientation, $now)`,
      )
      .run({ id, askKind, text: clean.slice(0, MAX_TEXT), channelId, orientation: orientation ? 1 : 0, now: this.now().toISOString() });
    return this.get(id);
  }

  /** You answer an ask. */
  answer(id: string, answer: string): InboxItem {
    const item = this.get(id);
    if (item.kind !== "ask") throw new ValidationError("Only asks are answered; proposals are approved or denied.");
    if (item.status !== "open") throw new ValidationError("That's already been dealt with.");
    const clean = answer.trim();
    if (!clean) throw new ValidationError("Write an answer first.");
    this.db
      .query("UPDATE inbox SET status = 'answered', answer = $answer, resolved_at = $now WHERE id = $id")
      .run({ id, answer: clean.slice(0, MAX_TEXT), now: this.now().toISOString() });
    return this.get(id);
  }

  /** You set an ask aside without answering. Your friend is told. */
  dismiss(id: string): InboxItem {
    const item = this.get(id);
    if (item.kind !== "ask") throw new ValidationError("Proposals are approved or denied.");
    if (item.status !== "open") throw new ValidationError("That's already been dealt with.");
    this.db.query("UPDATE inbox SET status = 'dismissed', resolved_at = $now WHERE id = $id").run({ id, now: this.now().toISOString() });
    return this.get(id);
  }

  /** Your friend's asks still waiting for you, oldest first. */
  openAsks(): InboxItem[] {
    return this.open().filter((i) => i.kind === "ask");
  }

  // ----------------------------------------------------------- proposals

  /**
   * Your friend proposes deleting a channel. Proposing the same thing twice
   * while the first is still waiting returns the first.
   */
  propose(kind: "delete_channel", targetId: string, targetName: string, reason: string): InboxItem {
    const existing = this.db
      .query("SELECT * FROM inbox WHERE kind = $kind AND target_id = $targetId AND status = 'open'")
      .get({ kind, targetId }) as InboxRow | null;
    if (existing) return toItem(existing);
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO inbox (id, kind, text, target_id, target_name, created_at)
         VALUES ($id, $kind, $reason, $targetId, $targetName, $now)`,
      )
      .run({ id, kind, reason: reason.slice(0, 1000), targetId, targetName, now: this.now().toISOString() });
    return this.get(id);
  }

  /** Waiting proposals, oldest first. */
  openProposals(): InboxItem[] {
    return this.open().filter((i) => i.kind !== "ask");
  }

  /** Mark a waiting proposal approved or denied. (Carrying it out is the caller's job.) */
  resolveProposal(id: string, status: "approved" | "denied"): InboxItem {
    const item = this.get(id);
    if (item.kind === "ask") throw new ValidationError("Asks are answered, not approved.");
    if (item.status !== "open") throw new ValidationError("That proposal has already been dealt with.");
    this.db.query("UPDATE inbox SET status = $status, resolved_at = $now WHERE id = $id").run({ id, status, now: this.now().toISOString() });
    return this.get(id);
  }

  // ---------------------------------------------------------- delivering

  /** Outcomes your friend hasn't had in a turn yet: answers, dismissals, and how proposals went. Oldest first. */
  undelivered(): InboxItem[] {
    return (
      this.db.query("SELECT * FROM inbox WHERE status != 'open' AND delivered_at IS NULL ORDER BY resolved_at, rowid").all() as InboxRow[]
    ).map(toItem);
  }

  /** These outcomes were in a turn of your friend's. */
  markDelivered(ids: string[]): void {
    const mark = this.db.query("UPDATE inbox SET delivered_at = $now WHERE id = $id AND delivered_at IS NULL");
    const now = this.now().toISOString();
    this.db.transaction(() => ids.forEach((id) => mark.run({ id, now })))();
  }
}
