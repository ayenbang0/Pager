# Changelog

All notable changes to pager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Changelog system**: what's new shows on startup after an update, and `/changelog [version]` shows recent changes on demand
- **Merge-conflict prediction** between agent branches and your checkout, shown after each turn and in `/agent runs`
- **Verify gate**: `/agent verify <cmd>` runs after each turn and blocks `/agent merge` on failure (`--force` overrides); `/agent log` shows the output; `+/-` line counts per run
- **Undo**: `/agent undo <name> [n]` and `/agent checkpoints <name>`
- **Risky-action approval** for ACP agents: `/agent risk on|off`
- **Daily budgets**: `/agent budget`
- **`/search <text>`** over chats and the agent room, and a "Since you left" recap on startup

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
