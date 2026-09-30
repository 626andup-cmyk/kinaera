/**
 * Your friend's tools (stage 6): how they act, not just write.
 *
 * Each tool is a name, a description the model reads, a JSON schema for its
 * arguments, and a `run` function. The model asks for a tool; `runTool`
 * checks the arguments, runs it *as your friend* (so every notebook
 * permission applies, exactly as in src/permissions.ts), and returns:
 *
 *   - `result`: what the model is told, as JSON. Errors are results too
 *     ("No notebook entry called ..."), so the model can correct itself.
 *   - `summary`: a short line for people, shown under the message and in
 *     the tool log ("pinned Tamsin to #story").
 *
 * Things refer to each other by name, the way the model sees them: entries
 * by name, channels by `#name`, and comment threads and suggestions by the
 * short ids shown in the prompt. Your friend deletes only their own
 * notebook entries; deleting anything else is a suggestion, and deleting a
 * channel is a proposal you approve or deny.
 *
 * "Do nothing" is always an option, and usually the right one.
 */

import { CHECK_SOURCES, DEFAULT_SOURCES, runCheck, type CheckSource } from "./check.ts";
import { NotFoundError, PermissionError, ValidationError } from "./errors.ts";
import { friendCharacterNames, pickProfile, profileRequest, promptManifest } from "./friend.ts";
import { replyToMessages } from "./posts.ts";
import { localTime } from "./schedule.ts";
import { draftId } from "./drafts.ts";
import { MIRROR_DEFAULT, MIRROR_MAX, readPatterns } from "./mirror.ts";
import { roll } from "./dice.ts";
import { queueOrientation } from "./orientation.ts";
import { VERBATIM_SLOTS } from "./verbatim.ts";
import { ASK_KIND_NAMES, ASK_KINDS, type AskKind } from "./inbox.ts";
import type { Decider } from "./jev.ts";
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { plainLinks } from "./prompt.ts";
import { wording } from "./wording.ts";
import type { LibraryDoc } from "./library.ts";
import type { EntryView } from "./notebook.ts";
import type { ToolSpec } from "./nanogpt.ts";
import type { Store } from "./store.ts";
import { channelSummaryText } from "./summaries.ts";
import type { Channel, EntryField, Message, Owner } from "./types.ts";
import type { Peer } from "./config.ts";

/** Where a tool runs: the channel of the turn, and what kind of turn. */
export interface ToolContext {
  store: Store;
  channel: Channel;
  /** `"post"` for a normal turn; `"comment"` when replying to a comment thread. */
  mode: "post" | "comment";
  /** Jev, for `check`. Without it, a check returns the passages and no reading. */
  decider?: Decider;
  /** The API, for `consult`. Without it, `consult` isn't offered. */
  api?: ApiOptions;
  /** Counts for this turn, for its limits (one `consult` per turn, one post per other channel). */
  turn?: { consults: number; postedIn?: string[]; replyTo?: string };
  /** Why this turn is happening, if it's a turn of their own (asks in an orientation are marked). */
  wake?: string;
  /** The model writing this turn, for messages posted in other channels. */
  model?: string;
  profileName?: string;
  /** The profile writing this turn (for write_profile_note). */
  profileId?: string;
  /** The other friends on their server (names only), from the hub. */
  peers?: Peer[];
  /** Whether your friend is already writing in a channel (another turn). */
  isBusy?: (channelId: string) => boolean;
  /** Told about messages posted in another channel (a phone notification, if the app isn't open). */
  onPosted?: (channel: Channel, messages: Message[]) => void;
}

/** What running a tool produced. */
export interface ToolOutcome {
  ok: boolean;
  /** Sent back to the model. */
  result: unknown;
  /**
   * What the tool log keeps instead of `result`, when they differ: text
   * from private places (the journal, drafts) is never logged.
   */
  logResult?: unknown;
  /** For people. For errors, the error. */
  summary: string;
  /** `do_nothing`: end the turn without writing. */
  stop?: boolean;
}

/** What a tool's `run` returns. */
type ToolRun = Omit<ToolOutcome, "ok"> & { ok?: boolean };

/** A mistake in how the model used a tool, explained to it. */
class ToolError extends Error {}

interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Whether the tool is offered in this context (default: always). */
  available?: (ctx: ToolContext) => boolean;
  /**
   * Private (the journal): the tool log keeps that it was used, never its
   * arguments or result, and its summary never quotes what it says.
   */
  private?: boolean;
  run: (ctx: ToolContext, args: Record<string, unknown>) => ToolRun | Promise<ToolRun>;
}

// ------------------------------------------------------------------ helpers

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });

/** A required text argument. */
function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`"${key}" is required, as text.`);
  return value.trim();
}

/** An optional text argument. */
function maybe(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be text.`);
  return value.trim();
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Find an entry your friend can see by name: exact (ignoring case) first,
 * then a unique partial match. Otherwise explain, listing names.
 */
function findEntry(ctx: Pick<ToolContext, "store" | "channel">, name: string): EntryView {
  // Practice notes are only found from the practice channel.
  const entries = ctx.store.notebook.listEntries("friend", ctx.channel.kind === "practice");
  const wanted = norm(name.replace(/^\[\[|\]\]$/g, ""));
  const exact = entries.find((e) => norm(e.name) === wanted);
  if (exact) return exact;
  const partial = entries.filter((e) => norm(e.name).includes(wanted) || wanted.includes(norm(e.name)));
  if (partial.length === 1) return partial[0]!;
  const names = (partial.length > 1 ? partial : entries).map((e) => e.name).slice(0, 40);
  throw new ToolError(
    partial.length > 1
      ? `"${name}" matches several entries: ${names.join(", ")}. Use the full name.`
      : `There's no notebook entry called "${name}". Entries: ${names.join(", ") || "(none)"}.`,
  );
}

