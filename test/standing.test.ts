/**
 * Tests for rebuild stage 8: standing permissions (src/standing.ts) and
 * retirement (archiving a friend, in src/hub.ts).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickProfile, promptForChannel } from "../src/friend.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  hub = createHub(testConfig(dir.path, fake.baseUrl, { groupDelayMs: 0 }));
  hub.apps.get("home")!.store.appState.set("orientation.pending", null);
});

afterEach(() => {
  hub.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await hub.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
}

const home = () => hub.apps.get("home")!;
const channels = () => home().store.listChannels() as [Channel, Channel];
const ctx = (channel = channels()[1]): ToolContext => ({ store: home().store, channel, mode: "post", turn: { consults: 0 } });

describe("standing permissions", () => {
  test("deleting channels themselves: only once you've granted it, logged, and in their prompt", async () => {
    const [story, ooc] = channels();
    expect(toolSpecs(ctx()).map((t) => t.function.name)).not.toContain("delete_channel");
    const { data } = await call("PUT", "/api/permissions/delete-channels", { granted: true });
    expect(data.permissions.find((p: any) => p.key === "delete-channels").granted).toBe(true);
    expect(home().store.interventions.recent()[0]!.summary).toContain("gave you standing permission to: Delete their channels");
    const prompt = promptForChannel(home().store, ooc.id, { profile: pickProfile(home().store, ooc) })[0]!.content;
    expect(prompt).toContain("You may delete channels yourself");
    expect((await runTool(ctx(), "delete_channel", { channel: "#ooc" })).ok).toBe(false); // the one they're in
    expect((await runTool(ctx(), "delete_channel", { channel: "#story", reason: "finished" })).ok).toBe(true);
    expect(home().store.hasChannel(story.id)).toBe(false);
    await call("PUT", "/api/permissions/delete-channels", { granted: false });
    expect(home().store.interventions.recent()[0]!.summary).toContain("took back");
    expect((await call("PUT", "/api/permissions/nonsense", { granted: true })).status).toBe(400);
  });

  test("editing your notebook entries directly instead of suggesting", async () => {
    const store = home().store;
    const entry = store.notebook.createEntry("user", { kind: "character", name: "Kestrel", fields: [] });
    store.notebook.updateEntrySettings("user", entry.id, { editing: "suggest" });
    expect(store.notebook.getEntry("friend", entry.id).access.edit).toBe("suggest");
    await call("PUT", "/api/permissions/edit-notebook", { granted: true });
    expect(store.notebook.getEntry("friend", entry.id).access.edit).toBe("direct");
    store.notebook.editEntry("friend", entry.id, { name: "Kestrel Vane" });
    expect(store.notebook.getEntry("user", entry.id).name).toBe("Kestrel Vane");
    // Locked stays locked.
    store.notebook.updateEntrySettings("user", entry.id, { editing: "locked" });
    expect(store.notebook.getEntry("friend", entry.id).access.edit).toBe("none");
  });
});

describe("retirement", () => {
  test("archived with a last note, set aside whole, and restored as they were", async () => {
    const { data: made } = await call("POST", `/api/hub/servers/${(await call("GET", "/api/hub")).data.servers[0].id}/friends`, { name: "Wren" });
    const wren = made.friendId;
    hub.apps.get(wren)!.store.appState.set("orientation.pending", null);
    const ooc = hub.apps.get(wren)!.store.listChannels().find((c) => c.kind === "ooc")!;
    hub.apps.get(wren)!.store.addTurn([{ channelId: ooc.id, author: "user", content: "REMEMBER-THIS" }]);

    fake.replies.push({ content: "Thank you for all of it. Wake me for the next storm." });
    const { data } = await call("POST", `/api/hub/friends/${wren}/archive`, {});
    expect(data.note).toBe("Thank you for all of it. Wake me for the next storm.");
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("The user is archiving you");
    expect(data.archived).toMatchObject([{ id: wren, name: "Wren", note: "Thank you for all of it. Wake me for the next storm." }]);
    expect(hub.apps.has(wren)).toBe(false);
    expect(data.servers.flatMap((s: any) => s.friends.map((f: any) => f.id))).toEqual(["home"]);
    expect((await call("GET", `/p/${wren}/api/state`)).status).toBe(404);

    // Restored, with everything they remembered.
    const serverId = data.servers[0].id;
    const restored = await call("POST", `/api/hub/friends/${wren}/restore`, { serverId });
    expect(restored.data.archived).toEqual([]);
    expect(hub.apps.get(wren)!.store.getMessages(ooc.id).map((m) => m.content)).toContain("REMEMBER-THIS");
  });

  test("the last friend can't be archived; an archived friend can be deleted for good", async () => {
    expect((await call("POST", "/api/hub/friends/home/archive", {})).status).toBe(400);
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    const wren = (await call("POST", `/api/hub/servers/${serverId}/friends`, { name: "Wren" })).data.friendId;
    fake.replies.push({ content: "[nothing]" });
    expect((await call("POST", `/api/hub/friends/${wren}/archive`, {})).data.note).toBe("");
    const { data } = await call("DELETE", `/api/hub/friends/${wren}`, {});
    expect(data.archived).toEqual([]);
  });
});
