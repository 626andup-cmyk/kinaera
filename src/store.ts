/**
 * The store: reading and writing Kinaera's data.
 *
 * Everything lives in an SQLite database (`data/kinaera.db`); the table
 * layout is described in `src/db.ts`. The rest of the server only talks to
 * the store through the methods of the `Store` class below, and never writes
 * SQL itself. That keeps every query in one place.
 *
 * All methods are synchronous. Bun's SQLite driver answers immediately
 * (there is no network in between), so there is nothing to wait for.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { Notebook } from "./notebook.ts";
import { Profiles } from "./profiles.ts";
import { Comments, ToolLog } from "./activity.ts";
import { Inbox } from "./inbox.ts";
import { CheckLog } from "./check.ts";
import { Summaries } from "./summaries.ts";
import { WakeLog } from "./wakeups.ts";
import { Library } from "./library.ts";
import { Reactions } from "./reactions.ts";
import { AppState } from "./appstate.ts";
import { Interventions } from "./interventions.ts";
import { Identity } from "./identity.ts";
import { Journal } from "./journal.ts";
import { SelfPage } from "./selfpage.ts";
import { Verbatim } from "./verbatim.ts";
import { queueOrientation } from "./orientation.ts";
import { parseSections } from "./wording.ts";
import type {
  Category,
  Author,
  Channel,
  ChannelKind,
  ChannelMode,
  EntryField,
  Message,
  MessageHistory,
  MessageKind,
  Revision,
  Settings,
} from "./types.ts";

// The error types live in their own file (so the notebook can use them
// too); re-exported here, where most code already imports them from.
export { NotFoundError, ValidationError };

/** Where the starting friend prompt and character sheet are kept. */
const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");

/** Jev's model on nanoGPT, pinned: upgrade on purpose, not by surprise (see src/jev.ts). */
export const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";



// ------------------------------------------------------------- defaults

/**
 * Settings used until you change them. The friend prompts come from
 * `defaults/*.md` so they're easy to read and edit as plain text.
 *
 * Settings are merged over these every time they're read, so a setting added
 * in a newer version of Kinaera quietly gets its default.
 */
export function defaultSettings(): Settings {
  return {
    friendName: "Arlo",
    // Which profile writes each job. "" means the first profile. (Models and
    // their settings live in connection profiles; see src/profiles.ts.)
    rpAssignment: "",
    oocAssignment: "",
    themeOptions: {},
    friendPrompt: readDefault("friend.md"),
    literaryPrompt: readDefault("literary.md"),
    casualPrompt: readDefault("casual.md"),
    oocPrompt: readDefault("ooc.md"),
    historyLimit: 40,
    summaries: true,
    summaryEvery: 20,
    summaryAssignment: "",
    decisionModel: DEFAULT_DECISION_MODEL,
    decisionFallback: "",
    decisionConfidence: 0.8,
    wakeups: "normal",
    awayHours: 4,
    wakeCooldownMinutes: 60,
    quietStart: -1,
    quietEnd: 8,
    heartbeatHours: 0,
    friendAvatar: "",
    friendColor: -1,
    oocBubbles: true,
    typingBaseMs: 600,
    typingPerCharMs: 40,
    replyDelayMs: 2500,
    appTheme: "classic",
  };
}

/**
 * The example character a brand-new server's first RP channel starts with,
 * from `defaults/character.md`: one `Label: text` line per field, and a
 * `Name:` line for their name. Blank lines are skipped.
 */
export function defaultCharacter(): { name: string; fields: EntryField[] } {
  const fields: EntryField[] = [];
  for (const line of readDefault("character.md").split("\n")) {
    const match = line.match(/^\s*([^:\n]{1,30}):\s*(.+)$/);
    if (match) fields.push({ label: match[1]!.trim(), value: match[2]!.trim() });
  }
  const name = fields.find((f) => f.label.toLowerCase() === "name")?.value ?? "Ilse Marrow";
  return { name, fields: fields.filter((f) => f.label.toLowerCase() !== "name") };
}

