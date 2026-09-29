/**
 * `check`: your friend's sonar (see KINAERA_REBUILD.md, section 5.4).
 *
 * Your friend asks whether something is true or present in their world
 * ("Has Ilse's brother been named anywhere?"), in two phrasings, and gets
 * back both the evidence and Jev's reading of it. It works in three steps:
 *
 *   1. **Search.** Full-text search (FTS5, as the reference library does)
 *      over the sources they chose: by default the notebook, this channel's
 *      messages and the summaries; the library if they ask. The best
 *      passages from each source are taken in turn, up to `CHECK_LIMIT`
 *      characters in all. Entries hidden from your friend are never
 *      searched: the notebook is read as they see it.
 *   2. **Ask Jev.** The passages are Jev's state, and the two phrasings a
 *      series (src/jev.ts). By the `agree` rule, it's a confident yes only
 *      if both phrasings say so (and a confident no only if both do).
 *   3. **Return.** The reading (`yes`, `no` or `unsure`) with each
 *      phrasing's probability, and the passages themselves, each with where
 *      it came from, so your friend can read the evidence, which is the most
 *      reliable part. "Nothing found" is an ordinary, useful answer.
 *
 * Jev decides nothing here. It reads the evidence it's given, and your
 * friend decides what that means.
 *
 * ## The check log
 *
 * Every check is written to the check log (`CheckLog`): the question, the
 * sources, the reading and the passages found. Passages from private
 * places (the journal and drafts, from stage 4) are `private`: the log
 * records that they were found, never their text.
 */

import { Database } from "bun:sqlite";
import type { Decider } from "./jev.ts";
import { ftsQuery } from "./library.ts";
import type { Store } from "./store.ts";
import type { Channel } from "./types.ts";

/** Longest material one check reads (characters). Moved here from Aettica's judge.ts. */
export const CHECK_LIMIT = 30_000;

/** Longest single passage (characters): a very long post is cut. */
const PASSAGE_LIMIT = 6_000;

/** At most this many passages from each source. */
const PER_SOURCE = 8;

/** The places a check can search. */
export const CHECK_SOURCES = ["notebook", "channel", "summaries", "library"] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

/** Searched when your friend doesn't say. */
export const DEFAULT_SOURCES: CheckSource[] = ["notebook", "channel", "summaries"];

/** One passage found, and where it came from. */
export interface Evidence {
  source: CheckSource;
  /** Where exactly: "notebook: Ilse Marrow (character)", "#story, you, 2 hours ago"... */
  where: string;
  text: string;
  /** From a private place: never written to any log. */
  private?: boolean;
}

export interface CheckInput {
  question: string;
  rephrased: string;
  sources?: CheckSource[];
}

export interface CheckResult {
  /** Jev's reading, or `null` when there's none (nothing found, or Jev couldn't answer). */
  verdict: "yes" | "no" | "unsure" | null;
  /** Each phrasing's p(yes), when there's a reading. */
  yes: number[];
  found: Evidence[];
  sources: CheckSource[];
  /** Why there's no reading, when there isn't. */
  error: string | null;
  answeredBy: "jev" | "fallback" | null;
}

// ------------------------------------------------------------ searching

/** "5 minutes ago", "2 days ago". */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const cut = (text: string) => (text.length > PASSAGE_LIMIT ? `${text.slice(0, PASSAGE_LIMIT)}…` : text);

