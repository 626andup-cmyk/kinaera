/**
 * The Kinaera server.
 *
 * This is a small web server, run by Bun in Termux on your phone. It does two
 * jobs:
 *
 *   1. Serves the web app (the files in `public/`) to your browser.
 *   2. Answers the app's API requests under `/api/...`: reading channels and
 *      messages, saving changes, and asking your friend to write.
 *
 * The browser never talks to nanoGPT itself. Your API key stays on the server,
 * and the server is the only thing that reads or writes your data.
 *
 * API overview (all request and response bodies are JSON):
 *
 *   POST   /api/wake                           You opened the app: your friend may wake up (stage 8)
 *   GET    /api/wakeups                        Recent wake-ups, and what came of them
 *   POST   /api/friend/random                 "Surprise me": a new friend's name and prompt, from random ingredients
 *   POST   /api/presence                       The app is (or isn't) on screen: {visible}
 *   POST   /api/heartbeat                      Beat now: a free moment for your friend, if the rules allow
 *   POST   /api/jev/test                      Ask Jev one tiny question, to see if it's reachable and understood
 *   GET    /api/checks                         The check log: every check your friend made
 *
 *   POST   /api/messages/:id/reactions         Add your emoji reaction to a message, or take it back
 *   GET    /api/emojis                         Custom emojis
 *   POST   /api/emojis                         Add a custom emoji: name, and the image as base64
 *   DELETE /api/emojis/:name                   Delete one (and reactions with it)
 *   (Custom emoji images are served at /emojis/<file>.)
 *
 *   GET    /api/library                        The reference library's documents
 *   POST   /api/library                        Add a document: title, description, channelIds and its text
 *   GET    /api/library/search?q=...           Search passages (&doc=id for one document)
 *   PATCH  /api/library/:id                    Change a document's title, description or channels
 *   DELETE /api/library/:id                    Delete a document
 *   GET    /api/library/:id/passages/:seq      Read passages in full (&count=n in a row, up to 10)
 *   GET    /api/state                          Settings, channels, profiles, roulettes, the open inbox,
 *                                              where the friend is writing, and the app version
 *   PUT    /api/settings                       Change settings (any subset of fields)
 *   GET    /api/models                         List models available on nanoGPT
 *
 *   POST   /api/channels                       Create a channel
 *   PATCH  /api/channels/:id                   Rename a channel, or change its style, theme or profile
 *   DELETE /api/channels/:id                   Delete a channel and all its messages
 *   PUT    /api/channels/order                 Put the channels in a new order (and move them between categories)
 *   POST   /api/categories                     Make a channel category
 *   PUT    /api/categories/order               Put the categories in a new order
 *   PATCH  /api/categories/:id                 Rename a category, or fold it up
 *   DELETE /api/categories/:id                 Delete a category (its channels stay)
 *
 *   GET    /api/channels/:id/messages          Every message in a channel, with its tool calls, comment threads
 *                                              and summaries
 *   POST   /api/channels/:id/messages          Send your message (with notes attached), then the friend replies
 *                                              (or add a scene break, if the message is `=====`)
 *   POST   /api/channels/:id/scene-breaks      Add a scene break
 *   DELETE /api/channels/:id/messages          Delete every message in a channel
 *   POST   /api/channels/:id/turn              Friend takes a turn without a new message from you
 *   POST   /api/channels/:id/regenerate        Replace the friend's last reply with a new one (optionally
 *                                              with a given profile)
 *   POST   /api/channels/:id/cancel            Stop the friend's turn in progress (the Stop button)
 *   GET    /api/channels/:id/prompt            The exact prompt stack the next turn would send
 *   GET    /api/channels/:id/tool-log          Every tool call in a channel, for troubleshooting
 *   GET    /api/channels/:id/summaries         Its summaries: scenes, the story so far, earlier in the scene, digest
 *   PUT    /api/channels/:id/summaries         Your own words for the story so far or a scene's summary
 *   POST   /api/channels/:id/summaries/update  Write the summaries that are due, now
 *   POST   /api/channels/:id/summaries/rebuild Rewrite all of them from the messages
 *   POST   /api/channels/:id/summaries/scenes/:sceneId/regenerate  Rewrite one scene's summary
 *   PUT    /api/channels/:id/cast/:entryId     Pin a notebook entry to a channel (add it to the cast)
 *   DELETE /api/channels/:id/cast/:entryId     Unpin it
 *
 *   PATCH  /api/messages/:id                   Edit a message's text (every version is kept)
 *   DELETE /api/messages/:id                   Delete one message (it's kept in history, as a tombstone)
 *   GET    /api/messages/:id/history           A message's versions, and the replies it replaced
 *   GET    /api/interventions                  The intervention log: what you've done that affects your friend
 *   POST   /api/messages/:id/comments          Comment on a message (your friend may reply)
 *   POST   /api/comments/:id/replies           Reply in a comment thread
 *   POST   /api/comments/:id/resolve           Resolve or reopen a thread
 *   DELETE /api/comments/:id                   Delete one of your comments
 *
 *   GET    /api/inbox                          What your friend asks of you: asks and proposals (open, and recent)
 *   POST   /api/inbox/:id/:action              answer (with {answer}) or dismiss an ask; approve or deny a proposal
 *
 *   GET    /api/profiles                       Connection profiles and roulettes
 *   POST   /api/profiles                       Make a profile
 *   PATCH  /api/profiles/:id                   Change a profile
 *   DELETE /api/profiles/:id                   Delete a profile
 *   POST   /api/profiles/:id/test              Check whether its model can call tools
 *   POST   /api/roulettes                      Make a roulette
 *   PATCH  /api/roulettes/:id                  Change a roulette
 *   DELETE /api/roulettes/:id                  Delete a roulette
 *
 *   GET    /api/notebook                       Folders, entries and suggestions you can see, and field templates
 *   POST   /api/notebook/entries               Make an entry (a character or lore)
 *   PATCH  /api/notebook/entries/:id           Change an entry's contents (or suggest a change)
 *   PUT    /api/notebook/entries/:id/settings  Change its owner, visibility, editing or folder (owner only)
 *   DELETE /api/notebook/entries/:id           Delete an entry (or suggest deleting it)
 *   POST   /api/notebook/folders               Make a folder
 *   PATCH  /api/notebook/folders/:id           Rename a folder or change its settings
 *   DELETE /api/notebook/folders/:id           Delete a folder (its entries are kept)
 *   POST   /api/notebook/suggestions/:id/:action  accept, reject or withdraw a suggestion
 *
 * Every channel in a response comes with its `cast`: the entries pinned to
 * it, as you see them (see `ChannelView`). The notebook routes act as you
 * ("user"); your friend acts through tools (src/tools.ts).
 *
 *   GET    /api/themes                         Every theme, for the theme picker
 *   POST   /api/themes                         Make a new theme, copying another
 *   GET    /api/themes/:id                     One theme's CSS and files, for the editor
 *   PATCH  /api/themes/:id                     Change one of your themes
 *   DELETE /api/themes/:id                     Delete one of your themes
 *   POST   /api/themes/:id/files               Add an image or font to one of your themes
 *   DELETE /api/themes/:id/files/:name         Remove one
 *
 * Theme files themselves are served at /themes/<id>/<file> (see src/themes.ts).
 *
 * Run it with `bun start`.
 */

