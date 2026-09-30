/**
 * The hub: several friends, each with their own memory, grouped into
 * servers.
 *
 * A **friend** is a whole Kinaera of their own: their own database and
 * folder, so their own notebook (and secrets), settings and prompts,
 * channels and messages, summaries, heartbeat, reference library,
 * custom emojis and logs. Nothing one friend knows can reach
 * another, because nothing is shared: each is a separate app (`createApp`
 * in src/server.ts), exactly as Kinaera was with one friend.
 *
 * A **server** is a group of friends in the rail on the left. Usually a
 * server has one friend (their own place, like a Discord server of your
 * own), but it can have several: its sidebar then shows each friend's
 * channels under their name. Each channel belongs to one friend.
 *
 * The hub keeps the list in `<dataDir>/hub.json`, runs one app per friend,
 * and sends each request to the right one:
 *
 *   /p/<friendId>/api/...   that friend's API (and /p/<id>/emojis/...)
 *   /api/hub/...             the servers and friends themselves (below)
 *   anything else            the first friend's app (the web app's files,
 *                            themes, and the API for older pages)
 *
 * The very first friend lives in the data folder itself. New friends
 * live in `<dataDir>/friends/<id>/`. Your own themes are shared by
 * everyone (`<dataDir>/themes`). A new friend starts with a copy of your
 * connection profiles, roulettes and preferences (models, Jev, reaching
 * out, texting, the look), but not the old friend's identity, prompts or
 * anything they remember.
 *
 * Deleting a friend moves their files to `<dataDir>/trash/`, not away for
 * good, in case you change your mind.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { keepAwake } from "./notify.ts";
import { createApp, type App } from "./server.ts";
import { validateSettings } from "./store.ts";
import type { Settings } from "./types.ts";

export interface HubServer {
  id: string;
  /** Its name; "" shows its first friend's name. */
  name: string;
  /** Its friends' ids, in sidebar order. */
  friends: string[];
}

export interface HubFriend {
  id: string;
  /** Their folder, relative to the data folder ("." for the first friend). */
  dir: string;
}

interface Registry {
  servers: HubServer[];
  friends: HubFriend[];
}

/** Settings that are the friend themselves: never copied to a new friend. */
export const FRIEND_KEYS: (keyof Settings)[] = [
  "friendName",
  "friendPrompt",
  "literaryPrompt",
  "casualPrompt",
  "oocPrompt",
  "friendAvatar",
  "friendColor",
];

/** A friend as the rail and sidebar show them, with their channels. */
export interface FriendSummary {
  id: string;
  name: string;
  avatar: string;
  color: number;
  channels: { id: string; name: string; kind: string; categoryId: string | null; position: number }[];
  categories: { id: string; name: string; position: number; collapsed: boolean }[];
  /** Each channel's newest message, for unread dots. */
  activity: Record<string, { lastId: string; author: string; at: string } | null>;
  busy: string[];
}

export interface Hub {
  fetch: (request: Request) => Promise<Response>;
  /** Each friend's app, by id. */
  apps: Map<string, App>;
  servers: () => HubServer[];
  /** Start every friend's timers (summaries, heartbeat): `main()` does this. */
  start: () => void;
  /** Stop timers and close every database (tests). */
  close: () => void;
}

class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createHub(config: Config, makeApp: (config: Config) => App = createApp): Hub {
  const root = config.dataDir;
  mkdirSync(root, { recursive: true });
  const registryPath = join(root, "hub.json");
  const apps = new Map<string, App>();
  let started = false;

  // ------------------------------------------------------------ the list

  function load(): Registry {
    if (existsSync(registryPath)) return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    return { friends: [{ id: "home", dir: "." }], servers: [{ id: crypto.randomUUID(), name: "", friends: ["home"] }] };
  }
  const registry = load();

