/**
 * Tests for the notebook (src/notebook.ts) and the example character:
 * entries, folders, suggestions, pins, and what reaches your friend's
 * prompt, each checked from both your side and your friend's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionError, NotFoundError, ValidationError } from "../src/errors.ts";
import { linkedNames, type Notebook } from "../src/notebook.ts";
import { HIDDEN_NAME } from "../src/permissions.ts";
import { defaultCharacter, Store } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;
let notebook: Notebook;
let story: string;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
  notebook = store.notebook;
  story = store.listChannels()[0]!.id;
  // Start from an empty notebook, without the example character.
  for (const entry of notebook.listEntries("user")) store.db.query("DELETE FROM notebook_entries WHERE id = ?").run(entry.id);
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

/** Make an entry as you, for whoever owns it. */
const make = (input: Record<string, unknown>) => notebook.createEntry("user", { kind: "character", ...input });

/** Make an entry as your friend (as their tools will in stage 6). */
const friendMakes = (input: Record<string, unknown>) => notebook.createEntry("friend", { kind: "character", ...input });

describe("entries", () => {
  test("start from their kind's template", () => {
    expect(make({ name: "Kestrel" }).fields.map((f) => f.label)).toEqual([
      "Pronouns",
      "Age",
      "Appearance",
      "Personality",
      "Background",
      "Speech",
    ]);
    expect(make({ name: "The Sea", kind: "lore" }).fields.map((f) => f.label)).toEqual(["Summary", "Details"]);
  });

  test("are yours unless you say otherwise; you can make them for your friend or share them", () => {
    expect(make({ name: "A" }).owner).toBe("user");
    expect(make({ name: "B", owner: "friend" }).owner).toBe("friend");
    expect(make({ name: "C", owner: "joint" }).owner).toBe("joint");
  });

  test("your friend can't make entries that are yours", () => {
    expect(() => friendMakes({ name: "Mine", owner: "user" })).toThrow(ValidationError);
  });

  test("only the owner picks visibility and editing when making one", () => {
    expect(() => make({ name: "Secret", owner: "friend", visibility: "hidden" })).toThrow(PermissionError);
  });

  test("need a name, and a valid kind", () => {
    expect(() => make({ name: "  " })).toThrow(/can't be empty/);
    expect(() => make({ name: "X", kind: "place" })).toThrow(/kind must be/);
  });
});

describe("visibility", () => {
  test("an entry hidden from you doesn't exist, as far as you can tell", () => {
    const secret = friendMakes({ name: "The Stranger", visibility: "hidden" });
    expect(notebook.listEntries("user")).toEqual([]);
    expect(() => notebook.getEntry("user", secret.id)).toThrow(NotFoundError);
    expect(notebook.listEntries("friend").map((e) => e.name)).toEqual(["The Stranger"]);
  });

  test("an entry you hide from your friend is hidden from them", () => {
    make({ name: "My Twist", visibility: "hidden" });
    expect(notebook.listEntries("friend")).toEqual([]);
  });

  test("entries take their folder's visibility", () => {
    const folder = notebook.createFolder("friend", { name: "Plans", visibility: "hidden" });
    friendMakes({ name: "Ambush", folderId: folder.id });
    expect(notebook.listEntries("user")).toEqual([]);
    expect(notebook.listFolders("user")).toEqual([]);
  });

  test("the owner can reveal an entry", () => {
    const secret = friendMakes({ name: "The Stranger", visibility: "hidden" });
    notebook.updateEntrySettings("friend", secret.id, { visibility: "visible" });
    expect(notebook.getEntry("user", secret.id).name).toBe("The Stranger");
  });
});

describe("editing", () => {
  test("open entries of your friend's are yours to edit directly", () => {
    const ilse = make({ name: "Ilse", owner: "friend" });
    expect(notebook.editEntry("user", ilse.id, { name: "Ilse Marrow" })).toMatchObject({ entry: { name: "Ilse Marrow" } });
  });

  test("suggest-only entries turn your edit into a suggestion", () => {
    const ilse = friendMakes({ name: "Ilse", editing: "suggest" });
    const result = notebook.editEntry("user", ilse.id, { name: "Ilse Marrow" });
    expect(result).toMatchObject({ suggestion: { author: "user", change: { name: "Ilse Marrow" }, status: "pending" } });
    expect(notebook.getEntry("user", ilse.id).name).toBe("Ilse");
  });

  test("locked entries can't be changed by the other person", () => {
    const ilse = friendMakes({ name: "Ilse", editing: "locked" });
    expect(() => notebook.editEntry("user", ilse.id, { name: "X" })).toThrow(PermissionError);
    expect(notebook.getEntry("user", ilse.id).access).toEqual({ edit: "none", settings: false, delete: false });
  });

  test("only the owner changes an entry's settings", () => {
    const ilse = make({ name: "Ilse", owner: "friend" });
    expect(() => notebook.updateEntrySettings("user", ilse.id, { editing: "locked" })).toThrow(PermissionError);
    expect(notebook.updateEntrySettings("friend", ilse.id, { editing: "locked" }).settings.editing).toBe("locked");
  });

  test("the owner can give an entry away, and then it's out of their hands", () => {
    const kit = make({ name: "Kit" });
    expect(notebook.updateEntrySettings("user", kit.id, { owner: "friend" }).owner).toBe("friend");
    expect(() => notebook.updateEntrySettings("user", kit.id, { owner: "user" })).toThrow(PermissionError);
  });

  test("shared lore's settings are fixed", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    expect(() => notebook.updateEntrySettings("user", sea.id, { visibility: "hidden" })).toThrow(/fixed/);
  });
});

