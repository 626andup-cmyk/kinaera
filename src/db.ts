/**
 * The database: where everything is stored, and how its layout is kept up
 * to date.
 *
 * Kinaera uses SQLite, a database that lives in a single file
 * (`data/kinaera.db`) and is built into Bun, so there is nothing to install
 * or run alongside the server.
 *
 * A database stores data in *tables*. Each table has fixed *columns*, and
 * each item is a *row*. Tables point at each other through ids; that is what
 * "data relationships" means. In Kinaera:
 *
 *   channels ──< messages ──< message_characters
 *
 * reads as "a channel has many messages, and a message has many characters
 * it voices". Each message row stores its channel's id (`channel_id`), and
 * each message_characters row stores its message's id (`message_id`).
 *
 * This file only knows about the *layout* of the tables. Reading and
 * writing actual data happens in `src/store.ts`.
 */

import { Database } from "bun:sqlite";

/**
 * Every change ever made to the database layout, oldest first.
 *
 * A *migration* is a step that moves the layout from one version to the
 * next. SQLite keeps a version number in the file itself (`user_version`).
 * On startup, any migrations newer than that number run, in order, and the
 * number is updated. So an old database is upgraded automatically, and a new
 * one is built by running every step from the start.
 *
 * Never edit a migration once it has been released: databases that already
 * ran it won't run it again. Add a new one to the end instead.
 *
 * Most steps are SQL. A step can also be a function, for moving data around
 * in ways that are easier to write in TypeScript. A step marked
 * `{ rebuild: ... }` runs with foreign keys off: SQLite can only change a
 * table's CHECK rules by building a new table and swapping it in, and with
 * foreign keys on, dropping the old one would delete everything that
 * points at it.
 *
 * Kinaera starts from Aettica's final layout, folded into one first step
 * (Aettica's own upgrade steps were for Aettica's data, which Kinaera
 * doesn't open; the importer reads it instead).
 */
export type Migration = string | ((db: Database) => void) | { rebuild: string };

