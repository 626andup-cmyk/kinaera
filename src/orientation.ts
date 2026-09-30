/**
 * Orientation and the weekly look back: turns your friend takes in their
 * own practice channel (KINAERA_REBUILD.md, sections 6.13 and 6.4).
 *
 * **Orientation** is an invitation to try their tools and find out what
 * suits them. Nothing in it can be passed or failed, and every part can be
 * skipped. It needs no new mechanism: a wake-up with the reason
 * "orientation", a guide from `defaults/orientation.md` (only the steps
 * whose tools they have), in the practice channel. It happens:
 *
 *   - when they're made (their first wake-up is their orientation);
 *   - when they ask for one (`start_orientation`, with an optional focus);
 *   - when you invite them (the friend page): they're told on their next
 *     turn, and it counts as a no if they don't start one then;
 *   - offered (not run) when a new profile joins a roulette: they're told
 *     on their next turn that a new model may be writing as them.
 *
 * **The look back**, once a week: a quiet turn with what they wrote in their
 * journal that week, to keep, rewrite or let go of entries.
 *
 * Both are queued here and started by a timer (`Rhythms`, every minute), through the hard
 * rules in src/wakeups.ts: quiet hours and the cooldown apply, but not "no
 * double texts" or "never mid-conversation", since they message no one.
 */

import type { Store } from "./store.ts";
import type { WakeResult, Wakeups } from "./wakeups.ts";
import { wording } from "./wording.ts";

/** Where things are kept between runs (app_state). */
const PENDING = "orientation.pending";
const INVITED = "orientation.invited";
const LOOKBACK_LAST = "lookback.last";
/** Why the waiting orientation hasn't started yet (a hard rule), for the friend page. */
const HELD = "orientation.held";

/** How often the look back comes round. */
export const LOOKBACK_DAYS = 7;

/** Queue an orientation (when they're made, or when they ask). */
export function queueOrientation(store: Store, focus?: string): void {
  store.appState.set(PENDING, JSON.stringify({ focus: focus?.trim().slice(0, 200) || null, at: new Date().toISOString() }));
}

/** Why the waiting orientation hasn't started yet, if a rule is holding it. */
export function orientationHeld(store: Store): string | null {
  return pendingOrientation(store) ? store.appState.get(HELD) : null;
}

/** The orientation waiting to start, if any. */
export function pendingOrientation(store: Store): { focus: string | null; at: string } | null {
  const value = store.appState.get(PENDING);
  return value ? (JSON.parse(value) as { focus: string | null; at: string }) : null;
}

/** You invite your friend to an orientation: they're told on their next turn. */
export function inviteToOrientation(store: Store): void {
  store.appState.set(INVITED, new Date().toISOString());
  store.interventions.add({ kind: "settings", summary: "The user invited you to an orientation." });
}

/** Whether an invitation is waiting for your friend's next turn. */
export function invited(store: Store): boolean {
  return store.appState.get(INVITED) !== null;
}

/**
 * After a turn that carried the invitation: it's answered. Starting an
 * orientation (queued) is a yes; anything else is a no, for now.
 */
export function settleInvitation(store: Store): void {
  if (!invited(store)) return;
  store.appState.set(INVITED, null);
  store.appState.set("orientation.invite-result", pendingOrientation(store) ? "accepted" : "declined");
}

/** Where a profile new to a roulette is noted, until your friend's next turn. */
export const NEW_PROFILE = "orientation.new-profile";

/**
 * A profile joined a roulette: your friend is told on their next turn that
 * a new model may be writing as them, and offered an orientation (not run).
 */
export function noteNewProfiles(store: Store, names: string[]): void {
  if (names.length === 0) return;
  const earlier = store.appState.get(NEW_PROFILE);
  const all = new Set([...(earlier ? earlier.split(", ") : []), ...names]);
  store.appState.set(NEW_PROFILE, [...all].join(", "));
}

/**
 * The orientation guide, put together from `defaults/orientation.md`: only
 * the steps whose tools your friend has this turn.
 */
export function orientationGuide(tools: string[], focus: string | null): string {
  const words = wording("orientation");
  const has = (name: string) => tools.includes(name);
  const steps = [
    has("check") ? words["orientation-check"] : "",
    has("edit_my_message") ? words["orientation-edit"] : "",
    has("read_prompt_manifest") ? words["orientation-manifest"] : "",
    has("consult") ? words["orientation-consult"] : "",
    has("ask") ? words["orientation-ask"] : "",
  ].filter(Boolean);
  return [
    words["orientation-intro"] ?? "",
    focus ? (words["orientation-focus"] ?? "").replace("{focus}", focus) : "",
    steps.map((s) => `- ${s}`).join("\n"),
    words["orientation-write"] ?? "",
    words["orientation-close"] ?? "",
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

/** Queues the look back and runs what's due, now and then. */
export class Rhythms {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly wakeups: Wakeups,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(checkMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), checkMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start what's due: a queued orientation, then the look back. Never throws. */
  async tick(): Promise<WakeResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const orientation = pendingOrientation(this.store);
      if (orientation) {
        const result = await this.wakeups.event("orientation", { focus: orientation.focus ?? undefined });
        // Done (or tried and failed on the model's side): no longer waiting.
        // Stopped by a rule (quiet hours, the cooldown): it waits. (One
        // asked for during it is kept for later.)
        if (result.outcome !== null && pendingOrientation(this.store)?.at === orientation.at) this.store.appState.set(PENDING, null);
        this.store.appState.set(HELD, result.outcome === null ? result.detail : null);
        return result;
      }
      // The first look back is a week after the journal starts being kept here.
      const last = this.store.appState.get(LOOKBACK_LAST);
      if (!last) {
        this.store.appState.set(LOOKBACK_LAST, this.now().toISOString());
        return null;
      }
      if (this.now().getTime() - new Date(last).getTime() < LOOKBACK_DAYS * 86_400_000) return null;
      const result = await this.wakeups.event("lookback", { since: last });
      if (result.outcome !== null) this.store.appState.set(LOOKBACK_LAST, this.now().toISOString());
      return result;
    } catch (error) {
      console.warn(`[rhythms] ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
