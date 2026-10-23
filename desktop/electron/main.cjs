'use strict'
// A thin client of the Pager daemon: window, browser pane, and a forwarder between the renderer and the daemon's pipe.
// Every program lives in the daemon (dist/daemon); closing this window only detaches. See desktop/DAEMON.md.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn: spawnChild } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createBrowser } = require('./browser.cjs')

const A = path.join(process.resourcesPath, 'app')
const P = path.join(A, 'pager')
// The daemon (and the pager panes) run under the bundled (OpenJS-signed) node.exe: Electron's GUI-subsystem exe cannot act as node on a ConPTY.
const NODE = path.join(process.resourcesPath, 'node', 'node.exe')
const argv = process.argv.slice(1)
const load = (rel) => import(pathToFileURL(path.join(P, 'dist', rel)).href)

app.setAppUserModelId('dev.pager.desktop')

if (argv.includes('--selftest')) {
  // Answers before Electron is ready; the installer uses it to learn whether this exe can start on this PC.
  process.stdout.write('ok\n')
  app.exit(0)
} else if (argv.includes('--install')) {
  app.whenReady().then(() => {
    const child = spawnChild(NODE, [path.join(P, 'dist', 'cli.js'), 'desktop', 'install', '--exe', process.execPath], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      dialog.showMessageBoxSync({ type: code === 0 ? 'info' : 'error', title: 'Pager', message: code === 0 ? 'Pager is installed' : 'Install failed', detail: out.trim() })
      app.exit(code ?? 1)
    })
  })
} else {
  run()
}

