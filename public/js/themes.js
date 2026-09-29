/**
 * Themes: applying them, Appearance (choosing one, its sliders, glass
 * effects) and the theme editor.
 *
 * Glass effects themselves live in glass.js, a plain script loaded before
 * this app.
 */

import { moveChannelIndicator, renderAll } from "./channels.js";
import { $, api, currentChannel, els, hideFormError, readLocal, showFormError, state, writeLocal } from "./core.js";
import { badge } from "./format.js";
import { actionButton, scrollToBottom } from "./messages.js";

// ----------------------------------------------------------------- themes

/*
 * Themes are CSS files served by the server (see src/themes.ts). Applying
 * one just means pointing a <link> at it; index.html has four, in order:
 *
 *   theme-app           the app theme                  /themes/<id>/theme.css
 *   theme-app-lite      its Lite version, if in use    /themes/<id>/theme-lite.css
 *   theme-channel       the open channel's own theme   /themes/<id>/channel.css
 *   theme-channel-lite  its Lite version, if in use    /themes/<id>/channel-lite.css
 *
 * The channel versions are rewritten by the server to only affect the
 * channel view. And while a channel theme is showing, the app theme is
 * loaded as `outside.css` instead: rewritten to affect everything *but* the
 * channel view, so the channel theme fully replaces it there.
 */

/** Keys for things remembered on this device only (in the browser's localStorage). */
const EFFECTS_KEY = "kinaera.effects"; // "auto" | "full" | "lite"
const AUTO_LITE_KEY = "kinaera.autoLite"; // "1" once Automatic has switched to Lite
export const LAST_THEME_KEY = "kinaera.lastAppTheme";

/** This device's glass effects choice: "auto", "full" or "lite". */
function effectsMode() {
  return readLocal(EFFECTS_KEY) ?? "auto";
}

/** Whether Lite versions of themes should be loaded right now. */
function liteEffects() {
  const mode = effectsMode();
  return mode === "lite" || (mode === "auto" && readLocal(AUTO_LITE_KEY) === "1");
}

function themeInfo(id) {
  return state.themes.find((t) => t.id === id);
}

/**
 * Point a theme <link> at a stylesheet, or unload it (`href` null).
 *
 * Swapping one stylesheet for another would briefly show the page without
 * either while the new one downloads. So the new one is loaded in a second
 * <link> next to the old, and the old is removed once the new has arrived.
 * A theme can also change the layout (spacing, fonts), so after it loads,
 * the view scrolls back to the newest message.
 */
export function setStylesheet(linkId, href) {
  const link = $(linkId);
  const current = link.getAttribute("href");
  if (!href) {
    link.removeAttribute("href");
    return;
  }
  if (current === href) return;
  if (!current) {
    link.addEventListener(
      "load",
      () => {
        scrollToBottom();
        themeLoaded();
      },
      { once: true },
    );
    link.setAttribute("href", href);
    return;
  }
  const next = link.cloneNode();
  next.setAttribute("href", href);
  link.removeAttribute("id"); // the new link takes over the id straight away
  const done = () => {
    link.remove();
    scrollToBottom();
    themeLoaded();
  };
  next.addEventListener("load", done, { once: true });
  next.addEventListener("error", done, { once: true });
  link.after(next);
}

/** The app theme and the open channel's theme, if it has a different one. */
function activeThemes() {
  const app = state.settings?.appTheme ?? "classic";
  const channel = currentChannel();
  return { app, channel: channel?.theme && channel.theme !== app ? channel.theme : null };
}

/** Load the stylesheets for the current app theme, channel theme and effects. */
export function applyThemes() {
  const { app, channel } = activeThemes();
  const lite = liteEffects();
  const v = state.themeVersion;
  // Classic is the base stylesheet itself, so there's nothing to load for it.
  const appTheme = app === "classic" ? null : app;

  const appFile = channel ? "outside" : "theme";
  setStylesheet("theme-app", appTheme && `/themes/${appTheme}/${appFile}.css?v=${v}`);
  setStylesheet("theme-app-lite", appTheme && lite && themeInfo(appTheme)?.hasLite && `/themes/${appTheme}/${appFile}-lite.css?v=${v}`);
  setStylesheet("theme-channel", channel && `/themes/${channel}/channel.css?v=${v}`);
  setStylesheet("theme-channel-lite", channel && lite && themeInfo(channel)?.hasLite && `/themes/${channel}/channel-lite.css?v=${v}`);

  // For theme authors: the channel view says which channel theme it has.
  els.channelView.dataset.channelTheme = channel ?? "";
  writeLocal(LAST_THEME_KEY, appTheme ?? "");
  applyThemeOptions();
  updateGlass();
}

