/**
 * The notebook: characters and lore, the entry editor, folders, and each
 * channel's cast.
 *
 * The server decides what you can see and do with each entry (see
 * src/permissions.ts) and says so in `entry.access`; the app only uses that
 * to show the right buttons.
 */

import { renderAll } from "./channels.js";
import { canHavePrefix } from "./composer.js";
import { $, api, channelPath, currentChannel, els, hideFormError, showFormError, state } from "./core.js";
import { badge, hueFor, initial } from "./format.js";
import { openInbox, renderInbox } from "./inbox.js";
import { updateChannelInState } from "./messages.js";

// --------------------------------------------------------------- notebook

/*
 * The notebook holds characters and lore, yours, your friend's and shared
 * ones. The server decides what you can see and do with each entry (see
 * src/permissions.ts) and says so in `entry.access`; the app only uses that
 * to show the right buttons. Pinning an entry to a channel puts it in that
 * channel's cast.
 */

/** Fetch the notebook from the server. */
export async function loadNotebook() {
  state.notebook = await api("GET", "/api/notebook");
}

/**
 * Reload the notebook and the channels (whose casts show entry names), then
 * redraw whatever's open. Called after any change to the notebook.
 */
export async function refreshNotebook() {
  const [notebook, { channels, proposals }] = await Promise.all([api("GET", "/api/notebook"), api("GET", "/api/state")]);
  state.notebook = notebook;
  state.channels = channels;
  state.proposals = proposals;
  renderAll();
  if ($("notebook-dialog").open) renderNotebook();
  if (els.channelDialog.open) renderCastEditor();
  if ($("inbox-dialog").open) renderInbox();
}

/** An entry by id, if you can see it. */
export function findEntry(id) {
  return state.notebook.entries.find((e) => e.id === id);
}

/** "Arlo's", "yours" or "shared": whose an entry is, for badges. */
export function ownerLabel(owner) {
  if (owner === "user") return "yours";
  if (owner === "joint") return "shared";
  return `${state.settings.friendName}'s`;
}

/** Short badges for an entry in lists: its kind, owner, and what's special about it. */
function entryBadges(entry) {
  const friend = state.settings.friendName;
  const badges = [entry.kind === "lore" ? "lore" : "character", ownerLabel(entry.owner)];
  if (entry.owner === "user") {
    if (entry.settings.visibility === "hidden") badges.push(`hidden from ${friend}`);
    if (entry.settings.editing === "suggest") badges.push(`${friend} suggests`);
    if (entry.settings.editing === "locked") badges.push("locked");
    if (entry.proxyPrefix) badges.push(`${entry.proxyPrefix}:`);
  } else if (entry.owner === "joint") {
    if (entry.proxyPrefix) badges.push(`${entry.proxyPrefix}:`);
  } else if (entry.owner === "friend") {
    if (entry.access.edit === "suggest") badges.push("you suggest");
    if (entry.access.edit === "none") badges.push("read only");
  }
  return badges;
}

