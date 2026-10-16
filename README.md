# pager

Peer-to-peer terminal chat for developers. A full-screen TUI: add people with a shareable contact code, chat 1:1 or in groups, with in-app toasts. No server: peers find each other over the [HyperDHT](https://github.com/holepunchto/hyperdht) and connect directly. History is stored locally in SQLite.

## Install

Requires **Node 24+** and npm.

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

1. Run `pager`. The home view shows **your contact code** (`pgr1-…`); `/code` shows it again.
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
| `/quit` | Exit |

## Keys

| Key | Action |
|---|---|
| Enter | Send / run command |
| Tab, Up/Down | Complete the highlighted command / move in the palette (or input history) |
| Ctrl+P | Command palette: switch conversation, accept/decline, change theme, and more |
| ? (empty prompt) | Keyboard shortcut help |
| Alt+Up / Alt+Down | Previous / next conversation (home is first) |
| Ctrl+B | Toggle the sidebar (saved) |
| PgUp / PgDn | Scroll messages |
| Ctrl+A / Ctrl+E, Home / End | Start / end of line |
| Alt+B / Alt+F, Ctrl+Left / Right | Word left / right |
| Ctrl+W, Ctrl+U, Ctrl+K | Delete word back, to line start, to line end |
| Esc | Clear the input (closes the palette / help) |
| Ctrl+C | Clear the input; on an empty prompt press again within 2 s to quit |
| Ctrl+D (empty prompt) | Quit |

## Configuration

| Variable | Meaning |
|---|---|
| `PAGER_HOME` | Data directory (default `~/.pager`) |
| `PAGER_BOOTSTRAP` | Comma-separated `host:port` DHT bootstrap nodes (default: public HyperDHT) |
| `PAGER_REDUCE_MOTION` | Set to `1` to disable animations (connecting spinner, toast countdown bars) |

Data directory contents: `identity.json` (your secret seed and name; keep it private, losing it means contacts must re-add you), `pager.db` (SQLite history), `settings.json` (theme, sidebar), `pager.lock` (one instance per directory).

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

## Limitations

- Messages only flow while both peers are online at the same time (no relay or store-and-forward server).
- `identity.json` and `pager.db` are not encrypted at rest.
- Display names are self-declared and can collide or impersonate; use the public-key prefix with `/open` and `/remove` to disambiguate.
- Input is single-line; pasted newlines become spaces.
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