import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { ApiError, CancelledError, listModels, type ApiOptions } from "./nanogpt.ts";
import { BusyError, Friend, pickProfile, promptForChannel, testToolCalling, type TurnResult } from "./friend.ts";
import { parseSceneBreak, postToMessages } from "./posts.ts";
import { Summarizer } from "./summarizer.ts";
import { Decider, testJev } from "./jev.ts";
import { FRESH_SCENE_MINUTES, Wakeups } from "./wakeups.ts";
import { Heartbeat } from "./heartbeat.ts";
import { describeSeeds, randomFriend, rollSeeds } from "./rng.ts";
import { keepAwake, Presence, TermuxNotifier, type Notifier } from "./notify.ts";
import { DEFAULT_THEME, ThemeLibrary } from "./themes.ts";
import { ENTRY_TEMPLATES } from "./notebook.ts";
import { invited, inviteToOrientation, noteNewProfiles, pendingOrientation, Rhythms } from "./orientation.ts";
import type { CastMember, Channel, Message, Settings } from "./types.ts";
import { PermissionError } from "./errors.ts";
import {
  NotFoundError,
  Store,
  ValidationError,
  validateChannelUpdate,
  validateNewChannel,
  validateSettings,
} from "./store.ts";

/** A channel as the app receives it: with its cast, as you see it. */
export type ChannelView = Channel & { cast: CastMember[] };

/** Settings that are about your friend: changing one goes in the intervention log. */
const SETTINGS_THEY_SEE: Partial<Record<keyof Settings, string>> = {
  friendName: "your name",
  friendPrompt: "your identity (who you are)",
  literaryPrompt: "how you write in literary scenes",
  casualPrompt: "how you write in casual scenes",
  oocPrompt: "how you talk out of character",
  friendAvatar: "your avatar",
  friendColor: "your colour",
  oocBubbles: "whether you text in short bubbles out of character",
};

/** Longest message you can send, in characters. A generous guard against accidents. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * An error that should be sent to the browser with a specific HTTP status.
 * Thrown by route handlers; turned into a JSON response by `fetch`.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The pieces a running app is made of, returned so tests can reach into them. */
export interface App {
  /** Handles one HTTP request. This is what `Bun.serve` calls. */
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  friend: Friend;
  themes: ThemeLibrary;
  /** Writes summaries in the background (stage 7). */
  summarizer: Summarizer;
  /** Asks Jev, the small decision model (only `check` uses it). */
  decider: Decider;
  /** Checks the hard rules, and gives your friend turns of their own. */
  wakeups: Wakeups;
  /** A timer that gives your friend free moments (src/heartbeat.ts). */
  heartbeat: Heartbeat;
  /** Orientation and the weekly look back (src/orientation.ts). */
  rhythms: Rhythms;
  /** Whether the app is on screen, as it last said (for notifications). */
  presence: Presence;
  notifier: Notifier;
}

/**
 * One API route: a method, a path pattern, and what to do.
 *
 * In a pattern, `:id` matches one path segment, and its value arrives in
 * `params.id`. So `/api/channels/:id/turn` matches `/api/channels/abc/turn`
 * with `params.id === "abc"`.
 */
interface Route {
  method: string;
  pattern: string;
  handler: (request: Request, params: Record<string, string>) => Promise<Response> | Response;
}

/**
 * Check a request's method and path against a route.
 * Returns the `:name` values if it matches, or `null` if it doesn't.
 */
export function matchRoute(route: Pick<Route, "method" | "pattern">, method: string, path: string) {
  if (route.method !== method) return null;
  const want = route.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(":")) {
      if (got[i] === "") return null;
      try {
        params[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
      } catch {
        return null; // badly encoded, like "%zz": treat as no match
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

/**
 * A fingerprint of the web app's files: it changes whenever any file in
 * `public/` changes.
 *
 * An installed app can stay open in the background for days. After you
 * update Kinaera and restart the server, that open page is still running the
 * old code. The page compares this fingerprint with the one it started with,
 * and reloads when they differ (see `checkForUpdate` in public/js/live.js).
 */
export function appVersion(publicDir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // Sorted, so the same files always give the same fingerprint.
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: publicDir })].sort();
  for (const file of files) {
    hasher.update(file);
    hasher.update(readFileSync(join(publicDir, file)));
  }
  // The first 12 characters are plenty to tell versions apart.
  return hasher.digest("hex").slice(0, 12);
}

/**
 * Wire everything together: open the store, create the friend, and build the
 * request handler. Nothing is listening yet; `main()` does that.
 */