function run() {
  // Chromium reorders switch-like arguments in the second instance's own argv, so the original ones travel as additional data.
  if (!app.requestSingleInstanceLock({ argv, cwd: process.cwd() })) return app.quit()
  // Chromium's own switches (debugging ports, flags) are Electron's, not Pager's.
  const passthrough = argv.filter((a) => a !== '--selftest' && a !== '--install' && !/^--(remote-debugging-|inspect|js-flags|enable-logging)/.test(a))

  let win
  let browser
  let daemonMod // dist/daemon/client.js
  let settingsMod // dist/daemon/settings.js
  let paths
  let client // DaemonClient, or undefined while the daemon is away
  let state = { sessions: [], panes: [], activeSession: '', clients: 0, settings: {} }
  let status = 'lost'
  let intentional = false
  let reconnecting = false
  let configKey = ''
  const attached = new Set()
  const outgoing = new Map() // paneId -> Buffer[] waiting for the next flush
  let flushTimer
  const blocks = new Map() // name -> { mod, ctx }

  const logFile = () => path.join(app.getPath('userData'), 'host.log')
  const log = (msg) => {
    try {
      fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`)
    } catch {
      // no log, no problem
    }
  }
  const send = (channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const toast = (level, text, action) => send('d:toast', { level, text, ...(action ? { action } : {}) })
  const own = (e) => win && !win.isDestroyed() && e.sender === win.webContents

  // ---- daemon connection ------------------------------------------------------------------------------------------

  const material = (m) => (m === 'solid' ? 'none' : m === 'mica' ? 'mica' : 'acrylic')
  const configOf = (s) => ({ material: s.material || 'clear', opacity: s.opacity ?? 60, fontSize: s.fontSize ?? 13 })

  function applyConfig() {
    const config = configOf(state.settings || {})
    const key = JSON.stringify(config)
    if (key === configKey || !win || win.isDestroyed()) return
    configKey = key
    win.setBackgroundMaterial(material(config.material))
    win.setBackgroundColor(config.material === 'solid' ? '#000000' : '#00000000')
    send('config', config)
  }

  function setState(s) {
    state = s
    send('d:state', s)
    applyConfig()
  }

  function setStatus(s) {
    status = s
    send('d:status', s)
  }

  function flushData() {
    flushTimer = undefined
    for (const [id, chunks] of outgoing) send('d:data', id, new Uint8Array(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)))
    outgoing.clear()
  }

  function onData(paneId, buf) {
    const id = String(paneId)
    if (!attached.has(id)) return
    const list = outgoing.get(id)
    if (list) list.push(buf)
    else outgoing.set(id, [buf])
    // One message per pane per few ms: a flooding program costs the renderer one write per frame, not one per pty chunk.
    flushTimer ??= setTimeout(flushData, 4)
  }

  async function resync(id) {
    if (!client || !attached.has(id)) return
    outgoing.delete(id)
    const r = await client.attach(id)
    send('d:resync', id, { replay: new Uint8Array(r.replay), cols: r.cols, rows: r.rows, seq: r.seq })
  }

  function onEvent(ev) {
    switch (ev.event) {
      case 'state':
        return setState(ev.state)
      case 'toast':
        return toast(ev.level || 'info', String(ev.text || ''))
      case 'open_url':
        if (typeof ev.url === 'string') browser.show(ev.url)
        return
      case 'pane_resync':
        return void resync(String(ev.paneId)).catch((e) => log(`resync ${ev.paneId}: ${e && e.message}`))
      case 'pane_closed':
        attached.delete(String(ev.paneId))
        outgoing.delete(String(ev.paneId))
        return send('d:event', ev)
      default:
        send('d:event', ev)
    }
  }

  /** Takes over a live connection: subscribes, loads the state, and brings every pane the renderer shows back up to date. */
  async function adopt(c) {
    client = c
    intentional = false
    c.on('event', onEvent)
    c.on('data', onData)
    c.once('close', () => onClosed(c))
    await c.subscribe()
    let s = await c.call('state')
    if (s.sessions.length === 0) {
      // The first pane of the first session is the Pager TUI itself (kind 'pager'): agents, chat and calls live in it and outlast this window.
      await c.call('session.new', { name: 'Pager' })
      s = await c.call('state')
    }
    setStatus('connected')
    setState(s)
    for (const id of attached) await resync(id).catch((e) => log(`resync ${id}: ${e && e.message}`))
  }

  function onClosed(c) {
    if (client !== c) return
    client = undefined
    if (intentional) return
    setStatus('lost')
    toast('error', 'The Pager daemon stopped. Its programs ended with it; they come back (in their folders, over their old output) when it restarts.', 'restart')
    log('daemon connection lost')
    watchForDaemon()
  }

  /** The daemon may come back by itself (`pager daemon start`, another window): notice without starting anything. */
  async function watchForDaemon() {
    if (reconnecting) return
    reconnecting = true
    while (!client && !intentional) {
      await new Promise((r) => setTimeout(r, 2000))
      if (client || intentional) break
      try {
        const c = await daemonMod.tryConnect(paths.address, { client: 'window', name: 'electron' })
        if (c) {
          await adopt(c)
          toast('info', 'Reconnected to the Pager daemon.')
        }
      } catch (e) {
        log(`reconnect: ${e && e.message}`)
      }
    }
    reconnecting = false
  }

  async function connect(start) {
    if (client) return true
    try {
      const c = start ? (await daemonMod.connectOrStart(paths, { client: 'window', name: 'electron' })).client : await daemonMod.tryConnect(paths.address, { client: 'window', name: 'electron' })
      if (!c) return false
      await adopt(c)
      return true
    } catch (e) {
      log(`cannot connect to the daemon: ${e && e.stack ? e.stack : e}`)
      return false
    }
  }

  async function restartDaemon() {
    if (client) return
    if (!(await connect(true))) throw new Error(`The daemon did not start; see ${path.join(paths.dir, 'daemon.log')}`)
    toast('info', 'The Pager daemon is running again.')
  }

  async function quitAll(stopDaemon) {
    intentional = true
    for (const { mod } of blocks.values()) {
      try {
        if (typeof mod.dispose === 'function') mod.dispose()
      } catch {
        // a block that cannot clean up must not hold the quit
      }
    }
    if (stopDaemon && client) {
      try {
        await client.call('daemon.stop', {}, 5000)
      } catch {
        // already gone
      }
    }
    client?.close()
    browser?.destroy()
    app.quit()
  }

  /** `Pager.exe run ...` / `Pager.exe --cwd DIR` from a second launch (or the first one's arguments): into the daemon's layout. */
  async function forward(args, cwd) {
    const { parseArgs } = await load('app/args.js')
    const parsed = parseArgs(args)
    if ('error' in parsed || !client) return
    const dir = parsed.cwd === undefined ? cwd : path.resolve(cwd, parsed.cwd)
    if (parsed.command === 'exec') {
      const command = parsed.words?.join(' ')
      await client.call('pane.run', { cwd: dir, ...(command ? { command } : {}) })
    } else if (parsed.cwd !== undefined) await client.call('tab.new', { cwd: dir, kind: 'shell' })
  }

  app.on('second-instance', async (_e, _argv, _cwd, extra) => {
    const second = Array.isArray(extra?.argv) ? extra.argv : []
    const cwd = typeof extra?.cwd === 'string' ? extra.cwd : os.homedir()
    try {
      await forward(second, cwd)
    } catch (e) {
      // A failed forward must not stop the window from coming forward; the reason goes to the log.
      log(`forward failed: ${e && e.stack ? e.stack : e}`)
    }
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // ---- blocks -----------------------------------------------------------------------------------------------------

  function block(name) {
    let entry = blocks.get(name)
    if (entry) return entry
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`bad block name: ${name}`)
    const file = path.join(__dirname, 'blocks', `${name}.cjs`)
    if (!fs.existsSync(file)) throw new Error(`no block named ${name}`)
    const mod = require(file)
    if (!mod || typeof mod.methods !== 'object' || mod.methods === null) throw new Error(`${name} is not a block`)
    const ctx = {
      emit: (event, payload) => send('d:block', name, String(event), payload),
      call: (type, args) => {
        if (!client) return Promise.reject(new Error('the daemon is not running'))
        return client.call(type, args || {})
      },
      openUrl: (url) => browser.show(url),
      userData: app.getPath('userData'),
      window: win,
    }
    entry = { mod, ctx }
    blocks.set(name, entry)
    return entry
  }

  async function callBlock(name, method, args) {
    const { mod, ctx } = block(name)
    const fn = Object.hasOwn(mod.methods, method) ? mod.methods[method] : undefined
    if (typeof fn !== 'function') throw new Error(`block ${name} has no method ${method}`)
    return fn(args, ctx)
  }

  // ---- the docs and the bot studio are served by the running Pager TUI on 127.0.0.1; the browser pane shows them ------

  async function showSite(page) {
    const { sendControl } = await load('app/control.js')
    const { dataDir } = await load('platform/paths.js')
    const sent = await sendControl(dataDir(), page === 'studio' ? { type: 'docs', page } : { type: 'docs' }).catch(() => ({ kind: 'none' }))
    if (sent.kind !== 'ok' || !sent.reply.ok || !sent.reply.url) return void dialog.showErrorBox(page === 'studio' ? 'Pager bot studio' : 'Pager docs', sent.kind === 'ok' && !sent.reply.ok ? sent.reply.error : 'Pager is not running yet.')
    browser.show(sent.reply.url)
  }

  function onHotkey(name) {
    if (name === 'docs' || name === 'studio') return void showSite(name)
    if (name === 'browser') return browser.command('toggle')
    if (name === 'quit') return void quitAll(true)
    const patch = settingsMod.stepPatch(state.settings, name)
    if (patch && client) client.call('settings.set', { patch }).catch((e) => log(`settings.set: ${e && e.message}`))
  }

  // ---- window -----------------------------------------------------------------------------------------------------

  app.whenReady().then(async () => {
    daemonMod = await load('daemon/client.js')
    settingsMod = await load('daemon/settings.js')
    paths = daemonMod.resolvePaths({ cliPath: path.join(P, 'dist', 'cli.js'), nodePath: NODE })
    // Connect (starting the daemon if nobody did) before the window exists, so its first paint already has the layout and theme.
    const connected = await connect(true)
    if (!connected) state = { ...state, settings: settingsMod.loadSettings(path.join(paths.dir, 'desktop.json')) }
    const config = configOf(state.settings)
    configKey = JSON.stringify(config)
    const solid = config.material === 'solid'
    win = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 640,
      minHeight: 300,
      show: false,
      icon: path.join(A, 'renderer', 'pager.png'),
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#cfe3ff', height: 30 },
      backgroundColor: solid ? '#000000' : '#00000000',
      backgroundMaterial: material(config.material),
      webPreferences: { preload: path.join(A, 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    })
    win.removeMenu()
    // What a pinned taskbar button or shortcut made from this window shows and runs: the pager icon, not the exe's resource (which Explorer caches).
    win.setAppDetails({ appId: 'dev.pager.desktop', appIconPath: path.join(P, 'desktop', 'assets', 'pager.ico'), appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Pager' })
    win.once('ready-to-show', () => win.show())
    win.webContents.on('did-finish-load', () => {
      send('config', configOf(state.settings))
      send('d:status', status)
      if (status === 'lost') toast('error', 'The Pager daemon is not running.', 'restart')
    })
    // A renderer error would otherwise vanish (devtools are off): it goes to the log.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') log(`renderer: ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    browser = createBrowser({
      win,
      onState: (s) => send('browser', s),
      // The pane's pages send their chords here: browser-* ones go to the pane's chrome, the rest act like the terminal's.
      onHotkey: (name) => (name.startsWith('browser-') ? send('browser-key', name.slice(8)) : onHotkey(name)),
    })
    win.loadFile(path.join(A, 'renderer', 'index.html'))

    // Arguments of the first launch (`Pager.exe run ...`) go where a second launch's would.
    forward(passthrough, process.cwd()).catch((e) => log(`forward failed: ${e && e.stack ? e.stack : e}`))

    const needClient = () => {
      if (!client) throw new Error('The Pager daemon is not running')
      return client
    }
    const BLOCKED = new Set(['hello', 'daemon.stop', 'stop'])

    ipcMain.handle('d:state', (e) => (own(e) ? state : undefined))
    ipcMain.handle('d:call', (e, type, args) => {
      if (!own(e)) return undefined
      if (typeof type !== 'string' || BLOCKED.has(type)) throw new Error(`request not allowed: ${type}`)
      return needClient().call(type, args && typeof args === 'object' ? args : {})
    })
    ipcMain.handle('d:attach', async (e, paneId, size) => {
      if (!own(e)) return undefined
      const id = String(paneId)
      attached.add(id)
      outgoing.delete(id)
      try {
        const r = await needClient().attach(id, size || undefined)
        return { replay: new Uint8Array(r.replay), cols: r.cols, rows: r.rows, seq: r.seq }
      } catch (err) {
        attached.delete(id)
        throw err
      }
    })
    ipcMain.handle('d:detach', async (e, paneId) => {
      if (!own(e)) return
      const id = String(paneId)
      attached.delete(id)
      outgoing.delete(id)
      if (client) await client.call('pane.detach', { paneId: id }).catch(() => {})
    })
    ipcMain.on('d:write', (e, paneId, data) => {
      if (own(e) && client) client.input(String(paneId), typeof data === 'string' ? data : Buffer.from(data))
    })
    ipcMain.on('d:resize', (e, paneId, cols, rows) => {
      if (own(e) && client && cols > 0 && rows > 0) client.call('pane.resize', { paneId: String(paneId), cols, rows }).catch(() => {})
    })
    ipcMain.handle('d:status', (e) => (own(e) ? status : undefined))
    ipcMain.handle('d:restart', async (e) => {
      if (own(e)) await restartDaemon()
    })
    ipcMain.handle('d:quit', (e) => {
      if (own(e)) void quitAll(true)
    })
    ipcMain.handle('d:block', (e, name, method, args) => (own(e) ? callBlock(String(name), String(method), args) : undefined))

    ipcMain.on('title', (e, t) => {
      if (own(e)) win.setTitle(t || 'Pager')
    })
    const BROWSER_CMDS = new Set(['toggle', 'hide', 'new', 'open', 'go', 'activate', 'close', 'next', 'prev', 'back', 'forward', 'reload', 'bounds', 'state'])
    ipcMain.on('browser', (e, cmd, arg) => {
      if (own(e) && BROWSER_CMDS.has(cmd)) browser.command(cmd, arg)
    })
    ipcMain.on('hotkey', (e, name) => {
      if (own(e)) onHotkey(name)
    })
  })

  // Closing the window detaches; the daemon, and every program in it, carries on. Only an explicit Quit (d.quit()) stops it.
  app.on('window-all-closed', () => void quitAll(false))
}
