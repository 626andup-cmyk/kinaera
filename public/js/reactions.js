/**
 * Emoji reactions (src/reactions.ts): chips under a message, one per emoji,
 * with who reacted, the picker, and your custom emojis.
 */

import { $, api, hideFormError, scoped, showFormError, state } from "./core.js";
import { refreshMessages, renderMessages } from "./messages.js";

// -------------------------------------------------------------- reactions

/*
 * Emoji reactions (src/reactions.ts): chips under a message, one per emoji,
 * with who reacted. Tap a chip to add or take back yours; "React" opens the
 * picker. Your friend reacts with a tool, and sees yours in their prompt.
 */

/** The emojis offered first in the picker. */
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "✨", "👀", "🥺", "💀", "🙏", "🎉"];

/** An emoji as a node: the character, or a custom emoji's image. */
function emojiNode(emoji) {
  const custom = /^:([a-z0-9_]{2,32}):$/.exec(emoji);
  const found = custom && state.emojis.find((e) => e.name === custom[1]);
  if (!found) {
    const span = document.createElement("span");
    span.className = "reaction-emoji";
    span.textContent = emoji;
    return span;
  }
  const img = document.createElement("img");
  img.className = "custom-emoji";
  img.src = scoped(`/emojis/${found.file}`);
  img.alt = emoji;
  return img;
}

export function renderReactions(message) {
  const row = document.createElement("div");
  row.className = "message-reactions";
  const groups = new Map();
  for (const r of message.reactions) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    groups.get(r.emoji).push(r.author);
  }
  for (const [emoji, authors] of groups) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction";
    if (authors.includes("user")) chip.classList.add("mine");
    if (authors.includes("friend")) chip.classList.add("friend");
    const names = authors.map((a) => (a === "user" ? "You" : state.settings.friendName));
    chip.title = `${names.join(" and ")} reacted ${emoji}`;
    chip.setAttribute("aria-label", chip.title);
    const count = document.createElement("span");
    count.className = "reaction-count";
    count.textContent = String(authors.length);
    chip.append(emojiNode(emoji), count);
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleReaction(message.id, emoji);
    });
    row.append(chip);
  }
  return row;
}

async function toggleReaction(messageId, emoji) {
  try {
    const { reactions } = await api("POST", `/api/messages/${encodeURIComponent(messageId)}/reactions`, { emoji });
    const message = state.messages.find((m) => m.id === messageId);
    if (message) message.reactions = reactions;
    renderMessages();
  } catch (error) {
    alert(error.message);
  }
}

/** The picker, floating by the message's React button. */
export function openReactionPicker(messageId, anchor) {
  closeReactionPicker();
  const picker = document.createElement("div");
  picker.className = "reaction-picker surface";
  picker.id = "reaction-picker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "React");

  const choose = (emoji) => {
    closeReactionPicker();
    toggleReaction(messageId, emoji);
  };
  const grid = document.createElement("div");
  grid.className = "reaction-picker-grid";
  const option = (emoji) => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = emoji;
    button.append(emojiNode(emoji));
    button.addEventListener("click", () => choose(emoji));
    return button;
  };
  grid.append(...QUICK_EMOJIS.map(option), ...state.emojis.map((e) => option(`:${e.name}:`)));

  const other = document.createElement("form");
  other.className = "reaction-picker-other";
  const input = document.createElement("input");
  input.placeholder = "Any emoji";
  input.setAttribute("aria-label", "Any emoji");
  input.maxLength = 34;
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "button";
  add.textContent = "React";
  other.append(input, add);
  other.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.value.trim()) choose(input.value.trim());
  });

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "link-button";
  manage.textContent = "Custom emojis…";
  manage.addEventListener("click", () => {
    closeReactionPicker();
    openEmojiManager();
  });

  picker.append(grid, other, manage);
  document.body.append(picker);
  // Beside the button, kept on screen.
  const box = anchor.getBoundingClientRect();
  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
  const top = box.top - height - 6 > 8 ? box.top - height - 6 : Math.min(box.bottom + 6, window.innerHeight - height - 8);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  setTimeout(() => document.addEventListener("pointerdown", closePickerOutside), 0);
}

function closePickerOutside(event) {
  if (!event.target.closest("#reaction-picker")) closeReactionPicker();
}

function closeReactionPicker() {
  $("reaction-picker")?.remove();
  document.removeEventListener("pointerdown", closePickerOutside);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeReactionPicker();
});

// ---------------------------------------------------------- custom emojis

function openEmojiManager() {
  const dialog = $("emoji-dialog");
  hideFormError(dialog);
  $("emoji-name").value = "";
  $("emoji-file").value = "";
  renderEmojiList();
  dialog.showModal();
}

function renderEmojiList() {
  const list = $("emoji-list");
  if (state.emojis.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No custom emojis yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...state.emojis.map((emoji) => {
      const item = document.createElement("li");
      const name = document.createElement("code");
      name.textContent = `:${emoji.name}:`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteEmoji(emoji.name));
      item.append(emojiNode(`:${emoji.name}:`), name, remove);
      return item;
    }),
  );
}

/** A file as base64 (without the data: prefix). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addEmoji(event) {
  event.preventDefault();
  const dialog = $("emoji-dialog");
  const file = $("emoji-file").files[0];
  try {
    if (!file) throw new Error("Choose an image first.");
    const name = $("emoji-name").value.trim() || file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 32);
    const { emojis } = await api("POST", "/api/emojis", { name, data: await fileToBase64(file) });
    state.emojis = emojis;
    $("emoji-name").value = "";
    $("emoji-file").value = "";
    hideFormError(dialog);
    renderEmojiList();
    renderMessages();
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

async function deleteEmoji(name) {
  if (!confirm(`Delete :${name}:? Reactions with it go too.`)) return;
  try {
    const { emojis } = await api("DELETE", `/api/emojis/${encodeURIComponent(name)}`, {});
    state.emojis = emojis;
    renderEmojiList();
    await refreshMessages();
  } catch (error) {
    showFormError($("emoji-dialog"), error.message);
  }
}

$("emoji-form").addEventListener("submit", addEmoji);