/** A small round avatar in a character's colour (a book mark for lore). */
export function entryAvatar(name, kind) {
  const avatar = document.createElement("span");
  avatar.className = "avatar entry-avatar";
  avatar.dataset.kind = kind;
  avatar.style.setProperty("--avatar-hue", hueFor(name));
  avatar.textContent = kind === "lore" ? "§" : initial(name);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

export function openNotebook() {
  hideFormError($("notebook-dialog"));
  renderNotebook();
  $("notebook-dialog").showModal();
  // Get the latest (your friend may change it, from stage 6).
  refreshNotebook().catch((error) => showFormError($("notebook-dialog"), error.message));
}

/** Draw the notebook dialog: suggestions waiting, then entries by folder. */
function renderNotebook() {
  renderSuggestions();

  const { folders, entries } = state.notebook;
  const folderIds = new Set(folders.map((f) => f.id));
  const groups = [
    { folder: null, entries: entries.filter((e) => !e.folderId || !folderIds.has(e.folderId)) },
    ...folders.map((folder) => ({ folder, entries: entries.filter((e) => e.folderId === folder.id) })),
  ];

  const list = $("notebook-list");
  if (entries.length === 0 && folders.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty notebook-empty";
    empty.textContent = "The notebook is empty. Add a character to start a cast.";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...groups
      .filter((group) => group.folder || group.entries.length > 0)
      .map(({ folder, entries }) => {
        const section = document.createElement("section");
        section.className = "notebook-folder";
        if (folder) {
          const header = document.createElement("header");
          header.className = "notebook-folder-header";
          const name = document.createElement("span");
          name.className = "notebook-folder-name";
          name.textContent = folder.name;
          header.append(name);
          if (folder.owner !== "user") header.append(badge(ownerLabel(folder.owner)));
          if (folder.visibility === "hidden") header.append(badge(`hidden from ${state.settings.friendName}`));
          if (folder.owner === "user") {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "link-button";
            edit.textContent = "Edit folder";
            edit.addEventListener("click", () => openFolder(folder));
            header.append(edit);
          }
          section.append(header);
        }

        const items = document.createElement("ul");
        items.className = "notebook-entries";
        for (const entry of entries) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "notebook-entry";
          button.dataset.kind = entry.kind;
          button.dataset.owner = entry.owner;
          const name = document.createElement("span");
          name.className = "notebook-entry-name";
          name.textContent = entry.name;
          const badges = document.createElement("span");
          badges.className = "notebook-entry-badges";
          badges.append(...entryBadges(entry).map(badge));
          if (entry.pinnedIn.includes(state.channelId) && currentChannel()) {
            badges.append(badge(`in #${currentChannel().name}`));
          }
          button.append(entryAvatar(entry.name, entry.kind), name, badges);
          button.addEventListener("click", () => openEntry(entry));
          item.append(button);
          items.append(item);
        }
        if (entries.length === 0) {
          const empty = document.createElement("li");
          empty.className = "hint";
          empty.textContent = "Empty. Move entries here from their settings.";
          items.append(empty);
        }
        section.append(items);
        return section;
      }),
  );
}

/**
 * Suggested changes still waiting are in the inbox; the notebook just says
 * how many, with a button to open it.
 */
function renderSuggestions() {
  const box = $("suggestion-list");
  const count = state.notebook.suggestions.length;
  box.hidden = count === 0;
  if (box.hidden) return;
  const text = document.createElement("span");
  text.className = "suggestion-text";
  text.textContent = `${count} suggested change${count === 1 ? " is" : "s are"} waiting.`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "link-button inline-link";
  open.textContent = "Open the inbox";
  open.addEventListener("click", openInbox);
  box.replaceChildren(text, open);
}

// ------------------------------------------------------ the entry editor

/**
 * Open an entry in the editor, or start a new one.
 *
 * @param entry  An entry from `state.notebook.entries`, or `{kind}` for a new one.
 * @param pinTo  For a new entry: a channel to pin it to once it's made.
 */
