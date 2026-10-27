// One xterm.js terminal bound to one daemon pane: replay on attach, rAF-coalesced writes, WebGL only while visible.
import { app } from './store.js'
import { runCommand } from './commands.js'
import { toast } from './toast.js'
import { attachSurface } from '../surface/index.js'

let xtermReady = null
const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`cannot load ${src}`))
    document.head.append(s)
  })

/** xterm + addons load on demand so the shell skeleton paints first. */
export function loadXterm() {
  if (window.Terminal && window.FitAddon && window.WebglAddon) return Promise.resolve()
  xtermReady ||= Promise.all(['vendor/xterm.js', 'vendor/addon-fit.js', 'vendor/addon-webgl.js'].map(loadScript))
  return xtermReady
}

const enc = new TextEncoder()
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d)
const isWin = /Windows/i.test(navigator.userAgent)
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

export function terminalTheme() {
  const v = cssVar
  const t = {
    background: 'rgba(0,0,0,0)',
    foreground: v('--tv-fg') || '#e4e4e7',
    cursor: v('--tv-cur') || '#e4e4e7',
    cursorAccent: v('--tv-cur-ink') || '#060607',
    selectionBackground: v('--tv-sel') || 'rgba(90,140,255,.32)',
    selectionInactiveBackground: v('--l2') || 'rgba(255,255,255,.1)',
  }
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
  names.forEach((n, i) => (t[n] = v(`--ansi${i}`) || undefined))
  return t
}

export function fontStack() {
  const base = cssVar('--mono') || "'Geist Mono', Consolas, monospace"
  const custom = (app.settings.font_family || '').trim()
  return custom ? `"${custom.replace(/"/g, '')}", ${base}` : base
}

export class TerminalView {
  /** hooks: { onFocus(), onTitle(t), onBell(), onSize(cols,rows), onKey(e) -> boolean (true = swallow), onReady() } */
  constructor(paneId, host, hooks = {}) {
    this.id = paneId
    this.host = host
    this.hooks = hooks
    this.term = null
    this.fit = null
    this.webgl = null
    this.attached = false
    this.visible = false
    this.disposed = false
    this.queue = []
    this.queued = 0
    this.raf = 0
    this.timer = 0
    this.fitRaf = 0
    this.firstByte = false
    this.starting = null
    this.syncing = true // while replaying, term.onResize must not echo to the daemon
  }

  /** Create and attach on first use. Resolves when the replay has been written. */
  start() {
    this.starting ||= this.#start()
    return this.starting
  }

  async #start() {
    await loadXterm()
    await Promise.race([document.fonts.load(`13px "Geist Mono"`), new Promise((r) => setTimeout(r, 1500))])
    if (this.disposed) return
    const s = app.settings
    const term = new Terminal({
      fontFamily: fontStack(),
      fontSize: s.font_size || 13,
      fontWeight: s.font_weight || 400,
      fontWeightBold: 'bold',
      lineHeight: s.line_height || 1.28,
      allowTransparency: true,
      allowProposedApi: true,
      customGlyphs: true,
      cursorStyle: s.cursor && s.cursor.shape === 'bar' ? 'bar' : s.cursor && s.cursor.shape === 'underline' ? 'underline' : 'block',
      cursorBlink: !s.cursor || s.cursor.blink !== false,
      scrollback: Math.min(s.scrollback_lines || 10000, 20000),
      scrollSensitivity: (s.scroll_speed || 100) / 100,
      smoothScrollDuration: s.smooth_scroll === false ? 0 : 80,
      minimumContrastRatio: this.#contrast(),
      windowsPty: isWin ? { backend: 'conpty' } : undefined,
      theme: terminalTheme(),
    })
    const fit = new FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(this.host)
    this.term = term
    this.fit = fit
    this.surface = attachSurface(term, { openBlock: (n, a) => runCommand('block.open', { name: n, args: a, from: this.id }), onError: (m) => toast('warn', m) })

