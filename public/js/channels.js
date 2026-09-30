/**
 * Channels and the sidebar: opening, creating, renaming and deleting
 * channels, categories, dragging to rearrange, and each channel's header and
 * settings.
 *
 * The open channel is kept in the address bar (`#/p/<friend>/channel/<id>`),
 * so reloading the page, or reopening the app, brings you back to it.
 */

import { autoGrow, renderComposer } from "./composer.js";
import {
  $,
  api,
  channelPath,
  currentChannel,
  els,
  hideError,
  hideFormError,
  showError,
  showFormError,
  state,
} from "./core.js";
import { otherFriendItems, paintAvatar, renderRail } from "./friend-page.js";
import { groupItems, groupTopic, isShared } from "./groups.js";
import { renderInboxBadge } from "./inbox.js";
import { isUnread, loadState, markSeen } from "./live.js";
import { currentSceneIsEmpty, friendTurn, renderMessages, scrollToBottom } from "./messages.js";
import { loadNotebook, renderCastEditor } from "./notebook.js";
import { assignmentName, fillAssignmentSelect } from "./settings.js";
import { refreshSummaries, renderMemory } from "./summaries.js";
import { stopReveal } from "./texting.js";
import { applyThemes } from "./themes.js";

// ------------------------------------------------------------- channels

/**
 * Open a channel: load its messages and redraw everything.
 * Also used to refresh the open channel after changes.
 */
export async function openChannel(channelId) {
  // Keep whatever you'd typed in the channel you're leaving.
  if (state.channelId) state.drafts.set(state.channelId, els.input.value);
  // Leaving texts your friend hasn't answered yet: they answer now.
  if (state.replyTimer && state.channelId !== channelId) {
    clearTimeout(state.replyTimer);
    state.replyTimer = 0;
    friendTurn();
  }
  stopReveal();

  state.channelId = channelId;
  state.editingId = null;
  state.messages = [];
  state.toolCalls = [];
  state.threads = [];
  state.summaries = null;
  state.openSummaries.clear();
  hideError();

  // Put the channel in the address bar without adding a history entry for
  // every switch. (Only if it isn't there already, to avoid a loop with the
  // hashchange handler.)
  const hash = channelId ? `#/p/${encodeURIComponent(state.friendId)}/channel/${channelId}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);

  if (channelId) {
    try {
      const { messages, toolCalls, threads, summaries, flags } = await api("GET", channelPath("messages", channelId));
      // Ignore the answer if you switched again while it was loading.
      if (state.channelId !== channelId) return;
      state.messages = messages;
      state.toolCalls = toolCalls;
      state.threads = threads;
      state.summaries = summaries;
      state.flags = flags ?? { voice: [], notMe: {} };
    } catch (error) {
      showError(`Couldn't load this channel: ${error.message}`, () => openChannel(channelId));
    }
  }

  els.input.value = state.drafts.get(channelId) ?? "";
  autoGrow();
  renderAll();
  scrollToBottom();
}

/** The channel named in the address bar, if it exists. */
export function channelFromAddress() {
  const { channelId } = parseAddress();
  return state.channels.some((c) => c.id === channelId) || state.practice?.id === channelId ? channelId : null;
}

