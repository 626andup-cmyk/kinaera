/**
 * Turning text into what's shown: escaping, *formatting*, custom emojis,
 * initials, times, colours and badges.
 *
 * Everything shown from a message goes through `escapeHtml` first, and
 * only then gets its formatting, so nothing a model writes can become
 * working HTML.
 */

import { scoped, state } from "./core.js";

/** A stable hue (0-359) for a name, so each character keeps their colour. */
export function hueFor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

/**
 * Turn message text into safe HTML with light RP formatting:
 * `***bold italics***`, `**bold**` and `*italics*` (or `_italics_`), the
 * usual way of writing actions in roleplay. Line breaks are kept by CSS
 * (`white-space: pre-wrap`).
 *
 * `***` is handled first: otherwise `**` would take two of its asterisks,
 * and the tags would come out crossed (`<strong><em>…</strong></em>`).
 */
export function formatText(text) {
  return withCustomEmojis(
    escapeHtml(text)
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<em>$2</em>"),
  );
}

/** Show `:name:` of a custom emoji as its image (in HTML that's already safe). */
function withCustomEmojis(html) {
  if (!state.emojis?.length) return html;
  const byName = new Map(state.emojis.map((e) => [e.name, e]));
  return html.replace(/:([a-z0-9_]{2,32}):/g, (whole, name) => {
    const emoji = byName.get(name);
    return emoji ? `<img class="custom-emoji" src="${scoped(`/emojis/${emoji.file}`)}" alt=":${name}:" title=":${name}:" />` : whole;
  });
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The first letter of a name, for avatars. */
export function initial(name) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** "14:05" for today, "Sep 24, 14:05" for older messages. */
export function formatTime(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function badge(text) {
  const span = document.createElement("span");
  span.className = "entry-badge";
  span.textContent = text;
  return span;
}
