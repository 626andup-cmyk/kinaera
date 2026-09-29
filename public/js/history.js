/**
 * History: nothing is ever overwritten in place.
 *
 * - A message's history: tap "(edited)", or "↻ 2" on a regenerated reply,
 *   to see every version of its text (who wrote each, and when) and the
 *   earlier replies it replaced.
 * - The intervention log (Friend menu → What you've changed): everything
 *   you've done that affects your friend. They can read the same log.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { formatText, formatTime } from "./format.js";

/** "You", or your friend's name. */
function whoWrote(author) {
  return author === "user" ? "You" : state.settings.friendName;
}

/** One version, as a card: who and when, then the text. */
function versionCard(heading, content, current = false) {
  const item = document.createElement("li");
  item.className = "history-version";
  if (current) item.dataset.current = "";
  const head = document.createElement("div");
  head.className = "hint";
  head.textContent = heading;
  const text = document.createElement("div");
  text.className = "history-version-text";
  text.innerHTML = formatText(content);
  item.append(head, text);
  return item;
}

/** Open a message's history. */
export async function openHistory(messageId) {
  const dialog = $("history-dialog");
  hideFormError(dialog);
  $("history-list").replaceChildren();
  $("history-note").textContent = "";
  dialog.showModal();
  try {
    const { message, revisions, alternates } = await api("GET", `/api/messages/${encodeURIComponent(messageId)}/history`);
    const cards = [];
    if (alternates.length > 0) {
      for (const [i, old] of alternates.entries()) {
        const by = old.profile ? `, by ${old.profile}` : "";
        cards.push(versionCard(`Reply ${i + 1}, ${formatTime(old.createdAt)}${by} (replaced by a regeneration)`, old.content));
      }
    }
    if (revisions.length > 0) {
      revisions.forEach((r, i) => {
        const current = i === revisions.length - 1;
        const label = i === 0 ? "Written" : "Edited";
        cards.push(versionCard(`${label} by ${whoWrote(r.author)}, ${formatTime(r.createdAt)}${current ? " (now)" : ""}`, r.content, current));
      });
    } else {
      const by = message.profile ? `, by ${message.profile}` : "";
      cards.push(versionCard(`Written by ${whoWrote(message.author)}, ${formatTime(message.createdAt)}${by} (now)`, message.content, true));
    }
    $("history-list").replaceChildren(...cards);
    const friend = state.settings.friendName;
    $("history-note").textContent =
      `Oldest first. ${friend} sees only the current text in the chat, and can read this history with a tool. Nothing here is ever deleted.`;
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

/** Open the intervention log. */
export async function openInterventions() {
  const dialog = $("interventions-dialog");
  const list = $("interventions-list");
  const friend = state.settings.friendName;
  hideFormError(dialog);
  $("interventions-note").textContent =
    `Everything you've done that affects ${friend}: editing, deleting or regenerating their messages, and changing who they are or how they write. It's written down automatically, and ${friend} can read this same log. Newest first.`;
  list.replaceChildren();
  dialog.showModal();
  try {
    const { interventions } = await api("GET", "/api/interventions");
    if (interventions.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = "Nothing yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...interventions.map((entry) => {
        const item = document.createElement("li");
        const when = document.createElement("div");
        when.className = "hint";
        when.textContent = formatTime(entry.at);
        const what = document.createElement("div");
        what.textContent = entry.summary;
        item.append(when, what);
        return item;
      }),
    );
  } catch (error) {
    showFormError(dialog, error.message);
  }
}
