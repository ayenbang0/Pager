# Changelog

All notable changes to pager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-10-22

### Added

- **Crash log**: an error nothing caught (a failed background task, a rejected promise) is written with a timestamp to `crash.log` in the data directory and shown as an error toast; pager keeps running instead of closing the window
- **Desktop Board block** (`Alt+Mod+K`): the pane's `TODO.md` as a kanban. `##` headings are lanes, `- [ ]` items are cards, `#tags` are labels, `📅 2025-01-31` (also `@{…}` and `due:`) is a due date, indented checkboxes are subtasks with a counter. Board and List views, drag between lanes, quick add, a card editor, and live reload when the file changes on disk. Edits rewrite only the lines they change and are written atomically, so front matter, prose, other lists, CRLF/BOM and Obsidian Kanban files (archive lane, settings footer) are kept byte for byte
- **Desktop Task manager block**: processes with CPU, memory and GPU as a sortable list or a parent/child tree, a detail card (owner, path, command line), and Stop (close its windows), Force Quit (optionally with its children) and Pause behind a confirmation. Pager's own processes, the session daemon and critical Windows processes can never be ended from it. Sampling runs only while the pane is visible and the sampler exits 30 s after the last request
- **Desktop Screen block**: view this machine's displays (nothing is captured until you pick one), Fit or Actual size, a LIVE/REC indicator, optional recording to a `.webm`. Driving a display is a separate per-session opt-in behind a red banner (Esc three times stops it); it ends when the pane is hidden or after 10 idle minutes, and every held key and button is released. Sharing a screen with another machine is not included
- **Session daemon** (`pager daemon`, see `desktop/DAEMON.md`): one background process owns every program of the desktop window, so closing the window only detaches and agents, bots, chat and calls keep running (the first pane is the Pager TUI itself). Windows and the CLI start it on demand on `\\.\pipe\pager-<USERNAME>` (`PAGER_DAEMON_SOCKET` overrides); an explicit Quit or `pager daemon stop` ends it. Several windows show the same output live, a window that falls behind is resynced from a replay, and `daemon.state` (layout, folders, newest 2 MiB of output per pane, written atomically and debounced) brings every pane back in its folder after a reboot or crash, agents resuming with `--continue`
- **Scripting the daemon**: `pager daemon start|stop|status`, `pager split right|down`, `pager send`, `pager capture`, `pager ls`, `pager events` (JSON lines) and `pager open PATH[:LINE[:COL]] | URL`; inside a desktop pane `pager run` opens the command in a new shell beside it
- **`pager serve`** (web access to the session daemon): the daemon's panes in a browser, with live xterm.js terminals, typing, resize, new tab, split and close, a Run box and copy-screen, from a small web client embedded in pager (no files at run time). It listens on `127.0.0.1:8377` (`--port`, `0` for a free port) and prints one URL with a random per-run token in the fragment that the page exchanges for an `HttpOnly; SameSite=Strict` cookie. Constant-time token compare, five wrong tokens lock an address out for a minute, `Host` and `Origin` checks (DNS rebinding, cross-site WebSockets), no CORS, a strict CSP, WebSocket messages capped at 256 KiB and input at 64 KiB. `--read-only` refuses every change on the server; `--host 0.0.0.0` is an explicit opt-in with a warning, `--tls-cert`/`--tls-key` serve https and `--allow-host NAME` admits a proxy's name. `pager serve --status` and `pager serve --stop` manage the running server
- **Inline terminal graphics** (desktop): a program draws a diagram, formula, diff or picture inside the terminal with `ESC ] 7777 ; pager-surface ; <base64 JSON> ST` (`{kind: mermaid|math|diff|image|html-sandbox, id, source, title?, height?}`, `height` in rows). The block is anchored to its line in the scrollback, scrolls and reflows with it, and has copy-source and open-in-a-pane buttons. Mermaid uses `securityLevel: 'strict'` and KaTeX `trust: false`; diagrams and html pages live in `sandbox=""` iframes with a no-network CSP, diffs (unified or side by side, collapsible hunks) are built from text nodes only, images must be png/jpeg/gif/webp data URLs; a payload is capped at 1 MiB and a terminal keeps at most 100 blocks. `pager show mermaid|math|diff|image <file|->` prints the sequence (`--title`, `--id`, `--height`). Full-screen programs (alternate screen) cannot draw blocks
- **Desktop Chats block** (`Ctrl+Alt+C`, a Home tile, the + menu and the palette): pager's chat inside the window - people, groups, rooms, agents and the AI assistant, with presence, reactions, windowed threads for long conversations, typing and a short local command list (/share /invite /agent /me /mute /clear). **Shared agents and shared blocks**: the Share menu of a chat offers your mounted blocks (canvas, board, notebook live; files, tasks, screen read-only or snapshot), guests join from the host's link and see edits and cursors live over the daemon's chat wire; agent sessions are offered into DMs and groups the same way. One chat Engine lives in the session daemon on the same data directory as the terminal pager, so chats keep running with the window closed; the identity is passphrase-locked and LAN peers link up without a server. A data directory has one chat Engine, so the terminal pager and the daemon take turns: starting pager in a terminal asks the daemon to hand the directory over (`chats.yield`) instead of refusing with `pager is already running`, and the Chats block says that pager is open in a terminal and connects again by itself when it quits. A terminal pager older than this release cannot be asked; the block then waits for it to quit

