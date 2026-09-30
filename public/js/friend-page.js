/**
 * Friends and servers: the rail on the left, switching between friends,
 * the friend menu (name, avatar, colour, how they write; opened from their
 * page, js/friend-self.js), making new friends, and server settings.
 */

import { channelIcon, parseAddress, renderAll } from "./channels.js";
import { $, api, els, hideFormError, readLocal, showFormError, state, writeLocal } from "./core.js";
import { initial } from "./format.js";
import { seenMessages } from "./live.js";
import { createGroup, renderServerGroups } from "./groups.js";

// ------------------------------------------------------ friends and servers

/*
 * Each friend is their own space, with their own memory (src/hub.ts);
 * servers group them in the rail on the left. The page works on one
 * friend at a time (`state.friendId`): opening another friend's channel,
 * or another server, switches to them.
 */

export const FRIEND_KEY = "kinaera.friend";

/** The servers and their friends (with each friend's channels and news), from the hub. */
export async function loadHub() {
  try {
    state.hub = (await api("GET", "/api/hub")).servers;
  } catch {
    state.hub = state.hub ?? [];
  }
}

const allFriends = () => (state.hub ?? []).flatMap((s) => s.friends.map((p) => ({ ...p, serverId: s.id })));
const currentServer = () => (state.hub ?? []).find((s) => s.friends.some((p) => p.id === state.friendId)) ?? null;
const serverName = (server) => server.name || server.friends[0]?.name || "Server";

/** Which friend to open: the address, then the last one you had open, then the first. */
export function pickFriend() {
  const friends = allFriends();
  const wanted = [parseAddress().friendId, readLocal(FRIEND_KEY)];
  return wanted.find((id) => id && friends.some((p) => p.id === id)) ?? friends[0]?.id ?? null;
}

/** Open another friend (and one of their channels): the page starts over as theirs. */
export function switchFriend(friendId, channelId = null) {
  writeLocal(FRIEND_KEY, friendId);
  const hash = `#/p/${encodeURIComponent(friendId)}${channelId ? `/channel/${encodeURIComponent(channelId)}` : ""}`;
  history.replaceState(null, "", hash);
  location.reload();
}

/** An avatar: an emoji or an initial, in the friend's colour. */
export function paintAvatar(element, { name, avatar, color }) {
  element.textContent = avatar || initial(name ?? "?");
  element.classList.toggle("emoji-avatar", Boolean(avatar));
  if (color >= 0) element.style.setProperty("--friend-hue", String(color));
  else element.style.removeProperty("--friend-hue");
  element.classList.toggle("colored-avatar", color >= 0);
}

/** Whether a friend (not the open one) has news in any channel. */
function friendHasNews(friend) {
  const seen = seenMessages();
  return friend.channels.some((c) => {
    const a = friend.activity[c.id];
    return a && a.author === "friend" && c.id !== state.channelId && seen[c.id] !== a.lastId;
  });
}

