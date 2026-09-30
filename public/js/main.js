/**
 * Kinaera's web app: the starting point.
 *
 * The app is deliberately simple: no framework and no build step. The
 * browser loads this file as an ES module, and it imports the rest, one
 * module per area (see the list below). Each keeps its part of the page in
 * step with `state` (in core.js), and redraws with its `render...`
 * functions whenever something changes.
 *
 * This file wires the page's buttons and forms to those modules, then
 * loads the server's state and opens a channel.
 *
 *   core.js         state, elements, the API, errors
 *   format.js       escaping and formatting text
 *   live.js         live updates, and new versions of the app
 *   channels.js     channels, categories and the sidebar
 *   messages.js     messages and turns
 *   composer.js     the box you write in, and attachments
 *   summaries.js    scene summaries and the story so far
 *   comments.js     comment threads
 *   reactions.js    emoji reactions and custom emojis
 *   texting.js      texting in OOC
 *   notebook.js     the notebook, entries, folders and casts
 *   library.js      the reference library
 *   inbox.js        asks, proposals and suggestions
 *   history.js      message history, the intervention log, the check log
 *   settings.js     settings, profiles, roulettes, logs
 *   themes.js       themes and appearance
 *   friend-page.js  friends, servers and the friend menu
 *   friend-self.js  the friend's page: identity, self-page, orientation
 */

import {
  channelFromAddress,
  clearChannel,
  closeSidebar,
  createChannel,
  deleteCategory,
  deleteChannel,
  fillCategorySelect,
  moveChannel,
  moveChannelIndicator,
  openCategory,
  openChannel,
  openChannelSettings,
  openNewChannel,
  openSidebar,
  parseAddress,
  previewPrompt,
  saveCategory,
  saveChannel,
  updateModeNote,
  updateNewChannelKind,
} from "./channels.js";
import { newComment, openThread, resolveThread, sendComment, updateCommentButton } from "./comments.js";
import { autoGrow, openAttach, renderAttachList } from "./composer.js";
import { $, els, hideError, readLocal, showError, state, writeLocal } from "./core.js";
import { FRIEND_KEY, loadHub, pickFriend, switchFriend } from "./friend-page.js";
import "./friend-self.js";
import { copyCheckLog, openCheckLog, openInterventions } from "./history.js";
import { openInbox } from "./inbox.js";
import {
  deleteLibraryDoc,
  library,
  openLibrary,
  openLibraryDoc,
  openPassage,
  readLibraryFile,
  saveLibraryDoc,
  searchLibrary,
} from "./library.js";
import {
  LIVE_CHECK_INTERVAL,
  WAKE_AFTER_HIDDEN,
  checkLive,
  checkServerVersion,
  loadState,
  sayOpened,
  sendPresence,
} from "./live.js";
import { friendTurn, newScene, regenerate, sendMessage, startBusyWatch, stopTurn, takeReply } from "./messages.js";
import {
  changeCast,
  deleteEntry,
  deleteFolder,
  fillEntrySettingChoices,
  fitToText,
  loadNotebook,
  openEntry,
  openFolder,
  openNotebook,
  readEntryFields,
  renderEntryFields,
  renderEntryLinks,
  saveEntry,
  saveFolder,
  toggleEntryPin,
  updateEntryForm,
} from "./notebook.js";
import {
  copyToolLog,
  deleteProfile,
  deleteRoulette,
  loadModels,
  openModels,
  openProfile,
  openRoulette,
  openSettings,
  openToolLog,
  renderToolLog,
  rouletteEntryRow,
  saveProfile,
  saveRoulette,
  saveSettings,
  testJevNow,
  testProfileTools,
  updateRouletteShares,
  updateSummariesOnly,
  updateWakeupsOnly,
} from "./settings.js";
import { refreshSummaries, saveStory, updateSummaries } from "./summaries.js";
import {
  LAST_THEME_KEY,
  chooseEffects,
  copyTheme,
  deleteTheme,
  loadThemes,
  openAppearance,
  openThemeEditor,
  saveTheme,
  setStylesheet,
  uploadThemeFiles,
  watchForStutter,
} from "./themes.js";

// ------------------------------------------------------------ wiring it up

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

// Enter makes a new line (you'll want paragraphs). Ctrl+Enter or Cmd+Enter sends.
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener("input", autoGrow);

els.turn.addEventListener("click", friendTurn);
$("stop-button").addEventListener("click", stopTurn);
$("appearance-button").addEventListener("click", openAppearance);
$("theme-copy").addEventListener("click", copyTheme);
$("theme-edit").addEventListener("click", () => openThemeEditor(state.settings.appTheme));
$("theme-delete").addEventListener("click", deleteTheme);
$("appearance-dialog").addEventListener("change", (event) => {
  if (event.target.name === "effects") chooseEffects(event.target.value);
});
$("theme-editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveTheme(true);
});
$("theme-apply").addEventListener("click", () => saveTheme(false));
$("theme-upload").addEventListener("change", (event) => {
  uploadThemeFiles([...event.target.files]);
  event.target.value = ""; // so choosing the same file again still counts
});
$("notice-dismiss").addEventListener("click", () => ($("notice").hidden = true));
els.messages.addEventListener("scroll", watchForStutter, { passive: true });
$("scene-button").addEventListener("click", newScene);
$("posting-as").addEventListener("change", (event) => state.postingAs.set(state.channelId, event.target.value));
els.channelForm.addEventListener("change", (event) => {
  if (event.target.name === "mode") updateModeNote();
});
$("update-reload").addEventListener("click", () => location.reload());

