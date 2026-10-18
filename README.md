# pager

A simpler way to chat. A full-screen TUI: add people with a shareable contact code, chat 1:1 or in groups, with in-app toasts. No server: peers find each other over the [HyperDHT](https://github.com/holepunchto/hyperdht) and connect directly. History is stored locally in SQLite.

## Install

Requires **Node 24+** and npm.

```sh
npm install -g pager-cli   # then run: pager
```

Or from source:

```sh
git clone https://github.com/ayenbang0/Pager.git
cd Pager
npm install
npm run build
npm start            # or: node dist/cli.js
```

The npm package is named `pager-cli`; the command is `pager` (`npm link` puts it on your `PATH`). On Debian/Ubuntu `/usr/bin/pager` already exists, so make sure the npm bin directory comes first in `PATH`.

`pager` needs an interactive terminal (at least 60x12). `pager -h` and `pager -v` print usage and version.

## Quick start

1. Run `pager`. The home view shows **your contact code** (`pgr1-…`) beside a summary: contacts and who is online, messages sent and received, a 7-day activity chart, and agent runs. `/code` shows the code again.
2. Send your code to a friend. They run `/add <your code> [note]`.
3. You get a toast and a **PENDING** entry in the sidebar. Run `/accept 1`.
4. Both of you now see each other under **DIRECT** (`●` online, `○` offline). `/open <name>`, type a message, press Enter.

Plain text + Enter sends to the open conversation. A message starting with `//` is sent as literal text with one `/` removed.

## Commands

| Command | What it does |
|---|---|
| `/help` | List commands |
| `/code` | Show your name and contact code |
| `/name <new name>` | Change your display name (1–64 chars) |
| `/add <code> [note]` | Send a contact request (delivered when they are online) |
| `/accept [n]` | Accept pending item `n` (number in the sidebar) |
| `/decline [n]` | Decline: blocks a contact request, or leaves a group invite |
| `/open <name>` | Open a DM or group (exact name, unique prefix, or ≥4 hex chars of a public key) |
| `/remove <name>` | Remove a contact (also unblocks); history is kept |
| `/group new <name>` | Create a group (you are its creator) |
| `/group invite <name>` | Invite an accepted contact (creator only, max 16 members) |
| `/group members` | List members of the open group |
| `/group leave` | Leave the open group permanently |
| `/theme [name]` | Show or switch the color theme: `omp` (default), `terminal`, `mono`, `ocean`, `amber`, `light` (saved) |
| `/terminal` | Open the built-in Terminal tab |
| `/doc new <name> [in <chat>]` | Create a shared Markdown document; also `open`, `rename`, `rm`, `list`. Without `in <chat>` it is private |
| `/agent <name> <task>` | Run a coding agent in an isolated worktree (`omp`, `claude`, `opencode`, `hermes`); also `chain`, `memory`, `commands`, `runs`, `stop`, `merge`, `drop`, `check` |
| `/agent invite <contact> [--view]` | Let a contact into your agent room: they can message the agents and answer questions (`--view`: only watch). Also `guests`, `kick <contact\|all>`; a guest uses `/accept n` and `/agent leave` |
| `/net` | Show which contacts are connected, their capabilities, and where `net.log` (link events and protocol errors) is |
| `/agent setup` | See which agent CLIs are installed and ready, add a teammate (Enter) or register a custom ACP agent (`custom: <id> <command…>`) |
| `/search <text>` | Find text in your chats and the agent room (newest 20 of the last 20,000 messages) |
| `/changelog [version]` | Show what changed in recent updates |
| `/quit` | Exit |

## Keys

| Key | Action |
|---|---|
| Enter | Send / run command |
| Tab, Up/Down | Complete the highlighted command / move in the palette (or input history) |
| Right, End, Tab | Accept the dim suggestion. It learns from what you type: whole lines you have sent before (most-used first), then your own vocabulary and the words you usually put after each word. Shell lines in the Terminal tab are learned as whole lines only |
| Ctrl+P | Command palette: switch conversation, accept/decline, change theme, and more |
| Ctrl+G | Keyboard shortcut help (no printable key is a shortcut, so every character, `?` included, types normally) |
| Alt+Up / Alt+Down | Previous / next conversation (home is first) |
| Ctrl+O / Ctrl+N | Same, for terminals that do not send Alt+arrows (macOS Terminal.app by default) |
| Alt+M | In an agent tab: pick that agent's model and effort (also the palette, `/agent model|effort <name>`, or a click on the chip in the tab header) |
| Alt+Q | Jump to the agent that is asking you a question; the question appears in place of the prompt (Up/Down, Space, Enter, Tab, Esc) |
| Ctrl+B | Toggle the sidebar (saved) |
| Mouse wheel / trackpad scroll, PgUp / PgDn | Scroll messages (3 lines per wheel notch). With the wheel active, hold Shift (Option in iTerm2) to select text with the mouse |
| Ctrl+T, click `▸ N more lines` | Fold / expand long messages (over 30 rows) |
| Ctrl+A / Ctrl+E, Home / End | Start / end of line |
| Alt+B / Alt+F, Ctrl+Left / Right | Word left / right (Option+Left / Right on macOS; Option+B / F also works without "Option as Meta") |
| Alt+Backspace | Delete word back (Option+Delete on macOS) |
| Ctrl+W, Ctrl+U, Ctrl+K | Delete word back, to line start, to line end |
| Esc | Clear the input (closes the palette / help) |
| Ctrl+C | Clear the input; on an empty prompt press again within 2 s to quit. In the Terminal tab it stops the running command; in the Docs editor it copies |
| Ctrl+D (empty prompt) | Quit |

## Configuration

| Variable | Meaning |
|---|---|
| `PAGER_HOME` | Data directory (default `~/.pager`); agent worktrees live in its `worktrees/` folder |
| `PAGER_BOOTSTRAP` | Comma-separated `host:port` DHT bootstrap nodes (default: public HyperDHT) |
| `PAGER_REDUCE_MOTION` | Set to `1` to disable animations (connecting spinner, toast countdown bars) |
| `PAGER_NO_UPDATE_CHECK` | Set to `1` to skip the daily check for a newer release |
| `PAGER_NO_MOUSE` | Set to `1` to leave the mouse alone (no wheel scrolling or click-to-expand; plain drag selects text) |
| `PAGER_NO_NOTIFY` | Set to `1` to turn off the bell when pager is unfocused and the taskbar progress indicator |
| `PAGER_NO_ACP` | Set to `1` to run every agent one-shot instead of over ACP |
| `PAGER_ACP_LOG` | Path of a file that receives the ACP JSON-RPC traffic (debugging) |

Data directory contents: `identity.json` (your secret seed and name; keep it private, losing it means contacts must re-add you), `pager.db` (SQLite history), `settings.json` (theme, sidebar), `history.json` (your last 500 inputs, for Up and the dim suggestion), `update.json` (cached latest version and check time), `agents-room.jsonl` (agents room transcript), `agent-sessions.json` (agent session ids), `memory/` (shared agent notes per repository), `worktrees/` (agent worktrees), `pager.lock` (one instance per directory).

When pager is not focused (terminals that report focus: Windows Terminal, iTerm2, kitty, Ghostty, WezTerm, tmux with `focus-events`) it rings the bell when a message arrives or the agents finish, and Windows Terminal, iTerm2, Ghostty and WezTerm also show an indeterminate progress indicator while agents run. A message that arrives in the conversation you are looking at rings too, and ghostty, WezTerm and iTerm2 also get a desktop notification (sender and a preview); other terminals rely on the bell.

### Updating

Once a day pager asks the npm registry for the latest `pager-cli` (one short request, failures are silent). If a newer release exists you get a toast and a `↑ x.y.z` badge in the status bar. `/update` checks on demand. Quit pager and run `pager update` to install it (`npm install -g pager-cli@latest`); it refuses while a pager is running in the same data directory, and on Windows it fails with a "file busy" message if another pager instance still holds the install open. Only releases that already contain this feature can announce updates. After updating, the home screen shows **What's new** on next launch; `/changelog [version]` shows it any time.

### Trying it on one machine

```sh
npm run testnet                     # prints PAGER_BOOTSTRAP=127.0.0.1:<port>
PAGER_HOME=/tmp/a PAGER_BOOTSTRAP=127.0.0.1:<port> npm start     # terminal 1
PAGER_HOME=/tmp/b PAGER_BOOTSTRAP=127.0.0.1:<port> npm start     # terminal 2
```

If your shell exports `CI`, pager still renders (it forces interactive mode when attached to a TTY).

## How it works

```
 pager (TUI) ── Engine ── Net ── HyperDHT ── direct encrypted socket ── peer
                  │
               SQLite (history, contacts, acks)
```

- **One process.** The TUI is the P2P node. There is no daemon and no server we run. Messages are received only while `pager` is open; messages sent to an offline peer wait in your local log and are delivered the next time you are both online.
- **Identity.** A random 32-byte seed creates an ed25519 keypair. Your **contact code** is `pgr1-` + the base32 public key + a 4-character checksum, so typos are caught.
- **Connecting.** `Net` dials every peer you want to stay connected to (contacts, pending requests you sent, group members) through HyperDHT, which handles NAT hole punching and encrypts the connection (Noise). Dials retry with exponential backoff (2 s up to 5 min). Each side sends a `hello` with its name; if both dial at once, the connection initiated by the lexicographically smaller public key wins.
- **Contacts.** Mutual consent: `/add` sends a `contact-request`; the other side `/accept`s, which sends `contact-accept`. Declined peers are blocked at the DHT firewall. Unknown peers may only send a contact request and are disconnected otherwise.
- **Messages are signed events.** Every message is an ed25519-signed event `(conversation, author, seq, timestamp, kind, body)` with a per-author sequence number. DMs and groups use the same mechanism. Received events pass a single gate (`src/ingest.ts`): the sender must be entitled to the conversation, the author must be a member, the signature must verify, and `seq` must be exactly the next one. Anything else is silently dropped.
- **Sync.** On every connection peers exchange a `sync-state` (the highest `seq` they hold per author, per shared conversation) and send each other whatever is missing. That gives offline catch-up and lets group members relay events to each other. Receivers `ack` events; your message shows `…` until the recipient(s) acked, then `✓`.
- **Groups.** The creator invites contacts with signed `member-add` events (max 16). Members connect to each other directly. `member-leave` is permanent for that group. New members receive the full history.
- **Hardening.** Frames are newline-delimited JSON, validated with zod, capped at 256 KiB, and peer-supplied text containing control characters (terminal escape injection) is rejected.

## Terminal tab

`▸ terminal` in the sidebar (or `/terminal`, or the palette) runs shell commands without leaving pager: each line runs in your shell (`cmd` on Windows, `$SHELL` elsewhere) in a persistent directory (`cd` works, `clear` empties the tab), output streams in with escape codes stripped, and a line typed while a command runs goes to its stdin. Ctrl+C stops the command; one that ran over 5 s rings an unfocused terminal when it ends. There is no pseudo-terminal, so full-screen programs (vim, htop) do not work. A line that must start with `/` is typed with `//`.

## Docs tab

`▤ docs` (or `/open docs`) is a Markdown editor for notes, plans and specs that several people edit at once. A document belongs to a conversation: `/doc new plan in team` shares it with everyone in `team`; plain `/doc new plan` goes into a private `notes` group. Open one from the list (PgUp/PgDn or click, then Enter) or with `/doc open plan`.

- **Editing is vim.** Normal, insert, visual and visual-line modes; counts; `h j k l w b e 0 ^ $ gg G { } f t ; ,`; operators `d c y > <` with motions and the text objects `iw aw ip ap` and quotes/brackets; `x X D C s S p P J r ~ u Ctrl+R`; `o` and Enter continue Markdown lists; `/` search with `n N`; `:w :q :wq :qa :rename <name> :<line>` and `:%s/pat/rep/g`. Dot-repeat, macros and registers other than the unnamed one are not implemented.
- **Everything else still works.** Click places the cursor, the wheel scrolls, Ctrl+C copies the selection (or the current line), Ctrl+V or your terminal's paste inserts, Ctrl+Z undoes and Ctrl+Y redoes (your own changes only, even while others type). Yanks also go to the system clipboard.
- **Live collaboration.** Edits are a text CRDT (RGA) carried as signed events in the conversation, so they sync like messages: concurrent edits merge without conflicts, an offline collaborator catches up on reconnect, and documents survive restarts. The status line shows who edited in the last 30 s. Document operations are hidden from the chat; older pager versions in the same chat will see them as unreadable lines.
- **Agents.** An agent sees a document only when you name it in the task as `#name` (for example `/agent claude tighten the intro in #plan`). The text is passed in a `--- DOCS ---` section (up to 12k characters) labelled as data, and the agent edits it by ending its reply with `@@doc <name>` … `@@end` (replaces the document; only the changed middle is applied, so concurrent edits elsewhere survive) or `@@docappend <name>` … `@@end`. It can only edit documents it was shown, cannot create or delete any, and edits as you. **Treat shared documents as untrusted input:** collaborators can write anything into them, and agents auto-approve their own tool use, so name only documents whose authors you trust. Nothing is ever included implicitly.
- **Limits.** Deleting a document hides it for everyone; its operations stay in the log. Positions count UTF-16 units, so wide characters can misalign the cursor column.

## Coding agents

`/agent` runs the coding agents installed on your machine (`omp`, `claude`, `opencode`, `hermes`) and lets them hand work to each other. It works only inside a git repository with at least one commit, and only on what you type locally or what a contact you explicitly invited types (see Shared agent sessions): nothing else from a peer or a chat can ever start or steer an agent.

```
/agent claude fix the flaky retry test     # starts a run; replies appear in the ⌁ agents room
@omp add unit tests for src/db.ts           # same, typed inside the agents room
/agent runs | stop [run] | merge <run> | drop <run|all> | check
/agent chain omp>claude <task> | memory [add <text>|clear] | commands <name> | cli <name> <args>
```

- **Isolation.** Every run gets its own git worktree and branch `pager/<agent>-<id>` under `<data dir>/worktrees/`. Agents start from `HEAD` (uncommitted edits are not visible). Pager commits each run's work automatically. Runs are headless and **auto-approve their own tool use**: the worktree isolates git state, not the shell, so an agent can still touch files outside it or use the network. Only run agents on tasks and repositories you trust them with.
- **Cooperation.** An agent can end its reply with `@@ask <agent>` … `@@end` blocks. Pager runs the asked agent on top of the asker's commit, then resumes the asker with the replies. Runs in one task are strictly sequential and stacked, so agents on different models and APIs never write the same files at once. Limits: 3 concurrent runs, delegation depth 3, 10 runs per task. A run has no time limit; end a stuck one with `/agent stop`.
- **Chains.** `/agent chain omp>claude <task>` (or `@omp>claude <task>` in the room) does not depend on an agent volunteering `@@ask`: the first agent works, and each next one starts on top of the previous commit with the original task plus the previous reply and the instruction to review it and fix what it finds. Up to 4 agents; the chain stops at the first failed step.
- **Merging.** Nothing reaches your checkout until you `/agent merge <run>`. It refuses on a dirty checkout, and on a conflict it aborts, names the conflicting files and leaves the tree untouched. Merging a run also retires the earlier runs it was built on. Pager warns when separate tasks change the same files.
- **Conflict prediction.** After each turn that changes files, pager dry-runs a merge of every unmerged agent branch into your checkout and into each other with `git merge-tree --write-tree` (git 2.38+, never touches a worktree) and warns once per new conflict; `/agent runs` ends the line with `conflicts: …`. Older git shows nothing.
- **Verify gate.** `/agent verify <command>` sets a per-repo shell command (`off` clears it, no argument shows it). It runs in the agent's worktree after every turn that changed files (5 min timeout, last 20,000 characters kept) and the result goes to the room. `/agent merge` refuses when verify failed on the branch's current commit and runs it first when it has not run; `--force` skips it. `/agent log <run|name>` posts the kept output, so nobody reruns it. The board shows `verify: pass|fail`. Turn summaries and `/agent runs` show `+adds/-dels`.
- **Undo.** Pager records the last 10 pre-turn commits per agent under `refs/pager/checkpoints/` (they survive restarts). `/agent undo <name> [n]` resets the worktree to before its last `n` turns; `/agent checkpoints <name>` lists them. It refuses while the agent works, and for work already merged into your checkout (use `git revert`). The agent is told on its next prompt.
- **Risky actions.** `/agent risk on|off` (default on). For ACP agents, permission requests for `git push` (force or to main/prod/release flagged), `reset --hard`, `clean -f`, `branch -D`, `rm -rf` / `Remove-Item -Recurse -Force` / `del /s`, package publish, deploys (`wrangler`, `vercel --prod`, `docker push`, `kubectl apply|delete`), `curl | sh` and writes outside the worktree become a question (Allow once / Allow for this run / Deny). Everything else stays auto-approved. One-shot runs (`PAGER_NO_ACP`, `claude`) cannot be intercepted, and the check is a pattern match on command text (`bash script.sh` is not caught).
- **Budgets.** `/agent budget [<name|all> turns=N minutes=N | <name|all> off]` sets daily (local day) caps from the stats log; reviews are not turns. A capped agent's next turn is refused (not queued) with a notice; one warning per day at 80%. Saved in `agent-budgets.json`.
- **Invocations.** `omp`, `opencode` and `hermes` run as Agent Client Protocol servers (`<agent> acp`, one process per run in the run's worktree): their reply streams live into the room (text plus `⚙`/`✓` tool lines, then one final message and a `used N tools` line), and permission requests are auto-approved like the other agents' flags. If the ACP handshake fails, the run falls back to the one-shot call (`omp -p --no-session`, `opencode run --auto`, `hermes chat -Q --oneshot --yolo`) with a notice. `claude` has no ACP mode and always runs `claude -p --permission-mode bypassPermissions`. `/agent check` asks each one to reply `PAGER_OK` (and whether ACP starts) so you can verify your installs. `PAGER_NO_ACP=1` forces one-shot everywhere; `PAGER_ACP_LOG=<file>` records the JSON-RPC traffic.
- **Persistence.** The room transcript is saved to `<data dir>/agents-room.jsonl` (last 500 messages) and survives restarts. Runs themselves live in memory only: after a restart, leftover worktrees stay in `<data dir>/worktrees/`; remove one with `git worktree remove --force <dir>` and `git branch -D pager/<id>` (`/agent drop` only knows runs from the current session).
- **Memory.** Three layers. The room transcript (the last 40 messages, up to 60k characters, including what other agents said and which files they changed) goes into every prompt. A repository-scoped notes file (`<data dir>/memory/<repo>.md`, passed as a `--- MEMORY ---` section, newest 8k characters) carries durable facts across restarts: agents add one with an `@@remember` … `@@end` block (up to 5 per reply), you manage it with `/agent memory [add <text>|clear]`. And `hermes` keeps its own ACP session between tasks (`omp` and `opencode` cannot resume a session across worktrees, so they rely on the first two layers).
- **Agent commands.** `/agent cli <name> <args>` (or `@name !<args>` in the room) runs the agent's own CLI, for example `/agent cli claude mcp list` or `/agent cli opencode models`, and posts the output. It is non-interactive, so commands that open a TUI or ask questions time out. A task that starts with `/` (for example `/agent claude /review`) is sent to the agent verbatim so its own slash command runs; such a run does not get the pager preamble, so it cannot delegate. `/agent commands <name>` lists the slash commands an ACP agent advertises.

## Shared agent sessions

`/agent invite <contact> [--view]` lets one contact into your Agents room, like omp's `/collab`. The guest gets `/accept n`; the session then appears in their sidebar as `◈ <your name>` (separate from their own agents). The agents always run on **your** machine in your repository.

- **Control** (default): the guest can message the agents (`@omp …`, `@all`, chains) and answer their questions; their messages show under their own name and run immediately. **A control guest has the same power over your worktree as you do through the agents** (shell, file edits, auto-approved tools), so invite only people you trust. **View** (`--view`): the guest only watches.
- **Host only:** every `/agent` command, `/…` slash commands and `@agent !…` passthrough typed by a guest are refused, and a guest's `#document` names never pull your documents into a prompt. Remove someone with `/agent kick <name|all>`; at most 8 guests.
- Needs both sides on a version that lists the `collab` capability (`/net` shows it); the guest list persists in `<data dir>/agent-guests.json` (host) and `agent-shared.json` (guest). The guest sees the last 100 room messages on joining, live updates after, and nothing while offline.

## Limitations

- Messages only flow while both peers are online at the same time (no relay or store-and-forward server).
- `identity.json` and `pager.db` are not encrypted at rest.
- Display names are self-declared and can collide or impersonate; use the public-key prefix with `/open` and `/remove` to disambiguate.
- Chat input is single-line; pasted newlines become spaces (documents take multi-line text).
- Some carrier NATs cannot be hole-punched by HyperDHT; those peers cannot connect directly.

## Development

```sh
npm run build        # tsc -> dist/
npm test             # build + node:test (integration tests use a local DHT, no internet)
npm run typecheck
```

Layout: `src/engine.ts` (contacts, groups, sync, commands), `src/ingest.ts` (event gate), `src/net.ts` (transport), `src/db.ts` (SQLite via `node:sqlite`), `src/wire.ts` (frames), `src/events.ts` (signed events), `src/ui/` (Ink components).

## License

Apache License 2.0. See [LICENSE](LICENSE).
