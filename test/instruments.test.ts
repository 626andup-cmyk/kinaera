/**
 * Tests for the instruments (rebuild stage 3): `check` (src/check.ts) and
 * its log, `ask` and the unified inbox (src/inbox.ts), and `consult` with
 * consultant profiles.
 *
 * Model calls go to a fake nanoGPT (see helpers.ts). Jev's answers are
 * queued in `jevReplies`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CHECK_LIMIT, gatherEvidence, runCheck } from "../src/check.ts";
import { MIGRATIONS, openDatabase } from "../src/db.ts";
import { inboxFor, promptForChannel } from "../src/friend.ts";
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

const say = (author: "user" | "friend", content: string, channel = story) =>
  app.store.addTurn([{ channelId: channel.id, author, content }])[0]!;

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

/** Jev answering both phrasings of a check. */
const jev = (p1: number, p2 = p1) => ({
  content: JSON.stringify({
    answers: {
      "q~0": { choice: p1 >= 0.5 ? "yes" : "no", probabilities: { yes: p1, no: 1 - p1 } },
      "q~1": { choice: p2 >= 0.5 ? "yes" : "no", probabilities: { yes: p2, no: 1 - p2 } },
    },
  }),
});

const ctx = (channel = story): ToolContext => ({ store: app.store, channel, mode: "post", decider: app.decider, api: { apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 }, turn: { consults: 0 } });

// ---------------------------------------------------------------- check

