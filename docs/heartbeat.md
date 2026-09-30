# The heartbeat

The heartbeat is a timer that now and then gives your friend a free moment, even with the app closed. What they do with it is up to them: text you, act with their tools, or nothing at all. Notifications are borrowed from Kitsikai.

(Aettica's heartbeat had the friend write ideas, had Jev grade them, and kept the rest in an "idea drawer". Kinaera removed all of that: whether something is worth saying is the friend's call. See section 6.7 of [KINAERA_REBUILD.md](../KINAERA_REBUILD.md).)

## Using it

- **Settings → Your friend reaching out → Heartbeat**: off by default, or about every 10, 15 or 30 minutes, every hour, every 2, 4, 6, 8 or 12 hours, or once a day. Each gap varies by ±20%, so it never feels like clockwork. The server checks every minute whether a beat is due. A short heartbeat only helps with a short cooldown: every beat still goes through the hard rules below.
- **Set quiet hours** in the same section, so it never wakes you at night.
- **Beat now** (same section) runs a heartbeat straight away, to try it. The rules still apply.
- **On your phone** (Termux), install Termux:API for notifications (see the README). When your friend writes on their own and the app isn't on screen, you get a notification, "Arlo in #ooc", and tapping it opens that channel.

## How a beat works

`src/heartbeat.ts`:

1. **The hard rules** (`Wakeups.blocked` in `src/wakeups.ts`), exactly as for any wake-up: chattiness (off stops the heartbeat), quiet hours, the cooldown, never a third time without you writing (one double text is fine), and not within 30 minutes of the last message. Most beats stop here, costing nothing. These are plain code, with no model calls.
2. **A free moment.** If the rules pass, your friend gets a wake-up turn in your OOC channel, with the reason "heartbeat". Their prompt says they're checking in on their own, how long it's been since you wrote, and what's waiting. They can write, use tools, or call `do_nothing` (or reply `[nothing]` without tools). Every turn goes in the wake-up log.

## Notifications

`src/notify.ts`:

- When a wake-up or heartbeat writes to you and the app isn't on screen, the server runs Termux:API's `termux-notification`. It's titled "Arlo in #ooc", with the message as the text, and tapping it opens the app at that channel. There's one notification per channel, and a newer one replaces the older.
- **On screen?** The app tells the server (`POST /api/presence`) when it's shown or hidden, and every 15 seconds while it's shown. No word for a minute counts as not on screen.
- **Staying awake**: with the heartbeat on, the server runs `termux-wake-lock`, so Android doesn't pause it.
- On a computer (no Termux), notifications are quietly off, and Settings says so.

## Where it's stored

When the next beat is due is kept in the `app_state` table (`src/appstate.ts`).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `heartbeatHours` | 0 (off) | About how often the heartbeat beats, in hours (5 minutes to 168 hours: 0.25 is every 15 minutes). Changing it starts the count again |

The heartbeat also follows the wake-up settings: chattiness, quiet hours, the cooldown.

## API

- `POST /api/presence` with `visible`: the app is (or isn't) on screen.
- `POST /api/heartbeat`: beat now, and wait for it. Returns what happened (`beat`).
- `GET /api/state` also has `notifications` (whether they work here) and `heartbeatNext`.

## Tests

`test/heartbeat.test.ts`: presence timing out; off and not-yet-due beats; the rules stopping a beat before any cost; a free moment your friend writes in (with a notification, and no Jev call); one they spend quietly; no notification while the app is on screen; never mid-conversation; the API.
