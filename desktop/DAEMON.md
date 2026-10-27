# The Pager daemon

One background process owns every program of the desktop app. A window is a client: closing it only disconnects, nothing running is touched. Only an explicit Quit (`window.pager.d.quit()` or `pager daemon stop`) ends the daemon and its programs.

Code: `src/daemon/` (`server.ts` daemon, `client.ts` Node client, `protocol.ts` wire, `layout.ts` pane trees, `panes.ts` one pane, `state.ts` `daemon.state`, `settings.ts`, `launch.ts`, `cli.ts` + `args.ts` commands). Window host: `desktop/electron/main.cjs` + `preload.cjs`. Tests: `src/daemon/daemon.test.ts`.

## Process and address

`pager daemon` (hidden, foreground) is the daemon; windows and the CLI start it detached on demand (`node dist/cli.js daemon`, no console window, log at `<data dir>/daemon.log`, truncated past 1 MiB). It listens on:

| platform | address |
|---|---|
| Windows | `\\.\pipe\pager-<USERNAME>` (a hash of the data dir is added when `PAGER_HOME` is set, so a test profile never reaches your daemon) |
| elsewhere | `<data dir>/daemon.sock` (0600) |
| any | `PAGER_DAEMON_SOCKET` overrides |

A second daemon on the same address exits at once ("already running"). A leftover unix socket nobody answers on is removed. Panes get `PAGER_PANE`, `PAGER_DAEMON_SOCKET`, `PAGER_DESKTOP_PIPE`, `PAGER_DESKTOP_TOKEN`, `TERM_PROGRAM=pager-desktop`.