describe("suggestions", () => {
  test("shared lore: whoever didn't suggest a change reviews it", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("friend", sea.id, { name: "The Charted Sea" }) as { suggestion: { id: string } };

    expect(() => notebook.reviewSuggestion("friend", suggestion.id, "accepted")).toThrow(PermissionError);
    notebook.reviewSuggestion("user", suggestion.id, "accepted");
    expect(notebook.getEntry("user", sea.id).name).toBe("The Charted Sea");
    expect(notebook.listSuggestions("user")).toEqual([]);
  });

  test("a rejected suggestion changes nothing, and can't be reviewed twice", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("friend", sea.id, { name: "X" }) as { suggestion: { id: string } };
    notebook.reviewSuggestion("user", suggestion.id, "rejected");
    expect(notebook.getEntry("user", sea.id).name).toBe("The Sea");
    expect(() => notebook.reviewSuggestion("user", suggestion.id, "accepted")).toThrow(/already been dealt with/);
  });

  test("only whoever made a suggestion can withdraw it", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    const { suggestion } = notebook.editEntry("user", sea.id, { name: "X" }) as { suggestion: { id: string } };
    expect(() => notebook.withdrawSuggestion("friend", suggestion.id)).toThrow(PermissionError);
    notebook.withdrawSuggestion("user", suggestion.id);
    expect(notebook.listSuggestions("user")).toEqual([]);
  });
});

describe("deleting", () => {
  test("you delete your own entries straight away", () => {
    const kit = make({ name: "Kit" });
    expect(notebook.deleteEntry("user", kit.id)).toEqual({ deleted: true });
    expect(notebook.listEntries("user")).toEqual([]);
  });

  test("your friend deletes their own entries straight away", () => {
    const stranger = friendMakes({ name: "The Stranger" });
    expect(notebook.deleteEntry("friend", stranger.id)).toEqual({ deleted: true });
  });

  test("deleting the other person's entry is a suggestion for its owner", () => {
    const ilse = make({ name: "Ilse", owner: "friend" });
    const mine = notebook.deleteEntry("user", ilse.id) as { suggestion: { id: string } };
    expect(notebook.waitingFor("friend").map((s) => s.id)).toEqual([mine.suggestion.id]);

    const kit = make({ name: "Kit" });
    make({ name: "Jun" });
    const theirs = notebook.deleteEntry("friend", kit.id) as { suggestion: { id: string } };
    expect(theirs).toMatchObject({ suggestion: { change: { delete: true } } });
    expect(() => notebook.reviewSuggestion("friend", theirs.suggestion.id, "accepted")).toThrow(PermissionError);

    // Accepting the suggestion deletes it.
    notebook.reviewSuggestion("user", theirs.suggestion.id, "accepted");
    expect(notebook.listEntries("user").map((e) => e.name)).toEqual(["Ilse", "Jun"]);
  });

  test("deleting shared lore is a suggestion", () => {
    const sea = make({ name: "The Sea", kind: "lore", owner: "joint" });
    expect(notebook.deleteEntry("user", sea.id)).toMatchObject({ suggestion: { change: { delete: true } } });
  });
});

