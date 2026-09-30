/**
 * Tests for group channels and DMs (rebuild stage 7, src/groups.ts): one
 * channel kept by several friends, each in their own store, with rounds,
 * @mentions, mirrored edits, and DMs you can choose not to see.
 *
 * Three friends share a server here: Arlo (the first), Wren and Sol. Model
 * calls go to one fake nanoGPT; which friend a request is from shows in its
 * prompt ("Your name is …").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptForChannel, pickProfile } from "../src/friend.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { runTool } from "../src/tools.ts";
import type { App } from "../src/server.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;
let serverId: string;
let wren: string;
let sol: string;

beforeEach(async () => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  hub = createHub(testConfig(dir.path, fake.baseUrl, { groupDelayMs: 0 }));
  serverId = (await call("GET", "/api/hub")).data.servers[0].id;
  wren = (await call("POST", `/api/hub/servers/${serverId}/friends`, { name: "Wren", prompt: "Your name is Wren." })).data.friendId;
  sol = (await call("POST", `/api/hub/servers/${serverId}/friends`, { name: "Sol", prompt: "Your name is Sol." })).data.friendId;
  for (const app of hub.apps.values()) app.store.appState.set("orientation.pending", null);
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

const app = (id: string) => hub.apps.get(id)!;
const home = () => app("home");
/** Who each request to the model was from. */
const writers = () => fake.requests.map((r) => (JSON.stringify(r.messages).match(/Your name is (\w+)/)?.[1] ?? "?"));

async function makeGroup(): Promise<string> {
  const { data } = await call("POST", `/api/hub/servers/${serverId}/groups`, { name: "Lounge", friends: ["home", wren, sol] });
  return data.group.id;
}

