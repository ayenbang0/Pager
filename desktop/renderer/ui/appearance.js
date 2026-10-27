// Appearance: turns settings (theme / layout / material / ...) into html classes and custom properties.
// - Pager's own palettes live in ui/tokens.css (pitch-black dark on :root, off-white light on html[data-theme="light"]).
// - An omp theme (ui/themes.js) is applied by adding class `tn-themed` and writing the same tokens inline on <html>
//   (mapping from the Tern spec, section 7). Reverting removes every inline property this module wrote.
import { app } from './store.js'
import { THEMES } from './themes.js'

export { THEMES }

const BY_ID = new Map(THEMES.map((t) => [t.id, t]))

// ---------------------------------------------------------------- colour maths (pure)
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
const rgbOf = (h) => {
  let s = String(h).replace('#', '')
  if (s.length === 3) s = [...s].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16))
}
const hexOf = (c) => '#' + c.map(hex2).join('')
const mix = (a, b, t) => {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return hexOf(x.map((v, i) => v * (1 - t) + y[i] * t))
}
const alpha = (h, a) => {
  const [r, g, b] = rgbOf(h)
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`
}
const luminance = (h) => {
  const [r, g, b] = rgbOf(h).map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a, b) {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/** Move `color` toward `toward` in 2 % steps until it reaches `min`:1 against `against` (simple luminance clamp). */
function nudge(color, against, min, toward) {
  if (contrastRatio(color, against) >= min) return color
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const c = mix(color, toward, t)
    if (contrastRatio(c, against) >= min) return c
  }
  return toward
}

// ---------------------------------------------------------------- omp theme -> tokens (pure)
/**
 * Map an omp theme (ui/themes.js entry) to Pager's custom properties. Returns { '--name': 'value' }.
 * @param theme   a THEMES entry
 * @param mode    'dark'|'light' used for the derivations; defaults to theme.mode
 * @param opts    { contrast: boolean } nudge --t3/--t4 to >= 4.5:1 against the card colour
 */
export function themeCssVars(theme, mode, opts = {}) {
  const dark = (mode || theme.mode) === 'dark'
  const { page, bg, fg, accent, ansi } = theme
  const ink = fg
  const out = {}

  // surfaces
  out['--page'] = page
  out['--panel'] = bg
  out['--card'] = bg
  out['--raise'] = dark ? mix(bg, ink, 0.07) : mix(bg, page, 0.55)
  out['--code-bg'] = dark ? mix(bg, '#000000', 0.28) : mix(bg, page, 0.3)
  out['--tbl-head'] = dark ? mix(bg, ink, 0.04) : mix(bg, page, 0.45)
  out['--fog'] = bg

  // ink ramps
  let t3 = mix(bg, ink, dark ? 0.52 : 0.62)
  let t4 = mix(bg, ink, 0.3)
  if (opts.contrast) {
    t3 = nudge(t3, bg, 4.5, ink)
    t4 = nudge(t4, bg, 4.5, ink)
    if (contrastRatio(t4, bg) > contrastRatio(t3, bg)) t3 = t4
  }
  out['--ink'] = ink
  out['--t1'] = ink
  out['--t2'] = mix(bg, ink, dark ? 0.7 : 0.75)
  out['--t3'] = t3
  out['--t4'] = t4
  out['--ink2'] = alpha(ink, 0.66)
  out['--ink3'] = alpha(ink, 0.44)
  out['--ink4'] = alpha(ink, 0.14)
  out['--l1'] = alpha(ink, 0.06)
  out['--l2'] = alpha(ink, 0.09)
  out['--l3'] = alpha(ink, 0.14)
  out['--l4'] = alpha(ink, 0.22)
  out['--chip-bg'] = alpha(ink, 0.055)
  out['--well'] = dark ? alpha(ink, 0.04) : 'rgba(255, 255, 255, .62)'
  out['--well-line'] = alpha(ink, 0.065)

  // accent
  const accentInk = nudge(dark ? mix(accent, '#ffffff', 0.35) : mix(accent, '#000000', 0.35), bg, 4.5, ink)
  const a1 = mix(accent, '#ffffff', 0.28)
  const a2 = mix(accent, '#000000', 0.12)
  out['--accent'] = accent
  out['--accent-ink'] = accentInk
  out['--accent-fill'] = nudge(accent, '#ffffff', 4.5, '#000000')
  out['--a1'] = a1
  out['--a2'] = a2
  out['--grad-ink'] = luminance(mix(a1, a2, 0.5)) > 0.35 ? '#05070b' : '#ffffff'
  out['--rail'] = accent

  // status colours (+ solid fills for white text)
  const ok = theme.ok || ansi[2]
  const warn = theme.warn || ansi[3]
  const bad = theme.bad || ansi[1]
  const live = theme.live || ansi[5]
  const fill = (c) => nudge(c, '#ffffff', 4.5, '#000000')
  out['--ok'] = ok
  out['--warn'] = warn
  out['--bad'] = bad
  out['--live'] = live
  out['--ok-fill'] = fill(ok)
  out['--bad-fill'] = fill(bad)
  out['--live-fill'] = fill(live)

  // glass, popovers, shadows
  out['--pop-bg'] = alpha(theme.pop || bg, dark ? 0.98 : 0.84)
  out['--topbar-bg'] = alpha(page, dark ? 0.56 : 0.72)
  out['--sheet-a'] = dark ? 'var(--card)' : alpha(bg, 0.82)
  out['--sheet-b'] = dark ? 'var(--card)' : alpha(mix(bg, page, 0.4), 0.7)
  out['--glass-hi'] = dark ? alpha(ink, 0.05) : '#ffffff'
  out['--dim'] = dark ? 'rgba(0, 0, 0, .55)' : alpha(page, 0.5)
  out['--sheet-drop'] = dark
    ? '0 1px 2px rgba(0, 0, 0, .5), 0 16px 40px -18px rgba(0, 0, 0, .7)'
    : `0 1px 2px ${alpha(ink, 0.05)}, 0 26px 60px -26px ${alpha(ink, 0.26)}, 0 70px 120px -50px ${alpha(ink, 0.2)}`
  // Backdrop washes behind the cards: accent (blue in dark-github) top-left, green bottom.
  out['--glow-a'] = alpha(accent, dark ? 0.12 : 0.16)
  out['--glow-b'] = alpha(ansi[2], dark ? 0.09 : 0.12)

  // terminal
  out['--tv-bg'] = bg
  out['--tv-fg'] = fg
  out['--tv-cur'] = fg
  out['--tv-cur-ink'] = bg
  out['--tv-sel'] = alpha(accent, dark ? 0.32 : 0.22)
  for (let i = 0; i < 16; i++) out[`--ansi${i}`] = ansi[i]
  return out
}

// ---------------------------------------------------------------- runtime
const root = () => document.documentElement
const PREFIXES = ['lay-', 'dense-', 'tabs-', 'tn-heads-', 'mat-']

let inited = false
let preview // undefined = not previewing; string = hovered theme id
let mqDark = null
let mqMotion = null
let mqTransp = null
let retintTimer = 0
let written = new Set() // inline custom properties currently set on <html>
let effective = 'dark'

const KEYS = new Set(['theme', 'theme_dark', 'theme_light', 'layout', 'density', 'tabs', 'pane_headers', 'status_bar', 'material', 'opacity', 'ui_font_size', 'reduce_motion', 'contrast'])

/** The window scheme the settings ask for ('system' resolved through prefers-color-scheme). Ignores hover previews. */
export function resolvedMode() {
  const t = app.settings.theme
  if (t === 'light' || t === 'dark') return t
  return mqDark ? (mqDark.matches ? 'dark' : 'light') : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** What is actually on screen: the active omp theme's own mode, else the resolved scheme. */
export const effectiveMode = () => effective

/** Persisted omp theme id for the current scheme, or null for Pager's built-in palette. Ignores hover previews. */
export function currentThemeId() {
  const id = app.settings[resolvedMode() === 'dark' ? 'theme_dark' : 'theme_light']
  return id && BY_ID.has(id) ? id : null
}

function setVars(map) {
  const style = root().style
  for (const name of written) if (!(name in map)) style.removeProperty(name)
  for (const name in map) style.setProperty(name, map[name])
  written = new Set(Object.keys(map))
}

function setClasses(s) {
  const cl = root().classList
  for (const c of Array.from(cl)) if (PREFIXES.some((p) => c.startsWith(p))) cl.remove(c)
  cl.add('lay-' + (s.layout || 'tiles'))
  cl.add('dense-' + (s.density || 'compact'))
  cl.add(s.tabs === 'vertical' || s.tabs === 'v' ? 'tabs-v' : 'tabs-h')
  cl.add('tn-heads-' + (s.pane_headers || 'never'))
  cl.add('mat-' + (s.material || 'glass'))
  cl.toggle('tn-status', !!s.status_bar)
  const rm = s.reduce_motion === 'on' || (s.reduce_motion !== 'off' && !!mqMotion && mqMotion.matches)
  cl.toggle('reduce-motion', rm)
}

function apply() {
  const s = app.settings
  const mode = resolvedMode()
  const id = preview === 'default' ? null : preview !== undefined ? preview : currentThemeId()
  const theme = id ? BY_ID.get(id) : null
  const el = root()

  setClasses(s)

  let vars = {}
  if (theme) {
    effective = theme.mode
    const contrast = s.contrast === 'always' || (s.contrast !== 'off' && theme.mode === 'light')
    vars = themeCssVars(theme, theme.mode, { contrast })
  } else {
    effective = mode
  }
  el.dataset.theme = effective
  el.classList.toggle('tn-themed', !!theme)

  const reduceTransp = !!mqTransp && mqTransp.matches
  vars['--tint'] = String(s.material === 'solid' || reduceTransp ? 1 : clamp((Number(s.opacity) || 80) / 100, 0.2, 1))
  const ui = Number(s.ui_font_size)
  vars['--ui-size'] = ui > 0 ? `${ui}px` : '13.5px'
  vars['--tn-zoom'] = String(ui > 0 ? +clamp(ui / 13, 0.7, 2).toFixed(3) : 1)
  setVars(vars)
  app.emit('theme')
}

function retint() {
  const cl = root().classList
  cl.add('tn-retint')
  clearTimeout(retintTimer)
  retintTimer = setTimeout(() => cl.remove('tn-retint'), 450)
}

/** Recompute everything from app.settings. */
export function applyAppearance() {
  apply()
}

/** Hover preview of an omp theme on the whole window (not persisted). 'default' previews Pager's built-in palette; null/falsy/unknown ids revert to the persisted look. */
export function previewTheme(id) {
  const next = id === 'default' ? 'default' : id && BY_ID.has(id) ? id : undefined
  if (next === preview) return
  retint()
  preview = next
  apply()
}

/** Keep a theme: stores it for its own scheme and switches to that scheme unless 'system' already matches the OS. */
export function pickTheme(id) {
  preview = undefined
  const theme = id ? BY_ID.get(id) : null
  if (id && !theme) return
  const mode = theme ? theme.mode : resolvedMode()
  const patch = { [mode === 'dark' ? 'theme_dark' : 'theme_light']: id || null }
  const osMode = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  if (app.settings.theme !== mode && !(app.settings.theme === 'system' && osMode === mode)) patch.theme = mode
  retint()
  app.set(patch)
  // app.set emitted 'settings', which re-applied
}

/** Wire media queries and the settings subscription, then apply once. Safe to call repeatedly. */
export function initAppearance() {
  if (inited) {
    apply()
    return
  }
  inited = true
  mqDark = matchMedia('(prefers-color-scheme: dark)')
  mqMotion = matchMedia('(prefers-reduced-motion: reduce)')
  mqTransp = matchMedia('(prefers-reduced-transparency: reduce)')
  const again = () => apply()
  for (const mq of [mqDark, mqMotion, mqTransp]) mq.addEventListener('change', again)
  app.on('settings', (patch) => {
    for (const k in patch) {
      if (KEYS.has(k)) {
        apply()
        return
      }
    }
  })
  apply()
}
