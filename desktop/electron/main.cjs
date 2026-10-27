'use strict'
// Launch marks for scripts/desktop/bench.mjs: epoch ms appended to the file named by PAGER_TRACE (nothing happens without it).
// With PAGER_TRACE_CLOSE set the window also closes itself once the first terminal output is on screen, like a user closing it.
const mark = process.env.PAGER_TRACE ? (m, extra) => require('node:fs').appendFile(process.env.PAGER_TRACE, `${JSON.stringify({ m, t: Date.now(), ...extra })}\n`, () => {}) : () => {}
mark('main-start')

const PROBE = `(() => {
  const o = performance.timeOrigin, marks = {}, paints = {}
  for (const e of performance.getEntriesByType('mark')) if (!(e.name in marks)) marks[e.name] = o + e.startTime
  for (const e of performance.getEntriesByType('paint')) paints[e.name] = o + e.startTime
  return JSON.stringify({ marks, paints, bridge: !!(window.pager && window.pager.d) })
})()`

/** Bench only: reads the renderer's performance marks (epoch ms) once the first terminal output was written, then closes the window. */
function traceRenderer(win) {
  const t0 = Date.now()
  const tick = async () => {
    if (win.isDestroyed()) return
    try {
      const r = JSON.parse(await win.webContents.executeJavaScript(PROBE))
      if ('pane-first-byte-any' in r.marks || Date.now() - t0 > 30_000) {
        mark('renderer', r)
        if (process.env.PAGER_TRACE_CLOSE) {
          mark('closing')
          win.close()
        }
        return
      }
    } catch {
      // the page is still loading
    }
    setTimeout(tick, 20)
  }
  win.webContents.once('dom-ready', tick)
}

