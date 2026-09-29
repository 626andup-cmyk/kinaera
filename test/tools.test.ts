/**
 * Tests for your friend's tools (src/tools.ts), run directly against a
 * store: each tool's effect, permissions applied as your friend, and
 * mistakes explained back to the model instead of thrown.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store.ts";
import { runTool, TOOL_NAMES, toolSpecs, type ToolContext } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;
let ctx: ToolContext;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
  ctx = { store, channel: store.listChannels()[0]!, mode: "post" };
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

const run = (name: string, args: Record<string, unknown> = {}) => runTool(ctx, name, args);
const oocContext = (): ToolContext => ({ store, channel: store.listChannels()[1]!, mode: "post" });

describe("offering tools", () => {
  test("every tool has a description and an object schema", async () => {
    for (const spec of toolSpecs(ctx)) {
      expect(spec.function.description.length).toBeGreaterThan(10);
      expect(spec.function.parameters.type).toBe("object");
    }
  });

  test("starting a scene is only offered in roleplay channels, and not when replying to a comment", async () => {
    const names = (c: ToolContext) => toolSpecs(c).map((t) => t.function.name);
    expect(names(ctx)).toContain("start_new_scene");
    expect(names(oocContext())).not.toContain("start_new_scene");
    expect(names({ ...ctx, mode: "comment" })).not.toContain("start_new_scene");
    expect(TOOL_NAMES).toContain("do_nothing");
  });

  test("an unknown tool is explained, listing the real ones", async () => {
    const outcome = await run("delete_everything");
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.summary).toMatch(/no tool called "delete_everything".*read_notebook_entry/);
  });
});

describe("reading the notebook", () => {
  test("reads an entry in full, by name, ignoring case", async () => {
    const outcome = await run("read_notebook_entry", { name: "ilse marrow" });
    expect(outcome).toMatchObject({ ok: true, summary: "read Ilse Marrow" });
    expect(outcome.result).toMatchObject({ name: "Ilse Marrow", kind: "character", owner: "yours", pinned_in: ["#story"] });
    expect((outcome.result as { fields: Record<string, string> }).fields.Age).toBe("34");
  });

  test("finds an entry by part of its name, and [[links]] work too", async () => {
    expect((await run("read_notebook_entry", { name: "Ilse" })).ok).toBe(true);
    expect((await run("read_notebook_entry", { name: "[[Ilse Marrow]]" })).ok).toBe(true);
  });

  test("never reads what's hidden from your friend, and lists what exists instead", async () => {
    store.notebook.createEntry("user", { kind: "lore", name: "My Twist", visibility: "hidden" });
    const outcome = await run("read_notebook_entry", { name: "My Twist" });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("no notebook entry called");
    expect(outcome.summary).toContain("Ilse Marrow");
    expect(outcome.summary).not.toContain("My Twist.");
  });

  test("searches by word", async () => {
    store.notebook.createEntry("user", { kind: "lore", name: "The Charted Sea", fields: [{ label: "Summary", value: "Cold." }] });
    const outcome = await run("search_notebook", { query: "cold" });
    expect(outcome.result).toMatchObject([{ name: "The Charted Sea", owner: "the user's" }]);
  });
});

describe("changing the notebook", () => {
  test("makes an entry of their own, optionally hidden and pinned here", async () => {
    const outcome = await run("create_notebook_entry", {
      kind: "character",
      name: "The Stranger",
      fields: { Appearance: "Soaked." },
      hidden_from_user: true,
      pin_here: true,
    });
    expect(outcome).toMatchObject({ ok: true, summary: "made The Stranger (character, hidden)" });
    expect(store.notebook.listEntries("user").map((e) => e.name)).not.toContain("The Stranger");
    expect(store.notebook.castFor("user", ctx.channel.id).map((c) => c.name)).toContain("??? (hidden)");
  });

  test("edits their own entries directly, merging fields", async () => {
    const outcome = await run("edit_notebook_entry", { name: "Ilse Marrow", fields: { Age: "35", Speech: "", Scar: "Left hand." } });
    expect(outcome).toMatchObject({ ok: true, summary: "edited Ilse Marrow" });
    const fields = store.notebook.listEntries("friend")[0]!.fields;
    expect(fields.find((f) => f.label === "Age")!.value).toBe("35");
    expect(fields.some((f) => f.label === "Speech")).toBe(false);
    expect(fields.at(-1)).toEqual({ label: "Scar", value: "Left hand." });
  });

  test("changing shared lore is a suggestion for you", async () => {
    store.notebook.createEntry("user", { kind: "lore", name: "The Light", owner: "joint" });
    const outcome = await run("edit_notebook_entry", { name: "The Light", new_name: "The Lamp" });
    expect(outcome).toMatchObject({ ok: true, summary: "suggested a change to The Light" });
    expect(store.notebook.waitingFor("user")).toHaveLength(1);
  });

  test("locked entries of yours are refused, with the reason", async () => {
    store.notebook.createEntry("user", { kind: "character", name: "Kestrel", editing: "locked" });
    expect(await run("edit_notebook_entry", { name: "Kestrel", new_name: "Kes" })).toMatchObject({
      ok: false,
      summary: "This entry is locked.",
    });
  });

  test("deletes their own entries, and suggests deleting yours", async () => {
    await run("create_notebook_entry", { kind: "lore", name: "Old idea" });
    expect(await run("delete_notebook_entry", { name: "Old idea" })).toMatchObject({ summary: "deleted Old idea" });
    store.notebook.createEntry("user", { kind: "character", name: "Kestrel" });
    expect(await run("delete_notebook_entry", { name: "Kestrel" })).toMatchObject({ summary: "suggested deleting Kestrel" });
    expect(store.notebook.listEntries("user").map((e) => e.name)).toContain("Kestrel");
  });

  test("hides and reveals their own entries", async () => {
    expect((await run("set_entry_visibility", { name: "Ilse Marrow", visibility: "hidden" })).summary).toBe("hid Ilse Marrow");
    expect(store.notebook.listEntries("user")).toEqual([]);
    expect((await run("set_entry_visibility", { name: "Ilse Marrow", visibility: "visible" })).summary).toBe("revealed Ilse Marrow");
  });

  test("reviews your suggestions by short id", async () => {
    const ilse = store.notebook.listEntries("user")[0]!;
    store.notebook.updateEntrySettings("friend", ilse.id, { editing: "suggest" });
    const { suggestion } = store.notebook.editEntry("user", ilse.id, { name: "Ilse M." }) as { suggestion: { id: string } };
    const outcome = await run("review_suggestion", { id: suggestion.id.slice(0, 8), decision: "accept" });
    expect(outcome).toMatchObject({ ok: true, summary: "accepted the user's suggestion for Ilse Marrow" });
    expect(store.notebook.listEntries("user")[0]!.name).toBe("Ilse M.");
    expect((await run("review_suggestion", { id: "nope", decision: "accept" })).ok).toBe(false);
  });
});

describe("the cast and channels", () => {
  test("pins and unpins, here or in another channel", async () => {
    await run("create_notebook_entry", { kind: "character", name: "Tamsin" });
    expect((await run("pin_to_channel", { name: "Tamsin" })).summary).toBe("pinned Tamsin to #story");
    expect((await run("pin_to_channel", { name: "Tamsin", channel: "#ooc" })).summary).toBe("pinned Tamsin to #ooc");
    expect((await run("unpin_from_channel", { name: "Tamsin" })).summary).toBe("unpinned Tamsin from #story");
    expect((await run("pin_to_channel", { name: "Tamsin", channel: "#nowhere" })).summary).toMatch(/no channel called #nowhere/);
  });

  test("makes, renames and moves channels", async () => {
    expect((await run("create_channel", { name: "#heist", kind: "roleplay", style: "casual", cast: ["Ilse Marrow"] })).summary).toBe(
      "made #heist",
    );
    const heist = store.listChannels().find((c) => c.name === "heist")!;
    expect(heist.mode).toBe("casual");
    expect(store.notebook.castFor("user", heist.id).map((c) => c.name)).toEqual(["Ilse Marrow"]);
    expect((await run("rename_channel", { channel: "heist", new_name: "the-heist" })).summary).toBe("renamed #heist to #the-heist");
    expect((await run("move_channel", { channel: "#the-heist", position: 1 })).summary).toBe("moved #the-heist to place 1");
    expect(store.listChannels()[0]!.name).toBe("the-heist");
  });

  test("starts a new scene in this channel", async () => {
    expect((await run("start_new_scene", { title: "Dawn" })).summary).toBe('started a new scene, "Dawn"');
    expect(store.lastMessage(ctx.channel.id)).toMatchObject({ kind: "scene_break", content: "Dawn", author: "friend" });
  });

  test("can only propose deleting a channel, once", async () => {
    expect((await run("propose_channel_deletion", { channel: "#story", reason: "Finished." })).summary).toBe("proposed deleting #story");
    await run("propose_channel_deletion", { channel: "#story" });
    expect(store.inbox.openProposals()).toMatchObject([{ targetName: "story", text: "Finished." }]);
    expect(store.listChannels()).toHaveLength(2);
  });
});

describe("comments", () => {
  test("comments on a quoted phrase in the newest message containing it", async () => {
    store.addMessage({ channelId: ctx.channel.id, author: "user", content: "I *knock twice* on the door." });
    const outcome = await run("comment_on_message", { quote: "knock twice", note: "Love the rhythm." });
    expect(outcome).toMatchObject({ ok: true, summary: 'commented on "knock twice"' });
    const [thread] = store.comments.forChannel(ctx.channel.id);
    expect(thread).toMatchObject({ quote: "knock twice", comments: [{ author: "friend", note: "Love the rhythm." }] });
    expect((await run("comment_on_message", { quote: "never said", note: "x" })).summary).toMatch(/No recent message/);
  });

  test("replies to and resolves threads by short id", async () => {
    const message = store.addMessage({ channelId: ctx.channel.id, author: "friend", content: "The lamp guttered." });
    const thread = store.comments.start("user", message.id, "Ominous!", "lamp guttered");
    const id = thread.id.slice(0, 8);
    expect((await run("reply_to_comment", { thread: id, note: "That's the idea." })).ok).toBe(true);
    expect((await run("resolve_comment", { thread: id })).ok).toBe(true);
    expect(store.comments.thread(thread.id)).toMatchObject({ resolved: true, comments: [{}, { author: "friend" }] });
    expect((await run("reply_to_comment", { thread: "zzzz", note: "x" })).summary).toMatch(/no comment thread/);
  });
});

describe("mistakes", () => {
  test("missing arguments are explained", async () => {
    expect(await run("read_notebook_entry", {})).toMatchObject({ ok: false, summary: '"name" is required, as text.' });
    expect((await run("create_channel", { name: "x", kind: "dm" })).summary).toMatch(/kind" must be roleplay or ooc/);
  });

  test("do_nothing ends the turn", async () => {
    expect(await run("do_nothing", { reason: "Nothing to add." })).toMatchObject({
      ok: true,
      stop: true,
      summary: "chose not to reply (Nothing to add.)",
    });
  });
});
