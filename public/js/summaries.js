/**
 * Summaries on screen: a scene's summary under its scene break, and the
 * channel's memory (the story so far) in channel settings. The server
 * writes them (src/summarizer.ts); here you read them, edit them, or ask for
 * new ones.
 */

import { $, api, channelPath, currentChannel, els, showError, showFormError, state } from "./core.js";
import { actionButton, renderMessages } from "./messages.js";

// ------------------------------------------------------------- summaries

/*
 * Summaries (stage 7) are written by the server in the background, a few
 * seconds after a channel changes (see src/summarizer.ts). The app shows
 * them where they belong: each scene's under the scene break that ended
 * it, and the story so far, earlier in the scene and the digest in channel
 * settings → Memory. You can edit them, and ask for them to be rewritten.
 */

/** Show or hide a scene's summary under its scene break (fetching the latest). */
export async function toggleSceneSummary(breakId) {
  if (state.openSummaries.has(breakId)) {
    state.openSummaries.delete(breakId);
    renderMessages();
    return;
  }
  state.openSummaries.add(breakId);
  renderMessages();
  await refreshSummaries();
}

/** Fetch the open channel's summaries, and redraw what shows them. */
export async function refreshSummaries() {
  const channelId = state.channelId;
  try {
    const { summaries } = await api("GET", channelPath("summaries", channelId));
    if (state.channelId !== channelId) return;
    state.summaries = summaries;
    renderMessages();
    if (els.channelDialog.open) renderMemory();
  } catch (error) {
    showError(`Couldn't load the summaries: ${error.message}`);
  }
}

/** The panel under a scene break: its scene's summary, to read, edit or rewrite. */
export function renderSceneSummary(sceneBreak) {
  const panel = document.createElement("div");
  panel.className = "scene-summary";
  const summary = state.summaries?.scenes?.[sceneBreak.id];

  if (state.editingSummary === sceneBreak.id) {
    const box = document.createElement("textarea");
    box.className = "scene-summary-edit";
    box.rows = 6;
    box.value = summary?.content ?? "";
    box.setAttribute("aria-label", "Scene summary");
    const buttons = document.createElement("div");
    buttons.className = "scene-summary-actions";
    buttons.append(
      actionButton("Cancel", () => {
        state.editingSummary = null;
        renderMessages();
      }),
      actionButton("Save", () => saveSceneSummary(sceneBreak.id, box.value)),
    );
    panel.append(box, buttons);
    queueMicrotask(() => box.focus());
    return panel;
  }

  const text = document.createElement("p");
  text.className = "scene-summary-text";
  if (summary) {
    text.textContent = summary.content;
  } else {
    text.classList.add("empty");
    text.textContent = !state.settings.summaries
      ? "Summaries are off (Settings → Memory)."
      : state.summaries?.running
        ? "Being written…"
        : "Not summarized yet. It's written a few seconds after a scene ends.";
  }
  const note = document.createElement("span");
  note.className = "scene-summary-note";
  note.textContent = summary?.edited ? "Your words" : summary?.stale ? "Out of date: being rewritten" : "";

  const buttons = document.createElement("div");
  buttons.className = "scene-summary-actions";
  buttons.append(
    note,
    actionButton("Edit", () => {
      state.editingSummary = sceneBreak.id;
      renderMessages();
    }),
    actionButton("Rewrite", () => regenerateSceneSummary(sceneBreak.id), !state.settings.summaries),
  );
  panel.append(text, buttons);
  return panel;
}

async function saveSceneSummary(breakId, content) {
  try {
    const { summaries } = await api("PUT", channelPath("summaries"), { kind: "scene", sceneId: breakId, content });
    state.summaries = summaries;
    state.editingSummary = null;
    renderMessages();
  } catch (error) {
    showError(`Couldn't save the summary: ${error.message}`);
  }
}

/** Have a scene's summary written again (waits for it). */
async function regenerateSceneSummary(breakId) {
  if (state.summaries) state.summaries.running = true;
  delete state.summaries?.scenes?.[breakId];
  renderMessages();
  try {
    const { summaries } = await api("POST", channelPath(`summaries/scenes/${encodeURIComponent(breakId)}/regenerate`), {});
    state.summaries = summaries;
    if (summaries.error) showError(`Couldn't write the summary: ${summaries.error}`);
  } catch (error) {
    showError(`Couldn't write the summary: ${error.message}`);
  }
  renderMessages();
}

/** Channel settings → Memory: the story so far, earlier in the scene, the digest. */
export function renderMemory() {
  const channel = currentChannel();
  const summaries = state.summaries;
  if (!channel) return;
  const rp = channel.kind === "rp";
  for (const element of $("channel-memory").querySelectorAll(".rp-only")) element.hidden = !rp;
  $("memory-note").textContent = state.settings.summaries
    ? `Your friend reads the newest ${state.settings.historyLimit} messages in full, and remembers the rest through these summaries. They're written only from the messages, so nothing hidden from you is ever in them.`
    : "Summaries are off (Settings → Memory), so your friend only reads the newest messages.";
  const story = $("memory-story");
  // Don't overwrite what you're typing.
  if (document.activeElement !== story) story.value = summaries?.story?.content ?? "";
  $("memory-earlier-label").textContent = rp ? "Earlier in this scene" : "Earlier in this conversation";
  $("memory-earlier").textContent =
    summaries?.current?.content ||
    (rp ? "Nothing yet: this scene is still short enough to be read in full." : "Nothing yet: this conversation is still short enough to be read in full.");
  $("memory-digest").textContent = summaries?.digest?.content || "Not written yet.";
  $("memory-status").textContent = summaries?.running
    ? "Writing summaries…"
    : summaries?.error
      ? `The last attempt failed: ${summaries.error}`
      : "";
  for (const id of ["memory-update", "memory-rebuild"]) $(id).disabled = !state.settings.summaries || summaries?.running;
}

export async function saveStory() {
  try {
    const { summaries } = await api("PUT", channelPath("summaries"), { kind: "story", content: $("memory-story").value });
    state.summaries = summaries;
    renderMemory();
    $("memory-status").textContent = "Saved.";
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** "Update now" and "Rebuild all": write summaries, and wait for them. */
export async function updateSummaries(rebuild) {
  if (rebuild && !confirm("Rewrite every summary in this channel from its messages? Your own edits to them will be replaced.")) {
    return;
  }
  if (state.summaries) state.summaries.running = true;
  renderMemory();
  try {
    const { summaries } = await api("POST", channelPath(rebuild ? "summaries/rebuild" : "summaries/update"), {});
    state.summaries = summaries;
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
  renderMemory();
  renderMessages();
}