function readDefault(fileName: string): string {
  const path = join(DEFAULTS_DIR, fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// ------------------------------------------------------------ validation

/**
 * Limits for each field. The validators below use these to reject nonsense
 * (a negative temperature, a 10 MB channel name) before it is saved.
 */
const LIMITS = {
  historyLimit: { min: 1, max: 1000 },
  summaryEvery: { min: 2, max: 500 },
  decisionConfidence: { min: 0.5, max: 0.99 },
  awayHours: { min: 0.25, max: 720 },
  wakeCooldownMinutes: { min: 1, max: 10_080 },
  hour: { min: -1, max: 23 },
  heartbeatHours: { min: 0, max: 168 },
  typingBaseMs: { min: 0, max: 10_000 },
  typingPerCharMs: { min: 0, max: 1000 },
  replyDelayMs: { min: 0, max: 30_000 },
  /** Longest friend prompt, in characters. */
  longText: 100_000,
  /** Longest name (channel, friend), in characters. */
  name: 100,
} as const;

/**
 * Check a partial settings update coming from the browser.
 *
 * Anything arriving over the network is untrusted, even from your own app, so
 * each field is checked for the right type and range. Unknown fields are
 * dropped. Returns the cleaned update, or throws an error describing the first
 * problem found.
 */
export function validateSettings(input: unknown): Partial<Settings> {
  const raw = requireObject(input, "Settings");
  const clean: Partial<Settings> = {};

  if (raw.friendName !== undefined) clean.friendName = name(raw.friendName, "friendName");
  for (const key of ["friendPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"] as const) {
    if (raw[key] !== undefined) clean[key] = longText(raw[key], key);
  }

  // Only the form is checked here; the server checks the profile or
  // roulette exists.
  if (raw.rpAssignment !== undefined) clean.rpAssignment = assignment(raw.rpAssignment, "rpAssignment") ?? "";
  if (raw.oocAssignment !== undefined) clean.oocAssignment = assignment(raw.oocAssignment, "oocAssignment") ?? "";
  if (raw.summaryAssignment !== undefined) {
    clean.summaryAssignment = assignment(raw.summaryAssignment, "summaryAssignment") ?? "";
  }
  if (raw.historyLimit !== undefined) {
    clean.historyLimit = numberInRange(raw.historyLimit, "historyLimit", LIMITS.historyLimit, true);
  }
  if (raw.summaryEvery !== undefined) {
    clean.summaryEvery = numberInRange(raw.summaryEvery, "summaryEvery", LIMITS.summaryEvery, true);
  }
  if (raw.decisionModel !== undefined) {
    if (typeof raw.decisionModel !== "string" || raw.decisionModel.trim().length > 200) {
      throw new ValidationError("decisionModel must be a model id");
    }
    clean.decisionModel = raw.decisionModel.trim();
  }
  if (raw.decisionFallback !== undefined) {
    const value = assignment(raw.decisionFallback, "decisionFallback") ?? "";
    if (value.startsWith("roulette:")) throw new ValidationError("decisionFallback must be a profile, not a roulette");
    clean.decisionFallback = value;
  }
  if (raw.decisionConfidence !== undefined) {
    clean.decisionConfidence = numberInRange(raw.decisionConfidence, "decisionConfidence", LIMITS.decisionConfidence, false);
  }
  if (raw.wakeups !== undefined) {
    if (!["off", "quiet", "normal", "chatty"].includes(raw.wakeups as string)) {
      throw new ValidationError('wakeups must be "off", "quiet", "normal" or "chatty"');
    }
    clean.wakeups = raw.wakeups as Settings["wakeups"];
  }
  if (raw.awayHours !== undefined) clean.awayHours = numberInRange(raw.awayHours, "awayHours", LIMITS.awayHours, false);
  if (raw.wakeCooldownMinutes !== undefined) {
    clean.wakeCooldownMinutes = numberInRange(raw.wakeCooldownMinutes, "wakeCooldownMinutes", LIMITS.wakeCooldownMinutes, true);
  }
  for (const key of ["quietStart", "quietEnd"] as const) {
    if (raw[key] !== undefined) clean[key] = numberInRange(raw[key], key, LIMITS.hour, true);
  }
  if (raw.heartbeatHours !== undefined) {
    clean.heartbeatHours = numberInRange(raw.heartbeatHours, "heartbeatHours", LIMITS.heartbeatHours, false);
    // Five minutes at the shortest (hours, so 0.25 is every 15 minutes).
    if (clean.heartbeatHours > 0 && clean.heartbeatHours < 5 / 60) throw new ValidationError("heartbeatHours must be 0 (off) or at least 5 minutes (0.0834)");
  }
  if (raw.friendAvatar !== undefined) {
    if (typeof raw.friendAvatar !== "string" || [...raw.friendAvatar.trim()].length > 8) {
      throw new ValidationError("friendAvatar must be an emoji (or empty)");
    }
    clean.friendAvatar = raw.friendAvatar.trim();
  }
  if (raw.friendColor !== undefined) clean.friendColor = numberInRange(raw.friendColor, "friendColor", { min: -1, max: 359 }, true);
  if (raw.oocBubbles !== undefined) {
    if (typeof raw.oocBubbles !== "boolean") throw new ValidationError("oocBubbles must be true or false");
    clean.oocBubbles = raw.oocBubbles;
  }
  for (const key of ["typingBaseMs", "typingPerCharMs", "replyDelayMs"] as const) {
    if (raw[key] !== undefined) clean[key] = numberInRange(raw[key], key, LIMITS[key], true);
  }
  if (raw.summaries !== undefined) {
    if (typeof raw.summaries !== "boolean") throw new ValidationError("summaries must be true or false");
    clean.summaries = raw.summaries;
  }
  // Only the id's form is checked here; the server checks the theme exists.
  if (raw.appTheme !== undefined) clean.appTheme = themeId(raw.appTheme, "appTheme");
  if (raw.themeOptions !== undefined) clean.themeOptions = themeOptions(raw.themeOptions);

  return clean;
}

/**
 * A profile or roulette assignment: `"profile:<id>"` or `"roulette:<id>"`.
 * `null` or `""` means none (returned as `null`).
 */
function assignment(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^(profile|roulette):[\w-]{1,100}$/.test(value)) {
    throw new ValidationError(`${field} must be "profile:<id>" or "roulette:<id>"`);
  }
  return value;
}

/**
 * Slider values for themes: `{ "rainy-window": { "bubble-transparency": 0.6 } }`.
 * Only the shape is checked; each theme's own ranges are applied by the app.
 */
function themeOptions(value: unknown): Settings["themeOptions"] {
  const themes = requireObject(value, "themeOptions");
  const entries = Object.entries(themes);
  if (entries.length > 100) throw new ValidationError("themeOptions has too many themes");
  return Object.fromEntries(
    entries.map(([id, options]) => {
      themeId(id, "themeOptions");
      const values = Object.entries(requireObject(options, "themeOptions"));
      if (values.length > 20) throw new ValidationError("themeOptions has too many options for one theme");
      for (const [key, number] of values) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || typeof number !== "number" || !Number.isFinite(number)) {
          throw new ValidationError("themeOptions values must be numbers, by option id");
        }
      }
      return [id, Object.fromEntries(values) as Record<string, number>];
    }),
  );
}

