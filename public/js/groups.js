/**
 * Group channels and DMs in the app (src/groups.ts): the "Together" part
 * of the sidebar, peers' names and faces on their messages, and making,
 * hiding and deleting them in server settings.
 *
 * A group channel is kept by every friend in it. The page works on one
 * friend at a time, so opening a group channel opens it as a friend who's
 * in it (the open friend, if they are).
 */

import { channelIcon } from "./channels.js";
import { $, api, showFormError, state } from "./core.js";
import { paintAvatar, switchFriend } from "./friend-page.js";
import { seenMessages } from "./live.js";

/** The open server's groups and DMs (from the hub), visible ones only. */
export function serverGroups() {
  const server = (state.hub ?? []).find((s) => s.friends.some((p) => p.id === state.friendId));
  return (server?.groups ?? []).filter((g) => g.visible);
}

/** A friend on the hub, by id: {name, avatar, color}. */
export function hubFriend(id) {
  for (const server of state.hub ?? []) {
    const friend = server.friends.find((p) => p.id === id);
    if (friend) return friend;
  }
  return null;
}

/** Whether a channel is a group channel or DM. */
export const isShared = (channel) => channel?.kind === "group" || channel?.kind === "dm";

/** The "Together" section: a header, then each group channel and visible DM. */
export function groupItems() {
  const groups = serverGroups();
  if (groups.length === 0) return [];
  const header = document.createElement("li");
  header.className = "friend-section together-section";
  header.textContent = "Together";
  const seen = seenMessages();
  const items = groups.map((group) => {
    const item = document.createElement("li");
    item.className = "group-item";
    const link = document.createElement("a");
    link.className = "channel-link";
    link.dataset.kind = group.kind;
    link.draggable = false;
    link.href = `#/p/${encodeURIComponent(state.friendId)}/channel/${group.id}`;
    if (group.id === state.channelId) link.setAttribute("aria-current", "page");
    const names = group.friends.map((id) => hubFriend(id)?.name ?? "?");
    link.title = group.kind === "dm" ? `${names.join(" & ")}'s DM (you can read it)` : `You, ${names.join(", ")}`;
    const name = document.createElement("span");
    name.className = "channel-link-name";
    name.textContent = group.name;
    link.append(channelIcon(group.kind === "dm" ? "ooc" : "rp"), name);
    if (group.writing?.length) {
      const dot = document.createElement("span");
      dot.className = "channel-busy";
      dot.title = `${group.writing.join(", ")} writing`;
      link.append(dot);
    } else if (group.activity && group.activity.author !== "user" && seen[group.id] !== group.activity.lastId && group.id !== state.channelId) {
      const dot = document.createElement("span");
      dot.className = "channel-unread";
      link.append(dot);
    }
    // Opened as a friend who's in it: the open one if they are.
    link.addEventListener("click", (event) => {
      if (group.friends.includes(state.friendId)) return;
      event.preventDefault();
      switchFriend(group.friends[0], group.id);
    });
    item.append(link);
    return item;
  });
  return [header, ...items];
}

/** Who a group channel is with, for the top of the channel. */
export function groupTopic(channel) {
  const group = serverGroups().find((g) => g.id === channel.id);
  const names = (group?.friends ?? []).map((id) => hubFriend(id)?.name ?? "?");
  if (channel.kind === "dm") return `${names.join(" & ")}'s DM. You can read it; you can't write in it.`;
  return `You, ${names.join(", ")}. When you write, each friend may take a turn.`;
}

/** A peer's message: their name, and their face and colour. */
export function paintPeer(avatar, root, message) {
  const friend = message.speaker ? hubFriend(message.speaker.id) : null;
  paintAvatar(avatar, { name: message.speaker?.name ?? "?", avatar: friend?.avatar ?? "", color: friend?.color ?? -1 });
  if (friend && friend.color >= 0) {
    root.classList.add("has-character");
    root.style.setProperty("--avatar-hue", String(friend.color));
  }
}

// ------------------------------------------------------- server settings

/** The server's group channels and DMs, in server settings: DMs can be hidden, any can be deleted. */
export function renderServerGroups(server) {
  const list = $("server-group-list");
  const groups = server.groups ?? [];
  list.replaceChildren(
    ...groups.map((group) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = group.kind === "dm" ? `DM: ${group.name}` : `#${group.name}`;
      item.append(label);
      if (group.kind === "dm") {
        const toggle = document.createElement("label");
        toggle.className = "check-inline";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = group.visible;
        box.addEventListener("change", () => updateGroup(group.id, { visible: box.checked }));
        toggle.append(box, " I can read it");
        item.append(toggle);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteGroup(group));
      item.append(remove);
      return item;
    }),
  );
  if (groups.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "None yet.";
    list.append(empty);
  }
  // Friends to pick for a new group channel.
  $("group-friends").replaceChildren(
    ...server.friends.map((friend) => {
      const label = document.createElement("label");
      label.className = "check-inline";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = friend.id;
      box.checked = true;
      const face = document.createElement("span");
      face.className = "avatar";
      paintAvatar(face, friend);
      label.append(box, face, friend.name);
      return label;
    }),
  );
  $("new-group").hidden = server.friends.length < 2;
}

async function updateGroup(id, change) {
  try {
    state.hub = (await api("PATCH", `/api/hub/groups/${encodeURIComponent(id)}`, change)).servers;
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

async function deleteGroup(group) {
  const what = group.kind === "dm" ? `the DM ${group.name}` : `#${group.name}`;
  if (!confirm(`Delete ${what}, for everyone in it? Each friend's copy goes, with everything said there.`)) return;
  try {
    state.hub = (await api("DELETE", `/api/hub/groups/${encodeURIComponent(group.id)}`, {})).servers;
    location.reload();
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

/** Make a group channel with the friends ticked. */
export async function createGroup(serverId) {
  const name = $("group-name").value.trim();
  const friends = [...$("group-friends").querySelectorAll("input:checked")].map((box) => box.value);
  try {
    const data = await api("POST", `/api/hub/servers/${encodeURIComponent(serverId)}/groups`, { name, friends });
    state.hub = data.servers;
    switchFriend(friends.includes(state.friendId) ? state.friendId : friends[0], data.group.id);
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}
