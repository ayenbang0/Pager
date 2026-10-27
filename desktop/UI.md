# Pager window (renderer)

Plain browser ES modules, no bundler. The visual contract is one quiet kit: flat accent controls, hairline borders, shared segmented controls, menus, dialogs and empty states; no decorative gradients, radial glows, pulsing indicators or per-block button forks. `renderer/index.html` paints a skeleton (avatar, chips, pane card) from markup and CSS alone, then `renderer.js` boots the shell.

## Boot
1. `ui/boot.js` (classic script in `<head>`): restores theme, layout and material from `localStorage['pager.ui.v1']` so there is no flash, and marks `shell-boot` and `shell-first-paint`. A watchdog replaces the skeleton with the failure reason after 8 s if `shell-ready` never happens.
2. `renderer.js` picks `window.pager.d` (preload) or `ui/mock-daemon.js` when it is missing (a plain browser). Then it initialises appearance, tooltips and actions, builds the top bar, awaits `d.state()`, and starts panes, sidebar and status line.
3. Marks in `performance`: `shell-boot`, `shell-first-paint`, `shell-ready`, `pane-first-byte`.

If any module in the import graph is missing or throws, the shell stays on the skeleton. That was the cause of the first packed build failing: `ui/actions.js` imports `palette.js` and `settings.js`.

## Modules (`renderer/ui`)
- `store.js`: the `app` singleton (state, settings, event bus, `app.set`).
- `appearance.js`, `themes.js`: tokens, 102 omp themes, hover preview (`previewTheme`), `pickTheme`.
- `commands.js`, `actions.js`: command registry, every action and hotkey. Keys are overridable through `settings.keybinds`.
- `topbar.js`, `panes.js`, `terminal.js`, `sidebar.js`, `statusbar.js`: the window. Right-clicking a pane opens the pane menu (Close pane / Close block, splits, move to tab); block panes guard the menu against text selection and CodeMirror.
- `palette.js`, `popover.js`, `toast.js`, `dialog.js`, `kit.css`: overlays.
- `blocks/home.js` (+ `home-model.js`, `home.css`): the pinned Home block, first pane of every session: greeting, quick-action tiles, live "Running now", recent folders and the newest changelog entries (read through `electron/blocks/home.cjs`). `isHome` in `store.js` is `kind === 'block:home'`; it has no close button and the daemon refuses to close it.
- `settings.js`, `settings-pages.js`, `controls.js`, `settings.css`: the right-docked sheet.
- `icons.js`: inline SVG icons (16 grid, stroke 1.45) and the Pager mark.
- CSS order (index.html): tokens, kit, chrome, layouts, palette, settings, style.
## Blocks
`blocks/index.js` registers the pane kinds; each module default-exports `{ id, title, icon, hotkey?, mount(el, ctx) }` and injects its own CSS through `import.meta.url`. Kinds: home (pinned, first pane of every session - the daemon refuses to close it), files, git, database, notebook, board, tasks, screen, canvas, chats. Right-clicking inside a block pane opens the pane menu (Close block; terminal panes keep Close pane).
- `blocks/chats.js` + `chats-*.js` + `chats.css`: the Chats block - DM/group/room/agent/AI conversations with presence, reactions, windowed long threads and typing, a short local command list (/share /invite /agent /me /mute /clear), shared agent sessions and shared blocks. The wire (daemon requests `chats.*`, events `chats_changed`/`chat_message`/`chat_share*`, and the `share` frame for block ops) is in `CHATS.md`; `blocks/share.js` is the renderer's adapter registry - a shareable block calls `registerShare` (what the kind can do) and `registerInstance` (a mounted pane, instanceId = paneId, with live/readonly/snapshot modes).
- Dev harnesses live in `blocks/_harness/` (loopback static servers that forward to the real `electron/blocks/*.cjs` handlers where possible; `chats.html` uses the in-page mock). `scripts/desktop/pack.mjs` leaves every `_harness` folder out of the packed app. The in-page Chats mock is used only with no daemon or with the browser preview's mock daemon; a real daemon that fails shows the Chats error state, never mock conversations.

## Layouts
`lay-tiles` (default), `lay-rail`, `lay-float`, `lay-studio`, set from `settings.layout`. Geometry lives in `layouts.css`; `--tn-bar` is the bar height; `--wco` reserves room for the native caption buttons at the right.

## Terminals
One xterm.js instance per pane. Daemon output is queued and written once per animation frame. `renderer: auto` uses xterm's DOM renderer; `webgl` is opt-in (in headless Chromium the WebGL layer painted blank for every terminal after the first, so it is not the default).

## Testing without Electron
Serve `renderer/` with any static server and open `index.html`: the mock daemon provides a fake shell, files and git blocks. `window.__pager` exposes `{ app, views }` in mock mode.

## Hotkeys kept from the old shell
F1 docs, F2 bot studio, Ctrl+Shift+B browser pane, Ctrl+Shift+M material, Ctrl+Shift+Up/Down opacity, Ctrl+= / Ctrl+- / Ctrl+0 text size. These call `window.pager.hotkey` when the host provides it.
