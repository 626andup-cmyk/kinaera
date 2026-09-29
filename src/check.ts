/**
 * `check`: your friend's sonar (see KINAERA_REBUILD.md, section 5.4).
 *
 * Your friend asks whether something is true or present in their world
 * ("Has Ilse's brother been named anywhere?"). The search finds the
 * passages that might answer it, Jev reads them, and your friend gets back
 * both: Jev's reading and the evidence itself.
 *
 * For now this file only holds the limit on how much material Jev reads in
 * one go. The tool itself is built in stage 3.
 */

/** Longest material one check reads (characters). Moved here from Aettica's judge.ts. */
export const CHECK_LIMIT = 30_000;
