/**
 * Tests for making your new friend after a fresh start (src/fresh.ts sets
 * it up; POST /api/setup in src/server.ts makes them).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { pendingOrientation } from "../src/orientation.ts";
import { createApp, type App } from "../src/server.ts";
import { SETUP_PENDING } from "../src/store.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl, { example: false }));
  // What a fresh start leaves: no friend made yet, no orientation queued.
  app.store.appState.set("orientation.pending", null);
  app.store.appState.set(SETUP_PENDING, "1");
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as any };
}

test("after a fresh start, you make your new friend, and their orientation is next", async () => {
  expect((await call("GET", "/api/state")).data.setup).toBe(true);
  expect((await call("POST", "/api/setup", { name: "", prompt: "You are Wren." })).status).toBe(400);
  expect((await call("POST", "/api/setup", { name: "Wren", prompt: "  " })).status).toBe(400);
  const { status } = await call("POST", "/api/setup", { name: "Wren", avatar: "🦉", color: 30, prompt: "You are Wren, a night owl.", tastes: "Loves fog." });
  expect(status).toBe(200);
  expect(app.store.getSettings()).toMatchObject({ friendName: "Wren", friendAvatar: "🦉", friendColor: 30 });
  expect(app.store.identity.history()).toMatchObject([{ identity: "You are Wren, a night owl.", tastes: "Loves fog.", author: "user" }]);
  expect(pendingOrientation(app.store)).not.toBeNull();
  expect((await call("GET", "/api/state")).data.setup).toBe(false);
  expect((await call("POST", "/api/setup", { name: "Again", prompt: "x" })).status).toBe(400);
});
