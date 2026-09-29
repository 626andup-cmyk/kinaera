/**
 * The inbox: what's waiting on someone. Your friend's proposals and
 * suggestions for you to approve, and your suggestions waiting for them.
 */

import { openChannel, renderAll } from "./channels.js";
import { $, api, hideFormError, showFormError, state } from "./core.js";
import { badge } from "./format.js";
import { findEntry, refreshNotebook } from "./notebook.js";

// ------------------------------------------------------------------ inbox

/*
 * The inbox gathers what's waiting on someone: your friend's proposals
 * (deleting a channel) and suggestions (notebook changes) for you to
 * approve, and your suggestions waiting for your friend, who reviews them
 * with their tools on their next turn.
 */

/** Suggestions waiting for you, and proposals: what the badge counts. */
function inboxCount() {
  return state.proposals.length + state.notebook.suggestions.filter((s) => s.reviewer === "user").length;
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

  if (state.proposals.length) {
    sections.push(
      inboxSection(
        `${friend} asks`,
        state.proposals.map((proposal) => {
          const card = inboxCard(`Delete #${proposal.targetName}?`, proposal.reason ? `“${proposal.reason}”` : "");
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
  if (yours.length) {
    sections.push(
      inboxSection(
        `Waiting for ${friend}`,
        yours.map((s) => {
          const card = suggestionCard(s);
          const note = document.createElement("p");
          note.className = "hint";
          note.textContent = `${friend} reviews these on their next turn with tools.`;
          card.append(note, cardButtons([["Withdraw", () => reviewSuggestion(s.id, "withdraw")]]));
          return card;
        }),
      ),
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

async function resolveProposal(id, action) {
  if (action === "approve" && !confirm("Delete this channel and every message in it? This can't be undone.")) return;
  try {
    const { proposals, channels } = await api("POST", `/api/proposals/${encodeURIComponent(id)}/${action}`, {});
    state.proposals = proposals;
    state.channels = channels;
    if (!channels.some((c) => c.id === state.channelId)) await openChannel(channels[0]?.id ?? null);
    renderAll();
    renderInbox();
  } catch (error) {
    showFormError($("inbox-dialog"), error.message);
  }
}