describe("group channels", () => {
  test("one channel in each member's store, listed with the server, not each friend", async () => {
    const id = await makeGroup();
    for (const f of ["home", wren, sol]) expect(app(f).store.getChannel(id)).toMatchObject({ kind: "group", name: "lounge" });
    const { data } = await call("GET", "/api/hub");
    expect(data.servers[0].groups).toMatchObject([{ id, kind: "group", name: "lounge", friends: ["home", wren, sol] }]);
    expect(data.servers[0].friends[0].channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect((await call("POST", `/api/hub/servers/${serverId}/groups`, { name: "x", friends: ["home"] })).status).toBe(400);
  });

  test("your message starts a round: each friend may write once, seeing the others; doing nothing is fine", async () => {
    const id = await makeGroup();
    fake.replies.push({ content: "FIRST-REPLY" }, { content: "[nothing]" }, { content: "THIRD-REPLY" });
    const { data } = await call("POST", `/p/home/api/channels/${id}/messages`, { content: "hi all" });
    expect(data.friendMessages).toBeUndefined();
    await hub.groups.settle();

    expect(new Set(writers())).toEqual(new Set(["Arlo", "Wren", "Sol"]));
    // The last to go saw what the first wrote.
    expect(JSON.stringify(fake.requests[2]!.messages)).toContain("FIRST-REPLY");
    // Every copy has the same messages, under the same ids.
    const copies = ["home", wren, sol].map((f) => app(f).store.getMessages(id));
    for (const copy of copies) expect(copy.map((m) => m.content)).toEqual(["hi all", "FIRST-REPLY", "THIRD-REPLY"]);
    expect(new Set(copies.map((c) => c[1]!.id)).size).toBe(1);
    // Theirs in their own copy, a peer's everywhere else.
    const firstBy = writers()[0]!;
    const firstId = { Arlo: "home", Wren: wren, Sol: sol }[firstBy]!;
    for (const f of ["home", wren, sol]) {
      const message = app(f).store.getMessages(id)[1]!;
      if (f === firstId) expect(message.author).toBe("friend");
      else expect(message).toMatchObject({ author: "peer", speaker: { id: firstId, name: firstBy } });
    }
  });

  test("an @mention gives one more turn, which can't give another", async () => {
    const id = await makeGroup();
    fake.replies.push({ content: "@Wren thoughts?" }, { content: "@Wren thoughts?" }, { content: "@Wren thoughts?" }, { content: "@Sol and you?" });
    await call("POST", `/p/home/api/channels/${id}/messages`, { content: "what should we write?" });
    await hub.groups.settle();
    expect(writers()).toHaveLength(4);
    expect(writers()[3]).toBe("Wren");
  });

  test("each sees who said what", async () => {
    const id = await makeGroup();
    fake.replies.push({ content: "[nothing]" }, { content: "[nothing]" }, { content: "[nothing]" });
    await call("POST", `/p/home/api/channels/${id}/messages`, { content: "hi all" });
    await hub.groups.settle();
    app(wren).store.addTurn([{ channelId: id, author: "friend", content: "Wren here" }]);
    const prompt = promptForChannel(home().store, id, { profile: pickProfile(home().store, home().store.getChannel(id)), groups: home().friend.groups });
    const text = JSON.stringify(prompt);
    expect(text).toContain("This is a group channel: you, the user, and Wren and Sol.");
    expect(text).toContain("The user: hi all");
    expect(text).toContain("Wren: Wren here");
  });

  test("edits and deletions reach every copy; yours of a friend's message is kept in their history", async () => {
    const id = await makeGroup();
    const [mine] = app(wren).store.addTurn([{ channelId: id, author: "friend", content: "Wren's lne" }]);
    await call("PATCH", `/p/home/api/messages/${mine!.id}`, { content: "Wren's line" });
    expect(app(sol).store.getMessage(mine!.id).content).toBe("Wren's line");
    expect(app(wren).store.history(mine!.id).revisions.map((r) => r.author)).toEqual(["friend", "user"]);
    expect(app(wren).store.interventions.recent()[0]!.summary).toContain("edited your message");
    app(wren).store.deleteMessage(mine!.id, "friend");
    expect(home().store.getMessages(id)).toEqual([]);
  });

  test("renaming and deleting reach every member", async () => {
    const id = await makeGroup();
    await call("PATCH", `/api/hub/groups/${id}`, { name: "Back Room" });
    expect(app(sol).store.getChannel(id).name).toBe("back-room");
    await call("DELETE", `/api/hub/groups/${id}`, {});
    expect(app(sol).store.hasChannel(id)).toBe(false);
  });

  test("regenerating isn't possible there", async () => {
    const id = await makeGroup();
    expect((await call("POST", `/p/home/api/channels/${id}/regenerate`, {})).status).toBe(400);
  });
});

describe("DMs", () => {
  const dm = async (from: App, to: string, text: string) => {
    const ooc = from.store.listChannels().find((c) => c.kind === "ooc")!;
    return runTool(
      { store: from.store, channel: ooc, mode: "post", turn: { consults: 0 }, peers: from.friend.peers(), groups: from.friend.groups! },
      "message_friend",
      { friend: to, text },
    );
  };

  test("a friend writes to another; they see it waiting; you can read it, not write", async () => {
    expect((await dm(home(), "Wren", "SECRET-DM psst, about the twist")).ok).toBe(true);
    const group = (await call("GET", "/api/hub")).data.servers[0].groups.find((g: any) => g.kind === "dm");
    expect(group).toMatchObject({ name: "Arlo & Wren", visible: true });
    const inWren = app(wren).store.getMessages(group.id);
    expect(inWren[0]).toMatchObject({ author: "peer", content: "SECRET-DM psst, about the twist" });
    const wrenOoc = app(wren).store.listChannels().find((c) => c.kind === "ooc")!;
    const wrenPrompt = promptForChannel(app(wren).store, wrenOoc.id, { profile: pickProfile(app(wren).store, wrenOoc) })[0]!.content;
    expect(wrenPrompt).toContain("Arlo wrote to you in your DM (#dm-arlo)");
    expect((await call("GET", `/p/${wren}/api/channels/${group.id}/messages`)).status).toBe(200);
    expect((await call("POST", `/p/${wren}/api/channels/${group.id}/messages`, { content: "hi" })).status).toBe(400);
  });

  test("hidden from you: no screen, no log, no notification; both are told", async () => {
    await dm(home(), "Wren", "SECRET-DM psst");
    const group = (await call("GET", "/api/hub")).data.servers[0].groups.find((g: any) => g.kind === "dm");
    await call("PATCH", `/api/hub/groups/${group.id}`, { visible: false });
    expect((await call("GET", `/p/${wren}/api/channels/${group.id}/messages`)).status).toBe(403);
    expect((await call("GET", `/p/${wren}/api/state`)).data.channels.map((c: any) => c.kind)).not.toContain("dm");
    expect(JSON.stringify(home().store.toolLog.forChannel(home().store.listChannels().find((c) => c.kind === "ooc")!.id))).not.toContain("SECRET-DM");
    const inDm = promptForChannel(app(wren).store, group.id, { profile: pickProfile(app(wren).store, app(wren).store.getChannel(group.id)), groups: app(wren).friend.groups });
    expect(inDm[0]!.content).toContain("The user chose not to see it");
  });
});
