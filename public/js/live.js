/**
 * Keeping the page up to date without being asked.
 *
 * Your friend can write on their own (a wake-up, the heartbeat), so while
 * the app is showing it checks every few seconds whether anything changed,
 * and marks channels with messages you haven't seen. It also notices when
 * the server has a newer version of the app, and reloads.
 */

import { renderAll, renderSidebar } from "./channels.js";
import { $, api, els, readLocal, state, writeLocal } from "./core.js";
import { loadHub } from "./friend-page.js";
import { refreshMessages } from "./messages.js";

/** Fetch settings, channels and busy channels from the server. */
export async function loadState() {
  const data = await api("GET", "/api/state");
  state.settings = data.settings;
  state.channels = data.channels;
  state.practice = data.practice ?? null;
  state.waiting = data.waiting ?? state.waiting;
  state.profiles = data.profiles;
  state.roulettes = data.roulettes;
  state.inbox = data.inbox ?? [];
  state.busy = new Set(data.busyChannels);
  state.revision = data.revision;
  state.activity = data.activity ?? {};
  // The very first time, everything that's there counts as read.
  if (readLocal(SEEN_KEY) === null) {
    writeLocal(SEEN_KEY, JSON.stringify(Object.fromEntries(Object.entries(state.activity).map(([id, a]) => [id, a?.lastId ?? null]))));
  }
  state.emojis = data.emojis ?? [];
  state.categories = data.categories ?? [];
  state.notifications = data.notifications ?? false;
  state.heartbeatNext = data.heartbeatNext ?? null;
  state.appVersion ??= data.appVersion;
  checkForUpdate(data.appVersion);
}

// ----------------------------------------------------------- live updates

/*
 * Your friend can write without being asked (stage 8: a wake-up when you
 * open the app, or when a scene ends). So while the app is showing, it
 * checks every few seconds whether any message changed (the server's
 * `revision`), and if so reloads the channel list and the open channel.
 * Channels with a new message from your friend that you haven't seen get
 * a dot. What you've seen is remembered on this device.
 */

/** How often to check for new messages while the app is showing. */
export const LIVE_CHECK_INTERVAL = 15_000;
/** Coming back after this long away counts as opening the app (a possible wake-up). */
export const WAKE_AFTER_HIDDEN = 5 * 60_000;
/** Each channel's newest message you've seen: {channelId: messageId}. */
const SEEN_KEY = "kinaera.seen";

export function seenMessages() {
  try {
    return JSON.parse(readLocal(SEEN_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Remember the open channel's newest message as seen. */
export function markSeen() {
  const last = state.messages.at(-1);
  if (!state.channelId || !last || last.id === "pending") return;
  const seen = seenMessages();
  if (seen[state.channelId] === last.id) return;
  seen[state.channelId] = last.id;
  writeLocal(SEEN_KEY, JSON.stringify(seen));
  if (state.activity?.[state.channelId]) state.activity[state.channelId].lastId = last.id;
}

/** Whether a channel has a message from your friend you haven't seen. */
export function isUnread(channel) {
  const activity = state.activity?.[channel.id];
  if (!activity || activity.author !== "friend" || channel.id === state.channelId) return false;
  return seenMessages()[channel.id] !== activity.lastId;
}

/** Check for messages the app didn't ask for, and show them. */
export async function checkLive() {
  if (document.visibilityState !== "visible") return;
  sendPresence();
  // Other friends' and servers' news, for the dots in the rail and sidebar.
  loadHub().then(() => renderSidebar());
  // Not while texts are still being revealed, or waiting for you to pause.
  if (state.busy.size > 0 || state.reveal || state.replyTimer) return;
  let data;
  try {
    data = await api("GET", "/api/state");
  } catch {
    return; // the server's away for a moment
  }
  checkForUpdate(data.appVersion);
  state.heartbeatNext = data.heartbeatNext ?? null;
  if (data.revision === state.revision) return;
  state.revision = data.revision;
  state.activity = data.activity ?? {};
  state.channels = data.channels;
  state.practice = data.practice ?? null;
  state.waiting = data.waiting ?? state.waiting;
  state.categories = data.categories ?? state.categories;
  state.inbox = data.inbox ?? [];
  state.settings = data.settings;
  for (const channelId of data.busyChannels) state.busy.add(channelId);
  const open = state.activity[state.channelId];
  const shown = state.messages.at(-1)?.id ?? null;
  // Reload the open channel if it changed (unless you're editing in it).
  if (state.channelId && (open?.lastId ?? null) !== shown && state.editingId === null) await refreshMessages();
  else renderAll();
}

/** Tell the server you've opened the app: your friend may wake up. */
export function sayOpened() {
  api("POST", "/api/wake", { event: "opened" }).catch(() => {});
}

// ------------------------------------------------------------- updates

/*
 * An installed app can stay open in the background for days. After you
 * update Kinaera and restart the server, a page that's still open would keep
 * running the old code (and miss things like new buttons). So the server
 * sends a fingerprint of the app's files (`appVersion`), and the page checks
 * it whenever it hears from the server, and whenever you come back to it.
 */

/**
 * Compare the server's app version with the one this page started with. If
 * they differ, reload, unless that would throw something away (unsent
 * text, an open dialog, a reply being written), in which case offer a
 * Reload button instead.
 */
export function checkForUpdate(serverVersion) {
  if (!serverVersion || !state.appVersion || serverVersion === state.appVersion) return;

  const unsentText = els.input.value.trim() !== "" || [...state.drafts.values()].some((d) => d.trim() !== "");
  const busy = state.busy.size > 0 || state.editingId !== null || document.querySelector("dialog[open]");
  if (!unsentText && !busy) {
    location.reload();
  } else {
    $("update-banner").hidden = false;
  }
}

/** Ask the server for its app version (used when you come back to the app). */
export async function checkServerVersion() {
  try {
    const data = await api("GET", "/api/state");
    checkForUpdate(data.appVersion);
  } catch {
    // Server not running right now; nothing to compare.
  }
}

/** Tell the server whether the app is on screen (no notifications while it is). */
export function sendPresence() {
  api("POST", "/api/presence", { visible: document.visibilityState === "visible" }).catch(() => {});
}