The daemon also listens on a private pipe (`<address>-host`) that only holds `{token,type:'open',url}` lines. This is where `pager docs` inside a pane asks the window to show a page (`PAGER_DESKTOP_PIPE`/`TOKEN` in the pane's environment). The daemon answers `ok` only when a window is attached, and then sends the window an `open_url` event; main.cjs shows it in the browser pane. (The old per-window host pipe is gone.)

## Wire

Frame: `u32 LE length` (type byte + payload), `u8 type`, payload. Type 0 JSON (utf-8), type 1 pane data `u32 LE paneId` + raw bytes. Unknown types are skipped, corrupt JSON is skipped, a length above 64 MiB closes the connection. `PROTOCOL_VERSION = 1`; `hello{version, client:'window'|'cli', name?}` must come first and answers `{version, build, pid, clientId, address, uptimeMs}`. Requests are `{id, type, ...args}`, replies `{id, ok:true, result?}` or `{id, ok:false, error}`. Events are `{event, ...}` JSON frames without `id`, sent to clients that called `events.subscribe{filter?}`.

Pane output (type-1 frames) goes to the clients that `pane.attach`ed, nobody else. A client may also send type-1 frames: they are keyboard bytes for that pane (binary safe, no JSON).

### Requests

| type | args | result |
|---|---|---|
| `hello` | `version, client, name?` | see above |
| `state` | | `DaemonState` |
| `status` | | pid, build, uptime, pane/client counts, state file |
| `daemon.stop` | | `ok`, then the daemon saves and exits |
| `settings.get` / `settings.set{patch}` | `patch` deep-merged; `null` resets a key | the settings; saved to `<data dir>/desktop.json` (changed keys only) |
| `events.subscribe` | `filter?: string[]` | names from `EVENT_NAMES`; empty = all |
| `session.new` | `name?, kind?, cwd?, command?, argv?` | `{sessionId, tabId, paneId}` |
| `session.close` / `session.rename` | `sessionId`, `name` | |
| `tab.new` | `sessionId?, kind?, cwd?, command?, argv?` | `{sessionId, tabId, paneId}` |
| `tab.close` / `tab.rename` / `tab.activate` | `tabId`, `title` | |
| `pane.split` | `paneId, dir:'row'\|'col', kind?, cwd?, command?, before?, ratio?` | `{paneId}` (`row` = side by side, new pane on the right) |
| `pane.run` | `command, cwd?, paneId?, dir?` | a new shell typing `command`, split beside `paneId` or in a new tab |
| `pane.close` / `pane.focus` / `pane.restart` | `paneId` | |
| `pane.ratio` | `paneId, ratio, path?` | `path` ('' root; `a`/`b` descend) addresses a split whose children are both subtrees; without it the split directly holding `paneId` |
| `pane.move` | `paneId, toTab` | |
| `pane.input` | `paneId, data \| b64` | |
| `pane.paste` | `paneId, text` | bracketed when the program asked for it |
| `pane.resize` | `paneId, cols, rows` | |
| `pane.attach` | `paneId, cols?, rows?` | `{replay: base64, cols, rows, seq}` |
| `pane.detach` | `paneId?` (none: all) | |
| `pane.capture` | `paneId, lines?, plain? (default true)` | `{text, cols, rows, cursor, alternate}` |
| `open` | `url` or `path, line?, col?, paneId?, dir?, tab?` | URL: `open_url` event. Path: a `block:files` pane (command = JSON args) beside `paneId` or in a new tab; `open_path` event |

`kind` is `pager | shell | omp | claude | opencode | hermes | custom | block:<name>`. Block panes have no PTY. `argv` runs that program instead of a shell (kind defaults to `custom`).

Defaults: `session.new`/`tab.new` without `kind` make the Home block (`block:home`, no process) when no Home pane exists, so the first pane of the first session is Home; else `shell`, or `omp` when `newBlocks` is `agent` (`tab.new` with a `command` is a shell). The Home pane is pinned: `pane.close` and `tab.close` on it fail with `Pager home stays open`. The classic Pager TUI (`kind: 'pager'`, `node dist/cli.js`) is an ordinary closable pane, which agents, chat and calls keep running in with the window closed. State saved before Home was a block gets a Home tab put first in the first session on the next start. New tabs start in the focused pane's folder (`newTabsStartIn: current`) or home.

### Events

`state` (full `DaemonState`, coalesced to one per 30 ms burst), `layout_changed{reasons}`, `pane_spawned{pane}`, `pane_exited{paneId,exitCode}`, `pane_closed{paneId}`, `pane_resized{paneId,cols,rows}`, `pane_title{paneId,title}`, `pane_cwd{paneId,cwd}`, `pane_resync{paneId}`, `command_finished{paneId,command,cwd,exit,ms}` (shell command blocks, OSC 133), `bell{paneId}`, `toast{level,text}`, `open_url{url}`, `open_path{path,paneId,line?,col?}`, `client_attached`/`client_detached{clients}`.

### Attach, sizes, resync

`pane.attach` registers the client and snapshots the pane in one step, so no output falls between the replay and the first data frame. `replay` is the pane's newest 2 MiB of raw output with terminal queries removed (a replayed screen must not make your terminal answer them again); after the ring wrapped it starts with the terminal modes it lost (alternate screen, mouse, paste). `seq` is the number of bytes the pane had produced; data frames after the reply continue from it (`DaemonClient.seqOf`). A full-screen program whose start the ring lost is nudged to repaint.

While a client is attached, its terminal answers the program's queries (cursor position, device attributes); with nobody attached the daemon answers them itself. A terminal that never answers will stall programs that ask (PSReadLine does).

Size: the pane runs at the size of the client that was last active (typing, focus, attach, resize). A client that detaches stops voting; with nobody attached the pane keeps its size.

Slow clients: a client whose socket holds more than 4 MiB unsent loses *all* pane output (the daemon's memory stays flat) until it re-attaches. When its socket drains the daemon sends `pane_resync{paneId}`; the client calls `pane.attach` again and resets its terminal to the replay. A client more than 128 MiB behind is disconnected. `pane.restart` and a reconnect use the same `pane_resync` path.

## State file and restore

`<data dir>/daemon.state` (JSON; scrollback is base64 deflate). Layout, ids, tab titles the user set, and per pane: kind, title, cwd, command, size, exited, newest 2 MiB of output (64 MiB in all, the biggest trimmed first). Writes are atomic (temp + rename), serialized, debounced: 400 ms after a layout change, 5 s after output alone; an unchanged pane's packed copy is reused. `daemon.stop` flushes first. An unreadable file is moved to `daemon.state.bad`.

On start every pane returns with state `restored`, in its folder, over its old output followed by a dim "restored" line (alternate screen and mouse modes are reset first). `shell`: a fresh shell. `pager`: the TUI starts again (an exited one stays exited). `omp|claude|opencode|hermes`: a shell that types the resume command (`omp --continue`, ...); an agent you had quit comes back as a plain shell. Block panes return as they were. The pane flips to `running` on its first input. Pane ids continue after the restored ones. A pane that cannot start comes back `exited` (code -1) and the reason is in `daemon.log`.

## CLI

```
pager daemon start|stop|status     (bare `pager daemon` is the server itself)
pager split right|down [--pane ID] [--kind K] [--cwd DIR] [-- COMMAND...]
pager run [--cwd DIR] [--] COMMAND...      inside a daemon pane: a new shell beside it; elsewhere as before (control pipe, or starts pager)
pager send [--pane ID] [--no-enter] TEXT...
pager capture [--pane ID] [--lines N] [--ansi] [--json]
pager ls [--json]
pager events [--filter a,b]        JSON lines until interrupted (default: everything but `state`)
pager open [--pane ID] [--split right|down] [--tab] PATH[:LINE[:COL]]... | URL
```

`--pane` takes an id, `@focused`, or a unique title/kind; the default is `$PAGER_PANE`, else the focused pane. `split`, `open` and `run` start the daemon when it is not running, the others say it is not.

## Window host (`main.cjs`, `preload.cjs`)

main.cjs loads `dist/daemon/client.js`, connects (starting the daemon with the bundled `node.exe` when absent), subscribes to every event, and creates the first session when the daemon has none. It keeps the browser pane, `setAppDetails`, single-instance forwarding (`Pager.exe run ...` and `--cwd` go to `pane.run`/`tab.new`), `--selftest`, `--install`, Chromium switch filtering, and the docs/studio hotkeys (via the pager TUI's control pipe, as before). Pane data is coalesced to one IPC message per pane per 4 ms.

`window.pager` (everything is in `d`; `ready/input/resize/onData/onExit` of the old host are gone):

- `d.state()`, `d.onState(fn)`: the full `DaemonState` (every change).
- `d.call(type, args)`: any request except `hello`, `daemon.stop`; resolves to `result`, rejects with the daemon's error.
- `d.attach(paneId, {cols,rows}?)` -> `{replay: Uint8Array, cols, rows, seq}`; `d.detach(paneId)`; `d.write(paneId, string|Uint8Array)`; `d.resize(paneId, cols, rows)`; `d.onData(fn(paneId, Uint8Array))`. Buffer data that arrives before the attach promise resolves, then write it after the replay.
- `d.onResync(fn(paneId, {replay, cols, rows, seq}))`: after falling behind, a pane restart or a reconnect (main re-attaches by itself): `term.reset()`, write `replay`.
- `d.onToast(fn({level,text,action?}))`: daemon toasts and the host's own. `action: 'restart'` means: offer `d.restart()`.
- `d.onEvent(fn(event))`: every event except `state`, `toast`, `open_url`.
- `d.status()` / `d.onStatus(fn('connected'|'lost'))`, `d.restart()`, `d.quit()`.
- `d.block(name, method, args)` -> `desktop/electron/blocks/<name>.cjs` `methods[method](args, ctx)`; `d.onBlock(name, fn(event, payload))`. `ctx = { emit(event, payload), call(type,args) /* daemon request */, openUrl(url), userData, window }`; `dispose()` runs on quit.
- Unchanged: `title`, `hotkey(name)` (also `quit`), `browser(cmd,arg)`, `onBrowser`, `onBrowserKey`, `onConfig` (`{material, opacity, fontSize}` from the daemon's settings).

If the daemon dies the window stays open: status `lost`, an error toast with `action:'restart'`, and a reconnect attempt every 2 s that never starts anything by itself. `d.restart()` starts it again; panes come back `restored` (see above) and every pane the renderer had attached is re-attached and resynced. Closing the window detaches (the daemon and every program carry on); `d.quit()` stops the daemon and exits.

## Measured (Windows 11, Node 24, this repo's `dist`)

Cold start (spawn the detached daemon until `hello` answered): 147-278 ms across runs (whole `pager daemon start` CLI call 257-472 ms, which includes starting that CLI's own node). `pane.attach` of a live pane (replay 1.2 KB): 1-6 ms over the pipe; a restored pane: 2 ms. Restart after a hard kill of the daemon: shell pane back in its folder in about a second including the new shell.
