'use strict'
const FONT = '"Pager Pixel","Cascadia Mono","Cascadia Code",Consolas,"Segoe UI Symbol",monospace'
const ANSI = {
  black: '#000000', red: '#ff6b81', green: '#7fe3a1', yellow: '#ffd479', blue: '#6aa8ff', magenta: '#c792ea', cyan: '#5fe0ff', white: '#cfd8e6',
  brightBlack: '#3a4658', brightRed: '#ff8fa1', brightGreen: '#a4f0bf', brightYellow: '#ffe4a3', brightBlue: '#92c0ff', brightMagenta: '#dbb4f5', brightCyan: '#8aeaff', brightWhite: '#ffffff',
}

const term = new Terminal({
  fontFamily: FONT,
  fontSize: 14,
  lineHeight: 1,
  allowTransparency: true,
  customGlyphs: true, // box and block characters drawn as exact vectors, not font outlines
  cursorStyle: 'block',
  cursorBlink: false,
  scrollback: 1000,
  windowsPty: { backend: 'conpty' },
  theme: { background: '#00000000', foreground: '#e6edf7', cursor: '#7fe9ff', selectionBackground: '#2b4a6f', ...ANSI },
})
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('term'))
try {
  const gl = new WebglAddon.WebglAddon()
  gl.onContextLoss(() => gl.dispose()) // falls back to the DOM renderer
  term.loadAddon(gl)
} catch {
  // no WebGL: the DOM renderer stays
}

window.pager.onData((s) => term.write(s))
window.pager.onExit((code) => term.write(`\r\n\x1b[31mpager exited (code ${code}), press any key\x1b[0m`))
window.pager.onConfig((c) => {
  document.documentElement.style.setProperty('--tint', String(c.material === 'solid' ? 1 : c.opacity / 100))
  const size = c.fontSize
  if (term.options.fontSize !== size) {
    term.options.fontSize = size
    fit.fit()
  }
})
term.onData((s) => window.pager.input(s))
term.onResize(({ cols, rows }) => window.pager.resize(cols, rows))
term.onTitleChange((t) => window.pager.title(t))

document.getElementById('docs').addEventListener('click', () => window.pager.hotkey('docs'))
document.getElementById('studio').addEventListener('click', () => window.pager.hotkey('studio'))

const HOTKEYS = {
  F1: () => window.pager.hotkey('docs'),
  F2: () => window.pager.hotkey('studio'),
  'Ctrl+Shift+M': () => window.pager.hotkey('material'),
  'Ctrl+Shift+ArrowUp': () => window.pager.hotkey('opacity+'),
  'Ctrl+Shift+ArrowDown': () => window.pager.hotkey('opacity-'),
  'Ctrl+=': () => window.pager.hotkey('font+'),
  'Ctrl+Shift++': () => window.pager.hotkey('font+'),
  'Ctrl+-': () => window.pager.hotkey('font-'),
  'Ctrl+0': () => window.pager.hotkey('font0'),
  'Ctrl+Shift+C': () => {
    const s = term.getSelection()
    if (s) navigator.clipboard.writeText(s)
  },
  'Ctrl+Shift+V': () => navigator.clipboard.readText().then((t) => term.paste(t)),
}
// Everything not listed, including Ctrl+C, Ctrl+V and every Alt chord, goes to Pager.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true
  const name = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`
  const hit = HOTKEYS[e.altKey ? '' : name]
  if (hit === undefined) return true
  hit()
  return false
})

// Fit only once the pixel font is measured, and again a frame later: columns measured with a fallback font overflow the window.
let frame = 0
new ResizeObserver(() => {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => fit.fit())
}).observe(document.getElementById('term'))
document.fonts.load('15px "Pager Pixel"', '\u2588').finally(() => {
  fit.fit()
  requestAnimationFrame(() => {
    fit.fit()
    window.pager.ready(term.cols, term.rows)
  })
})
