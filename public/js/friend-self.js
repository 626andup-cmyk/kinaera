/**
 * The friend's page: who they are (and every version of it), their
 * self-page, their journal (only how many entries: it's private), and an
 * invitation to an orientation. Tapping your friend in the sidebar opens it.
 *
 * Their identity and self-page are theirs. What you write here arrives as a
 * suggestion, which they accept or decline on their next turn; until then
 * you can take it back.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { formatTime } from "./format.js";
import { openFriend, paintAvatar } from "./friend-page.js";
import { openChannel } from "./channels.js";

/** The page as the server last sent it (GET /api/friend-page). */
let page = null;

export async function openSelf() {
  const dialog = $("self-dialog");
  hideFormError(dialog);
  const s = state.settings;
  paintAvatar($("self-avatar"), { name: s.friendName, avatar: s.friendAvatar, color: s.friendColor });
  $("self-title").textContent = s.friendName;
  if (!dialog.open) dialog.showModal();
  keepFresh();
  try {
    page = await api("GET", "/api/friend-page");
    renderSelf();
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

/** Text, or a quiet "(nothing yet)". */
function fill(id, text, empty = "Nothing yet.") {
  const element = $(id);
  element.textContent = text?.trim() ? text : empty;
  element.classList.toggle("self-empty", !text?.trim());
}

function renderSelf() {
  const friend = state.settings.friendName;
  fill("self-identity", page.identity?.identity);
  fill("self-tastes", page.identity?.tastes, `${friend} hasn't written their tastes yet.`);

  // Your suggestions still waiting for them.
  $("self-identity-waiting").replaceChildren(
    ...page.waiting.identity.map((v) =>
      waitingCard(`Your suggestion, waiting for ${friend}`, v.note || "A change to who they are.", () => withdraw(`/api/identity/suggestions/${v.id}/withdraw`)),
    ),
  );
  if (!$("self-suggest").open) {
    $("self-suggest-identity").value = page.identity?.identity ?? "";
    $("self-suggest-tastes").value = page.identity?.tastes ?? "";
    $("self-suggest-note").value = "";
  }

  // The changelog, newest first.
  const by = (v) => (v.author === "friend" ? friend : "You");
  const status = { accepted: "", pending: " (waiting)", declined: " (declined)", withdrawn: " (withdrawn)" };
  $("self-changelog").replaceChildren(
    ...[...page.history].reverse().map((v) => {
      const item = document.createElement("li");
      const head = document.createElement("strong");
      head.textContent = `${by(v)}${v.author === "user" && v.status !== "accepted" ? " suggested" : ""}${status[v.status] ?? ""}`;
      const when = document.createElement("span");
      when.className = "hint";
      when.textContent = ` ${formatTime(v.createdAt)}`;
      item.append(head, when);
      for (const [label, text] of [["Note", v.note], [`${friend}'s reply`, v.reply]]) {
        if (!text) continue;
        const line = document.createElement("div");
        line.className = "hint";
        line.textContent = `${label}: ${text}`;
        item.append(line);
      }
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "This version";
      const body = document.createElement("div");
      body.className = "self-text";
      body.textContent = v.identity + (v.tastes ? `\n\nTastes: ${v.tastes}` : "");
      details.append(summary, body);
      item.append(details);
      return item;
    }),
  );

  // The self-page.
  const self = page.selfPage;
  fill("self-says", self.says, `${friend} hasn't written this yet.`);
  fill("self-feedback", self.feedback, `${friend} hasn't written this yet.`);
  const notes = self.notes.map((note) => {
    const item = document.createElement("li");
    item.className = "self-note";
    const text = document.createElement("div");
    text.textContent = note.text;
    const meta = document.createElement("div");
    meta.className = "hint";
    const from = note.source === "user" ? "Your note" : `A pattern ${friend} kept`;
    meta.textContent = note.status === "pending" ? `${from}, waiting for ${friend}` : from;
    item.append(text, meta);
    for (const [label, value] of [[`${friend}'s reply`, note.reply], [`${friend} disputes this`, note.dispute]]) {
      if (!value) continue;
      const line = document.createElement("div");
      line.className = "self-reply";
      line.textContent = `${label}: ${value}`;
      item.append(line);
    }
    if (note.status === "pending") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-button";
      button.textContent = "Withdraw";
      button.addEventListener("click", () => withdraw(`/api/self-page/notes/${encodeURIComponent(note.id)}/withdraw`));
      item.append(button);
    }
    return item;
  });
  if (notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "self-empty";
    empty.textContent = "No notes yet.";
    notes.push(empty);
  }
  $("self-notes").replaceChildren(...notes);

  // The journal: counts only.
  const { entries, kept } = page.journal;
  $("self-journal").textContent =
    entries === 0
      ? `${friend} hasn't written in their journal yet. It's private: only how many entries there are is shown here.`
      : `${entries} ${entries === 1 ? "entry" : "entries"}, ${kept} kept in front of them. It's private: only the counts are shown here.`;

  renderOrientation();
}

/** Where orientation stands, in words: now, what's holding it, and how the last one went. */
function renderOrientation() {
  const friend = state.settings.friendName;
  const o = page.orientation;
  const lines = [];
  if (o.running) lines.push(`${friend} is in an orientation right now, in #practice.`);
  else if (o.pending) {
    lines.push(`${friend} is starting an orientation in #practice. It's checked every minute.`);
    if (o.held) lines.push(`Not yet, because: ${o.held}`);
    // The cooldown (Settings → Your friend reaching out) ends at a known time.
    if (o.heldUntil) lines.push(`It can start around ${formatTime(o.heldUntil)}. A shorter cooldown in Settings makes that sooner.`);
  } else if (o.invited) {
    lines.push(`You've invited ${friend}, and they haven't answered yet. Starting one is a yes; not starting one on the turn where they're told is a no.`);
  } else {
    lines.push(`A turn of their own for trying their tools and finding what suits them. You can invite ${friend}; they can say no.`);
    const answer = { accepted: `${friend} said yes to your last invitation.`, declined: `${friend} passed on your last invitation (they didn't start one on the turn after it).` }[o.lastInvitation];
    if (answer) lines.push(answer);
  }
  // What happened to your invitation, in plain words (from the server).
  if (o.note) lines.push(o.note);
  if (o.last) {
    const how = { posted: "wrote in #practice", quiet: "didn't write anything there", failed: "failed" }[o.last.outcome] ?? o.last.outcome;
    lines.push(`Last orientation: ${formatTime(o.last.at)}, ${how}.${o.last.outcome === "failed" ? ` ${o.last.detail}` : ""}`);
  } else {
    lines.push(`${friend} hasn't had an orientation yet.`);
  }
  const box = $("self-orientation");
  box.replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement("span");
      p.className = "self-orientation-line";
      p.textContent = line;
      return p;
    }),
  );
  $("self-invite").disabled = o.invited || o.pending || o.running;
  $("self-open-practice").hidden = !o.practiceId;
}

