/**
 * Prompt wording that lives in `defaults/`, where you can read and edit it,
 * instead of being buried in code.
 *
 * A wording file is Markdown with one `## name` section per piece of
 * text. Anything before the first section is a note for people, and isn't
 * sent. For example, `defaults/standing.md`:
 *
 *   ## history
 *
 *   The user sometimes edits or regenerates messages...
 *
 * gives `wording("standing").history`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");

/** Split a wording file's text into its sections, by name. */
export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let name: string | null = null;
  let lines: string[] = [];
  const finish = () => {
    if (name !== null) sections[name] = lines.join("\n").trim();
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      finish();
      name = heading[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  finish();
  return sections;
}

/**
 * The sections of `defaults/<file>.md`. Read fresh each time (they're
 * small), so an edit shows up on the next turn without a restart.
 */
export function wording(file: string): Record<string, string> {
  const path = join(DEFAULTS_DIR, `${file}.md`);
  return existsSync(path) ? parseSections(readFileSync(path, "utf8")) : {};
}