/** The rail: one button per server, and + for a new one. */
export function renderRail() {
  const rail = $("server-rail");
  if (!rail || !state.hub) return;
  const current = currentServer();
  const buttons = state.hub.map((server) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "server-button";
    if (server === current) button.setAttribute("aria-current", "true");
    button.title = serverName(server);
    button.setAttribute("aria-label", serverName(server));
    const first = server.friends[0];
    const face = document.createElement("span");
    face.className = "avatar server-face";
    if (server.friends.length === 1 || !server.name) paintAvatar(face, first);
    else paintAvatar(face, { name: server.name, avatar: "", color: first?.color ?? -1 });
    button.append(face);
    if (server.friends.some((p) => p.id !== state.friendId && friendHasNews(p))) {
      const dot = document.createElement("span");
      dot.className = "server-unread";
      button.append(dot);
    }
    button.addEventListener("click", () => {
      if (server === current) return openServerSettings();
      const last = readLocal(`kinaera.friend.${server.id}`);
      switchFriend(server.friends.find((p) => p.id === last)?.id ?? first.id);
    });
    return button;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "server-button server-add";
  add.title = "New server, with a new friend";
  add.setAttribute("aria-label", "New server");
  add.textContent = "+";
  add.addEventListener("click", () => openNewFriend(null));
  rail.replaceChildren(...buttons, add);
  $("server-name").textContent = current ? serverName(current) : "Kinaera";
  if (current) writeLocal(`kinaera.friend.${current.id}`, state.friendId);
}

/**
 * In a server with several friends, the sidebar shows each one's channels
 * under their name. The open friend's are the real, draggable list; the
 * others' are links that switch to them.
 */
export function otherFriendItems() {
  const server = currentServer();
  if (!server || server.friends.length < 2) return { before: [], after: [], header: null };
  const index = server.friends.findIndex((p) => p.id === state.friendId);
  const section = (friend) => {
    const header = document.createElement("li");
    header.className = "friend-section";
    const face = document.createElement("span");
    face.className = "avatar";
    paintAvatar(face, friend);
    const name = document.createElement("span");
    name.textContent = friend.name;
    header.append(face, name);
    return header;
  };
  const items = (friend) => {
    const categories = new Map(friend.categories.map((c) => [c.id, c.position]));
    const order = (c) => [c.categoryId ? 1 + (categories.get(c.categoryId) ?? 0) : 0, c.position];
    return [...friend.channels]
      .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
      .map((channel) => {
        const item = document.createElement("li");
        item.className = "remote-channel";
        const link = document.createElement("a");
        link.className = "channel-link";
        link.href = `#/p/${encodeURIComponent(friend.id)}/channel/${channel.id}`;
        link.draggable = false;
        const label = document.createElement("span");
        label.className = "channel-link-name";
        label.textContent = channel.name;
        link.append(channelIcon(channel.kind), label);
        const a = friend.activity[channel.id];
        if (a && a.author === "friend" && seenMessages()[channel.id] !== a.lastId) {
          const dot = document.createElement("span");
          dot.className = "channel-unread";
          link.append(dot);
        }
        item.append(link);
        return item;
      });
  };
  const before = server.friends.slice(0, index).flatMap((p) => [section(p), ...items(p)]);
  const after = server.friends.slice(index + 1).flatMap((p) => [section(p), ...items(p)]);
  return { before, after, header: section({ ...server.friends[index], ...currentFriendLook() }) };
}

const currentFriendLook = () => ({ name: state.settings.friendName, avatar: state.settings.friendAvatar, color: state.settings.friendColor });

// ------------------------------------------------------------ the friend menu

export function openFriend() {
  const s = state.settings;
  const form = $("friend-form").elements;
  paintAvatar($("friend-dialog-avatar"), currentFriendLook());
  $("friend-dialog-title").textContent = s.friendName;
  form.friendName.value = s.friendName;
  form.friendAvatar.value = s.friendAvatar;
  form.themeColor.checked = s.friendColor < 0;
  form.friendColor.value = s.friendColor < 0 ? 260 : s.friendColor;
  form.friendColor.disabled = s.friendColor < 0;
  for (const key of ["friendPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"]) form[key].value = s[key];
  form.oocBubbles.checked = s.oocBubbles;
  form.replyDelaySeconds.value = s.replyDelayMs / 1000;
  form.typingPerCharMs.value = s.typingPerCharMs;
  updateTextingOnly();
  $("surprise-result").textContent = "Reroll who they are from a few random ingredients. Nothing changes until you press Save.";
  $("friend-move").hidden = (currentServer()?.friends.length ?? 1) < 2;
  hideFormError($("friend-form"));
  $("friend-dialog").showModal();
}

async function saveFriend(event) {
  event.preventDefault();
  const form = $("friend-form").elements;
  try {
    const { settings, suggestion } = await api("PUT", "/api/settings", {
      friendName: form.friendName.value,
      friendAvatar: form.friendAvatar.value,
      friendColor: form.themeColor.checked ? -1 : Number(form.friendColor.value),
      friendPrompt: form.friendPrompt.value,
      literaryPrompt: form.literaryPrompt.value,
      casualPrompt: form.casualPrompt.value,
      oocPrompt: form.oocPrompt.value,
      oocBubbles: form.oocBubbles.checked,
      replyDelayMs: Math.round(Number(form.replyDelaySeconds.value) * 1000),
      typingPerCharMs: Number(form.typingPerCharMs.value),
    });
    state.settings = settings;
    $("friend-dialog").close();
    // A change to who they are is a suggestion, waiting for them.
    if (suggestion) alert(`Your change to who ${settings.friendName} is was sent as a suggestion: they'll accept or decline it on their next turn.`);
    await loadHub();
    renderAll();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

/** Show the texting numbers only when texting is on. */
function updateTextingOnly() {
  const form = $("friend-form");
  for (const element of form.querySelectorAll(".texting-only")) element.hidden = !form.elements.oocBubbles.checked;
}

/** The friend menu's avatar follows what you type and pick. */
function previewFriendLook() {
  const form = $("friend-form").elements;
  form.friendColor.disabled = form.themeColor.checked;
  paintAvatar($("friend-dialog-avatar"), {
    name: form.friendName.value,
    avatar: form.friendAvatar.value.trim(),
    color: form.themeColor.checked ? -1 : Number(form.friendColor.value),
  });
}

/** Friend menu → "Surprise me": reroll who they are, filled in but not saved. */
async function surpriseFriend() {
  const button = $("surprise-friend");
  const result = $("surprise-result");
  button.disabled = true;
  result.textContent = "Rolling…";
  try {
    const { name, prompt, seeds } = await api("POST", "/api/friend/random", {});
    const form = $("friend-form").elements;
    form.friendName.value = name;
    form.friendPrompt.value = prompt;
    previewFriendLook();
    result.textContent = `Meet ${name} (${seeds}). Press Save to keep them, or roll again.`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function deleteFriend() {
  const name = state.settings.friendName;
  if (!confirm(`Delete ${name}? Their notebook, channels and everything they remember go too. (Their files are kept in the data folder's trash, just in case.)`)) return;
  if (prompt(`Type ${name} to confirm.`)?.trim() !== name) return;
  try {
    await api("DELETE", `/api/hub/friends/${encodeURIComponent(state.friendId)}`, {});
    writeLocal(FRIEND_KEY, "");
    history.replaceState(null, "", location.pathname);
    location.reload();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

/** Give the open friend a server of their own. */
async function moveFriendOut() {
  try {
    await api("POST", `/api/hub/friends/${encodeURIComponent(state.friendId)}/move`, {});
    await loadHub();
    $("friend-dialog").close();
    renderAll();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

// -------------------------------------------------------- new friends

/** A new friend: in a new server (`serverId` null), or in that server. */
function openNewFriend(serverId) {
  state.newFriendServer = serverId;
  const form = $("new-friend-form");
  form.reset();
  const server = serverId && state.hub.find((s) => s.id === serverId);
  $("new-friend-title").textContent = server ? `A new friend in ${serverName(server)}` : "New server";
  $("new-friend-note").textContent = server
    ? "Another friend here, with their own notebook, channels and memory. Their channels show under their name."
    : "A new friend, with a server of their own. They start fresh: their own notebook, channels and memory, with your connection profiles and preferences.";
  $("new-server-name-row").hidden = Boolean(server);
  $("new-friend-surprise-result").textContent = "";
  state.newFriendTastes = "";
  hideFormError(form);
  $("new-friend-dialog").showModal();
}

async function surpriseNewFriend() {
  const button = $("new-friend-surprise");
  const result = $("new-friend-surprise-result");
  button.disabled = true;
  result.textContent = "Rolling…";
  try {
    const { name, prompt, tastes, seeds } = await api("POST", "/api/friend/random", {});
    const form = $("new-friend-form").elements;
    form.name.value = name;
    form.prompt.value = prompt;
    state.newFriendTastes = tastes ?? "";
    result.textContent = `Meet ${name} (${seeds}). Roll again, or Create.`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function createFriend(event) {
  event.preventDefault();
  const form = $("new-friend-form").elements;
  const body = { name: form.name.value, avatar: form.avatar.value, copyFrom: state.friendId };
  if (form.prompt.value.trim()) body.prompt = form.prompt.value;
  // Tastes rolled with "Surprise me" (theirs to rewrite from then on).
  if (state.newFriendTastes) body.tastes = state.newFriendTastes;
  const button = $("new-friend-create");
  button.disabled = true;
  try {
    const serverId = state.newFriendServer;
    const data = serverId
      ? await api("POST", `/api/hub/servers/${encodeURIComponent(serverId)}/friends`, body)
      : await api("POST", "/api/hub/servers", { ...body, serverName: form.serverName.value });
    switchFriend(data.friendId);
  } catch (error) {
    showFormError($("new-friend-form"), error.message);
    button.disabled = false;
  }
}

// ------------------------------------------------------------- servers

function openServerSettings() {
  const server = currentServer();
  if (!server) return;
  $("server-name-input").value = server.name;
  $("server-friend-list").replaceChildren(
    ...server.friends.map((friend) => {
      const item = document.createElement("li");
      const face = document.createElement("span");
      face.className = "avatar";
      paintAvatar(face, friend.id === state.friendId ? currentFriendLook() : friend);
      const name = document.createElement("span");
      name.textContent = friend.id === state.friendId ? `${friend.name} (open)` : friend.name;
      item.append(face, name);
      return item;
    }),
  );
  $("server-delete").hidden = state.hub.length < 2;
  renderServerGroups(server);
  hideFormError($("server-form"));
  $("server-dialog").showModal();
}

async function saveServer(event) {
  event.preventDefault();
  try {
    const data = await api("PATCH", `/api/hub/servers/${encodeURIComponent(currentServer().id)}`, { name: $("server-name-input").value });
    state.hub = data.servers;
    $("server-dialog").close();
    renderRail();
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

async function deleteServer() {
  const server = currentServer();
  const names = server.friends.map((p) => p.name).join(", ");
  if (!confirm(`Delete the server "${serverName(server)}", and ${names} with it? Everything they remember goes too. (Their files are kept in the data folder's trash.)`)) return;
  if (prompt(`Type ${serverName(server)} to confirm.`)?.trim() !== serverName(server)) return;
  try {
    await api("DELETE", `/api/hub/servers/${encodeURIComponent(server.id)}`, {});
    writeLocal(FRIEND_KEY, "");
    history.replaceState(null, "", location.pathname);
    location.reload();
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

$("open-friend-from-settings").addEventListener("click", () => {
  els.settingsDialog.close();
  openFriend();
});
$("friend-form").addEventListener("submit", saveFriend);
$("friend-form").addEventListener("input", previewFriendLook);
$("friend-form").elements.oocBubbles.addEventListener("change", updateTextingOnly);
$("surprise-friend").addEventListener("click", surpriseFriend);
$("friend-delete").addEventListener("click", deleteFriend);
$("friend-move").addEventListener("click", moveFriendOut);
$("new-friend-form").addEventListener("submit", createFriend);
$("new-friend-surprise").addEventListener("click", surpriseNewFriend);
$("server-name").addEventListener("click", openServerSettings);
$("server-form").addEventListener("submit", saveServer);
$("server-delete").addEventListener("click", deleteServer);
$("create-group").addEventListener("click", () => createGroup(currentServer().id));
$("server-add-friend").addEventListener("click", () => {
  $("server-dialog").close();
  openNewFriend(currentServer().id);
});