export function openEntry(entry, pinTo = null) {
  const isNew = !entry.id;
  if (isNew) {
    entry = {
      kind: entry.kind,
      name: "",
      fields: state.notebook.templates[entry.kind].map((label) => ({ label, value: "" })),
      systemPrompt: "",
      proxyPrefix: null,
      folderId: null,
      owner: entry.owner ?? "user",
      visibility: null,
      editing: null,
      settings: { owner: "user", visibility: "visible", editing: "open" },
      access: { edit: "direct", settings: true, delete: false },
      pinnedIn: [],
    };
  }
  state.editingEntry = { ...entry, isNew, pinTo };

  const form = $("entry-form");
  const fields = form.elements;
  hideFormError(form);
  const kindName = entry.kind === "lore" ? "lore" : "character";
  $("entry-title").textContent = isNew ? `New ${kindName}` : entry.name;
  fields.name.value = entry.name;
  fields.systemPrompt.value = entry.systemPrompt;
  fields.proxyPrefix.value = entry.proxyPrefix ?? "";
  renderEntryFields(entry.fields);

  // Contents: editable unless the entry is locked to you.
  const readOnly = entry.access.edit === "none";
  for (const input of [fields.name, fields.systemPrompt, fields.proxyPrefix]) input.readOnly = readOnly;
  $("entry-add-field").hidden = readOnly;

  // Settings: only the owner can change them.
  renderEntrySettings(entry);
  $("entry-settings").disabled = !entry.access.settings;

  $("entry-access").textContent = accessNote(entry, isNew);
  const save = $("entry-save");
  save.hidden = readOnly && !entry.access.settings;
  save.textContent = isNew ? "Create" : entry.access.edit === "suggest" && !entry.access.settings ? "Suggest changes" : "Save";

  const del = $("entry-delete");
  // Your own entries are deleted; deleting anything else is a suggestion.
  del.hidden = isNew;
  del.textContent = entry.access.delete ? "Delete" : "Suggest deleting";

  renderEntryPin();
  renderEntryLinks();
  updateEntryForm();
  $("entry-dialog").showModal();
  // Sized once the dialog is showing, when the boxes have a width.
  for (const box of $("entry-fields").querySelectorAll(".entry-field-value")) fitToText(box);
}

/** Grow a text box to show all its text, up to about 12 lines (then it scrolls). */
export function fitToText(box) {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight + 2, 300)}px`;
}

/** The line under the entry's title: whose it is, and what you can do with it. */
function accessNote(entry, isNew) {
  const friend = state.settings.friendName;
  if (isNew) return `Pick who owns it below: you, ${friend}, or both of you (shared).`;
  if (entry.owner === "joint") {
    const play = entry.kind === "character" ? " Either of you can play them, and the proxy prefix is yours to set." : "";
    return `Shared by both of you. Changes are suggestions, for the other one to accept.${play}`;
  }
  if (entry.owner === "user") {
    return entry.kind === "character" ? "Your character: you play them." : "Your lore.";
  }
  const whose = entry.kind === "character" ? `${friend}'s character: they play them.` : `${friend}'s lore.`;
  if (entry.access.edit === "direct") return `${whose} You can edit it.`;
  if (entry.access.edit === "suggest") return `${whose} Your changes are sent to ${friend} as suggestions.`;
  return `${whose} Only ${friend} can change it.`;
}

/** The labelled fields, one row each: label, value, and a remove button. */
export function renderEntryFields(fields) {
  const readOnly = state.editingEntry.access.edit === "none";
  $("entry-fields").replaceChildren(
    ...fields.map((field) => {
      const row = document.createElement("div");
      row.className = "entry-field";
      const label = document.createElement("input");
      label.className = "entry-field-label";
      label.value = field.label;
      label.placeholder = "Label";
      label.setAttribute("aria-label", "Field label");
      const value = document.createElement("textarea");
      value.className = "entry-field-value";
      value.value = field.value;
      value.rows = 1;
      value.setAttribute("aria-label", field.label || "Field value");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button entry-field-remove";
      remove.textContent = "✕";
      remove.title = "Remove this field";
      remove.setAttribute("aria-label", "Remove this field");
      remove.addEventListener("click", () => {
        row.remove();
        renderEntryLinks();
      });
      label.readOnly = value.readOnly = readOnly;
      remove.hidden = readOnly;
      row.append(label, value, remove);
      return row;
    }),
  );
}

/**
 * The fields as typed in the editor. Rows with no label are skipped, unless
 * `keepBlank` (for redrawing the editor without losing a half-typed row).
 */
export function readEntryFields(keepBlank = false) {
  return [...$("entry-fields").querySelectorAll(".entry-field")]
    .map((row) => ({
      label: row.querySelector(".entry-field-label").value.trim(),
      value: row.querySelector(".entry-field-value").value,
    }))
    .filter((field) => keepBlank || field.label !== "");
}

/** Fill the settings selects for an entry. */
function renderEntrySettings(entry) {
  const friend = state.settings.friendName;
  const fields = $("entry-form").elements;
  fields.owner.replaceChildren(
    new Option("You", "user"),
    new Option(friend, "friend"),
    new Option("Shared (both of you)", "joint"),
  );
  fields.owner.value = entry.owner;
  fields.folderId.replaceChildren(
    new Option("No folder", ""),
    ...state.notebook.folders.map((f) => new Option(f.name, f.id)),
  );
  fields.folderId.value = entry.folderId ?? "";
  fillEntrySettingChoices(entry.visibility, entry.editing);
}

/**
 * The visibility and editing choices depend on the owner (hidden from
 * whom?) and the folder (what "the folder's setting" means), so they're
 * redrawn when either changes. Keeps the current choice.
 */
export function fillEntrySettingChoices(visibility, editing) {
  const fields = $("entry-form").elements;
  const owner = fields.owner.value;
  const folder = state.notebook.folders.find((f) => f.id === fields.folderId.value);
  const other = owner === "friend" ? "you" : state.settings.friendName;

  const visibilityNames = { visible: "Visible to both", hidden: `Hidden from ${other}` };
  const editingNames = { open: "Edit it", suggest: "Suggest changes", locked: "Only read it" };
  fields.visibility.replaceChildren(
    new Option(`Folder's setting (${visibilityNames[folder?.visibility ?? "visible"].toLowerCase()})`, ""),
    new Option(visibilityNames.visible, "visible"),
    new Option(visibilityNames.hidden, "hidden"),
  );
  fields.editing.replaceChildren(
    new Option(`Folder's setting (${editingNames[folder?.editing ?? "open"].toLowerCase()})`, ""),
    new Option(editingNames.open, "open"),
    new Option(editingNames.suggest, "suggest"),
    new Option(editingNames.locked, "locked"),
  );
  fields.visibility.value = visibility ?? "";
  fields.editing.value = editing ?? "";
  $("entry-editing-label").textContent = owner === "friend" ? "You can" : `${state.settings.friendName} can`;
}