/** The friend and channel in the address: #/p/<friend>/channel/<id> (or the older #/channel/<id>). */
export function parseAddress() {
  const match = location.hash.match(/^#(?:\/p\/([^/]+))?\/channel\/(.+)$/);
  return { friendId: match?.[1] ? decodeURIComponent(match[1]) : null, channelId: match ? decodeURIComponent(match[2]) : null };
}

export async function createChannel(event) {
  event.preventDefault();
  const form = els.newChannelForm.elements;
  const kind = form.kind.value;
  const body = { name: form.name.value, kind, categoryId: form.category.value || null };
  if (kind === "rp") body.mode = form.mode.value;
  try {
    let { channel } = await api("POST", "/api/channels", body);
    // Pin the character picked for your friend, if any.
    if (kind === "rp" && form.cast.value) {
      ({ channel } = await api("PUT", channelPath(`cast/${encodeURIComponent(form.cast.value)}`, channel.id), {}));
      await loadNotebook();
    }
    state.channels.push(channel);
    els.newChannelDialog.close();
    closeSidebar();
    openChannel(channel.id);
  } catch (error) {
    showFormError(els.newChannelForm, error.message);
  }
}

export async function saveChannel(event) {
  event.preventDefault();
  const channel = currentChannel();
  const form = els.channelForm.elements;
  const body = {
    name: form.name.value,
    theme: form.theme.value || null,
    assignment: form.assignment.value || null,
    categoryId: form.category.value || null,
  };
  if (channel.kind === "rp") body.mode = form.mode.value;
  try {
    const { channel: updated } = await api("PATCH", `/api/channels/${encodeURIComponent(channel.id)}`, body);
    state.channels = state.channels.map((c) => (c.id === updated.id ? updated : c));
    els.channelDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** Move the open channel one place up (-1) or down (+1) in the sidebar, within its category. */
export async function moveChannel(step) {
  const groups = sidebarGroups().map((g) => g.channels.map((c) => c.id));
  const group = groups.find((ids) => ids.includes(state.channelId));
  const from = group.indexOf(state.channelId);
  const to = from + step;
  if (to < 0 || to >= group.length) return;
  // Swap the two neighbours.
  [group[from], group[to]] = [group[to], group[from]];
  const ids = groups.flat();
  try {
    const { channels } = await api("PUT", "/api/channels/order", { ids });
    state.channels = channels;
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

export async function deleteChannel() {
  const channel = currentChannel();
  if (!confirm(`Delete #${channel.name} and every message in it? This can't be undone.`)) return;
  try {
    await api("DELETE", `/api/channels/${encodeURIComponent(channel.id)}`, {});
    state.channels = state.channels.filter((c) => c.id !== channel.id);
    state.drafts.delete(channel.id);
    els.channelDialog.close();
    openChannel(state.channels[0]?.id ?? null);
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

export async function clearChannel() {
  const channel = currentChannel();
  if (!confirm(`Clear every message from #${channel.name}? They leave the chat, but each one is kept in its history.`)) return;
  try {
    await api("DELETE", channelPath("messages"), {});
    state.messages = [];
    els.channelDialog.close();
    renderMessages();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

// -------------------------------------------------------------- rendering

/** Redraw everything from `state`. */
export function renderAll() {
  markSeen();
  applyThemes();
  renderSidebar();
  renderChannelHeader();
  renderMessages();
  renderComposer();
  renderInboxBadge();
}

/** The channel list and the friend card at the bottom of the sidebar. */
export function renderSidebar() {
  // Not in the middle of a drag: that would pull the channel from under your finger.
  if (state.dragging) return;
  const items = [];
  for (const { category, channels } of sidebarGroups()) {
    if (category) items.push(renderCategoryHeader(category, channels));
    for (const channel of channels) {
      // A folded category still shows the channel you're in, like Discord.
      if (category?.collapsed && channel.id !== state.channelId) continue;
      items.push(renderChannelItem(channel, category));
    }
  }
  // Their practice channel, apart from the rest (not draggable).
  if (state.practice) items.push(renderPracticeItem(state.practice));
  // Other friends in this server: their channels, under their names.
  const others = otherFriendItems();
  els.channelList.replaceChildren(...groupItems(), ...others.before, ...(others.header ? [others.header] : []), ...items, ...others.after);

  // The indicator goes back in after the links, and moves to the open one.
  els.channelList.append(els.channelIndicator);
  moveChannelIndicator();

  const friendName = state.settings?.friendName ?? "Friend";
  els.friendName.textContent = friendName;
  // Under their name: their own status (set_status), else what they're doing now.
  const doing = { writing: "writing…", reading: "reading…", quiet: "quiet hours" }[state.presence] ?? "your friend";
  $("friend-role").textContent = state.status?.text ?? doing;
  $("friend-role").title = state.status ? `Status, set by ${friendName}` : "";
  $("friend-card").dataset.presence = state.presence ?? "idle";
  paintAvatar(els.friendAvatar, { name: friendName, avatar: state.settings?.friendAvatar, color: state.settings?.friendColor });
  renderRail();
}

/** The practice channel: your friend's own, which you can read. */
function renderPracticeItem(channel) {
  const item = renderChannelItem(channel, null);
  delete item.dataset.channelId; // not one of the channels you order
  item.dataset.practiceId = channel.id;
  item.className = "practice-item";
  const link = item.querySelector(".channel-link");
  link.title = `${state.settings.friendName}'s own channel, for trying things out. You can read it.`;
  return item;
}

/** One channel in the sidebar. */
function renderChannelItem(channel, category) {
  const item = document.createElement("li");
  item.dataset.channelId = channel.id;
  if (category) item.dataset.inCategory = category.id;
  const link = document.createElement("a");
  link.className = "channel-link";
  link.href = `#/channel/${channel.id}`;
  link.draggable = false; // dragging is ours (see "Dragging in the sidebar")
  link.dataset.kind = channel.kind;
  if (channel.id === state.channelId) link.setAttribute("aria-current", "page");
  link.title =
    channel.kind === "ooc"
      ? "Out of character"
      : [...castNames(channel, "friend"), ...castNames(channel, "both")].join(", ") || "Roleplay";

  const name = document.createElement("span");
  name.className = "channel-link-name";
  name.textContent = channel.name;
  link.append(channelIcon(channel.kind), name);

  if (state.busy.has(channel.id)) {
    const dot = document.createElement("span");
    dot.className = "channel-busy";
    dot.title = "Your friend is writing here";
    link.append(dot);
  } else if (isUnread(channel)) {
    const dot = document.createElement("span");
    dot.className = "channel-unread";
    dot.title = "A new message from your friend";
    link.append(dot);
  }
  item.append(link);
  return item;
}

/** A category's header: fold it up or open it, and edit it. */
function renderCategoryHeader(category, channels) {
  const item = document.createElement("li");
  item.className = "category-item";
  item.dataset.categoryId = category.id;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "category-toggle";
  toggle.setAttribute("aria-expanded", String(!category.collapsed));
  const chevron = document.createElement("span");
  chevron.className = "category-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  const name = document.createElement("span");
  name.className = "category-name";
  name.textContent = category.name;
  toggle.append(chevron, name);
  // Folded up, a dot says something new is inside.
  if (category.collapsed && channels.some((c) => c.id !== state.channelId && isUnread(c))) {
    const dot = document.createElement("span");
    dot.className = "channel-unread";
    dot.title = "A new message from your friend";
    toggle.append(dot);
  }
  toggle.addEventListener("click", () => toggleCategory(category));
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "category-menu icon-button";
  menu.title = `Edit ${category.name}`;
  menu.setAttribute("aria-label", `Edit category ${category.name}`);
  menu.textContent = "⋯";
  menu.addEventListener("click", () => openCategory(category));
  item.append(toggle, menu);
  return item;
}

/**
 * The channels grouped as the sidebar shows them: those outside any
 * category first, then each category's, each in order.
 */
function sidebarGroups() {
  const known = new Set(state.categories.map((c) => c.id));
  // Group channels and DMs are listed with the server ("Together"), not here.
  const ordered = state.channels.filter((c) => !isShared(c)).sort((a, b) => a.position - b.position);
  const group = (id) => ordered.filter((c) => (known.has(c.categoryId) ? c.categoryId : null) === id);
  return [{ category: null, channels: group(null) }, ...state.categories.map((category) => ({ category, channels: group(category.id) }))];
}

async function toggleCategory(category) {
  category.collapsed = !category.collapsed;
  renderSidebar();
  try {
    await api("PATCH", `/api/categories/${encodeURIComponent(category.id)}`, { collapsed: category.collapsed });
  } catch (error) {
    showError(`Couldn't save that: ${error.message}`);
  }
}

/** Make a category (no `category`), or rename or delete one. */
export function openCategory(category = null, afterCreate = null) {
  const dialog = $("category-dialog");
  hideFormError(dialog);
  state.editingCategory = category;
  state.afterCategory = afterCreate;
  $("category-title").textContent = category ? "Category" : "New category";
  $("category-name").value = category?.name ?? "";
  $("category-delete").hidden = !category;
  dialog.showModal();
}

export async function saveCategory(event) {
  event.preventDefault();
  const dialog = $("category-dialog");
  const name = $("category-name").value;
  try {
    const editing = state.editingCategory;
    if (editing) {
      const { category } = await api("PATCH", `/api/categories/${encodeURIComponent(editing.id)}`, { name });
      state.categories = state.categories.map((c) => (c.id === category.id ? category : c));
    } else {
      const { category, categories } = await api("POST", "/api/categories", { name });
      state.categories = categories;
      state.afterCategory?.(category);
    }
    dialog.close();
    renderSidebar();
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

export async function deleteCategory() {
  const category = state.editingCategory;
  if (!category || !confirm(`Delete the category "${category.name}"? Its channels stay, outside any category.`)) return;
  try {
    const { categories, channels } = await api("DELETE", `/api/categories/${encodeURIComponent(category.id)}`, {});
    state.categories = categories;
    state.channels = channels;
    $("category-dialog").close();
    renderSidebar();
  } catch (error) {
    showFormError($("category-dialog"), error.message);
  }
}

/** Fill a "Category" select: none, then each category. */
export function fillCategorySelect(select, value) {
  select.replaceChildren(new Option("None", ""), ...state.categories.map((c) => new Option(c.name, c.id)));
  select.value = value ?? "";
}

// ------------------------------------------------ dragging in the sidebar

/*
 * Drag a channel to reorder it, or into (or out of) a category; drag a
 * category's header to reorder the categories. With a mouse, just drag;
 * on a phone, press and hold for a moment first (so scrolling still
 * works), and feel a little buzz when it picks up.
 *
 * While dragging, a copy follows your finger and a line shows where it
 * will land. A channel lands in the category whose header is above the
 * line (none, above all the headers). Everything is saved at once when
 * you let go: the new order, and the channel's category.
 */

const drag = { pending: null, active: null, justDropped: false };

els.channelList.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag.active) return;
  const item = event.target.closest("li[data-channel-id], li[data-category-id]");
  if (!item || event.target.closest(".category-menu")) return;
  const touch = event.pointerType !== "mouse";
  drag.pending = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch };
  if (touch) drag.pending.timer = setTimeout(() => startDrag(drag.pending?.x, drag.pending?.y), 450);
});

window.addEventListener("pointermove", (event) => {
  if (drag.active) {
    moveDrag(event.clientY);
    return;
  }
  const pending = drag.pending;
  if (!pending || event.pointerId !== pending.pointerId) return;
  const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
  if (pending.touch) {
    if (distance > 8) cancelPendingDrag(); // it's a scroll
  } else if (distance > 6) {
    startDrag(event.clientX, event.clientY);
    moveDrag(event.clientY);
  }
});

window.addEventListener("pointerup", () => (drag.active ? finishDrag(true) : cancelPendingDrag()));
// A finger lifted before the long press finished: not a drag (some browsers
// send touchend without a pointerup after a tap).
window.addEventListener("touchend", (event) => {
  if (!drag.active && event.touches.length === 0) cancelPendingDrag();
});
window.addEventListener("pointercancel", () => (drag.active ? finishDrag(false) : cancelPendingDrag()));
// While dragging on a phone, the finger moves the channel, not the list.
els.channelList.addEventListener("touchmove", (event) => drag.active && event.preventDefault(), { passive: false });
// Press and hold would otherwise open the link's menu.
els.channelList.addEventListener("contextmenu", (event) => (drag.pending || drag.active) && event.preventDefault());
els.channelList.addEventListener("dragstart", (event) => event.preventDefault());
// The click that ends a drag doesn't open the channel.
els.channelList.addEventListener(
  "click",
  (event) => {
    if (!drag.justDropped) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

function cancelPendingDrag() {
  if (drag.pending?.timer) clearTimeout(drag.pending.timer);
  drag.pending = null;
}

function startDrag(x, y) {
  const pending = drag.pending;
  if (!pending) return;
  cancelPendingDrag();
  const item = pending.item;
  const rect = item.getBoundingClientRect();
  const ghost = item.cloneNode(true);
  ghost.classList.add("drag-ghost");
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  document.body.append(ghost);
  const marker = document.createElement("div");
  marker.className = "drop-marker";
  els.channelList.append(marker);
  item.classList.add("drag-source");
  state.dragging = true;
  drag.active = {
    item,
    ghost,
    marker,
    kind: item.dataset.channelId ? "channel" : "category",
    id: item.dataset.channelId ?? item.dataset.categoryId,
    offsetY: y - rect.top,
    before: undefined,
  };
  if (pending.touch) navigator.vibrate?.(15);
}

/** Follow the pointer, and show where it would land. */
function moveDrag(y) {
  const active = drag.active;
  active.ghost.style.top = `${y - active.offsetY}px`;
  // Scroll the list when near its top or bottom.
  const box = els.channelList.getBoundingClientRect();
  if (y < box.top + 32) els.channelList.scrollTop -= 8;
  else if (y > box.bottom - 32) els.channelList.scrollTop += 8;

  const selector = active.kind === "channel" ? "li[data-channel-id], li[data-category-id]" : "li[data-category-id]";
  const candidates = [...els.channelList.querySelectorAll(selector)].filter((li) => li !== active.item);
  const before = candidates.find((li) => {
    const r = li.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  active.before = before ?? null;
  const last = [...els.channelList.querySelectorAll("li[data-channel-id], li[data-category-id]")].filter((li) => li !== active.item).at(-1);
  const top = before ? before.offsetTop : last ? last.offsetTop + last.offsetHeight : 0;
  active.marker.style.top = `${top - 1}px`;
}

async function finishDrag(drop) {
  const active = drag.active;
  drag.active = null;
  state.dragging = false;
  active.ghost.remove();
  active.marker.remove();
  active.item.classList.remove("drag-source");
  drag.justDropped = true;
  setTimeout(() => (drag.justDropped = false), 50);
  if (!drop || active.before === undefined) return;
  try {
    if (active.kind === "channel") await dropChannel(active.id, active.before);
    else await dropCategory(active.id, active.before);
  } catch (error) {
    showError(`Couldn't move that: ${error.message}`);
    await loadState();
    renderSidebar();
  }
}

/** A channel dropped before `before` (or at the end): its new place and category. */
async function dropChannel(id, before) {
  // The category is the one whose header is above where it landed.
  let categoryId = null;
  for (let el = before ? before.previousElementSibling : els.channelList.lastElementChild; el; el = el.previousElementSibling) {
    if (el.dataset?.categoryId) {
      categoryId = el.dataset.categoryId;
      break;
    }
  }
  const groups = sidebarGroups().map((g) => ({ id: g.category?.id ?? null, ids: g.channels.map((c) => c.id).filter((c) => c !== id) }));
  const target = groups.find((g) => g.id === categoryId);
  const at = before?.dataset.channelId ? target.ids.indexOf(before.dataset.channelId) : -1;
  if (at >= 0) target.ids.splice(at, 0, id);
  else target.ids.push(id);
  const ids = groups.flatMap((g) => g.ids);
  // Show it straight away; the server's answer follows.
  const channel = state.channels.find((c) => c.id === id);
  channel.categoryId = categoryId;
  ids.forEach((cid, position) => (state.channels.find((c) => c.id === cid).position = position));
  renderSidebar();
  const { channels } = await api("PUT", "/api/channels/order", { ids, categories: { [id]: categoryId } });
  state.channels = channels;
  renderSidebar();
}

async function dropCategory(id, before) {
  const ids = state.categories.map((c) => c.id).filter((c) => c !== id);
  const at = before ? ids.indexOf(before.dataset.categoryId) : -1;
  if (at >= 0) ids.splice(at, 0, id);
  else ids.push(id);
  state.categories = ids.map((cid, position) => ({ ...state.categories.find((c) => c.id === cid), position }));
  renderSidebar();
  const { categories } = await api("PUT", "/api/categories/order", { ids });
  state.categories = categories;
  renderSidebar();
}

/**
 * Move the channel indicator (a pill a theme can show behind the open
 * channel's link) to the open channel. When it moves, it first stretches
 * to cover both links, then snaps into place with a little overshoot, like
 * a drop of liquid flowing from one to the other. Only transforms change,
 * so it stays smooth, and a liquid glass lens on it doesn't need remaking.
 */
export function moveChannelIndicator() {
  const indicator = els.channelIndicator;
  const link = els.channelList.querySelector('.channel-link[aria-current="page"]');
  if (!link || getComputedStyle(indicator).display === "none") {
    delete indicator.dataset.top;
    return;
  }
  // Relative to the channel list, which is positioned.
  const top = link.offsetTop;
  const place = (y, stretch) => (indicator.style.transform = `translateY(${y}px) scaleY(${stretch})`);
  indicator.style.left = `${link.offsetLeft}px`;
  indicator.style.width = `${link.offsetWidth}px`;
  indicator.style.height = `${link.offsetHeight}px`;

  const from = Number(indicator.dataset.top);
  indicator.dataset.top = String(top);
  clearTimeout(moveChannelIndicator.timer);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!Number.isFinite(from) || from === top || reduced) {
    indicator.classList.remove("stretching", "settling");
    place(top, 1);
    return;
  }
  // Stretch over both links...
  const span = Math.abs(top - from) + link.offsetHeight;
  indicator.classList.remove("settling");
  indicator.classList.add("stretching");
  place(Math.min(from, top), span / link.offsetHeight);
  // ...then gather at the new one.
  moveChannelIndicator.timer = setTimeout(() => {
    indicator.classList.replace("stretching", "settling");
    place(top, 1);
  }, 170);
}

/** The `#` icon for RP channels, a speech bubble for OOC. */
export function channelIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "channel-icon");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", kind === "ooc" ? "#icon-ooc" : "#icon-hash");
  svg.append(use);
  return svg;
}

/** Channel name and "topic" (character or OOC) at the top of the channel. */
function renderChannelHeader() {
  const channel = currentChannel();
  // These attributes are what per-channel themes (stage 3.5) will hook onto.
  els.channelView.dataset.channelId = channel?.id ?? "";
  els.channelView.dataset.channelKind = channel?.kind ?? "";

  els.channelName.textContent = channel?.name ?? "";
  els.channelTitleIcon.setAttribute("href", channel?.kind === "ooc" ? "#icon-ooc" : "#icon-hash");
  els.channelTopic.textContent = channel ? channelTopic(channel) : "";
  $("channel-settings-button").hidden = !channel;
  document.title = channel ? `#${channel.name} · Kinaera` : "Kinaera";
}

/**
 * The line next to the channel name, e.g.
 * "Arlo plays Ilse Marrow, ??? (hidden) · you play Kestrel · you both play Bo ·
 * Literary (casual from the next scene)".
 */
function channelTopic(channel) {
  const friendName = state.settings.friendName;
  if (channel.kind === "ooc") return `Out of character with ${friendName}`;
  if (isShared(channel)) return groupTopic(channel);
  if (channel.kind === "practice") return `${friendName}'s own channel, for trying things out. You can read it; nothing here feeds anything else.`;
  const parts = [];
  const theirs = castNames(channel, "friend");
  const yours = castNames(channel, "user");
  if (theirs.length) parts.push(`${friendName} plays ${theirs.join(", ")}`);
  const shared = castNames(channel, "both");
  if (yours.length) parts.push(`you play ${yours.join(", ")}`);
  if (shared.length) parts.push(`you both play ${shared.join(", ")}`);
  let mode = MODE_NAMES[channel.mode];
  if (channel.pendingMode) mode += ` (${MODE_NAMES[channel.pendingMode].toLowerCase()} from the next scene)`;
  parts.push(mode);
  return parts.join(" · ");
}

const MODE_NAMES = { literary: "Literary", casual: "Casual" };

/** Names of the characters in a channel's cast played by `who` ("user", "friend" or "both"). */
function castNames(channel, who) {
  return (channel.cast ?? []).filter((c) => c.kind === "character" && c.playedBy === who).map((c) => c.name);
}

/** Channel settings for the open channel. */
export function openChannelSettings() {
  const channel = currentChannel();
  if (!channel) return;
  const form = els.channelForm.elements;
  form.name.value = channel.name;
  fillCategorySelect(form.category, channel.categoryId);
  form.theme.replaceChildren(
    new Option("Same as the app theme", ""),
    ...state.themes.map((t) => new Option(t.name, t.id)),
  );
  form.theme.value = channel.theme ?? "";
  const serverWide = channel.kind === "ooc" ? state.settings.oocAssignment : state.settings.rpAssignment;
  fillAssignmentSelect(form.assignment, channel.assignment, `Same as the server (${assignmentName(serverWide)})`);
  // Show the mode you'll get: a waiting change if there is one.
  form.mode.value = channel.pendingMode ?? channel.mode;
  updateModeNote();
  renderCastEditor();
  els.channelForm.querySelector(".rp-only").hidden = channel.kind !== "rp";
  renderMemory();
  // The summaries may have changed since the channel was opened.
  if ($("channel-memory").open) refreshSummaries();
  $("channel-kind-note").textContent =
    channel.kind === "rp"
      ? "A roleplay channel: a storyline with its own cast."
      : "An out-of-character channel. Your friend talks to you as themselves.";
  hideFormError(els.channelForm);
  els.channelDialog.showModal();
}

/**
 * Under the Style choice in channel settings: say when a mode change will
 * take effect, since a scene never mixes styles.
 */
export function updateModeNote() {
  const channel = currentChannel();
  const chosen = els.channelForm.elements.mode.value;
  const note = $("channel-mode-note");
  if (!channel || chosen === channel.mode) {
    note.textContent = "";
  } else if (currentSceneIsEmpty()) {
    note.textContent = `The current scene hasn't started yet, so it will be ${chosen} right away.`;
  } else {
    note.textContent = `Scenes never mix styles, so this takes effect at the next scene break.`;
  }
}

export function openNewChannel() {
  els.newChannelForm.reset();
  // Your friend's characters (and shared ones), to start the cast with.
  $("new-channel-cast").replaceChildren(
    new Option("Nobody yet", ""),
    ...state.notebook.entries
      .filter((e) => e.kind === "character" && e.owner !== "user")
      .map((e) => new Option(e.name, e.id)),
  );
  fillCategorySelect($("new-channel-category"), null);
  hideFormError(els.newChannelForm);
  updateNewChannelKind();
  els.newChannelDialog.showModal();
}

/** Show the style and cast choices only when "Roleplay" is picked. */
export function updateNewChannelKind() {
  els.newChannelForm.querySelector(".rp-only").hidden = els.newChannelForm.elements.kind.value !== "rp";
}

/**
 * Show the exact prompt stack the next turn in the open channel would send.
 * Uses the *saved* settings, so save first if you want to preview a change.
 */
export async function previewPrompt() {
  try {
    const { messages } = await api("GET", channelPath("prompt"));
    els.promptPreview.replaceChildren(
      ...messages.map((m) => {
        const block = document.createElement("div");
        block.className = "prompt-message";
        const role = document.createElement("div");
        role.className = "prompt-role";
        role.textContent = m.role;
        const pre = document.createElement("pre");
        pre.textContent = m.content;
        block.append(role, pre);
        return block;
      }),
    );
    els.promptDialog.showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

// ---------------------------------------------------------------- sidebar

/** On phones, the sidebar slides over the channel. These open and close it. */
export function openSidebar() {
  els.app.classList.add("sidebar-open");
}

export function closeSidebar() {
  els.app.classList.remove("sidebar-open");
}