// Coming back to the app (switching to it, unlocking the phone) is when an
// update is most likely to have happened while it sat in the background,
// and, after a while away, a chance for your friend to say hi (stage 8).
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    hiddenAt = Date.now();
    sendPresence();
    return;
  }
  checkServerVersion();
  if (hiddenAt !== null && Date.now() - hiddenAt >= WAKE_AFTER_HIDDEN) sayOpened();
  hiddenAt = null;
  checkLive();
});
setInterval(checkLive, LIVE_CHECK_INTERVAL);
els.errorRetry.addEventListener("click", () => state.retry && state.retry());
$("error-dismiss").addEventListener("click", hideError);

// Clicking a channel link changes the address; this opens that channel.
window.addEventListener("hashchange", () => {
  // Another friend's channel (from their section, or a notification): switch to them.
  const address = parseAddress();
  if (address.friendId && address.friendId !== state.friendId) return switchFriend(address.friendId, address.channelId);
  const id = channelFromAddress();
  if (id && id !== state.channelId) openChannel(id);
  closeSidebar();
});
// Tapping the channel you're already in should still close the phone sidebar.
// Opening a channel closes the sidebar on a phone (not folding a category, or editing one).
els.channelList.addEventListener("click", (event) => {
  if (event.target.closest(".channel-link")) closeSidebar();
});
// The channel indicator follows the links' size when the sidebar changes width.
new ResizeObserver(() => moveChannelIndicator()).observe(els.channelList);

$("menu-button").addEventListener("click", openSidebar);
$("sidebar-scrim").addEventListener("click", closeSidebar);

$("settings-button").addEventListener("click", openSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.loadModels.addEventListener("click", loadModels);

$("channel-settings-button").addEventListener("click", openChannelSettings);
// Memory, in channel settings: fetch the latest summaries when it's opened.
$("channel-memory").addEventListener("toggle", () => {
  if ($("channel-memory").open) refreshSummaries();
});
$("memory-save-story").addEventListener("click", saveStory);
$("memory-update").addEventListener("click", () => updateSummaries(false));
$("memory-rebuild").addEventListener("click", () => updateSummaries(true));
els.settingsForm.elements.summaries.addEventListener("change", updateSummariesOnly);
els.settingsForm.elements.wakeups.addEventListener("change", updateWakeupsOnly);
$("test-jev").addEventListener("click", testJevNow);
$("open-check-log").addEventListener("click", openCheckLog);
$("friend-check-log").addEventListener("click", openCheckLog);
$("check-log-copy").addEventListener("click", copyCheckLog);
els.channelForm.addEventListener("submit", saveChannel);
$("channel-move-up").addEventListener("click", () => moveChannel(-1));
$("channel-move-down").addEventListener("click", () => moveChannel(1));
$("preview-prompt").addEventListener("click", previewPrompt);
$("clear-channel").addEventListener("click", clearChannel);
$("delete-channel").addEventListener("click", deleteChannel);

$("cast-add").addEventListener("change", (event) => {
  const value = event.target.value;
  event.target.value = "";
  if (value.startsWith("new:")) openEntry({ kind: value.slice(4), owner: "friend" }, state.channelId);
  else if (value) changeCast(value, true);
});

$("notebook-button").addEventListener("click", openNotebook);
$("notebook-new-character").addEventListener("click", () => openEntry({ kind: "character" }));
$("notebook-new-lore").addEventListener("click", () => openEntry({ kind: "lore", owner: "joint" }));
$("notebook-new-folder").addEventListener("click", () => openFolder());
$("notebook-library").addEventListener("click", openLibrary);
$("library-add").addEventListener("click", () => openLibraryDoc());
$("library-file").addEventListener("change", readLibraryFile);
$("library-doc-form").addEventListener("submit", saveLibraryDoc);
$("library-doc-delete").addEventListener("click", deleteLibraryDoc);
$("library-search").addEventListener("input", () => {
  clearTimeout(library.searchTimer);
  library.searchTimer = setTimeout(searchLibrary, 250);
});
$("library-read-prev").addEventListener("click", () => openPassage(library.reading.doc.id, library.reading.seq - 1));
$("library-read-next").addEventListener("click", () => openPassage(library.reading.doc.id, library.reading.seq + 1));
$("entry-form").addEventListener("submit", saveEntry);
$("entry-form").addEventListener("change", (event) => {
  const fields = event.currentTarget.elements;
  if (event.target === fields.owner || event.target === fields.folderId) {
    fillEntrySettingChoices(fields.visibility.value || null, fields.editing.value || null);
    updateEntryForm();
  }
});
$("entry-form").addEventListener("input", (event) => {
  if (event.target.classList.contains("entry-field-value")) fitToText(event.target);
  renderEntryLinks();
});
$("entry-add-field").addEventListener("click", () => {
  renderEntryFields([...readEntryFields(true), { label: "", value: "" }]);
  for (const box of $("entry-fields").querySelectorAll(".entry-field-value")) fitToText(box);
  $("entry-fields").querySelector(".entry-field:last-child .entry-field-label").focus();
});
$("entry-pin").addEventListener("click", toggleEntryPin);
$("entry-delete").addEventListener("click", deleteEntry);
$("folder-form").addEventListener("submit", saveFolder);
$("folder-delete").addEventListener("click", deleteFolder);

$("open-models").addEventListener("click", openModels);
$("new-profile").addEventListener("click", () => openProfile(null));
$("new-roulette").addEventListener("click", () => openRoulette(null));
$("profile-form").addEventListener("submit", saveProfile);
$("profile-delete").addEventListener("click", deleteProfile);
$("roulette-form").addEventListener("submit", saveRoulette);
$("roulette-delete").addEventListener("click", deleteRoulette);
$("roulette-add").addEventListener("click", () => {
  const used = new Set([...$("roulette-entries").querySelectorAll(".roulette-profile")].map((s) => s.value));
  const next = state.profiles.find((p) => !used.has(p.id)) ?? state.profiles[0];
  $("roulette-entries").append(rouletteEntryRow({ profileId: next.id, weight: 1 }));
  updateRouletteShares();
});
$("roulette-entries").addEventListener("input", updateRouletteShares);
$("regenerate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("regenerate-dialog").close();
  regenerate($("regenerate-profile").value || undefined);
});

