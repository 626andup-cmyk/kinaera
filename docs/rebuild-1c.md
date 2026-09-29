# Rebuild step 1c: split the frontend

The web app used to be one 5,700-line file, `public/app.js`. It's now **17 ES modules** in `public/js/`, one per area, loaded with `<script type="module">`. There's still no build step: the browser loads `js/main.js`, and that imports the rest. This step also fixes the `***bold italics***` formatting bug. Nothing else changed in how the app looks or behaves.

## The modules

| Module | What it does |
| --- | --- |
| `main.js` | The starting point. Wires the page's buttons and forms to the other modules, then loads the server's state and opens a channel. |
| `core.js` | What everything shares: `state` (a copy of what's on screen), `$` and `els` (finding elements), `api` (talking to the server), showing errors, and remembering small things in the browser. It imports nothing, so it's always ready first. |
| `format.js` | Escaping and formatting text, times, initials, colours and badges. |
| `live.js` | Live updates (your friend writing on their own, unread dots), and reloading when the app is updated. |
| `channels.js` | Channels, categories, the sidebar, dragging, and channel settings. |
| `messages.js` | Sending, turns, regenerating, stopping, editing, deleting, and drawing messages. |
| `composer.js` | The box you write in, posting as a character, and attachments. |
| `summaries.js` | Scene summaries and the story so far. |
| `comments.js` | Comment threads. |
| `reactions.js` | Emoji reactions and custom emojis. |
| `texting.js` | Texting in OOC. |
| `notebook.js` | The notebook, the entry editor, folders and casts. |
| `library.js` | The reference library. |
| `inbox.js` | Proposals and suggestions. |
| `settings.js` | The Settings dialog, profiles and roulettes, the tool log, wake-ups, and Jev's test and log. |
| `themes.js` | Themes, Appearance and the theme editor. |
| `friend-page.js` | Friends and servers: the rail, the friend menu, new friends and server settings. |

`glass.js` (real refraction for the glass themes), `style.css` and the themes are unchanged.

A few areas beyond the guide's list got their own module (`format`, `live`, `summaries`, `comments`, `reactions`, `library`), to keep each file a readable size. The guide's `presence` module will be written in stage 7, where presence is built. For now, live updates are in `live.js`.

## How the split was done

The split was done by a script rather than by hand, so no function was changed along the way. Every top-level function and value in `app.js` went to the module for its section, keeping its comments. Each module imports exactly the names it uses from the others and exports the ones others use. The script also checked for the two ways a split like this can break:

- **Assigning to another module's variable** (modules can't do that). There was none.
- **Using another module's value while the modules are still loading** (it wouldn't exist yet). Only `main.js` does anything at load time beyond setting up its own values, and it runs last, after every module it imports.

## The `***` fix

`***Finally.***` used to come out as crossed tags (`<strong><em>Finally.</strong></em>`), because `**` took two of the three asterisks first. `formatText` in `format.js` now handles `***text***` first, as `<strong><em>text</em></strong>`. `test/format.test.ts` checks this, along with escaping (HTML in a message never becomes working HTML) and the other formatting.

## Checked

- `bun run typecheck`: clean.
- `bun test`: 434 tests pass (431, plus 3 new formatting tests).
- In a phone-sized browser, against a fake nanoGPT, with no console errors:
  - every dialog opens: Settings, profiles, the Jev log, the notebook, Appearance, channel settings, the tool log, the inbox, a new channel, attachments, the friend menu and server settings;
  - sending in `#story` gets a reply, with `***` formatted correctly;
  - regenerating, editing, reacting and commenting work;
  - OOC texting sends your bubbles and gets your friend's answer;
  - switching themes and making a second friend work.