/** While the page is open, keep orientation's status fresh (it changes on its own). */
let refresher = null;
function keepFresh() {
  clearInterval(refresher);
  refresher = setInterval(async () => {
    if (!$("self-dialog").open) return clearInterval(refresher);
    try {
      page = await api("GET", "/api/friend-page");
      renderOrientation();
    } catch {
      // Try again next time.
    }
  }, 10_000);
}

/** A suggestion of yours still waiting, with a Withdraw button. */
function waitingCard(title, text, onWithdraw) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  const heading = document.createElement("p");
  heading.className = "inbox-card-title";
  heading.textContent = title;
  const body = document.createElement("p");
  body.className = "inbox-card-text";
  body.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.textContent = "Withdraw";
  button.addEventListener("click", onWithdraw);
  card.append(heading, body, button);
  return card;
}

/** Send something, and show the page that comes back. */
async function act(method, path, body = {}) {
  try {
    page = await api(method, path, body);
    state.waiting = page.waiting;
    renderSelf();
    return true;
  } catch (error) {
    showFormError($("self-dialog"), error.message);
    return false;
  }
}

const withdraw = (path) => act("POST", path);

async function suggestIdentity() {
  const change = { identity: $("self-suggest-identity").value, tastes: $("self-suggest-tastes").value, note: $("self-suggest-note").value };
  hideFormError($("self-dialog"));
  if (await act("POST", "/api/identity/suggestions", change)) $("self-suggest").open = false;
}

async function suggestNote() {
  hideFormError($("self-dialog"));
  if (await act("POST", "/api/self-page/notes", { text: $("self-note-text").value })) {
    $("self-note-text").value = "";
    $("self-note-text").closest("details").open = false;
  }
}

async function invite() {
  if (!confirm(`Invite ${state.settings.friendName} to an orientation? They're told on their next turn, and can say no.`)) return;
  await act("POST", "/api/orientation/invite");
}

$("friend-card").addEventListener("click", openSelf);
$("friend-card").addEventListener("keydown", (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), openSelf()));
$("self-settings").addEventListener("click", () => {
  $("self-dialog").close();
  openFriend();
});
$("self-suggest-send").addEventListener("click", suggestIdentity);
$("self-note-send").addEventListener("click", suggestNote);
$("self-invite").addEventListener("click", invite);
$("self-open-practice").addEventListener("click", () => {
  $("self-dialog").close();
  openChannel(page.orientation.practiceId);
});
