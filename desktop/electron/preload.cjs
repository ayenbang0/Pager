'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The renderer gets exactly these calls and nothing else. Everything about terminals lives in the daemon (`d`).

/** ipcRenderer.invoke wraps messages as "Error invoking remote method 'x': Error: msg"; callers want msg. */
const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((e) => {
    throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''))
  })

/** Subscribes to a channel; the returned function unsubscribes. */
const on = (channel, fn) => {
  const h = (_e, ...a) => fn(...a)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const d = {
  state: () => call('d:state'),
  onState: (fn) => on('d:state', fn),
  /** Any daemon request except hello. Resolves to the reply's result, rejects with its error. */
  call: (type, args) => call('d:call', String(type), args ?? {}),
  /** { replay: Uint8Array, cols, rows, seq }. Output frames for the pane follow through onData. */
  attach: (paneId, size) => call('d:attach', String(paneId), size && { cols: size.cols | 0, rows: size.rows | 0 }),
  detach: (paneId) => call('d:detach', String(paneId)),
  write: (paneId, data) => ipcRenderer.send('d:write', String(paneId), data),
  resize: (paneId, cols, rows) => ipcRenderer.send('d:resize', String(paneId), cols | 0, rows | 0),
  onData: (fn) => on('d:data', fn),
  /** After falling behind, a pane restart or a reconnect: reset the terminal, then write replay. fn(paneId, { replay, cols, rows, seq }). */
  onResync: (fn) => on('d:resync', fn),
  onToast: (fn) => on('d:toast', fn),
  /** Every other daemon event: pane_exited, pane_title, pane_cwd, bell, command_finished, open_path, ... fn(event). */
  onEvent: (fn) => on('d:event', fn),
  /** 'connected' | 'lost'. */
  status: () => call('d:status'),
  onStatus: (fn) => on('d:status', fn),
  /** Starts the daemon again (and reconnects) after it died. */
  restart: () => call('d:restart'),
  /** Explicit Quit: stops the daemon (every program ends, the state file is saved) and closes the window. */
  quit: () => call('d:quit'),
  /** Calls a main-process block handler: desktop/electron/blocks/<name>.cjs methods[method](args, ctx). */
  block: (name, method, args) => call('d:block', String(name), String(method), args),
  /** Pushed block events (ctx.emit). fn(event, payload). */
  onBlock: (name, fn) => on('d:block', (n, event, payload) => (n === name ? fn(event, payload) : undefined)),
}

contextBridge.exposeInMainWorld('pager', {
  d,
  title: (t) => ipcRenderer.send('title', String(t)),
  hotkey: (name) => ipcRenderer.send('hotkey', String(name)),
  browser: (cmd, arg) => ipcRenderer.send('browser', String(cmd), arg),
  onBrowser: (fn) => ipcRenderer.on('browser', (_e, s) => fn(s)),
  onBrowserKey: (fn) => ipcRenderer.on('browser-key', (_e, name) => fn(name)),
  onConfig: (fn) => ipcRenderer.on('config', (_e, c) => fn(c)),
})