/**
 * Once a theme's stylesheet has loaded: things that depend on how the theme
 * looks. (The channel indicator is hidden until a theme shows it, and its
 * size comes from the theme's channel links.)
 */
function themeLoaded() {
  updateGlass();
  moveChannelIndicator();
}

/**
 * Real liquid glass (public/glass.js): on when a theme asks for it (with
 * `--lensing: on` in its :root), and glass effects aren't Lite. The theme
 * then marks which elements are glass with `--lens: 1`. Checked again
 * whenever a theme's stylesheet finishes loading.
 */
function updateGlass() {
  const wants = (element) => getComputedStyle(element).getPropertyValue("--lensing").trim() === "on";
  Glass.setEnabled(!liteEffects() && (wants(document.documentElement) || wants(els.channelView)));
  Glass.refresh();
}

/*
 * Theme options: sliders a theme declares in its theme.json, each setting a
 * CSS variable (like --bubble-transparency). The values are set straight on
 * the page: the app theme's on <html>, and a channel theme's on the channel
 * view, where they win over the theme's own defaults.
 */

/** The variables set by the last call, so they can be cleared. */
const appliedOptions = { root: [], channel: [] };

/** A theme's option values: yours where you've moved a slider, the theme's default elsewhere. */
function themeOptionValues(themeId) {
  const saved = state.settings?.themeOptions?.[themeId] ?? {};
  return (themeInfo(themeId)?.options ?? []).map((option) => {
    const raw = saved[option.id];
    const value = typeof raw === "number" ? Math.min(option.max, Math.max(option.min, raw)) : option.default;
    return { option, value };
  });
}

function applyThemeOptions() {
  const { app, channel } = activeThemes();
  const set = (element, key, themeId) => {
    for (const variable of appliedOptions[key]) element.style.removeProperty(variable);
    appliedOptions[key] = [];
    if (!themeId) return;
    for (const { option, value } of themeOptionValues(themeId)) {
      element.style.setProperty(option.variable, `${value}${option.unit}`);
      appliedOptions[key].push(option.variable);
    }
  };
  set(document.documentElement, "root", app);
  set(els.channelView, "channel", channel);
  // Sliders can change the glass's settings: remake its lenses.
  Glass.refresh();
}

export async function loadThemes() {
  state.themes = (await api("GET", "/api/themes")).themes;
}

/*
 * Automatic glass effects: real blur can make scrolling stutter on some
 * phones. In Automatic mode, the first few times you scroll the message
 * list, the page times its frames. Once it has watched STUTTER_SAMPLES
 * frames or STUTTER_WATCH_MS of scrolling (a stuttering phone draws few
 * frames, so time matters too), it judges: if a typical frame took longer
 * than STUTTER_FRAME_MS (fewer than about 35 frames a second), it switches
 * this device to the Lite versions of themes, and says so.
 */
const STUTTER_FRAME_MS = 28;
const STUTTER_SAMPLES = 90;
const STUTTER_WATCH_MS = 2500;
const stutter = { samples: [], watchedMs: 0, sampling: false, done: false };

export function watchForStutter() {
  if (stutter.done || stutter.sampling || effectsMode() !== "auto" || liteEffects()) return;
  // Only worth measuring if a theme with a Lite version is in use.
  const { app, channel } = activeThemes();
  if (!themeInfo(app)?.hasLite && !themeInfo(channel)?.hasLite) return;

  stutter.sampling = true;
  let last = performance.now();
  const stopAt = last + 1000; // sample for a second after scrolling starts
  const frame = (now) => {
    stutter.samples.push(now - last);
    stutter.watchedMs += now - last;
    last = now;
    if (now < stopAt) {
      requestAnimationFrame(frame);
    } else {
      stutter.sampling = false;
      judgeStutter();
    }
  };
  requestAnimationFrame(frame);
}

