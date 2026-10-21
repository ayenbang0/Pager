# Changelog

All notable changes to pager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
