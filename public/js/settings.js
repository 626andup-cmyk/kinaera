/**
 * The Settings dialog and what hangs off it: profiles and roulettes, their
 * editors, the tool log and tool test, wake-ups and the heartbeat, and
 * Jev's test and log.
 */

import { renderAll } from "./channels.js";
import { $, api, channelPath, els, hideFormError, showFormError, state } from "./core.js";
import { badge, formatTime } from "./format.js";
import { checkLive } from "./live.js";
import { renderToolCall } from "./messages.js";

// ---------------------------------------------------------------- dialogs

/** Server-wide settings: fill the form from `state.settings` and open it. */
export function openSettings() {
  const s = state.settings;
  const form = els.settingsForm.elements;
  fillAssignmentSelect(form.rpAssignment, s.rpAssignment);
  fillAssignmentSelect(form.oocAssignment, s.oocAssignment);
  form.historyLimit.value = s.historyLimit;
  form.summaries.checked = s.summaries;
  form.summaryEvery.value = s.summaryEvery;
  fillAssignmentSelect(form.summaryAssignment, s.summaryAssignment, "Same as roleplay");
  updateSummariesOnly();
  form.wakeups.value = s.wakeups;
  form.awayHours.value = s.awayHours;
  form.wakeCooldownMinutes.value = s.wakeCooldownMinutes;
  form.quietStart.value = String(s.quietStart);
  form.quietEnd.value = String(s.quietEnd);
  form.decisionModel.value = s.decisionModel;
  form.decisionConfidence.value = s.decisionConfidence;
  fillFallbackSelect(form.decisionFallback, s.decisionFallback);
  form.heartbeatHours.value = String(s.heartbeatHours);
  // A custom value (set some other way) still shows.
  if (form.heartbeatHours.value !== String(s.heartbeatHours)) {
    form.heartbeatHours.append(new Option(`About every ${s.heartbeatHours} hours`, String(s.heartbeatHours)));
    form.heartbeatHours.value = String(s.heartbeatHours);
  }
  renderHeartbeatStatus();
  $("beat-result").textContent = "";
  $("test-jev-result").textContent = "";
  updateWakeupsOnly();
  loadWakeLog();
  hideFormError(els.settingsForm);
  els.settingsDialog.showModal();
}

export async function saveSettings(event) {
  // Stop the <form method="dialog"> from closing the dialog before we know
  // the save worked.
  event.preventDefault();
  const form = els.settingsForm.elements;
  try {
    const data = await api("PUT", "/api/settings", {
      rpAssignment: form.rpAssignment.value,
      oocAssignment: form.oocAssignment.value,
      // Number boxes give text; the server wants numbers.
      historyLimit: Number(form.historyLimit.value),
      summaries: form.summaries.checked,
      summaryEvery: Number(form.summaryEvery.value),
      summaryAssignment: form.summaryAssignment.value,
      wakeups: form.wakeups.value,
      awayHours: Number(form.awayHours.value),
      wakeCooldownMinutes: Number(form.wakeCooldownMinutes.value),
      quietStart: Number(form.quietStart.value),
      quietEnd: Number(form.quietEnd.value),
      decisionModel: form.decisionModel.value,
      decisionConfidence: Number(form.decisionConfidence.value),
      decisionFallback: form.decisionFallback.value,
      heartbeatHours: Number(form.heartbeatHours.value),
    });
    state.settings = data.settings;
    els.settingsDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.settingsForm, error.message);
  }
}

