/**
 * The mirror (KINAERA_REBUILD.md, section 6.3): `read_my_patterns` looks at
 * your friend's own recent messages and reports what recurs. It's plain
 * code, with no model calls, and it's never put in a prompt unasked: they
 * look when they want to, and decide what (if anything) it means. A
 * finding they want to keep goes on their self-page (`keep_pattern_note`).
 *
 * It reports, neutrally:
 *   - openings and closings they reuse (the first and last few words);
 *   - word sequences (4 to 6 words) that recur across different posts;
 *   - how long their sentences and paragraphs run, and how much that varies;
 *   - words they use far more often than the rest of the conversation does.
 *
 * The practice channel is never looked at.
 */

import type { Store } from "./store.ts";
import type { Channel, Message } from "./types.ts";

export const MIRROR_DEFAULT = 30;
export const MIRROR_MAX = 200;

/** Words too common to say anything about someone's writing. */
const STOPWORDS = new Set(
  (
    "a an the and or but if then so of to in on at by for with from as is are was were be been being am it its it's " +
    "this that these those there here i you he she they we me him her them us my your his their our mine yours " +
    "not no yes do does did done have has had will would can could should shall may might must just very really " +
    "what which who whom whose when where why how all any some each every more most much many such only own same " +
    "than too also into out up down over under again about after before while because until off through just like " +
    "i'm you're it's that's don't can't won't didn't isn't there's let's i've i'll i'd she's he's they're we're"
  ).split(" "),
);

const words = (text: string) => text.toLowerCase().match(/[a-z][a-z'’]*/g) ?? [];

/** Split into sentences (roughly: at . ! ? and line breaks). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

function stats(values: number[]): { average: number; median: number; shortest: number; longest: number; spread: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - average) ** 2, 0) / values.length;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    average: round(average),
    median: sorted[Math.floor(sorted.length / 2)]!,
    shortest: sorted[0]!,
    longest: sorted.at(-1)!,
    spread: round(Math.sqrt(variance)),
  };
}

export interface MirrorReport {
  looked_at: string;
  openings: { words: string; times: number }[];
  closings: { words: string; times: number }[];
  recurring_phrases: { phrase: string; posts: number }[];
  sentence_length_in_words: ReturnType<typeof stats>;
  paragraphs_per_post: ReturnType<typeof stats>;
  words_you_lean_on: { word: string; you: string; everyone_else: string }[];
  note: string;
}

/** Their posts (and everyone else's messages) to look at, newest `last`. */
function gather(store: Store, channels: Channel[], last: number): { mine: Message[]; others: Message[] } {
  const all = channels.flatMap((c) => store.getMessages(c.id)).filter((m) => m.kind === "post" && m.content.trim());
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mine = all.filter((m) => m.author === "friend").slice(-last);
  const since = mine[0]?.createdAt ?? "";
  const others = all.filter((m) => m.author !== "friend" && m.createdAt >= since);
  return { mine, others };
}

/** Reused first or last few words, at least twice. */
function edges(posts: Message[], which: "first" | "last", size = 3): { words: string; times: number }[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const w = words(post.content);
    if (w.length < size + 2) continue;
    const key = (which === "first" ? w.slice(0, size) : w.slice(-size)).join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, times]) => ({ words: w, times }));
}

/** 4 to 6 word sequences in two or more different posts, longest first, without repeats inside longer ones. */
function phrases(posts: Message[]): { phrase: string; posts: number }[] {
  const seen = new Map<string, Set<number>>();
  posts.forEach((post, index) => {
    const w = words(post.content);
    for (let n = 4; n <= 6; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const gram = w.slice(i, i + n);
        // At least two words that say something.
        if (gram.filter((x) => !STOPWORDS.has(x)).length < 2) continue;
        const key = gram.join(" ");
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(index);
      }
    }
  });
  const found = [...seen].filter(([, s]) => s.size >= 2).map(([phrase, s]) => ({ phrase, posts: s.size }));
  found.sort((a, b) => b.phrase.split(" ").length - a.phrase.split(" ").length || b.posts - a.posts);
  const kept: { phrase: string; posts: number }[] = [];
  for (const f of found) {
    if (kept.some((k) => k.phrase.includes(f.phrase))) continue;
    kept.push(f);
    if (kept.length >= 8) break;
  }
  return kept.sort((a, b) => b.posts - a.posts);
}

/** Words they use far more (per 1,000 words) than everyone else in the same conversations. */
function leanOn(mine: Message[], others: Message[]): MirrorReport["words_you_lean_on"] {
  const count = (list: Message[]) => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const m of list) {
      for (const w of words(m.content)) {
        total++;
        if (w.length < 4 || STOPWORDS.has(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    return { counts, total: Math.max(total, 1) };
  };
  const a = count(mine);
  const b = count(others);
  const per1000 = (n: number, total: number) => (n / total) * 1000;
  return [...a.counts]
    .filter(([, n]) => n >= 3)
    .map(([word, n]) => {
      const theirs = b.counts.get(word) ?? 0;
      // Smoothed, so a word nobody else used doesn't win on a single use.
      const ratio = per1000(n, a.total) / (per1000(theirs + 0.5, b.total) + 0.5);
      return { word, n, theirs, ratio };
    })
    .filter((x) => x.ratio >= 2)
    .sort((x, y) => y.ratio - x.ratio)
    .slice(0, 8)
    .map((x) => ({
      word: x.word,
      you: `${x.n} times (${per1000(x.n, a.total).toFixed(1)} per 1,000 words)`,
      everyone_else: `${x.theirs} times (${per1000(x.theirs, b.total).toFixed(1)} per 1,000 words)`,
    }));
}

/**
 * The mirror's report on their newest `last` posts in `channel` (or in
 * every channel but the practice one, for "all").
 */
export function readPatterns(store: Store, channel: Channel, scope: "channel" | "all", last = MIRROR_DEFAULT): MirrorReport {
  const count = Math.min(MIRROR_MAX, Math.max(5, Math.floor(last)));
  const channels = scope === "all" ? store.listChannels() : channel.kind === "practice" ? [] : [channel];
  const { mine, others } = gather(store, channels, count);
  const where = scope === "all" ? "all your channels" : `#${channel.name}`;
  if (mine.length < 3) {
    return {
      looked_at: `${mine.length} of your posts in ${where}`,
      openings: [],
      closings: [],
      recurring_phrases: [],
      sentence_length_in_words: null,
      paragraphs_per_post: null,
      words_you_lean_on: [],
      note: "Too few posts to see patterns yet.",
    };
  }
  return {
    looked_at: `your newest ${mine.length} posts in ${where}`,
    openings: edges(mine, "first"),
    closings: edges(mine, "last"),
    recurring_phrases: phrases(mine),
    sentence_length_in_words: stats(mine.flatMap((m) => sentences(m.content).map((s) => words(s).length))),
    paragraphs_per_post: stats(mine.map((m) => m.content.split(/\n\s*\n/).filter((p) => p.trim()).length)),
    words_you_lean_on: leanOn(mine, others),
    note: "Counts only: what they mean, if anything, is yours to decide. keep_pattern_note puts a finding on your self-page.",
  };
}