  function save(): void {
    // Written whole, then renamed over the old one: never half-written.
    const temp = `${registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2));
    renameSync(temp, registryPath);
  }
  if (!existsSync(registryPath)) save();

  function open(friend: HubFriend): App {
    const app = makeApp({
      ...config,
      dataDir: resolve(root, friend.dir),
      userThemesDir: join(root, "themes"),
      friendId: friend.id,
      example: friend.id === "home",
      // Who else is on their server (names only).
      peers: () => {
        const server = registry.servers.find((s) => s.friends.includes(friend.id));
        return (server?.friends ?? [])
          .filter((id) => id !== friend.id && apps.has(id))
          .map((id) => ({ id, name: apps.get(id)!.store.getSettings().friendName }));
      },
    });
    apps.set(friend.id, app);
    if (started) startApp(app);
    return app;
  }
  for (const friend of registry.friends) open(friend);

  function startApp(app: App): void {
    app.summarizer.scheduleAll(15_000);
    app.heartbeat.start();
    app.rhythms.start();
    if (app.store.getSettings().heartbeatHours > 0) keepAwake();
  }

  function stopApp(app: App): void {
    app.heartbeat.stop();
    app.rhythms.stop();
    app.summarizer.stop();
    app.store.close();
  }

  const defaultApp = () => apps.get(registry.servers[0]!.friends[0]!)!;
  const server = (id: string) => {
    const found = registry.servers.find((s) => s.id === id);
    if (!found) throw new HubError(404, "There's no such server.");
    return found;
  };
  const friendApp = (id: string) => {
    const app = apps.get(id);
    if (!app) throw new HubError(404, "There's no such friend.");
    return app;
  };

  // --------------------------------------------------------- summaries

  function summary(id: string): FriendSummary {
    const { store, friend } = friendApp(id);
    const settings = store.getSettings();
    const channels = store.listChannels();
    return {
      id,
      name: settings.friendName,
      avatar: settings.friendAvatar,
      color: settings.friendColor,
      channels: channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, categoryId: c.categoryId, position: c.position })),
      categories: store.listCategories().map((c) => ({ id: c.id, name: c.name, position: c.position, collapsed: c.collapsed })),
      activity: Object.fromEntries(
        channels.map((c) => {
          const last = store.lastMessage(c.id);
          return [c.id, last ? { lastId: last.id, author: last.author, at: last.createdAt } : null];
        }),
      ),
      busy: friend.busyChannels(),
    };
  }

  function view() {
    return { servers: registry.servers.map((s) => ({ ...s, friends: s.friends.map(summary) })) };
  }

  // ------------------------------------------------------- new friends

  /** Make a friend, copying profiles and preferences from another. */
  function makeFriend(input: Record<string, unknown>): string {
    const source = friendApp(typeof input.copyFrom === "string" ? input.copyFrom : registry.servers[0]!.friends[0]!);
    const identity = validateSettings({
      friendName: input.name ?? "New friend",
      ...(input.prompt !== undefined ? { friendPrompt: input.prompt } : {}),
      ...(input.avatar !== undefined ? { friendAvatar: input.avatar } : {}),
      ...(input.color !== undefined ? { friendColor: input.color } : {}),
    });
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const friend: HubFriend = { id, dir: join("friends", id) };
    const app = open(friend);
    copyProfiles(source, app);
    const preferences = Object.fromEntries(
      Object.entries(source.store.getSettings()).filter(([key]) => !FRIEND_KEYS.includes(key as keyof Settings)),
    );
    app.store.updateSettings({ ...(preferences as Partial<Settings>), ...identity });
    // Who they were made as is the first version of their identity, which
    // is theirs from now on (src/identity.ts). Their first turn is the
    // orientation their store queued (src/orientation.ts).
    app.store.identity.begin(identity.friendPrompt ?? app.store.getSettings().friendPrompt, typeof input.tastes === "string" ? input.tastes : "");
    if (started) void app.rhythms.tick();
    registry.friends.push(friend);
    return id;
  }

  // ------------------------------------------------------------- routes

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      throw new HubError(415, "API requests that change data must be sent as JSON.");
    }
    try {
      const value = await request.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new HubError(400, "The request body must be a JSON object.");
    }
  }

  function removeFriendFiles(friend: HubFriend): void {
    const trash = join(root, "trash", `${friend.id}-${Date.now()}`);
    mkdirSync(trash, { recursive: true });
    if (friend.dir === ".") {
      // The first friend lives in the data folder itself: move just their files.
      for (const name of ["kinaera.db", "kinaera.db-wal", "kinaera.db-shm", "emojis"]) {
        if (existsSync(join(root, name))) renameSync(join(root, name), join(trash, name));
      }
    } else {
      renameSync(resolve(root, friend.dir), join(trash, "files"));
    }
  }

  /** Remove a friend from everywhere; their files go to the trash. */
  function deleteFriend(id: string): void {
    if (registry.friends.length === 1) throw new HubError(400, "You need at least one friend, so the last one can't be deleted.");
    const app = friendApp(id);
    const friend = registry.friends.find((p) => p.id === id)!;
    stopApp(app);
    apps.delete(id);
    removeFriendFiles(friend);
    registry.friends = registry.friends.filter((p) => p.id !== id);
    for (const s of registry.servers) s.friends = s.friends.filter((p) => p !== id);
    registry.servers = registry.servers.filter((s) => s.friends.length > 0);
  }

  async function hubRoute(request: Request, path: string): Promise<Response> {
    const method = request.method;
    const parts = path.split("/").slice(3); // after /api/hub
    if (method === "GET" && parts.length === 0) return json(view());

    if (parts[0] === "servers") {
      if (method === "POST" && parts.length === 1) {
        // A new server, with a new friend of its own.
        const input = await body(request);
        const friendId = makeFriend(input);
        const created: HubServer = { id: crypto.randomUUID(), name: typeof input.serverName === "string" ? input.serverName.trim().slice(0, 100) : "", friends: [friendId] };
        registry.servers.push(created);
        save();
        return json({ server: created, friendId, ...view() });
      }
      if (method === "PUT" && parts[1] === "order") {
        const ids = (await body(request)).ids;
        if (!Array.isArray(ids) || ids.length !== registry.servers.length || !registry.servers.every((s) => ids.includes(s.id))) {
          throw new HubError(400, "The new order must list every server exactly once.");
        }
        registry.servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        save();
        return json(view());
      }
      const target = server(parts[1] ?? "");
      if (method === "PATCH" && parts.length === 2) {
        const input = await body(request);
        if (input.name !== undefined) {
          if (typeof input.name !== "string" || input.name.length > 100) throw new HubError(400, "A server's name is text, 100 characters at most.");
          target.name = input.name.trim();
        }
        if (input.friends !== undefined) {
          // Reorder its friends.
          const ids = input.friends;
          if (!Array.isArray(ids) || ids.length !== target.friends.length || !target.friends.every((p) => ids.includes(p))) {
            throw new HubError(400, "friends must list the server's friends, in the new order.");
          }
          target.friends = ids as string[];
        }
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "friends" && parts.length === 3) {
        // Another friend in this server.
        const friendId = makeFriend(await body(request));
        target.friends.push(friendId);
        save();
        return json({ friendId, ...view() });
      }
      if (method === "DELETE" && parts.length === 2) {
        if (registry.servers.length === 1) throw new HubError(400, "You need at least one server, so the last one can't be deleted.");
        if (registry.friends.length === target.friends.length) throw new HubError(400, "That would delete every friend.");
        for (const id of [...target.friends]) deleteFriend(id);
        registry.servers = registry.servers.filter((s) => s.id !== target.id);
        save();
        return json(view());
      }
    }

    if (parts[0] === "friends" && parts[1]) {
      const id = parts[1];
      friendApp(id);
      if (method === "DELETE" && parts.length === 2) {
        deleteFriend(id);
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "move") {
        // Move a friend to another server, or into a server of their own.
        const to = (await body(request)).serverId;
        for (const s of registry.servers) s.friends = s.friends.filter((p) => p !== id);
        if (typeof to === "string") server(to).friends.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", friends: [id] });
        registry.servers = registry.servers.filter((s) => s.friends.length > 0);
        save();
        return json(view());
      }
    }
    throw new HubError(404, "No such API route.");
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/hub" || url.pathname.startsWith("/api/hub/")) return await hubRoute(request, url.pathname);
      // /p/<id>/...: that friend's app, with the rest of the path.
      const scoped = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
      if (scoped) {
        const app = friendApp(decodeURIComponent(scoped[1]!));
        url.pathname = scoped[2]!;
        return await app.fetch(new Request(url.toString(), request));
      }
      return await defaultApp().fetch(request);
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : String(error);
      if (/must be|is too long|non-empty/.test(message)) return json({ error: message }, 400);
      console.error("[hub]", error);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  }

  return {
    fetch,
    apps,
    servers: () => registry.servers,
    start: () => {
      started = true;
      for (const app of apps.values()) startApp(app);
    },
    close: () => {
      for (const app of apps.values()) stopApp(app);
    },
  };
}

/**
 * Give a new friend the same connection profiles and roulettes as another
 * (same ids, so assignments carry over), replacing the default one.
 */
function copyProfiles(from: App, to: App): void {
  const source = from.store.db;
  const target = to.store.db;
  const rows = (table: string) => source.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const copy = (table: string, list: Record<string, unknown>[]) => {
    for (const row of list) {
      const columns = Object.keys(row);
      target
        .query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`)
        .run(Object.fromEntries(columns.map((c) => [c, row[c] as string | number | null])));
    }
  };
  const profiles = rows("profiles");
  const roulettes = rows("roulettes");
  const entries = rows("roulette_profiles");
  target.transaction(() => {
    target.query("DELETE FROM roulette_profiles").run();
    target.query("DELETE FROM roulettes").run();
    target.query("DELETE FROM profiles").run();
    copy("profiles", profiles);
    copy("roulettes", roulettes);
    copy("roulette_profiles", entries);
  })();
}