function judgeStutter() {
  // Keep collecting on later scrolls until there's enough to go on.
  if (stutter.samples.length < STUTTER_SAMPLES && stutter.watchedMs < STUTTER_WATCH_MS) return;
  stutter.done = true;
  const sorted = [...stutter.samples].sort((a, b) => a - b);
  const typicalFrame = sorted[Math.floor(sorted.length / 2)];
  if (typicalFrame > STUTTER_FRAME_MS) {
    writeLocal(AUTO_LITE_KEY, "1");
    applyThemes();
    showNotice("Scrolling was stuttering, so glass effects switched to Lite on this device. You can change this in Appearance.");
  }
}

export function showNotice(text) {
  $("notice-text").textContent = text;
  $("notice").hidden = false;
}

// ------------------------------------------------------------- appearance

export function openAppearance() {
  renderThemeList();
  renderThemeOptions();
  for (const radio of document.querySelectorAll('input[name="effects"]')) radio.checked = radio.value === effectsMode();
  hideFormError($("appearance-dialog"));
  $("appearance-dialog").showModal();
}

/** The theme cards in Appearance. The app theme is the selected one. */
function renderThemeList() {
  const selected = state.settings.appTheme;
  $("theme-list").replaceChildren(
    ...state.themes.map((theme) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(theme.id === selected));

      // The preview: a strip of the theme's colours.
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      for (const colour of theme.swatch.length ? theme.swatch : ["var(--input-bg)"]) {
        const part = document.createElement("span");
        part.style.background = colour;
        swatch.append(part);
      }

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = theme.name;
      const badge = document.createElement("span");
      badge.className = "theme-badge";
      badge.textContent = theme.builtIn ? "Built-in" : "Yours";
      name.append(" ", badge);

      const description = document.createElement("span");
      description.className = "theme-description";
      description.textContent = theme.description;

      card.append(swatch, name, description);
      card.addEventListener("click", () => chooseAppTheme(theme.id));
      return card;
    }),
  );

  // Edit and Delete are only for your own themes.
  const current = themeInfo(selected);
  $("theme-edit").hidden = !current || current.builtIn;
  $("theme-delete").hidden = !current || current.builtIn;
}