/** A theme id: lowercase letters, digits and dashes. */
function themeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new ValidationError(`${field} must be a theme id`);
  }
  return value;
}

/** Check a channel mode. */
function mode(value: unknown): ChannelMode {
  if (value !== "literary" && value !== "casual") throw new ValidationError('mode must be "literary" or "casual"');
  return value;
}

/** The fields you give when creating a channel. */
export interface NewChannel {
  name: string;
  kind: ChannelKind;
  /** RP channels: the first scene's mode. Defaults to literary. */
  mode?: ChannelMode;
}

/** Check the body of a "create channel" request. */
export function validateNewChannel(input: unknown): NewChannel {
  const raw = requireObject(input, "Channel");
  if (raw.kind !== "rp" && raw.kind !== "ooc") {
    throw new ValidationError('kind must be "rp" or "ooc"');
  }
  return {
    name: name(raw.name, "name"),
    kind: raw.kind,
    ...(raw.mode !== undefined ? { mode: mode(raw.mode) } : {}),
  };
}

/**
 * The channel fields that can be changed after creation. `mode` is the mode
 * you *ask* for; see `Store.updateChannel` for when it takes effect.
 */
export type ChannelUpdate = Partial<Pick<Channel, "name" | "mode" | "theme" | "assignment" | "categoryId">>;

