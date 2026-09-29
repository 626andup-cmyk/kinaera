/**
 * Small values the server keeps between runs, like when the next heartbeat
 * is due. One row per value in the `app_state` table, as text.
 */

import type { Database } from "bun:sqlite";

export class AppState {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.query("SELECT value FROM app_state WHERE key = $key").get({ key }) as { value: string } | null;
    return row?.value ?? null;
  }

  /** Save a value, or forget it (`null`). */
  set(key: string, value: string | null): void {
    if (value === null) this.db.query("DELETE FROM app_state WHERE key = $key").run({ key });
    else this.db.query("INSERT INTO app_state (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run({ key, value });
  }
}
