'use strict'
// Thin glue: window + pty bridge. Everything else is Pager itself, run as a child on a pseudo-terminal.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn: spawnChild } = require('node:child_process')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createBrowser } = require('./browser.cjs')

const A = path.join(process.resourcesPath, 'app')
const P = path.join(A, 'pager')
// Pager runs under the bundled (OpenJS-signed) node.exe: Electron's GUI-subsystem exe cannot act as node on a ConPTY.
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
  let term
  let config
  let configFile
  let tail = ''
  let pending = ''
  let flush

  app.on('second-instance', async (_e, _argv, _cwd, extra) => {
    const second = Array.isArray(extra?.argv) ? extra.argv : []
    const cwd = typeof extra?.cwd === 'string' ? extra.cwd : os.homedir()
    try {
      const { parseArgs } = await load('app/args.js')
      const { sendControl } = await load('app/control.js')
      const { dataDir } = await load('platform/paths.js')
      const parsed = parseArgs(second)
      if (!('error' in parsed) && (parsed.command === 'exec' || parsed.cwd !== undefined)) {
        const command = parsed.words?.join(' ')
        await sendControl(dataDir(), { type: 'run', cwd: parsed.cwd ?? cwd, ...(command ? { command } : {}) })
      }
    } catch (e) {
      // A failed forward must not stop the window from coming forward; the reason goes to the log.
      try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'host.log'), `${new Date().toISOString()} forward failed: ${e && e.stack ? e.stack : e}\n`)
      } catch {
        // no log, no problem
      }
    }
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  const material = (m) => (m === 'solid' ? 'none' : m === 'mica' ? 'mica' : 'acrylic')

  // The docs and the bot studio are served by the running Pager on 127.0.0.1; the browser pane shows them.
  let browser
  async function showSite(page) {
    const { sendControl } = await load('app/control.js')
    const { dataDir } = await load('platform/paths.js')
    const sent = await sendControl(dataDir(), page === 'studio' ? { type: 'docs', page } : { type: 'docs' }).catch(() => ({ kind: 'none' }))
    if (sent.kind !== 'ok' || !sent.reply.ok || !sent.reply.url) return void dialog.showErrorBox(page === 'studio' ? 'Pager bot studio' : 'Pager docs', sent.kind === 'ok' && !sent.reply.ok ? sent.reply.error : 'Pager is not running yet.')
    browser.show(sent.reply.url)
  }

  // Pager (and every program in its shell) asks this window to show a URL over a private pipe; the token is in their environment.
  const hostToken = randomBytes(16).toString('hex')
  const hostPipe = process.platform === 'win32' ? `\\\\.\\pipe\\pager-desktop-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `pager-desktop-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
  const hostServer = net.createServer((sock) => {
    let buf = ''
    sock.setTimeout(5000, () => sock.destroy())
    sock.on('error', () => {})
    sock.on('data', (d) => {
      buf += d
      if (buf.length > 8192) return sock.destroy()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let ok = false
      try {
        const m = JSON.parse(buf.slice(0, nl))
        const given = Buffer.from(String(m.token))
        const want = Buffer.from(hostToken)
        ok = given.length === want.length && timingSafeEqual(given, want) && m.type === 'open' && typeof m.url === 'string' && browser.show(m.url)
      } catch {
        // not JSON: refused
      }
      sock.end(ok ? 'ok\n' : 'no\n')
    })
  })
  hostServer.on('error', () => {})
  hostServer.listen(hostPipe)

  function applyConfig() {
    const solid = config.material === 'solid'
    win.setBackgroundMaterial(material(config.material))
    win.setBackgroundColor(solid ? '#000000' : '#00000000')
    win.webContents.send('config', config)
  }

  app.whenReady().then(async () => {
    const cfg = await load('host/config.js')
    configFile = path.join(app.getPath('userData'), 'desktop.json')
    config = cfg.loadConfig(configFile)
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
    win.webContents.on('did-finish-load', () => win.webContents.send('config', config))
    // A renderer error would otherwise vanish (devtools are off): it goes to the log.
    win.webContents.on('console-message', (e) => {
      if (e.level !== 'error') return
      try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'host.log'), `${new Date().toISOString()} renderer: ${e.message} (${e.sourceId}:${e.lineNumber})\n`)
      } catch {
        // no log, no problem
      }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    browser = createBrowser({
      win,
      onState: (state) => { if (!win.isDestroyed()) win.webContents.send('browser', state) },
      // The pane's pages send their chords here: browser-* ones go to the pane's chrome, the rest act like the terminal's.
      onHotkey: (name) => (name.startsWith('browser-') ? win.webContents.send('browser-key', name.slice(8)) : onHotkey(name)),
    })
    win.loadFile(path.join(A, 'renderer', 'index.html'))

    ipcMain.on('ready', (_e, cols, rows) => startPty(cols, rows))
    ipcMain.on('input', (_e, s) => term?.write(String(s)))
    ipcMain.on('resize', (_e, cols, rows) => {
      if (term && cols > 0 && rows > 0) term.resize(Math.min(cols, 400), Math.min(rows, 200))
    })
    ipcMain.on('title', (_e, t) => win.setTitle(t || 'Pager'))
    const BROWSER_CMDS = new Set(['toggle', 'hide', 'new', 'open', 'go', 'activate', 'close', 'next', 'prev', 'back', 'forward', 'reload', 'bounds', 'state'])
    ipcMain.on('browser', (_e, cmd, arg) => {
      if (BROWSER_CMDS.has(cmd)) browser.command(cmd, arg)
    })
    ipcMain.on('hotkey', (_e, name) => onHotkey(name))
    function onHotkey(name) {
      if (name === 'docs' || name === 'studio') return void showSite(name)
      if (name === 'browser') return browser.command('toggle')
      if (name === 'material') config = { ...config, material: cfg.nextMaterial(config.material) }
      else if (name === 'opacity+') config = { ...config, opacity: cfg.stepOpacity(config.opacity, 10) }
      else if (name === 'opacity-') config = { ...config, opacity: cfg.stepOpacity(config.opacity, -10) }
      else if (name === 'font+') config = { ...config, fontSize: cfg.stepFont(config.fontSize, 1) }
      else if (name === 'font-') config = { ...config, fontSize: cfg.stepFont(config.fontSize, -1) }
      else if (name === 'font0') config = { ...config, fontSize: cfg.DEFAULT_CONFIG.fontSize }
      else return
      cfg.saveConfig(configFile, config)
      applyConfig()
    }
  })

  async function startPty(cols, rows) {
    if (term) return
    // Required from Pager's own node_modules; useConptyDll selects the Microsoft-signed conpty.dll + OpenConsole.exe it ships.
    const pty = require(path.join(P, 'node_modules', '@lydell', 'node-pty'))
    term = pty.spawn(NODE, [path.join(P, 'dist', 'cli.js'), ...passthrough], {
      name: 'xterm-256color',
      cols: Math.min(Math.max(cols, 20), 400),
      rows: Math.min(Math.max(rows, 5), 200),
      cwd: os.homedir(),
      useConptyDll: true,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'pager-desktop', PAGER_NO_UPDATE_CHECK: '1', PAGER_DESKTOP_PIPE: hostPipe, PAGER_DESKTOP_TOKEN: hostToken },
    })
    term.onData((d) => {
      tail = (tail + d).slice(-16384)
      pending += d
      if (flush === undefined) {
        flush = setTimeout(() => {
          flush = undefined
          const chunk = pending
          pending = ''
          if (!win.isDestroyed()) win.webContents.send('data', chunk)
        }, 8)
      }
    })
    term.onExit(({ exitCode }) => {
      term = undefined
      if (exitCode === 0) return app.quit()
      try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'crash.log'), tail)
      } catch {
        // best effort
      }
      win.webContents.send('exit', exitCode)
      ipcMain.once('input', () => app.quit())
    })
  }

  app.on('window-all-closed', () => {
    hostServer.close()
    browser?.destroy()
    try {
      term?.kill()
    } catch {
      // already gone
    }
    app.quit()
  })
}
