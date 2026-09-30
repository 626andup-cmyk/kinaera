/**
 * The composer: the box you write in, who you're posting as in casual
 * scenes, and notes attached to what you're about to send.
 */

import { $, currentChannel, els, state } from "./core.js";
import { badge } from "./format.js";
import { entryAvatar, findEntry, openEntry, ownerLabel } from "./notebook.js";

/** Show or hide the composer, the "writing…" indicator, and lock buttons while busy. */
export function renderComposer() {
  const channel = currentChannel();
  els.composer.hidden = !channel;
  if (!channel) return;
  // Their practice channel is theirs to write in: you can only read it.
  $("composer-form").hidden = channel.kind === "practice";

  const busy = state.busy.has(channel.id);
  // "Writing" while the model works; "typing" while texts are revealed one by one.
  els.status.hidden = !busy && !state.reveal;
  $("status-text").textContent = `${state.settings.friendName} is ${busy ? "writing" : "typing"}…`;
  // Only a turn in progress can be stopped; "typing…" is skipped with a double-tap.
  $("stop-button").hidden = !busy;
  els.status.title = busy ? "" : "Double-tap to show the rest now";
  els.send.disabled = busy;
  els.turn.disabled = busy;

  const casual = channel.kind === "rp" && channel.mode === "casual";
  $("scene-button").hidden = channel.kind !== "rp";
  renderAttachRow();
  $("scene-button").disabled = busy;
  renderPostingAs(casual);

  if (channel.kind === "ooc") {
    els.input.placeholder = `Message ${state.settings.friendName}…`;
  } else if (casual) {
    const example = yourCharacters().find((c) => c.proxyPrefix);
    els.input.placeholder = example
      ? `Chat in #${channel.name}… (start a line with ${example.proxyPrefix}: to post as ${example.name})`
      : `Chat in #${channel.name}…`;
  } else {
    els.input.placeholder = `Write your post in #${channel.name}…  (===== starts a new scene)`;
  }
}

/** The characters you can post as: yours and shared ones. */
function yourCharacters() {
  return state.notebook.entries.filter((e) => canHavePrefix(e.kind, e.owner));
}

/** Whether a character can have a proxy prefix: one you play (yours, or shared). */
export function canHavePrefix(kind, owner) {
  return kind === "character" && (owner === "user" || owner === "joint");
}

/**
 * The "posting as" picker, shown in casual scenes: yourself, or one of your
 * characters (from the notebook). Lines starting with a character's prefix
 * override it.
 */
function renderPostingAs(visible) {
  const select = $("posting-as");
  const characters = yourCharacters();
  const row = $("posting-as-row");
  row.hidden = !visible || characters.length === 0;
  if (row.hidden) return;

  // Forget a choice whose character no longer exists.
  let current = state.postingAs.get(state.channelId) ?? "";
  if (current && !characters.some((c) => c.name === current)) current = "";

  select.replaceChildren(new Option("yourself", ""), ...characters.map((c) => new Option(c.name, c.name)));
  select.value = current;
}

// ----------------------------------------------------------- attachments

/*
 * Attaching notes: pick notebook entries with the paperclip, and they're
 * sent to your friend in full with your next message, and kept in their
 * view while that message is in the conversation. `[[Name]]` in the text
 * attaches that entry too (the server finds those).
 */

/** Entries you can attach: ones your friend can see. */
function attachable() {
  return state.notebook.entries.filter((e) => !(e.owner === "user" && e.settings.visibility === "hidden"));
}

function pickedAttachments() {
  if (!state.attachments.has(state.channelId)) state.attachments.set(state.channelId, new Set());
  return state.attachments.get(state.channelId);
}

export function openAttach() {
  $("attach-search").value = "";
  renderAttachList();
  $("attach-dialog").showModal();
}

export function renderAttachList() {
  const picked = pickedAttachments();
  const query = $("attach-search").value.trim().toLowerCase();
  const entries = attachable().filter((e) => !query || e.name.toLowerCase().includes(query));
  $("attach-list").replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      label.className = "attach-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = picked.has(entry.id);
      box.addEventListener("change", () => {
        if (box.checked) picked.add(entry.id);
        else picked.delete(entry.id);
        renderAttachRow();
      });
      const name = document.createElement("span");
      name.textContent = entry.name;
      label.append(box, entryAvatar(entry.name, entry.kind), name, badge(ownerLabel(entry.owner)));
      item.append(label);
      return item;
    }),
  );
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No entries found.";
    $("attach-list").append(empty);
  }
}

/** The chips above the text box: what's attached to the message you're writing. */
function renderAttachRow() {
  const row = $("attach-row");
  const picked = [...(state.attachments.get(state.channelId) ?? [])].map(findEntry).filter(Boolean);
  row.hidden = picked.length === 0;
  row.replaceChildren(
    ...picked.map((entry) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.textContent = `📎 ${entry.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Don't attach ${entry.name}`);
      remove.addEventListener("click", () => {
        pickedAttachments().delete(entry.id);
        renderAttachRow();
      });
      chip.append(remove);
      return chip;
    }),
  );
}

/** Under a message: the notes attached to it, each opening its entry. */
export function renderAttachments(message) {
  const row = document.createElement("div");
  row.className = "message-attachments";
  for (const id of message.attachments) {
    const entry = findEntry(id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attach-chip";
    chip.textContent = `📎 ${entry?.name ?? "a note you can't see"}`;
    chip.disabled = !entry;
    if (entry) chip.addEventListener("click", () => openEntry(entry));
    row.append(chip);
  }
  return row;
}

// ---------------------------------------------------------------- composer

/** Grow the text box to fit what you've typed (CSS caps the height). */
export function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight + 2}px`;
}
