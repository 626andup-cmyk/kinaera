/**
 * Tests for time (rebuild stage 5): wake-ups your friend schedules for
 * themselves (src/schedule.ts), their private drafts (src/drafts.ts), and
 * pausing a storyline.
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gatherEvidence } from "../src/check.ts";
import { pickProfile, promptForChannel } from "../src/friend.ts";
import { Rhythms } from "../src/orientation.ts";
import { parseWhen } from "../src/schedule.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, type ToolContext } from "../src/tools.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
  app.store.appState.set("orientation.pending", null);
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

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

const ctx = (channel: Channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown>, channel: Channel = ooc) => runTool(ctx(channel), name, args);
const systemPrompt = (channel: Channel = ooc, preview = false) =>
  promptForChannel(app.store, channel.id, { profile: pickProfile(app.store, channel), preview })[0]!.content;

// ------------------------------------------------------------ scheduling

describe("reading times", () => {
  // Wednesday 30 September 2026, 14:00, local time.
  const now = new Date(2026, 8, 30, 14, 0);
  const at = (when: string) => parseWhen(when, now);

  test("relative, clock and ISO times", () => {
    expect(at("in 3 hours").getTime() - now.getTime()).toBe(3 * 3_600_000);
    expect(at("in an hour").getTime() - now.getTime()).toBe(3_600_000);
    expect(at("in 20 minutes").getTime() - now.getTime()).toBe(20 * 60_000);
    expect(at("tomorrow 9am")).toEqual(new Date(2026, 9, 1, 9, 0));
    expect(at("today 18:30")).toEqual(new Date(2026, 8, 30, 18, 30));
    expect(at("thursday at 7pm")).toEqual(new Date(2026, 9, 1, 19, 0));
    // "wednesday" on a Wednesday afternoon, for a time already gone: next week's.
    expect(at("wednesday 9am")).toEqual(new Date(2026, 9, 7, 9, 0));
    expect(at("2026-10-08T19:00")).toEqual(new Date(2026, 9, 8, 19, 0));
    expect(() => at("sometime soon")).toThrow("Couldn't read");
  });
});

describe("wake-ups they set themselves", () => {
  test("schedule, list, cancel, and see them in their prompt", async () => {
    const outcome = await run("schedule_wakeup", { when: "in 3 hours", note: "ask how the interview went" });
    expect(outcome.ok).toBe(true);
    expect(systemPrompt()).toContain("ask how the interview went");
    expect(systemPrompt()).toContain("(the user's local time)");
    const listed = (await run("list_my_wakeups", {})).result as any[];
    expect(listed).toHaveLength(1);
    expect((await run("cancel_wakeup", { id: listed[0].id })).ok).toBe(true);
    expect(app.store.schedule.waiting()).toEqual([]);
    expect((await run("schedule_wakeup", { when: "in 90 days", note: "far" })).ok).toBe(false);
  });

  test("when it's due, they wake with their note, even after reaching out twice; a rule only delays it", async () => {
    let now = new Date();
    now.setHours(12, 0, 0, 0);
    const wakeups = new Wakeups(app.store, app.friend, true, () => now);
    const rhythms = new Rhythms(app.store, wakeups, () => now);
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "hey", createdAt: new Date(now.getTime() - 10 * 3_600_000).toISOString() });
    // They've already reached out twice without hearing back.
    for (const hours of [8, 6]) {
      app.store.wakeLog.add({ at: new Date(now.getTime() - hours * 3_600_000).toISOString(), reason: "heartbeat", outcome: "posted", channelId: ooc.id, detail: "" });
    }
    app.store.schedule.add("in 1 hour", "ask how the interview went");
    app.store.db.query("UPDATE schedule SET at = $at").run({ at: new Date(now.getTime() - 60_000).toISOString() });

    // Quiet hours hold it: it stays waiting.
    app.store.updateSettings({ quietStart: 11, quietEnd: 13 });
    expect((await rhythms.tick())?.outcome).toBeNull();
    expect(app.store.schedule.waiting()).toHaveLength(1);

    // When they end, it happens: their plan isn't blocked by your silence.
    now = new Date(now.getTime() + 2 * 3_600_000);
    fake.replies.push({ content: "so?? how did it go" });
    expect(await rhythms.tick()).toMatchObject({ reason: "scheduled", outcome: "posted" });
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('Your note to yourself: \\"ask how the interview went\\"');
    expect(app.store.schedule.waiting()).toEqual([]);
  });
});

// ---------------------------------------------------------------- drafts

describe("drafts", () => {
  test("private: never in the tool log, the preview or the friend page", async () => {
    fake.replies.push(
      { toolCalls: [{ name: "save_draft", arguments: { text: "SECRET-DRAFT opening line", title: "SECRET-TITLE", channel: "#story" } }] },
      { content: "working on something" },
    );
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(JSON.stringify(app.store.toolLog.forChannel(ooc.id))).not.toContain("SECRET");
    expect(systemPrompt()).toContain("SECRET-TITLE");
    expect(JSON.stringify((await call("GET", `/api/channels/${ooc.id}/prompt`)).data)).not.toContain("SECRET");
    const page = (await call("GET", "/api/friend-page")).data;
    expect(JSON.stringify(page)).not.toContain("SECRET");
    expect(page.drafts).toBe(1);
    // check can search them, privately.
    const found = gatherEvidence(app.store, ooc, { question: "Is there an opening line?", rephrased: "Did I draft an opening line?", sources: ["drafts"] });
    expect(found[0]).toMatchObject({ source: "drafts", private: true });
  });

  test("rewritten across turns, then posted where it's for, and gone", async () => {
    const draft = app.store.drafts.create("First try.", "opener", story.id);
    expect((await run("save_draft", { id: draft.id.slice(0, 6), text: "Ilse Marrow lights the lamp." })).ok).toBe(true);
    const outcome = await run("post_draft", { id: draft.id.slice(0, 6), new_scene: "Dusk" });
    expect(outcome).toMatchObject({ ok: true, summary: "posted a draft in #story" });
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["Dusk", "Ilse Marrow lights the lamp."]);
    expect(app.store.drafts.count()).toBe(0);
  });

  test("posted here, it can be edited in the same turn", async () => {
    const draft = app.store.drafts.create("Its a start.");
    fake.replies.push(
      { toolCalls: [{ name: "post_draft", arguments: { id: draft.id.slice(0, 6) } }] },
      { toolCalls: [{ name: "edit_my_message", arguments: { quote: "Its a start", new_text: "It's a start." } }] },
      { toolCalls: [{ name: "do_nothing", arguments: {} }] },
    );
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(app.store.getMessages(ooc.id).map((m) => m.content)).toEqual(["It's a start."]);
  });
});

// ------------------------------------------------------------ storylines

describe("pausing a storyline", () => {
  test("paused with a reason you see, told in their prompts, and picked back up", async () => {
    expect((await run("pause_storyline", { channel: "#story", reason: "I want to rethink Ilse's arc." })).ok).toBe(true);
    const state = (await call("GET", "/api/state")).data;
    expect(state.channels.find((c: any) => c.name === "story").paused).toMatchObject({ reason: "I want to rethink Ilse's arc." });
    expect(systemPrompt(app.store.getChannel(story.id))).toContain('You paused this storyline: "I want to rethink Ilse\'s arc."');
    expect(systemPrompt()).toContain("paused by you");
    expect((await run("resume_storyline", {}, app.store.getChannel(story.id))).ok).toBe(true);
    expect(app.store.getChannel(story.id).paused).toBeNull();
    expect((await run("pause_storyline", { channel: "#ooc", reason: "x" })).ok).toBe(false);
  });

  test("declining is welcome, in roleplay", () => {
    expect(systemPrompt(story)).toContain("Declining it, pausing it (pause_storyline), or proposing a different direction");
  });
});
