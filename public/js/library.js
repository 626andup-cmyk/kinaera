/**
 * The reference library (Notebook → Library): long texts you upload for
 * your friend to search, and reading them yourself.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { badge } from "./format.js";

// ---------------------------------------------------------------- library

/*
 * The reference library (src/library.ts): long texts your friend can
 * search with tools. Here you add, change and delete documents, and try
 * searches yourself to see what your friend would find.
 */

export const library = { docs: [], editing: null, text: null, reading: null, searchTimer: 0 };

export async function openLibrary() {
  hideFormError($("library-dialog"));
  $("library-search").value = "";
  $("library-results").replaceChildren();
  await refreshLibrary();
  $("library-dialog").showModal();
}

async function refreshLibrary() {
  try {
    library.docs = (await api("GET", "/api/library")).documents;
    renderLibrary();
  } catch (error) {
    showFormError($("library-dialog"), error.message);
  }
}

/** "12 KB", "1.4 MB". */
function formatSize(chars) {
  return chars < 1_000_000 ? `${Math.max(1, Math.round(chars / 1000))} KB` : `${(chars / 1_000_000).toFixed(1)} MB`;
}

function renderLibrary() {
  const list = $("library-list");
  if (library.docs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing here yet. Add a script, a book or a wiki page as a text file.";
    list.replaceChildren(empty);
    return;
  }
  const channelName = (id) => state.channels.find((c) => c.id === id)?.name;
  list.replaceChildren(
    ...library.docs.map((doc) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "library-doc";
      const name = document.createElement("span");
      name.className = "notebook-entry-name";
      name.textContent = doc.title;
      const badges = document.createElement("span");
      badges.className = "notebook-entry-badges";
      const where = doc.channelIds.map(channelName).filter(Boolean);
      badges.append(
        badge(`${doc.passages} passage${doc.passages === 1 ? "" : "s"}`),
        badge(formatSize(doc.chars)),
        badge(where.length ? where.map((n) => `#${n}`).join(", ") : "everywhere"),
      );
      button.append(name, badges);
      if (doc.description) {
        const description = document.createElement("span");
        description.className = "hint";
        description.textContent = doc.description;
        button.append(description);
      }
      button.addEventListener("click", () => openLibraryDoc(doc));
      item.append(button);
      return item;
    }),
  );
}

/** Add a document (no `doc`), or change one. */
export function openLibraryDoc(doc = null) {
  const dialog = $("library-doc-dialog");
  hideFormError(dialog);
  library.editing = doc;
  library.text = null;
  $("library-doc-title").textContent = doc ? "Document" : "Add a document";
  $("library-file-row").hidden = Boolean(doc);
  $("library-file").value = "";
  $("library-file-note").textContent = "A text file (.txt, .md, .fountain, .json…). Save a PDF or Word script as text first.";
  $("library-doc-name").value = doc?.title ?? "";
  $("library-doc-description").value = doc?.description ?? "";
  $("library-doc-delete").hidden = !doc;
  $("library-doc-save").textContent = doc ? "Save" : "Add";
  $("library-doc-channels").replaceChildren(
    ...state.channels.map((channel) => {
      const label = document.createElement("label");
      label.className = "check-inline";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = channel.id;
      box.checked = channel.kind === "ooc" || (doc?.channelIds.includes(channel.id) ?? false);
      box.disabled = channel.kind === "ooc";
      label.append(box, `#${channel.name}${channel.kind === "ooc" ? " (always)" : ""}`);
      return label;
    }),
  );
  dialog.showModal();
}

export async function readLibraryFile() {
  const file = $("library-file").files[0];
  library.text = null;
  if (!file) return;
  const note = $("library-file-note");
  try {
    const raw = await file.text();
    if (raw.includes("\u0000")) throw new Error("That doesn't look like a text file. Save it as plain text (.txt) first.");
    // A JSON file (a scraped script, transcripts…): keep the words, not the wrapping.
    const fromJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(raw) ? jsonText(raw) : null;
    const text = fromJson ?? raw;
    if (!text.trim()) throw new Error("There's no readable text in that file.");
    library.text = text;
    if (!$("library-doc-name").value.trim()) $("library-doc-name").value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    const passages = Math.max(1, Math.round(text.length / 1500));
    note.textContent = fromJson
      ? `${file.name}: ${formatSize(raw.length)} of JSON, ${formatSize(text.length)} of text kept, about ${passages} passage${passages === 1 ? "" : "s"}.`
      : `${file.name}: ${formatSize(text.length)}, about ${passages} passage${passages === 1 ? "" : "s"}.`;
  } catch (error) {
    note.textContent = error.message;
  }
}

// ------------------------------------------------------------- JSON files

/** Fields that hold the words, and fields that say who's speaking, in common script and transcript formats. */
const TEXT_KEYS = ["text", "line", "lines", "dialogue", "dialog", "content", "body", "action", "description", "value", "transcript", "words"];
const SPEAKER_KEYS = ["character", "speaker", "name", "who", "role", "char"];