### Changed

- **Desktop: Home is a glass block, pinned.** The first pane of every session is now the Home block instead of the Pager terminal UI: a greeting, quick-action tiles (new terminal and agent, Chats, Files, Git, Database, Notebook, Canvas, Board, Tasks, Screen, browser pane, docs, settings, command palette), a live Running now list that jumps to the pane's tab, recent folders and the newest changelog entries. It has no close button and the daemon refuses to close it (`Pager home stays open`). Chats opens in the kit-based Chats block; the classic terminal UI has no desktop palette command. Saved sessions from before get a Home tab first
- **Desktop: one quiet UI kit across the shell and every block.** Flat accent controls, hairline borders and shared segmented controls, menus, dialogs, empty states and status dots replace decorative gradients, radial glows, pulsing indicators, tinted empty-state icons and per-block button forks. Home, Chats, Files, Git, Database, Notebook, Board, Tasks, Screen and Canvas use the same simple visual language; Canvas has one unified toolbar and notifications go through the global toast host
- **Desktop: new blocks from the + button.** Hovering the + (new tab) button, in the top bar or the vertical tab list, opens a menu with Terminal and every block (Files, Git, Database, Notebook, Board, Tasks, Screen, Canvas, Chats); picking one opens it in a new tab. Clicking + still opens a terminal
- **Desktop: no more agent blocks.** "New omp / Claude Code / opencode / Hermes block" (Ctrl+Shift+A), the agent composer surface, and the Agent, Agent opens, Open agents with the composer, New blocks open and Custom agents settings are gone; start an agent by typing its command in a terminal
- A stray error still ends pager when it is not safe to go on: the terminal is gone (EPIPE, EIO), memory ran out, or twenty errors arrive within ten seconds
- If the interface itself throws while rendering, pager exits non-zero with the error and records it in `crash.log`
- **One smooth look, no pixel art.** The pager logo is a single rounded P stroke (blue to indigo) instead of the pixel P: the app tile is the docs and bot studio favicon and sidebar mark (`logo.svg`; `logo-mark.svg` is the tile-less mark), and heads the README
- The Home screen in the terminal shows a plain `P A G E R` wordmark in the theme gradient between two rules, instead of the big block-letter logo, and no longer glitches into block glyphs
- Terminal spinners are the standard braille dots (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), the same frames the window title uses
- The docs, stats and bot studio site is restyled: Geist and Geist Mono (SIL OFL, served by pager itself behind the site's random token, so no network), a pitch-black page by default with glass cards on a 1px ring, 1.45-stroke vector icons and an Appearance control (dark, light, system)
- The README no longer describes the desktop window as pixel-styled or the Departure Mono pixel font
- Right-click inside a block pane opens the pane menu too, with **Close block** instead of **Close pane** (the pinned Home pane still cannot be closed; the daemon refuses), instead of doing nothing

### Fixed

- `/bot remove` no longer closes pager when Windows keeps the bot's sandbox folder open (EPERM): the folder is retried for half a second, and if it still will not go the bot is removed anyway and a warning names the folder left behind
- Leaving a group warns about bot sandbox folders that could not be deleted instead of failing
- Chat events no longer miss a join-then-leave inside one 50 ms coalescing window: every mutating chat RPC first publishes the pending snapshot, so the leave is diffed against the joined state clients saw and `chats_changed.removed` is delivered. A `chats.retry` racing an in-flight engine start no longer starts a second engine, and leaving a group from the sidebar passes its explicit chat id instead of acting on the focused chat
- Clearing the AI chat and clearing the agents' memory report a locked file instead of throwing, and `Agents: check installs` and `/agent commands` no longer fail on a locked temporary folder
- The lock file is removed with the same care at start and exit: a stale one that is held open no longer aborts startup, and a failed delete on exit is ignored
- The desktop window's caption buttons (minimize, maximize, close) used a fixed grey that was hard to see on a light title bar: the symbol colour now follows the theme, and it is sent before the first paint
- The Canvas block's hand-drawn text did not render in the packed app: its font URL pointed at `desktop/assets/fonts`, a folder the packer never shipped; the font now lives in `renderer/fonts` and travels with the window
- Bell and open events from the daemon were dropped by every window: a bell in a visible pane now flashes its border, a bell in any other tab rings the inbox chip, and `pager open` from the CLI or another window focuses the opened pane's tab in every attached window
- The session daemon no longer loads the chat encryption and network modules (sodium-native, hyperdht) at startup: the Chats bridge imported them through a shared helper, so a machine that refused to load one (for example Windows Smart App Control or an Application Control policy) killed the daemon and every terminal with it. Conversation ids now come from `chat/convId.ts`, the daemon stays free of those addons until Chats is opened (guarded by `nativeFree.test.ts`), and a blocked module shows in the Chats block as one clear message instead of the daemon being unreachable
- A message in a group with no other member showed the pending clock forever; it is now sent, and never delivered or read
- The packed app no longer ships the developer harness pages (`_harness` folders); they stay in the repository for `git.test.cjs` and `desktop/UI.md`
- Light theme text was too faint in places (placeholders, timestamps, status lines, code and terminal colours, tinted surfaces): secondary and tertiary text, the accent, status colours and the ANSI palette now keep at least 4.5:1 against their backgrounds, and the dark theme is unchanged
- Quitting pager (or stopping the daemon) while an agent's readiness check was still handshaking waited out its 15 second timeout: closing now aborts the check and its process

### Removed

- The `⌕ web` tab in the sidebar's TOOLS section, its `⌕ Web` palette entry, `/open web`, and its labels in the status bar, breadcrumb and window title. Agents keep `web_search` and `web_read` (Settings > AI chat and Web, `PAGER_NO_WEB=1`)

## [1.10.0] - 2026-10-22

### Added

- **Calls**: `/call` for voice calls in DMs and named call rooms in groups, `/mute` and `/hangup`; sound uses SoX, which `/call setup` installs
- **Pings and sound presets**: `/ping <name>` plays a sound on their machine; Settings > Notifications picks a sound mode (all, pings only, off) and presets for messages and the call ring
- **Group screen** (`/group members`): people, bots and call rooms in one list, with keys to ping, open a chat, join a room or change a bot
- **Requests screen** (`/requests`): contact requests, group invites and agent sessions to accept or decline
- **Bot model and effort**: `/bot model` and `/bot effort`, and Model and Effort fields in the bot studio

### Changed

- `/group members` and `/bot list` open the group screen instead of printing to Home; `/accept` with several items pending opens the requests screen
- The Chime switch became Sounds (all, pings, off); an old "off" stays off

## [1.9.0] - 2026-10-21

### Added

- **Browser pane (desktop window)**: a real browser docked beside the terminal, toggled with Ctrl+Shift+B or the `web` button: tabs, address bar with search, back, forward, reload, a draggable divider, pages in a sandboxed session with no permissions and no downloads
- Ctrl+click a link in the terminal output to read it in the pane
- Pages open links in new tabs; Ctrl+L, Ctrl+T, Ctrl+W, Ctrl+Tab, F5 and Alt+Left/Right work while a page has focus

### Changed

- `/docs`, `/studio`, `pager docs`, `pager studio`, F1, F2 and the web tool's `open <n>` show their page in the pane; pager no longer starts your default browser. Outside the desktop window they print the address instead
- Chromium switches such as `--remote-debugging-port` are no longer passed on to pager by the desktop window

### Fixed

- A taskbar button pinned from the desktop window kept Electron's icon: the window now declares the pager icon for pins and relaunch, not only in the exe (unpin the old button and pin again)

## [1.8.0] - 2026-10-21

### Added

- **Bot studio**: `/studio`, `pager studio`, or F2 / the `bots` button in the desktop window open a local page (127.0.0.1, random token in the URL, changes only by a POST that carries a header a foreign web page cannot send) to shape bots in detail: persona, keywords, only-when-called mode, reply cap, cooldown, history length, document access, ignoring other bots, pausing
- **Bot preview and test**: the studio shows the exact prompt a bot is sent and tries the bot on a pretend message without posting anything
- Bots keep working as before: `/bot` bots get the defaults, `bots.json` entries from older versions load unchanged, and a bot's job may now be up to 4000 characters and several lines
- `scripts/install.ps1` (`irm … | iex`): per-user install of the desktop window from a GitHub release, verified by SHA-256; `npm run desktop:pack` writes the `.sha256`, and a tag workflow publishes both
- Local docs and usage stats: `/docs`, `pager docs`, or F1 / the `docs` button in the desktop window open a read-only site on 127.0.0.1 (random token in the URL) with every command, key binding and feature, plus your messages, agent turns, tokens and terminal commands (programs only, never arguments) computed from your data directory

### Fixed

- The desktop window's taskbar button, a pinned shortcut, Alt+Tab and Task Manager showed Electron's icon; `Pager.exe` now carries the pager icon and version info (stamped by `npm run desktop:pack`)

### Changed

- The app icon is the plain pixel P, in the window, the Windows Terminal profile and the docs

## [1.6.0] - 2026-10-20

### Added

- **Group bots**: `/bot add <name> [@backend] <job>` puts an AI bot in a group. It decides after every message whether its job calls for a reply, always answers `@name`, can answer other bots without spamming, and can write the group's Markdown documents; CLI agents work in a sandbox folder under the data directory
- **More themes**: flat themes without gradients (nord, gruvbox, slate, paper) and new visual ones (dracula, synthwave, tokyo, rose, forest, matrix)
- **Custom themes**: `New custom theme…` in the palette saves the current theme to `themes.json` for editing; `Reload custom themes` applies your changes
- **Real terminal**: the Terminal tab is now a shell on a PTY (colors, full-screen programs, resize, history, Ctrl+C) instead of one process per line; up to six tabs with `/terminal new` and `/terminal close`, and `PAGER_SHELL` picks the shell (default: pwsh, then powershell, then cmd on Windows; `$SHELL` elsewhere)
- **Command blocks**: bash, zsh, fish and PowerShell mark each command, so a gutter bar shows running, passed or failed; `Alt+K` selects a finished command to copy its output (`c`) or text (`y`), rerun it (`r`), view a lens (`l`) or send it to the AI tab to explain (`e`)
- **Output lenses**: `ping`, `dig`, `curl -i/-I/-v`, `traceroute` and `tracert` output shows as a compact card; anything unrecognised stays as plain output
- **Desktop window (Windows)**: `pager desktop install` adds a glass-and-pixel window host (Windows Terminal profile in pitch black with clean Cascadia Mono text (plus a 55% acrylic `Pager Glass` profile)), a Start menu entry and an "Open Pager here" folder menu, all per-user without administrator rights; `desktop launch`, `status` and `uninstall` manage it. An own-window Electron host (`npm run desktop:pack`, unsigned unless `PAGER_SIGN_CMD` is set) is used instead when it can start on the PC
- **Run from outside**: `pager run [--cwd DIR] [--] <command>` and `/run [--cwd <dir>] <command>` open a new Terminal tab and type the command into it; `pager run` hands the request to the running pager or starts one with it, and `pager --cwd DIR` starts in a folder
- `Ctrl+H` jumps to Home and replays the logo animation, even after a command replaced the welcome screen
- A start-up failure caused by Windows Smart App Control blocking a native file now names the file and says why

### Changed

- In the Terminal tab only Alt+Up/Down, Alt+P and Alt+K belong to pager; every other key, including Ctrl+C, Ctrl+D and Ctrl+P, goes to the shell (Quit is in the palette)

### Removed

- The line-at-a-time terminal runner (`cd`/`clear` interception, `TERM=dumb`)

## [1.5.1] - 2026-10-18

### Added

- **AI chat**: a ✦ ai tab to talk to your installed agents, a local Ollama or any OpenAI-compatible API without a git repository; tools run in a scratch folder, history stays on your machine, and @name picks who answers
- **Web search**: a ⌕ web tab (search, open, read) backed by DuckDuckGo; agents can call web_search and web_read too
- **Settings tab** (Alt+S or /settings): theme, accent, density, name, badge, notifications, folders, agents, AI backends, privacy and advanced switches in one place
- **Sidebar folders**: sections fold with a click, the sidebar scrolls, and you can file chats, docs, the AI tab and the agents room into your own folders
- **Group rename**: the creator renames a group with /group rename and every member sees it
- **Message reactions**: click a message to react with an emoji; reacting again removes it
- **More emojis**: about 500 :shortcodes:
- **Encryption at rest**: pager lock protects your identity key and encrypts message history, group titles and contact names with a passphrase; pager unlock reverses it
- **LAN mode**: pager --lan chats over a local network with no internet, discovering or hosting the local network automatically
- **No-agents mode**: pager --no-agents turns off the agents room, the AI tab and the agent tool server
- **Changelog system**: what's new shows on startup after an update, and `/changelog [version]` shows recent changes on demand
- **Merge-conflict prediction** between agent branches and your checkout, shown after each turn and in `/agent runs`
- **Verify gate**: `/agent verify <cmd>` runs after each turn and blocks `/agent merge` on failure (`--force` overrides); `/agent log` shows the output; `+/-` line counts per run
- **Undo**: `/agent undo <name> [n]` and `/agent checkpoints <name>`
- **Risky-action approval** for ACP agents: `/agent risk on|off`
- **Daily budgets**: `/agent budget`
- **`/search <text>`** over chats and the agent room, and a "Since you left" recap on startup

### Changed

- **Fewer commands**: /theme, /accent, /badge, /density, /notify, /sound, /name and /net moved to Settings; /agent keeps only the work-flow subcommands, the rest moved to Settings > Agents and the Ctrl+P palette
- **Source layout**: the source tree is organized into domain folders (no behavior change)

### Fixed

- **What's new after install**: CHANGELOG.md is now shipped in the package and found at runtime, so the changelog appears after npm install
- **/changelog <version>**: shows exactly that version

## [1.2.1]

### Added

- Peer-to-peer group chat with CRDT-based shared documents
- Agent orchestration: run multiple coding agents in isolated worktrees
- Agent chaining with automatic peer review between turns
- Shared agent sessions: invite contacts to view or control your agent room
- Command palette (Ctrl+P) with fuzzy search across all commands
- Theme picker with live preview and custom accent colors
- Desktop notifications with configurable chime sound
- Built-in terminal tab for running shell commands
- Message input history (up to 500 lines)
- Autocomplete from message history and learned vocabulary

### Changed

- Rebuilt UI with ink 8 and React 19
- Improved connection resilience with exponential backoff reconnection
- Optimized database queries with WAL mode SQLite

### Fixed

- Direct message delivery reliability
- Agent session sharing edge cases

## [1.1.0]

### Added

- Agent system with ACP (Agent Client Protocol) support
- MCP shim for stdio-based agent communication
- Git worktree isolation per agent
- Agent question queue with elicitation support
- Board state (shared goal and tasks) for agent teams
- Memory system for shared agent notes

### Changed

- Refactored message ingestion pipeline
- Improved sync protocol efficiency

## [1.0.0]

### Added

- Initial release
- Peer-to-peer messaging over HyperDHT
- Contact codes for easy peer discovery
- Direct messages and group conversations
- Read receipts and delivery status
- Basic settings (theme, density, badge)
