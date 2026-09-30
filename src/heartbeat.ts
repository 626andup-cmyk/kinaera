/**
 * The heartbeat: a timer that now and then gives your friend a free moment,
 * even with the app closed.
 *
 * Every `heartbeatHours` (each gap varies by ±20%, so it never feels like
 * clockwork), the server checks in on its own. If the hard rules pass
 * (chattiness, quiet hours, the cooldown, no double texts, not
 * mid-conversation: see src/wakeups.ts), your friend gets a turn of their
 * own ("heartbeat"). What they do with it is up to them: text you, act with
 * their tools, or nothing at all. Most beats stop at the rules, costing
 * nothing.
 *
 * (Aettica's heartbeat had the friend come up with ideas and Jev grade
 * them first. Kinaera leaves that judgment to your friend.)
 *
 * A message on a heartbeat (or any wake-up) sends a phone notification
 * when the app isn't on screen (src/notify.ts).
 */

import type { Store } from "./store.ts";
import type { WakeResult, Wakeups } from "./wakeups.ts";

/** Where the next beat's time is kept (app_state). */
const NEXT_KEY = "heartbeat.next";

/** What a beat did. */
export interface BeatResult {
  outcome: "off" | "not-due" | "blocked" | "woke" | "failed";
  detail: string;
  wake?: WakeResult;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private beating = false;

  constructor(
    private readonly store: Store,
    private readonly wakeups: Wakeups,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  /** Check every `checkMs` whether a beat is due (every minute, so short heartbeats keep time). */
  start(checkMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), checkMs);
    // Right away too: schedules the first beat (or beats, if one was due while the server was off).
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** When the next beat is due, or `null` if the heartbeat is off. */
  nextAt(): Date | null {
    if (this.store.getSettings().heartbeatHours <= 0) return null;
    const value = this.store.appState.get(NEXT_KEY);
    return value ? new Date(value) : null;
  }

  /** Forget the next beat's time, so it's counted again from now (the pace changed). */
  reset(): void {
    this.store.appState.set(NEXT_KEY, null);
  }

  /** Set the next beat's time: `heartbeatHours` from now, ±20%. */
  private schedule(): Date {
    const hours = this.store.getSettings().heartbeatHours * (0.8 + 0.4 * this.random());
    const next = new Date(this.now().getTime() + hours * 3_600_000);
    this.store.appState.set(NEXT_KEY, next.toISOString());
    return next;
  }

  /**
   * Beat if it's time (or `force`: Settings → "Beat now"). Never throws.
   */
  async tick(force = false): Promise<BeatResult> {
    if (this.beating) return { outcome: "not-due", detail: "A beat is already running." };
    const settings = this.store.getSettings();
    if (settings.heartbeatHours <= 0 && !force) return { outcome: "off", detail: "The heartbeat is off." };
    if (!force) {
      const next = this.nextAt();
      // The first check after turning it on only sets the time.
      if (!next) {
        this.schedule();
        return { outcome: "not-due", detail: "First beat scheduled." };
      }
      if (this.now() < next) return { outcome: "not-due", detail: `Next beat at ${next.toISOString()}.` };
    }
    this.beating = true;
    try {
      if (settings.heartbeatHours > 0) this.schedule();
      return await this.beat();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[heartbeat] failed: ${message}`);
      return { outcome: "failed", detail: message };
    } finally {
      this.beating = false;
    }
  }

  /** The rules, then a free moment for your friend. */
  private async beat(): Promise<BeatResult> {
    const blocked = this.wakeups.blocked("heartbeat");
    if (blocked) {
      console.log(`[heartbeat] ${blocked}`);
      return { outcome: "blocked", detail: blocked };
    }
    const wake = await this.wakeups.event("heartbeat");
    return { outcome: "woke", detail: `${wake.outcome ?? "skipped"}: ${wake.detail}`, wake };
  }
}