/** A string worth keeping: words, not ids, links, dates or numbers. */
function looksLikeText(s) {
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^(https?:|www\.|data:|\/)/i.test(t)) return false;
  if (/^[\w-]{16,}$/.test(t) && !/\s/.test(t)) return false; // an id or hash
  if (/^[\d\s.:,/+-]+(t[\d:.]+z?)?$/i.test(t)) return false; // numbers, times, dates
  return true;
}

/**
 * The readable text in a JSON file, in order: each object's words (with
 * who says them, when it says so), and any other text in it. Returns null
 * if it isn't JSON after all.
 */
export function jsonText(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const out = [];
  const walk = (value) => {
    if (typeof value === "string") {
      if (looksLikeText(value)) out.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      const keys = Object.keys(value);
      const textKey = keys.find((k) => TEXT_KEYS.includes(k.toLowerCase()) && typeof value[k] === "string");
      const speakerKey = keys.find((k) => SPEAKER_KEYS.includes(k.toLowerCase()) && typeof value[k] === "string" && value[k].length <= 40);
      if (textKey && looksLikeText(value[textKey])) {
        const words = value[textKey].trim();
        out.push(speakerKey && speakerKey !== textKey ? `${value[speakerKey].trim().toUpperCase()}: ${words}` : words);
      }
      // Nested parts (scenes, lines…), but not the fields already used, nor other loose labels.
      for (const k of keys) {
        if (k === textKey || k === speakerKey) continue;
        if (typeof value[k] === "object" && value[k] !== null) walk(value[k]);
        else if (!textKey && typeof value[k] === "string" && value[k].trim().includes(" ")) walk(value[k]);
      }
    }
  };
  walk(data);
  return out.join("\n");
}

export async function saveLibraryDoc(event) {
  event.preventDefault();
  const dialog = $("library-doc-dialog");
  const body = {
    title: $("library-doc-name").value,
    description: $("library-doc-description").value,
    channelIds: [...$("library-doc-channels").querySelectorAll("input:checked:not(:disabled)")].map((box) => box.value),
  };
  const save = $("library-doc-save");
  try {
    save.disabled = true;
    if (library.editing) {
      await api("PATCH", `/api/library/${encodeURIComponent(library.editing.id)}`, body);
    } else {
      if (!library.text) throw new Error("Choose a text file first.");
      save.textContent = "Adding…";
      await api("POST", "/api/library", { ...body, content: library.text });
    }
    dialog.close();
    await refreshLibrary();
  } catch (error) {
    showFormError(dialog, error.message);
  } finally {
    save.disabled = false;
    save.textContent = library.editing ? "Save" : "Add";
  }
}

export async function deleteLibraryDoc() {
  const doc = library.editing;
  if (!doc || !confirm(`Delete "${doc.title}" from the library?`)) return;
  try {
    await api("DELETE", `/api/library/${encodeURIComponent(doc.id)}`, {});
    $("library-doc-dialog").close();
    await refreshLibrary();
  } catch (error) {
    showFormError($("library-doc-dialog"), error.message);
  }
}

/** A snippet from the server, with its matches («like this») highlighted. */
function snippetNode(text) {
  const node = document.createElement("span");
  node.className = "library-snippet";
  for (const [i, part] of text.split(/[«»]/).entries()) {
    if (i % 2) {
      const mark = document.createElement("mark");
      mark.textContent = part;
      node.append(mark);
    } else {
      node.append(part);
    }
  }
  return node;
}

export async function searchLibrary() {
  const query = $("library-search").value.trim();
  const list = $("library-results");
  if (!query) {
    list.replaceChildren();
    return;
  }
  try {
    const { results } = await api("GET", `/api/library/search?q=${encodeURIComponent(query)}`);
    if (query !== $("library-search").value.trim()) return; // typed more since
    if (results.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = "Nothing matches.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...results.map((hit) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "library-hit";
        const where = document.createElement("span");
        where.className = "library-hit-where";
        where.textContent = `${hit.title} · passage ${hit.seq}${hit.heading ? ` · ${hit.heading}` : ""}`;
        button.append(where, snippetNode(hit.snippet));
        button.addEventListener("click", () => openPassage(hit.docId, hit.seq));
        item.append(button);
        return item;
      }),
    );
  } catch (error) {
    showFormError($("library-dialog"), error.message);
  }
}

export async function openPassage(docId, seq) {
  try {
    const { document: doc, passages } = await api("GET", `/api/library/${encodeURIComponent(docId)}/passages/${seq}`);
    const passage = passages[0];
    if (!passage) return;
    library.reading = { doc, seq };
    $("library-read-title").textContent = doc.title;
    $("library-read-where").textContent = `Passage ${seq} of ${doc.passages}${passage.heading ? ` · ${passage.heading}` : ""}`;
    $("library-read-text").textContent = passage.content;
    $("library-read-prev").disabled = seq <= 1;
    $("library-read-next").disabled = seq >= doc.passages;
    $("library-read-text").scrollTop = 0;
    if (!$("library-read-dialog").open) $("library-read-dialog").showModal();
  } catch (error) {
    showFormError($("library-dialog"), error.message);
  }
}
