/**
 * Tests for the hub (src/hub.ts): friends with their own memory, grouped
 * into servers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import { createApp } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  hub = createHub(testConfig(dir.path, fake.baseUrl));
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

describe("starting", () => {
  test("one server with the first friend, living in the data folder", async () => {
    const { data } = await call("GET", "/api/hub");
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].friends.map((p: any) => [p.id, p.name])).toEqual([["home", "Arlo"]]);
    expect(data.servers[0].friends[0].channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect(existsSync(join(dir.path, "kinaera.db"))).toBe(true);
    expect(existsSync(join(dir.path, "hub.json"))).toBe(true);
  });

  test("an existing Kinaera becomes the first friend, unchanged", async () => {
    hub.close();
    const other = tempDir();
    const old = createApp(testConfig(other.path, fake.baseUrl));
    old.store.updateSettings(validateSettings({ friendName: "Mira" }));
    old.store.close();
    hub = createHub(testConfig(other.path, fake.baseUrl));
    expect((await call("GET", "/api/state")).data.settings.friendName).toBe("Mira");
    hub.close();
    other.cleanup();
    hub = createHub(testConfig(dir.path, fake.baseUrl));
  });

  test("unprefixed and /p/<id>/ requests reach the friend", async () => {
    expect((await call("GET", "/api/state")).data.settings.friendName).toBe("Arlo");
    expect((await call("GET", "/p/home/api/state")).data.settings.friendName).toBe("Arlo");
    expect((await call("GET", "/p/nobody/api/state")).status).toBe(404);
  });
});

describe("a new friend", () => {
  test("gets their own server, their own memory, and your profiles and preferences", async () => {
    home().store.updateSettings(validateSettings({ decisionConfidence: 0.9, literaryPrompt: "Arlo's style" }));
    const { data } = await call("POST", "/api/hub/servers", { name: "Wren", prompt: "You are Wren.", avatar: "🐦" });
    const wren = data.friendId as string;
    expect(data.servers).toHaveLength(2);
    expect(existsSync(join(dir.path, "friends", wren, "kinaera.db"))).toBe(true);

    const state = (await call("GET", `/p/${wren}/api/state`)).data;
    expect(state.settings).toMatchObject({ friendName: "Wren", friendPrompt: "You are Wren.", friendAvatar: "🐦", decisionConfidence: 0.9 });
    // Not Arlo's prompts…
    expect(state.settings.literaryPrompt).not.toBe("Arlo's style");
    // …the same connection profiles (same ids, so assignments carry over)…
    expect(state.profiles.map((p: any) => p.id)).toEqual(home().store.profiles.list().map((p) => p.id));
    // …and a clean slate: channels, no example character.
    expect(state.channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect((await call("GET", `/p/${wren}/api/notebook`)).data.entries).toEqual([]);
  });

  test("never sees another friend's notebook or messages", async () => {
    const wren = (await call("POST", "/api/hub/servers", { name: "Wren" })).data.friendId;
    home().store.notebook.createEntry("friend", { kind: "lore", name: "Arlo's secret", visibility: "hidden" });
    const ooc = home().store.listChannels().find((c) => c.kind === "ooc")!;
    home().store.addMessage({ channelId: ooc.id, author: "user", content: "only for Arlo" });
    const wrenApp = hub.apps.get(wren)!;
    expect(wrenApp.store.notebook.listEntries("friend").map((e) => e.name)).toEqual([]);
    expect(wrenApp.store.listChannels().flatMap((c) => wrenApp.store.getMessages(c.id))).toEqual([]);
    // Each friend's turns go to their own prompt.
    const wrenOoc = wrenApp.store.listChannels().find((c) => c.kind === "ooc")!;
    wrenApp.store.addMessage({ channelId: wrenOoc.id, author: "user", content: "hi Wren" });
    await wrenApp.friend.takeTurn(wrenOoc.id, "user-message");
    const prompt = JSON.stringify(fake.requests.at(-1)!.messages);
    expect(prompt).toContain("hi Wren");
    expect(prompt).not.toContain("only for Arlo");
    expect(prompt).not.toContain("Arlo's secret");
  });

  test("several friends in one server", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    const { data } = await call("POST", `/api/hub/servers/${serverId}/friends`, { name: "Wren" });
    expect(data.servers[0].friends.map((p: any) => p.name)).toEqual(["Arlo", "Wren"]);
    // Reorder them, then give Wren a server of her own.
    const reordered = await call("PATCH", `/api/hub/servers/${serverId}`, { friends: [data.friendId, "home"] });
    expect(reordered.data.servers[0].friends.map((p: any) => p.name)).toEqual(["Wren", "Arlo"]);
    const moved = await call("POST", `/api/hub/friends/${data.friendId}/move`, {});
    expect(moved.data.servers.map((s: any) => s.friends.map((p: any) => p.name))).toEqual([["Arlo"], ["Wren"]]);
  });
});

describe("servers", () => {
  test("rename, reorder, and it's all kept", async () => {
    const first = (await call("GET", "/api/hub")).data.servers[0].id;
    const second = (await call("POST", "/api/hub/servers", { name: "Wren", serverName: "Wren's nest" })).data.server.id;
    await call("PATCH", `/api/hub/servers/${first}`, { name: "Home" });
    await call("PUT", "/api/hub/servers/order", { ids: [second, first] });
    hub.close();
    hub = createHub(testConfig(dir.path, fake.baseUrl));
    const { data } = await call("GET", "/api/hub");
    expect(data.servers.map((s: any) => s.name)).toEqual(["Wren's nest", "Home"]);
    expect(hub.apps.size).toBe(2);
  });

  test("deleting moves files to the trash; the last can't go", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    expect((await call("DELETE", `/api/hub/servers/${serverId}`, {})).status).toBe(400);
    expect((await call("DELETE", "/api/hub/friends/home", {})).status).toBe(400);
    const wren = (await call("POST", "/api/hub/servers", { name: "Wren" })).data;
    const gone = await call("DELETE", `/api/hub/servers/${wren.server.id}`, {});
    expect(gone.data.servers).toHaveLength(1);
    expect(existsSync(join(dir.path, "friends", wren.friendId))).toBe(false);
    expect(readdirSync(join(dir.path, "trash")).some((d) => d.startsWith(wren.friendId))).toBe(true);
    // The first friend too (their files move out of the data folder).
    const again = (await call("POST", "/api/hub/servers", { name: "Wren" })).data.friendId;
    await call("DELETE", "/api/hub/friends/home", {});
    expect(existsSync(join(dir.path, "kinaera.db"))).toBe(false);
    // Unprefixed requests now reach the remaining friend.
    expect((await call("GET", "/api/state")).data.settings.friendName).toBe("Wren");
    expect(JSON.parse(readFileSync(join(dir.path, "hub.json"), "utf8")).friends.map((p: any) => p.id)).toEqual([again]);
  });

  test("bad input", async () => {
    expect((await call("POST", "/api/hub/servers", { name: "" })).status).toBe(400);
    expect((await call("PATCH", "/api/hub/servers/nope", { name: "x" })).status).toBe(404);
    expect((await call("PUT", "/api/hub/servers/order", { ids: [] })).status).toBe(400);
    const response = await hub.fetch(new Request("http://localhost/api/hub/servers", { method: "POST", body: "x" }));
    expect(response.status).toBe(415);
  });
});