// Stage 6: activity, tool log, inbox, comments, attachments.
$("inbox-button").addEventListener("click", openInbox);
$("open-interventions").addEventListener("click", openInterventions);
$("open-tool-log").addEventListener("click", openToolLog);
$("tool-log-errors").addEventListener("change", renderToolLog);
$("tool-log-copy").addEventListener("click", copyToolLog);
$("profile-test").addEventListener("click", testProfileTools);
$("attach-button").addEventListener("click", openAttach);
$("attach-search").addEventListener("input", renderAttachList);
$("thread-form").addEventListener("submit", sendComment);
$("thread-resolve").addEventListener("click", resolveThread);
$("thread-picker").addEventListener("change", (event) => openThread(event.target.value));
els.messages.addEventListener("click", (event) => {
  const mark = event.target.closest(".comment-mark");
  if (mark) openThread(mark.dataset.thread);
});
document.addEventListener("selectionchange", updateCommentButton);
// Keep the selection when the button is pressed, so it's still there to read.
$("comment-float").addEventListener("pointerdown", (event) => event.preventDefault());
$("comment-float").addEventListener("click", (event) => {
  const { messageId, quote } = event.currentTarget.dataset;
  event.currentTarget.hidden = true;
  document.getSelection()?.removeAllRanges();
  newComment(messageId, quote);
});

$("new-channel-button").addEventListener("click", openNewChannel);
els.newChannelForm.addEventListener("submit", createChannel);
$("category-form").addEventListener("submit", saveCategory);
$("category-delete").addEventListener("click", deleteCategory);
// A new category from the new channel dialog: made, and picked.
$("new-channel-new-category").addEventListener("click", () =>
  openCategory(null, (category) => fillCategorySelect($("new-channel-category"), category.id)),
);
els.newChannelForm.addEventListener("change", updateNewChannelKind);

// Every "Cancel" / "Close" button closes the dialog it's in.
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

// Register the service worker, which is what makes the app installable.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service worker registration failed:", error);
  });
}

// Start: load the server's state, then open the channel in the address bar
// (or the first channel).
// Apply the last app theme straight away, so the page doesn't flash the
// default look while the server answers. (applyThemes corrects it after.)
if (readLocal(LAST_THEME_KEY)) setStylesheet("theme-app", `/themes/${readLocal(LAST_THEME_KEY)}/theme.css?v=0`);

// Which friend first (the hub knows who there is), then their state.
loadHub()
  .then(() => {
    state.friendId = pickFriend();
    if (state.friendId) writeLocal(FRIEND_KEY, state.friendId);
    return Promise.all([loadState(), loadThemes(), loadNotebook()]);
  })
  .then(() => {
    // A turn may already be running (from another tab, or from before a
    // reload): keep an eye on it.
    if (state.busy.size > 0) startBusyWatch();
    // You've opened the app: your friend may wake up (stage 8).
    sayOpened();
    return openChannel(channelFromAddress() ?? state.channels[0]?.id ?? null);
  })
  .catch((error) => showError(`Couldn't load Kinaera: ${error.message}`, () => location.reload()));

// Replying to a message: ✕ drops it.
$("reply-bar-cancel").addEventListener("click", () => takeReply(state.channelId));
