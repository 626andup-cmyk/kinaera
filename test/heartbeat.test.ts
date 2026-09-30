/**
 * Tests for the heartbeat (src/heartbeat.ts) and notifications
 * (src/notify.ts).
 *
 * Your friend's replies come from the fake nanoGPT's `replies`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Heartbeat } from "../src/heartbeat.ts";
import { Presence, PRESENCE_TIMEOUT_MS, type Notification } from "../src/notify.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;
let now: Date;
let wakeups: Wakeups;
let heartbeat: Heartbeat;
let notified: Notification[];

const HOUR = 3_600_000;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  notified = [];
  app = createApp(testConfig(dir.path, fake.baseUrl, { notifier: { available: () => true, notify: (n) => notified.push(n) } }));
  ooc = app.store.listChannels()[1]!;
  now = new Date();
  now.setHours(12, 0, 0, 0);
  wakeups = new Wakeups(app.store, app.friend, true, () => now);
  wakeups.onPosted = app.wakeups.onPosted; // notifications, as the server sets them up
  heartbeat = new Heartbeat(app.store, wakeups, () => now, () => 0.5);
  settings({ heartbeatHours: 6 });
});

afterEach(() => {
  heartbeat.stop();
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

function settings(update: Record<string, unknown>) {
  app.store.updateSettings(validateSettings(update));
}

function youWrote(hoursAgo: number, content = "night!") {
  app.store.addMessage({ channelId: ooc.id, author: "user", content, createdAt: new Date(now.getTime() - hoursAgo * HOUR).toISOString() });
}

describe("pieces", () => {
  test("presence times out", () => {
    let t = 0;
    const presence = new Presence(() => t);
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    expect(presence.isVisible()).toBe(true);
    t = PRESENCE_TIMEOUT_MS + 1;
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    presence.set(false);
    expect(presence.isVisible()).toBe(false);
  });
});

describe("the heartbeat", () => {
  test("off, or not yet due: nothing", async () => {
    settings({ heartbeatHours: 0 });
    expect((await heartbeat.tick()).outcome).toBe("off");
    settings({ heartbeatHours: 6 });
    // The first check only schedules: 6 hours × (0.8 + 0.4 × 0.5) = 6 hours.
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(heartbeat.nextAt()!.getTime()).toBe(now.getTime() + 6 * HOUR);
    now = new Date(now.getTime() + 5 * HOUR);
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);
  });

  test("the hard rules come first, costing nothing", async () => {
    settings({ quietStart: 10, quietEnd: 14 });
    youWrote(8);
    const beat = await heartbeat.tick(true);
    expect(beat).toMatchObject({ outcome: "blocked", detail: "It's quiet hours." });
    expect(fake.requests).toHaveLength(0);
  });

  test("a free moment: your friend writes, with no Jev in the way", async () => {
    youWrote(8);
    fake.replies.push({ content: "Random thought: what if Ilse's lighthouse was the vault in a heist?" });
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("woke");
    expect(beat.wake).toMatchObject({ outcome: "posted", reason: "heartbeat" });
    expect(fake.jevRequests).toHaveLength(0);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("A free moment");
    // You weren't looking: a notification.
    expect(notified).toEqual([
      { title: "Arlo in #ooc", text: "Random thought: what if Ilse's lighthouse was the vault in a heist?", channelId: ooc.id },
    ]);
  });

  test("a free moment your friend spends quietly", async () => {
    youWrote(8);
    fake.replies.push({ content: "[nothing]" });
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "quiet", reason: "heartbeat" });
    expect(notified).toEqual([]);
  });

  test("no notification while the app is on screen", async () => {
    app.presence.set(true);
    youWrote(8);
    fake.replies.push({ content: "Hi!" });
    await heartbeat.tick(true);
    expect(notified).toEqual([]);
  });

  test("never mid-conversation", async () => {
    youWrote(0.1);
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("blocked");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the API", () => {
  async function call(method: string, path: string, body?: unknown) {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, data: (await response.json()) as any };
  }

  test("presence, state, settings", async () => {
    expect((await call("POST", "/api/presence", { visible: true })).status).toBe(200);
    expect(app.presence.isVisible()).toBe(true);
    const state = (await call("GET", "/api/state")).data;
    expect(state.notifications).toBe(true);
    // As short as every 5 minutes, and no shorter.
    expect((await call("PUT", "/api/settings", { heartbeatHours: 0.1667 })).status).toBe(200);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 0.05 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 200 })).status).toBe(400);
  });

  test("beat now", async () => {
    // Chattiness off, so nothing is spent.
    settings({ wakeups: "off" });
    const { data } = await call("POST", "/api/heartbeat", {});
    expect(data.beat.outcome).toBe("blocked");
  });
});
