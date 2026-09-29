# Friends and servers

You can have as many friends as you like. **Each friend is a different person with their own memory**, and each usually has **a server of their own**, like having a Discord server with each friend. A server can also hold several friends.

## Using them

- **The rail** on the far left has one button per server; tap one to go there. A dot means a friend there has written something you haven't seen. **+** makes a new server with a new friend.
- **A new friend**: give them a name, an avatar (an emoji) and who they are, or press **🎲 Surprise me** to invent someone. They start fresh: their own notebook, channels (#story and #ooc) and memory. They get your connection profiles and roulettes, and your preferences: models, Jev, reaching out, the heartbeat, texting and the look. They don't get the other friend's identity, prompts or anything they remember.
- **The friend menu**: tap the friend card at the bottom of the sidebar. It holds their name, avatar and colour, who they are (with Surprise me to reroll), how they write in literary, casual and OOC channels, and texting. Their avatar and colour show on their messages, the friend card and the rail.
- **Server settings**: tap the server's name at the top of the sidebar, or its button in the rail. You can rename it, see who's there, **add a friend here**, or delete it.
- **Several friends in one server**: the sidebar shows each friend's channels under their name and avatar. Each channel belongs to one friend: they're the one who writes there, and only they know what's in it. Opening another friend's channel switches to them, and the friend card, notebook and settings become theirs. From a friend's menu, **Own server** moves them out into a server of their own.
- **Deleting** a friend (their menu → Delete…, typing their name to confirm) or a server moves their files to `data/trash/`, not away for good. You can't delete your last friend.
- Phone notifications open the right friend's channel.

## Separate memory, by construction

Each friend is a complete Kinaera of their own (`src/hub.ts`). They have their own database and folder, so their own:

- notebook, including their secrets, suggestions and pins;
- channels, categories, messages, comments, reactions and tool log;
- summaries;
- wake-ups, heartbeat, inbox, and the check and intervention logs;
- reference library and custom emojis;
- settings and prompts.

Nothing is shared between friends except your own themes and the connection profiles you choose to copy when making one. So no friend can ever see another's notebook, secrets or conversations: there's no code path between them to get it wrong. When two friends share a server, only the sidebar puts them side by side, and each one's prompt only ever contains their own channels.

## How it works

The server runs a **hub** in front of one app per friend:

| Request | Goes to |
| --- | --- |
| `/p/<friend>/api/...` and `/p/<friend>/emojis/...` | That friend's app |
| `/api/hub/...` | The hub: servers and friends |
| Anything else (the web app, themes, and `/api/...` from older pages) | The first friend's app |

The page works on one friend at a time. Its requests are prefixed with that friend (`scoped` in `public/js/core.js`), and the address says whose channel is open: `#/p/<friend>/channel/<id>`. Switching friends (another server in the rail, another friend's channel, a notification) reloads the page as theirs. Every 15 seconds the page also asks the hub for every friend's channels and newest messages, for the dots in the rail and the other friends' sections.

### The data folder

```
data/
  hub.json          the servers and their friends
  kinaera.db        your first friend (where Kinaera always kept its data)
  emojis/           their custom emojis
  themes/           your own themes, shared by everyone
  friends/<id>/    each other friend: kinaera.db, emojis/
  trash/            deleted friends
```

Upgrading changes nothing: the existing database becomes the first friend, in the first server. To back up, stop the server and copy the whole `data/` folder.

### The hub's API

- `GET /api/hub`: the servers. Each has its friends, and each friend comes with their name, avatar, colour, channels, categories, each channel's newest message, and where they're writing.
- `POST /api/hub/servers` with `name`, and optionally `prompt`, `avatar`, `color`, `serverName` and `copyFrom` (the friend whose profiles and preferences to copy): a new server with a new friend.
- `POST /api/hub/servers/:id/friends` (same fields): a new friend in that server.
- `PATCH /api/hub/servers/:id` with `name`, and/or `friends` (a new order).
- `PUT /api/hub/servers/order` with `ids`.
- `DELETE /api/hub/servers/:id`: the server and its friends (to the trash).
- `DELETE /api/hub/friends/:id`: one friend (to the trash).
- `POST /api/hub/friends/:id/move` with `serverId`, or nothing for a server of their own.

Each friend's app has the same API as before. Its new settings are `friendAvatar` (an emoji, or "" for their initial) and `friendColor` (a hue from 0 to 359, or -1 for the theme's).

## Tests

`test/hub.test.ts`:

- starting fresh, and upgrading an existing data folder;
- routing;
- a new friend with copied profiles and preferences but their own identity and a clean slate;
- a friend never seeing another's notebook, messages or prompt;
- several friends in one server, reordering them, and moving one out;
- renaming and reordering servers, kept after a restart;
- deleting to the trash (including the first friend), and the last one can't go;
- bad input.

In a real browser, on desktop and phone sizes: the rail; the friend menu (avatar and colour); a new server from Surprise me; adding a friend to a server, with both sections in the sidebar; and switching by another friend's channel and by the rail.
