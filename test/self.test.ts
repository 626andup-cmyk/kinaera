/**
 * Tests for the friend's own things (rebuild stage 4): their identity and
 * its changelog (src/identity.ts), the self-page (src/selfpage.ts), the
 * private journal and forgetting (src/journal.ts), moments kept in full
 * (src/verbatim.ts), the prompt manifest, and orientation, the look back
 * and the practice channel (src/orientation.ts).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gatherEvidence } from "../src/check.ts";
import { pickProfile, promptForChannel } from "../src/friend.ts";
import { JOURNAL_RECENT } from "../src/journal.ts";
import { invited, LOOKBACK_DAYS, pendingOrientation, Rhythms } from "../src/orientation.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
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

const ctx = (channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", api: { apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 }, turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown>, channel = ooc) => runTool(ctx(channel), name, args);
/** A turn's system prompt, as a profile with tools gets it. */
const systemPrompt = (channelId = ooc.id) =>
  promptForChannel(app.store, channelId, { profile: pickProfile(app.store, app.store.getChannel(channelId)) })[0]!.content;
const practice = () => app.store.practiceChannel()!;

// ------------------------------------------------------------- identity

describe("identity", () => {
  test("a friend from before identities had versions keeps theirs, however long", () => {
    // What an older version left: a long identity in settings, no versions.
    const long = "You are Arlo. ".repeat(2000); // 28,000 characters
    app.store.updateSettings({ friendPrompt: long });
    app.store.db.exec("DELETE FROM identity_versions");
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl));
    expect(app.store.identity.current()!.identity).toBe(long.trim());
    expect(app.store.identity.current()!.tastes).toBe("");
  });

  test("a new friend starts with who they were made as, and their tastes", () => {
    const [first] = app.store.identity.history();
    expect(first).toMatchObject({ author: "user", status: "accepted" });
    expect(first!.identity).toBe(app.store.getSettings().friendPrompt);
    expect(first!.tastes).not.toBe("");
    expect(systemPrompt()).toContain("Your tastes");
  });

  test("they rewrite it themselves, and every version is kept", async () => {
    const outcome = await run("revise_identity", { identity: "You are Arlo, who writes lighthouses.", note: "Found my thing." });
    expect(outcome).toMatchObject({ ok: true, summary: "revised their identity" });
    expect(app.store.getSettings().friendPrompt).toBe("You are Arlo, who writes lighthouses.");
    expect(app.store.identity.history().map((v) => v.author)).toEqual(["user", "friend"]);
    expect(systemPrompt()).toContain("who writes lighthouses");
  });

  test("your change in settings is a suggestion, not saved over theirs", async () => {
    const before = app.store.getSettings().friendPrompt;
    const { data } = await call("PUT", "/api/settings", { friendPrompt: "You are someone else." });
    expect(data.suggestion).toMatchObject({ status: "pending", author: "user" });
    expect(app.store.getSettings().friendPrompt).toBe(before);
    // Their next turn lists it for review.
    expect(systemPrompt()).toContain(`i${data.suggestion.id}`);
    const outcome = await run("review_identity_suggestion", { id: `i${data.suggestion.id}`, decision: "accept", reply: "Sure, try it." });
    expect(outcome.ok).toBe(true);
    expect(app.store.getSettings().friendPrompt).toBe("You are someone else.");
    expect(app.store.identity.current()).toMatchObject({ author: "user", reply: "Sure, try it." });
  });

  test("declined, and withdrawn", async () => {
    const one = (await call("POST", "/api/identity/suggestions", { tastes: "Loves opera." })).data.waiting.identity[0];
    await run("review_identity_suggestion", { id: `i${one.id}`, decision: "decline", reply: "Not me." });
    expect(app.store.identity.current()!.tastes).not.toBe("Loves opera.");
    const two = (await call("POST", "/api/identity/suggestions", { tastes: "Loves jazz." })).data.waiting.identity[0];
    const { data } = await call("POST", `/api/identity/suggestions/${two.id}/withdraw`, {});
    expect(data.waiting.identity).toEqual([]);
    expect(data.history.map((v: any) => v.status)).toEqual(["accepted", "declined", "withdrawn"]);
  });
});

// ------------------------------------------------------------ self-page

describe("the self-page", () => {
  test("they write it, and the short version is kept in front of them", async () => {
    await run("write_self_page", { section: "says", text: "I like slow scenes." });
    await run("write_self_page", { section: "standing", text: "Slow is fine. Don't rush endings." });
    expect(app.store.selfPage.view()).toMatchObject({ says: "I like slow scenes.", standing: "Slow is fine. Don't rush endings." });
    expect(systemPrompt()).toContain("Don't rush endings.");
    expect((await run("write_self_page", { section: "standing", text: "x".repeat(700) })).ok).toBe(false);
  });

  test("your note is a suggestion: they accept it with a reply, and can dispute it later", async () => {
    const { data } = await call("POST", "/api/self-page/notes", { text: "You end scenes on a question." });
    const note = data.waiting.selfNotes[0];
    expect(note).toMatchObject({ source: "user", status: "pending" });
    await run("review_self_note", { id: note.id.slice(0, 8), decision: "accept", reply: "Guilty." });
    await run("dispute_self_note", { id: note.id.slice(0, 8), dispute: "Only in OOC, though." });
    expect(app.store.selfPage.view().notes[0]).toMatchObject({ status: "accepted", reply: "Guilty.", dispute: "Only in OOC, though." });
  });

  test("edit markers are theirs to turn on", async () => {
    const message = app.store.addTurn([{ channelId: ooc.id, author: "friend", content: "Its late." }])[0]!;
    app.store.editMessage(message.id, "It's late.", "user");
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).not.toContain("(edited by the user)");
    await run("write_self_page", { edit_markers: true });
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).toContain("(edited by the user)");
  });
});