async function chooseAppTheme(id) {
  try {
    const { settings } = await api("PUT", "/api/settings", { appTheme: id });
    state.settings = settings;
    renderThemeList();
    renderThemeOptions();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Copy the selected theme into a new theme of your own, and open it in the editor. */
export async function copyTheme() {
  const source = themeInfo(state.settings.appTheme);
  const name = prompt("Name for your theme:", source ? `My ${source.name}` : "My theme");
  if (!name) return;
  try {
    const { theme } = await api("POST", "/api/themes", { name, from: source?.id });
    await loadThemes();
    await chooseAppTheme(theme.id);
    openThemeEditor(theme.id);
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

export async function deleteTheme() {
  const theme = themeInfo(state.settings.appTheme);
  if (!theme || !confirm(`Delete the theme "${theme.name}" and its images? This can't be undone.`)) return;
  try {
    const data = await api("DELETE", `/api/themes/${encodeURIComponent(theme.id)}`, {});
    // Anything that used it has gone back to the default.
    state.settings = data.settings;
    state.channels = data.channels;
    await loadThemes();
    renderThemeList();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/**
 * The sliders in Appearance: the app theme's, and the open channel's theme's
 * if it has its own. Moving one applies at once; letting go saves it.
 */
function renderThemeOptions() {
  const { app, channel } = activeThemes();
  const groups = [];
  const add = (themeId, title) => {
    const values = themeOptionValues(themeId);
    if (values.length === 0 || groups.some((g) => g.themeId === themeId)) return;
    groups.push({ themeId, title, values });
  };
  add(app, themeInfo(app)?.name ?? "App theme");
  if (channel) add(channel, `#${currentChannel()?.name}: ${themeInfo(channel)?.name ?? channel}`);

  const box = $("theme-options");
  box.hidden = groups.length === 0;
  box.replaceChildren(
    ...groups.map(({ themeId, title, values }) => {
      const section = document.createElement("fieldset");
      section.className = "theme-option-group";
      const legend = document.createElement("legend");
      legend.textContent = title;
      section.append(legend);
      for (const { option, value } of values) {
        const row = document.createElement("label");
        row.className = "theme-option";
        const name = document.createElement("span");
        name.className = "theme-option-label";
        name.textContent = option.label;
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = option.min;
        slider.max = option.max;
        slider.step = option.step;
        slider.value = value;
        const shown = document.createElement("output");
        shown.className = "theme-option-value";
        const show = (v) => (shown.textContent = formatOption(option, v));
        show(value);
        slider.addEventListener("input", () => {
          setThemeOption(themeId, option.id, Number(slider.value));
          show(Number(slider.value));
        });
        slider.addEventListener("change", saveThemeOptions);
        row.append(name, slider, shown);
        section.append(row);
      }
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "link-button";
      reset.textContent = "Reset to the theme's defaults";
      reset.addEventListener("click", () => {
        delete state.settings.themeOptions[themeId];
        applyThemeOptions();
        renderThemeOptions();
        saveThemeOptions();
      });
      section.append(reset);
      return section;
    }),
  );
}

/** "55%" for fractions of 1, "14px", or the plain number. */
function formatOption(option, value) {
  if (!option.unit && option.min >= 0 && option.max <= 1) return `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100) / 100}${option.unit}`;
}

/** Change one slider's value locally, and show it straight away. */
function setThemeOption(themeId, optionId, value) {
  const all = (state.settings.themeOptions ??= {});
  all[themeId] = { ...all[themeId], [optionId]: value };
  applyThemeOptions();
}

async function saveThemeOptions() {
  try {
    const { settings } = await api("PUT", "/api/settings", { themeOptions: state.settings.themeOptions ?? {} });
    state.settings = settings;
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

export function chooseEffects(mode) {
  writeLocal(EFFECTS_KEY, mode);
  if (mode === "auto") {
    // Choosing Automatic again starts the stutter check afresh.
    writeLocal(AUTO_LITE_KEY, null);
    Object.assign(stutter, { samples: [], watchedMs: 0, sampling: false, done: false });
  }
  applyThemes();
}

// ----------------------------------------------------------- theme editor

export async function openThemeEditor(id) {
  try {
    const { theme } = await api("GET", `/api/themes/${encodeURIComponent(id)}`);
    state.editingTheme = theme;
    const form = $("theme-editor-form").elements;
    form.name.value = theme.name;
    form.description.value = theme.description;
    form.css.value = theme.css;
    form.liteCss.value = theme.liteCss;
    form.options.value = theme.options.length ? JSON.stringify(theme.options, null, 2) : "";
    renderThemeFiles(theme.files);
    hideFormError($("theme-editor-form"));
    $("theme-editor").showModal();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Save the editor's changes and reload the theme's stylesheets. */
export async function saveTheme(close) {
  const form = $("theme-editor-form").elements;
  try {
    let options;
    try {
      options = form.options.value.trim() ? JSON.parse(form.options.value) : [];
    } catch {
      throw new Error("The sliders must be valid JSON: a list like [{\"id\": ...}].");
    }
    await api("PATCH", `/api/themes/${encodeURIComponent(state.editingTheme.id)}`, {
      name: form.name.value,
      description: form.description.value,
      css: form.css.value,
      liteCss: form.liteCss.value,
      options,
    });
    state.themeVersion++;
    await loadThemes();
    renderThemeList();
    renderThemeOptions();
    renderAll();
    if (close) $("theme-editor").close();
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** The list of images and fonts in the theme being edited. */
function renderThemeFiles(files) {
  const list = $("theme-files");
  if (files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No files yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...files.map((name) => {
      const item = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = name;
      item.append(label, actionButton("Remove", () => removeThemeFile(name)));
      return item;
    }),
  );
}

/** Upload the chosen files into the theme being edited. */
export async function uploadThemeFiles(fileList) {
  const id = state.editingTheme.id;
  for (const file of fileList) {
    try {
      const data = await readAsBase64(file);
      const { files } = await api("POST", `/api/themes/${encodeURIComponent(id)}/files`, { name: file.name, data });
      renderThemeFiles(files);
    } catch (error) {
      showFormError($("theme-editor-form"), `${file.name}: ${error.message}`);
    }
  }
  state.themeVersion++;
  applyThemes();
}

async function removeThemeFile(name) {
  if (!confirm(`Remove ${name} from this theme?`)) return;
  try {
    const { files } = await api(
      "DELETE",
      `/api/themes/${encodeURIComponent(state.editingTheme.id)}/files/${encodeURIComponent(name)}`,
      {},
    );
    renderThemeFiles(files);
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** A file's contents as base64 text (the "data:...;base64," prefix removed). */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}
