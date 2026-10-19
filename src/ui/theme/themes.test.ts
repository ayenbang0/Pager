import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast, parseColor, toRgb } from './colors.js'
import { DEFAULT_THEME, degradeTheme, findTheme, PILL_KINDS, resolveTheme, THEMES, withAccent, type Theme } from './themes.js'

const COLOR_TOKENS = ['accent', 'accent2', 'glow', 'border', 'dim', 'text', 'surface', 'success', 'warning', 'error', 'info', 'online', 'badge', 'mine', 'userBubble'] as const

test('theme names are unique and the default is the vivid omp theme', () => {
  const names = THEMES.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  assert.equal(DEFAULT_THEME.name, 'omp')
  for (const wanted of ['omp', 'terminal', 'mono', 'ocean', 'amber', 'light', 'neon', 'sunset', 'aurora']) assert.ok(names.includes(wanted), wanted)
})

test('findTheme matches exactly, ignoring case and padding', () => {
  assert.equal(findTheme(' NEON ')?.name, 'neon')
  assert.equal(findTheme('neo'), undefined)
  assert.equal(findTheme(''), undefined)
  assert.equal(findTheme('constructor'), undefined)
})

test('every theme defines every token with a usable color', () => {
  for (const t of THEMES) {
    assert.ok(t.description.length > 0, t.name)
    for (const token of COLOR_TOKENS) assert.notEqual(toRgb(t[token]), undefined, `${t.name}.${token} = ${t[token]}`)
    assert.ok(t.authors.length >= 2, `${t.name}.authors`)
    for (const a of t.authors) assert.notEqual(toRgb(a), undefined, `${t.name} author ${a}`)
    assert.ok(t.gradient.length >= 2 && t.gradient.length <= 4, `${t.name}.gradient`)
    for (const g of t.gradient) assert.notEqual(toRgb(g), undefined, `${t.name} gradient ${g}`)
    for (const p of [t.band, ...PILL_KINDS.map((k) => t.pill[k])]) {
      assert.notEqual(toRgb(p.fg), undefined, `${t.name} pill fg ${p.fg}`)
      assert.notEqual(toRgb(p.bg), undefined, `${t.name} pill bg ${p.bg}`)
    }
    assert.deepEqual(Object.keys(t.pill).sort(), [...PILL_KINDS].sort(), t.name)
  }
})

test('every pill and band reads: text on its fill has a contrast ratio of at least 4.5', () => {
  for (const t of THEMES) {
    for (const [label, p] of [['band', t.band], ...PILL_KINDS.map((k) => [`pill.${k}`, t.pill[k]] as const)] as const) {
      assert.ok(contrast(p.fg, p.bg) >= 4.5, `${t.name} ${label}: ${p.fg} on ${p.bg} = ${contrast(p.fg, p.bg).toFixed(2)}`)
    }
  }
})

test('body text and secondary text read on the theme surface', () => {
  for (const t of THEMES.filter((x) => x.name !== 'mono' && x.name !== 'terminal')) {
    assert.ok(contrast(t.text, t.surface) >= 7, `${t.name} text`)
    assert.ok(contrast(t.dim, t.surface) >= 3.5, `${t.name} dim`)
  }
})

test('the bright themes are saturated truecolor, not ANSI names', () => {
  for (const name of ['omp', 'neon', 'sunset', 'aurora']) {
    const t = findTheme(name) as Theme
    assert.match(t.accent, /^#[0-9a-f]{6}$/, name)
    assert.match(t.accent2, /^#[0-9a-f]{6}$/, name)
    assert.ok(t.gradient.every((g) => g.startsWith('#')), name)
  }
})

test('withAccent recolors the accent everywhere it shows and keeps the rest', () => {
  const t = withAccent(DEFAULT_THEME, '#ff00aa')
  assert.equal(t.accent, '#ff00aa')
  assert.equal(t.mine, '#ff00aa')
  assert.equal(t.userBubble, '#ff00aa')
  assert.equal(t.band.bg, '#ff00aa')
  assert.equal(t.pill.accent.bg, '#ff00aa')
  assert.equal(t.gradient[0], '#ff00aa')
  assert.equal(t.gradient[1], DEFAULT_THEME.accent2)
  assert.notEqual(t.glow, DEFAULT_THEME.glow)
  assert.ok(contrast(t.band.fg, t.band.bg) >= 4.5)
  assert.ok(contrast(t.pill.accent.fg, t.pill.accent.bg) >= 4.5)
  assert.equal(t.success, DEFAULT_THEME.success)
  assert.equal(t.pill.success.bg, DEFAULT_THEME.pill.success.bg)
  assert.notEqual(DEFAULT_THEME.accent, '#ff00aa', 'the source theme is untouched')
  for (const accent of ['cyan', '#000000', '#ffffff', '#ffff00']) assert.ok(contrast(withAccent(DEFAULT_THEME, accent).band.fg, accent) >= 4.5, accent)
})

test('degradeTheme snaps every color to the 16 ANSI names and keeps pills readable', () => {
  const ansi = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright'])
  for (const t of THEMES) {
    const d = degradeTheme(t)
    for (const token of COLOR_TOKENS) assert.ok(ansi.has(d[token]), `${t.name}.${token} = ${d[token]}`)
    for (const g of d.gradient) assert.ok(ansi.has(g), `${t.name} gradient ${g}`)
    for (const p of [d.band, ...PILL_KINDS.map((k) => d.pill[k])]) assert.ok(ansi.has(p.fg) && ansi.has(p.bg), `${t.name} ${p.fg}/${p.bg}`)
    for (const k of PILL_KINDS.filter((x) => x !== 'muted')) assert.ok(contrast(d.pill[k].fg, d.pill[k].bg) >= 4.5, `${t.name} pill.${k}`)
    assert.equal(d.name, t.name)
  }
})

test('resolveTheme: unknown names fall back, an accent applies, shallow terminals degrade, deep ones keep hex', () => {
  assert.equal(resolveTheme('nope', undefined, 24).name, 'omp')
  assert.equal(resolveTheme('neon', undefined, 24).accent, findTheme('neon')?.accent)
  assert.equal(resolveTheme('neon', '#123456', 24).accent, '#123456')
  assert.equal(resolveTheme('neon', undefined, 8).accent, findTheme('neon')?.accent, '256-color terminals keep hex; Ink down-samples it')
  assert.notEqual(resolveTheme('neon', undefined, 4).accent.startsWith('#'), true)
  assert.notEqual(resolveTheme('neon', parseColor('orange'), 4).accent.startsWith('#'), true)
  assert.notEqual(resolveTheme('neon', undefined, 1).accent.startsWith('#'), true)
})