// A thin client of the Pager daemon: window, browser pane, and a forwarder between the renderer and the daemon's pipe.
// Every program lives in the daemon (dist/daemon); closing this window only detaches. See desktop/DAEMON.md.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn: spawnChild } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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
  const passthrough = argv.filter((a) => a !== '--selftest' && a !== '--install' && !/^--(remote-debugging-|inspect|js-flags|enable-logging|user-data-dir)/.test(a))

  let win
  let browser
  let daemonMod // dist/daemon/client.js
  let settingsMod // dist/daemon/settings.js, loaded when a hotkey or a missing daemon needs it
  let paths
  let client // DaemonClient, or undefined while the daemon is away
  let state = { sessions: [], panes: [], activeSession: '', clients: 0, settings: {} }
  let started = false // this launch had to start the daemon
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
        if (typeof ev.url === 'string') getBrowser().show(ev.url)
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
    // Same pipe, same order: the daemon answers `state` after it has subscribed us.
    const [, first] = await Promise.all([c.subscribe(), c.call('state')])
    let s = first
    if (s.sessions.length === 0) {
      // The first pane of the first session is the Home block (kind 'block:home'): the daemon pins it, and the Pager TUI, agents, chat and calls run in ordinary panes that outlast this window.
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
      let c
      if (start) {
        const r = await daemonMod.connectOrStart(paths, { client: 'window', name: 'electron' })
        c = r.client
        started = r.started
      } else c = await daemonMod.tryConnect(paths.address, { client: 'window', name: 'electron' })
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
      await ready
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
      openUrl: (url) => getBrowser().show(url),
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
    getBrowser().show(sent.reply.url)
  }

  /** The browser pane (a session, a view per tab) only exists once something asks for it. */
  function getBrowser() {
    browser ??= require('./browser.cjs').createBrowser({
      win,
      onState: (s) => send('browser', s),
      // The pane's pages send their chords here: browser-* ones go to the pane's chrome, the rest act like the terminal's.
      onHotkey: (name) => (name.startsWith('browser-') ? send('browser-key', name.slice(8)) : onHotkey(name)),
    })
    return browser
  }

  function onHotkey(name) {
    if (name === 'docs' || name === 'studio') return void showSite(name)
    if (name === 'browser') return getBrowser().command('toggle')
    if (name === 'quit') return void quitAll(true)
    void (settingsMod ? Promise.resolve(settingsMod) : load('daemon/settings.js')).then((m) => {
      settingsMod = m
      const patch = m.stepPatch(state.settings, name)
      if (patch && client) client.call('settings.set', { patch }).catch((e) => log(`settings.set: ${e && e.message}`))
    })
  }

  // ---- window -----------------------------------------------------------------------------------------------------

  // The daemon work starts the moment Electron is ready, in parallel with the window; only what needs the layout waits for it.
  const dir = process.env.PAGER_HOME || path.join(os.homedir(), '.pager')
  // The material is known from the saved settings file alone, so the window is created right-coloured without asking the daemon.
  const desktopJson = fs.promises
    .readFile(path.join(dir, 'desktop.json'), 'utf8')
    .then((t) => {
      const v = JSON.parse(t)
      return v && typeof v === 'object' ? v : {}
    })
    .catch(() => ({}))
  // The module loads while Electron boots. Opening the pipe itself has to wait for app ready: a connection made before it left the process
  // hanging in its exit (the window closed, the process stayed) on Windows.
  const clientModule = load('daemon/client.js')
  clientModule.catch(() => {}) // awaited (and reported) once ready; until then a failure must not be an unhandled rejection
  /** Settles (never rejects) once the daemon is connected and `state` is loaded; false when there is none. */
  const ready = app.whenReady().then(async () => {
    try {
      daemonMod = await clientModule
      paths = daemonMod.resolvePaths({ cliPath: path.join(P, 'dist', 'cli.js'), nodePath: NODE })
      const ok = await connect(true)
      mark('daemon-up', { started, ok })
      if (ok) return true
    } catch (e) {
      log(`daemon start-up failed: ${e && e.stack ? e.stack : e}`)
    }
    // No daemon: the window still opens, with the saved settings; its toast offers Restart.
    settingsMod ??= await load('daemon/settings.js')
    state = { ...state, settings: settingsMod.loadSettings(path.join(paths ? paths.dir : dir, 'desktop.json')) }
    return false
  }).catch((e) => {
    log(`start-up failed: ${e && e.stack ? e.stack : e}`)
    return false
  })

  app.whenReady().then(async () => {
    mark('app-ready')
    const config = configOf(await desktopJson)
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
      titleBarOverlay: { color: '#00000000', symbolColor: '#b4b8c4', height: 40 },
      backgroundColor: solid ? '#000000' : '#00000000',
      backgroundMaterial: material(config.material),
      webPreferences: { preload: path.join(A, 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    })
    mark('window-created')
    win.removeMenu()
    win.once('ready-to-show', () => {
      win.show()
      mark('ready-to-show')
      // What a pinned taskbar button or shortcut made from this window shows and runs: the pager icon, not the exe's resource (which Explorer caches).
      setImmediate(() => win && !win.isDestroyed() && win.setAppDetails({ appId: 'dev.pager.desktop', appIconPath: path.join(P, 'desktop', 'assets', 'pager.ico'), appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Pager' }))
    })
    win.webContents.on('did-finish-load', () => {
      void ready.then(() => {
        send('config', configOf(state.settings))
        send('d:status', status)
        if (status === 'lost') toast('error', 'The Pager daemon is not running.', 'restart')
      })
    })
    // A renderer error would otherwise vanish (devtools are off): it goes to the log.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') log(`renderer: ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (process.env.PAGER_TRACE) traceRenderer(win)
    win.loadFile(path.join(A, 'renderer', 'index.html'))

    // Arguments of the first launch (`Pager.exe run ...`) go where a second launch's would.
    if (passthrough.length > 0) void ready.then(() => forward(passthrough, process.cwd())).catch((e) => log(`forward failed: ${e && e.stack ? e.stack : e}`))
    // A daemon that answered before the window existed may hold newer settings than the file the window was made from.
    void ready.then(applyConfig)

    const needClient = () => {
      if (!client) throw new Error('The Pager daemon is not running')
      return client
    }
    const BLOCKED = new Set(['hello', 'daemon.stop', 'stop'])

    // The renderer starts in parallel with the daemon connection; whatever needs the daemon's answer waits for it.
    ipcMain.handle('d:state', async (e) => {
      if (!own(e)) return undefined
      await ready
      return state
    })
    ipcMain.handle('d:call', async (e, type, args) => {
      if (!own(e)) return undefined
      if (typeof type !== 'string' || BLOCKED.has(type)) throw new Error(`request not allowed: ${type}`)
      await ready
      return needClient().call(type, args && typeof args === 'object' ? args : {})
    })
    ipcMain.handle('d:attach', async (e, paneId, size) => {
      if (!own(e)) return undefined
      await ready
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
    ipcMain.handle('d:status', async (e) => {
      if (!own(e)) return undefined
      await ready
      return status
    })
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
    // The caption buttons float over the glass, so their symbols follow the theme: light grey on pitch black, dark grey on the off-white light theme. The renderer sends the mode on boot and on every theme change.
    ipcMain.on('chrome', (e, cmd, arg) => {
      if (own(e) && cmd === 'titlebar' && /^#[0-9a-f]{6}$/i.test(String(arg))) win.setTitleBarOverlay({ symbolColor: String(arg) })
    })
    const BROWSER_CMDS = new Set(['toggle', 'hide', 'new', 'open', 'go', 'activate', 'close', 'next', 'prev', 'back', 'forward', 'reload', 'bounds', 'state'])
    ipcMain.on('browser', (e, cmd, arg) => {
      if (own(e) && BROWSER_CMDS.has(cmd)) getBrowser().command(cmd, arg)
    })
    ipcMain.on('hotkey', (e, name) => {
      if (own(e)) onHotkey(name)
    })
  })

  // Closing the window detaches; the daemon, and every program in it, carries on. Only an explicit Quit (d.quit()) stops it.
  app.on('window-all-closed', () => void quitAll(false))
}
