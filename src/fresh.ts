/**
 * A fresh start: `bun run fresh`.
 *
 * Sets every friend's memory aside and starts Kinaera over, with one new
 * friend (Arlo, whose first turn of their own is an orientation). Nothing
 * is deleted: the whole data folder is renamed to `data-old-<date>`, so you
 * can go back by stopping Kinaera and renaming it back.
 *
 * What carries over, because it's yours rather than theirs:
 *   - your connection profiles and roulettes (from your first friend);
 *   - your preferences (models, Jev, reaching out, the heartbeat, quiet
 *     hours, texting, the look), but not anything that's the friend
 *     themselves (name, identity, how they write);
 *   - your own themes.
 * Your API key is in `.env`, outside the data folder, so it's untouched.
 *
 * Stop Kinaera first: this refuses to run while it's running.
 */

import { Database } from "bun:sqlite";
import { cpSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { copyProfiles, FRIEND_KEYS } from "./hub.ts";
import { Store } from "./store.ts";
import type { Settings } from "./types.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const dataDir = config.dataDir;
  if (!existsSync(join(dataDir, "kinaera.db"))) {
    console.log(`There's no Kinaera data in ${dataDir} yet: just run "bun start".`);
    return;
  }

  // Refuse while the server is running: it has the database open.
  try {
    await fetch(`http://127.0.0.1:${config.port}/api/state`, { signal: AbortSignal.timeout(1500) });
    console.log("Kinaera is still running. Stop it first (Ctrl+C where it runs), then run this again.");
    process.exitCode = 1;
    return;
  } catch {
    // Not running: good.
  }

  // What's yours, from your first friend.
  const old = new Store(dataDir);
  const preferences = Object.fromEntries(
    Object.entries(old.getSettings()).filter(([key]) => !FRIEND_KEYS.includes(key as keyof Settings)),
  ) as Partial<Settings>;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const aside = `${dataDir}-old-${stamp}`;

  // Set the old folder aside (closed first, so nothing is half-written),
  // then start a new one, with your profiles and preferences.
  old.close();
  renameSync(dataDir, aside);
  const store = new Store(dataDir);
  const previous = new Database(join(aside, "kinaera.db"), { readonly: true });
  const profiles = previous.query("SELECT COUNT(*) AS n FROM profiles").get() as { n: number };
  copyProfiles(previous, store.db);
  previous.close();
  store.updateSettings(preferences);
  store.close();
  if (existsSync(join(aside, "themes"))) cpSync(join(aside, "themes"), join(dataDir, "themes"), { recursive: true });

  console.log("Done: Kinaera starts fresh, with one new friend (Arlo).");
  console.log(`Kept: your API key, ${profiles.n} connection profile${profiles.n === 1 ? "" : "s"} and roulettes, your preferences and your themes.`);
  console.log(`Everything else is set aside, not deleted, in ${aside}`);
  console.log("When you're sure you won't want it back, you can delete that folder. Now run: bun start");
}

await main();
