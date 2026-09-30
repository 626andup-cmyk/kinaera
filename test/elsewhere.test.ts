/**
 * Tests for acting on one channel from another: `post_in_channel` (asking
 * in OOC about a story, or opening a scene after planning it in OOC) and
 * `read_recent_messages` (src/tools.ts).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel, Message } from "../src/types.ts";
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
  // No orientation waiting: these tests are about other things.
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

const ctx = (channel: Channel): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 } });

describe("posting in another channel", () => {
  test("after planning in OOC, they open a scene in #story, and still reply in OOC", async () => {
    app.store.addTurn([{ channelId: ooc.id, author: "user", content: "want to start the storm scene?" }]);
    fake.replies.push(
      { toolCalls: [{ name: "post_in_channel", arguments: { channel: "#story", new_scene: "The Storm", text: "Ilse Marrow bars the door as the first wave hits." } }] },
      { content: "done! go look in #story" },
    );
    const { data } = await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(data.friendMessages.map((m: Message) => m.content)).toEqual(["done! go look in #story"]);
    const inStory = app.store.getMessages(story.id);
    expect(inStory.map((m) => [m.kind, m.author, m.content])).toEqual([
      ["scene_break", "friend", "The Storm"],
      ["post", "friend", "Ilse Marrow bars the door as the first wave hits."],
    ]);
    expect(inStory[1]!.characters).toEqual(["Ilse Marrow"]);
    expect(app.store.toolLog.forChannel(ooc.id)[0]!.summary).toBe('started a scene ("The Storm") and posted in #story: "Ilse Marrow bars the door as the first wave hits."');
  });

  test("from a story, a question in OOC, as texts", async () => {
    app.store.updateSettings({ oocBubbles: true });
    const outcome = await runTool(ctx(story), "post_in_channel", { channel: "ooc", text: "wait<cht>is Kestrel lying to Ilse?" });
    expect(outcome.ok).toBe(true);
    expect(app.store.getMessages(ooc.id).map((m) => m.content)).toEqual(["wait", "is Kestrel lying to Ilse?"]);
  });

  test("not here, not twice in one turn, not while writing there, and not from practice", async () => {
    const here = ctx(ooc);
    expect((await runTool(here, "post_in_channel", { channel: "ooc", text: "hi" })).ok).toBe(false);
    expect((await runTool(here, "post_in_channel", { channel: "story", text: "One." })).ok).toBe(true);
    expect((await runTool(here, "post_in_channel", { channel: "story", text: "Two." })).ok).toBe(false);
    expect((await runTool({ ...ctx(ooc), isBusy: () => true }, "post_in_channel", { channel: "story", text: "Three." })).ok).toBe(false);
    expect((await runTool(here, "post_in_channel", { channel: "ooc", text: "x", new_scene: "Nope" })).ok).toBe(false);
    const practice = app.store.practiceChannel()!;
    expect(toolSpecs(ctx(practice)).map((t) => t.function.name)).not.toContain("post_in_channel");
    expect((await runTool(here, "post_in_channel", { channel: "practice", text: "x" })).ok).toBe(false);
  });

  test("a wake-up that only posts elsewhere counts as writing to you, and notifies once", async () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const wakeups = new Wakeups(app.store, app.friend, true, () => now);
    const told: string[] = [];
    wakeups.onPosted = (channel, messages) => told.push(`${channel.name}: ${messages.map((m) => m.content).join(" ")}`);
    app.friend.onPostedElsewhere = (channel, messages) => wakeups.onPosted?.(channel, messages);
    app.store.addTurn([{ channelId: ooc.id, author: "user", content: "morning", createdAt: new Date(now.getTime() - 5 * 3_600_000).toISOString() }]);
    fake.replies.push({ toolCalls: [{ name: "post_in_channel", arguments: { channel: "story", text: "The fog lifts." } }] }, { content: "[nothing]" });
    const result = await wakeups.event("heartbeat");
    expect(result).toMatchObject({ outcome: "posted" });
    expect(told).toEqual(["story: The fog lifts."]);
  });
});

describe("reading another channel", () => {
  test("the newest messages, oldest first", async () => {
    app.store.addTurn([{ channelId: story.id, author: "user", content: "Kestrel knocks." }]);
    app.store.addTurn([{ channelId: story.id, author: "friend", content: "Ilse opens the door.", characters: ["Ilse Marrow"] }]);
    const { result } = await runTool(ctx(ooc), "read_recent_messages", { channel: "#story", count: 5 });
    expect((result as any).messages).toEqual([
      { from: "the user", when: expect.any(String), text: "Kestrel knocks." },
      { from: "you", as: "Ilse Marrow", when: expect.any(String), text: "Ilse opens the door." },
    ]);
  });
});
