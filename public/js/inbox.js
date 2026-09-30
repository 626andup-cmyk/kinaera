/**
 * The inbox: what's waiting on someone. What your friend asks of you
 * (their asks, and proposals to approve), suggestions for either of you,
 * and your suggestions waiting for them.
 */

import { openChannel, renderAll } from "./channels.js";
import { $, api, hideFormError, showFormError, state } from "./core.js";
import { formatTime } from "./format.js";
import { findEntry, refreshNotebook } from "./notebook.js";

// ------------------------------------------------------------------ inbox

/*
 * The inbox gathers what's waiting on someone:
 *
 *   - your friend's asks (src/inbox.ts), which you answer or set aside;
 *     your answer reaches them on their next turn;
 *   - their proposals (deleting a channel) and suggestions (notebook
 *     changes), which you approve or reject;
 *   - your suggestions waiting for your friend, who reviews them with their
 *     tools on their next turn.
 */

/** What each kind of ask is about. */
const ASK_TITLES = {
  context: "Context: something they need to know",
  check: "Check: can you look at something",
  model: "Model: a different profile",
  pause: "Pause: a break from a storyline",
  clarify: "Clarify: what did you mean",
  prompt: "Prompt: how their context is built",
  other: "Something else",
};

/** Everything waiting for you: what the badge counts. */
function inboxCount() {
  return state.inbox.length + state.notebook.suggestions.filter((s) => s.reviewer === "user").length;
}

export function renderInboxBadge() {
  const count = inboxCount();
  const badge = $("inbox-count");
  badge.hidden = count === 0;
  badge.textContent = String(count);
  $("inbox-button").title = count ? `Inbox: ${count} waiting for you` : "Inbox";
}

export function openInbox() {
  hideFormError($("inbox-dialog"));
  renderInbox();
  $("inbox-dialog").showModal();
  refreshNotebook().catch((error) => showFormError($("inbox-dialog"), error.message));
}

export function renderInbox() {
  const friend = state.settings.friendName;
  const forYou = state.notebook.suggestions.filter((s) => s.reviewer === "user");
  const yours = state.notebook.suggestions.filter((s) => s.author === "user" && s.reviewer !== "user");
  const sections = [];

  const asks = state.inbox.filter((item) => item.kind === "ask");
  const proposals = state.inbox.filter((item) => item.kind !== "ask");
  if (asks.length) {
    sections.push(
      inboxSection(
        `${friend} asks you`,
        asks.map((ask) => {
          const where = state.channels.find((c) => c.id === ask.channelId);
          const title = ASK_TITLES[ask.askKind] ?? "A question";
          // Asked while trying their tools out (src/orientation.ts): low stakes.
          const card = inboxCard(ask.orientation ? `${title} (orientation)` : title, `“${ask.text}”`);
          const meta = document.createElement("p");
          meta.className = "hint";
          meta.textContent = `Asked ${formatTime(ask.createdAt)}${where ? ` in #${where.name}` : ""}. Your answer reaches ${friend} on their next turn.`;
          const answer = document.createElement("textarea");
          answer.className = "inbox-answer";
          answer.rows = 3;
          answer.placeholder = "Your answer";
          answer.setAttribute("aria-label", "Your answer");
          card.append(
            meta,
            answer,
            cardButtons([
              ["Answer", () => answerAsk(ask.id, answer.value), "button-primary"],
              ["Set aside", () => dismissAsk(ask.id)],
            ]),
          );
          return card;
        }),
      ),
    );
  }
  if (proposals.length) {
    sections.push(
      inboxSection(
        `${friend} proposes`,
        proposals.map((proposal) => {
          const card = inboxCard(`Delete #${proposal.targetName}?`, proposal.text ? `“${proposal.text}”` : "");
          card.append(
            cardButtons([
              ["Delete it", () => resolveProposal(proposal.id, "approve"), "button-danger"],
              ["Keep it", () => resolveProposal(proposal.id, "deny")],
            ]),
          );
          return card;
        }),
      ),
    );
  }
  if (forYou.length) {
    sections.push(
      inboxSection(
        "Suggestions for you",
        forYou.map((s) => {
          const card = suggestionCard(s);
          card.append(
            cardButtons([
              ["Accept", () => reviewSuggestion(s.id, "accept"), "button-primary"],
              ["Reject", () => reviewSuggestion(s.id, "reject")],
            ]),
          );
          return card;
        }),
      ),
    );
  }
  // Your suggestions for their identity and self-page (their page has more).
  const identity = state.waiting.identity.map((v) => {
    const card = inboxCard("You: a change to who they are", v.note ? `“${v.note}”` : "");
    card.append(cardButtons([["Withdraw", () => withdrawWaiting(`/api/identity/suggestions/${v.id}/withdraw`)]]));
    return card;
  });
  const notes = state.waiting.selfNotes.map((n) => {
    const card = inboxCard("You: a note for their self-page", `“${n.text}”`);
    card.append(cardButtons([["Withdraw", () => withdrawWaiting(`/api/self-page/notes/${encodeURIComponent(n.id)}/withdraw`)]]));
    return card;
  });
  if (yours.length || identity.length || notes.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = `${friend} reviews these on their next turn with tools.`;
    sections.push(
      inboxSection(`Waiting for ${friend}`, [
        hint,
        ...yours.map((s) => {
          const card = suggestionCard(s);
          card.append(cardButtons([["Withdraw", () => reviewSuggestion(s.id, "withdraw")]]));
          return card;
        }),
        ...identity,
        ...notes,
      ]),
    );
  }
  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing waiting.";
    sections.push(empty);
  }
  $("inbox-list").replaceChildren(...sections);
}

