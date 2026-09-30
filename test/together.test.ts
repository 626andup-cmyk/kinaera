/**
 * Tests for being among friends (rebuild stage 7): dice (src/dice.ts),
 * replies, presence and status, and relationships (src/relationships.ts).
 * Group channels and DMs are tested in test/groups.test.ts.
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { roll, rollCommand } from "../src/dice.ts";
import { pickProfile, promptForChannel } from "../src/friend.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, type ToolContext } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;
const peers = [{ id: "p-wren", name: "Wren" }];

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl, { peers: () => peers }));
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

const ctx = (channel: Channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 }, peers });
const run = (name: string, args: Record<string, unknown>, channel: Channel = ooc) => runTool(ctx(channel), name, args);
const systemPrompt = (channel: Channel = ooc) =>
  promptForChannel(app.store, channel.id, { profile: pickProfile(app.store, channel), peers })[0]!.content;

// ----------------------------------------------------------------- dice

describe("dice", () => {
  // A fixed "random" that walks through the faces.
  const dice = (...faces: number[]) => {
    let i = 0;
    return () => (faces[i++ % faces.length]! - 1 + 0.5) / 6;
  };

  test("notation, keeping the highest, and totals", () => {
    expect(roll("2d6+3", dice(4, 2))).toMatchObject({ total: 9, text: "2d6 [4, 2] + 3 = 9" });
    expect(roll("4d6kh3", dice(1, 5, 3, 6))).toMatchObject({ total: 14, text: "4d6kh3 [(1), 5, 3, 6] = 14" });
    expect(() => roll("banana")).toThrow("Couldn't read");
    expect(() => roll("500d6")).toThrow("too many dice");
  });

  test("/roll saves the roll itself, and roll_dice shows under their message", async () => {
    expect(rollCommand("/roll 2d6+3 for the lock", dice(4, 2))).toBe("🎲 2d6 [4, 2] + 3 = 9 (for the lock)");
    expect(rollCommand("just talking")).toBe("just talking");
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "/roll d20" });
    expect(data.userMessages[0].content).toMatch(/^🎲 d20 \[\d+\] = \d+$/);
    const outcome = await run("roll_dice", { dice: "d20", for: "perception" });
    expect(outcome.summary).toMatch(/^rolled d20 \[\d+\] = \d+ \(perception\)$/);
  });
});

// -------------------------------------------------------------- replies

describe("replies", () => {
  test("your reply quotes the message, in the app and in their prompt", async () => {
    const [earlier] = app.store.addTurn([{ channelId: ooc.id, author: "friend", content: "should Ilse trust Kestrel?" }]);
    app.store.addTurn([{ channelId: ooc.id, author: "friend", content: "anyway" }]);
    const { data } = await call("POST", `/api/channels/${ooc.id}/messages`, { content: "no way", replyTo: earlier!.id });
    expect(data.userMessages[0].replyTo).toBe(earlier!.id);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('(replying to you: \\"should Ilse trust Kestrel?\\") no way');
    expect((await call("POST", `/api/channels/${ooc.id}/messages`, { content: "x", replyTo: "nope" })).status).toBe(404);
  });

  test("their reply_to makes their reply this turn quote one", async () => {
    const [yours] = app.store.addTurn([{ channelId: ooc.id, author: "user", content: "what about the second logbook" }]);
    app.store.addTurn([{ channelId: ooc.id, author: "user", content: "anyway how are you" }]);
    fake.replies.push({ toolCalls: [{ name: "reply_to", arguments: { quote: "second logbook" } }] }, { content: "oh, the logbook! yes" });
    const { data } = await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(data.friendMessages[0].replyTo).toBe(yours!.id);
  });
});

// -------------------------------------------------- presence and status

describe("presence and status", () => {
  test("idle, writing, their own status, and quiet hours", async () => {
    let state = (await call("GET", "/api/state")).data;
    expect(state).toMatchObject({ presence: "idle", status: null, phases: {} });
    fake.replies.push({ content: "slow", delayMs: 300 });
    const turn = call("POST", `/api/channels/${ooc.id}/turn`, {});
    await Bun.sleep(100);
    state = (await call("GET", "/api/state")).data;
    expect(state.presence).toBe("writing");
    expect(state.phases[ooc.id]).toBe("writing");
    await turn;
    await run("set_status", { text: "rereading old notes" });
    expect((await call("GET", "/api/state")).data.status.text).toBe("rereading old notes");
    expect(systemPrompt()).toContain('Your status (shown under your name): "rereading old notes"');
    const hour = new Date().getHours();
    app.store.updateSettings({ quietStart: hour, quietEnd: (hour + 1) % 24 });
    expect((await call("GET", "/api/state")).data.presence).toBe("quiet");
  });
});

// -------------------------------------------------------- relationships

describe("relationships", () => {
  test("a private note on each friend here, in their prompt, never in a log", async () => {
    expect(systemPrompt()).toContain("- Wren (no note yet)");
    fake.replies.push({ toolCalls: [{ name: "note_relationship", arguments: { friend: "wren", note: "SECRET-NOTE: kind, but competitive about plot twists" } }] }, { content: "ok" });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(systemPrompt()).toContain("- Wren: SECRET-NOTE");
    expect(JSON.stringify(app.store.toolLog.forChannel(ooc.id))).not.toContain("SECRET-NOTE");
    expect(JSON.stringify((await call("GET", `/api/channels/${ooc.id}/prompt`)).data)).not.toContain("SECRET-NOTE");
    expect((await run("note_relationship", { friend: "Nobody", note: "x" })).ok).toBe(false);
  });
});