export function createApp(config: Config): App {
  const store = new Store(config.dataDir, { example: config.example ?? true });
  const api: ApiOptions = {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
  };
  const friend = new Friend(store, api);
  const summarizer = new Summarizer(store, api, config.summaryDelayMs);
  const decider = new Decider(
    api,
    () => {
      const settings = store.getSettings();
      const [kind, id] = settings.decisionFallback.split(":");
      let fallback = null;
      try {
        fallback = kind === "profile" && id ? store.profiles.get(id) : null;
      } catch {
        fallback = null; // deleted since
      }
      return { decisionModel: settings.decisionModel, fallback };
    },
  );
  // Jev's only job: the check tool (src/check.ts).
  friend.decider = decider;
  const wakeups = new Wakeups(store, friend, Boolean(config.apiKey));
  const heartbeat = new Heartbeat(store, wakeups);
  const rhythms = new Rhythms(store, wakeups);
  const presence = new Presence();
  const notifier = config.notifier ?? new TermuxNotifier(`http://127.0.0.1:${config.port}`);
  // A wake-up (or heartbeat) wrote to you while the app isn't on screen: a
  // phone notification (src/notify.ts).
  wakeups.onPosted = (channel, messages) => {
    if (presence.isVisible() || !notifier.available()) return;
    const text = messages.map((m) => m.content).join("\n");
    notifier.notify({ title: `${store.getSettings().friendName} in #${channel.name}`, text, channelId: channel.id, friendId: config.friendId });
  };
  // …and so does a post in another channel (post_in_channel), whatever
  // started the turn: you weren't looking there.
  friend.onPostedElsewhere = (channel, messages) => wakeups.onPosted?.(channel, messages);
  const autoWake = config.autoWake ?? true;

  /**
   * A scene you ended was just summarized: that's a wake-up (if it's the
   * newest scene break, and fresh, not an old one being rewritten).
   */
  summarizer.onSceneSummarized = (channelId, breakId) => {
    const sceneBreak = store.getMessage(breakId);
    const newest = store.getMessages(channelId).filter((m) => m.kind === "scene_break").at(-1);
    const fresh = Date.now() - new Date(sceneBreak.createdAt).getTime() < FRESH_SCENE_MINUTES * 60_000;
    if (autoWake && sceneBreak.author === "user" && newest?.id === breakId && fresh) {
      void wakeups.event("scene-ended", { channelId, breakId });
    }
  };

  /** You ended a scene: with summaries off, that's a wake-up straight away (otherwise, once it's summarized). */
  function sceneEnded(result: { sceneBreak: Message; channel: Channel }) {
    if (!store.getSettings().summaries && autoWake) {
      void wakeups.event("scene-ended", { channelId: result.channel.id, breakId: result.sceneBreak.id });
    }
    return result;
  }

  /** You made a suggestion for your friend to review: that's a wake-up. */
  function maybeReview<T>(result: T): T {
    const suggestion = (result as { suggestion?: Parameters<typeof store.notebook.reviewerOf>[0] }).suggestion;
    if (autoWake && suggestion && store.notebook.reviewerOf(suggestion) === "friend") void wakeups.event("review");
    return result;
  }
  const version = appVersion(config.publicDir);
  const themes = new ThemeLibrary(
    config.themesDir,
    config.userThemesDir ?? join(config.dataDir, "themes"),
    readFileSync(join(config.publicDir, "style.css"), "utf8"),
  );

  /** Refuse a theme id that doesn't exist (for settings and channels). */
  function ensureTheme(id: string | null | undefined): void {
    if (id && !themes.exists(id)) throw new HttpError(400, "That theme doesn't exist.");
  }

  /** A channel, with its cast as you see it (hidden entries shown as "??? (hidden)"). */
  function channelView(channel: Channel): ChannelView {
    return { ...channel, cast: store.notebook.castFor("user", channel.id) };
  }

  function channelViews(): ChannelView[] {
    return store.listChannels().map(channelView);
  }

  /** The practice channel, with the sample notes pinned to it. */
  function practiceView(): ChannelView | null {
    const channel = store.practiceChannel();
    return channel ? channelView(channel) : null;
  }

  /** Your suggestions for their identity and self-page that your friend hasn't answered yet. */
  function waitingOnFriend() {
    return {
      identity: store.identity.pending(),
      selfNotes: store.selfPage.pendingNotes().filter((n) => n.source === "user"),
    };
  }

  /** Everything on the friend page (the journal only as counts: it's private). */
  function friendPage() {
    return {
      identity: store.identity.current(),
      history: store.identity.history(),
      selfPage: store.selfPage.view(),
      journal: store.journal.counts(),
      orientation: {
        invited: invited(store),
        pending: pendingOrientation(store) !== null,
        lastInvitation: store.appState.get("orientation.invite-result"),
      },
      waiting: waitingOnFriend(),
    };
  }

  /** You suggested something for your friend to answer: that's a wake-up, if the rules allow. */
  function suggested(): void {
    if (autoWake) void wakeups.event("review");
  }

  function sceneBreakResult(result: { sceneBreak: Message; channel: Channel }) {
    return { sceneBreak: result.sceneBreak, channel: channelView(result.channel) };
  }

  /**
   * After you comment, your friend gets a turn to reply in the thread. On
   * your own message, the comment may be a note for yourself: they can
   * leave it (their call, not a rule's). The reply is reported as data: if
   * it fails, your comment is still saved.
   */
  async function commentReply(threadId: string) {
    const reply = await tryTurn(() => friend.replyToComment(threadId));
    return { thread: store.comments.thread(threadId), ...reply };
  }

  /**
   * The notebook entries to attach to a message you're sending: the ids you
   * picked (`attach`), plus any entry you linked in the text with
   * `[[Name]]`. You must be able to see each, and so must your friend, or
   * it couldn't be sent.
   */
  function readAttachments(body: unknown, content: string): string[] {
    const picked = (body as { attach?: unknown } | null)?.attach ?? [];
    if (!Array.isArray(picked) || !picked.every((id) => typeof id === "string")) {
      throw new HttpError(400, '"attach" must be a list of notebook entry ids.');
    }
    const ids = new Set<string>();
    for (const id of picked) {
      const entry = store.notebook.getEntry("user", id); // 404 if you can't see it
      if (!store.notebook.canSeeEntry("friend", id)) {
        throw new HttpError(400, `${entry.name} is hidden from your friend, so it can't be sent to them.`);
      }
      ids.add(id);
    }
    // [[Name]] and [[Name|shown text]] links, silently skipping names that
    // aren't in the notebook or that your friend can't see.
    const entries = store.notebook.listEntries("user");
    for (const [, name] of content.matchAll(/\[\[([^\]|\n]{1,100})(?:\|[^\]\n]*)?\]\]/g)) {
      const entry = entries.find((e) => e.name.toLowerCase() === name!.trim().toLowerCase());
      if (entry && store.notebook.canSeeEntry("friend", entry.id)) ids.add(entry.id);
    }
    return [...ids];
  }

  /**
   * Changes to who your friend is, or how they write, go in the
   * intervention log, one line each.
   */
  function noteSettingsChanges(before: Settings, after: Settings): void {
    for (const [key, what] of Object.entries(SETTINGS_THEY_SEE) as [keyof Settings, string][]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        store.interventions.add({ kind: "settings", summary: `The user changed ${what}.` });
      }
    }
  }

  /** Refuse to change a channel's messages while the friend is writing there. */
  function ensureIdle(channelId: string): void {
    if (friend.isBusy(channelId)) throw new BusyError();
  }

  // Routes are checked in order and the first match wins, so fixed paths
  // (`/api/channels/order`) must come before patterns that would also match
  // them (`/api/channels/:id`).
  const routes: Route[] = [
    // ------------------------------------------------------- server-wide
    {
      method: "GET",
      pattern: "/api/state",
      handler: () =>
        json({
          settings: store.getSettings(),
          channels: channelViews(),
          // Your friend's own practice channel, shown apart (src/orientation.ts).
          practice: practiceView(),
          categories: store.listCategories(),
          profiles: store.profiles.list(),
          roulettes: store.profiles.listRoulettes(),
          inbox: store.inbox.open(),
          // Your suggestions still waiting for your friend.
          waiting: waitingOnFriend(),
          busyChannels: friend.busyChannels(),
          appVersion: version,
          emojis: store.reactions.listEmojis(),
          // Whether phone notifications work here (Termux), and the next heartbeat.
          notifications: notifier.available(),
          heartbeatNext: heartbeat.nextAt()?.toISOString() ?? null,
          // For noticing messages the app didn't ask for (a wake-up): a
          // number that changes with any message, and each channel's newest.
          revision: store.revision,
          activity: Object.fromEntries(
            store.listChannels().map((c) => {
              const last = store.lastMessage(c.id);
              return [c.id, last ? { lastId: last.id, author: last.author, at: last.createdAt } : null];
            }),
          ),
        }),
    },
    {
      // You opened the app (or came back to it). Your friend may wake up;
      // the answer doesn't wait for that (the app notices new messages).
      method: "POST",
      pattern: "/api/wake",
      handler: async (request) => {
        const body = (await readJson(request)) as { event?: unknown } | null;
        if (body?.event !== "opened") throw new HttpError(400, '"event" must be "opened".');
        if (autoWake) void wakeups.event("opened");
        return json({ ok: true });
      },
    },
    // The reference library: long texts your friend can search.
    {
      method: "GET",
      pattern: "/api/library",
      handler: () => json({ documents: store.library.list() }),
    },
    {
      method: "POST",
      pattern: "/api/library",
      handler: async (request) => json({ document: store.library.add(await readObject(request)) }),
    },
    {
      method: "GET",
      pattern: "/api/library/search",
      handler: (request) => {
        const params = new URL(request.url).searchParams;
        const doc = params.get("doc");
        return json({ results: store.library.search(params.get("q") ?? "", doc ? [store.library.get(doc).id] : undefined, 20) });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/library/:id",
      handler: async (request, { id }) => json({ document: store.library.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/library/:id",
      handler: (_request, { id }) => {
        store.library.remove(id!);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/library/:id/passages/:seq",
      handler: (request, { id, seq }) => {
        const count = Number(new URL(request.url).searchParams.get("count") ?? 1);
        const from = Number(seq);
        if (!Number.isInteger(from) || !Number.isInteger(count)) throw new HttpError(400, "Passage numbers are whole numbers.");
        return json({ document: store.library.get(id!), passages: store.library.passages(id!, from, Math.min(10, Math.max(1, count))) });
      },
    },
    {
      // Settings → "Surprise me": a new friend from random ingredients (not saved).
      method: "POST",
      pattern: "/api/friend/random",
      handler: async () => {
        if (!config.apiKey) throw new HttpError(400, "Add your nanoGPT API key first.");
        const seeds = rollSeeds();
        const ooc = store.listChannels().find((c) => c.kind === "ooc") ?? store.listChannels()[0]!;
        try {
          const made = await randomFriend(api, pickProfile(store, ooc), seeds);
          return json({ ...made, seeds: describeSeeds(seeds) });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new HttpError(502, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      // The app is (or isn't) on screen: no notifications while it is.
      method: "POST",
      pattern: "/api/presence",
      handler: async (request) => {
        const body = await readObject(request);
        presence.set(body.visible === true);
        return json({ ok: true });
      },
    },
    {
      // Settings → "Beat now": a heartbeat straight away, whatever the time.
      method: "POST",
      pattern: "/api/heartbeat",
      handler: async () => json({ beat: await heartbeat.tick(true) }),
    },
    {
      method: "GET",
      pattern: "/api/wakeups",
      handler: () => json({ wakeups: store.wakeLog.recent() }),
    },
    {
      // Ask Jev one tiny question, to see if it's reachable and understood.
      method: "POST",
      pattern: "/api/jev/test",
      handler: async () => json(await testJev(decider)),
    },
    {
      method: "GET",
      pattern: "/api/checks",
      handler: () => json({ checks: store.checkLog.recent(200) }),
    },
    {
      method: "PUT",
      pattern: "/api/settings",
      handler: async (request) => {
        const update = validateSettings(await readJson(request));
        ensureTheme(update.appTheme);
        // Their identity is theirs (src/identity.ts): a change you make to it
        // is a suggestion they accept or decline, never saved over it.
        let suggestion = null;
        if (update.friendPrompt !== undefined) {
          const current = store.identity.current();
          if (update.friendPrompt.trim() !== (current?.identity ?? "")) {
            suggestion = store.identity.suggest({ identity: update.friendPrompt });
            store.interventions.add({ kind: "settings", summary: "The user suggested a change to your identity." });
          }
          delete update.friendPrompt;
        }
        for (const assignment of [update.rpAssignment, update.oocAssignment, update.summaryAssignment, update.decisionFallback]) {
          if (assignment) store.profiles.checkAssignment(assignment);
        }
        const before = store.getSettings();
        const settings = store.updateSettings(update);
        noteSettingsChanges(before, settings);
        // Turning summaries on, or changing when they're written: catch up.
        if (update.summaries || update.summaryEvery || update.historyLimit) summarizer.scheduleAll();
        // The heartbeat's pace changed: start counting again from now.
        if (update.heartbeatHours !== undefined) {
          heartbeat.reset();
          if (update.heartbeatHours > 0) keepAwake();
        }
        if (suggestion) suggested();
        return json({ settings, suggestion });
      },
    },
    {
      method: "GET",
      pattern: "/api/models",
      handler: async () => json({ models: await listModels(api) }),
    },

    // ---------------------------------------------------------- channels
    {
      method: "POST",
      pattern: "/api/channels",
      handler: async (request) => {
        const body = await readJson(request);
        const categoryId = (body as { categoryId?: unknown } | null)?.categoryId;
        if (categoryId !== undefined && categoryId !== null && typeof categoryId !== "string") {
          throw new HttpError(400, '"categoryId" must be a category id.');
        }
        return json({ channel: channelView(store.createChannel({ ...validateNewChannel(body), categoryId: categoryId || null })) });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/order",
      handler: async (request) => {
        // A drag in the sidebar: the new order, and (optionally) which
        // category each moved channel is now in: {channelId: categoryId | null}.
        const body = (await readJson(request)) as { ids?: unknown; categories?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of channel ids.');
        }
        const categories = body.categories ?? {};
        if (
          typeof categories !== "object" ||
          categories === null ||
          Array.isArray(categories) ||
          !Object.values(categories).every((c) => c === null || typeof c === "string")
        ) {
          throw new HttpError(400, '"categories" must map channel ids to category ids (or null).');
        }
        store.reorderChannels(body.ids, categories as Record<string, string | null>);
        return json({ channels: channelViews() });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/channels/:id",
      handler: async (request, { id }) => {
        const update = validateChannelUpdate(await readJson(request));
        ensureTheme(update.theme);
        if (update.assignment) store.profiles.checkAssignment(update.assignment);
        return json({ channel: channelView(store.updateChannel(id!, update)) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id",
      handler: (_request, { id }) => {
        // A turn in progress would try to save its reply into a channel that
        // no longer exists, so wait for it to finish.
        ensureIdle(id!);
        store.deleteChannel(id!);
        return json({ ok: true });
      },
    },

    // ------------------------------------------------ channel messages
    {
      method: "GET",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) =>
        json({
          messages: store.getMessages(id!),
          // Your friend's actions (shown under their messages), and comments.
          toolCalls: store.toolLog.forChannel(id!),
          threads: store.comments.forChannel(id!),
          // Scene summaries (shown under scene breaks), the story so far, and more.
          summaries: summarizer.view(id!),
        }),
    },

    // --------------------------------------------------------- summaries
    {
      method: "GET",
      pattern: "/api/channels/:id/summaries",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // Your own words for the story so far, or a scene's summary. Empty
      // text removes yours, and the model writes one again.
      method: "PUT",
      pattern: "/api/channels/:id/summaries",
      handler: async (request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        const body = (await readJson(request)) as { kind?: unknown; sceneId?: unknown; content?: unknown } | null;
        const content = body?.content;
        if (typeof content !== "string" || content.length > 20_000) {
          throw new HttpError(400, '"content" must be text of 20,000 characters at most.');
        }
        let throughSeq: number;
        let sceneId = "";
        if (body?.kind === "story") {
          throughSeq = store.summaries.get(id!, "story")?.throughSeq ?? 0;
        } else if (body?.kind === "scene") {
          const breakMessage = typeof body.sceneId === "string" ? store.getMessage(body.sceneId) : null;
          if (!breakMessage || breakMessage.kind !== "scene_break" || breakMessage.channelId !== id) {
            throw new HttpError(400, '"sceneId" must be a scene break in this channel.');
          }
          sceneId = breakMessage.id;
          throughSeq = store.summaries.withSeq(id!, [breakMessage])[0]!.seq;
          // The story so far is rewritten with the new scene summary.
          store.summaries.markStale(id!, "story");
        } else {
          throw new HttpError(400, '"kind" must be "story" or "scene".');
        }
        if (content.trim() === "") store.summaries.remove(id!, body.kind, sceneId);
        else store.summaries.edit(id!, body.kind, sceneId, content.trim(), throughSeq);
        summarizer.schedule(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // "Update now": write whatever summaries are due, and wait for them.
      method: "POST",
      pattern: "/api/channels/:id/summaries/update",
      handler: async (_request, { id }) => {
        store.getChannel(id!);
        await summarizer.catchUp(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // "Rebuild": rewrite every summary from the messages, your edits included.
      method: "POST",
      pattern: "/api/channels/:id/summaries/rebuild",
      handler: async (_request, { id }) => {
        store.getChannel(id!);
        await summarizer.rebuild(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // Rewrite one scene's summary (your edit to it included).
      method: "POST",
      pattern: "/api/channels/:id/summaries/scenes/:sceneId/regenerate",
      handler: async (_request, { id, sceneId }) => {
        store.getChannel(id!);
        store.summaries.remove(id!, "scene", sceneId!);
        store.summaries.markStale(id!, "story");
        await summarizer.catchUp(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/tool-log",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        return json({ toolCalls: store.toolLog.forChannel(id!, 1000) });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/messages",
      handler: async (request, { id }) => {
        const body = await readJson(request);
        const content = requireText(body, "content");
        const channel = store.getChannel(id!); // 404 for an unknown channel
        // Refuse *before* saving, so a message sent while the friend is busy
        // isn't saved without a reply attached.
        ensureIdle(id!);

        // `=====` (with an optional title) in an RP channel is a scene break,
        // not a post, and the friend doesn't reply to it.
        const sceneTitle = channel.kind === "rp" ? parseSceneBreak(content) : null;
        if (sceneTitle !== null) return json(sceneBreakResult(sceneEnded(store.addSceneBreak(id!, "user", sceneTitle))));

        const yourCharacters = store.notebook.postableCharacters();
        const postingAs = readPostingAs(body, yourCharacters);
        const messages = postToMessages(channel, content, yourCharacters, postingAs);
        if (messages.length === 0) throw new HttpError(400, "There's nothing to send after the character tags.");
        // Notes you attached (and entries you [[linked]]) go with the message.
        const attach = readAttachments(body, content);
        const userMessages = store.addTurn(messages);
        if (attach.length > 0) userMessages[0] = store.attach(userMessages[0]!.id, attach);

        // Posting as one of your characters puts them in the channel's cast,
        // if they aren't already.
        for (const name of new Set(userMessages.flatMap((m) => m.characters))) {
          const entry = yourCharacters.find((c) => c.name === name);
          if (entry) store.notebook.pin("user", id!, entry.id);
        }

        // `reply: false`: just save it. In OOC with texting on, the app sends
        // your bubbles this way and asks for a turn once you pause.
        if ((body as { reply?: unknown }).reply === false) {
          return json({ userMessages, channel: channelView(store.getChannel(id!)), channels: channelViews() });
        }
        // The reply is attempted separately: if it fails, your message is still
        // saved and the app offers to retry with a friend turn.
        const reply = await tryTurn(() => friend.takeTurn(id!, "user-message"));
        return json({ userMessages, ...reply, channel: channelView(store.getChannel(id!)), channels: channelViews() });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => {
        ensureIdle(id!);
        store.clearMessages(id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/turn",
      handler: async (_request, { id }) =>
        json({ ...turnResult(await friend.takeTurn(id!, "continue")), channels: channelViews() }),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/scene-breaks",
      handler: async (request, { id }) => {
        const body = (await readJson(request)) as { title?: unknown } | null;
        const title = body?.title ?? "";
        if (typeof title !== "string" || title.length > 200) {
          throw new HttpError(400, '"title" must be text of 200 characters at most.');
        }
        // Waits for a turn in progress, so the break can't land in the middle
        // of a reply.
        ensureIdle(id!);
        return json(sceneBreakResult(sceneEnded(store.addSceneBreak(id!, "user", title))));
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/regenerate",
      handler: async (request, { id }) => {
        ensureIdle(id!);
        // Optional: the profile to write with ("Regenerate with..."). Without
        // one, the channel's profile or roulette picks again.
        const body = (await readJson(request)) as { profileId?: unknown } | null;
        const profileId = typeof body?.profileId === "string" && body.profileId ? body.profileId : undefined;
        if (profileId) store.profiles.get(profileId); // 404 for an unknown profile
        // The whole last reply: one post, or every bubble of a casual reply.
        const replacedIds = store.lastFriendTurn(id!).map((m) => m.id);
        if (replacedIds.length === 0) {
          throw new HttpError(400, "The last message isn't from your friend, so there's nothing to regenerate.");
        }
        // Generate first, and only delete the old reply once the new one exists.
        // If generation fails you keep the reply you had.
        const result = await friend.takeTurn(id!, "regenerate", { replacing: replacedIds, profileId });
        // If the new turn wrote nothing, the old reply stays.
        if (result.replaced.length > 0) {
          const how = profileId ? ` with ${store.profiles.get(profileId).name}` : "";
          store.interventions.add({
            kind: "regenerate",
            summary: `The user regenerated your reply in #${store.getChannel(id!).name}${how}. The earlier one is kept as an alternate.`,
            channelId: id!,
            messageId: result.messages[0]?.id ?? null,
          });
        }
        return json({ ...turnResult(result), replacedIds: result.replaced, channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/cancel",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        // `cancelled` is false if nothing was running, e.g. the reply
        // arrived just before you pressed Stop.
        return json({ cancelled: friend.cancel(id!) });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/prompt",
      handler: (request, { id }) => {
        // For a roulette, the model notes depend on the profile picked, so
        // the preview shows a given profile (`?profile=<id>`), or the one a
        // roulette would pick first.
        const profileId = new URL(request.url).searchParams.get("profile");
        const profile = profileId ? store.profiles.get(profileId) : pickProfile(store, store.getChannel(id!), 0);
        // The preview never shows journal text (it's private to your friend).
        return json({ messages: promptForChannel(store, id!, { profile, preview: true }), profile });
      },
    },

    // ---------------------------------------------------------- messages
    {
      method: "PATCH",
      pattern: "/api/messages/:id",
      handler: async (request, { id }) => {
        const body = await readJson(request);
        // A scene break's "content" is its title, which may be empty.
        if (store.getLiveMessage(id!).kind === "scene_break") {
          const title = (body as { content?: unknown } | null)?.content;
          if (typeof title !== "string" || title.length > 200) {
            throw new HttpError(400, '"content" must be text of 200 characters at most.');
          }
          return json({ message: store.editMessage(id!, title.trim()) });
        }
        return json({ message: store.editMessage(id!, requireText(body, "content")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/messages/:id",
      handler: (_request, { id }) => {
        ensureIdle(store.getLiveMessage(id!).channelId);
        store.deleteMessage(id!);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/messages/:id/history",
      handler: (_request, { id }) => json(store.history(id!)),
    },
    {
      method: "GET",
      pattern: "/api/interventions",
      handler: () => json({ interventions: store.interventions.recent(100) }),
    },

    // -------------------------------------------------------- categories
    {
      method: "POST",
      pattern: "/api/categories",
      handler: async (request) => json({ category: store.createCategory(await readJson(request)), categories: store.listCategories() }),
    },
    {
      method: "PUT",
      pattern: "/api/categories/order",
      handler: async (request) => {
        const body = (await readJson(request)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of category ids.');
        }
        return json({ categories: store.reorderCategories(body.ids) });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/categories/:id",
      handler: async (request, { id }) => json({ category: store.updateCategory(id!, await readJson(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/categories/:id",
      handler: (_request, { id }) => {
        store.deleteCategory(id!);
        return json({ categories: store.listCategories(), channels: channelViews() });
      },
    },

    // --------------------------------------------------------- reactions
    {
      // Add your reaction, or take it back if it's there.
      method: "POST",
      pattern: "/api/messages/:id/reactions",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        if (store.getMessage(id!).kind !== "post") throw new HttpError(400, "Only posts can have reactions.");
        return json({ reactions: store.reactions.toggle(id!, "user", body.emoji) });
      },
    },
    {
      method: "GET",
      pattern: "/api/emojis",
      handler: () => json({ emojis: store.reactions.listEmojis() }),
    },
    {
      method: "POST",
      pattern: "/api/emojis",
      handler: async (request) => {
        // The image arrives as base64 text inside JSON, like theme files.
        const body = await readObject(request);
        if (typeof body.data !== "string") throw new HttpError(400, '"name" and "data" (base64) are required.');
        const emoji = store.reactions.addEmoji(body.name, Buffer.from(body.data, "base64"));
        return json({ emoji, emojis: store.reactions.listEmojis() });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/emojis/:name",
      handler: (_request, { name }) => {
        store.reactions.removeEmoji(name!);
        return json({ emojis: store.reactions.listEmojis() });
      },
    },

    // ---------------------------------------------------------- comments
    {
      method: "POST",
      pattern: "/api/messages/:id/comments",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        const quote = typeof body.quote === "string" ? body.quote : "";
        const thread = store.comments.start("user", id!, String(body.note ?? ""), quote);
        return json(await commentReply(thread.id));
      },
    },
    {
      method: "POST",
      pattern: "/api/comments/:id/replies",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        store.comments.reply("user", id!, String(body.note ?? ""));
        return json(await commentReply(id!));
      },
    },
    {
      method: "POST",
      pattern: "/api/comments/:id/resolve",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        return json({ thread: store.comments.resolve(id!, body.resolved !== false) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/comments/:id",
      handler: (_request, { id }) => {
        store.comments.delete("user", id!);
        return json({ ok: true });
      },
    },

    // ------------------------------------------------------- friend page
    {
      method: "GET",
      pattern: "/api/friend-page",
      handler: () => json(friendPage()),
    },
    {
      // Suggest a change to their identity or tastes: they accept or decline it.
      method: "POST",
      pattern: "/api/identity/suggestions",
      handler: async (request) => {
        const body = await readObject(request);
        const change: { identity?: string; tastes?: string; note?: string } = {};
        for (const key of ["identity", "tastes", "note"] as const) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== "string") throw new HttpError(400, `"${key}" must be text.`);
          change[key] = body[key] as string;
        }
        store.identity.suggest(change);
        store.interventions.add({ kind: "settings", summary: "The user suggested a change to your identity." });
        suggested();
        return json(friendPage());
      },
    },
    {
      method: "POST",
      pattern: "/api/identity/suggestions/:id/withdraw",
      handler: (_request, { id }) => {
        store.identity.withdraw(Number(id));
        return json(friendPage());
      },
    },
    {
      // Add a note to "what my writing shows": it arrives as a suggestion.
      method: "POST",
      pattern: "/api/self-page/notes",
      handler: async (request) => {
        const body = await readObject(request);
        if (typeof body.text !== "string") throw new HttpError(400, '"text" must be text.');
        const ids = body.messageIds ?? [];
        if (!Array.isArray(ids) || !ids.every((m) => typeof m === "string")) throw new HttpError(400, '"messageIds" must be a list of message ids.');
        store.selfPage.suggestNote(body.text, ids as string[]);
        store.interventions.add({ kind: "settings", summary: "The user suggested a note for your self-page." });
        suggested();
        return json(friendPage());
      },
    },
    {
      method: "POST",
      pattern: "/api/self-page/notes/:id/withdraw",
      handler: (_request, { id }) => {
        store.selfPage.withdrawNote(id!);
        return json(friendPage());
      },
    },
    {
      // Invite them to an orientation: they're told on their next turn.
      method: "POST",
      pattern: "/api/orientation/invite",
      handler: () => {
        inviteToOrientation(store);
        return json(friendPage());
      },
    },

    // ------------------------------------------------------------- inbox
    {
      method: "GET",
      pattern: "/api/inbox",
      handler: () => json({ inbox: store.inbox.open(), recent: store.inbox.recent(30) }),
    },
    {
      method: "POST",
      pattern: "/api/inbox/:id/:action",
      handler: async (request, { id, action }) => {
        const item = store.inbox.get(id!);
        if (action === "answer") {
          const body = await readObject(request);
          if (typeof body.answer !== "string") throw new HttpError(400, '"answer" must be text.');
          store.inbox.answer(id!, body.answer);
          store.interventions.add({ kind: "ask", summary: `The user answered your ask: "${item.text.slice(0, 80)}"` });
          // Your answer can give them a turn of their own, if the rules allow.
          if (autoWake) void wakeups.event("answer");
        } else if (action === "dismiss") {
          store.inbox.dismiss(id!);
          store.interventions.add({ kind: "ask", summary: `The user set aside your ask without answering: "${item.text.slice(0, 80)}"` });
        } else if (action === "approve" || action === "deny") {
          // Deleting a channel waits for a turn in progress there.
          if (action === "approve" && item.kind === "delete_channel" && item.targetId) ensureIdle(item.targetId);
          store.resolveProposal(id!, action === "approve");
        } else {
          throw new HttpError(404, "No such API route.");
        }
        return json({ inbox: store.inbox.open(), channels: channelViews() });
      },
    },

    // ------------------------------------------- profiles and roulettes
    {
      method: "GET",
      pattern: "/api/profiles",
      handler: () => json({ profiles: store.profiles.list(), roulettes: store.profiles.listRoulettes() }),
    },
    {
      method: "POST",
      pattern: "/api/profiles",
      handler: async (request) => json({ profile: store.profiles.create(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/profiles/:id",
      handler: async (request, { id }) => json({ profile: store.profiles.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/profiles/:id",
      handler: (_request, { id }) => {
        store.profiles.delete(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/profiles/:id/test",
      handler: async (_request, { id }) => json({ test: await testToolCalling(api, store.profiles.get(id!)) }),
    },
    {
      method: "POST",
      pattern: "/api/roulettes",
      handler: async (request) => json({ roulette: store.profiles.createRoulette(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/roulettes/:id",
      handler: async (request, { id }) => {
        const before = new Set(store.profiles.getRoulette(id!).entries.map((e) => e.profileId));
        const roulette = store.profiles.updateRoulette(id!, await readObject(request));
        // A profile new to the roulette: your friend is offered an orientation.
        const added = roulette.entries.filter((e) => !before.has(e.profileId)).map((e) => store.profiles.get(e.profileId).name);
        noteNewProfiles(store, added);
        return json({ roulette });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/roulettes/:id",
      handler: (_request, { id }) => {
        store.profiles.deleteRoulette(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },

    // ------------------------------------------------------ notebook & cast
    // Everything here acts as you ("user"): the notebook checks what you're
    // allowed to do (see src/permissions.ts).
    {
      method: "GET",
      pattern: "/api/notebook",
      handler: () =>
        json({
          folders: store.notebook.listFolders("user"),
          entries: store.notebook.listEntries("user"),
          // Each with who reviews it: you, or your friend (through their tools).
          suggestions: store.notebook
            .listSuggestions("user")
            .map((suggestion) => ({ ...suggestion, reviewer: store.notebook.reviewerOf(suggestion) })),
          templates: ENTRY_TEMPLATES,
        }),
    },
    {
      method: "POST",
      pattern: "/api/notebook/entries",
      handler: async (request) => json({ entry: store.notebook.createEntry("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/entries/:id",
      // Returns { entry } if saved, or { suggestion } if you can only suggest changes.
      handler: async (request, { id }) => json(maybeReview(store.notebook.editEntry("user", id!, await readObject(request)))),
    },
    {
      method: "PUT",
      pattern: "/api/notebook/entries/:id/settings",
      handler: async (request, { id }) =>
        json({ entry: store.notebook.updateEntrySettings("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/entries/:id",
      // Returns { deleted: true }, or { suggestion } for shared lore.
      handler: (_request, { id }) => json(maybeReview(store.notebook.deleteEntry("user", id!))),
    },
    {
      method: "POST",
      pattern: "/api/notebook/folders",
      handler: async (request) => json({ folder: store.notebook.createFolder("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/folders/:id",
      handler: async (request, { id }) =>
        json({ folder: store.notebook.updateFolder("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/folders/:id",
      handler: (_request, { id }) => {
        store.notebook.deleteFolder("user", id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/notebook/suggestions/:id/:action",
      handler: (_request, { id, action }) => {
        if (action === "withdraw") {
          store.notebook.withdrawSuggestion("user", id!);
          return json({ ok: true });
        }
        if (action !== "accept" && action !== "reject") throw new HttpError(404, "No such API route.");
        const decision = action === "accept" ? "accepted" : "rejected";
        return json({ suggestion: store.notebook.reviewSuggestion("user", id!, decision) });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.pin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.unpin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },

    // ------------------------------------------------------------ themes
    {
      method: "GET",
      pattern: "/api/themes",
      handler: () => json({ themes: themes.list() }),
    },
    {
      method: "POST",
      pattern: "/api/themes",
      handler: async (request) => {
        const body = (await readJson(request)) as { name?: unknown; from?: unknown } | null;
        const from = typeof body?.from === "string" ? body.from : DEFAULT_THEME;
        return json({ theme: themes.create(body?.name as string, from) });
      },
    },
    {
      method: "GET",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => json({ theme: themes.details(id!) }),
    },
    {
      method: "PATCH",
      pattern: "/api/themes/:id",
      handler: async (request, { id }) => {
        const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
        return json({ theme: themes.update(id!, body) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => {
        themes.remove(id!);
        // Anything using the theme goes back to the default.
        store.forgetTheme(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/themes/:id/files",
      handler: async (request, { id }) => {
        // Files arrive as base64 text inside JSON, so every request that
        // changes something stays JSON (see checkRequestIsFromTheApp).
        const body = (await readJson(request)) as { name?: unknown; data?: unknown } | null;
        if (typeof body?.name !== "string" || typeof body?.data !== "string") {
          throw new HttpError(400, '"name" and "data" (base64) are required.');
        }
        return json({ files: themes.addFile(id!, body.name, Buffer.from(body.data, "base64")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id/files/:name",
      handler: (_request, { id, name }) => json({ files: themes.removeFile(id!, name!) }),
    },
  ];

  /**
   * The top-level request handler: API routes, then static files, and turn
   * any thrown error into a JSON error response.
   */
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Custom emoji images: /emojis/<file>.
    const emojiFile = url.pathname.match(/^\/emojis\/([^/]+)$/);
    if (emojiFile && (request.method === "GET" || request.method === "HEAD")) {
      return store.reactions.serve(emojiFile[1]!) ?? new Response("Not found", { status: 404 });
    }

    // Theme files: /themes/<id>/<file>.
    const themeFile = url.pathname.match(/^\/themes\/([^/]+)\/([^/]+)$/);
    if (themeFile && (request.method === "GET" || request.method === "HEAD")) {
      return themes.serve(themeFile[1]!, themeFile[2]!) ?? new Response("Not found", { status: 404 });
    }

    if (!url.pathname.startsWith("/api/")) {
      return serveStatic(config.publicDir, url.pathname);
    }

    try {
      checkRequestIsFromTheApp(request);
      for (const route of routes) {
        const params = matchRoute(route, request.method, url.pathname);
        if (params) return await route.handler(request, params);
      }
      return errorResponse(404, "No such API route.");
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      if (error instanceof NotFoundError) return errorResponse(404, error.message);
      if (error instanceof BusyError) return errorResponse(409, error.message);
      if (error instanceof ValidationError) return errorResponse(400, error.message);
      if (error instanceof PermissionError) return errorResponse(403, error.message);
      // A turn you stopped isn't an error: the request that started it just
      // learns that nothing was written.
      if (error instanceof CancelledError) return json({ cancelled: true });
      if (error instanceof ApiError) return errorResponse(502, error.message);
      // Anything else is a bug, not something you did. Log the details for
      // debugging, and send a general message.
      console.error("[server] unexpected error", error);
      return errorResponse(500, "Something went wrong on the server.");
    }
  }

  return { fetch, store, friend, themes, summarizer, decider, wakeups, heartbeat, rhythms, presence, notifier };
}

/**
 * Run a friend turn, but report failure as data instead of throwing.
 * Used after sending a message, where the message itself has already been
 * saved successfully and only the reply failed.
 */
async function tryTurn(
  turn: () => Promise<TurnResult>,
): Promise<Partial<ReturnType<typeof turnResult>> & { error?: string; cancelled?: true }> {
  try {
    return turnResult(await turn());
  } catch (error) {
    if (error instanceof CancelledError) return { cancelled: true };
    if (error instanceof ApiError || error instanceof BusyError) return { error: error.message };
    throw error;
  }
}

/** A turn's result, as the app receives it. */
function turnResult(result: TurnResult) {
  return {
    friendMessages: result.messages,
    toolCalls: result.toolCalls,
    skipped: result.skipped,
    ...(result.thread ? { thread: result.thread } : {}),
  };
}

// -------------------------------------------------------- request helpers

/**
 * Basic protection against other websites using your server.
 *
 * Any web page open in your phone's browser could try to send requests to
 * `http://127.0.0.1:4747`. Browsers block such pages from *reading* the
 * answers, but a simple form-style POST could still make your friend take a
 * turn (and spend your nanoGPT balance). Requiring a JSON content type on
 * every request that changes something stops that: browsers won't send a
 * cross-site JSON request without first asking the server for permission,
 * and this server never gives it.
 */
function checkRequestIsFromTheApp(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "API requests that change data must be sent as JSON.");
  }
}

/** Parse the request body as JSON, with a clear error if it isn't. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

/**
 * Read the optional `postingAs` field of a message: the name of one of your
 * characters (for casual scenes), or nothing to post as yourself.
 */
function readPostingAs(body: unknown, characters: { name: string }[]): string | null {
  const value = (body as Record<string, unknown> | null)?.postingAs;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !characters.some((c) => c.name === value)) {
    throw new HttpError(400, `"postingAs" must be one of your characters.`);
  }
  return value;
}

/** Read a JSON body that must be an object. */
async function readObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Read a required, non-empty text field from a JSON body. */
function requireText(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" must be non-empty text.`);
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `"${field}" is too long.`);
  }
  return value;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ------------------------------------------------------------ static files

/**
 * Serve a file from `public/`.
 *
 * `/` serves `index.html`. The path is normalised and checked to stay inside
 * the public folder, so a request like `/../.env` can't read files elsewhere.
 */
async function serveStatic(publicDir: string, pathname: string): Promise<Response> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  // `no-cache` means "check with the server before using a cached copy", so
  // updates to the app show up on the next load instead of being stuck behind
  // a stale cache.
  return new Response(file, { headers: { "Cache-Control": "no-cache" } });
}

// --------------------------------------------------------------- start up

/** Start listening. Only runs when this file is executed directly. */
async function main(): Promise<void> {
  const config = loadConfig();
  // One app per friend, grouped into servers (src/hub.ts).
  const { createHub } = await import("./hub.ts");
  const hub = createHub(config);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: hub.fetch,
    // Model replies can take a while; don't let Bun close the connection on
    // a slow generation. (Bun's limit is in seconds, 255 at most; 0 = never.)
    idleTimeout: 0,
  });

  // Catch up on summaries that were due when the server last stopped, and
  // start each friend's heartbeat (which also keeps the phone awake while on).
  hub.start();

  console.log(`Kinaera is running at http://${server.hostname}:${server.port}`);
  console.log(`Saving your data in ${config.dataDir} (${hub.apps.size} friend${hub.apps.size === 1 ? "" : "s"})`);
  if (!config.apiKey) {
    console.warn("Warning: NANOGPT_API_KEY is not set, so your friend can't reply yet. See .env.example.");
  }
}

// `import.meta.main` is true when this file is run with `bun run src/server.ts`,
// and false when the tests import it. That way importing doesn't start a server.
if (import.meta.main) {
  void main();
}