/**
 * Keep the form consistent with the chosen owner: shared lore is always
 * visible and suggest-only, and only your characters have a proxy prefix.
 */
export function updateEntryForm() {
  const entry = state.editingEntry;
  const fields = $("entry-form").elements;
  const owner = fields.owner.value;
  const fixed = owner === "joint" || (entry.isNew && owner === "friend");
  fields.visibility.disabled = fields.editing.disabled = fixed;
  $("entry-prefix-row").hidden = !canHavePrefix(entry.kind, owner);
}

/** The pin button: pin to, or unpin from, the open roleplay channel. */
function renderEntryPin() {
  const entry = state.editingEntry;
  const channel = currentChannel();
  const button = $("entry-pin");
  button.hidden = entry.isNew || !channel || channel.kind !== "rp";
  if (button.hidden) return;
  button.textContent = entry.pinnedIn.includes(channel.id) ? `Unpin from #${channel.name}` : `Pin to #${channel.name}`;
}

export async function toggleEntryPin() {
  const entry = state.editingEntry;
  const channel = currentChannel();
  const pinned = entry.pinnedIn.includes(channel.id);
  try {
    await api(pinned ? "DELETE" : "PUT", channelPath(`cast/${encodeURIComponent(entry.id)}`, channel.id), {});
    await refreshNotebook();
    state.editingEntry = { ...state.editingEntry, pinnedIn: findEntry(entry.id)?.pinnedIn ?? [] };
    renderEntryPin();
  } catch (error) {
    showFormError($("entry-form"), error.message);
  }
}

/**
 * Under the text: the entries it links to with [[Name]], as buttons that
 * open them. Links to names that aren't in the notebook are listed too, so
 * a typo shows.
 */