function inboxSection(title, cards) {
  const section = document.createElement("section");
  section.className = "inbox-section";
  const heading = document.createElement("h3");
  heading.className = "section-title";
  heading.textContent = title;
  section.append(heading, ...cards);
  return section;
}

function inboxCard(title, text) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  const heading = document.createElement("p");
  heading.className = "inbox-card-title";
  heading.textContent = title;
  card.append(heading);
  if (text) {
    const body = document.createElement("p");
    body.className = "inbox-card-text";
    body.textContent = text;
    card.append(body);
  }
  return card;
}

/** Buttons for a card: [label, onClick, extra class]. */
function cardButtons(buttons) {
  const row = document.createElement("div");
  row.className = "dialog-buttons inbox-card-buttons";
  for (const [label, onClick, extra] of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${extra ?? ""}`.trim();
    button.textContent = label;
    button.addEventListener("click", onClick);
    row.append(button);
  }
  return row;
}

/**
 * A suggestion as a before/after comparison: each changed part of the entry,
 * old struck through, new below it.
 */
function suggestionCard(suggestion) {
  const entry = findEntry(suggestion.entryId);
  const who = suggestion.author === "user" ? "You" : state.settings.friendName;
  const name = entry?.name ?? "an entry";
  const change = suggestion.change;
  const card = inboxCard(change.delete ? `${who}: delete ${name}?` : `${who}: change ${name}`, "");
  if (change.delete || !entry) return card;

  const diff = document.createElement("dl");
  diff.className = "suggestion-diff";
  const row = (label, before, after) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const old = document.createElement("dd");
    old.className = "diff-before";
    old.textContent = before || "(empty)";
    const next = document.createElement("dd");
    next.className = "diff-after";
    next.textContent = after || "(removed)";
    diff.append(term, old, next);
  };
  if (change.name !== undefined && change.name !== entry.name) row("Name", entry.name, change.name);
  if (change.fields !== undefined) {
    const before = new Map(entry.fields.map((f) => [f.label, f.value]));
    const after = new Map(change.fields.map((f) => [f.label, f.value]));
    for (const label of new Set([...before.keys(), ...after.keys()])) {
      if ((before.get(label) ?? "") !== (after.get(label) ?? "")) row(label, before.get(label), after.get(label));
    }
  }
  if (change.systemPrompt !== undefined && change.systemPrompt !== entry.systemPrompt) {
    row("Notes", entry.systemPrompt, change.systemPrompt);
  }
  card.append(diff);
  return card;
}

async function reviewSuggestion(id, action) {
  try {
    await api("POST", `/api/notebook/suggestions/${encodeURIComponent(id)}/${action}`, {});
    await refreshNotebook();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

/** Take back one of your identity or self-page suggestions. */
async function withdrawWaiting(path) {
  try {
    state.waiting = (await api("POST", path, {})).waiting;
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

/** Do something to an inbox item (answer, dismiss, approve, deny), and show the result. */
async function inboxAction(id, action, body = {}) {
  const { inbox, channels } = await api("POST", `/api/inbox/${encodeURIComponent(id)}/${action}`, body);
  state.inbox = inbox;
  state.channels = channels;
}

async function answerAsk(id, answer) {
  try {
    await inboxAction(id, "answer", { answer });
    renderAll();
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

async function dismissAsk(id) {
  if (!confirm(`Set this aside without answering? ${state.settings.friendName} is told you did.`)) return;
  try {
    await inboxAction(id, "dismiss");
    renderAll();
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}

async function resolveProposal(id, action) {
  if (action === "approve" && !confirm("Delete this channel and every message in it? This can't be undone.")) return;
  try {
    await inboxAction(id, action);
    const channels = state.channels;
    if (!channels.some((c) => c.id === state.channelId)) await openChannel(channels[0]?.id ?? null);
    renderAll();
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}