/** Everything a source could offer, before searching. */
function candidates(store: Store, channel: Channel, source: Exclude<CheckSource, "library">): Evidence[] {
  if (source === "notebook") {
    return store.notebook.listEntries("friend").map((entry) => ({
      source,
      where: `notebook: ${entry.name} (${entry.kind})`,
      text: cut(
        [
          entry.name,
          ...entry.fields.filter((f) => f.value.trim()).map((f) => `${f.label}: ${f.value.trim()}`),
          entry.systemPrompt.trim() ? `Notes: ${entry.systemPrompt.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    }));
  }
  if (source === "channel") {
    return store
      .getMessages(channel.id)
      .filter((m) => m.kind === "post" && m.content.trim())
      .map((m) => {
        const who = m.author === "user" ? "the user" : "you";
        const voices = m.characters.length ? ` as ${m.characters.join(" & ")}` : "";
        return { source, where: `#${channel.name}, ${who}${voices}, ${ago(m.createdAt)}`, text: cut(m.content.trim()) };
      });
  }
  const kinds = { story: "the story so far", scene: "a scene's summary", current: "earlier in the scene", digest: "the overview" } as const;
  return store.listChannels().flatMap((c) =>
    store.summaries
      .all(c.id)
      .filter((s) => s.content.trim())
      .map((s) => ({ source, where: `#${c.name}: ${kinds[s.kind]}`, text: cut(s.content.trim()) })),
  );
}

/** Search a list of passages with FTS5 (in a throwaway in-memory index), best first. */
function searchPassages(passages: Evidence[], match: string, limit: number): Evidence[] {
  if (passages.length === 0) return [];
  const db = new Database(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5 (text, tokenize = 'porter unicode61')");
    const insert = db.query("INSERT INTO t (rowid, text) VALUES (?, ?)");
    db.transaction(() => passages.forEach((p, i) => insert.run(i + 1, `${p.where}\n${p.text}`)))();
    const rows = db.query("SELECT rowid FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT ?").all(match, limit) as { rowid: number }[];
    return rows.map((r) => passages[r.rowid - 1]!);
  } finally {
    db.close();
  }
}

/**
 * Step 1: the best passages from each source, taken in turn (the best of
 * each, then the second best of each...), up to `CHECK_LIMIT` characters.
 */
export function gatherEvidence(store: Store, channel: Channel, input: CheckInput): Evidence[] {
  const match = ftsQuery(`${input.question} ${input.rephrased}`);
  if (!match) return [];
  const sources = input.sources?.length ? input.sources : DEFAULT_SOURCES;
  const lists: Evidence[][] = sources.map((source) => {
    if (source === "library") {
      const docs = store.library.forChannel(channel);
      return store.library.search(`${input.question} ${input.rephrased}`, docs.map((d) => d.id), PER_SOURCE).flatMap((hit) => {
        const passage = store.library.passages(hit.docId, hit.seq, 1)[0];
        return passage ? [{ source, where: `library: "${hit.title}", passage ${hit.seq}`, text: cut(passage.content) }] : [];
      });
    }
    return searchPassages(candidates(store, channel, source), match, PER_SOURCE);
  });
  const found: Evidence[] = [];
  let total = 0;
  for (let rank = 0; rank < PER_SOURCE; rank++) {
    for (const list of lists) {
      const passage = list[rank];
      if (!passage || total + passage.text.length > CHECK_LIMIT) continue;
      found.push(passage);
      total += passage.text.length;
    }
  }
  return found;
}

// ---------------------------------------------------------------- Jev

/** What Jev reads: the passages, numbered, each with where it's from. */
export function checkState(found: Evidence[]): string {
  return [
    "Passages found in a story's notes, messages and summaries, each with where it's from:",
    ...found.map((p, i) => `[${i + 1}] (${p.where})\n${p.text}`),
  ].join("\n\n");
}

/** Steps 1 to 3, and the log. Never throws for a Jev failure: that's a result without a reading. */
export async function runCheck(store: Store, channel: Channel, decider: Decider | null, input: CheckInput): Promise<CheckResult> {
  const started = Date.now();
  const sources = input.sources?.length ? input.sources : DEFAULT_SOURCES;
  const found = gatherEvidence(store, channel, input);
  const result: CheckResult = { verdict: null, yes: [], found, sources, error: null, answeredBy: null };
  if (found.length > 0) {
    if (!decider?.enabled()) {
      result.error = "Jev is turned off, so there's no reading; the passages are below.";
    } else {
      try {
        const verdicts = await decider.askSeries(
          checkState(found),
          [{ id: "q", phrasings: [input.question, input.rephrased] }],
          store.getSettings().decisionConfidence,
          { purpose: "Check" },
        );
        const verdict = verdicts.get("q")!;
        result.verdict = verdict.verdict;
        result.yes = verdict.yes;
        result.answeredBy = decider.lastReport?.answeredBy ?? "jev";
      } catch (error) {
        result.error = `Jev couldn't give a reading (${error instanceof Error ? error.message : error}); the passages are below.`;
      }
    }
  }
  store.checkLog.add({ channelId: channel.id, question: input.question, rephrased: input.rephrased, result, durationMs: Date.now() - started });
  return result;
}

// ------------------------------------------------------------ the log

/** One check in the log. Private passages have no text. */
export interface CheckLogEntry {
  id: string;
  at: string;
  channelId: string | null;
  question: string;
  rephrased: string;
  sources: CheckSource[];
  verdict: CheckResult["verdict"];
  yes: number[];
  found: { source: CheckSource; where: string; text: string | null }[];
  answeredBy: CheckResult["answeredBy"];
  error: string | null;
  durationMs: number;
}

interface CheckLogRow {
  id: string;
  at: string;
  channel_id: string | null;
  question: string;
  rephrased: string;
  sources: string;
  verdict: CheckResult["verdict"];
  yes: string;
  found: string;
  answered_by: CheckResult["answeredBy"];
  error: string | null;
  duration_ms: number;
}

/** How many checks are kept (the oldest go first). */
export const CHECK_LOG_SIZE = 1000;

export class CheckLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(entry: { channelId: string | null; question: string; rephrased: string; result: CheckResult; durationMs: number }): void {
    const { result } = entry;
    // Private passages: where they're from, never what they say.
    const found = result.found.map((p) => ({ source: p.source, where: p.where, text: p.private ? null : p.text }));
    this.db
      .query(
        `INSERT INTO check_log (id, at, channel_id, question, rephrased, sources, verdict, yes, found, answered_by, error, duration_ms)
         VALUES ($id, $at, $channelId, $question, $rephrased, $sources, $verdict, $yes, $found, $answeredBy, $error, $durationMs)`,
      )
      .run({
        id: crypto.randomUUID(),
        at: this.now().toISOString(),
        channelId: entry.channelId,
        question: entry.question,
        rephrased: entry.rephrased,
        sources: JSON.stringify(result.sources),
        verdict: result.verdict,
        yes: JSON.stringify(result.yes),
        found: JSON.stringify(found),
        answeredBy: result.answeredBy,
        error: result.error,
        durationMs: Math.round(entry.durationMs),
      });
    this.db.query("DELETE FROM check_log WHERE id NOT IN (SELECT id FROM check_log ORDER BY at DESC, rowid DESC LIMIT $n)").run({ n: CHECK_LOG_SIZE });
  }

  /** The newest checks, newest first. */
  recent(limit = 100): CheckLogEntry[] {
    const rows = this.db.query("SELECT * FROM check_log ORDER BY at DESC, rowid DESC LIMIT $limit").all({ limit }) as CheckLogRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      channelId: r.channel_id,
      question: r.question,
      rephrased: r.rephrased,
      sources: JSON.parse(r.sources),
      verdict: r.verdict,
      yes: JSON.parse(r.yes),
      found: JSON.parse(r.found),
      answeredBy: r.answered_by,
      error: r.error,
      durationMs: r.duration_ms,
    }));
  }
}