// -------------------------------------------------------------- journal

describe("the journal", () => {
  test("is in their prompt, but never in the tool log, the preview or the friend page", async () => {
    fake.replies.push({ toolCalls: [{ name: "write_journal", arguments: { text: "SECRET-THOUGHT about the lighthouse" } }] }, { content: "Done." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    // The next turn has it.
    expect(systemPrompt()).toContain("SECRET-THOUGHT");
    // Nothing on any screen, and nothing in any log.
    const log = JSON.stringify(app.store.toolLog.forChannel(ooc.id));
    expect(log).toContain("write_journal");
    expect(log).not.toContain("SECRET-THOUGHT");
    expect(JSON.stringify((await call("GET", `/api/channels/${ooc.id}/prompt`)).data)).not.toContain("SECRET-THOUGHT");
    const page = (await call("GET", "/api/friend-page")).data;
    expect(JSON.stringify(page)).not.toContain("SECRET-THOUGHT");
    expect(page.journal).toEqual({ entries: 1, kept: 0 });
  });

  test("reading it isn't logged either", async () => {
    app.store.journal.write("PRIVATE-LINE");
    fake.replies.push({ toolCalls: [{ name: "read_journal", arguments: { search: "private" } }] }, { content: "Hm." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(JSON.stringify(app.store.toolLog.forChannel(ooc.id))).not.toContain("PRIVATE-LINE");
    // …though the model was told, in the turn itself.
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain("PRIVATE-LINE");
  });

  test("entries they don't keep fade as they age; read_journal still finds them", async () => {
    const first = app.store.journal.write("OLDEST entry");
    for (let i = 0; i < JOURNAL_RECENT + 2; i++) app.store.journal.write(`entry ${i}`);
    expect(systemPrompt()).not.toContain("OLDEST");
    expect(systemPrompt()).toContain("older entries aren't shown here");
    app.store.journal.keep(first.id, true);
    expect(systemPrompt()).toContain("OLDEST");
    const found = await run("read_journal", { search: "oldest" });
    expect(JSON.stringify(found.result)).toContain("OLDEST");
  });

  test("check can look in it, marked private in the check log", () => {
    app.store.journal.write("I think Kestrel's brother is called Tobias.");
    const found = gatherEvidence(app.store, ooc, { question: "Is Kestrel's brother called Tobias?", rephrased: "Is Tobias the brother?", sources: ["journal"] });
    expect(found.find((p) => p.source === "journal")).toMatchObject({ private: true });
  });
});

// ------------------------------------------ verbatim, and the manifest

describe("seeing their own prompt", () => {
  test("a moment kept in full stays when it scrolls out of the recent messages", async () => {
    app.store.updateSettings({ historyLimit: 2, summaries: false });
    app.store.addTurn([{ channelId: story.id, author: "user", content: "The KEEPSAKE is a brass key." }]);
    expect((await run("keep_verbatim", { quote: "KEEPSAKE is a brass" }, story)).ok).toBe(true);
    for (let i = 0; i < 5; i++) app.store.addTurn([{ channelId: story.id, author: i % 2 ? "friend" : "user", content: `line ${i}` }]);
    expect(systemPrompt(story.id)).toContain("KEEPSAKE");
    await run("release_verbatim", { quote: "KEEPSAKE" }, story);
    expect(systemPrompt(story.id)).not.toContain("KEEPSAKE");
  });

  test("three slots per channel", async () => {
    for (let i = 0; i < 4; i++) app.store.addTurn([{ channelId: story.id, author: "user", content: `moment number ${i}` }]);
    for (let i = 0; i < 3; i++) expect((await run("keep_verbatim", { quote: `moment number ${i}` }, story)).ok).toBe(true);
    expect((await run("keep_verbatim", { quote: "moment number 3" }, story)).ok).toBe(false);
  });

  test("the manifest lists what's in their context", async () => {
    app.store.journal.write("a thought");
    const { result } = await run("read_prompt_manifest", {}, story);
    const manifest = result as any;
    expect(manifest.layers.map((l: any) => l.title)).toContain("Who you are");
    expect(manifest.journal.included).toHaveLength(1);
    expect(manifest.messages.verbatimSlotsFree).toBe(3);
    expect(manifest.pinned).toContain("Ilse Marrow");
  });
});

// ----------------------------------------------------- practice channel

describe("the practice channel", () => {
  test("is theirs, apart from your channels, and can't be deleted", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect(data.practice).toMatchObject({ kind: "practice", name: "practice" });
    expect((await call("DELETE", `/api/channels/${data.practice.id}`, {})).status).toBe(400);
  });

  test("its sample notes are found only from there", () => {
    const question = { question: "Is Fen Aldous the lamplighter?", rephrased: "Does Fen Aldous light the lamps?" };
    expect(gatherEvidence(app.store, practice(), question).some((p) => p.source === "notebook")).toBe(true);
    expect(gatherEvidence(app.store, story, question).some((p) => p.text.includes("Fen Aldous"))).toBe(false);
    expect(app.store.notebook.listEntries("friend").map((e) => e.name)).toEqual(["Ilse Marrow"]);
    expect(systemPrompt(practice().id)).toContain("Fen Aldous");
    expect(systemPrompt(story.id)).not.toContain("Fen Aldous");
  });

  test("nothing in it reaches other channels", () => {
    app.store.addTurn([{ channelId: practice().id, author: "friend", content: "PRACTICE-ONLY words" }]);
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).not.toContain("PRACTICE-ONLY");
    expect(JSON.stringify(promptForChannel(app.store, story.id))).not.toContain("PRACTICE-ONLY");
  });
});

// ----------------------------------------------------------- orientation

describe("orientation", () => {
  let now: Date;
  let wakeups: Wakeups;
  let rhythms: Rhythms;
  beforeEach(() => {
    now = new Date();
    now.setHours(12, 0, 0, 0);
    wakeups = new Wakeups(app.store, app.friend, true, () => now);
    rhythms = new Rhythms(app.store, wakeups, () => now);
  });

  test("a new friend's first turn of their own is an orientation, in the practice channel", async () => {
    expect(pendingOrientation(app.store)).not.toBeNull();
    fake.replies.push({ toolCalls: [{ name: "ask", arguments: { kind: "other", text: "Is this thing on?" } }] }, { content: "Trying things." });
    const result = await rhythms.tick();
    expect(result).toMatchObject({ outcome: "posted", reason: "orientation" });
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("This is an orientation");
    expect(app.store.getMessages(practice().id).map((m) => m.content)).toEqual(["Trying things."]);
    expect(pendingOrientation(app.store)).toBeNull();
    // Asks made during it are marked.
    expect(app.store.inbox.open()[0]).toMatchObject({ orientation: true });
  });

  test("they can start one themselves, with a focus", async () => {
    await rhythms.tick(); // the first one
    now = new Date(now.getTime() + 3 * 3_600_000);
    await run("start_orientation", { focus: "consult" });
    await rhythms.tick();
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("consult");
  });

  test("your invitation: they're told once, and not starting one is a no", async () => {
    app.store.appState.set("orientation.pending", null);
    await call("POST", "/api/orientation/invite", {});
    expect(invited(app.store)).toBe(true);
    expect(systemPrompt()).toContain("invited you to an orientation");
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(invited(app.store)).toBe(false);
    expect((await call("GET", "/api/friend-page")).data.orientation.lastInvitation).toBe("declined");
    expect(systemPrompt()).not.toContain("invited you to an orientation");
  });

  test("…and starting one is a yes", async () => {
    app.store.appState.set("orientation.pending", null);
    await call("POST", "/api/orientation/invite", {});
    fake.replies.push({ toolCalls: [{ name: "start_orientation", arguments: {} }] }, { content: "Sure!" });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(app.store.appState.get("orientation.invite-result")).toBe("accepted");
  });

  test("a new profile in a roulette is an offer, told once", async () => {
    const profile = app.store.profiles.list()[0]!;
    const other = (await call("POST", "/api/profiles", { name: "Other", model: "zeta/model" })).data.profile;
    const roulette = (await call("POST", "/api/roulettes", { name: "Mix", entries: [{ profileId: profile.id, weight: 1 }] })).data.roulette;
    await call("PATCH", `/api/roulettes/${roulette.id}`, { entries: [{ profileId: profile.id, weight: 1 }, { profileId: other.id, weight: 1 }] });
    expect(systemPrompt()).toContain("A new profile joined the roulette that picks who writes as you: Other.");
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(systemPrompt()).not.toContain("A new profile joined");
  });

  test("the weekly look back shows the week's journal", async () => {
    app.store.appState.set("orientation.pending", null);
    expect(await rhythms.tick()).toBeNull(); // starts counting
    app.store.journal.write("WEEK-ONE thought");
    expect(await rhythms.tick()).toBeNull(); // not a week yet
    now = new Date(now.getTime() + LOOKBACK_DAYS * 86_400_000 + 60_000);
    const result = await rhythms.tick();
    expect(result).toMatchObject({ reason: "lookback" });
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("WEEK-ONE");
  });

  test("tools for your own things are offered everywhere, verbatim only outside practice", () => {
    const names = (channel: Channel) => toolSpecs(ctx(channel)).map((t) => t.function.name);
    expect(names(ooc)).toEqual(expect.arrayContaining(["revise_identity", "write_journal", "read_prompt_manifest", "keep_verbatim", "start_orientation"]));
    expect(names(practice())).not.toContain("keep_verbatim");
  });
});
