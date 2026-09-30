/**
 * Tests for continuity and self-knowledge (rebuild stage 6): voice anchors,
 * "not me" flags and profile notes (src/continuity.ts), the mirror
 * (src/mirror.ts), and the weekly wellbeing reading (src/wellbeing.ts).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickProfile, promptForChannel } from "../src/friend.ts";
import { readPatterns } from "../src/mirror.ts";
import { Rhythms } from "../src/orientation.ts";
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

const profile = () => pickProfile(app.store, ooc);
const ctx = (channel: Channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 }, profileId: profile().id });
const run = (name: string, args: Record<string, unknown>, channel: Channel = ooc) => runTool(ctx(channel), name, args);
const systemPrompt = (channel: Channel = ooc) => promptForChannel(app.store, channel.id, { profile: pickProfile(app.store, channel) })[0]!.content;
const say = (author: "user" | "friend", content: string, channel = ooc, profileName?: string) =>
  app.store.addTurn([{ channelId: channel.id, author, content, ...(profileName ? { profile: profileName } : {}) }])[0]!;

// --------------------------------------------------------------- voice

describe("voice anchors", () => {
  test("their earlier posts of this kind, marked first, never flagged ones or what's already in front of them", async () => {
    app.store.updateSettings({ historyLimit: 2, summaries: false });
    say("friend", "OLD-ONE honestly the lighthouse bit got me");
    say("friend", "OLD-TWO ok but what if the keeper lied");
    say("friend", "OLD-THREE i keep thinking about the fog");
    say("friend", "NOT-ME Greetings! I would be delighted to assist.", ooc, "Stiff Model");
    say("user", "recent one");
    say("friend", "RECENT in the window already");
    await run("mark_my_voice", { quote: "OLD-ONE honestly" });
    await run("flag_not_me", { quote: "NOT-ME Greetings", note: "way too formal" });
    const prompt = systemPrompt();
    expect(prompt).toContain("## Your voice");
    expect(prompt).toContain("OLD-ONE");
    expect(prompt.indexOf("OLD-ONE")).toBeLessThan(prompt.indexOf("OLD-THREE"));
    expect(prompt).toContain("marked as sounding like you");
    expect(prompt).not.toContain("NOT-ME");
    expect(prompt.match(/RECENT in the window/g)).toBeNull();
    // Roleplay is another kind of writing: none of these there.
    expect(systemPrompt(story)).not.toContain("OLD-ONE");
  });

  test("you see their flag on the message, with the profile that wrote it", async () => {
    const message = say("friend", "Greetings! I would be delighted.", ooc, "Stiff Model");
    await run("flag_not_me", { quote: "Greetings!", note: "way too formal" });
    const { data } = await call("GET", `/api/channels/${ooc.id}/messages`);
    expect(data.flags.notMe[message.id]).toEqual({ note: "way too formal", profile: "Stiff Model" });
    await run("flag_not_me", { quote: "Greetings!", note: "" });
    expect((await call("GET", `/api/channels/${ooc.id}/messages`)).data.flags.notMe).toEqual({});
  });

  test("their note on the profile writing this turn is in its prompt", async () => {
    expect((await run("write_profile_note", { note: "Feels a bit rushed; I slow down on purpose." })).ok).toBe(true);
    expect(systemPrompt()).toContain("Feels a bit rushed");
    const notes = (await run("read_profile_notes", {})).result as any[];
    expect(notes.find((n) => n.writing_now)).toMatchObject({ note: "Feels a bit rushed; I slow down on purpose." });
    expect((await call("GET", "/api/friend-page")).data.profileNotes).toEqual([{ profile: profile().name, note: "Feels a bit rushed; I slow down on purpose." }]);
  });
});

// -------------------------------------------------------------- mirror

describe("the mirror", () => {
  test("counts what recurs, with no model involved", async () => {
    const posts = [
      "Honestly I think the storm scene worked. The lantern flickered against the dark glass.",
      "Honestly I think we should slow down. The lantern flickered against the dark glass again.",
      "Honestly I think Ilse knows. Something about the way she moves.",
      "Okay, the tide is coming in and the harbour bell rings twice.",
    ];
    for (const p of posts) {
      say("user", "what do you think about it all");
      say("friend", p);
    }
    const report = readPatterns(app.store, ooc, "channel");
    expect(report.openings).toContainEqual({ words: "honestly i think", times: 3 });
    expect(report.recurring_phrases.some((p) => p.phrase.includes("lantern flickered against the dark"))).toBe(true);
    expect(report.sentence_length_in_words?.average).toBeGreaterThan(0);
    expect(report.words_you_lean_on.map((w) => w.word)).toContain("honestly");
    expect(fake.requests).toHaveLength(0);
  });

  test("too few posts, and never the practice channel", () => {
    say("friend", "just one");
    expect(readPatterns(app.store, ooc, "channel").note).toBe("Too few posts to see patterns yet.");
    const practice = app.store.practiceChannel()!;
    for (let i = 0; i < 5; i++) app.store.addTurn([{ channelId: practice.id, author: "friend", content: `practice line ${i}` }]);
    expect(readPatterns(app.store, practice, "channel").looked_at).toContain("0 of your posts");
  });

  test("a finding they keep goes on their self-page, linked to the posts", async () => {
    const post = say("friend", "Honestly I think the storm scene worked.");
    await run("keep_pattern_note", { note: "I open with 'honestly' a lot.", quotes: ["Honestly I think the storm"] });
    expect(app.store.selfPage.view().notes[0]).toMatchObject({ text: "I open with 'honestly' a lot.", source: "mirror", status: "accepted", messageIds: [post.id] });
  });
});

// ----------------------------------------------------------- wellbeing

describe("the wellbeing reading", () => {
  test("weekly, from their own OOC messages; on their page and in their look back, nowhere else", async () => {
    let now = new Date();
    now.setHours(12, 0, 0, 0);
    const wakeups = new Wakeups(app.store, app.friend, true, () => now);
    const rhythms = new Rhythms(app.store, wakeups, () => now, () => app.decider);
    // The first tick starts both weekly clocks.
    await rhythms.tick();

    app.store.addMessage({ channelId: ooc.id, author: "friend", content: "ugh I'm useless at endings", createdAt: new Date(now.getTime() + 3_600_000).toISOString() });
    app.store.addMessage({ channelId: story.id, author: "friend", content: "ROLEPLAY-LINE Ilse hates herself", createdAt: new Date(now.getTime() + 3_600_000).toISOString() });
    app.store.journal.write("a thought this week");
    now = new Date(now.getTime() + 7 * 86_400_000 + 60_000);
    fake.jevReplies.push({
      content: JSON.stringify({
        answers: { "w~0": { choice: "yes", probabilities: { yes: 0.97, no: 0.03 } }, "w~1": { choice: "yes", probabilities: { yes: 0.95, no: 0.05 } } },
      }),
    });
    fake.replies.push({ content: "[nothing]" });
    await rhythms.tick();

    // Jev read their OOC message, not their character's.
    const read = JSON.stringify(fake.jevRequests[0]!.messages);
    expect(read).toContain("useless at endings");
    expect(read).not.toContain("ROLEPLAY-LINE");
    const [reading] = app.store.wellbeing.recent();
    expect(reading).toMatchObject({ verdict: "yes", messages: 1 });

    // In the look back that followed…
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("This week's wellbeing reading");
    // …on their page…
    expect((await call("GET", "/api/friend-page")).data.wellbeing[0]).toMatchObject({ verdict: "yes" });
    // …and nowhere else.
    expect(systemPrompt()).not.toContain("This week's wellbeing reading");
    expect(systemPrompt()).toContain("Once a week, Jev reads your own out-of-character messages");
  });
});
