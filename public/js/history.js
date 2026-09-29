/**
 * History and logs: nothing is ever overwritten in place, and what happens
 * is written down.
 *
 * - A message's history: tap "(edited)", or "↻ 2" on a regenerated reply,
 *   to see every version of its text (who wrote each, and when) and the
 *   earlier replies it replaced.
 * - The intervention log (Friend menu → What you've changed): everything
 *   you've done that affects your friend. They can read the same log.
 * - The check log (Friend menu, or Settings → Jev): every check your
 *   friend made, with what was found.
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

// ------------------------------------------------------------ check log

/** The check log's entries, as last loaded (for copying). */
let checks = [];

/** Open the check log: every check your friend made, newest first. */
export async function openCheckLog() {
  const dialog = $("check-log-dialog");
  const list = $("check-log-list");
  const friend = state.settings.friendName;
  hideFormError(dialog);
  $("check-log-copy").textContent = "Copy as text";
  $("check-log-note").textContent =
    `Every check ${friend} made: what they asked, where they looked, Jev's reading, and the passages found. Passages from private places (their journal and drafts) show where they're from, never what they say.`;
  list.replaceChildren();
  dialog.showModal();
  try {
    ({ checks } = await api("GET", "/api/checks"));
    if (checks.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = `${friend} hasn't checked anything yet.`;
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...checks.map(checkCard));
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

/** "yes (94%, 91%)", "nothing found", or why there's no reading. */
function readingText(check) {
  if (check.found.length === 0) return "nothing found";
  if (!check.verdict) return "no reading";
  return `${check.verdict} (${check.yes.map((p) => `${Math.round(p * 100)}%`).join(", ")})`;
}

/** One check: the question, the reading, and the passages (folded away). */
function checkCard(check) {
  const item = document.createElement("li");
  item.className = "tool-call";
  item.dataset.status = check.error ? "error" : "ok";
  const head = document.createElement("div");
  head.className = "tool-call-head";
  const verdict = document.createElement("strong");
  verdict.textContent = readingText(check);
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = check.at;
  time.textContent = formatTime(check.at);
  head.append(verdict, time);
  const question = document.createElement("p");
  question.className = "tool-call-summary";
  question.textContent = check.question === check.rephrased ? check.question : `${check.question} / ${check.rephrased}`;
  item.append(head, question);
  if (check.error) {
    const error = document.createElement("p");
    error.className = "hint";
    error.textContent = check.error;
    item.append(error);
  }
  const details = document.createElement("details");
  details.className = "tool-call-raw";
  const label = document.createElement("summary");
  label.textContent = `${check.found.length} passage${check.found.length === 1 ? "" : "s"} from ${check.sources.join(", ")}`;
  details.append(label);
  for (const passage of check.found) {
    const block = document.createElement("pre");
    block.textContent = `${passage.where}\n${passage.text ?? "(private: not shown)"}`;
    details.append(block);
  }
  item.append(details);
  return item;
}

/** Copy the check log as plain text, e.g. to share when something goes wrong. */
export async function copyCheckLog() {
  const text = checks
    .map((c) =>
      [
        `${c.at}  ${readingText(c)}  ${c.question} / ${c.rephrased}`,
        c.error ? `note: ${c.error}` : "",
        ...c.found.map((p) => `- ${p.where}: ${(p.text ?? "(private)").replace(/\s+/g, " ").slice(0, 200)}`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("check-log-copy").textContent = "Copied";
  } catch {
    showFormError($("check-log-dialog"), "Couldn't copy: your browser didn't allow it.");
  }
}
