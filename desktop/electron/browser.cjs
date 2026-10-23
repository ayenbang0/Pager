'use strict'
// The browser pane: tabs of web pages shown beside the terminal. Pages are WebContentsViews laid over the renderer's
// #viewport box; the chrome (tabs, address bar) is HTML in the renderer. Pages get no preload, no Node, no permissions.
const { WebContentsView, session } = require('electron')

const PARTITION = 'persist:pager-browser'
const MAX_TABS = 12
const SEARCH = 'https://duckduckgo.com/?q='

/** An address-bar entry as a URL: a URL as typed, a bare host with https (http for localhost and IPs), anything else a search. */
function normalize(input) {
  const text = String(input).trim()
  if (text === '' || /[\u0000-\u001f]/.test(text)) return undefined
  if (/^https?:\/\//i.test(text)) return safe(text)
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d{1,5})?([/?#]|$)/i.test(text)) return safe(`http://${text}`)
  if (!/\s/.test(text) && /^[^\s/?#:]+\.[^\s/?#:]{2,}(:\d{1,5})?([/?#]|$)/.test(text)) return safe(`https://${text}`)
  return `${SEARCH}${encodeURIComponent(text)}`
}

/** `url` when it is an http(s) URL, else undefined. */
function safe(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const errorPage = (url, why) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>Can't open the page</title><body style="margin:0;background:#000;color:#c0caf5;font:14px 'Cascadia Mono',Consolas,monospace;padding:12vh 8vw"><h2 style="color:#f7768e;font-weight:600;margin:0 0 12px">&gt; can't open this page</h2><p style="color:#7a82a8;word-break:break-all">${url.replace(/[<&>"]/g, '')}</p><p>${String(why).replace(/[<&>"]/g, '')}</p>`,
  )}`

/**
 * @param {{ win: import('electron').BrowserWindow, onState: (s: object) => void, onHotkey: (name: string) => void }} o
 */
function createBrowser({ win, onState, onHotkey }) {
  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => {
    e.preventDefault()
    notice = 'Downloads are off in the pager browser'
    push()
  })

  /** @type {{ id: number, view: import('electron').WebContentsView, failed?: string }[]} */
  let tabs = []
  let active = -1
  let visible = false
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  let nextId = 1
  let notice = ''

  const current = () => tabs.find((t) => t.id === active)
  const wc = (t) => t.view.webContents

  function layout() {
    for (const t of tabs) {
      const show = visible && t.id === active && bounds.width > 0 && bounds.height > 0
      t.view.setVisible(show)
      if (show) t.view.setBounds(bounds)
    }
  }

  function push() {
    layout()
    onState({
      visible,
      active,
      notice,
      tabs: tabs.map((t) => {
        const w = wc(t)
        return { id: t.id, title: t.failed === undefined ? w.getTitle() || w.getURL() || 'new tab' : `can't open ${hostOf(t.failed)}`, url: t.failed ?? w.getURL(), loading: w.isLoading(), back: w.navigationHistory.canGoBack(), forward: w.navigationHistory.canGoForward() }
      }),
    })
    notice = ''
  }

  function create(url) {
    if (tabs.length >= MAX_TABS) {
      notice = `At most ${MAX_TABS} tabs`
      return push()
    }
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false, spellcheck: false } })
    view.setBackgroundColor('#000000')
    view.setBorderRadius(10)
    const tab = { id: nextId++, view }
    tabs.push(tab)
    win.contentView.addChildView(view)
    const w = wc(tab)
    for (const ev of ['page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) w.on(ev, () => push())
    w.on('did-start-navigation', (e) => {
      // The error page is itself a navigation; only a real one clears the failure.
      if (e.isMainFrame && !e.isSameDocument && !e.url.startsWith('data:text/html')) tab.failed = undefined
    })
    w.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: the load was replaced or stopped
      tab.failed = failedUrl
      void w.loadURL(errorPage(failedUrl, desc))
    })
    w.on('will-navigate', (e, to) => {
      if (safe(to) === undefined && !to.startsWith('data:text/html')) e.preventDefault()
    })
    // A page's own new-window requests become tabs; nothing else may open.
    w.setWindowOpenHandler(({ url: to }) => {
      const ok = safe(to)
      if (ok !== undefined) open(ok)
      return { action: 'deny' }
    })
    w.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const k = input.key
      const ctrl = input.control && !input.alt
      const hit = (name) => {
        e.preventDefault()
        onHotkey(name)
      }
      if (ctrl && !input.shift && k.toLowerCase() === 'l') return hit('browser-address')
      if (ctrl && !input.shift && k.toLowerCase() === 't') return hit('browser-new')
      if (ctrl && !input.shift && k.toLowerCase() === 'w') return hit('browser-close')
      if (ctrl && input.shift && k.toLowerCase() === 'b') return hit('browser')
      if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) return hit('browser-reload')
      if (input.alt && k === 'ArrowLeft') return hit('browser-back')
      if (input.alt && k === 'ArrowRight') return hit('browser-forward')
      if (ctrl && k === 'Tab') return hit(input.shift ? 'browser-prev' : 'browser-next')
      if (k === 'F1') return hit('docs')
      if (k === 'F2') return hit('studio')
    })
    active = tab.id
    visible = true
    if (url !== undefined) void w.loadURL(url)
    push()
    return tab
  }

  /** Shows `url` in a tab: an existing tab already on it comes forward, else a new one opens. */
  function open(url, { reuse = false } = {}) {
    const ok = safe(url)
    if (ok === undefined) return false
    const same = reuse ? tabs.find((t) => wc(t).getURL() === ok) : undefined
    if (same) {
      active = same.id
      visible = true
      push()
    } else create(ok)
    return true
  }

  function close(id) {
    const i = tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const [t] = tabs.splice(i, 1)
    win.contentView.removeChildView(t.view)
    wc(t).close()
    if (active === id) active = (tabs[i] ?? tabs[i - 1])?.id ?? -1
    if (tabs.length === 0) visible = false
    push()
  }

  function step(delta) {
    if (tabs.length < 2) return
    const i = tabs.findIndex((t) => t.id === active)
    active = tabs[(i + delta + tabs.length) % tabs.length].id
    push()
  }

  return {
    open,
    /** A renderer command; unknown ones are ignored. */
    command(cmd, arg) {
      const t = current()
      switch (cmd) {
        case 'toggle':
          if (!visible && tabs.length === 0) create(undefined)
          else visible = !visible
          return push()
        case 'hide':
          visible = false
          return push()
        case 'new':
          visible = true
          return void create(undefined)
        case 'open':
          return void open(String(arg), { reuse: false })
        case 'go': {
          const url = normalize(arg)
          if (url === undefined) return
          if (t) void wc(t).loadURL(url)
          else create(url)
          return
        }
        case 'activate':
          if (tabs.some((x) => x.id === arg)) active = arg
          return push()
        case 'close':
          return close(typeof arg === 'number' ? arg : active)
        case 'next':
          return step(1)
        case 'prev':
          return step(-1)
        case 'back':
          if (t && wc(t).navigationHistory.canGoBack()) wc(t).navigationHistory.goBack()
          return
        case 'forward':
          if (t && wc(t).navigationHistory.canGoForward()) wc(t).navigationHistory.goForward()
          return
        case 'reload':
          if (t) wc(t).isLoading() ? wc(t).stop() : wc(t).reload()
          return
        case 'bounds': {
          const b = arg || {}
          const n = (v) => Math.max(0, Math.round(Number(v) || 0))
          bounds = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) }
          return layout()
        }
        case 'state':
          return push()
      }
    },
    /** Shows `url`, reusing a tab that is already on it. */
    show: (url) => open(url, { reuse: true }),
    tabCount: () => tabs.length,
    destroy() {
      for (const t of tabs) {
        try {
          wc(t).close()
        } catch {
          // already gone
        }
      }
      tabs = []
    },
  }
}

module.exports = { createBrowser, normalize }