describe("folders", () => {
  test("deleting a folder keeps its entries", () => {
    const folder = notebook.createFolder("user", { name: "Old" });
    const kit = make({ name: "Kit", folderId: folder.id });
    notebook.deleteFolder("user", folder.id);
    expect(notebook.getEntry("user", kit.id).folderId).toBeNull();
  });

  test("only the folder's owner changes it", () => {
    const folder = notebook.createFolder("friend", { name: "Theirs" });
    expect(() => notebook.updateFolder("user", folder.id, { name: "Mine" })).toThrow(PermissionError);
    expect(() => notebook.deleteFolder("user", folder.id)).toThrow(PermissionError);
  });
});

describe("proxy prefixes", () => {
  test("are only for your characters, and can't be shared between them", () => {
    make({ name: "Kestrel", proxyPrefix: "k" });
    expect(() => make({ name: "Kit", proxyPrefix: "K" })).toThrow(/already uses the prefix/);
    expect(() => make({ name: "Ilse", owner: "friend", proxyPrefix: "i" })).toThrow(/Only characters you play/);
    expect(() => make({ name: "Jun", proxyPrefix: "j j" })).toThrow(/no spaces or colons/);
  });

  test("work on shared characters too, and you set them directly, not by suggestion", () => {
    const bo = make({ name: "Bo", owner: "joint", proxyPrefix: "b" });
    expect(bo.proxyPrefix).toBe("b");
    expect(notebook.postableCharacters().map((c) => c.name)).toEqual(["Bo"]);

    // Changing only the prefix saves at once...
    expect(notebook.editEntry("user", bo.id, { proxyPrefix: "bo" })).toMatchObject({ entry: { proxyPrefix: "bo" } });
    // ...while a change to the rest is still a suggestion.
    const result = notebook.editEntry("user", bo.id, { name: "Bo Tern", proxyPrefix: "t" });
    expect(result).toMatchObject({ suggestion: { change: { name: "Bo Tern" } } });
    expect(notebook.getEntry("user", bo.id)).toMatchObject({ name: "Bo", proxyPrefix: "t" });
  });

  test("are kept when a character of yours becomes shared", () => {
    const kestrel = make({ name: "Kestrel", proxyPrefix: "k" });
    expect(notebook.updateEntrySettings("user", kestrel.id, { owner: "joint" }).proxyPrefix).toBe("k");
  });

  test("are dropped when a character is given away", () => {
    const kestrel = make({ name: "Kestrel", proxyPrefix: "k" });
    expect(notebook.updateEntrySettings("user", kestrel.id, { owner: "friend" }).proxyPrefix).toBeNull();
  });
});