/** Only profiles (a fallback for Jev can't be a roulette), with "Nobody" first. */
function fillFallbackSelect(select, value) {
  select.replaceChildren(new Option("Nobody", ""), ...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  select.value = value || "";
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

/** Show the wake-up settings only while wake-ups are on. */
export function updateWakeupsOnly() {
  const on = els.settingsForm.elements.wakeups.value !== "off";
  for (const element of els.settingsForm.querySelectorAll(".wakeups-only")) element.hidden = !on;
}

const WAKE_REASONS = {
  opened: "You opened the app",
  away: "You came back",
  "scene-ended": "A scene ended",
  review: "A suggestion to review",
  heartbeat: "Heartbeat",
  answer: "You answered an ask",
};
const WAKE_OUTCOMES = { posted: "wrote to you", quiet: "didn't write", failed: "failed" };

/** Settings → Your friend reaching out → Recent wake-ups. */
/** Whether phone notifications work here, and when the next heartbeat is. */
function renderHeartbeatStatus() {
  const parts = [
    state.notifications
      ? "Phone notifications are on (Termux): you'll get one when your friend writes and the app isn't open."
      : "Phone notifications need Termux:API (on Android); here, messages wait in the app.",
  ];
  if (state.heartbeatNext) parts.push(`Next heartbeat around ${formatTime(state.heartbeatNext)}.`);
  $("heartbeat-status").textContent = parts.join(" ");
}

/** Settings → "Beat now": a heartbeat straight away. */
async function beatNow() {
  const result = $("beat-result");
  const button = $("beat-now");
  button.disabled = true;
  result.textContent = "Beating…";
  try {
    const { beat } = await api("POST", "/api/heartbeat", {});
    result.textContent = beat.detail;
    loadWakeLog();
    checkLive();
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$("beat-now").addEventListener("click", beatNow);

async function loadWakeLog() {
  const list = $("wake-log-list");
  try {
    const { wakeups } = await api("GET", "/api/wakeups");
    if (wakeups.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = "Nothing yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...wakeups.map((w) => {
        const item = document.createElement("li");
        item.dataset.outcome = w.outcome;
        const head = document.createElement("strong");
        head.textContent = `${WAKE_REASONS[w.reason] ?? w.reason}: ${WAKE_OUTCOMES[w.outcome] ?? w.outcome}`;
        const time = document.createElement("time");
        time.className = "message-time";
        time.dateTime = w.at;
        time.textContent = ` ${formatTime(w.at)}`;
        const detail = document.createElement("div");
        detail.className = "hint";
        detail.textContent = w.detail;
        item.append(head, time, detail);
        return item;
      }),
    );
  } catch (error) {
    list.replaceChildren();
  }
}

/** Settings → Test Jev: one tiny question, and what came back. */
export async function testJevNow() {
  const result = $("test-jev-result");
  result.textContent = "Asking Jev…";
  try {
    const data = await api("POST", "/api/jev/test", {});
    const raw = data.report?.raw ? ` Raw reply: ${data.report.raw.slice(0, 300)}` : "";
    result.textContent = `${data.ok ? "✓" : "✗"} ${data.detail}${data.ok ? "" : raw}`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  }
}

/** Show the summary settings only while summaries are on. */
export function updateSummariesOnly() {
  const on = els.settingsForm.elements.summaries.checked;
  for (const element of els.settingsForm.querySelectorAll(".summaries-only")) element.hidden = !on;
}

// ------------------------------------------------- profiles and roulettes

/*
 * Stage 5: connection profiles (a model and its settings) and roulettes (a
 * weighted set of profiles). The server keeps them; the app lists, edits
 * and assigns them. An assignment is written "profile:<id>" or
 * "roulette:<id>"; "" means the first profile.
 */

/** Reload profiles and roulettes, and redraw whatever shows them. */
async function refreshProfiles() {
  const { profiles, roulettes } = await api("GET", "/api/profiles");
  state.profiles = profiles;
  state.roulettes = roulettes;
  if ($("models-dialog").open) renderModels();
  // Settings may be open underneath: keep its choices current.
  if (els.settingsDialog.open) {
    const form = els.settingsForm.elements;
    fillAssignmentSelect(form.rpAssignment, form.rpAssignment.value);
    fillAssignmentSelect(form.oocAssignment, form.oocAssignment.value);
    fillAssignmentSelect(form.summaryAssignment, form.summaryAssignment.value, "Same as roleplay");
  }
}

/**
 * Fill a select with every profile and roulette.
 *
 * @param emptyLabel  If given, a first option with value "" and this label
 *                    (e.g. "Same as the server").
 */
export function fillAssignmentSelect(select, value, emptyLabel) {
  const profiles = document.createElement("optgroup");
  profiles.label = "Profiles";
  profiles.append(...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  const roulettes = document.createElement("optgroup");
  roulettes.label = "Roulettes";
  roulettes.append(...state.roulettes.map((r) => new Option(`🎲 ${r.name}`, `roulette:${r.id}`)));
  select.replaceChildren(
    ...(emptyLabel ? [new Option(emptyLabel, "")] : []),
    profiles,
    ...(state.roulettes.length ? [roulettes] : []),
  );
  // "" (no assignment) means the first profile, where there's no "" option.
  select.value = value || (emptyLabel ? "" : `profile:${state.profiles[0]?.id}`);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

/** A readable name for an assignment, e.g. "DeepSeek" or "🎲 Variety". */
export function assignmentName(value) {
  const [kind, id] = (value || "").split(":");
  if (kind === "roulette") return `🎲 ${state.roulettes.find((r) => r.id === id)?.name ?? "?"}`;
  return (state.profiles.find((p) => p.id === id) ?? state.profiles[0])?.name ?? "?";
}

export function openModels() {
  hideFormError($("models-dialog"));
  renderModels();
  $("models-dialog").showModal();
}

/** Draw the lists of profiles and roulettes. */
function renderModels() {
  const inUse = (value) => {
    const jobs = [];
    if (state.settings.rpAssignment === value) jobs.push("roleplay");
    if (state.settings.oocAssignment === value) jobs.push("OOC");
    const channels = state.channels.filter((c) => c.assignment === value).map((c) => `#${c.name}`);
    return [...jobs, ...channels];
  };

  $("profile-list").replaceChildren(
    ...state.profiles.map((profile, index) => {
      const uses = inUse(`profile:${profile.id}`);
      if (index === 0 && !state.settings.rpAssignment) uses.unshift("roleplay");
      if (index === 0 && !state.settings.oocAssignment) uses.unshift("OOC");
      return profileRow(
        profile.name,
        [profile.model.split("/").at(-1), profile.supportsTools ? "tools" : "no tools", ...(profile.consultant ? ["consultant"] : []), ...uses.map((u) => `used by ${u}`)],
        () => openProfile(profile),
      );
    }),
  );

  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  $("roulette-list").replaceChildren(
    ...state.roulettes.map((roulette) => {
      const total = roulette.entries.reduce((sum, e) => sum + e.weight, 0);
      const shares = roulette.entries.map(
        (e) => `${Math.round((e.weight / total) * 100)}% ${byId.get(e.profileId)?.name ?? "?"}`,
      );
      return profileRow(
        `🎲 ${roulette.name}`,
        [...(shares.length ? shares : ["empty"]), ...inUse(`roulette:${roulette.id}`).map((u) => `used by ${u}`)],
        () => openRoulette(roulette),
      );
    }),
  );
}

/** One row in the profile or roulette list: a name, badges, and the whole row opens it. */
function profileRow(name, badges, onOpen) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "profile-row";
  const title = document.createElement("span");
  title.className = "profile-row-name";
  title.textContent = name;
  const tags = document.createElement("span");
  tags.className = "notebook-entry-badges";
  tags.append(...badges.map(badge));
  button.append(title, tags);
  button.addEventListener("click", onOpen);
  item.append(button);
  return item;
}

// --------------------------------------------------------- profile editor

/** Open a profile in the editor, or start a new one (`null`). */
export function openProfile(profile) {
  state.editingProfile = profile;
  const form = $("profile-form");
  const f = form.elements;
  hideFormError(form);
  $("profile-title").textContent = profile ? profile.name : "New profile";
  const base = profile ?? state.profiles[0] ?? {};
  f.name.value = profile?.name ?? "";
  f.model.value = profile?.model ?? base.model ?? "";
  f.temperature.value = profile?.temperature ?? 0.9;
  f.maxTokens.value = profile?.maxTokens ?? 1024;
  f.topP.value = profile?.topP ?? "";
  f.reasoningEffort.value = profile?.reasoningEffort ?? "";
  f.supportsTools.checked = profile?.supportsTools ?? true;
  f.consultant.checked = profile?.consultant ?? false;
  f.quirkPrompt.value = profile?.quirkPrompt ?? "";
  f.extraParams.value = profile?.extraParams ?? "";
  form.querySelector(".advanced").open = Boolean(profile?.extraParams);
  $("profile-delete").hidden = !profile;
  renderToolTest(profile);
  $("profile-dialog").showModal();
}

export async function saveProfile(event) {
  event.preventDefault();
  const form = $("profile-form");
  const f = form.elements;
  const body = {
    name: f.name.value,
    model: f.model.value,
    // Number boxes give text; the server wants numbers.
    temperature: Number(f.temperature.value),
    maxTokens: Number(f.maxTokens.value),
    topP: f.topP.value === "" ? null : Number(f.topP.value),
    reasoningEffort: f.reasoningEffort.value || null,
    supportsTools: f.supportsTools.checked,
    consultant: f.consultant.checked,
    quirkPrompt: f.quirkPrompt.value,
    extraParams: f.extraParams.value,
  };
  try {
    const profile = state.editingProfile;
    if (profile) await api("PATCH", `/api/profiles/${encodeURIComponent(profile.id)}`, body);
    else await api("POST", "/api/profiles", body);
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

export async function deleteProfile() {
  const profile = state.editingProfile;
  if (!confirm(`Delete the profile "${profile.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/profiles/${encodeURIComponent(profile.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("profile-form"), error.message);
  }
}

/** Ask the server which models nanoGPT offers and offer them as suggestions. */
export async function loadModels() {
  els.loadModels.disabled = true;
  els.loadModels.textContent = "Loading…";
  try {
    const { models } = await api("GET", "/api/models");
    els.modelList.replaceChildren(...models.map((id) => new Option(id, id)));
    els.loadModels.textContent = `${models.length} models`;
    // Focus the model box so the suggestions are one tap away.
    $("profile-form").elements.model.focus();
  } catch (error) {
    showFormError($("profile-form"), error.message);
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

// -------------------------------------------------------- roulette editor

export function openRoulette(roulette) {
  state.editingRoulette = roulette;
  const form = $("roulette-form");
  hideFormError(form);
  $("roulette-title").textContent = roulette ? `🎲 ${roulette.name}` : "New roulette";
  form.elements.name.value = roulette?.name ?? "";
  const entries = roulette?.entries ?? state.profiles.slice(0, 2).map((p) => ({ profileId: p.id, weight: 1 }));
  $("roulette-entries").replaceChildren(...entries.map(rouletteEntryRow));
  updateRouletteShares();
  $("roulette-delete").hidden = !roulette;
  $("roulette-dialog").showModal();
}

/** One row of the roulette editor: a profile, its weight, its share, and a remove button. */
export function rouletteEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "roulette-entry";
  const select = document.createElement("select");
  select.className = "roulette-profile";
  select.setAttribute("aria-label", "Profile");
  select.append(...state.profiles.map((p) => new Option(p.name, p.id)));
  select.value = entry.profileId;
  const weight = document.createElement("input");
  weight.className = "roulette-weight";
  weight.type = "number";
  weight.min = "0.01";
  weight.step = "any";
  weight.value = entry.weight;
  weight.setAttribute("aria-label", "Weight");
  const share = document.createElement("span");
  share.className = "roulette-share";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove");
  remove.addEventListener("click", () => {
    row.remove();
    updateRouletteShares();
  });
  row.append(select, weight, share, remove);
  return row;
}

/** Show each row's chance, e.g. "40%". */
export function updateRouletteShares() {
  const rows = [...$("roulette-entries").querySelectorAll(".roulette-entry")];
  const weights = rows.map((row) => Math.max(0, Number(row.querySelector(".roulette-weight").value) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  rows.forEach((row, i) => {
    row.querySelector(".roulette-share").textContent = total ? `${Math.round((weights[i] / total) * 100)}%` : "";
  });
}

export async function saveRoulette(event) {
  event.preventDefault();
  const form = $("roulette-form");
  const entries = [...$("roulette-entries").querySelectorAll(".roulette-entry")].map((row) => ({
    profileId: row.querySelector(".roulette-profile").value,
    weight: Number(row.querySelector(".roulette-weight").value),
  }));
  try {
    const roulette = state.editingRoulette;
    const body = { name: form.elements.name.value, entries };
    if (roulette) await api("PATCH", `/api/roulettes/${encodeURIComponent(roulette.id)}`, body);
    else await api("POST", "/api/roulettes", body);
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

export async function deleteRoulette() {
  const roulette = state.editingRoulette;
  if (!confirm(`Delete the roulette "${roulette.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/roulettes/${encodeURIComponent(roulette.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("roulette-form"), error.message);
  }
}

// ---------------------------------------------------------------- tool log

export async function openToolLog() {
  $("tool-log-copy").textContent = "Copy as text";
  try {
    const { toolCalls } = await api("GET", channelPath("tool-log"));
    state.toolLog = toolCalls;
    renderToolLog();
    $("tool-log-dialog").showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

export function renderToolLog() {
  const errorsOnly = $("tool-log-errors").checked;
  const calls = [...state.toolLog].reverse().filter((c) => !errorsOnly || c.status === "error");
  const list = $("tool-log-list");
  if (calls.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = errorsOnly ? "No errors." : `${state.settings.friendName} hasn't used any tools here yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...calls.map(renderToolCall));
}

/** Copy the tool log as plain text, e.g. to share when something goes wrong. */
export async function copyToolLog() {
  const text = state.toolLog
    .map((c) =>
      [
        `${c.createdAt}  ${c.profile ?? ""}  round ${c.round + 1}  ${c.source}  ${c.status}`,
        `${c.name} ${c.arguments}`,
        `-> ${c.result}`,
      ].join("\n"),
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("tool-log-copy").textContent = "Copied";
  } catch {
    showFormError($("tool-log-dialog"), "Couldn't copy: your browser didn't allow it.");
  }
}

// ------------------------------------------------------------- tool test

/** Under "Test tools" in the profile editor: the last result, or a hint. */
function renderToolTest(profile, result) {
  const box = $("profile-test-result");
  $("profile-test").disabled = !profile;
  box.dataset.verdict = result?.verdict ?? "";
  if (!profile) {
    box.textContent = "Save the profile first, then test it.";
  } else if (!result) {
    box.textContent = "Checks whether this model can call tools, with one small request.";
  } else {
    const labels = { native: "✓ Works", text: "~ Works, as text", none: "✗ No tool call", broken: "✗ Broken arguments" };
    box.textContent = `${labels[result.verdict]} (${result.seconds}s). ${result.detail}`;
  }
}

export async function testProfileTools() {
  const profile = state.editingProfile;
  const button = $("profile-test");
  button.disabled = true;
  button.textContent = "Testing…";
  try {
    const { test } = await api("POST", `/api/profiles/${encodeURIComponent(profile.id)}/test`, {});
    renderToolTest(profile, test);
  } catch (error) {
    showFormError($("profile-form"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Test tools";
  }
}
