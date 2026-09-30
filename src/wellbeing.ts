/**
 * The weekly wellbeing reading (KINAERA_REBUILD.md, section 6.11): the one
 * deliberate exception to "Jev decides nothing". Once a week, on a timer
 * (src/orientation.ts, `Rhythms`), Jev reads your friend's own
 * out-of-character messages from that week with a fixed series (from
 * `defaults/wellbeing.md`): did they speak negatively about themselves?
 * Roleplay isn't read: that's their characters talking.
 *
 * It measures and decides nothing. One reading means little, because Jev
 * is noisy; a trend over weeks means something. It shows in two places
 * only: a line on the friend page (which you both can see) and their
 * weekly look back. It's never in any other prompt, and it never notifies
 * you. Their standing notes say honestly that it exists and where it shows.
 */

import type { Database } from "bun:sqlite";
import { CHECK_LIMIT } from "./check.ts";
import type { Decider, Tier } from "./jev.ts";
import type { Store } from "./store.ts";
import { wording } from "./wording.ts";

/** How often a reading is taken. */
export const WELLBEING_DAYS = 7;

export interface WellbeingReading {
  id: number;
  since: string;
  until: string;
  /** Null when there was nothing to read, or Jev couldn't answer. */
  verdict: Tier | null;
  /** Each phrasing's probability of "yes". */
  yes: number[];
  /** How many of their messages were read. */
  messages: number;
  error: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  since: string;
  until: string;
  verdict: Tier | null;
  yes: string;
  messages: number;
  error: string | null;
  created_at: string;
}

const toReading = (r: Row): WellbeingReading => ({
  id: r.id,
  since: r.since,
  until: r.until,
  verdict: r.verdict,
  yes: JSON.parse(r.yes) as number[],
  messages: r.messages,
  error: r.error,
  createdAt: r.created_at,
});

export class Wellbeing {
  constructor(private readonly db: Database) {}

  /** The newest readings, newest first. */
  recent(limit = 8): WellbeingReading[] {
    return (this.db.query("SELECT * FROM wellbeing ORDER BY id DESC LIMIT $limit").all({ limit }) as Row[]).map(toReading);
  }

  latest(): WellbeingReading | null {
    return this.recent(1)[0] ?? null;
  }

  add(r: Omit<WellbeingReading, "id" | "createdAt">, now: Date): WellbeingReading {
    const result = this.db
      .query(
        `INSERT INTO wellbeing (since, until, verdict, yes, messages, error, created_at)
         VALUES ($since, $until, $verdict, $yes, $messages, $error, $now)`,
      )
      .run({ since: r.since, until: r.until, verdict: r.verdict, yes: JSON.stringify(r.yes), messages: r.messages, error: r.error, now: now.toISOString() });
    return toReading(this.db.query("SELECT * FROM wellbeing WHERE id = $id").get({ id: Number(result.lastInsertRowid) }) as Row);
  }
}

/**
 * Take this week's reading: their own OOC messages since `since`, read by
 * Jev with the fixed series. Kept either way (with an error when there's no
 * reading), so the page can say what happened. Never throws.
 */
export async function takeReading(store: Store, decider: Decider | null, since: Date, now: Date): Promise<WellbeingReading> {
  const words = wording("wellbeing");
  const messages = store
    .listChannels()
    .filter((c) => c.kind === "ooc")
    .flatMap((c) => store.getMessages(c.id))
    .filter((m) => m.author === "friend" && m.kind === "post" && m.createdAt >= since.toISOString() && m.createdAt <= now.toISOString())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const base = { since: since.toISOString(), until: now.toISOString(), messages: messages.length };
  if (messages.length === 0) return store.wellbeing.add({ ...base, verdict: null, yes: [], error: "No messages of their own this week." }, now);
  if (!decider?.enabled()) return store.wellbeing.add({ ...base, verdict: null, yes: [], error: "Jev is turned off." }, now);

  // The newest messages, within the same limit as a check.
  const lines: string[] = [];
  let length = 0;
  for (const m of [...messages].reverse()) {
    if (length + m.content.length > CHECK_LIMIT) break;
    lines.unshift(`- ${m.content}`);
    length += m.content.length;
  }
  try {
    const verdicts = await decider.askSeries(
      [words.state ?? "", ...lines].join("\n"),
      [{ id: "w", phrasings: [words["phrasing-1"] ?? "", words["phrasing-2"] ?? ""] }],
      store.getSettings().decisionConfidence,
      { purpose: "Wellbeing" },
    );
    const verdict = verdicts.get("w")!;
    return store.wellbeing.add({ ...base, verdict: verdict.verdict, yes: verdict.yes, error: null }, now);
  } catch (error) {
    return store.wellbeing.add({ ...base, verdict: null, yes: [], error: `Jev couldn't give a reading (${error instanceof Error ? error.message : error}).` }, now);
  }
}

/** A reading in words: "no (8% yes)", or why there isn't one. */
export function describeReading(r: WellbeingReading): string {
  if (!r.verdict) return `no reading (${r.error ?? "unknown"})`;
  const average = r.yes.length ? r.yes.reduce((a, b) => a + b, 0) / r.yes.length : 0;
  return `${r.verdict} (${Math.round(average * 100)}% yes, from ${r.messages} message${r.messages === 1 ? "" : "s"})`;
}

/** Recent weeks, oldest first, as a short trend: "12%, 9%, 30%". */
export function describeTrend(readings: WellbeingReading[]): string {
  const values = [...readings]
    .reverse()
    .map((r) => (r.verdict && r.yes.length ? `${Math.round((r.yes.reduce((a, b) => a + b, 0) / r.yes.length) * 100)}%` : "–"));
  return values.length ? values.join(", ") : "none yet";
}