export const MIGRATIONS: Migration[] = [
  // ---------------------------------------------------------------- 1
  // The starting layout.
  (db) => {
    db.exec(`
    -- Server-wide settings as key/value pairs. Each value is stored as JSON,
    -- so numbers stay numbers and text stays text.
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Small values kept between runs, like when the next heartbeat is due.
    CREATE TABLE app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ------------------------------------------------ channels and messages

    -- Named, collapsible groups of channels in the sidebar.
    CREATE TABLE categories (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      -- Where it sits among the categories: 0 is the top. Channels outside
      -- any category are listed above all of them.
      position   INTEGER NOT NULL,
      -- 1 when folded up in the sidebar.
      collapsed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE channels (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      -- CHECK makes the database itself refuse any other value.
      kind         TEXT NOT NULL CHECK (kind IN ('rp', 'ooc')),
      position     INTEGER NOT NULL,
      -- The mode of the current scene, and a change waiting for the next
      -- scene break (NULL when none is waiting).
      mode         TEXT NOT NULL DEFAULT 'literary' CHECK (mode IN ('literary', 'casual')),
      pending_mode TEXT CHECK (pending_mode IN ('literary', 'casual')),
      -- The channel's own theme (NULL: the app theme). Themes themselves are
      -- folders, not rows; see src/themes.ts.
      theme        TEXT,
      -- The channel's own profile or roulette ("profile:<id>" or
      -- "roulette:<id>"), overriding the server-wide one. NULL: no override.
      assignment   TEXT,
      -- Deleting a category leaves its channels, outside any category.
      category_id  TEXT REFERENCES categories (id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE messages (
      -- seq counts up by one for every message ever saved, so ordering by it
      -- gives the order messages were written in.
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      -- REFERENCES ties each message to a real channel. ON DELETE CASCADE
      -- means deleting a channel deletes its messages too, instead of leaving
      -- orphans behind.
      channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
      -- Scene breaks are rows here too, so they stay in order with the
      -- messages around them. For a scene break, content is its title.
      kind       TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'scene_break')),
      -- The mode each message was written in (NULL outside RP channels).
      mode       TEXT CHECK (mode IN ('literary', 'casual')),
      -- Messages written together (one casual reply's bubbles) share a turn id.
      turn_id    TEXT,
      author     TEXT NOT NULL CHECK (author IN ('user', 'friend')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at  TEXT,
      model      TEXT,
      -- The name of the profile that wrote each friend message.
      profile    TEXT
    );

    -- An index is like the index at the back of a book: it lets SQLite jump
    -- straight to one channel's messages instead of reading every message.
    CREATE INDEX messages_by_channel ON messages (channel_id, seq);

    -- Which character(s) each message voices. One row per character, so a
    -- message can voice none, one or several.
    CREATE TABLE message_characters (
      message_id     TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      character_name TEXT NOT NULL,
      -- Keeps the characters in the order they were given.
      position       INTEGER NOT NULL,
      PRIMARY KEY (message_id, character_name)
    );

    -- ------------------------------------------------------------ notebook

    -- Folders group entries, and pass their visibility and editing settings
    -- down to them.
    CREATE TABLE notebook_folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      owner      TEXT NOT NULL CHECK (owner IN ('user', 'friend', 'joint')),
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
      editing    TEXT NOT NULL DEFAULT 'open' CHECK (editing IN ('open', 'suggest', 'locked')),
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE notebook_entries (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('character', 'lore')),
      name          TEXT NOT NULL,
      -- The labelled fields, as a JSON list of {label, value}.
      fields        TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT NOT NULL DEFAULT '',
      proxy_prefix  TEXT,
      -- Deleting a folder moves its entries out of it rather than deleting them.
      folder_id     TEXT REFERENCES notebook_folders (id) ON DELETE SET NULL,
      owner         TEXT NOT NULL CHECK (owner IN ('user', 'friend', 'joint')),
      -- NULL means "use the folder's setting".
      visibility    TEXT CHECK (visibility IN ('visible', 'hidden')),
      editing       TEXT CHECK (editing IN ('open', 'suggest', 'locked')),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Which entries are pinned to which channels: the channel's cast (and
    -- its lore). A many-to-many relationship: an entry can be pinned to many
    -- channels, and a channel can have many entries pinned.
    CREATE TABLE channel_cast (
      channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
      entry_id   TEXT NOT NULL REFERENCES notebook_entries (id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      PRIMARY KEY (channel_id, entry_id)
    );

    -- Suggested changes to entries someone can't edit directly.
    CREATE TABLE notebook_suggestions (
      id          TEXT PRIMARY KEY,
      entry_id    TEXT NOT NULL REFERENCES notebook_entries (id) ON DELETE CASCADE,
      author      TEXT NOT NULL CHECK (author IN ('user', 'friend')),
      -- What would change, as JSON (see SuggestedChange in src/types.ts).
      change      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    );

    -- Notebook entries you attached to a message, so they're sent to your
    -- friend in full while that message is in the conversation.
    CREATE TABLE message_attachments (
      message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      entry_id   TEXT NOT NULL REFERENCES notebook_entries (id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, entry_id)
    );

    -- ------------------------------------------- profiles and roulettes

    -- A connection profile: one model and its settings (see src/profiles.ts).
    CREATE TABLE profiles (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      model            TEXT NOT NULL,
      temperature      REAL NOT NULL,
      max_tokens       INTEGER NOT NULL,
      top_p            REAL,
      reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high')),
      -- SQLite has no true/false type: 1 is true, 0 is false.
      supports_tools   INTEGER NOT NULL DEFAULT 1,
      quirk_prompt     TEXT NOT NULL DEFAULT '',
      extra_params     TEXT NOT NULL DEFAULT '',
      position         INTEGER NOT NULL,
      created_at       TEXT NOT NULL
    );

    -- A roulette: a weighted set of profiles.
    CREATE TABLE roulettes (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE roulette_profiles (
      roulette_id TEXT NOT NULL REFERENCES roulettes (id) ON DELETE CASCADE,
      profile_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      weight      REAL NOT NULL CHECK (weight > 0),
      PRIMARY KEY (roulette_id, profile_id)
    );

    -- ------------------------------------------ tools, comments, proposals

    -- Every tool call your friend makes, kept for the activity shown under
    -- their messages and for troubleshooting (see src/friend.ts).
    CREATE TABLE tool_calls (
      id         TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
      -- The turn the call belongs to: the same id as the messages it wrote.
      turn_id    TEXT NOT NULL,
      -- Which round of the turn: a model can call tools, see the results,
      -- and call more.
      round      INTEGER NOT NULL,
      name       TEXT NOT NULL,
      -- The arguments exactly as the model wrote them, even if broken.
      arguments  TEXT NOT NULL,
      -- What was sent back to the model, as JSON.
      result     TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      -- A short description for people, e.g. "pinned Tamsin to #story".
      summary    TEXT NOT NULL DEFAULT '',
      -- 'native' if the API returned it as a tool call, 'text' if it was
      -- found written out in the reply (some models do that).
      source     TEXT NOT NULL CHECK (source IN ('native', 'text')),
      profile    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX tool_calls_by_channel ON tool_calls (channel_id, created_at);

    -- Comments on messages, in threads. The first comment of a thread has
    -- thread_id = its own id, and holds the highlighted text and whether the
    -- thread is resolved.
    CREATE TABLE comments (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      thread_id  TEXT NOT NULL,
      author     TEXT NOT NULL CHECK (author IN ('user', 'friend')),
      quote      TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX comments_by_message ON comments (message_id);

    -- Things your friend asks you to approve that aren't notebook changes
    -- (those are suggestions): for now, deleting a channel.
    CREATE TABLE proposals (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('delete_channel')),
      target_id   TEXT NOT NULL,
      -- The target's name when proposed, so the card still makes sense later.
      target_name TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    );

    -- ------------------------------------------------------------ summaries

    -- So long stories fit in the context (see src/summaries.ts).
    CREATE TABLE summaries (
      channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
      -- 'scene':   one finished scene, ended by the scene break scene_id.
      -- 'story':   the story so far: every finished scene, folded together.
      -- 'current': the older part of the scene still going (in OOC, of the
      --            whole conversation), started by the scene break scene_id
      --            ('' for the channel's first scene).
      -- 'digest':  one or two lines about the channel, for OOC.
      kind        TEXT NOT NULL CHECK (kind IN ('scene', 'story', 'current', 'digest')),
      scene_id    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL,
      -- The newest message (its seq) the summary covers.
      through_seq INTEGER NOT NULL DEFAULT 0,
      -- 1 when messages it covers were edited or deleted: it's rewritten.
      stale       INTEGER NOT NULL DEFAULT 0,
      -- 1 when you wrote or edited it: it's kept as you left it.
      edited      INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (channel_id, kind, scene_id)
    );

    -- ------------------------------------------------------ logs and Jev

    -- Every call to Jev (src/jevlog.ts), kept for 36 hours.
    CREATE TABLE jev_log (
      id          TEXT PRIMARY KEY,
      at          TEXT NOT NULL,
      -- What asked: "Test Jev"...
      purpose     TEXT NOT NULL,
      model       TEXT NOT NULL,
      -- The request body sent to Jev, as JSON; NULL if Jev wasn't asked (turned off).
      request     TEXT,
      -- Jev's reply, exactly as it came back ('' if there wasn't one).
      response    TEXT NOT NULL,
      error       TEXT,
      -- 'jev', 'fallback', or NULL when nobody answered.
      answered_by TEXT CHECK (answered_by IN ('jev', 'fallback')),
      -- The answers in short: "t1: yes (95%), plan: no (90%)".
      summary     TEXT NOT NULL,
      -- The fallback profile's request and reply, as JSON, when it was asked.
      fallback    TEXT,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX jev_log_by_time ON jev_log (at);

    -- Each time your friend took a turn on their own, and what came of it
    -- (src/wakeups.ts).
    CREATE TABLE wakeups (
      id         TEXT PRIMARY KEY,
      at         TEXT NOT NULL,
      -- What happened: 'opened', 'away', 'scene-ended', 'review', 'heartbeat'.
      reason     TEXT NOT NULL,
      -- 'posted' (they wrote), 'quiet' (their turn, but they chose not to
      -- write), 'failed'.
      outcome    TEXT NOT NULL CHECK (outcome IN ('posted', 'quiet', 'failed')),
      channel_id TEXT REFERENCES channels (id) ON DELETE SET NULL,
      -- Why, in words.
      detail     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX wakeups_by_time ON wakeups (at);

    -- ------------------------------------------------ the reference library

    -- Long texts, split into passages, that your friend can search and read
    -- with tools (src/library.ts).
    CREATE TABLE library_docs (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      -- A JSON list of the channels it's limited to; '[]' means everywhere.
      channel_ids TEXT NOT NULL DEFAULT '[]',
      chars       INTEGER NOT NULL,
      passages    INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- A page or so of a document each. The rowid ties it to the search index.
    CREATE TABLE library_passages (
      rowid    INTEGER PRIMARY KEY,
      doc_id   TEXT NOT NULL REFERENCES library_docs (id) ON DELETE CASCADE,
      -- Counts from 1, in order.
      seq      INTEGER NOT NULL,
      -- The scene or chapter it's in.
      heading  TEXT NOT NULL DEFAULT '',
      -- In a script, the characters with lines in it, one per line.
      speakers TEXT NOT NULL DEFAULT '',
      content  TEXT NOT NULL,
      UNIQUE (doc_id, seq)
    );

    -- The full-text search index over the passages (FTS5), with stemming, so
    -- "running" finds "run". It reads its text from library_passages.
    CREATE VIRTUAL TABLE library_fts USING fts5 (
      heading, speakers, content,
      content = 'library_passages', content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    -- ------------------------------------------------------------ reactions

    -- Emoji reactions, and custom emojis (src/reactions.ts).
    CREATE TABLE reactions (
      message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      author     TEXT NOT NULL CHECK (author IN ('user', 'friend')),
      -- A Unicode emoji, or ':name:' of a custom one.
      emoji      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, author, emoji)
    );

    -- Images you uploaded, used as :name:. The files are in the data folder's
    -- emojis/ folder.
    CREATE TABLE custom_emojis (
      name       TEXT PRIMARY KEY,
      file       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    `);

    // Every server starts with one connection profile, which writes both
    // roleplay and OOC until you change that.
    const model = "deepseek-ai/DeepSeek-V3.1-Terminus";
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO profiles (id, name, model, temperature, max_tokens, position, created_at)
       VALUES (?, ?, ?, 0.9, 1024, 0, ?)`,
    ).run(id, model.split("/").at(-1)!, model, new Date().toISOString());
    const assign = db.query("INSERT INTO settings (key, value) VALUES (?, ?)");
    assign.run("rpAssignment", JSON.stringify(`profile:${id}`));
    assign.run("oocAssignment", JSON.stringify(`profile:${id}`));
  },

  // ---------------------------------------------------------------- 2
  // Rebuild stage 2: messages with history. Nothing is overwritten in
  // place: edits keep every version, deleting leaves a tombstone, and a
  // regenerated reply is kept as a superseded alternate. And the
  // intervention log: everything you do that affects your friend.
  `
  -- Who last edited a message ('user' or 'friend'; NULL if never edited).
  ALTER TABLE messages ADD COLUMN edited_by TEXT CHECK (edited_by IN ('user', 'friend'));
  -- A tombstone: the message has left the chat, but stays in history.
  ALTER TABLE messages ADD COLUMN deleted_at TEXT;
  ALTER TABLE messages ADD COLUMN deleted_by TEXT CHECK (deleted_by IN ('user', 'friend'));
  -- A regenerated reply: the turn id of the reply that replaced it.
  ALTER TABLE messages ADD COLUMN superseded_by TEXT;
  CREATE INDEX messages_by_superseding_turn ON messages (superseded_by);

  -- Every version of an edited message, oldest first. The first edit also
  -- saves the original, so a message with no rows here was never edited.
  CREATE TABLE message_revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    -- Who wrote this version.
    author     TEXT NOT NULL CHECK (author IN ('user', 'friend')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX message_revisions_by_message ON message_revisions (message_id, id);

  -- The intervention log: every action of yours that affects your friend,
  -- which they can read (read_interventions), and you can too.
  CREATE TABLE interventions (
    id         TEXT PRIMARY KEY,
    at         TEXT NOT NULL,
    -- 'edit', 'delete', 'regenerate', 'clear', 'settings'...
    kind       TEXT NOT NULL,
    -- What happened, in a sentence, as your friend reads it.
    summary    TEXT NOT NULL,
    channel_id TEXT,
    message_id TEXT
  );
  CREATE INDEX interventions_by_time ON interventions (at);
  `,

  // ---------------------------------------------------------------- 3
  // Rebuild stage 3: the instruments. The check log (replacing the Jev
  // log: check is Jev's only caller now), the unified inbox (asks, and the
  // proposals that were in their own table), and consultant profiles.
  `
  DROP TABLE jev_log;

  -- Every check your friend made (src/check.ts). Text from private places
  -- (the journal, drafts) is never stored here: only how much was found.
  CREATE TABLE check_log (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    channel_id  TEXT,
    question    TEXT NOT NULL,
    rephrased   TEXT NOT NULL,
    -- The sources searched, as a JSON list: ["notebook", "channel"...].
    sources     TEXT NOT NULL,
    -- 'yes', 'no', 'unsure', or NULL when there was no reading (nothing
    -- found, or Jev couldn't answer).
    verdict     TEXT CHECK (verdict IN ('yes', 'no', 'unsure')),
    -- Each phrasing's p(yes), as a JSON list.
    yes         TEXT NOT NULL DEFAULT '[]',
    -- The passages found, as JSON: [{source, where, text}], text NULL for private ones.
    found       TEXT NOT NULL DEFAULT '[]',
    -- 'jev', 'fallback', or NULL.
    answered_by TEXT,
    error       TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX check_log_by_time ON check_log (at);

  -- The inbox: what your friend asks of you. Their asks (ask), and
  -- proposals of things they can't do alone (deleting a channel).
  -- Notebook suggestions stay in notebook_suggestions, tied to their
  -- entries, but the app shows them in the same inbox.
  CREATE TABLE inbox (
    id           TEXT PRIMARY KEY,
    -- 'ask' or 'delete_channel'.
    kind         TEXT NOT NULL CHECK (kind IN ('ask', 'delete_channel')),
    -- For asks: 'context', 'check', 'model', 'pause', 'clarify', 'prompt', 'other'.
    ask_kind     TEXT,
    -- What they asked, or why they propose it.
    text         TEXT NOT NULL DEFAULT '',
    -- For a proposal: what it's about, and its name at the time.
    target_id    TEXT,
    target_name  TEXT,
    -- The channel they asked from, if any.
    channel_id   TEXT,
    -- 'open' (waiting for you), 'answered', 'dismissed', 'approved', 'denied'.
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'answered', 'dismissed', 'approved', 'denied')),
    -- Your answer to an ask.
    answer       TEXT,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    -- When your friend's prompt first carried the outcome.
    delivered_at TEXT
  );
  CREATE INDEX inbox_by_status ON inbox (status, created_at);

  INSERT INTO inbox (id, kind, text, target_id, target_name, status, created_at, resolved_at, delivered_at)
    SELECT id, kind, reason, target_id, target_name,
           CASE status WHEN 'pending' THEN 'open' ELSE status END,
           created_at, resolved_at, resolved_at
      FROM proposals;
  DROP TABLE proposals;

  -- Profiles your friend may consult for a second opinion (consult).
  ALTER TABLE profiles ADD COLUMN consultant INTEGER NOT NULL DEFAULT 0;
  `,

  // ---------------------------------------------------------------- 4
  // Rebuild stage 4: what belongs to your friend. Their identity (every
  // version kept), their self-page, their journal, moments kept in full, and
  // orientation: a practice channel (a new kind, so the channels table is
  // rebuilt) and a Practice folder in the notebook.
  {
    rebuild: `
  CREATE TABLE channels_new (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    -- 'rp', 'ooc', or 'practice': your friend's own channel for trying
    -- things out, which never feeds anything else.
    kind         TEXT NOT NULL CHECK (kind IN ('rp', 'ooc', 'practice')),
    position     INTEGER NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'literary' CHECK (mode IN ('literary', 'casual')),
    pending_mode TEXT CHECK (pending_mode IN ('literary', 'casual')),
    theme        TEXT,
    assignment   TEXT,
    category_id  TEXT REFERENCES categories (id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL
  );
  INSERT INTO channels_new (id, name, kind, position, mode, pending_mode, theme, assignment, category_id, created_at)
    SELECT id, name, kind, position, mode, pending_mode, theme, assignment, category_id, created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;

  -- Every version of your friend's identity: who they are, and their tastes
  -- (what they love, what bores them, what they'd never write). Your friend
  -- owns it. The current identity is the newest 'accepted' version; your
  -- edits arrive as 'pending' suggestions, which they accept or decline.
  CREATE TABLE identity_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    identity     TEXT NOT NULL,
    tastes       TEXT NOT NULL DEFAULT '',
    -- Who wrote this version.
    author       TEXT NOT NULL CHECK (author IN ('user', 'friend')),
    -- Why, in their words (or yours, for a suggestion).
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL CHECK (status IN ('accepted', 'pending', 'declined', 'withdrawn')),
    -- Your friend's reply to a suggestion of yours.
    reply        TEXT,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    -- When your friend's prompt first carried it (see src/identity.ts).
    delivered_at TEXT
  );

  -- The self-page's own sections, by key: 'says' (what they say about
  -- themselves), 'feedback' (how they'd like feedback), 'standing' (the
  -- short version in every prompt), 'edit_markers' ('on' or 'off').
  CREATE TABLE self_page (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- "What my writing shows": notes on the self-page, each with the
  -- messages that show it. Yours arrive as suggestions your friend accepts
  -- (maybe with a reply) or declines; they can dispute any note.
  CREATE TABLE self_notes (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    -- 'user': a note you added; 'mirror': a pattern your friend kept.
    source       TEXT NOT NULL CHECK (source IN ('user', 'mirror')),
    -- The messages that show it, as a JSON list of ids.
    message_ids  TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    reply        TEXT,
    dispute      TEXT,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    delivered_at TEXT
  );

  -- Your friend's private journal (src/journal.ts). It has no screen in
  -- the app, and its text is never written to any log.
  CREATE TABLE journal (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    -- 1: carried forward, in every prompt; 0: fades as it ages.
    kept       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX journal_by_time ON journal (created_at);

  -- Moments your friend asked to keep in full instead of summarized
  -- (keep_verbatim), a few per channel.
  CREATE TABLE verbatim (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, message_id)
  );

  -- The Practice folder: sample notes for orientation, left out of every
  -- listing and prompt but the practice channel's.
  ALTER TABLE notebook_folders ADD COLUMN practice INTEGER NOT NULL DEFAULT 0;

  -- Asks made during an orientation are marked as such in your inbox.
  ALTER TABLE inbox ADD COLUMN orientation INTEGER NOT NULL DEFAULT 0;
  `,
  },

  // ---------------------------------------------------------------- 5
  // Rebuild stage 5: time. Wake-ups your friend schedules for themselves,
  // their private drafts, and storylines they've paused.
  `
  CREATE TABLE schedule (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- When it's due (ISO, UTC).
    at         TEXT NOT NULL,
    -- Their note to themselves, shown when it fires.
    note       TEXT NOT NULL,
    -- Where to wake up (null: their usual OOC channel).
    channel_id TEXT REFERENCES channels (id) ON DELETE SET NULL,
    -- 'waiting', 'done' (it fired), or 'cancelled'.
    status     TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'cancelled')),
    created_at TEXT NOT NULL,
    done_at    TEXT
  );
  CREATE INDEX schedule_by_status ON schedule (status, at);

  -- Private, like the journal: no screen, never in a log.
  CREATE TABLE drafts (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    -- Where they mean to post it (null: undecided).
    channel_id TEXT REFERENCES channels (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- A roleplay channel your friend paused (pause_storyline), and why.
  ALTER TABLE channels ADD COLUMN paused_reason TEXT;
  ALTER TABLE channels ADD COLUMN paused_at TEXT;
  `,

  // ---------------------------------------------------------------- 6
  // Rebuild stage 6: continuity and self-knowledge. Posts your friend
  // marked as sounding like them (voice anchors), posts that didn't ("not
  // me"), their notes on each profile, and the weekly wellbeing reading.
  `
  CREATE TABLE voice_marks (
    message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE not_me (
    message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    -- The profile that wrote it, as it was called then.
    profile    TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE profile_notes (
    profile_id TEXT PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE wellbeing (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The week read: from and to (ISO).
    since      TEXT NOT NULL,
    until      TEXT NOT NULL,
    -- 'yes', 'no', 'unsure', or null (no reading: nothing to read, or Jev failed).
    verdict    TEXT,
    -- Each phrasing's probability of yes (JSON).
    yes        TEXT NOT NULL DEFAULT '[]',
    messages   INTEGER NOT NULL,
    error      TEXT,
    created_at TEXT NOT NULL
  );
  `,

  // ---------------------------------------------------------------- 7
  // Rebuild stage 7: among friends. Replies (a message can answer an
  // earlier one, shown as a quoted preview), and your friend's private
  // notes on the other friends (by their hub id).
  `
  ALTER TABLE messages ADD COLUMN reply_to TEXT;

  CREATE TABLE relationships (
    friend_id  TEXT PRIMARY KEY,
    -- Their name when the note was last written.
    name       TEXT NOT NULL,
    note       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  // ---------------------------------------------------------------- 8
  // Rebuild stage 7: group channels and DMs. A group channel (or a DM
  // between two friends) is kept by every friend in it, in their own
  // database, under the same id, with every message mirrored under the
  // same id (src/groups.ts). Messages from the other friends are by a
  // "peer": their hub id and name are kept with the message. Both tables
  // get new allowed values, so both are rebuilt.
  {
    rebuild: `
  CREATE TABLE channels_new (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    -- 'rp', 'ooc', 'practice', or 'group' (several friends and you) or
    -- 'dm' (two friends).
    kind          TEXT NOT NULL CHECK (kind IN ('rp', 'ooc', 'practice', 'group', 'dm')),
    position      INTEGER NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'literary' CHECK (mode IN ('literary', 'casual')),
    pending_mode  TEXT CHECK (pending_mode IN ('literary', 'casual')),
    theme         TEXT,
    assignment    TEXT,
    category_id   TEXT REFERENCES categories (id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL,
    paused_reason TEXT,
    paused_at     TEXT
  );
  INSERT INTO channels_new (id, name, kind, position, mode, pending_mode, theme, assignment, category_id, created_at, paused_reason, paused_at)
    SELECT id, name, kind, position, mode, pending_mode, theme, assignment, category_id, created_at, paused_reason, paused_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;

  CREATE TABLE messages_new (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'scene_break')),
    mode          TEXT CHECK (mode IN ('literary', 'casual')),
    turn_id       TEXT,
    -- 'user' (you), 'friend' (this friend), or 'peer' (another friend, in a
    -- group channel or DM: see speaker_id and speaker_name).
    author        TEXT NOT NULL CHECK (author IN ('user', 'friend', 'peer')),
    content       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    edited_at     TEXT,
    model         TEXT,
    profile       TEXT,
    edited_by     TEXT CHECK (edited_by IN ('user', 'friend')),
    deleted_at    TEXT,
    deleted_by    TEXT CHECK (deleted_by IN ('user', 'friend')),
    superseded_by TEXT,
    reply_to      TEXT,
    speaker_id    TEXT,
    speaker_name  TEXT
  );
  INSERT INTO messages_new (seq, id, channel_id, kind, mode, turn_id, author, content, created_at, edited_at, model, profile,
                            edited_by, deleted_at, deleted_by, superseded_by, reply_to)
    SELECT seq, id, channel_id, kind, mode, turn_id, author, content, created_at, edited_at, model, profile,
           edited_by, deleted_at, deleted_by, superseded_by, reply_to FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_by_channel ON messages (channel_id, seq);
  CREATE INDEX messages_by_superseding_turn ON messages (superseded_by);
  `,
  },
];

/**
 * Open (or create) the database file and bring its layout up to date.
 *
 * @param path  File path, or `":memory:"` for a throwaway in-memory database.
 */
export function openDatabase(path: string): Database {
  // `strict: true` lets queries use `$name` placeholders filled from plain
  // objects like `{ name: "story" }`, and makes a missing value an error.
  const db = new Database(path, { create: true, strict: true });

  // SQLite doesn't enforce REFERENCES unless asked to, once per connection.
  db.exec("PRAGMA foreign_keys = ON");
  // WAL ("write-ahead log") mode makes saves faster and safer if the phone
  // dies mid-write. It adds `-wal` and `-shm` files next to the database;
  // they belong to it, so copy all three if you back up while the server runs.
  db.exec("PRAGMA journal_mode = WAL");

  migrate(db);
  return db;
}

/** Run any migrations the database hasn't had yet. */
function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };

  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database was created by a newer version of Kinaera (layout version ${current}, ` +
        `this version knows up to ${MIGRATIONS.length}). Update Kinaera before opening it.`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version]!;
    // Foreign keys can only be switched off outside a transaction.
    const rebuild = typeof step === "object";
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      // A transaction makes the whole step happen completely or not at all, so
      // a crash can't leave the database half-upgraded.
      db.transaction(() => {
        if (typeof step === "string") db.exec(step);
        else if (typeof step === "function") step(db);
        else {
          db.exec(step.rebuild);
          // Nothing may point at a row that isn't there.
          const broken = db.query("PRAGMA foreign_key_check").all();
          if (broken.length > 0) throw new Error(`Migration ${version + 1} broke ${broken.length} reference(s).`);
        }
        // PRAGMA doesn't accept placeholders, but `version + 1` is our own
        // number, so building the text directly is safe here.
        db.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    } finally {
      if (rebuild) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** The latest layout version. Exported for tests. */
export const SCHEMA_VERSION = MIGRATIONS.length;