describe("check: searching", () => {
  test("finds passages in the notebook, this channel and the summaries, each with where it's from", () => {
    say("user", "Kestrel mentions her brother Tobias drowned off the point.");
    app.store.summaries.save(story.id, "story", "", "Ilse took Kestrel in during a storm; the brother came up.", 1);
    const found = gatherEvidence(app.store, story, { question: "Has Kestrel's brother been named?", rephrased: "Is there a name given for Kestrel's brother?" });
    const wheres = found.map((p) => p.where);
    expect(wheres.some((w) => w.startsWith("#story, the user"))).toBe(true);
    expect(wheres).toContain("#story: the story so far");
    expect(found.find((p) => p.source === "channel")!.text).toContain("Tobias");
  });

  test("the notebook as your friend sees it: entries hidden from them are never searched", () => {
    const secret = app.store.notebook.createEntry("user", { kind: "lore", name: "The Drowned Bell", fields: [{ label: "What", value: "A bell under the lighthouse." }] });
    app.store.notebook.updateEntrySettings("user", secret.id, { visibility: "hidden" });
    const found = gatherEvidence(app.store, story, { question: "Is there a drowned bell?", rephrased: "Does a bell lie under the lighthouse?" });
    expect(found.some((p) => p.text.includes("A bell under the lighthouse"))).toBe(false);
    // The example character is visible, and found by name.
    expect(gatherEvidence(app.store, story, { question: "Is Ilse a lighthouse keeper?", rephrased: "Does Ilse keep the light?" })[0]!.where).toBe("notebook: Ilse Marrow (character)");
  });

  test("only the sources asked for, and never more than CHECK_LIMIT characters", () => {
    for (let i = 0; i < 20; i++) say("user", `The tide rose again, ${"salt and wind ".repeat(200)} (${i})`);
    const found = gatherEvidence(app.store, story, { question: "Did the tide rise?", rephrased: "Was there a high tide?", sources: ["channel"] });
    expect(found.every((p) => p.source === "channel")).toBe(true);
    expect(found.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(CHECK_LIMIT);
  });
});

describe("check: Jev's reading", () => {
  test("a confident yes needs both phrasings", async () => {
    say("user", "My brother Tobias drowned.");
    fake.jevReplies.push(jev(0.95, 0.9));
    const yes = await runCheck(app.store, story, app.decider, { question: "Was the brother named?", rephrased: "Is there a name for the brother?" });
    expect(yes).toMatchObject({ verdict: "yes", yes: [0.95, 0.9], answeredBy: "jev" });
    // Jev read the passages, with both phrasings as questions.
    expect(fake.jevRequests[0]!.messages[0]!.content).toContain("Tobias");
    expect(Object.keys(fake.jevRequests[0]!.response_format.questions)).toEqual(["q~0", "q~1"]);

    fake.jevReplies.push(jev(0.95, 0.3));
    const split = await runCheck(app.store, story, app.decider, { question: "Was the brother named?", rephrased: "Is there a name for the brother?" });
    expect(split.verdict).toBe("unsure");
  });

  test("nothing found is an ordinary answer, and Jev isn't asked", async () => {
    const result = await runCheck(app.store, story, app.decider, { question: "Is there a dragon?", rephrased: "Does a dragon exist?" });
    expect(result).toMatchObject({ verdict: null, found: [], error: null });
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("with Jev off or failing, the passages still come back", async () => {
    say("user", "The dragon circles the lighthouse.");
    app.store.updateSettings({ decisionModel: "" });
    const off = await runCheck(app.store, story, app.decider, { question: "Is there a dragon?", rephrased: "Does a dragon exist?" });
    expect(off.verdict).toBeNull();
    expect(off.found).toHaveLength(1);
    expect(off.error).toContain("turned off");

    app.store.updateSettings({ decisionModel: "typesafe/jev-1.13" });
    fake.jevReplies.push({ status: 503, error: "unavailable" });
    const failed = await runCheck(app.store, story, app.decider, { question: "Is there a dragon?", rephrased: "Does a dragon exist?" });
    expect(failed.error).toContain("couldn't give a reading");
    expect(failed.found).toHaveLength(1);
  });
});

describe("check: the tool and its log", () => {
  test("returns the reading and the evidence, and every check is logged", async () => {
    say("user", "Tobias was my brother.");
    fake.jevReplies.push(jev(0.9));
    const outcome = await runTool(ctx(), "check", { question: "Was the brother named?", rephrased: "Is there a name for the brother?" });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      reading: { answer: "yes", how_sure: ["90% yes", "90% yes"] },
      found: [{ from: expect.stringContaining("#story, the user"), text: "Tobias was my brother." }],
    });
    const nothing = await runTool(ctx(), "check", { question: "Is there a dragon?", rephrased: "Does a dragon exist?" });
    expect((nothing.result as { note: string }).note).toBe("Nothing found in the notebook, this channel and the summaries. That's an ordinary answer: as far as these sources go, it isn't there.");
    const { data } = await call("GET", "/api/checks");
    expect(data.checks.map((c: { verdict: string | null }) => c.verdict)).toEqual([null, "yes"]);
  });

  test("private passages are logged by where they're from, never their text", () => {
    app.store.checkLog.add({
      channelId: story.id,
      question: "q",
      rephrased: "q",
      durationMs: 1,
      result: {
        verdict: "yes",
        yes: [0.9, 0.9],
        sources: ["notebook"],
        error: null,
        answeredBy: "jev",
        found: [
          { source: "notebook", where: "notebook: Ilse", text: "shareable" },
          { source: "notebook", where: "journal: Tuesday", text: "a private thought", private: true },
        ],
      },
    });
    const [entry] = app.store.checkLog.recent();
    expect(entry!.found).toEqual([
      { source: "notebook", where: "notebook: Ilse", text: "shareable" },
      { source: "notebook", where: "journal: Tuesday", text: null },
    ]);
    expect(JSON.stringify(app.store.db.query("SELECT * FROM check_log").all())).not.toContain("a private thought");
  });

  test("an unknown source is explained", async () => {
    expect(await runTool(ctx(), "check", { question: "x", rephrased: "y", sources: ["diary"] })).toMatchObject({ ok: false });
  });
});

// ------------------------------------------------------------------ ask

describe("ask and the inbox", () => {
  test("an ask goes to the inbox, waits in your friend's prompt, and your answer reaches them once", async () => {
    const asked = await runTool(ctx(), "ask", { kind: "context", text: "Who knows Ilse's secret logbook exists?" });
    expect(asked).toMatchObject({ ok: true, result: { asked: true } });
    const [item] = app.store.inbox.open();
    expect(item).toMatchObject({ kind: "ask", askKind: "context", channelId: story.id });

    const waiting = promptForChannel(app.store, ooc.id)[0]!.content;
    expect(waiting).toContain("## What you've asked of the user");
    expect(waiting).toContain("No answer yet.");

    const { data } = await call("POST", `/api/inbox/${item!.id}/answer`, { answer: "Only Kestrel, since chapter two." });
    expect(data.inbox).toEqual([]);
    expect(inboxFor(app.store).lines).toEqual([`New: You asked the user (context): "Who knows Ilse's secret logbook exists?". They answered: "Only Kestrel, since chapter two."`]);

    // A turn carries it; after that it's no longer new, but stays for a day.
    fake.replies.push({ content: "Got it." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("Only Kestrel, since chapter two.");
    expect(inboxFor(app.store).lines[0]).not.toStartWith("New:");
    expect(inboxFor(app.store, Date.now() + 25 * 3_600_000).lines).toEqual([]);
    // Your answer is in the intervention log too.
    expect(app.store.interventions.recent()[0]!.kind).toBe("ask");
  });

  test("setting an ask aside: your friend is told", async () => {
    const item = app.store.inbox.ask("other", "Can we do a heist?", ooc.id);
    await call("POST", `/api/inbox/${item.id}/dismiss`, {});
    expect(inboxFor(app.store).lines[0]).toContain("They set it aside without answering.");
  });

  test("a wrong kind is explained; an empty answer is refused", async () => {
    expect(await runTool(ctx(), "ask", { kind: "urgent", text: "hi" })).toMatchObject({ ok: false });
    const item = app.store.inbox.ask("clarify", "What did you mean?", null);
    expect((await call("POST", `/api/inbox/${item.id}/answer`, { answer: "  " })).status).toBe(400);
  });

  test("answering can wake your friend, even though they reached out last", async () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const wakeups = new Wakeups(app.store, app.friend, true, () => now);
    app.store.addMessage({ channelId: ooc.id, author: "user", content: "hey", createdAt: new Date(now.getTime() - 6 * 3_600_000).toISOString() });
    fake.replies.push({ content: "Welcome back!" });
    expect((await wakeups.event("opened")).outcome).toBe("posted");
    // They've reached out; normally they'd wait for you now.
    now.setHours(15);
    expect((await wakeups.event("opened")).detail).toContain("waiting for you");
    fake.replies.push({ content: "Thanks for answering!" });
    expect(await wakeups.event("answer")).toMatchObject({ outcome: "posted", reason: "answer" });
  });

  test("proposals are in the inbox too", async () => {
    await runTool(ctx(), "propose_channel_deletion", { channel: "#ooc", reason: "Unused." });
    expect((await call("GET", "/api/state")).data.inbox).toMatchObject([{ kind: "delete_channel", targetName: "ooc", text: "Unused." }]);
    const [item] = app.store.inbox.open();
    await call("POST", `/api/inbox/${item!.id}/deny`, {});
    expect(inboxFor(app.store).lines).toEqual(["New: The user denied your proposal to delete #ooc."]);
  });

  test("proposals from before stage 3 move into the inbox", () => {
    const path = join(dir.path, "stage2.db");
    const old = new Database(path);
    old.exec("PRAGMA foreign_keys = ON");
    for (const step of MIGRATIONS.slice(0, 2)) typeof step === "string" ? old.exec(step) : typeof step === "function" ? step(old) : old.exec(step.rebuild);
    old.exec("PRAGMA user_version = 2");
    old.exec(`INSERT INTO proposals (id, kind, target_id, target_name, reason, status, created_at) VALUES ('p1', 'delete_channel', 'c', 'old', 'Done.', 'pending', 'then')`);
    old.close();
    const db = openDatabase(path);
    expect(db.query("SELECT id, kind, target_name, text, status FROM inbox").all()).toEqual([{ id: "p1", kind: "delete_channel", target_name: "old", text: "Done.", status: "open" }]);
    db.close();
  });
});

// -------------------------------------------------------------- consult

describe("consult", () => {
  test("only offered once a profile is marked as a consultant", async () => {
    const names = () => toolSpecs(ctx()).map((t) => t.function.name);
    expect(names()).not.toContain("consult");
    await call("POST", "/api/profiles", { name: "Opus", model: "strong/model", temperature: 0.7, maxTokens: 800, consultant: true });
    expect(names()).toContain("consult");
    expect(names()).toContain("check");
    expect(names()).toContain("ask");
  });

  test("sends the question and attachments with the framing; only your friend gets the reply; once per turn", async () => {
    app.store.profiles.create({ name: "Opus", model: "strong/model", temperature: 0.7, maxTokens: 800, consultant: true });
    say("friend", "*Ilse sets the lamp down, again.*");
    fake.replies.push({ content: "You open three posts in a row with the lamp. Try starting with Kestrel." });
    const turn = ctx();
    const outcome = await runTool(turn, "consult", { question: "Am I repeating myself?", messages: ["sets the lamp"], entries: ["Ilse Marrow"], draft: "*Ilse lights the lamp.*" });
    expect(outcome.result).toEqual({ consultant: "Opus", reply: "You open three posts in a row with the lamp. Try starting with Kestrel." });
    const request = fake.requests[0]!;
    expect(request.model).toBe("strong/model");
    expect(request.messages[0]!.content).toContain("A writer friend is asking for your honest read.");
    const sent = request.messages[1]!.content;
    expect(sent).toContain("Am I repeating myself?");
    expect(sent).toContain("*Ilse sets the lamp down, again.*");
    expect(sent).toContain("### Ilse Marrow (character)");
    expect(sent).toContain("*Ilse lights the lamp.*");

    expect(await runTool(turn, "consult", { question: "Again?" })).toMatchObject({ ok: false });
    expect(fake.requests).toHaveLength(1);
  });

  test("a consultant that fails is explained, not thrown", async () => {
    app.store.profiles.create({ name: "Opus", model: "strong/model", temperature: 0.7, maxTokens: 800, consultant: true });
    fake.replies.push({ status: 500, error: "down" });
    const outcome = await runTool(ctx(), "consult", { question: "Thoughts?" });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("didn't go through");
  });
});

describe("being honest about what the user sees", () => {
  test("the tool log keeps that your friend consulted, not the reply", async () => {
    app.store.profiles.create({ name: "Opus", model: "strong/model", temperature: 0.7, maxTokens: 800, consultant: true });
    app.store.updateSettings({ oocAssignment: `profile:${app.store.profiles.list()[0]!.id}` });
    fake.replies.push({ toolCalls: [{ name: "consult", arguments: { question: "Too dark?" } }] }, { content: "A secret opinion." }, { content: "Okay." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    const [logged] = app.store.toolLog.forChannel(ooc.id);
    expect(logged!.arguments).toContain("Too dark?");
    expect(logged!.result).not.toContain("A secret opinion.");
    // Your friend did get it.
    expect(JSON.stringify(fake.requests[2]!.messages)).toContain("A secret opinion.");
  });

  test("with tools, the prompt says the user can see tool use", () => {
    const system = promptForChannel(app.store, story.id, { profile: app.store.profiles.list()[0] })[0]!.content;
    expect(system).toContain("The user can see which tools you use");
  });
});
