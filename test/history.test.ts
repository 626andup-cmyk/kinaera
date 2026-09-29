/**
 * Tests for messages with history (rebuild stage 2): edits that keep every
 * version, deleting as a tombstone, regenerations kept as alternates, the
 * intervention log, your friend's message tools, and the honest note in
 * their prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel } from "../src/friend.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, type ToolContext } from "../src/tools.ts";
import type { Channel, Message } from "../src/types.ts";
import { parseSections } from "../src/wording.ts";
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

const say = (author: "user" | "friend", content: string, channel = story): Message =>
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

describe("editing keeps every version", () => {
  test("the first edit saves the original too; later edits add to it", async () => {
    const m = say("friend", "*Ilse sets the lamp down.*");
    app.store.editMessage(m.id, "*Ilse sets the lamp down, slowly.*", "user");
    app.store.editMessage(m.id, "*Ilse sets the lamp down.* Well?", "friend");
    const { message, revisions } = app.store.history(m.id);
    expect(message).toMatchObject({ content: "*Ilse sets the lamp down.* Well?", editedBy: "friend" });
    expect(revisions.map((r) => [r.author, r.content])).toEqual([
      ["friend", "*Ilse sets the lamp down.*"],
      ["user", "*Ilse sets the lamp down, slowly.*"],
      ["friend", "*Ilse sets the lamp down.* Well?"],
    ]);
  });

  test("an unedited message has no versions, and an edit to the same text changes nothing", async () => {
    const m = say("user", "hi");
    app.store.editMessage(m.id, "hi");
    expect(app.store.history(m.id).revisions).toEqual([]);
    expect(app.store.getMessage(m.id).editedAt).toBeUndefined();
  });

  test("your friend can edit only their own messages", async () => {
    const yours = say("user", "I knock.");
    expect(() => app.store.editMessage(yours.id, "I kick the door.", "friend")).toThrow(/only edit your own/);
  });
});

describe("deleting leaves a tombstone", () => {
  test("gone from the chat and the prompt, kept in history", async () => {
    const m = say("friend", "A line I regret.");
    say("user", "Hm.");
    app.store.deleteMessage(m.id, "user");
    expect(app.store.getMessages(story.id).map((x) => x.content)).toEqual(["Hm."]);
    expect(JSON.stringify(promptForChannel(app.store, story.id))).not.toContain("A line I regret.");
    expect(app.store.history(m.id).message).toMatchObject({ content: "A line I regret.", deletedBy: "user" });
    // It can't be edited or deleted again.
    expect(() => app.store.editMessage(m.id, "x")).toThrow();
    expect(() => app.store.deleteMessage(m.id)).toThrow();
  });

  test("clearing a channel keeps every message as a tombstone", async () => {
    say("user", "one");
    say("friend", "two");
    app.store.clearMessages(story.id);
    expect(app.store.getMessages(story.id)).toEqual([]);
    expect(app.store.lastMessage(story.id)).toBeUndefined();
    const count = app.store.db.query("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(story.id) as { n: number };
    expect(count.n).toBe(2);
  });
});

describe("regenerating keeps the old reply as an alternate", () => {
  test("twice: each reply keeps the ones before it", async () => {
    say("user", "I knock.");
    fake.replies.push({ content: "First reply." }, { content: "Second reply." }, { content: "Third reply." });
    await call("POST", `/api/channels/${story.id}/turn`, {});
    await call("POST", `/api/channels/${story.id}/regenerate`, {});
    const { data } = await call("POST", `/api/channels/${story.id}/regenerate`, {});
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["I knock.", "Third reply."]);
    const newest = data.friendMessages[0];
    expect(newest.alternates).toBe(1);
    const history = app.store.history(newest.id);
    expect(history.alternates.map((m) => m.content)).toEqual(["First reply.", "Second reply."]);
    // The prompt for the regeneration never saw the reply it replaced.
    expect(JSON.stringify(fake.requests[2]!.messages)).not.toContain("Second reply.");
  });
});

describe("the intervention log", () => {
  test("records what you do to your friend's messages, and only that", async () => {
    const yours = say("user", "I wave.");
    const theirs = say("friend", "*Ilse turns.*");
    app.store.editMessage(yours.id, "I wave, soaked.");
    app.store.editMessage(theirs.id, "*Ilse turns, frowning.*", "friend");
    expect(app.store.interventions.recent()).toEqual([]);

    await call("PATCH", `/api/messages/${theirs.id}`, { content: "*Ilse turns and smiles.*" });
    fake.replies.push({ content: "Again." });
    await call("POST", `/api/channels/${story.id}/regenerate`, {});
    const last = app.store.lastMessage(story.id)!;
    await call("DELETE", `/api/messages/${last.id}`, {});
    expect(app.store.interventions.recent().map((e) => e.kind)).toEqual(["delete", "regenerate", "edit"]);
    expect(app.store.interventions.recent()[0]!.summary).toContain("deleted your message in #story");
  });

  test("records changes to who your friend is and how they write, not other settings", async () => {
    await call("PUT", "/api/settings", { friendPrompt: "You are Arlo, a lighthouse romantic.", historyLimit: 30 });
    const { data } = await call("GET", "/api/interventions");
    expect(data.interventions.map((e: { summary: string }) => e.summary)).toEqual(["The user changed your identity (who you are)."]);
  });

  test("clearing a channel with your friend's messages in it", async () => {
    say("friend", "hello");
    app.store.clearMessages(story.id);
    expect(app.store.interventions.recent()[0]!.summary).toBe("The user cleared every message in #story.");
  });
});

describe("your friend's tools", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = { store: app.store, channel: story, mode: "post" };
  });
  const run = (name: string, args: Record<string, unknown> = {}) => runTool(ctx, name, args);

  test("edit_my_message: their latest, or one they quote; never yours", async () => {
    say("friend", "The lamp is lit.");
    say("user", "The lamp is warm.");
    say("friend", "Tea?");
    expect(await run("edit_my_message", { new_text: "Tea? Or something stronger?" })).toMatchObject({ ok: true });
    expect(await run("edit_my_message", { quote: "lamp is lit", new_text: "The lamp is lit, barely." })).toMatchObject({ ok: true });
    expect(app.store.getMessages(story.id).map((m) => m.content)).toEqual(["The lamp is lit, barely.", "The lamp is warm.", "Tea? Or something stronger?"]);
    // Only their own messages are searched.
    expect(await run("edit_my_message", { quote: "lamp is warm", new_text: "x" })).toMatchObject({ ok: false });
  });

  test("delete_my_message", async () => {
    say("friend", "Oops, wrong channel.");
    expect(await run("delete_my_message", {})).toMatchObject({ ok: true });
    expect(app.store.getMessages(story.id)).toEqual([]);
  });

  test("read_message_history shows versions and who wrote them", async () => {
    const m = say("friend", "Original.");
    app.store.editMessage(m.id, "Edited by the user.");
    const outcome = await run("read_message_history", { quote: "Edited by" });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      written_by: "you",
      text_now: "Edited by the user.",
      versions: [
        { by: "you", text: "Original." },
        { by: "the user", text: "Edited by the user." },
      ],
    });
  });

  test("read_interventions", async () => {
    expect((await run("read_interventions")).result).toMatchObject({ note: "Nothing yet." });
    const m = say("friend", "hi");
    app.store.deleteMessage(m.id);
    expect((await run("read_interventions")).result).toEqual([{ when: "just now", what: 'The user deleted your message in #story: "hi"' }]);
  });

  test("they're offered in a turn, and an edit through a real turn works", async () => {
    say("friend", "Its a storm.", ooc);
    fake.replies.push({ toolCalls: [{ name: "edit_my_message", arguments: { new_text: "It's a storm." } }] }, { content: "(fixed a typo)" });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    const names = fake.requests[0]!.tools!.map((t: { function: { name: string } }) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["edit_my_message", "delete_my_message", "read_message_history", "read_interventions"]));
    expect(app.store.getMessages(ooc.id)[0]).toMatchObject({ content: "It's a storm.", editedBy: "friend" });
  });
});

describe("the prompt", () => {
  test("has one honest note about edits, and no markers on edited messages", async () => {
    const m = say("friend", "Before.");
    app.store.editMessage(m.id, "After.");
    const system = promptForChannel(app.store, story.id, { profile: app.store.profiles.list()[0] })[0]!.content;
    expect(system).toContain("## Good to know");
    expect(system).toContain("The user sometimes edits or regenerates messages, including yours.");
    expect(system).toContain("read_message_history");
    const history = JSON.stringify(promptForChannel(app.store, story.id).slice(1));
    expect(history).toContain("After.");
    expect(history).not.toMatch(/edited/i);
  });

  test("without tools, the note doesn't mention them", async () => {
    const system = promptForChannel(app.store, story.id)[0]!.content;
    expect(system).toContain("The user sometimes edits or regenerates messages");
    expect(system).not.toContain("read_message_history");
  });
});

describe("the API", () => {
  test("GET /api/messages/:id/history", async () => {
    const m = say("user", "one");
    await call("PATCH", `/api/messages/${m.id}`, { content: "two" });
    const { data } = await call("GET", `/api/messages/${m.id}/history`);
    expect(data.revisions.map((r: { content: string }) => r.content)).toEqual(["one", "two"]);
    expect(data.alternates).toEqual([]);
  });

  test("a deleted message can't be edited or deleted again", async () => {
    const m = say("user", "one");
    await call("DELETE", `/api/messages/${m.id}`, {});
    expect((await call("PATCH", `/api/messages/${m.id}`, { content: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/messages/${m.id}`, {})).status).toBe(404);
  });
});

describe("wording files", () => {
  test("sections by name; text before the first is ignored", async () => {
    expect(parseSections("# Notes\nfor people\n\n## one\n\nFirst.\n\n## two\nSecond\nline.\n")).toEqual({ one: "First.", two: "Second\nline." });
  });
});
