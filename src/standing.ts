/**
 * Standing permissions (KINAERA_REBUILD.md, section 6.10): things you can
 * pre-approve for a friend, on their page, so they don't have to ask each
 * time. Each grant and each revocation goes into the intervention log
 * (which they read), and their prompt lists what they're currently allowed.
 *
 *   delete-channels   delete their channels themselves (delete_channel),
 *                     instead of proposing it (never group channels, DMs,
 *                     or the practice channel)
 *   edit-notebook     edit your notebook entries directly where they'd
 *                     otherwise suggest (locked entries stay locked)
 *
 * Wording is in `defaults/permissions.md`.
 */

import type { Store } from "./store.ts";
import { wording } from "./wording.ts";
import { ValidationError } from "./errors.ts";

export const PERMISSIONS = ["delete-channels", "edit-notebook"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const KEY = "permissions";

/** What's granted right now. */
export function grants(store: Store): Record<Permission, boolean> {
  const saved = store.appState.get(KEY);
  const parsed = saved ? (JSON.parse(saved) as Partial<Record<Permission, boolean>>) : {};
  return Object.fromEntries(PERMISSIONS.map((p) => [p, parsed[p] === true])) as Record<Permission, boolean>;
}

export function granted(store: Store, permission: Permission): boolean {
  return grants(store)[permission];
}

/** You grant or take back a permission. It's logged where they can read it. */
export function setGrant(store: Store, permission: string, on: boolean): Record<Permission, boolean> {
  if (!(PERMISSIONS as readonly string[]).includes(permission)) throw new ValidationError(`There's no permission called "${permission}".`);
  const current = grants(store);
  const key = permission as Permission;
  if (current[key] === on) return current;
  current[key] = on;
  store.appState.set(KEY, JSON.stringify(current));
  const what = (wording("permissions")[key] ?? key).replace(/\.$/, "");
  store.interventions.add({ kind: "settings", summary: on ? `The user gave you standing permission to: ${what}.` : `The user took back your standing permission to: ${what}.` });
  return current;
}

/** Their prompt's list of what they're allowed, or null if nothing. */
export function describeGrants(store: Store): string | null {
  const words = wording("permissions");
  const lines = PERMISSIONS.filter((p) => granted(store, p)).map((p) => `- ${words[`${p}-friend`] ?? p}`);
  return lines.length ? [words.heading ?? "", ...lines].join("\n") : null;
}

/** Each permission as the friend page shows it: its key, what it lets them do, and whether it's on. */
export function permissionViews(store: Store): { key: Permission; description: string; granted: boolean }[] {
  const words = wording("permissions");
  const current = grants(store);
  return PERMISSIONS.map((key) => ({ key, description: words[key] ?? key, granted: current[key] }));
}