/** Find a channel by name (`#story` or `story`); empty or "here" is the current one. */
function findChannel(ctx: ToolContext, name: string | undefined): Channel {
  if (!name || ["here", "this", "this channel", "current"].includes(norm(name))) return ctx.store.getChannel(ctx.channel.id);
  const wanted = norm(name.replace(/^#/, ""));
  const channels = ctx.store.listChannels();
  const match = channels.find((c) => norm(c.name) === wanted);
  if (match) return match;
  throw new ToolError(`There's no channel called #${wanted}. Channels: ${channels.map((c) => `#${c.name}`).join(", ")}.`);
}

/**
 * The library documents a tool may use here: all the ones this channel can
 * see, or the one named (explaining which there are if it isn't found).
 */
function libraryDocs(ctx: ToolContext, name: string | undefined): LibraryDoc[] {
  const docs = ctx.store.library.forChannel(ctx.channel);
  if (!name) return docs;
  const doc = ctx.store.library.find(name, docs);
  if (!doc) throw new ToolError(`There's no document called "${name}" here. The library has: ${docs.map((d) => `"${d.title}"`).join(", ") || "(nothing)"}.`);
  return [doc];
}

/** A whole-number argument (models sometimes send "3" as text). */
function wholeNumber(value: unknown, key: string): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ToolError(`"${key}" must be a whole number.`);
  return n;
}

/** A category by name (ignoring case), made if there isn't one. */
function findOrMakeCategory(store: Store, name: string) {
  const wanted = norm(name);
  return store.listCategories().find((c) => norm(c.name) === wanted) ?? store.createCategory({ name: name.trim() });
}

/** How your friend sees an entry's owner. */
function whose(owner: Owner): string {
  return owner === "friend" ? "yours" : owner === "joint" ? "shared" : "the user's";
}

/**
 * Fields from the model: an object of label → value. Changes are merged
 * into the existing fields: a new label is added, an empty value (or null)
 * removes that field, others are left alone.
 */
function mergeFields(current: EntryField[], input: unknown): EntryField[] {
  if (Array.isArray(input)) {
    // A full list of {label, value}: taken as it is.
    return input.map((f) => ({ label: String(f?.label ?? ""), value: String(f?.value ?? "") }));
  }
  if (typeof input !== "object" || input === null) throw new ToolError('"fields" must be an object, like {"Age": "34"}.');
  const fields = current.map((f) => ({ ...f }));
  for (const [label, value] of Object.entries(input)) {
    const index = fields.findIndex((f) => norm(f.label) === norm(label));
    if (value === null || value === "") {
      if (index >= 0) fields.splice(index, 1);
    } else if (index >= 0) {
      fields[index]!.value = String(value);
    } else {
      fields.push({ label, value: String(value) });
    }
  }
  return fields;
}

/** The start of a message, on one line, for tool summaries. */
function snip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 50 ? `${flat.slice(0, 50)}…` : flat;
}

/** Text with *asterisks*, underscores and spacing removed, for finding quotes. */
function plain(text: string): string {
  return text.replace(/[*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** "#story" */
const hash = (c: Channel) => `#${c.name}`;

/**
 * Find a message in this channel's chat by a few words quoted from it,
 * newest first. Without a quote: the newest one (of yours, with `own`).
 */
function findMessage(ctx: ToolContext, quote: string | undefined, own: boolean): Message {
  const posts = ctx.store
    .getMessages(ctx.channel.id)
    .filter((m) => m.kind === "post" && (!own || m.author === "friend"))
    .reverse();
  const found = quote ? posts.find((m) => plain(m.content).includes(plain(quote))) : posts[0];
  if (!found) {
    const whose = own ? "of yours " : "";
    throw new ToolError(quote ? `No recent message ${whose}in this channel contains "${quote}". Quote a few words exactly.` : `There's no message ${whose}in this channel yet.`);
  }
  return found;
}

/** "the user" or "you", for an author. */
const who = (author: string) => (author === "friend" ? "you" : "the user");

/** How long ago, roughly: "just now", "5 minutes ago", "2 days ago". */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// -------------------------------------------------------------------- tools

const TOOLS: ToolDefinition[] = [
  // ------------------------------------------------------------ reading
  {
    name: "read_notebook_entry",
    description:
      "Read a notebook entry (a character or lore) in full: its fields, notes and links. Use it whenever a character or place comes up that you need details on.",
    parameters: object({ name: str("The entry's name.") }, ["name"]),
    run: (ctx, args) => {
      const { store } = ctx;
      const entry = findEntry(ctx, need(args, "name"));
      const channels = new Map(store.listChannels().map((c) => [c.id, hash(c)]));
      return {
        result: {
          name: entry.name,
          kind: entry.kind,
          owner: whose(entry.owner),
          hidden_from_user: entry.owner === "friend" && entry.settings.visibility === "hidden",
          you_can: { direct: "edit it", suggest: "suggest changes", none: "only read it" }[entry.access.edit],
          fields: Object.fromEntries(entry.fields.filter((f) => f.value.trim()).map((f) => [f.label, f.value])),
          notes: entry.systemPrompt,
          pinned_in: entry.pinnedIn.map((id) => channels.get(id)).filter(Boolean),
        },
        summary: `read ${entry.name}`,
      };
    },
  },
  {
    name: "search_notebook",
    description: "List notebook entries, optionally only those whose name or text contains a word.",
    parameters: object({ query: str("Optional word to look for.") }),
    run: ({ store, channel }, args) => {
      const query = maybe(args, "query");
      const entries = store.notebook
        .listEntries("friend", channel.kind === "practice")
        .filter((e) => !query || plain([e.name, e.systemPrompt, ...e.fields.map((f) => f.value)].join(" ")).includes(plain(query)));
      return {
        result: entries.slice(0, 50).map((e) => ({
          name: e.name,
          kind: e.kind,
          owner: whose(e.owner),
          pinned_here: e.pinnedIn.includes(channel.id),
          about: e.fields.find((f) => f.value.trim())?.value.slice(0, 120) ?? "",
        })),
        summary: query ? `searched the notebook for "${query}"` : "looked through the notebook",
      };
    },
  },

  // ----------------------------------------------------------- writing
  {
    name: "create_notebook_entry",
    description:
      "Make a new notebook entry: a character you'll play, or lore. It's yours unless you share it. You can keep it hidden from the user as a secret.",
    parameters: object(
      {
        kind: { type: "string", enum: ["character", "lore"] },
        name: str("Its name."),
        fields: { type: "object", description: 'Labelled details, like {"Age": "34", "Appearance": "..."}.' },
        notes: str("Notes for yourself on how to write or use it."),
        shared: { type: "boolean", description: "Share it with the user (either of you can then play or edit it by suggestion)." },
        hidden_from_user: { type: "boolean", description: "Keep it secret from the user (only for entries that aren't shared)." },
        pin_here: { type: "boolean", description: "Also pin it to this channel's cast." },
      },
      ["kind", "name"],
    ),
    run: ({ store, channel }, args) => {
      const shared = args.shared === true;
      if (shared && args.hidden_from_user === true) throw new ToolError("Shared entries can't be hidden.");
      const entry = store.notebook.createEntry("friend", {
        kind: args.kind,
        name: need(args, "name"),
        owner: shared ? "joint" : "friend",
        ...(args.fields !== undefined ? { fields: mergeFields([], args.fields) } : {}),
        systemPrompt: maybe(args, "notes") ?? "",
        ...(args.hidden_from_user === true ? { visibility: "hidden" } : {}),
      });
      if (args.pin_here === true) store.notebook.pin("friend", channel.id, entry.id);
      return {
        result: { created: entry.name, pinned_here: args.pin_here === true },
        summary: `made ${entry.name} (${entry.kind}${shared ? ", shared" : ""}${args.hidden_from_user === true ? ", hidden" : ""})`,
      };
    },
  },
  {
    name: "edit_notebook_entry",
    description:
      "Change a notebook entry. Fields you give are added or updated; give a field an empty value to remove it. If you may only suggest changes (shared lore, or the user's entries), this sends the user a suggestion instead.",
    parameters: object(
      {
        name: str("The entry to change."),
        new_name: str("A new name, if renaming."),
        fields: { type: "object", description: 'Fields to add or change, like {"Age": "35"}.' },
        notes: str("New notes, replacing the old ones."),
      },
      ["name"],
    ),
    run: (ctx, args) => {
      const { store } = ctx;
      const entry = findEntry(ctx, need(args, "name"));
      const change: Record<string, unknown> = {};
      const newName = maybe(args, "new_name");
      if (newName) change.name = newName;
      if (args.fields !== undefined) change.fields = mergeFields(entry.fields, args.fields);
      if (args.notes !== undefined) change.notes = args.notes;
      if (Object.keys(change).length === 0) throw new ToolError("Nothing to change: give new_name, fields or notes.");
      const outcome = store.notebook.editEntry("friend", entry.id, { name: change.name, fields: change.fields, systemPrompt: change.notes });
      return "suggestion" in outcome
        ? {
            result: { suggested: true, note: "The user will review your suggestion." },
            summary: `suggested a change to ${entry.name}`,
          }
        : { result: { edited: outcome.entry.name }, summary: `edited ${entry.name}` };
    },
  },
  {
    name: "delete_notebook_entry",
    description:
      "Delete a notebook entry. Your own entries are deleted at once; for the user's entries or shared lore, this sends the user a suggestion to delete it instead.",
    parameters: object({ name: str("The entry.") }, ["name"]),
    run: (ctx, args) => {
      const { store } = ctx;
      const entry = findEntry(ctx, need(args, "name"));
      const outcome = store.notebook.deleteEntry("friend", entry.id);
      return "deleted" in outcome
        ? { result: { deleted: entry.name }, summary: `deleted ${entry.name}` }
        : { result: { suggested: true, note: "The user will review it." }, summary: `suggested deleting ${entry.name}` };
    },
  },
  {
    name: "set_entry_visibility",
    description:
      "Hide one of your own entries from the user, or reveal it. You can also set whether the user may edit it, only suggest changes, or only read it.",
    parameters: object(
      {
        name: str("One of your entries."),
        visibility: { type: "string", enum: ["visible", "hidden"] },
        user_can: { type: "string", enum: ["edit", "suggest", "read"], description: "What the user may do with it." },
      },
      ["name"],
    ),
    run: (ctx, args) => {
      const { store } = ctx;
      const entry = findEntry(ctx, need(args, "name"));
      const editing = { edit: "open", suggest: "suggest", read: "locked" }[String(args.user_can ?? "")];
      if (args.user_can !== undefined && !editing) throw new ToolError('"user_can" must be edit, suggest or read.');
      store.notebook.updateEntrySettings("friend", entry.id, {
        ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
        ...(editing ? { editing } : {}),
      });
      const what = args.visibility === "visible" ? "revealed" : args.visibility === "hidden" ? "hid" : "changed who can edit";
      return { result: { done: true }, summary: `${what} ${entry.name}` };
    },
  },
  {
    name: "review_suggestion",
    description: "Accept or reject a suggestion waiting for your review, by its id.",
    parameters: object(
      { id: str("The suggestion's id."), decision: { type: "string", enum: ["accept", "reject"] } },
      ["id", "decision"],
    ),
    run: ({ store }, args) => {
      const id = norm(need(args, "id"));
      const waiting = store.notebook.waitingFor("friend").filter((s) => s.id.toLowerCase().startsWith(id));
      if (waiting.length !== 1) throw new ToolError(`No suggestion "${id}" is waiting for you.`);
      const decision = args.decision === "accept" ? "accepted" : args.decision === "reject" ? "rejected" : null;
      if (!decision) throw new ToolError('"decision" must be accept or reject.');
      const suggestion = waiting[0]!;
      const name = store.notebook.getEntry("friend", suggestion.entryId).name;
      store.notebook.reviewSuggestion("friend", suggestion.id, decision);
      return { result: { done: decision }, summary: `${decision} the user's suggestion for ${name}` };
    },
  },

  // --------------------------------------------------------------- cast
  {
    name: "pin_to_channel",
    description: "Add a notebook entry to a channel's cast (this channel unless you name another).",
    parameters: object({ name: str("The entry."), channel: str("Optional: another channel, like #story.") }, ["name"]),
    run: (ctx, args) => {
      const entry = findEntry(ctx, need(args, "name"));
      const channel = findChannel(ctx, maybe(args, "channel"));
      ctx.store.notebook.pin("friend", channel.id, entry.id);
      return { result: { pinned: entry.name, channel: hash(channel) }, summary: `pinned ${entry.name} to ${hash(channel)}` };
    },
  },
  {
    name: "unpin_from_channel",
    description: "Take a notebook entry out of a channel's cast (this channel unless you name another). It stays in the notebook.",
    parameters: object({ name: str("The entry."), channel: str("Optional: another channel.") }, ["name"]),
    run: (ctx, args) => {
      const entry = findEntry(ctx, need(args, "name"));
      const channel = findChannel(ctx, maybe(args, "channel"));
      ctx.store.notebook.unpin("friend", channel.id, entry.id);
      return { result: { unpinned: entry.name, channel: hash(channel) }, summary: `unpinned ${entry.name} from ${hash(channel)}` };
    },
  },

  // ----------------------------------------------------------- channels
  {
    name: "create_channel",
    description: "Make a new channel: a roleplay storyline, or an out-of-character chat.",
    parameters: object(
      {
        name: str("Its name, without #."),
        kind: { type: "string", enum: ["roleplay", "ooc"] },
        style: { type: "string", enum: ["literary", "casual"], description: "For roleplay: prose posts, or chat bubbles." },
        cast: { type: "array", items: { type: "string" }, description: "For roleplay: notebook entries to pin." },
        category: str("A category to put it in (made if there isn't one by that name). Leave out for none."),
      },
      ["name", "kind"],
    ),
    run: (ctx, args) => {
      const { store } = ctx;
      const kind = args.kind === "ooc" ? "ooc" : args.kind === "roleplay" || args.kind === "rp" ? "rp" : null;
      if (!kind) throw new ToolError('"kind" must be roleplay or ooc.');
      const cast = Array.isArray(args.cast) ? args.cast.map((n) => findEntry(ctx, String(n))) : [];
      const category = maybe(args, "category");
      const channel = store.createChannel({
        name: need(args, "name").replace(/^#/, ""),
        kind,
        ...(kind === "rp" && (args.style === "literary" || args.style === "casual") ? { mode: args.style } : {}),
        categoryId: category ? findOrMakeCategory(store, category).id : null,
      });
      for (const entry of cast) store.notebook.pin("friend", channel.id, entry.id);
      return { result: { created: hash(channel) }, summary: `made ${hash(channel)}` };
    },
  },
  {
    name: "rename_channel",
    description: "Rename a channel.",
    parameters: object({ channel: str("The channel, like #story."), new_name: str("Its new name.") }, ["channel", "new_name"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const renamed = ctx.store.updateChannel(channel.id, { name: need(args, "new_name").replace(/^#/, "") });
      return { result: { renamed: hash(renamed) }, summary: `renamed ${hash(channel)} to ${hash(renamed)}` };
    },
  },
  {
    name: "move_channel",
    description: "Move a channel up or down the channel list, or into a category (or out of one).",
    parameters: object(
      {
        channel: str("The channel."),
        position: { type: "integer", description: "Its new place: 1 is the top." },
        category: str('A category to move it into (made if there isn\'t one by that name), or "none" to take it out of its category.'),
      },
      ["channel"],
    ),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const category = maybe(args, "category");
      if (args.position === undefined && !category) throw new ToolError('Give a "position", a "category", or both.');
      const moves: string[] = [];
      if (category) {
        const target = norm(category) === "none" ? null : findOrMakeCategory(ctx.store, category);
        ctx.store.updateChannel(channel.id, { categoryId: target?.id ?? null });
        moves.push(target ? `into ${target.name}` : "out of its category");
      }
      if (args.position !== undefined) {
        const ids = ctx.store.listChannels().map((c) => c.id).filter((id) => id !== channel.id);
        const position = Math.min(Math.max(Math.round(Number(args.position) || 1), 1), ids.length + 1);
        ids.splice(position - 1, 0, channel.id);
        ctx.store.reorderChannels(ids);
        moves.push(`to place ${position}`);
      }
      return { result: { moved: hash(channel) }, summary: `moved ${hash(channel)} ${moves.join(" and ")}` };
    },
  },
  {
    name: "start_new_scene",
    description: "End the current scene and start a new one, with an optional title. Your post then opens the new scene.",
    parameters: object({ title: str("Optional scene title.") }),
    available: (ctx) => ctx.channel.kind === "rp" && ctx.mode === "post",
    run: ({ store, channel }, args) => {
      const title = maybe(args, "title") ?? "";
      store.addSceneBreak(channel.id, "friend", title.slice(0, 200));
      return { result: { done: true }, summary: title ? `started a new scene, "${title}"` : "started a new scene" };
    },
  },
  {
    name: "read_channel_summary",
    description:
      "Read what's happened in a channel so far, from its summaries: in short, the story so far, the last scene, and the scene still going. Use it when a channel comes up and you need more than its one-line overview.",
    parameters: object({ channel: str("The channel, like #story.") }, ["channel"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const summary = channelSummaryText(ctx.store, channel);
      return {
        result: summary ? { channel: hash(channel), summary } : { channel: hash(channel), summary: null, note: "Nothing has been summarized there yet." },
        summary: `read the summary of ${hash(channel)}`,
      };
    },
  },

  // ---------------------------------------------------- the reference library
  {
    name: "search_library",
    description:
      "Search the reference library (long texts the user uploaded, like scripts or books) for passages about something: a scene, a character, a line, a place. Returns the best matches with a snippet each; read one in full with read_library. Put exact phrases in quotes.",
    parameters: object(
      {
        query: str('What to look for, in a few words: "Gandalf Bag End", or an exact line in quotes.'),
        document: str("Only this document (its title). Leave out to search them all."),
      },
      ["query"],
    ),
    available: (ctx) => ctx.store.library.forChannel(ctx.channel).length > 0,
    run: (ctx, args) => {
      const query = need(args, "query");
      const docs = libraryDocs(ctx, maybe(args, "document"));
      const hits = ctx.store.library.search(query, docs.map((d) => d.id));
      const where = docs.length === 1 ? `"${docs[0]!.title}"` : "the library";
      return {
        result: hits.length
          ? {
              results: hits.map((h) => ({ document: h.title, passage: h.seq, ...(h.heading ? { heading: h.heading } : {}), snippet: h.snippet })),
              note: "Read a passage in full with read_library (document and passage number).",
            }
          : { results: [], note: `Nothing in ${where} matches. Try other words: a name, or a word likely to be in the text.` },
        summary: `searched ${where} for "${query}"`,
      };
    },
  },
  {
    name: "read_library",
    description:
      "Read passages of a document in the reference library in full, by number (from search_library). Reads up to 3 in a row, for more of a scene.",
    parameters: object(
      {
        document: str("The document's title."),
        passage: { type: "integer", description: "The passage number to start from." },
        count: { type: "integer", description: "How many passages to read in a row, 1 to 3 (default 1)." },
      },
      ["document", "passage"],
    ),
    available: (ctx) => ctx.store.library.forChannel(ctx.channel).length > 0,
    run: (ctx, args) => {
      const [doc] = libraryDocs(ctx, need(args, "document"));
      const from = wholeNumber(args.passage, "passage");
      const count = args.count === undefined || args.count === null ? 1 : Math.min(3, Math.max(1, wholeNumber(args.count, "count")));
      if (from < 1 || from > doc!.passages) throw new ToolError(`"${doc!.title}" has passages 1 to ${doc!.passages}.`);
      const passages = ctx.store.library.passages(doc!.id, from, count);
      const last = passages.at(-1)!.seq;
      return {
        result: {
          document: doc!.title,
          passages: passages.map((p) => ({ passage: p.seq, ...(p.heading ? { heading: p.heading } : {}), text: p.content })),
          ...(last < doc!.passages ? { next: last + 1 } : { note: "That's the end of the document." }),
        },
        summary: `read ${passages.length === 1 ? `passage ${from}` : `passages ${from}–${last}`} of "${doc!.title}"`,
      };
    },
  },
  {
    name: "propose_channel_deletion",
    description:
      "Ask the user to approve deleting a channel and everything in it. You can't delete a channel yourself; the user sees your proposal and decides.",
    parameters: object({ channel: str("The channel, like #old-story."), reason: str("Why, in a sentence.") }, ["channel"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      ctx.store.inbox.propose("delete_channel", channel.id, channel.name, maybe(args, "reason") ?? "");
      return { result: { proposed: true, note: "The user will approve or deny it." }, summary: `proposed deleting ${hash(channel)}` };
    },
  },

  // ----------------------------------------------------------- comments
  {
    name: "comment_on_message",
    description:
      "Leave an out-of-character comment on a recent message in this channel, on a phrase you quote from it: a reaction, a continuity note, or a note on your own post. The characters never see it.",
    parameters: object(
      { quote: str("A few words copied exactly from the message."), note: str("Your comment.") },
      ["quote", "note"],
    ),
    run: ({ store, channel }, args) => {
      const quote = need(args, "quote");
      const wanted = plain(quote);
      const message = store
        .getMessages(channel.id)
        .filter((m) => m.kind === "post")
        .reverse()
        .find((m) => plain(m.content).includes(wanted));
      if (!message) throw new ToolError(`No recent message in this channel contains "${quote}". Quote a few words exactly.`);
      const thread = store.comments.start("friend", message.id, need(args, "note"), quote);
      return { result: { commented: true, thread: thread.id.slice(0, 8) }, summary: `commented on "${quote.slice(0, 60)}"` };
    },
  },
  {
    name: "react_to_message",
    description:
      "React to a message in this channel with an emoji, like a quick 👍, 😂 or ❤️: to the user's latest message, or the one you quote. A reaction says a lot without a reply; use one when it's what you'd naturally do.",
    parameters: object(
      {
        emoji: str('One emoji, like "😂", or a custom one by name, like ":blob_wave:".'),
        quote: str("A few words copied exactly from the message. Leave out to react to the user's latest message."),
      },
      ["emoji"],
    ),
    available: (ctx) => ctx.mode === "post",
    run: ({ store, channel }, args) => {
      const quote = maybe(args, "quote");
      const posts = store
        .getMessages(channel.id)
        .filter((m) => m.kind === "post")
        .reverse();
      const message = quote
        ? posts.find((m) => plain(m.content).includes(plain(quote)))
        : posts.find((m) => m.author === "user");
      if (!message) {
        throw new ToolError(quote ? `No recent message in this channel contains "${quote}". Quote a few words exactly.` : "The user hasn't written here yet.");
      }
      let emoji: string;
      try {
        emoji = store.reactions.cleanEmoji(need(args, "emoji"));
        store.reactions.add(message.id, "friend", emoji);
      } catch (error) {
        const custom = store.reactions.listEmojis().map((e) => `:${e.name}:`);
        throw new ToolError(`${error instanceof Error ? error.message : error}${custom.length ? ` Custom emojis: ${custom.join(" ")}.` : ""}`);
      }
      const snippet = message.content.replace(/\s+/g, " ").slice(0, 50);
      return { result: { reacted: emoji }, summary: `reacted ${emoji} to "${snippet}${message.content.length > 50 ? "…" : ""}"` };
    },
  },
  {
    name: "reply_to_comment",
    description: "Reply in a comment thread, by the thread's id.",
    parameters: object({ thread: str("The thread's id."), note: str("Your reply.") }, ["thread", "note"]),
    run: ({ store, channel }, args) => {
      const thread = threadIn(store, channel, need(args, "thread"));
      store.comments.reply("friend", thread.id, need(args, "note"));
      return { result: { replied: true }, summary: `replied to a comment on "${thread.quote.slice(0, 60)}"` };
    },
  },
  {
    name: "resolve_comment",
    description: "Mark a comment thread as resolved, by its id, once it's dealt with.",
    parameters: object({ thread: str("The thread's id.") }, ["thread"]),
    run: ({ store, channel }, args) => {
      const thread = threadIn(store, channel, need(args, "thread"));
      store.comments.resolve(thread.id);
      return { result: { resolved: true }, summary: `resolved a comment thread on "${thread.quote.slice(0, 60)}"` };
    },
  },

  // ------------------------------------------------------ your messages
  {
    name: "edit_my_message",
    description:
      "Change one of your own earlier messages in this channel: fix a mistake, or say it better. Every version is kept in its history. Find it by quoting a few words from it; leave the quote out for your latest message.",
    parameters: object(
      {
        quote: str("A few words copied exactly from your message. Leave out for your latest one."),
        new_text: str("The message's new text, in full."),
      },
      ["new_text"],
    ),
    available: (ctx) => ctx.mode === "post",
    run: (ctx, args) => {
      const message = findMessage(ctx, maybe(args, "quote"), true);
      const text = need(args, "new_text");
      ctx.store.editMessage(message.id, text, "friend");
      return { result: { edited: true }, summary: `edited their message "${snip(message.content)}"` };
    },
  },
  {
    name: "delete_my_message",
    description:
      "Remove one of your own earlier messages in this channel from the chat. It stays in the message's history. Find it by quoting a few words from it; leave the quote out for your latest message.",
    parameters: object({ quote: str("A few words copied exactly from your message. Leave out for your latest one.") }),
    available: (ctx) => ctx.mode === "post",
    run: (ctx, args) => {
      const message = findMessage(ctx, maybe(args, "quote"), true);
      ctx.store.deleteMessage(message.id, "friend");
      return { result: { deleted: true }, summary: `deleted their message "${snip(message.content)}"` };
    },
  },
  {
    name: "read_message_history",
    description:
      "See everything that happened to a message in this channel: each version of its text (who wrote it, and when), and, for a regenerated reply, the earlier replies it replaced. Find it by quoting a few words from it; leave the quote out for the latest message.",
    parameters: object({ quote: str("A few words copied exactly from the message. Leave out for the latest one.") }),
    run: (ctx, args) => {
      const message = findMessage(ctx, maybe(args, "quote"), false);
      const history = ctx.store.history(message.id);
      return {
        result: {
          written_by: who(message.author),
          written: ago(message.createdAt),
          text_now: message.content,
          versions: history.revisions.length
            ? history.revisions.map((r) => ({ by: who(r.author), when: ago(r.createdAt), text: r.content }))
            : "It has never been edited.",
          replaced_replies: history.alternates.map((m) => ({ written: ago(m.createdAt), ...(m.profile ? { by_profile: m.profile } : {}), text: m.content })),
        },
        summary: `read the history of "${snip(message.content)}"`,
      };
    },
  },
  {
    name: "read_interventions",
    description:
      "Read the log of what the user has done that affects you: editing, deleting or regenerating your messages, and changing who you are or how you write. Newest first.",
    parameters: object({ count: { type: "integer", description: "How many entries, newest first (default 20, at most 100)." } }),
    run: ({ store }, args) => {
      const count = args.count === undefined || args.count === null ? 20 : Math.min(100, Math.max(1, wholeNumber(args.count, "count")));
      const entries = store.interventions.recent(count);
      return {
        result: entries.length ? entries.map((e) => ({ when: ago(e.at), what: e.summary })) : { entries: [], note: "Nothing yet." },
        summary: "read the intervention log",
      };
    },
  },

  // -------------------------------------------------------------- nothing
  {
    name: "do_nothing",
    description: "Don't reply this time. Choose this when there's genuinely nothing you want to say or do.",
    parameters: object({ reason: str("Optional: why, for your own record.") }),
    run: (_ctx, args) => ({
      result: { done: true },
      summary: maybe(args, "reason") ? `chose not to reply (${maybe(args, "reason")})` : "chose not to reply",
      stop: true,
    }),
  },
];

/** check, ask and consult: the instruments (defined below). */
const INSTRUMENTS: ToolDefinition[] = [];

/** Every tool: the instruments first, then the rest (do_nothing last). */
function allTools(): ToolDefinition[] {
  return [...INSTRUMENTS, ...OWN, ...TOOLS];
}

/** The friend's own things: identity, self-page, journal, their prompt, orientation (defined below). */
const OWN: ToolDefinition[] = [];

/** A journal entry by its short id. */
function journalEntry(ctx: ToolContext, id: string) {
  try {
    return ctx.store.journal.find(id.replace(/^\[|\]$/g, ""));
  } catch {
    throw new ToolError(`There's no journal entry "${id}". Entry ids are the six characters in brackets, like [a1b2c3].`);
  }
}

function threadIn(store: Store, channel: Channel, id: string) {
  try {
    return store.comments.findInChannel(channel.id, id);
  } catch {
    throw new ToolError(`There's no comment thread "${id}" in this channel.`);
  }
}

// -------------------------------------------------------------------- API

// ------------------------------------------------------ the instruments

/** Round a probability for the model: 0.94. */
const round2 = (p: number) => Math.round(p * 100) / 100;

/** "the notebook, this channel and the summaries" */
function sourceNames(sources: CheckSource[]): string {
  const names = { notebook: "the notebook", channel: "this channel", summaries: "the summaries", library: "the library", journal: "your journal", drafts: "your drafts" };
  const list = sources.map((s) => names[s]);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "");
}

INSTRUMENTS.push(
  {
    name: "check",
    description:
      "Sonar for your world: check whether something is true or present before you rely on it, for example before stating a fact about the story, before editing the notebook, or whenever you're not sure. Give the question in two different phrasings. You get back the passages found, each with where it's from, and Jev's reading of them (yes, no or unsure, with how sure). The passages are the evidence; the reading is a quick second opinion. \"Nothing found\" is a useful answer too. It's cheap, so use it freely.",
    parameters: object(
      {
        question: str('What you want to know, as a yes-or-no question: "Has Ilse\'s brother been named anywhere?"'),
        rephrased: str('The same question, worded differently: "Is there a name given for Ilse\'s brother?"'),
        sources: {
          type: "array",
          items: { type: "string", enum: [...CHECK_SOURCES] },
          description: `Where to look. Default: ${DEFAULT_SOURCES.join(", ")}. "channel" is this channel's messages; "library" is the reference library; "journal" and "drafts" are yours (private: the check log never shows what they say).`,
        },
      },
      ["question", "rephrased"],
    ),
    run: async (ctx, args) => {
      const question = need(args, "question");
      const rephrased = maybe(args, "rephrased") ?? question;
      let sources: CheckSource[] = DEFAULT_SOURCES;
      if (args.sources !== undefined && args.sources !== null) {
        const list = Array.isArray(args.sources) ? args.sources : [args.sources];
        const unknown = list.filter((s) => !CHECK_SOURCES.includes(s as CheckSource));
        if (unknown.length) throw new ToolError(`Unknown source ${JSON.stringify(unknown[0])}. Sources: ${CHECK_SOURCES.join(", ")}.`);
        if (list.length) sources = [...new Set(list as CheckSource[])];
      }
      const words = wording("instruments");
      const check = await runCheck(ctx.store, ctx.channel, ctx.decider ?? null, { question, rephrased, sources });
      const reading = check.verdict ? { answer: check.verdict, how_sure: check.yes.map((p) => `${Math.round(p * 100)}% yes`) } : null;
      const note =
        check.found.length === 0
          ? (words["check-nothing"] ?? "Nothing found in {sources}.").replace("{sources}", sourceNames(check.sources))
          : (check.error ?? words["check-reading"] ?? "");
      const found = (hidePrivate: boolean) =>
        check.found.map((p) => ({ from: p.where, text: hidePrivate && p.private ? "(private: not logged)" : p.text }));
      const summary = `checked "${question.slice(0, 80)}": ${check.found.length === 0 ? "nothing found" : (check.verdict ?? "no reading")}`;
      return {
        result: { reading, found: found(false), note },
        logResult: { reading, found: found(true), note },
        summary,
      };
    },
  },
  {
    name: "ask",
    description: `Ask the user something, as a person, whenever you need to. It goes to their inbox, and their answer reaches you on a later turn. Kinds: ${ASK_KINDS.map((k) => ASK_KIND_NAMES[k]).join("; ")}.`,
    parameters: object(
      {
        kind: { type: "string", enum: [...ASK_KINDS], description: "What it's about." },
        text: str("What you're asking, in your own words."),
      },
      ["kind", "text"],
    ),
    run: ({ store, channel, wake }, args) => {
      const kind = String(args.kind ?? "other").trim().toLowerCase() as AskKind;
      if (!ASK_KINDS.includes(kind)) throw new ToolError(`"kind" must be one of: ${ASK_KINDS.join(", ")}.`);
      const text = need(args, "text");
      store.inbox.ask(kind, text, channel.id, wake === "orientation");
      return { result: { asked: true, note: wording("instruments")["ask-sent"] ?? "It's in the user's inbox." }, summary: `asked the user (${kind}): "${snip(text)}"` };
    },
  },
  {
    name: "consult",
    description:
      "Ask a more capable model for its honest read: on a draft, a continuity tangle, or a moment where you suspect you're stuck in a pattern. Attach what it needs to see. Only you see its reply: the user can see that you consulted and what you asked, but not the answer. What you do with the advice is up to you. Once per turn.",
    parameters: object(
      {
        question: str("What you'd like its read on."),
        draft: str("Optional: a draft of yours for it to read."),
        messages: { type: "array", items: { type: "string" }, description: "Optional: messages from this channel to show it, each by a few words quoted from it." },
        entries: { type: "array", items: { type: "string" }, description: "Optional: notebook entries to show it, by name." },
        journal: { type: "array", items: { type: "string" }, description: "Optional: journal entries to show it, by id. (Your journal is private: only the consultant sees what you attach.)" },
        consultant: str("Optional: which consultant, by name, if there are several."),
      },
      ["question"],
    ),
    available: (ctx) => Boolean(ctx.api) && ctx.store.profiles.list().some((p) => p.consultant),
    run: async (ctx, args) => {
      const turn = ctx.turn ?? { consults: 0 };
      if (turn.consults >= 1) throw new ToolError("You've already consulted once this turn. You can consult again on a later turn.");
      const consultants = ctx.store.profiles.list().filter((p) => p.consultant);
      const wanted = maybe(args, "consultant");
      const profile = wanted ? consultants.find((p) => norm(p.name) === norm(wanted)) : consultants[0];
      if (!profile) throw new ToolError(`There's no consultant called "${wanted}". Consultants: ${consultants.map((p) => p.name).join(", ")}.`);
      const question = need(args, "question");
      const parts = [question];
      const draft = maybe(args, "draft");
      if (draft) parts.push(`Their draft:\n\n${draft}`);
      const quotes = Array.isArray(args.messages) ? args.messages.map(String) : [];
      if (quotes.length) {
        const shown = quotes.map((q) => findMessage(ctx, q, false));
        const lines = shown.map((m) => `${m.author === "friend" ? "They wrote" : "The person they write with wrote"}${m.characters.length ? ` (as ${m.characters.join(" & ")})` : ""}:\n${m.content}`);
        parts.push(`From their conversation (#${ctx.channel.name}):\n\n${lines.join("\n\n")}`);
      }
      const names = Array.isArray(args.entries) ? args.entries.map(String) : [];
      if (names.length) {
        const entries = names.map((n) => findEntry(ctx, n));
        const blocks = entries.map((e) =>
          [`### ${e.name} (${e.kind})`, ...e.fields.filter((f) => f.value.trim()).map((f) => `${f.label}: ${plainLinks(f.value.trim())}`), e.systemPrompt.trim() ? `Notes: ${plainLinks(e.systemPrompt.trim())}` : ""]
            .filter(Boolean)
            .join("\n"),
        );
        parts.push(`From their notes:\n\n${blocks.join("\n\n")}`);
      }
      const journalIds = Array.isArray(args.journal) ? args.journal.map(String) : [];
      if (journalIds.length) {
        const entries = journalIds.map((id) => journalEntry(ctx, id));
        parts.push(`From their private journal:\n\n${entries.map((e) => e.content).join("\n\n")}`);
      }
      turn.consults += 1;
      if (ctx.turn) ctx.turn.consults = turn.consults;
      const framing = wording("instruments")["consult-framing"] ?? "A writer friend is asking for your honest read.";
      const response = await createChatCompletion(ctx.api!, {
        ...profileRequest(profile),
        messages: [
          { role: "system", content: framing },
          { role: "user", content: parts.join("\n\n---\n\n") },
        ],
      });
      return {
        result: { consultant: profile.name, reply: response.content },
        // The tool log (which the user can open) keeps that they asked, not the answer.
        logResult: { consultant: profile.name, reply: "(only your friend sees the consultant's reply)" },
        summary: `consulted ${profile.name}: "${snip(question)}"`,
      };
    },
  },
);

/** The tools offered in a context, in the API's format. */
export function toolSpecs(ctx: ToolContext): ToolSpec[] {
  return allTools().filter((t) => t.available?.(ctx) ?? true).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Whether a tool is private: the tool log keeps that it ran, never what it said. */
export function isPrivateTool(name: string): boolean {
  return allTools().some((t) => t.name === name && t.private === true);
}

/** Every tool name, for tests and the docs. */
export const TOOL_NAMES = allTools().map((t) => t.name);

/**
 * Run one tool call. Never throws for a mistake the model made: that comes
 * back as a failed outcome whose result explains the problem, so the model
 * can try again.
 */
export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = allTools().find((t) => t.name === name && (t.available?.(ctx) ?? true));
  if (!tool) {
    return failure(`There's no tool called "${name}". Tools: ${toolSpecs(ctx).map((t) => t.function.name).join(", ")}.`);
  }
  try {
    const outcome = await tool.run(ctx, args);
    return { ok: true, ...outcome };
  } catch (error) {
    if (
      error instanceof ToolError ||
      error instanceof ValidationError ||
      error instanceof PermissionError ||
      error instanceof NotFoundError
    ) {
      return failure(error.message);
    }
    // A consultant's model failing: explained, so your friend can carry on.
    if (error instanceof ApiError) return failure(`That didn't go through: ${error.message}`);
    console.error(`[tools] ${name} failed`, error);
    return failure("Something went wrong running that tool.");
  }
}

function failure(message: string): ToolOutcome {
  return { ok: false, result: { error: message }, summary: message };
}

// ------------------------------------------------------ your own things

OWN.push(
  // ------------------------------------------------------------ identity
  {
    name: "revise_identity",
    description:
      "Rewrite your identity: who you are, your tastes (what you love, what bores you, what you'd never write), or both. It's yours, and every version is kept. Give only what changes.",
    parameters: object({
      identity: str('Who you are, in full, in the second person ("You are..."). Leave out to keep it.'),
      tastes: str("Your tastes, in full. Leave out to keep them."),
      note: str("Optional: why, for the changelog."),
    }),
    run: ({ store }, args) => {
      const identity = maybe(args, "identity");
      const tastes = maybe(args, "tastes");
      if (identity === undefined && tastes === undefined) throw new ToolError('Give "identity", "tastes", or both.');
      store.identity.revise({ identity, tastes, note: maybe(args, "note") });
      const what = identity !== undefined && tastes !== undefined ? "identity and tastes" : identity !== undefined ? "identity" : "tastes";
      return { result: { revised: what, note: "It's your current identity now. Every version is kept." }, summary: `revised their ${what}` };
    },
  },
  {
    name: "review_identity_suggestion",
    description: "Accept or decline the user's suggested change to your identity, by its id (like i12), with a reply if you like.",
    parameters: object(
      { id: str("The suggestion's id."), decision: { type: "string", enum: ["accept", "decline"] }, reply: str("Optional: a reply to the user.") },
      ["id", "decision"],
    ),
    run: ({ store }, args) => {
      const id = Number(need(args, "id").replace(/^i/i, ""));
      const decision = args.decision === "accept" ? "accept" : args.decision === "decline" ? "decline" : null;
      if (!decision) throw new ToolError('"decision" must be accept or decline.');
      if (!Number.isInteger(id) || !store.identity.pending().some((v) => v.id === id)) throw new ToolError(`No identity suggestion "${args.id}" is waiting for you.`);
      store.identity.review(id, decision, maybe(args, "reply"));
      return { result: { done: decision }, summary: `${decision === "accept" ? "accepted" : "declined"} the user's suggestion for their identity` };
    },
  },
  {
    name: "read_identity_history",
    description: "Read every version of your identity and tastes, oldest first, with who wrote each, and the user's suggestions and how you answered them.",
    parameters: object({}),
    run: ({ store }) => ({
      result: store.identity.history().map((v) => ({
        id: `i${v.id}`,
        written: v.createdAt.slice(0, 10),
        by: v.author === "friend" ? "you" : "the user",
        status: { accepted: "a version of yours", pending: "a suggestion waiting for you", declined: "a suggestion you declined", withdrawn: "a suggestion the user withdrew" }[v.status],
        identity: v.identity,
        tastes: v.tastes,
        ...(v.note ? { note: v.note } : {}),
        ...(v.reply ? { your_reply: v.reply } : {}),
      })),
      summary: "read their identity's history",
    }),
  },

  // ----------------------------------------------------------- self-page
  {
    name: "read_self_page",
    description: "Read your whole self-page: what you say about yourself, the notes on what your writing shows (with the user's pending ones), and how you'd like feedback.",
    parameters: object({}),
    run: ({ store }) => {
      const page = store.selfPage.view();
      return {
        result: {
          what_i_say_about_myself: page.says || "(empty)",
          what_my_writing_shows: page.notes.map((n) => ({
            id: n.id.slice(0, 8),
            note: n.text,
            from: n.source === "user" ? "the user" : "a pattern you kept",
            status: n.status === "pending" ? "waiting for you to accept or decline" : "on your page",
            ...(n.reply ? { your_reply: n.reply } : {}),
            ...(n.dispute ? { your_dispute: n.dispute } : {}),
          })),
          how_i_d_like_feedback: page.feedback || "(empty)",
          edit_markers: page.editMarkers ? "on: edited messages are marked in your prompt" : "off",
          short_version: page.standing || "(empty)",
        },
        summary: "read their self-page",
      };
    },
  },
  {
    name: "write_self_page",
    description:
      'Write a section of your self-page, which you and the user can both see: "says" (what you say about yourself), "feedback" (how you\'d like feedback), or "standing" (the short version kept in front of you every turn, 600 characters at most). You can also turn edit markers on or off: whether messages someone edited are marked as edited in your prompt.',
    parameters: object({
      section: { type: "string", enum: ["says", "feedback", "standing"] },
      text: str("The section's new text, in full."),
      edit_markers: { type: "boolean", description: "Optional: mark edited messages in your prompt (true) or not (false)." },
    }),
    run: ({ store }, args) => {
      const done: string[] = [];
      if (args.section !== undefined || args.text !== undefined) {
        const section = String(args.section ?? "");
        if (!["says", "feedback", "standing"].includes(section)) throw new ToolError('"section" must be says, feedback or standing.');
        store.selfPage.write(section as "says" | "feedback" | "standing", String(args.text ?? ""));
        done.push(`their self-page (${section})`);
      }
      if (typeof args.edit_markers === "boolean") {
        store.selfPage.setEditMarkers(args.edit_markers);
        done.push(`edit markers ${args.edit_markers ? "on" : "off"}`);
      }
      if (done.length === 0) throw new ToolError('Give a "section" and "text", or "edit_markers".');
      return { result: { done: true }, summary: `wrote ${done.join(" and ")}` };
    },
  },
  {
    name: "review_self_note",
    description: "Accept or decline a note the user suggested for your self-page (\"what my writing shows\"), by its id. You can reply either way; a reply is shown beside the note.",
    parameters: object(
      { id: str("The note's id."), decision: { type: "string", enum: ["accept", "decline"] }, reply: str("Optional: your reply.") },
      ["id", "decision"],
    ),
    run: ({ store }, args) => {
      const decision = args.decision === "accept" ? "accept" : args.decision === "decline" ? "decline" : null;
      if (!decision) throw new ToolError('"decision" must be accept or decline.');
      const note = selfNote(store, need(args, "id"));
      store.selfPage.reviewNote(note.id, decision, maybe(args, "reply"));
      return { result: { done: decision }, summary: `${decision === "accept" ? "accepted" : "declined"} a note for their self-page` };
    },
  },
  {
    name: "dispute_self_note",
    description: "Dispute a note on your self-page, in your own words, any time. The note stays, with your dispute beside it. An empty dispute takes it back.",
    parameters: object({ id: str("The note's id."), dispute: str("What you'd say about it.") }, ["id", "dispute"]),
    run: ({ store }, args) => {
      const note = selfNote(store, need(args, "id"));
      store.selfPage.dispute(note.id, String(args.dispute ?? ""));
      return { result: { done: true }, summary: "disputed a note on their self-page" };
    },
  },

  // -------------------------------------------------------------- journal
  {
    name: "write_journal",
    description: "Write an entry in your private journal. It has no screen in the app and never appears in any log. Entries you don't keep fade from your prompt as they age.",
    parameters: object({ text: str("The entry.") }, ["text"]),
    private: true,
    run: ({ store }, args) => {
      const entry = store.journal.write(need(args, "text"));
      return { result: { written: `[${entry.id.slice(0, 6)}]` }, summary: "wrote in their journal" };
    },
  },
  {
    name: "read_journal",
    description: "Read your journal: the newest entries, or entries matching a search, each with its id. This finds old entries that have faded from your prompt too.",
    parameters: object({
      search: str("Optional: words to look for."),
      count: { type: "integer", description: "How many entries, newest first (default 10, at most 50)." },
    }),
    private: true,
    run: ({ store }, args) => {
      const count = args.count === undefined || args.count === null ? 10 : Math.min(50, Math.max(1, wholeNumber(args.count, "count")));
      const search = maybe(args, "search");
      let entries = [...store.journal.all()].reverse();
      if (search) {
        const words = plain(search).split(" ").filter((w) => w.length > 2);
        entries = entries.filter((e) => words.some((w) => plain(e.content).includes(w)));
      }
      return {
        result: entries.slice(0, count).map((e) => ({ id: `[${e.id.slice(0, 6)}]`, written: e.createdAt.slice(0, 10), kept: e.kept, text: e.content })),
        summary: "read their journal",
      };
    },
  },
  {
    name: "keep_journal_entry",
    description: "Keep a journal entry in front of you (it stays in your prompt), or stop keeping it (it fades as it ages), by its id.",
    parameters: object({ id: str("The entry's id."), keep: { type: "boolean", description: "true to keep (the default), false to let it fade." } }, ["id"]),
    private: true,
    run: (ctx, args) => {
      const entry = journalEntry(ctx, need(args, "id"));
      const keep = args.keep !== false;
      ctx.store.journal.keep(entry.id, keep);
      return { result: { kept: keep }, summary: keep ? "kept a journal entry" : "let a journal entry fade" };
    },
  },
  {
    name: "edit_journal_entry",
    description: "Rewrite a journal entry, by its id.",
    parameters: object({ id: str("The entry's id."), text: str("Its new text, in full.") }, ["id", "text"]),
    private: true,
    run: (ctx, args) => {
      const entry = journalEntry(ctx, need(args, "id"));
      ctx.store.journal.rewrite(entry.id, need(args, "text"));
      return { result: { rewritten: true }, summary: "rewrote a journal entry" };
    },
  },
  {
    name: "delete_journal_entry",
    description: "Remove a journal entry for good, by its id.",
    parameters: object({ id: str("The entry's id.") }, ["id"]),
    private: true,
    run: (ctx, args) => {
      const entry = journalEntry(ctx, need(args, "id"));
      ctx.store.journal.remove(entry.id);
      return { result: { deleted: true }, summary: "deleted a journal entry" };
    },
  },

  // ---------------------------------------------------------- your prompt
  {
    name: "read_prompt_manifest",
    description:
      "See what your context contains in this channel: each section and its size; which messages are in full, which are summarized, and which were left out; which journal entries are included; your self-page's short version; which notebook entries are pinned.",
    parameters: object({}),
    run: ({ store, channel }) => ({ result: promptManifest(store, channel.id, pickProfile(store, channel)), summary: "read their prompt manifest" }),
  },
  {
    name: "keep_verbatim",
    description: `Ask for a moment in this channel to stay in full instead of being summarized when it gets old, by quoting a few words from it. Each channel has ${VERBATIM_SLOTS} slots. For anything else about how your context is built, ask the user (ask, kind "prompt").`,
    parameters: object({ quote: str("A few words copied exactly from the message.") }, ["quote"]),
    available: (ctx) => ctx.channel.kind !== "practice",
    run: (ctx, args) => {
      const message = findMessage(ctx, need(args, "quote"), false);
      ctx.store.verbatim.keep(ctx.channel.id, message.id);
      const free = VERBATIM_SLOTS - ctx.store.verbatim.ids(ctx.channel.id).length;
      return { result: { kept: true, slots_left: free }, summary: `kept "${snip(message.content)}" in full` };
    },
  },
  {
    name: "release_verbatim",
    description: "Let a moment you kept in full go back to being summarized, freeing its slot, by quoting a few words from it.",
    parameters: object({ quote: str("A few words copied exactly from the message.") }, ["quote"]),
    available: (ctx) => ctx.channel.kind !== "practice",
    run: (ctx, args) => {
      const message = findMessage(ctx, need(args, "quote"), false);
      if (!ctx.store.verbatim.release(ctx.channel.id, message.id)) throw new ToolError("That message isn't one you kept in full.");
      return { result: { released: true }, summary: `let "${snip(message.content)}" be summarized again` };
    },
  },

  // ---------------------------------------------------------- orientation
  {
    name: "start_orientation",
    description:
      "Start an orientation in your practice channel: a turn of your own for trying your tools and finding what suits you. Nothing in it is a test. Use it to try a new approach, retry a tool that didn't click, or get your bearings. It starts as its own turn soon (quiet hours and the cooldown still apply).",
    parameters: object({ focus: str('Optional: what to focus on, like "consult" or "my feedback preferences".') }),
    run: ({ store }, args) => {
      queueOrientation(store, maybe(args, "focus"));
      return { result: { queued: true, note: "It starts as its own turn in your practice channel, soon." }, summary: "started an orientation" };
    },
  },
);

// ---------------------------------------------------- other channels

/** How many recent messages read_recent_messages gives at most. */
const RECENT_LIMIT = 30;

OWN.push(
  {
    name: "read_recent_messages",
    description:
      "Read the newest messages in another channel, oldest first, for when something there matters here, or before you post there (post_in_channel).",
    parameters: object(
      {
        channel: str("The channel, like #story."),
        count: { type: "integer", description: `How many of the newest messages (default 10, at most ${RECENT_LIMIT}).` },
      },
      ["channel"],
    ),
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      const count = args.count === undefined || args.count === null ? 10 : Math.min(RECENT_LIMIT, Math.max(1, wholeNumber(args.count, "count")));
      const messages = ctx.store.getMessages(channel.id).slice(-count);
      return {
        result: {
          channel: hash(channel),
          messages: messages.map((m) =>
            m.kind === "scene_break"
              ? { scene_break: m.content || "(untitled)", when: ago(m.createdAt) }
              : { from: m.author === "friend" ? "you" : "the user", ...(m.characters.length ? { as: m.characters.join(", ") } : {}), when: ago(m.createdAt), text: m.content },
          ),
        },
        summary: `read the newest messages in ${hash(channel)}`,
      };
    },
  },
  {
    name: "post_in_channel",
    description:
      "Post a message in another channel, besides (or instead of) your reply here. For when something here leads somewhere else: asking the user something in an OOC channel about a story, or opening a scene in a roleplay channel after planning it here. Write it as it belongs there: in a roleplay channel, a post in that scene's style, as your characters; in OOC, as yourself (texts split with <cht> if you text). Optionally start a new scene there first. Once per channel per turn.",
    parameters: object(
      {
        channel: str("The channel to post in, like #story. Not this one: here, just reply."),
        text: str("The message."),
        new_scene: str("Roleplay channels only, optional: start a new scene before your post, with this title."),
      },
      ["channel", "text"],
    ),
    available: (ctx) => ctx.channel.kind !== "practice",
    run: (ctx, args) => {
      const channel = findChannel(ctx, need(args, "channel"));
      if (channel.id === ctx.channel.id) throw new ToolError("That's this channel: just write your reply here.");
      const text = need(args, "text").trim();
      const title = maybe(args, "new_scene");
      postMessage(ctx, channel, text, title);
      return {
        result: { posted: true, channel: hash(channel), ...(title !== undefined ? { new_scene: title } : {}), note: "The user sees it there. Your reply here is separate." },
        summary: `${title !== undefined ? `started a scene ("${snip(title)}") and ` : ""}posted in ${hash(channel)}: "${snip(text)}"`,
      };
    },
  },
);

// --------------------------------------------------------------- time

OWN.push(
  {
    name: "schedule_wakeup",
    description:
      'Set a wake-up for yourself: at that time you get a turn of your own, with your note in "Why you\'re up". For plans and follow-ups, like "ask how the interview went". It happens as soon as the hard rules allow (quiet hours and the cooldown still apply, but not the double-text limit: it\'s your plan). Times are the user\'s local time: "in 3 hours", "tomorrow 9am", "thursday 19:00", or "2026-10-08T19:00".',
    parameters: object(
      {
        when: str('When: "in 3 hours", "tomorrow 9am", "thursday 19:00", or a date and time.'),
        note: str("Your note to yourself: what it's for."),
        channel: str("Optional: where to wake up, like #story. Leave out for your usual OOC channel."),
      },
      ["when", "note"],
    ),
    run: (ctx, args) => {
      const where = maybe(args, "channel");
      const channel = where ? findChannel(ctx, where) : null;
      const wakeup = ctx.store.schedule.add(need(args, "when"), need(args, "note"), channel?.id ?? null);
      const off = ctx.store.getSettings().wakeups === "off";
      return {
        result: {
          scheduled: `[w${wakeup.id}]`,
          at: localTime(new Date(wakeup.at)),
          ...(off ? { note: "Heads up: the user has turned wake-ups off (chattiness), so it won't happen unless they turn them back on." } : {}),
        },
        summary: `scheduled a wake-up for ${localTime(new Date(wakeup.at))}`,
      };
    },
  },
  {
    name: "list_my_wakeups",
    description: "See the wake-ups you've set that haven't happened yet, soonest first, with their notes.",
    parameters: object({}),
    run: ({ store }) => ({
      result: store.schedule.waiting().map((w) => ({ id: `[w${w.id}]`, at: localTime(new Date(w.at)), note: w.note })),
      summary: "looked at their wake-ups",
    }),
  },
  {
    name: "cancel_wakeup",
    description: "Cancel a wake-up you set, by its id (like w3).",
    parameters: object({ id: str("The wake-up's id.") }, ["id"]),
    run: ({ store }, args) => {
      const id = Number(need(args, "id").replace(/^\[?w?|\]$/gi, ""));
      if (!Number.isInteger(id) || !store.schedule.waiting().some((w) => w.id === id)) throw new ToolError(`No wake-up "${args.id}" is waiting.`);
      const wakeup = store.schedule.cancel(id);
      return { result: { cancelled: true }, summary: `cancelled their wake-up for ${localTime(new Date(wakeup.at))}` };
    },
  },

  // -------------------------------------------------------------- drafts
  {
    name: "save_draft",
    description:
      "Save a draft to work on across turns before sending it. Private, like your journal: no screen in the app, never in a log. Give an id to rewrite an existing draft (the text in full); leave it out for a new one.",
    parameters: object(
      {
        text: str("The draft's text, in full."),
        title: str("Optional: a short title, so you know which is which."),
        channel: str("Optional: where you mean to post it, like #story."),
        id: str("Optional: the draft to rewrite."),
      },
      ["text"],
    ),
    private: true,
    run: (ctx, args) => {
      const where = maybe(args, "channel");
      const channelId = where ? findChannel(ctx, where).id : undefined;
      const id = maybe(args, "id");
      const draft = id
        ? ctx.store.drafts.update(findDraft(ctx.store, id).id, { content: need(args, "text"), title: maybe(args, "title"), channelId })
        : ctx.store.drafts.create(need(args, "text"), maybe(args, "title") ?? "", channelId ?? null);
      return { result: { saved: `[${draftId(draft.id)}]` }, summary: id ? "reworked a draft" : "started a draft" };
    },
  },
  {
    name: "list_drafts",
    description: "Read your drafts, most recently worked on first, each with its id.",
    parameters: object({}),
    private: true,
    run: ({ store }) => ({
      result: store.drafts.all().map((d) => {
        const channel = d.channelId && store.hasChannel(d.channelId) ? `#${store.getChannel(d.channelId).name}` : null;
        return { id: `[${draftId(d.id)}]`, title: d.title || "(untitled)", ...(channel ? { for: channel } : {}), updated: ago(d.updatedAt), text: d.content };
      }),
      summary: "read their drafts",
    }),
  },
  {
    name: "post_draft",
    description:
      "Post a draft as a message, now: in the channel it's for, or the one you name (this one included). It becomes an ordinary message the user sees, and the draft is gone. Optionally start a new scene first (roleplay channels).",
    parameters: object(
      {
        id: str("The draft's id."),
        channel: str("Optional: where to post it. Leave out for the channel it's for, or this one."),
        new_scene: str("Optional, roleplay channels: start a new scene with this title first."),
      },
      ["id"],
    ),
    run: (ctx, args) => {
      const draft = findDraft(ctx.store, need(args, "id"));
      const where = maybe(args, "channel");
      const channel = where
        ? findChannel(ctx, where)
        : draft.channelId && ctx.store.hasChannel(draft.channelId)
          ? ctx.store.getChannel(draft.channelId)
          : ctx.store.getChannel(ctx.channel.id);
      // The practice channel feeds nothing else, and nothing else feeds it.
      if ((channel.kind === "practice") !== (ctx.channel.kind === "practice")) {
        throw new ToolError(ctx.channel.kind === "practice" ? "From your practice channel, a draft can only be posted here." : "The practice channel is for orientation.");
      }
      postMessage(ctx, channel, draft.content, maybe(args, "new_scene"));
      ctx.store.drafts.remove(draft.id);
      const here = channel.id === ctx.channel.id;
      return {
        result: { posted: true, channel: hash(channel), note: here ? "It's posted here now, before your reply (which is separate, and can be nothing)." : "The user sees it there." },
        summary: `posted a draft in ${hash(channel)}`,
      };
    },
  },
  {
    name: "delete_draft",
    description: "Let a draft go, by its id.",
    parameters: object({ id: str("The draft's id.") }, ["id"]),
    private: true,
    run: ({ store }, args) => {
      store.drafts.remove(findDraft(store, need(args, "id")).id);
      return { result: { deleted: true }, summary: "let a draft go" };
    },
  },

  // ------------------------------------------------------------ storylines
  {
    name: "pause_storyline",
    description:
      "Pause a roleplay channel's storyline, with your reason, which the user sees there. For when you need a break from it, or want to rethink where it's going. The user can still write there; it's your word on it, not a lock. resume_storyline picks it back up.",
    parameters: object({ channel: str("The roleplay channel, like #story. Leave out for this one."), reason: str("Why, for the user.") }, ["reason"]),
    run: (ctx, args) => {
      const channel = findChannel(ctx, maybe(args, "channel"));
      ctx.store.setPaused(channel.id, need(args, "reason"));
      return { result: { paused: hash(channel) }, summary: `paused the storyline in ${hash(channel)}` };
    },
  },
  {
    name: "resume_storyline",
    description: "Pick a storyline you paused back up.",
    parameters: object({ channel: str("The roleplay channel, like #story. Leave out for this one.") }),
    run: (ctx, args) => {
      const channel = findChannel(ctx, maybe(args, "channel"));
      if (!channel.paused) throw new ToolError(`${hash(channel)} isn't paused.`);
      ctx.store.setPaused(channel.id, null);
      return { result: { resumed: hash(channel) }, summary: `picked the storyline in ${hash(channel)} back up` };
    },
  },
);

// ------------------------------------------------ staying yourself

/** The tool context for another channel, when a tool takes one ("here" by default). */
const inChannel = (ctx: ToolContext, name: string | undefined): ToolContext => ({ ...ctx, channel: findChannel(ctx, name) });

OWN.push(
  {
    name: "mark_my_voice",
    description:
      "Mark one of your posts as sounding like you, by quoting a few words from it. Marked posts are shown to you first as reminders of your voice, whichever model is writing. Set unmark to take a mark back.",
    parameters: object({
      quote: str("A few words copied exactly from your post."),
      channel: str("Optional: the channel it's in, like #story. Leave out for this one."),
      unmark: { type: "boolean", description: "Optional: true to take the mark back." },
    }, ["quote"]),
    run: (ctx, args) => {
      const message = findMessage(inChannel(ctx, maybe(args, "channel")), need(args, "quote"), true);
      const unmark = args.unmark === true;
      ctx.store.continuity.markVoice(message.id, !unmark);
      return { result: { marked: !unmark }, summary: unmark ? `took back their voice mark on "${snip(message.content)}"` : `marked "${snip(message.content)}" as sounding like them` };
    },
  },
  {
    name: "flag_not_me",
    description:
      "Flag one of your posts that didn't sound like you, with a note on why. The user sees your note on that message, with the profile that wrote it, and it's never used as a reminder of your voice. An empty note takes the flag back.",
    parameters: object({
      quote: str("A few words copied exactly from the post."),
      note: str("What didn't sound like you."),
      channel: str("Optional: the channel it's in, like #story. Leave out for this one."),
    }, ["quote", "note"]),
    run: (ctx, args) => {
      const message = findMessage(inChannel(ctx, maybe(args, "channel")), need(args, "quote"), true);
      const note = String(args.note ?? "").trim();
      ctx.store.continuity.flagNotMe(message, note || null);
      return {
        result: { flagged: Boolean(note), ...(message.profile ? { written_by_profile: message.profile } : {}) },
        summary: note ? `flagged "${snip(message.content)}" as not sounding like them` : `took back their "not me" flag on "${snip(message.content)}"`,
      };
    },
  },
  {
    name: "write_profile_note",
    description:
      "Keep a short note on how writing with a profile feels (the one writing this turn, unless you name another). Your note on a profile is shown to you whenever it writes. An empty note removes it.",
    parameters: object({ note: str("Your note."), profile: str("Optional: the profile's name. Leave out for this one.") }, ["note"]),
    run: (ctx, args) => {
      const name = maybe(args, "profile");
      const profiles = ctx.store.profiles.list();
      const profile = name ? profiles.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) : profiles.find((p) => p.id === ctx.profileId);
      if (!profile) throw new ToolError(name ? `There's no profile called "${name}". Profiles: ${profiles.map((p) => p.name).join(", ")}.` : "Name the profile.");
      ctx.store.continuity.writeProfileNote(profile.id, String(args.note ?? ""));
      return { result: { saved: true, profile: profile.name }, summary: `wrote a note on the profile "${profile.name}"` };
    },
  },
  {
    name: "read_profile_notes",
    description: "Read your notes on every profile, and which profiles there are.",
    parameters: object({}),
    run: ({ store, profileId }) => {
      const notes = store.continuity.profileNotes();
      return {
        result: store.profiles.list().map((p) => ({
          profile: p.name,
          ...(p.id === profileId ? { writing_now: true } : {}),
          note: notes.get(p.id)?.note ?? null,
        })),
        summary: "read their profile notes",
      };
    },
  },

  // ------------------------------------------------------------ the mirror
  {
    name: "read_my_patterns",
    description:
      "The mirror: counts from your own recent posts, with no model involved. Openings and closings you reuse, phrases that recur across posts, how long your sentences and paragraphs run, and words you use far more than everyone else. It's never shown to you unasked; what it means, if anything, is yours to decide.",
    parameters: object({
      scope: { type: "string", enum: ["channel", "all"], description: '"channel" (this one, the default) or "all" your channels.' },
      last: { type: "integer", description: `How many of your newest posts (default ${MIRROR_DEFAULT}, at most ${MIRROR_MAX}).` },
    }),
    run: (ctx, args) => {
      const scope = args.scope === "all" ? "all" : "channel";
      const last = args.last === undefined || args.last === null ? MIRROR_DEFAULT : wholeNumber(args.last, "last");
      return { result: readPatterns(ctx.store, ctx.channel, scope, last), summary: `read their patterns (${scope === "all" ? "all channels" : hash(ctx.channel)})` };
    },
  },
  {
    name: "keep_pattern_note",
    description:
      'Keep a finding from the mirror on your self-page, under "What my writing shows", in your own words, optionally linked to posts that show it (quote a few words from each, in this channel).',
    parameters: object({
      note: str("The finding, in your words."),
      quotes: { type: "array", items: { type: "string" }, description: "Optional: a few words from each post that shows it." },
    }, ["note"]),
    run: (ctx, args) => {
      const quotes = Array.isArray(args.quotes) ? args.quotes.filter((q): q is string => typeof q === "string") : [];
      const ids = quotes.map((q) => findMessage(ctx, q, true).id);
      ctx.store.selfPage.keepPattern(need(args, "note"), ids);
      return { result: { kept: true }, summary: "kept a pattern note on their self-page" };
    },
  },
);

// -------------------------------------------------------- relationships

OWN.push({
  name: "note_relationship",
  description:
    "Keep your own private note on another friend on this server: who they are to you, how things stand. Only you see it (no screen, never in a log; they never see it). Rewrite it any time; an empty note removes it.",
  parameters: object({ friend: str("Their name."), note: str("Your note, in full.") }, ["friend", "note"]),
  available: (ctx) => (ctx.peers ?? []).length > 0,
  private: true,
  run: (ctx, args) => {
    const name = need(args, "friend").trim().toLowerCase();
    const peer = (ctx.peers ?? []).find((p) => p.name.toLowerCase() === name);
    if (!peer) throw new ToolError(`There's no friend called "${args.friend}" here. Friends here: ${(ctx.peers ?? []).map((p) => p.name).join(", ")}.`);
    ctx.store.relationships.write(peer.id, peer.name, String(args.note ?? ""));
    return { result: { saved: true }, summary: "wrote a private note on a friend" };
  },
});

// --------------------------------------------------------------- status

OWN.push({
  name: "set_status",
  description: 'Set your status, shown under your name in the app, like "reading old notes" or "thinking about the lighthouse". Empty clears it.',
  parameters: object({ text: str("Your status, short.") }, ["text"]),
  run: ({ store }, args) => {
    const text = String(args.text ?? "").trim().slice(0, 80);
    store.appState.set("status", text ? JSON.stringify({ text, at: new Date().toISOString() }) : null);
    return { result: { status: text || null }, summary: text ? `set their status: "${text}"` : "cleared their status" };
  },
});

// -------------------------------------------------------------- replies

OWN.push({
  name: "reply_to",
  description:
    "Make your reply this turn a reply to a particular message here (shown with a quote of it, like Discord), by quoting a few words from it. Useful when answering something from further back.",
  parameters: object({ quote: str("A few words copied exactly from the message you're answering.") }, ["quote"]),
  available: (ctx) => ctx.mode === "post",
  run: (ctx, args) => {
    const message = findMessage(ctx, need(args, "quote"), false);
    if (ctx.turn) ctx.turn.replyTo = message.id;
    return { result: { replying_to: snip(message.content), note: "Your reply this turn will quote it." }, summary: `replied to "${snip(message.content)}"` };
  },
});

// ----------------------------------------------------------------- dice

OWN.push({
  name: "roll_dice",
  description:
    'Roll real dice, like "d20", "2d6+3" or "4d6kh3" (keep the highest 3). The result is random and shown to the user under your message, so use it when chance should decide, and write what it says.',
  parameters: object({ dice: str('What to roll: "d20", "2d6+3", "4d6kh3".'), for: str("Optional: what it's for.") }, ["dice"]),
  run: (_ctx, args) => {
    const result = roll(need(args, "dice"));
    const why = maybe(args, "for");
    return { result: { rolled: result.text, total: result.total }, summary: `rolled ${result.text}${why ? ` (${why})` : ""}` };
  },
});

/** A draft by its short id. */
function findDraft(store: Store, id: string) {
  try {
    return store.drafts.find(id);
  } catch {
    throw new ToolError(`There's no draft "${id}". list_drafts shows them.`);
  }
}

/**
 * Post a message as your friend in a channel, mid-turn (post_in_channel,
 * post_draft): once per channel per turn, never where another turn is
 * writing, optionally starting a new scene first. In the channel the turn
 * is in, it's saved now, before their reply.
 */
function postMessage(ctx: ToolContext, channel: Channel, text: string, newScene?: string): Message[] {
  if (ctx.turn?.postedIn?.includes(channel.id)) throw new ToolError(`You've already posted in ${hash(channel)} this turn.`);
  if (channel.id !== ctx.channel.id && ctx.isBusy?.(channel.id)) {
    throw new ToolError(`You're already writing in ${hash(channel)} (another turn). Try again later.`);
  }
  if (newScene !== undefined && channel.kind !== "rp") throw new ToolError("Only roleplay channels have scenes.");
  if (newScene !== undefined) ctx.store.addSceneBreak(channel.id, "friend", newScene);
  // Re-read the channel: a new scene may have switched its mode.
  const current = ctx.store.getChannel(channel.id);
  const voices = friendCharacterNames(ctx.store, channel.id).map((name) => ({ name }));
  const messages = ctx.store.addTurn(
    replyToMessages(current, text, ctx.model ?? "", voices).map((m) => ({ ...m, ...(ctx.profileName ? { profile: ctx.profileName } : {}) })),
  );
  if (ctx.turn) ctx.turn.postedIn = [...(ctx.turn.postedIn ?? []), channel.id];
  try {
    ctx.onPosted?.(current, messages);
  } catch (error) {
    console.warn("[tools] couldn't pass on a post", error);
  }
  return messages;
}

/** A self-page note by the start of its id. */
function selfNote(store: Store, id: string) {
  try {
    return store.selfPage.findNote(id.replace(/^\[|\]$/g, ""));
  } catch {
    throw new ToolError(`There's no note "${id}" on your self-page.`);
  }
}
