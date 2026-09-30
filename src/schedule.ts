/**
 * Your friend's own schedule: wake-ups they set for themselves
 * (KINAERA_REBUILD.md, section 6.5), like "Thursday evening: ask how the
 * interview went".
 *
 * `schedule_wakeup({ when, note })` adds one, `list_my_wakeups` shows them
 * and `cancel_wakeup` takes one back. When one is due, a timer
 * (src/orientation.ts, `Rhythms`) gives them a turn with the reason
 * "scheduled", and their note is in "Why you're up". The hard rules still
 * apply (src/wakeups.ts), with one exception: a wake-up they planned isn't
 * held back by the double-text limit, because a friend's own plan isn't
 * blocked just because you've been quiet. If a rule holds it (quiet hours,
 * the cooldown, a conversation going on), it stays waiting and fires as
 * soon as the rules allow. That's how one landing in quiet hours moves to
 * their end.
 *
 * Times are the phone's local time. `when` can be:
 *   - "in 20 minutes", "in 3 hours", "in 2 days", "in 1 week";
 *   - "today 18:30", "tomorrow 9am", "thursday 7pm", "friday at 20:00";
 *   - an ISO date and time, like "2026-10-08T19:00".
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

export type ScheduleStatus = "waiting" | "done" | "cancelled";

export interface ScheduledWakeup {
  id: number;
  /** When it's due (ISO). */
  at: string;
  note: string;
  /** Where they'll wake up (null: their usual OOC channel). */
  channelId: string | null;
  status: ScheduleStatus;
  createdAt: string;
  doneAt: string | null;
}

interface Row {
  id: number;
  at: string;
  note: string;
  channel_id: string | null;
  status: ScheduleStatus;
  created_at: string;
  done_at: string | null;
}

const toWakeup = (r: Row): ScheduledWakeup => ({
  id: r.id,
  at: r.at,
  note: r.note,
  channelId: r.channel_id,
  status: r.status,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

/** How many can be waiting at once, and how far ahead. */
export const SCHEDULE_LIMIT = 20;
export const SCHEDULE_MAX_DAYS = 60;
const NOTE_LIMIT = 1000;

const UNITS: Record<string, number> = {
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Read `when` into a time, or explain what's understood. Clock times like
 * "7pm" or "19:00" are the phone's local time.
 */
export function parseWhen(when: string, now = new Date()): Date {
  const text = when.trim().toLowerCase().replace(/\s+/g, " ");
  const fail = () =>
    new ValidationError(
      `Couldn't read "${when}" as a time. Try "in 3 hours", "tomorrow 9am", "thursday 19:00", or a date and time like "2026-10-08T19:00".`,
    );

  // "in 3 hours", "in 20 min"
  const relative = text.match(/^in (\d+(?:\.\d+)?|an?|one) ([a-z]+?)s?$/);
  if (relative) {
    const count = /^(a|an|one)$/.test(relative[1]!) ? 1 : Number(relative[1]);
    const unit = UNITS[relative[2]!];
    if (!unit) throw fail();
    return new Date(now.getTime() + count * unit);
  }

  // "tomorrow 9am", "thursday at 19:00", "today 6:30pm"
  const dayTime = text.match(/^(today|tonight|tomorrow|[a-z]+day)(?: at)? (\d{1,2})(?::(\d{2}))? ?(am|pm)?$/);
  if (dayTime) {
    const [, day, h, m, meridiem] = dayTime;
    let hour = Number(h);
    const minute = Number(m ?? 0);
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw fail();
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (day === "tomorrow") date.setDate(date.getDate() + 1);
    else if (day !== "today" && day !== "tonight") {
      const target = WEEKDAYS.indexOf(day!);
      if (target < 0) throw fail();
      let ahead = (target - date.getDay() + 7) % 7;
      if (ahead === 0 && date <= now) ahead = 7; // "thursday" on a Thursday evening: next week's
      date.setDate(date.getDate() + ahead);
    }
    return date;
  }

  // An ISO date and time (without a zone, it's local time).
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{1,2}:\d{2}/.test(text)) {
    const date = new Date(when.trim().replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw fail();
}

/** A time in words, in the phone's local time: "Thu 8 Oct, 19:00". */
export function localTime(date: Date): string {
  return date.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export class Schedule {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(id: number): ScheduledWakeup {
    const row = this.db.query("SELECT * FROM schedule WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("wake-up");
    return toWakeup(row);
  }

  /** Waiting wake-ups, soonest first. */
  waiting(): ScheduledWakeup[] {
    return (this.db.query("SELECT * FROM schedule WHERE status = 'waiting' ORDER BY at, id").all() as Row[]).map(toWakeup);
  }

  /** The waiting ones already due, soonest first. */
  due(at: Date = this.now()): ScheduledWakeup[] {
    const now = at.toISOString();
    return this.waiting().filter((w) => w.at <= now);
  }

  /** Your friend sets a wake-up for themselves. */
  add(when: string, note: string, channelId: string | null = null): ScheduledWakeup {
    const now = this.now();
    const at = parseWhen(when, now);
    if (at.getTime() <= now.getTime()) throw new ValidationError("That time has already passed.");
    if (at.getTime() - now.getTime() > SCHEDULE_MAX_DAYS * 86_400_000) {
      throw new ValidationError(`That's too far ahead: ${SCHEDULE_MAX_DAYS} days at most.`);
    }
    const clean = note.trim();
    if (!clean) throw new ValidationError("A wake-up needs a note: what it's for.");
    if (this.waiting().length >= SCHEDULE_LIMIT) {
      throw new ValidationError(`You already have ${SCHEDULE_LIMIT} wake-ups waiting. Cancel one first.`);
    }
    const result = this.db
      .query("INSERT INTO schedule (at, note, channel_id, created_at) VALUES ($at, $note, $channelId, $now)")
      .run({ at: at.toISOString(), note: clean.slice(0, NOTE_LIMIT), channelId, now: now.toISOString() });
    return this.get(Number(result.lastInsertRowid));
  }

  /** Your friend takes one back. */
  cancel(id: number): ScheduledWakeup {
    const wakeup = this.get(id);
    if (wakeup.status !== "waiting") throw new ValidationError("That wake-up isn't waiting any more.");
    this.db.query("UPDATE schedule SET status = 'cancelled', done_at = $now WHERE id = $id").run({ id, now: this.now().toISOString() });
    return this.get(id);
  }

  /** It fired: their turn happened (or the model failed, and it isn't retried). */
  markDone(id: number): void {
    this.db.query("UPDATE schedule SET status = 'done', done_at = $now WHERE id = $id AND status = 'waiting'").run({ id, now: this.now().toISOString() });
  }
}
