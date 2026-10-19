# Changelog

All notable changes to pager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