    term.onData((d) => app.d.write(this.id, d))
    term.onResize(({ cols, rows }) => {
      if (!this.syncing) app.d.resize(this.id, cols, rows)
      if (this.hooks.onSize) this.hooks.onSize(cols, rows)
    })
    term.onTitleChange((t) => this.hooks.onTitle && this.hooks.onTitle(t))
    term.onBell(() => this.hooks.onBell && this.hooks.onBell())
    term.onSelectionChange(() => {
      if (app.settings.copy_on_select && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {})
    })
    term.textarea && term.textarea.addEventListener('focus', () => this.hooks.onFocus && this.hooks.onFocus())
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      return !(this.hooks.onKey && this.hooks.onKey(e))
    })
    term.registerLinkProvider({
      provideLinks: (y, cb) => {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        const links = []
        for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g)) {
          links.push({
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            text: m[0],
            activate: (ev, url) => {
              if (app.settings.link_click === 'command' && !ev.ctrlKey) return
              if (app.settings.link_target === 'pager' && window.pager && window.pager.browser) window.pager.browser('open', url)
              else window.open(url, '_blank', 'noopener')
            },
          })
        }
        cb(links)
      },
    })
    this.ro = new ResizeObserver(() => this.scheduleFit())
    this.ro.observe(this.host)
    if (this.visible) this.#gl(true)

    const r = await app.d.attach(this.id)
    if (this.disposed) return
    this.#replay(r)
    this.attached = true
    if (this.queued) this.#flush()
    if (this.hooks.onReady) this.hooks.onReady()
  }

  #replay(r) {
    const { term } = this
    this.syncing = true
    if (r && r.cols && r.rows) term.resize(r.cols, r.rows)
    const bytes = r && r.replay ? toBytes(r.replay) : null
    const done = () => {
      this.syncing = false
      this.fitNow(true)
    }
    if (bytes && bytes.length) {
      this.#mark()
      term.write(bytes, done)
    } else done()
  }

  /** The daemon says we fell behind (or the pane restarted): start over from its replay. */
  resync(r) {
    if (!this.term) return
    this.queue = []
    this.queued = 0
    this.term.reset()
    this.#replay(r)
  }

  #mark() {
    if (this.firstByte) return
    this.firstByte = true
    performance.mark('pane-first-byte', { detail: { paneId: this.id } })
    if (!performance.getEntriesByName('pane-first-byte-any').length) performance.mark('pane-first-byte-any')
  }

  /** Daemon output. Chunks are joined and written once per animation frame. */
  write(data) {
    if (this.disposed || !this.starting) return // not shown yet: the daemon replay catches it up on attach
    const b = toBytes(data)
    this.queue.push(b)
    this.queued += b.length
    if (!this.attached) return
    if (this.queued > 4 << 20) return this.#flush() // never let a flood pile up unboundedly (also when rAF is paused)
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => this.#flush())
      this.timer = setTimeout(() => this.#flush(), 120)
    }
  }

  #flush() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.timer)
    this.raf = 0
    this.timer = 0
    if (!this.queue.length || !this.term) return
    this.#mark()
    let buf
    if (this.queue.length === 1) buf = this.queue[0]
    else {
      buf = new Uint8Array(this.queued)
      let o = 0
      for (const c of this.queue) {
        buf.set(c, o)
        o += c.length
      }
    }
    this.queue = []
    this.queued = 0
    this.term.write(buf)
  }

  #contrast() {
    const c = app.settings.contrast
    if (c === 'always') return 4.5
    if (c === 'off') return 1
    return document.documentElement.dataset.theme === 'light' ? 4.5 : 1
  }

  #gl(on) {
    if (!this.term) return
    if (on && !this.webgl && app.settings.renderer === 'webgl' && window.WebglAddon) {
      try {
        const gl = new WebglAddon.WebglAddon()
        gl.onContextLoss(() => {
          try { gl.dispose() } catch { /* already gone */ }
          if (this.webgl === gl) this.webgl = null
        })
        this.term.loadAddon(gl)
        this.webgl = gl
      } catch {
        this.webgl = null // DOM renderer stays
      }
    } else if (!on && this.webgl) {
      try { this.webgl.dispose() } catch { /* ignore */ }
      this.webgl = null
    }
  }

  setVisible(v) {
    if (this.visible === v) return
    this.visible = v
    if (v) {
      this.#gl(true)
      this.scheduleFit()
    }
  }

  scheduleFit() {
    if (this.fitRaf || this.disposed) return
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = 0
      this.fitNow()
    })
  }

  fitNow(force) {
    const { term, fit, host } = this
    if (!term || !fit || !host.offsetWidth || !host.offsetHeight) return
    const p = fit.proposeDimensions()
    if (!p || !p.cols || !p.rows || !isFinite(p.cols) || !isFinite(p.rows)) return
    if (p.cols !== term.cols || p.rows !== term.rows) term.resize(p.cols, p.rows)
    else if (force) app.d.resize(this.id, term.cols, term.rows)
  }

  /** Re-read settings/theme: fonts, cursor, colours, scroll feel. */
  applySettings() {
    const { term } = this
    if (!term) return
    const s = app.settings
    const o = term.options
    o.theme = terminalTheme()
    o.fontFamily = fontStack()
    o.fontSize = s.font_size || 13
    o.fontWeight = s.font_weight || 400
    o.lineHeight = s.line_height || 1.28
    o.cursorStyle = s.cursor && s.cursor.shape === 'bar' ? 'bar' : s.cursor && s.cursor.shape === 'underline' ? 'underline' : 'block'
    o.cursorBlink = !s.cursor || s.cursor.blink !== false
    o.scrollSensitivity = (s.scroll_speed || 100) / 100
    o.smoothScrollDuration = s.smooth_scroll === false ? 0 : 80
    o.minimumContrastRatio = this.#contrast()
    o.scrollback = Math.min(s.scrollback_lines || 10000, 20000)
    if (s.renderer === 'canvas') this.#gl(false)
    else if (this.visible) this.#gl(true)
    this.scheduleFit()
  }

  focus() {
    if (this.term) this.term.focus()
  }
  selection() {
    return this.term ? this.term.getSelection() : ''
  }
  paste(text) {
    if (this.term) this.term.paste(text)
  }
  clear() {
    if (this.term) this.term.clear()
  }

  dispose() {
    if (this.surface) this.surface.dispose()
    this.disposed = true
    cancelAnimationFrame(this.raf)
    cancelAnimationFrame(this.fitRaf)
    clearTimeout(this.timer)
    this.#gl(false)
    if (this.ro) this.ro.disconnect()
    if (this.term) this.term.dispose()
    this.term = null
  }
}
