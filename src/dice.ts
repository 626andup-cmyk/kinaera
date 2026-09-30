/**
 * Dice (KINAERA_REBUILD.md, section 7): `/roll 2d6+3` in the box you write
 * in, and `roll_dice` for your friend. The rolls are real (random here, on
 * the server), and what's saved is the result, so nobody (you, your friend,
 * or a model filling in a number) can make one up.
 *
 * Notation: dice terms like `d20`, `2d6`, `4d6kh3` (keep the highest 3) or
 * `2d20kl1` (keep the lowest), and plain numbers, joined with + and -:
 * `1d20+5`, `2d6+1d4-1`. At most 100 dice, of up to 1,000 sides.
 */

import { ValidationError } from "./errors.ts";

export interface DiceRoll {
  /** The notation, tidied: "2d6+3". */
  notation: string;
  total: number;
  /** "2d6 [4, 2] + 3 = 9", or with dropped dice in parentheses. */
  text: string;
}

const MAX_DICE = 100;
const MAX_SIDES = 1000;

/** Roll dice from notation like "2d6+3". Throws `ValidationError` for anything else. */
export function roll(notation: string, random: () => number = Math.random): DiceRoll {
  const clean = notation.toLowerCase().replace(/\s+/g, "");
  if (!clean || clean.length > 60) throw new ValidationError('Roll something like "d20", "2d6+3" or "4d6kh3".');
  const terms = clean.match(/[+-]?[^+-]+/g) ?? [];
  let total = 0;
  let dice = 0;
  const shown: string[] = [];
  for (const [index, raw] of terms.entries()) {
    const sign = raw.startsWith("-") ? -1 : 1;
    const term = raw.replace(/^[+-]/, "");
    const op = index === 0 ? (sign < 0 ? "-" : "") : sign < 0 ? " - " : " + ";
    const number = term.match(/^\d+$/);
    if (number) {
      total += sign * Number(term);
      shown.push(`${op}${term}`);
      continue;
    }
    const die = term.match(/^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/);
    if (!die) throw new ValidationError(`Couldn't read "${term}". Roll something like "d20", "2d6+3" or "4d6kh3".`);
    const count = die[1] ? Number(die[1]) : 1;
    const sides = Number(die[2]);
    if (count < 1 || sides < 2) throw new ValidationError("Dice need at least one die and two sides.");
    dice += count;
    if (dice > MAX_DICE || sides > MAX_SIDES) throw new ValidationError(`That's too many dice (at most ${MAX_DICE}, of up to ${MAX_SIDES} sides).`);
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides));
    // Keep the highest or lowest few; the rest are shown struck out (in parentheses).
    let kept = rolls.map((value, i) => ({ value, i }));
    if (die[3]) {
      const keep = Math.min(count, Number(die[4]));
      const sorted = [...kept].sort((a, b) => (die[3] === "kh" ? b.value - a.value : a.value - b.value));
      const keepIds = new Set(sorted.slice(0, keep).map((k) => k.i));
      kept = kept.filter((k) => keepIds.has(k.i));
    }
    const keptIds = new Set(kept.map((k) => k.i));
    total += sign * kept.reduce((sum, k) => sum + k.value, 0);
    shown.push(`${op}${term} [${rolls.map((value, i) => (keptIds.has(i) ? String(value) : `(${value})`)).join(", ")}]`);
  }
  if (terms.length === 0 || dice === 0) throw new ValidationError('Roll some dice, like "d20" or "2d6+3".');
  const tidy = terms.map((t, i) => (i === 0 ? t.replace(/^\+/, "") : t)).join("");
  return { notation: tidy, total, text: `${shown.join("")} = ${total}` };
}

/**
 * Your message starting with `/roll`: the roll, written out, in its place
 * (anything after the notation is kept, as what the roll is for). Anything
 * else comes back unchanged.
 */
export function rollCommand(content: string, random: () => number = Math.random): string {
  const match = content.trim().match(/^\/roll\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (!match) return content;
  const result = roll(match[1]!, random);
  return `🎲 ${result.text}${match[2]?.trim() ? ` (${match[2].trim()})` : ""}`;
}