export function renderEntryLinks() {
  const text = [$("entry-form").elements.systemPrompt.value, ...readEntryFields().map((f) => f.value)].join("\n");
  const names = [...new Set([...text.matchAll(/\[\[([^\]|\n]{1,100})(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim()))];
  const box = $("entry-links");
  box.hidden = names.length === 0;
  if (box.hidden) return;

  const label = document.createElement("span");
  label.className = "entry-links-label";
  label.textContent = "Links to:";
  box.replaceChildren(
    label,
    ...names.map((name) => {
      const target = state.notebook.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (!target) {
        const missing = document.createElement("span");
        missing.className = "entry-link missing";
        missing.textContent = name;
        missing.title = "Nothing in the notebook has this name";
        return missing;
      }
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link-button entry-link";
      link.textContent = target.name;
      link.addEventListener("click", () => {
        $("entry-dialog").close();
        openEntry(target);
      });
      return link;
    }),
  );
}

/** Save the entry editor: create, edit (or suggest), and change settings. */
export async function saveEntry(event) {
  event.preventDefault();
  const entry = state.editingEntry;
  const form = $("entry-form");
  const fields = form.elements;
  const owner = fields.owner.value;
  const contents = {
    name: fields.name.value,
    fields: readEntryFields(),
    systemPrompt: fields.systemPrompt.value,
  };
  const prefix = canHavePrefix(entry.kind, owner) ? fields.proxyPrefix.value.trim() || null : null;
  // Shared lore's settings are fixed, and only an entry's owner picks them.
  const settings = {
    owner,
    folderId: fields.folderId.value || null,
    visibility: fields.visibility.disabled ? null : fields.visibility.value || null,
    editing: fields.editing.disabled ? null : fields.editing.value || null,
  };

  try {
    if (entry.isNew) {
      const { entry: created } = await api("POST", "/api/notebook/entries", {
        kind: entry.kind,
        ...contents,
        proxyPrefix: prefix,
        ...settings,
      });
      if (entry.pinTo) await api("PUT", channelPath(`cast/${encodeURIComponent(created.id)}`, entry.pinTo), {});
    } else {
      // Send only what changed, so a suggestion says exactly what you suggest.
      const changes = {};
      if (contents.name !== entry.name) changes.name = contents.name;
      if (JSON.stringify(contents.fields) !== JSON.stringify(entry.fields)) changes.fields = contents.fields;
      if (contents.systemPrompt !== entry.systemPrompt) changes.systemPrompt = contents.systemPrompt;
      if (canHavePrefix(entry.kind, entry.owner) && prefix !== entry.proxyPrefix) changes.proxyPrefix = prefix;
      if (Object.keys(changes).length > 0 && entry.access.edit !== "none") {
        await api("PATCH", `/api/notebook/entries/${encodeURIComponent(entry.id)}`, changes);
      }
      const settingsChanged =
        settings.owner !== entry.owner ||
        settings.folderId !== entry.folderId ||
        settings.visibility !== entry.visibility ||
        settings.editing !== entry.editing;
      if (settingsChanged && entry.access.settings) {
        await api("PUT", `/api/notebook/entries/${encodeURIComponent(entry.id)}/settings`, settings);
      }
    }
    $("entry-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError(form, error.message);
  }
}

/** Delete an entry, or suggest deleting it when it isn't yours to delete. */
export async function deleteEntry() {
  const entry = state.editingEntry;
  const question = entry.access.delete
    ? `Delete ${entry.name}? It's unpinned from every channel. This can't be undone.`
    : `Suggest deleting ${entry.name}? It stays until the suggestion is accepted.`;
  if (!confirm(question)) return;
  try {
    await api("DELETE", `/api/notebook/entries/${encodeURIComponent(entry.id)}`, {});
    $("entry-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError($("entry-form"), error.message);
  }
}

// ------------------------------------------------------------- folders

export function openFolder(folder = null) {
  state.editingFolder = folder;
  const form = $("folder-form");
  hideFormError(form);
  $("folder-title").textContent = folder ? "Edit folder" : "New folder";
  form.elements.name.value = folder?.name ?? "";
  form.elements.visibility.value = folder?.visibility ?? "visible";
  form.elements.editing.value = folder?.editing ?? "open";
  $("folder-delete").hidden = !folder;
  $("folder-dialog").showModal();
}

export async function saveFolder(event) {
  event.preventDefault();
  const form = $("folder-form");
  const body = {
    name: form.elements.name.value,
    visibility: form.elements.visibility.value,
    editing: form.elements.editing.value,
  };
  try {
    const folder = state.editingFolder;
    if (folder) await api("PATCH", `/api/notebook/folders/${encodeURIComponent(folder.id)}`, body);
    else await api("POST", "/api/notebook/folders", body);
    $("folder-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError(form, error.message);
  }
}

export async function deleteFolder() {
  const folder = state.editingFolder;
  if (!confirm(`Delete the folder "${folder.name}"? The entries in it are kept, outside any folder.`)) return;
  try {
    await api("DELETE", `/api/notebook/folders/${encodeURIComponent(folder.id)}`, {});
    $("folder-dialog").close();
    await refreshNotebook();
  } catch (error) {
    showFormError($("folder-form"), error.message);
  }
}

// ---------------------------------------------------------------- cast

/**
 * The cast in channel settings: who's pinned, with a button to unpin each,
 * and a menu to pin more from the notebook (or make a new entry).
 */
export function renderCastEditor() {
  const channel = currentChannel();
  if (!channel || channel.kind !== "rp") return;
  const friend = state.settings.friendName;

  const list = $("cast-list");
  list.replaceChildren(
    ...channel.cast.map((member) => {
      const item = document.createElement("li");
      item.className = "cast-member";
      item.dataset.playedBy = member.playedBy;
      item.dataset.kind = member.kind;
      if (member.hidden) item.classList.add("hidden-entry");

      const name = document.createElement(member.hidden ? "span" : "button");
      name.className = member.hidden ? "cast-member-name" : "link-button cast-member-name";
      name.textContent = member.name;
      if (!member.hidden) {
        name.type = "button";
        name.addEventListener("click", () => {
          const entry = findEntry(member.entryId);
          if (entry) openEntry(entry);
        });
      }

      const roles = { user: "you play", friend: `${friend} plays`, both: "you both play" };
      const role = member.kind === "lore" ? "lore" : roles[member.playedBy];
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.className = "link-button cast-unpin";
      unpin.textContent = "Unpin";
      unpin.addEventListener("click", () => changeCast(member.entryId, false));
      item.append(entryAvatar(member.hidden ? "?" : member.name, member.kind), name, badge(role), unpin);
      return item;
    }),
  );
  if (channel.cast.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = `Nobody yet. Without a cast, ${friend} narrates.`;
    list.append(empty);
  }

  // Everything you can see that isn't pinned yet, characters first.
  const pinned = new Set(channel.cast.map((c) => c.entryId));
  const unpinned = state.notebook.entries.filter((e) => !pinned.has(e.id));
  const group = (label, kind) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    optgroup.append(...unpinned.filter((e) => e.kind === kind).map((e) => new Option(`${e.name} (${ownerLabel(e.owner)})`, e.id)));
    return optgroup;
  };
  const make = document.createElement("optgroup");
  make.label = "New";
  make.append(new Option("New character…", "new:character"), new Option("New lore…", "new:lore"));
  $("cast-add").replaceChildren(new Option("Add to the cast…", ""), group("Characters", "character"), group("Lore", "lore"), make);
}

/** Pin (`true`) or unpin (`false`) an entry in the open channel, straight away. */
export async function changeCast(entryId, pin) {
  try {
    const { channel } = await api(pin ? "PUT" : "DELETE", channelPath(`cast/${encodeURIComponent(entryId)}`), {});
    updateChannelInState(channel);
    await loadNotebook(); // each entry lists where it's pinned
    renderAll();
    renderCastEditor();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}