describe("the cast", () => {
  test("is the pinned entries, in the order they were pinned, with who plays each", () => {
    const ilse = make({ name: "Ilse", owner: "friend" });
    const kit = make({ name: "Kit" });
    const bo = make({ name: "Bo", owner: "joint" });
    notebook.pin("user", story, kit.id);
    notebook.pin("user", story, ilse.id);
    notebook.pin("user", story, bo.id);
    notebook.pin("user", story, kit.id); // already pinned: no change
    expect(notebook.castFor("user", story).map((c) => [c.name, c.playedBy])).toEqual([
      ["Kit", "user"],
      ["Ilse", "friend"],
      ["Bo", "both"],
    ]);
  });

  test("shows entries hidden from you as ??? (hidden), and you can still unpin them", () => {
    const stranger = friendMakes({ name: "The Stranger", visibility: "hidden" });
    notebook.pin("friend", story, stranger.id);
    expect(notebook.castFor("user", story)).toEqual([
      { entryId: stranger.id, name: HIDDEN_NAME, playedBy: "friend", owner: "friend", hidden: true, proxyPrefix: null, kind: "character" },
    ]);
    expect(notebook.castFor("friend", story)[0]!.name).toBe("The Stranger");

    // You can't pin what you can't see, but you can unpin it.
    expect(() => notebook.pin("user", story, stranger.id)).toThrow(NotFoundError);
    notebook.unpin("user", story, stranger.id);
    expect(notebook.castFor("user", story)).toEqual([]);
  });

  test("deleting an entry unpins it everywhere", () => {
    const kit = make({ name: "Kit" });
    notebook.pin("user", story, kit.id);
    notebook.deleteEntry("user", kit.id);
    expect(notebook.castFor("user", story)).toEqual([]);
  });
});

describe("what your friend's prompt gets", () => {
  test("pinned entries they can see, marked if they're hidden from you", () => {
    const stranger = friendMakes({ name: "The Stranger", visibility: "hidden" });
    const twist = make({ name: "My Twist", kind: "lore", visibility: "hidden" });
    const ilse = make({ name: "Ilse", owner: "friend" });
    for (const entry of [stranger, twist, ilse]) store.db.query("INSERT INTO channel_cast VALUES (?, ?, 0)").run(story, entry.id);

    const { pinned } = notebook.forPrompt(story);
    expect(pinned.map((p) => [p.entry.name, p.hiddenFromUser])).toEqual([
      ["Ilse", false],
      ["The Stranger", true],
    ]);
  });

  test("entries linked from pinned ones, one step deep", () => {
    const sea = make({ name: "The Sea", kind: "lore", fields: [{ label: "Summary", value: "Home of [[The Wreck]]." }] });
    make({ name: "The Wreck", kind: "lore", fields: [{ label: "Summary", value: "Near [[The Reef]]." }] });
    make({ name: "The Reef", kind: "lore" });
    const ilse = make({ name: "Ilse", owner: "friend", systemPrompt: "She fears [[the sea|the water]]. [[Nobody]]" });
    notebook.pin("user", story, ilse.id);
    notebook.pin("user", story, sea.id);

    const { pinned, linked } = notebook.forPrompt(story);
    expect(pinned.map((p) => p.entry.name)).toEqual(["Ilse", "The Sea"]);
    // The Sea is already pinned, so only The Wreck is added; The Reef is two steps away.
    expect(linked.map((p) => p.entry.name)).toEqual(["The Wreck"]);
  });

  test("links never reveal what's hidden from your friend", () => {
    make({ name: "My Twist", kind: "lore", visibility: "hidden" });
    const ilse = make({ name: "Ilse", owner: "friend", systemPrompt: "See [[My Twist]]." });
    notebook.pin("user", story, ilse.id);
    expect(notebook.forPrompt(story).linked).toEqual([]);
  });

  test("the OOC overview has everything they can see", () => {
    make({ name: "My Twist", visibility: "hidden" });
    friendMakes({ name: "The Stranger", visibility: "hidden" });
    expect(notebook.friendOverview().map((p) => [p.entry.name, p.hiddenFromUser])).toEqual([["The Stranger", true]]);
  });
});

describe("linkedNames", () => {
  test("finds [[Name]] and [[Name|shown text]] links, once each", () => {
    const entry = { systemPrompt: "[[A]] and [[B|bee]]", fields: [{ label: "x", value: "[[A]], [[ C ]]" }] };
    expect(linkedNames(entry)).toEqual(["A", "B", "C"]);
  });
});

describe("the example character", () => {
  test("is read from defaults/character.md, one labelled line per field", () => {
    const character = defaultCharacter();
    expect(character.name).toBe("Ilse Marrow");
    expect(character.fields[0]).toEqual({ label: "Age", value: "34" });
    expect(character.fields.map((f) => f.label)).toContain("Speech");
    expect(character.fields.some((f) => f.label === "Name")).toBe(false);
  });
});
