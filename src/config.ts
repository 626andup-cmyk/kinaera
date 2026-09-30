/**
 * Server configuration, read from environment variables.
 *
 * Bun automatically loads a `.env` file from the project folder, so on the
 * phone you put your settings there (see `.env.example`) rather than typing
 * them every time you start the server.
 *
 * Only things that belong to the *machine* live here: the API key, the port,
 * the data folder. Things that belong to the *chat* (friend prompt, model,
 * temperature) are settings you change in the app; see `store.ts`.
 */

import { resolve } from "node:path";

export interface Config {
  /** Interface to listen on. `127.0.0.1` means "this device only". */
  host: string;
  port: number;
  /** Absolute path of the folder where the chat is saved. */
  dataDir: string;
  /** Absolute path of the folder holding the web app's files. */
  publicDir: string;
  /** Absolute path of the folder of built-in themes. (Your own are in `<dataDir>/themes`.) */
  themesDir: string;
  /** nanoGPT API key. Empty means "not configured yet". */
  apiKey: string;
  /** Base URL of the OpenAI-compatible API, without a trailing slash. */
  apiBaseUrl: string;
  /** How long to wait for one model reply, in milliseconds. */
  requestTimeoutMs: number;
  /**
   * How long after a channel changes its summaries are brought up to date,
   * in milliseconds (default 4000). Negative: only when asked (for tests).
   */
  summaryDelayMs?: number;
  /** Something that posts phone notifications (default: Termux's, if installed). Tests pass a fake. */
  notifier?: import("./notify.ts").Notifier;
  /**
   * Whether events wake your friend on their own (stage 8). Default true;
   * tests turn it off and call `app.wakeups.event` themselves.
   */
  autoWake?: boolean;
  /**
   * Set by the hub (src/hub.ts), which runs one app per friend. Where your
   * own themes are (shared by every friend; default `<dataDir>/themes`),
   * which friend this app is (for notification links), and whether a brand
   * new friend starts with the example character (default true).
   */
  userThemesDir?: string;
  friendId?: string;
  example?: boolean;
  /**
   * The other friends on this friend's server, from the hub: who else is
   * here (their names only: never anything they remember).
   */
  peers?: () => Peer[];
  /** Group channels and DMs (from the hub). */
  groups?: GroupDirectory;
  /** How long after your last message in a group its round starts (tests: 0). */
  groupDelayMs?: number;
}

/** Another friend on the same server. */
export interface Peer {
  id: string;
  name: string;
}

/** A group channel or DM, as a friend in it knows it (src/groups.ts). */
export interface GroupInfo {
  kind: "group" | "dm";
  /** The other friends in it. */
  members: Peer[];
  /** DMs: whether you (the user) can see it. Group channels: always. */
  visible: boolean;
}

/** What a friend's app can ask the hub about group channels and DMs. */
export interface GroupDirectory {
  /** A group channel or DM this friend is in, by its channel id. */
  info(channelId: string): GroupInfo | null;
  /** The DM with another friend on their server, made if there isn't one yet: its channel id. */
  dmWith(peerId: string): string;
}

/**
 * Build the configuration from an environment (normally `process.env`).
 *
 * Taking the environment as a parameter instead of reading `process.env`
 * directly lets the tests build a config without touching real variables.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // The project root is one folder up from this file (src/..).
  const root = resolve(import.meta.dir, "..");

  return {
    host: env.HOST || "127.0.0.1",
    port: parsePositiveInt(env.PORT, 4747, "PORT"),
    dataDir: resolve(root, env.DATA_DIR || "data"),
    publicDir: resolve(root, "public"),
    themesDir: resolve(root, "themes"),
    apiKey: (env.NANOGPT_API_KEY || "").trim(),
    // Strip any trailing slashes so we can always write `${base}/path`.
    apiBaseUrl: (env.NANOGPT_BASE_URL || "https://nano-gpt.com/api/v1").replace(/\/+$/, ""),
    requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_SECONDS, 180, "REQUEST_TIMEOUT_SECONDS") * 1000,
  };
}

/**
 * Parse a whole number greater than zero, falling back to a default when the
 * variable is unset. A value that is set but invalid is an error: silently
 * ignoring a typo like `PORT=30OO` would be more confusing than failing.
 */
function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a whole number greater than 0, got "${value}"`);
  }
  return parsed;
}