/** Check a partial channel update. The kind can't be changed, so it's ignored. */
export function validateChannelUpdate(input: unknown): ChannelUpdate {
  const raw = requireObject(input, "Channel");
  const clean: ChannelUpdate = {};
  if (raw.name !== undefined) clean.name = name(raw.name, "name");
  if (raw.mode !== undefined) clean.mode = mode(raw.mode);
  // `null` (or "") means "use the app theme".
  if (raw.theme !== undefined) clean.theme = raw.theme === null || raw.theme === "" ? null : themeId(raw.theme, "theme");
  // `null` (or "") means "use the server-wide profile for this kind of channel".
  if (raw.assignment !== undefined) clean.assignment = assignment(raw.assignment, "assignment");
  // `null` (or "") means "in no category". The store checks it exists.
  if (raw.categoryId !== undefined) {
    if (raw.categoryId !== null && typeof raw.categoryId !== "string") throw new ValidationError("categoryId must be a category id, or null");
    clean.categoryId = raw.categoryId || null;
  }
  return clean;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

/** A required, non-empty, reasonably short piece of text, trimmed. */
function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be non-empty text`);
  if (value.trim().length > LIMITS.name) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

function longText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length > LIMITS.longText) throw new ValidationError(`${field} is too long`);
  return value;
}

function numberInRange(
  value: unknown,
  field: string,
  range: { min: number; max: number },
  wholeNumber: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  if (wholeNumber && !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`);
  }
  if (value < range.min || value > range.max) {
    throw new ValidationError(`${field} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

// ----------------------------------------------------------- row mapping

/*
 * The database uses snake_case column names (`channel_id`), while the rest
 * of the code uses camelCase (`channelId`). These types describe rows exactly
 * as SQLite returns them, and the functions below convert them.
 */

interface ChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  pending_mode: ChannelMode | null;
  theme: string | null;
  assignment: string | null;
  position: number;
  category_id: string | null;
  created_at: string;
}

interface CategoryRow {
  id: string;
  name: string;
  position: number;
  collapsed: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  channel_id: string;
  kind: MessageKind;
  mode: ChannelMode | null;
  turn_id: string | null;
  author: Author;
  content: string;
  created_at: string;
  edited_at: string | null;
  edited_by: Author | null;
  deleted_at: string | null;
  deleted_by: Author | null;
  superseded_by: string | null;
  alternates: number;
  model: string | null;
  profile: string | null;
  /** A JSON array of character names, built by the query itself. */
  characters: string;
  /** A JSON array of attached notebook entry ids, built by the query itself. */
  attachments: string;
  /** A JSON array of {emoji, author}, built by the query itself. */
  reactions: string;
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    pendingMode: row.pending_mode,
    theme: row.theme,
    assignment: row.assignment,
    position: row.position,
    categoryId: row.category_id,
    createdAt: row.created_at,
  };
}

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, position: row.position, collapsed: row.collapsed === 1, createdAt: row.created_at };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    kind: row.kind,
    author: row.author,
    content: row.content,
    mode: row.mode,
    turnId: row.turn_id,
    characters: JSON.parse(row.characters) as string[],
    attachments: JSON.parse(row.attachments) as string[],
    reactions: JSON.parse(row.reactions) as Message["reactions"],
    createdAt: row.created_at,
    // Only include optional fields when they have a value.
    alternates: row.alternates,
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.edited_by ? { editedBy: row.edited_by } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at, deletedBy: row.deleted_by! } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
  };
}

/**
 * The start of every query that reads messages. For each message, the inner
 * `SELECT` gathers the characters it voices from `message_characters`, in
 * order, into one JSON array (`json_group_array`), so one query returns
 * everything about a message.
 */
const SELECT_MESSAGES = `
  SELECT m.id, m.channel_id, m.kind, m.mode, m.turn_id, m.author, m.content, m.created_at, m.edited_at, m.model, m.profile,
    m.edited_by, m.deleted_at, m.deleted_by, m.superseded_by,
    (SELECT COUNT(DISTINCT COALESCE(a.turn_id, a.id)) FROM messages a
       WHERE m.turn_id IS NOT NULL AND a.superseded_by = m.turn_id AND a.channel_id = m.channel_id) AS alternates,
    (SELECT json_group_array(character_name)
       FROM (SELECT character_name FROM message_characters
              WHERE message_id = m.id ORDER BY position)) AS characters,
    (SELECT json_group_array(entry_id) FROM message_attachments WHERE message_id = m.id) AS attachments,
    (SELECT json_group_array(json_object('emoji', emoji, 'author', author))
       FROM (SELECT emoji, author FROM reactions WHERE message_id = m.id ORDER BY created_at, rowid)) AS reactions
  FROM messages m`;

/**
 * Messages that are in the chat: not deleted, and not replaced by a
 * regeneration. (Those stay in the table, for history.)
 */
const LIVE = "m.deleted_at IS NULL AND m.superseded_by IS NULL";

// ----------------------------------------------------------------- store

/** The fields you give when adding a message. */
export interface NewMessage {
  channelId: string;
  author: Author;
  content: string;
  characters?: string[];
  model?: string;
  /** The name of the profile that wrote it (friend messages). */
  profile?: string;
  /** Defaults to "post". Use `addSceneBreak` for scene breaks. */
  kind?: MessageKind;
  /** RP channels: the mode it was written in. Defaults to `null`. */
  mode?: ChannelMode | null;
  /** Shared by messages written together. Defaults to `null`. */
  turnId?: string | null;
}

export class Store {
  readonly db: Database;
  /** Characters, lore and each channel's cast (see `src/notebook.ts`). */
  readonly notebook: Notebook;
  /** Connection profiles and roulettes (see `src/profiles.ts`). */
  readonly profiles: Profiles;
  /** Every tool call your friend makes (see `src/activity.ts`). */
  readonly toolLog: ToolLog;
  /** Comment threads on messages. */
  readonly comments: Comments;
  /** What your friend asks of you: asks, and proposals to approve (see `src/inbox.ts`). */
  readonly inbox: Inbox;
  /** Every check your friend made (see `src/check.ts`). */
  readonly checkLog: CheckLog;
  /** Scene summaries, the story so far and the digest (see `src/summaries.ts`). */
  readonly summaries: Summaries;
  /** The reference library: long texts your friend can search. */
  readonly library: Library;
  /** Emoji reactions on messages, and custom emojis. */
  readonly reactions: Reactions;
  /** Small values kept between runs. */
  readonly appState: AppState;
  /** Everything you do that affects your friend (see `src/interventions.ts`). */
  readonly interventions: Interventions;
  /** Your friend's identity and tastes, every version kept (see `src/identity.ts`). */
  readonly identity: Identity;
  /** Your friend's self-page (see `src/selfpage.ts`). */
  readonly selfPage: SelfPage;
  /** Your friend's private journal (see `src/journal.ts`). */
  readonly journal: Journal;
  /** Moments your friend asked to keep in full (see `src/verbatim.ts`). */
  readonly verbatim: Verbatim;
  /** Your friend's recent wake-ups, and what came of them (see `src/wakeups.ts`). */
  readonly wakeLog: WakeLog;
  /**
   * Goes up by one whenever any message changes (added, edited, deleted).
   * The app checks it to notice new messages it didn't ask for, like a
   * wake-up (stage 8).
   */
  revision = 0;
  private readonly messageWatchers: ((channelId: string) => void)[] = [];

  /**
   * Be told whenever a channel's messages change (added, edited, deleted):
   * summaries catch up (src/summarizer.ts).
   */
  watchMessages(watcher: (channelId: string) => void): void {
    this.messageWatchers.push(watcher);
  }

  private messagesChanged(channelId: string): void {
    this.revision++;
    for (const watcher of this.messageWatchers) watcher(channelId);
  }

  /**
   * Open (or create) the database inside `dataDir`.
   *
   * The very first time, the database is filled with starting content: a
   * `#story` channel with the example character pinned to it, and an `#ooc`
   * channel.
   *
   * @param dataDir  Folder for the database. Created if it doesn't exist.
   *                 Pass `":memory:"` for a throwaway database (for tests).
   */
  constructor(dataDir: string, options: { example?: boolean } = {}) {
    const inMemory = dataDir === ":memory:";
    if (!inMemory) mkdirSync(dataDir, { recursive: true });
    const path = inMemory ? ":memory:" : join(dataDir, "kinaera.db");

    const isNew = inMemory || !existsSync(path);
    this.db = openDatabase(path);
    this.notebook = new Notebook(this.db);
    this.profiles = new Profiles(this.db);
    this.toolLog = new ToolLog(this.db);
    this.comments = new Comments(this.db);
    this.inbox = new Inbox(this.db);
    this.checkLog = new CheckLog(this.db);
    this.summaries = new Summaries(this.db);
    this.library = new Library(this.db, (id) => this.hasChannel(id));
    // In memory (tests), custom emoji files go to a throwaway folder.
    this.reactions = new Reactions(this.db, inMemory ? join(tmpdir(), `kinaera-emojis-${crypto.randomUUID()}`) : dataDir, () => this.revision++);
    this.wakeLog = new WakeLog(this.db);
    this.appState = new AppState(this.db);
    this.interventions = new Interventions(this.db);
    this.identity = new Identity(this.db, (identity) => this.updateSettings({ friendPrompt: identity }));
    this.selfPage = new SelfPage(this.db);
    this.journal = new Journal(this.db);
    this.verbatim = new Verbatim(this.db);

    if (isNew) {
      this.seed(options.example ?? true);
      // A new friend's first turn of their own is an orientation.
      queueOrientation(this);
    }
    // Every friend has an identity of their own, and a practice channel.
    if (!this.identity.current()) this.identity.begin(this.getSettings().friendPrompt, isNew && options.example !== false ? readDefault("tastes.md") : "");
    this.ensurePractice();
  }

  /**
   * Orientation's practice channel and Practice folder (src/orientation.ts),
   * made if they aren't there yet: the channel, and a few sample notes
   * (defaults/practice.md) pinned only to it.
   */
  ensurePractice(): Channel {
    let channel = this.practiceChannel();
    if (!channel) channel = this.createChannel({ name: "practice", kind: "practice" });
    if (!this.notebook.practiceFolder()) {
      const folder = this.notebook.createPracticeFolder();
      for (const [heading, body] of Object.entries(parseSections(readDefault("practice.md")))) {
        const match = heading.match(/^(.+?)\s*\((character|lore)\)\s*$/);
        if (!match) continue;
        const fields = body
          .split("\n")
          .map((line) => line.match(/^\s*([^:\n]{1,30}):\s*(.+)$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => ({ label: m[1]!.trim(), value: m[2]!.trim() }));
        const entry = this.notebook.createEntry("friend", { kind: match[2], name: match[1]!.trim(), fields });
        this.notebook.updateEntrySettings("friend", entry.id, { folderId: folder.id });
        this.notebook.pin("friend", channel.id, entry.id);
      }
    }
    return channel;
  }

  /**
   * Starting content for a brand-new friend: a #story and an #ooc channel,
   * and (for the very first friend) the example character in #story.
   */
  private seed(example: boolean): void {
    const story = this.createChannel({ name: "story", kind: "rp" });
    this.createChannel({ name: "ooc", kind: "ooc" });
    if (!example) return;
    const character = defaultCharacter();
    const entry = this.notebook.createEntry("user", {
      kind: "character",
      owner: "friend",
      name: character.name,
      fields: character.fields,
    });
    this.notebook.pin("user", story.id, entry.id);
  }

  /** Close the database. Only needed in tests, which open many. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------- settings

  /** The current settings, with defaults for anything never changed. */
  getSettings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...defaultSettings(), ...saved };
  }

  /** Save an already-validated settings update. Returns the new settings. */
  updateSettings(update: Partial<Settings>): Settings {
    // "Upsert": insert the key, or if it already exists, update its value.
    const upsert = this.db.query(
      "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(update)) {
        if (value !== undefined) upsert.run({ key, value: JSON.stringify(value) });
      }
    })();
    return this.getSettings();
  }

  // -------------------------------------------------------------- channels

  /**
   * Every channel, in sidebar order. The practice channel isn't one of them:
   * it's your friend's own, shown apart (see `practiceChannel`).
   */
  listChannels(): Channel[] {
    const rows = this.db.query("SELECT * FROM channels WHERE kind != 'practice' ORDER BY position").all() as ChannelRow[];
    return rows.map(toChannel);
  }

  /** Your friend's practice channel (made with the store, so always there after startup). */
  practiceChannel(): Channel | null {
    const row = this.db.query("SELECT * FROM channels WHERE kind = 'practice'").get() as ChannelRow | null;
    return row ? toChannel(row) : null;
  }

  /** One channel. Throws `NotFoundError` if there's no such channel. */
  getChannel(id: string): Channel {
    const row = this.db.query("SELECT * FROM channels WHERE id = $id").get({ id }) as ChannelRow | null;
    if (!row) throw new NotFoundError("channel");
    return toChannel(row);
  }

  /** Whether a channel exists. */
  hasChannel(id: string): boolean {
    return this.db.query("SELECT 1 FROM channels WHERE id = $id").get({ id }) !== null;
  }

  /** Create a channel at the bottom of the sidebar. */
  createChannel(input: NewChannel & { categoryId?: string | null }): Channel {
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM channels WHERE kind != 'practice'").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO channels (id, name, kind, mode, position, category_id, created_at)
         VALUES ($id, $name, $kind, $mode, $position, $categoryId, $createdAt)`,
      )
      .run({
        id,
        name: input.name,
        kind: input.kind,
        mode: input.mode ?? "literary",
        position: next,
        categoryId: input.categoryId ? this.getCategory(input.categoryId).id : null,
        createdAt: new Date().toISOString(),
      });
    return this.getChannel(id);
  }

  /**
   * Change a channel's name, mode or theme. Returns the updated channel.
   * (Its cast is changed by pinning entries; see `src/notebook.ts`.)
   *
   * A mode change follows the design's rule that a scene never mixes
   * styles:
   *
   *   - If the current scene has no messages yet (a new channel, or just
   *     after a scene break), the new mode applies right away.
   *   - Otherwise it's saved as `pendingMode` and applies at the next scene
   *     break (`addSceneBreak`). Asking for the current mode again cancels
   *     a pending change.
   */
  updateChannel(id: string, update: ChannelUpdate): Channel {
    const channel = this.getChannel(id); // throws if missing
    const { mode: requestedMode, ...rest } = update;
    const merged = { ...channel, ...rest };
    if (requestedMode !== undefined && channel.kind === "rp") {
      if (this.currentSceneIsEmpty(id)) {
        merged.mode = requestedMode;
        merged.pendingMode = null;
      } else {
        merged.pendingMode = requestedMode === channel.mode ? null : requestedMode;
      }
    }
    this.db
      .query(
        `UPDATE channels SET name = $name, mode = $mode, pending_mode = $pendingMode, theme = $theme,
                assignment = $assignment, category_id = $categoryId
         WHERE id = $id`,
      )
      .run({
        id,
        name: merged.name,
        mode: merged.mode,
        pendingMode: merged.pendingMode,
        theme: merged.theme,
        assignment: merged.assignment,
        categoryId: merged.categoryId === null ? null : this.getCategory(merged.categoryId).id,
      });
    return this.getChannel(id);
  }

  /**
   * Stop using a theme that's been deleted: the app theme goes back to
   * Classic, and channels using it go back to the app theme.
   */
  forgetTheme(themeId: string): void {
    this.db.transaction(() => {
      const settings = this.getSettings();
      if (settings.appTheme === themeId) this.updateSettings({ appTheme: "classic" });
      if (settings.themeOptions[themeId]) {
        const { [themeId]: _gone, ...rest } = settings.themeOptions;
        this.updateSettings({ themeOptions: rest });
      }
      this.db.query("UPDATE channels SET theme = NULL WHERE theme = $themeId").run({ themeId });
    })();
  }

  /**
   * Whether the channel's current scene has no messages yet: nothing after
   * its latest scene break, or nothing at all if it has none.
   */
  currentSceneIsEmpty(channelId: string): boolean {
    const { count } = this.db
      .query(
        `SELECT COUNT(*) AS count FROM messages m
          WHERE m.channel_id = $channelId AND m.kind = 'post' AND ${LIVE}
            AND m.seq > COALESCE(
              (SELECT MAX(seq) FROM messages m WHERE m.channel_id = $channelId AND m.kind = 'scene_break' AND ${LIVE}), 0)`,
      )
      .get({ channelId }) as { count: number };
    return count === 0;
  }

  /**
   * Put the channels in a new order.
   *
   * @param ids  Every channel id, in the new order. Leaving one out or adding
   *             an unknown one is an error, so the order can never end up
   *             with gaps or duplicates.
   */
  reorderChannels(ids: string[], categoryOf?: Record<string, string | null>): Channel[] {
    const existing = new Set(this.listChannels().map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every channel exactly once.");
    }
    // Moving channels between categories (a drag in the sidebar) happens
    // with the new order, all at once.
    const categories = new Set(this.listCategories().map((c) => c.id));
    for (const [channelId, categoryId] of Object.entries(categoryOf ?? {})) {
      if (!existing.has(channelId)) throw new ValidationError("categories must map channel ids to category ids.");
      if (categoryId !== null && !categories.has(categoryId)) throw new NotFoundError("category");
    }
    const setPosition = this.db.query("UPDATE channels SET position = $position WHERE id = $id");
    const setCategory = this.db.query("UPDATE channels SET category_id = $categoryId WHERE id = $id");
    this.db.transaction(() => {
      ids.forEach((id, position) => setPosition.run({ id, position }));
      for (const [id, categoryId] of Object.entries(categoryOf ?? {})) setCategory.run({ id, categoryId });
    })();
    return this.listChannels();
  }

  // ------------------------------------------------------------ categories

  /** Every category, in sidebar order. */
  listCategories(): Category[] {
    return (this.db.query("SELECT * FROM categories ORDER BY position, created_at").all() as CategoryRow[]).map(toCategory);
  }

  getCategory(id: string): Category {
    const row = this.db.query("SELECT * FROM categories WHERE id = $id").get({ id }) as CategoryRow | null;
    if (!row) throw new NotFoundError("category");
    return toCategory(row);
  }

  /** Make a category, at the bottom. */
  createCategory(input: unknown): Category {
    const raw = requireObject(input, "Category");
    const id = crypto.randomUUID();
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM categories").get() as { next: number };
    this.db
      .query("INSERT INTO categories (id, name, position, collapsed, created_at) VALUES ($id, $name, $next, 0, $now)")
      .run({ id, name: name(raw.name, "name"), next, now: new Date().toISOString() });
    return this.getCategory(id);
  }

  /** Rename a category, or fold it up (or open it). */
  updateCategory(id: string, input: unknown): Category {
    const raw = requireObject(input, "Category");
    const current = this.getCategory(id);
    if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") throw new ValidationError("collapsed must be true or false");
    this.db.query("UPDATE categories SET name = $name, collapsed = $collapsed WHERE id = $id").run({
      id,
      name: raw.name !== undefined ? name(raw.name, "name") : current.name,
      collapsed: (raw.collapsed ?? current.collapsed) ? 1 : 0,
    });
    return this.getCategory(id);
  }

  /** Delete a category. Its channels stay, outside any category. */
  deleteCategory(id: string): void {
    this.getCategory(id);
    this.db.query("DELETE FROM categories WHERE id = $id").run({ id });
  }

  /** Put the categories in a new order (every one, exactly once). */
  reorderCategories(ids: string[]): Category[] {
    const existing = new Set(this.listCategories().map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every category exactly once.");
    }
    const set = this.db.query("UPDATE categories SET position = $position WHERE id = $id");
    this.db.transaction(() => ids.forEach((id, position) => set.run({ id, position })))();
    return this.listCategories();
  }

  /**
   * Delete a channel and, through `ON DELETE CASCADE`, all its messages.
   * Throws `NotFoundError` if there's no such channel.
   */
  deleteChannel(id: string): void {
    if (this.hasChannel(id) && this.getChannel(id).kind === "practice") {
      throw new ValidationError("The practice channel is your friend's own, and can't be deleted.");
    }
    const result = this.db.query("DELETE FROM channels WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("channel");
    this.library.channelDeleted(id);
  }

  // -------------------------------------------------------------- messages

  /**
   * Every message in a channel's chat, oldest first: not deleted ones, or
   * replies that were regenerated (those are in `history`).
   */
  getMessages(channelId: string): Message[] {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const rows = this.db.query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND ${LIVE} ORDER BY m.seq`).all({
      channelId,
    }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * One message, even a deleted or replaced one (see `deletedAt` and
   * `supersededBy`). Throws `NotFoundError` if there's no such message.
   */
  getMessage(id: string): Message {
    const row = this.db.query(`${SELECT_MESSAGES} WHERE m.id = $id`).get({ id }) as MessageRow | null;
    if (!row) throw new NotFoundError("message");
    return toMessage(row);
  }

  /** One message that's in the chat. Throws `NotFoundError` if it isn't (deleted or replaced). */
  getLiveMessage(id: string): Message {
    const message = this.getMessage(id);
    if (message.deletedAt || message.supersededBy) throw new NotFoundError("message");
    return message;
  }

  /** The newest message in a channel's chat, or `undefined` if it's empty. */
  lastMessage(channelId: string): Message | undefined {
    const row = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND ${LIVE} ORDER BY m.seq DESC LIMIT 1`)
      .get({ channelId }) as MessageRow | null;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Add a message to the end of a channel.
   *
   * @param createdAt  Only for importing old messages; new ones get "now".
   */
  addMessage(input: NewMessage & { id?: string; createdAt?: string; editedAt?: string }): Message {
    const id = input.id ?? crypto.randomUUID();
    const insertMessage = this.db.query(
      `INSERT INTO messages (id, channel_id, kind, mode, turn_id, author, content, created_at, edited_at, model, profile)
       VALUES ($id, $channelId, $kind, $mode, $turnId, $author, $content, $createdAt, $editedAt, $model, $profile)`,
    );
    const insertCharacter = this.db.query(
      "INSERT OR IGNORE INTO message_characters (message_id, character_name, position) VALUES ($id, $name, $position)",
    );

    // The message and its characters are saved together or not at all.
    this.db.transaction(() => {
      insertMessage.run({
        id,
        channelId: input.channelId,
        kind: input.kind ?? "post",
        mode: input.mode ?? null,
        turnId: input.turnId ?? null,
        author: input.author,
        content: input.content,
        createdAt: input.createdAt ?? new Date().toISOString(),
        editedAt: input.editedAt ?? null,
        model: input.model ?? null,
        profile: input.profile ?? null,
      });
      (input.characters ?? []).forEach((name, position) => insertCharacter.run({ id, name, position }));
    })();

    this.messagesChanged(input.channelId);
    return this.getMessage(id);
  }

  /**
   * Add several messages at once, all or nothing, sharing a new turn id.
   * Used for a casual reply's bubbles, or several lines you sent together.
   */
  addTurn(messages: Omit<NewMessage, "turnId">[], turnId: string = crypto.randomUUID()): Message[] {
    return this.db.transaction(() => messages.map((m) => this.addMessage({ ...m, turnId })))();
  }

  /**
   * Put a scene break at the end of a channel.
   *
   * If a mode change is waiting (`pendingMode`), this is where it takes
   * effect: the new scene starts in the new mode. Both happen in one
   * transaction.
   *
   * @returns The scene break, and the channel as it is afterwards.
   */
  addSceneBreak(channelId: string, author: Author, title: string): { sceneBreak: Message; channel: Channel } {
    const channel = this.getChannel(channelId); // throws if missing
    if (channel.kind !== "rp") throw new ValidationError("Scene breaks are only for roleplay channels.");

    return this.db.transaction(() => {
      const sceneBreak = this.addMessage({ channelId, author, content: title.trim(), kind: "scene_break" });
      if (channel.pendingMode) {
        this.db
          .query("UPDATE channels SET mode = pending_mode, pending_mode = NULL WHERE id = $channelId")
          .run({ channelId });
      }
      return { sceneBreak, channel: this.getChannel(channelId) };
    })();
  }

  /**
   * The friend's most recent turn in a channel: every message of it (one
   * for a literary post, several bubbles for a casual reply), oldest first.
   * Empty if the channel doesn't end on a friend post.
   */
  lastFriendTurn(channelId: string): Message[] {
    const last = this.lastMessage(channelId);
    if (!last || last.kind !== "post" || last.author !== "friend") return [];
    if (!last.turnId) return [last];
    const rows = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.turn_id = $turnId AND ${LIVE} ORDER BY m.seq`)
      .all({ channelId, turnId: last.turnId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Change a message's text. Nothing is overwritten: the first edit also
   * saves the original, and every version is kept (see `history`).
   *
   * @param by  Who's editing. Your friend may only edit their own messages.
   * @throws NotFoundError   if the message isn't in the chat.
   * @throws ValidationError if your friend tries to edit someone else's.
   */
  editMessage(id: string, content: string, by: Author = "user"): Message {
    const message = this.getLiveMessage(id);
    if (by === "friend" && message.author !== "friend") throw new ValidationError("You can only edit your own messages.");
    if (content === message.content) return message;
    this.summaries.messageChanging(message, false);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const insert = this.db.query(
        "INSERT INTO message_revisions (message_id, content, author, created_at) VALUES ($id, $content, $author, $at)",
      );
      const { n } = this.db.query("SELECT COUNT(*) AS n FROM message_revisions WHERE message_id = $id").get({ id }) as { n: number };
      if (n === 0) insert.run({ id, content: message.content, author: message.author, at: message.createdAt });
      insert.run({ id, content, author: by, at: now });
      this.db.query("UPDATE messages SET content = $content, edited_at = $now, edited_by = $by WHERE id = $id").run({ id, content, now, by });
      if (by === "user" && message.author === "friend") {
        this.interventions.add({
          kind: "edit",
          summary: `The user edited ${message.kind === "scene_break" ? "the title of a scene break you made" : "your message"} in #${this.getChannel(message.channelId).name}.`,
          channelId: message.channelId,
          messageId: id,
        });
      }
    })();
    this.messagesChanged(message.channelId);
    return this.getMessage(id);
  }

  /**
   * Delete a message: it leaves the chat (and every prompt), but stays in
   * history as a tombstone.
   *
   * @param by  Who's deleting. Your friend may only delete their own messages.
   */
  deleteMessage(id: string, by: Author = "user"): void {
    const message = this.getLiveMessage(id);
    if (by === "friend" && message.author !== "friend") throw new ValidationError("You can only delete your own messages.");
    this.summaries.messageChanging(message, true);
    this.db.transaction(() => {
      this.db.query("UPDATE messages SET deleted_at = $now, deleted_by = $by WHERE id = $id").run({ id, now: new Date().toISOString(), by });
      if (by === "user" && message.author === "friend") {
        this.interventions.add({
          kind: "delete",
          summary: `The user deleted ${message.kind === "scene_break" ? "a scene break you made" : "your message"} in #${this.getChannel(message.channelId).name}: "${snippet(message.content)}"`,
          channelId: message.channelId,
          messageId: id,
        });
      }
    })();
    this.messagesChanged(message.channelId);
  }

  /**
   * A regeneration: the old reply leaves the chat, replaced by the new
   * turn `turnId`, and is kept as an alternate of it.
   */
  supersede(ids: string[], turnId: string): void {
    if (ids.length === 0) return;
    const messages = ids.map((id) => this.getLiveMessage(id));
    for (const message of messages) this.summaries.messageChanging(message, true);
    const mark = this.db.query("UPDATE messages SET superseded_by = $turnId WHERE id = $id");
    this.db.transaction(() => {
      for (const message of messages) mark.run({ id: message.id, turnId });
    })();
    this.messagesChanged(messages[0]!.channelId);
  }

  /**
   * Everything that happened to a message: every version of its text, and
   * the replies it replaced, including ones those replaced in turn.
   */
  history(id: string): MessageHistory {
    const message = this.getMessage(id);
    const revisions = (
      this.db
        .query("SELECT content, author, created_at FROM message_revisions WHERE message_id = $id ORDER BY id")
        .all({ id }) as { content: string; author: Author; created_at: string }[]
    ).map((r): Revision => ({ content: r.content, author: r.author, createdAt: r.created_at }));
    const alternates: Message[] = [];
    const seen = new Set<string>();
    let turns = message.turnId ? [message.turnId] : [];
    while (turns.length > 0) {
      const next: string[] = [];
      for (const turnId of turns) {
        if (seen.has(turnId)) continue;
        seen.add(turnId);
        const rows = this.db
          .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.superseded_by = $turnId ORDER BY m.seq`)
          .all({ channelId: message.channelId, turnId }) as MessageRow[];
        for (const row of rows) {
          alternates.push(toMessage(row));
          if (row.turn_id) next.push(row.turn_id);
        }
      }
      turns = next;
    }
    alternates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { message, revisions, alternates };
  }

  /**
   * Attach notebook entries to a message, so they're sent to your friend
   * with it. Entries already attached are skipped.
   */
  attach(messageId: string, entryIds: string[]): Message {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO message_attachments (message_id, entry_id) VALUES ($messageId, $entryId)",
    );
    this.db.transaction(() => {
      for (const entryId of entryIds) insert.run({ messageId, entryId });
    })();
    return this.getMessage(messageId);
  }

  /**
   * Approve or deny one of your friend's proposals. Approving carries it
   * out: for a channel deletion, the channel is deleted (if it still exists).
   */
  resolveProposal(id: string, approve: boolean): void {
    this.db.transaction(() => {
      const proposal = this.inbox.resolveProposal(id, approve ? "approved" : "denied");
      if (approve && proposal.kind === "delete_channel") {
        this.db.query("DELETE FROM channels WHERE id = $id").run({ id: proposal.targetId! });
      }
    })();
  }

  /**
   * Clear a channel: every message leaves the chat, as tombstones (see
   * `deleteMessage`). The channel itself stays.
   */
  clearMessages(channelId: string, by: Author = "user"): void {
    const channel = this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const hadFriend = this.getMessages(channelId).some((m) => m.author === "friend");
    this.db.transaction(() => {
      this.db
        .query("UPDATE messages SET deleted_at = $now, deleted_by = $by WHERE channel_id = $channelId AND deleted_at IS NULL AND superseded_by IS NULL")
        .run({ channelId, now: new Date().toISOString(), by });
      if (by === "user" && hadFriend) {
        this.interventions.add({ kind: "clear", summary: `The user cleared every message in #${channel.name}.`, channelId });
      }
    })();
    this.summaries.clear(channelId);
    this.messagesChanged(channelId);
  }
}

/** The start of a message, on one line, for the intervention log. */
function snippet(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
