// The web client of `pager serve`: layout, live terminals (xterm.js) and input over one WebSocket to the session daemon.
// Plain browser JS, no bundler; served from memory by the server, so it needs no files at run time.

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`
const ICON = {
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  run: svg('<path d="m3.5 4.5 3.5 3.5-3.5 3.5M8.5 12h4"/>'),
  right: svg('<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M8 3v10"/>'),
  down: svg('<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 8h11"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5v-1.2a1.8 1.8 0 0 0-1.8-1.8H4.3a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8h1.2"/>'),
  close: svg('<path d="m4.5 4.5 7 7m0-7-7 7"/>'),
}

const app = {
  ws: null,
  readOnly: false,
  data: null, // the daemon's layout: { sessions, panes, activeSession }
  tabId: null,
  focus: null,
  views: new Map(),
  sig: '',
  retry: 0,
  seq: 0,
  calls: new Map(),
}

// ---------------------------------------------------------------- small helpers

function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function toast(text, level = 'info') {
  const t = el('div', 'rm-toast', text)
  t.dataset.level = level
  $('toasts').append(t)
  setTimeout(() => t.remove(), level === 'error' ? 7000 : 3500)
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

function terminalTheme() {
  const t = {
    background: 'rgba(0,0,0,0)',
    foreground: cssVar('--tv-fg') || '#e4e4e7',
    cursor: cssVar('--tv-cur') || '#e4e4e7',
    cursorAccent: cssVar('--tv-cur-ink') || '#060607',
    selectionBackground: cssVar('--tv-sel') || 'rgba(90,140,255,.32)',
  }
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
  names.forEach((n, i) => {
    const v = cssVar(`--ansi${i}`)
    if (v) t[n] = v
  })
  return t
}

// ---------------------------------------------------------------- connection

function call(t, args = {}) {
  return new Promise((resolve, reject) => {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'))
    const id = ++app.seq
    app.calls.set(id, { resolve, reject })
    app.ws.send(JSON.stringify({ t, id, ...args }))
  })
}

function send(t, args = {}) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify({ t, ...args }))
}

function setLink(state) {
  const chip = $('link')
  chip.dataset.state = state
  chip.textContent = state === 'live' ? 'Live' : state === 'offline' ? 'Reconnecting' : 'Connecting'
}

function connect() {
  setLink('connecting')
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  app.ws = ws
  ws.onopen = () => {
    app.retry = 0
    setLink('live')
  }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') onJson(JSON.parse(e.data))
    else onBinary(e.data)
  }
  ws.onclose = async () => {
    if (app.ws !== ws) return
    setLink('offline')
    for (const c of app.calls.values()) c.reject(new Error('connection lost'))
    app.calls.clear()
    for (const v of app.views.values()) v.live = false
    const r = await fetch('/api/session', { credentials: 'same-origin' }).catch(() => null)
    if (r && r.status === 401) return gate('Your session ended. Open the link from `pager serve` again.')
    setTimeout(connect, Math.min(5000, 600 * 2 ** app.retry++))
  }
}

function onBinary(buf) {
  if (buf.byteLength <= 4) return
  const id = new DataView(buf).getUint32(0, true)
  const view = app.views.get(String(id))
  if (view && view.live) view.write(new Uint8Array(buf, 4))
}

function onJson(m) {
  switch (m.t) {
    case 'hello':
      app.readOnly = !!m.readOnly
      document.body.classList.toggle('ro', app.readOnly)
      $('ro').hidden = !app.readOnly
      break
    case 'state':
      app.data = m.state
      render()
      break
    case 'reply': {
      const c = app.calls.get(m.id)
      if (!c) break
      app.calls.delete(m.id)
      if (m.ok) c.resolve(m.result)
      else c.reject(new Error(m.error))
      break
    }
    case 'resync': {
      const v = app.views.get(m.pane)
      if (v) v.replay(m)
      break
    }
    case 'event':
      onEvent(m)
      break
  }
}

function onEvent(ev) {
  const v = ev.paneId === undefined ? undefined : app.views.get(String(ev.paneId))
  switch (ev.event) {
    case 'pane_resized':
      if (v && app.readOnly && v.term) v.term.resize(ev.cols, ev.rows)
      break
    case 'bell':
      if (v) v.flash()
      break
    case 'toast':
      toast(String(ev.text || ''), ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info')
      break
  }
}

// ---------------------------------------------------------------- panes

let xtermFonts = null
const fontsReady = () => (xtermFonts ||= Promise.race([document.fonts.load('13px "Geist Mono"'), new Promise((r) => setTimeout(r, 1500))]))

class PaneView {
  constructor(id) {
    this.id = id
    this.term = null
    this.fit = null
    this.live = false
    this.shown = false
    this.syncing = false
    this.queue = []
    this.raf = 0
    this.fitRaf = 0
    this.el = el('section', 'rm-pane')
    this.dot = el('span', 'rm-dot')
    this.title = el('b')
    this.cwd = el('i')
    const bar = el('div', 'rm-pane-bar')
    bar.append(this.dot, this.title, this.cwd, this.button('right', 'Split right', 'rm-w', () => this.split('row')), this.button('down', 'Split down', 'rm-w', () => this.split('col')), this.button('copy', 'Copy the screen as text', '', () => this.copyScreen()), this.button('close', 'Close pane', 'rm-w', () => this.close()))
    this.body = el('div', 'rm-term')
    this.note = el('div', 'rm-note')
    this.note.hidden = true
    this.el.append(bar, this.body, this.note)
    this.el.addEventListener('pointerdown', () => setFocus(this.id))
    if (app.readOnly) this.el.classList.add('rm-ro')
  }

  button(icon, label, cls, fn) {
    const b = el('button', cls)
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.innerHTML = ICON[icon]
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }

  update(meta) {
    this.meta = meta
    this.title.textContent = meta.title || meta.kind
    this.cwd.textContent = meta.cwd || ''
    this.dot.dataset.state = meta.state
    const block = String(meta.kind).startsWith('block:')
    this.note.hidden = !(block || meta.state === 'exited')
    this.note.textContent = block ? 'This pane lives in the Pager desktop app.' : meta.state === 'exited' ? `Exited${meta.exitCode === undefined ? '' : ` (code ${meta.exitCode})`}` : ''
  }

  split(dir) {
    call('split', { pane: this.id, dir, kind: 'shell' }).catch((e) => toast(e.message, 'error'))
  }

  close() {
    if (this.meta && this.meta.state === 'running' && !confirm(`Close "${this.meta.title}"? Its program will end.`)) return
    call('close', { pane: this.id }).catch((e) => toast(e.message, 'error'))
  }

  async copyScreen() {
    try {
      const r = await call('capture', { pane: this.id })
      await navigator.clipboard.writeText(r.text)
      toast('Screen copied')
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  flash() {
    this.el.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 220 })
  }

  async #open() {
    if (this.term || this.opening) return this.opening
    this.opening = (async () => {
      await fontsReady()
      const term = new Terminal({
        fontFamily: cssVar('--mono') || 'monospace',
        fontSize: 13,
        lineHeight: 1.28,
        allowTransparency: true,
        allowProposedApi: true,
        customGlyphs: true,
        cursorBlink: true,
        scrollback: 10000,
        theme: terminalTheme(),
        disableStdin: app.readOnly,
      })
      const fit = new FitAddon.FitAddon()
      term.loadAddon(fit)
      term.open(this.body)
      this.term = term
      this.fit = fit
      term.onData((d) => {
        if (!app.readOnly) send('input', { pane: this.id, data: d })
      })
      term.onBinary((d) => {
        if (!app.readOnly) send('input', { pane: this.id, b64: bytesToB64(Uint8Array.from(d, (c) => c.charCodeAt(0))) })
      })
      term.onResize(({ cols, rows }) => {
        if (!app.readOnly && !this.syncing) send('resize', { pane: this.id, cols, rows })
      })
      if (!app.readOnly) {
        this.ro = new ResizeObserver(() => {
          cancelAnimationFrame(this.fitRaf)
          this.fitRaf = requestAnimationFrame(() => this.refit())
        })
        this.ro.observe(this.body)
      }
    })()
    return this.opening
  }

  refit() {
    if (!this.term || !this.shown || this.body.clientWidth < 20) return
    const d = this.fit.proposeDimensions()
    if (d && Number.isFinite(d.cols) && (d.cols !== this.term.cols || d.rows !== this.term.rows)) this.term.resize(d.cols, d.rows)
  }

  /** In the active tab: open the terminal if needed and attach to the daemon's output. */
  async show() {
    this.shown = true
    if (String(this.meta?.kind).startsWith('block:')) return
    await this.#open()
    if (!this.shown || this.live || this.attaching) return
    this.attaching = true
    try {
      if (!app.readOnly) this.refit()
      const size = app.readOnly ? {} : { cols: this.term.cols, rows: this.term.rows }
      const r = await call('attach', { pane: this.id, ...size })
      if (this.shown) this.replay(r)
    } catch (e) {
      if (e.message !== 'connection lost' && e.message !== 'not connected') toast(`${this.meta?.title ?? this.id}: ${e.message}`, 'error')
    } finally {
      this.attaching = false
    }
  }

  hide() {
    this.shown = false
    if (this.live) send('detach', { pane: this.id })
    this.live = false
  }

  replay(r) {
    const { term } = this
    if (!term) return
    this.queue = []
    this.syncing = true
    term.reset()
    if (app.readOnly) term.resize(r.cols, r.rows)
    else if (r.cols && r.rows && (r.cols !== term.cols || r.rows !== term.rows)) term.resize(r.cols, r.rows)
    this.live = true
    term.write(r.replay ? b64ToBytes(r.replay) : '', () => {
      this.syncing = false
      this.refit()
    })
  }

  /** Output chunks are joined and written once per animation frame; a hidden tab gets no frames, so a timer flushes too. */
  write(bytes) {
    this.queue.push(bytes)
    if (this.raf) return
    const flush = () => {
      cancelAnimationFrame(this.raf)
      clearTimeout(this.timer)
      this.raf = 0
      const q = this.queue
      this.queue = []
      if (!this.term || q.length === 0) return
      if (q.length === 1) return this.term.write(q[0])
      let n = 0
      for (const c of q) n += c.length
      const all = new Uint8Array(n)
      n = 0
      for (const c of q) {
        all.set(c, n)
        n += c.length
      }
      this.term.write(all)
    }
    this.raf = requestAnimationFrame(flush)
    this.timer = setTimeout(flush, 120)
  }

  focusTerm() {
    if (this.term && !app.readOnly) this.term.focus()
  }

  dispose() {
    this.hide()
    cancelAnimationFrame(this.raf)
    clearTimeout(this.timer)
    cancelAnimationFrame(this.fitRaf)
    if (this.ro) this.ro.disconnect()
    if (this.term) this.term.dispose()
    this.el.remove()
  }
}

function setFocus(id) {
  app.focus = id
  for (const [pid, v] of app.views) v.el.dataset.focus = String(pid === id)
}

// ---------------------------------------------------------------- layout

function allTabs() {
  const out = []
  const sessions = app.data ? app.data.sessions : []
  for (const s of sessions) for (const t of s.tabs) out.push({ session: s, tab: t, many: sessions.length > 1 })
  return out
}

function currentTab() {
  const tabs = allTabs()
  let hit = tabs.find((x) => x.tab.id === app.tabId)
  if (!hit) {
    const s = app.data.sessions.find((x) => x.id === app.data.activeSession) || app.data.sessions[0]
    hit = s && tabs.find((x) => x.session === s && x.tab.id === s.activeTab)
    hit = hit || tabs[0]
  }
  return hit
}

function paneIdsOf(n, out = []) {
  if (n.type === 'pane') out.push(n.paneId)
  else {
    paneIdsOf(n.a, out)
    paneIdsOf(n.b, out)
  }
  return out
}

function buildNode(n) {
  if (n.type === 'pane') {
    const v = app.views.get(n.paneId)
    return v ? v.el : el('div')
  }
  const box = el('div', `rm-split rm-${n.dir}`)
  const a = buildNode(n.a)
  const b = buildNode(n.b)
  a.style.flex = `${n.ratio} 1 0`
  b.style.flex = `${1 - n.ratio} 1 0`
  box.append(a, b)
  return box
}

function render() {
  const d = app.data
  if (!d) return
  const cur = currentTab()
  const panesById = new Map(d.panes.map((p) => [p.id, p]))
  // Skip the rebuild when nothing the page draws changed (state events also carry cpu and size churn).
  const sig = JSON.stringify([cur && cur.tab.id, d.sessions.map((s) => [s.name, s.tabs.map((t) => [t.id, t.title, t.root])]), d.panes.map((p) => [p.id, p.title, p.cwd, p.state, p.exitCode, p.kind])])
  $('count').textContent = `${d.panes.length} pane${d.panes.length === 1 ? '' : 's'}`
  if (sig === app.sig) return
  app.sig = sig

  const tabs = $('tabs')
  tabs.replaceChildren()
  for (const x of allTabs()) {
    const b = el('button', 'rm-tab')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(cur && x.tab.id === cur.tab.id))
    b.append(el('span', '', x.tab.title || 'Tab'))
    if (x.many) b.append(el('small', '', x.session.name))
    b.addEventListener('click', () => {
      app.tabId = x.tab.id
      app.sig = ''
      render()
    })
    tabs.append(b)
  }

  const wanted = new Set(cur ? paneIdsOf(cur.tab.root) : [])
  for (const [id, v] of app.views) {
    if (!panesById.has(id)) {
      v.dispose()
      app.views.delete(id)
    } else if (!wanted.has(id)) v.hide()
  }
  for (const id of wanted) {
    if (!app.views.has(id)) app.views.set(id, new PaneView(id))
    const meta = panesById.get(id)
    if (meta) app.views.get(id).update(meta)
  }
  const stage = $('stage')
  if (!cur) {
    stage.replaceChildren(el('div', 'rm-empty', app.readOnly ? 'Nothing is running in the session daemon.' : 'Nothing is running. Press + to start a shell.'))
    return
  }
  stage.replaceChildren(buildNode(cur.tab.root))
  if (!wanted.has(app.focus)) setFocus(wanted.has(cur.tab.focus) ? cur.tab.focus : [...wanted][0])
  else setFocus(app.focus)
  for (const id of wanted) void app.views.get(id).show()
  const f = app.views.get(app.focus)
  if (f) void f.show().then(() => f.focusTerm())
}

// ---------------------------------------------------------------- gate and start

function gate(message) {
  $('app').hidden = true
  $('gate').hidden = false
  if (message) $('gateMsg').textContent = message
}

async function login(token) {
  const r = await fetch('/api/auth', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  if (r.ok) return null
  if (r.status === 429) return `Too many wrong tokens. Try again in ${r.headers.get('retry-after') || 'a minute'} s.`
  return 'That token is not valid for this run of pager serve.'
}

function start(info) {
  app.readOnly = !!info.readOnly
  document.body.classList.toggle('ro', app.readOnly)
  $('ro').hidden = !app.readOnly
  $('note').textContent = `pager ${info.version}`
  $('gate').hidden = true
  $('app').hidden = false
  $('newBtn').innerHTML = ICON.plus
  $('runBtn').innerHTML = ICON.run
  connect()
}

async function boot() {
  const params = new URLSearchParams(location.hash.slice(1))
  const token = params.get('token')
  if (token) {
    history.replaceState(null, '', location.pathname + location.search) // the token leaves the address bar and the history
    const bad = await login(token)
    if (bad) return gate(bad)
  }
  const r = await fetch('/api/session', { credentials: 'same-origin' }).catch(() => null)
  if (r && r.ok) start(await r.json())
  else gate()
}

$('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const bad = await login($('gateToken').value.trim())
  if (bad) return void ($('gateMsg').textContent = bad)
  $('gateToken').value = ''
  boot()
})

$('newBtn').addEventListener('click', () => {
  call('new', { kind: 'shell' })
    .then((r) => {
      app.tabId = r.tabId
      app.sig = ''
      if (app.data) render()
    })
    .catch((e) => toast(e.message, 'error'))
})

const runBar = $('runBar')
const hideRun = () => {
  runBar.hidden = true
}
$('runBtn').addEventListener('click', () => {
  runBar.hidden = !runBar.hidden
  if (!runBar.hidden) $('runInput').focus()
})
$('runCancel').addEventListener('click', hideRun)
runBar.addEventListener('submit', (e) => {
  e.preventDefault()
  const command = $('runInput').value.trim()
  if (!command) return
  const at = app.focus && app.views.has(app.focus) ? { pane: app.focus } : {}
  call('run', { command, dir: 'row', ...at })
    .then((r) => {
      $('runInput').value = ''
      hideRun()
      setFocus(r.paneId)
    })
    .catch((err) => toast(err.message, 'error'))
})

void boot()
