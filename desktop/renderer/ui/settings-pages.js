// Settings pages: every page is data (eyebrow, title, blurb) plus a build() that returns section elements made from the
// control kit (controls.js). Controls are bound to settings once at build time and updated in place (`refreshBound`), so
// typing never re-renders a page and inputs keep focus. settings.js owns the sheet, tab strip and search.

import { h, uid } from './dom.js'
import { app, DEFAULT_SETTINGS } from './store.js'
import { icon } from './icons.js'
import { toast } from './toast.js'
import { confirmDialog } from './dialog.js'
import { allCommands, chordFromEvent, commandForChord } from './commands.js'
import { THEMES, previewTheme, pickTheme, currentThemeId, resolvedMode } from './appearance.js'
import { toggle, segmented, select, field, stepper, slider, button, iconButton, row, section, keycaps } from './controls.js'

/* ------------------------------------------------------------------ settings access */

const EXTRA = { auto_acp: false, keymap_prefix: 'Ctrl+B', blur: 56 }
const DEF = { ...DEFAULT_SETTINGS, ...EXTRA }
// Nested groups are always written back as whole merged objects.
const NESTED = {
  cursor: { shape: null, blink: true, programs: false },
  files: { markdown_rendered: true, wrap_code: false, wrap_prose: true, line_numbers: true, tab_width: 4, auto_save: 'off' },
  file_tree: { width: 260, hidden: false, ignored: false, compact: true, reveal: true },
  git: { auto_fetch_minutes: 5, pull_mode: 'merge', sign: false, external_editor: '', diff_layout: 'inline', name: '', email: '' },
  database: { page_size: 200, confirm_destructive: true },
  notebook: { python: '', autostart: false },
}

const get = (key) => {
  const i = key.indexOf('.')
  if (i < 0) return app.settings[key] ?? DEF[key]
  const a = key.slice(0, i)
  const b = key.slice(i + 1)
  return (app.settings[a] || {})[b] ?? NESTED[a]?.[b]
}
const put = (key, value) => {
  const i = key.indexOf('.')
  if (i < 0) return app.set({ [key]: value })
  const a = key.slice(0, i)
  return app.set({ [a]: { ...NESTED[a], ...(app.settings[a] || {}), [key.slice(i + 1)]: value } })
}

/* ------------------------------------------------------------------ binding helpers */

const bound = [] // () => void: pull the current setting into a control
const live = [] // () => void: repaint from daemon state

export const refreshBound = () => bound.forEach((f) => f())
export const refreshLive = () => live.forEach((f) => f())

const same = (v) => v
const bind = (ctl, key, from = same) => {
  bound.push(() => ctl.setValue(from(get(key))))
  return ctl
}

const tog = (key, label) => bind(toggle({ value: !!get(key), label, onChange: (v) => put(key, v) }), key, Boolean)
const seg = (key, options, o = {}) => {
  const from = o.from || same
  const to = o.to || same
  return bind(segmented({ options, value: from(get(key)), label: o.label, sm: o.sm, onChange: (v) => put(key, to(v)) }), key, from)
}
const sel = (key, options, o = {}) => bind(select({ options, value: get(key), label: o.label, minWidth: o.minWidth, onChange: (v) => put(key, v) }), key)
const num = (key, o = {}) => {
  const from = o.from || same
  return bind(stepper({ min: o.min, max: o.max, step: o.step, unit: o.unit, label: o.label, value: from(get(key)), onChange: (v) => (o.write ? o.write(v) : put(key, v)) }), key, from)
}
const sld = (key, o) => bind(slider({ ...o, value: get(key), onChange: (v) => put(key, v) }), key)
const fld = (key, o = {}) => bind(field({ value: get(key) ?? '', placeholder: o.placeholder, mono: o.mono, live: o.live, label: o.label, onChange: (v) => put(key, v) }), key, (v) => v ?? '')

/** A searchable settings row; `data-q` is what the search box matches (title + description). */
function R(title, desc, control, o = {}) {
  const el = row({ title, desc, control, block: o.block })
  el.dataset.q = `${title} ${desc || ''} ${o.kw || ''}`.toLowerCase()
  if (o.off) {
    const paint = () => el.classList.toggle('dim', !get(o.off))
    bound.push(paint)
    paint()
  }
  return el
}

/** A row that owns its whole width (editors, grids with their own header). */
function bare(q, ...children) {
  const el = h('div', { class: 'pf-row bare' }, ...children)
  el.dataset.q = q.toLowerCase()
  return el
}

/* ------------------------------------------------------------------ transient state (capture, hover preview) */

let cap = null // { end(), commit(chord), clear() }
let hoverTimer = 0

export function stopTransient() {
  cap?.end()
  clearTimeout(hoverTimer)
  hoverTimer = 0
  previewTheme(null)
}

// Registered at module load so it runs before the app-wide chord handler (also window + capture).
window.addEventListener(
  'keydown',
  (e) => {
    if (!cap) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.key === 'Escape') return cap.end()
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return cap.clear()
    const chord = chordFromEvent(e)
    if (chord) cap.commit(chord)
  },
  true,
)
document.addEventListener(
  'pointerdown',
  (e) => {
    if (cap && !(e.target instanceof Element && e.target.closest('.kb-bind.cap'))) cap.end()
  },
  true,
)

/* ------------------------------------------------------------------ 01 General */

function general() {
  return [
    section('Shell', [R('Shell', 'What new blocks on this PC run, as a login shell. Empty runs your login shell.', fld('shell', { mono: true, placeholder: 'Default login shell', live: true, label: 'Shell' }), { block: true })]),
    section('Tabs and splits', [
      R('New tabs start in', 'Splits always start in the directory of the block they split.', seg('new_tabs_start', [{ value: 'current', label: 'Current directory' }, { value: 'home', label: 'Home' }], { label: 'New tabs start in' }), { block: true }),
    ]),
    section('Selection', [R('Copy on select', 'Finishing a selection puts it on the clipboard.', tog('copy_on_select', 'Copy on select'))]),
    section('Links', [
      R('Open links with', 'Links in terminal output and program output.', seg('link_click', [{ value: 'click', label: 'Click' }, { value: 'command', label: 'Ctrl+Click' }], { label: 'Open links with' })),
      R('Open links in', 'The browser pane inside Pager, or your system browser.', seg('link_target', [{ value: 'pager', label: 'Pager' }, { value: 'browser', label: 'System browser' }], { label: 'Open links in' })),
    ]),
    section('Closing', [R('Confirm before closing', 'Ask before a tab, pane or the window goes away.', sel('confirm_close', [{ value: 'never', label: 'Never' }, { value: 'running', label: 'When something is running' }, { value: 'always', label: 'Always' }], { label: 'Confirm before closing', minWidth: 180 }))]),
  ]
}

/* ------------------------------------------------------------------ 02 Agents */

/** Editor for a list of {id, name, <second>} entries stored in a setting (hosts). */
function listEditor({ key, q, title, desc, second, secondPlaceholder, nameLabel, empty, addLabel, mk }) {
  const list = h('div', { class: 'ed-list' })
  const items = () => (Array.isArray(app.settings[key]) ? app.settings[key] : [])
  const write = (next) => app.set({ [key]: next })
  const edit = (id, patch) => write(items().map((x) => (x.id === id ? { ...x, ...patch } : x)))
  let sig = null
  const render = () => {
    sig = items().map((x) => x.id).join('|')
    list.replaceChildren(
      ...(items().length
        ? items().map((it) =>
            h(
              'div',
              { class: 'ed-item' },
              field({ value: it.name, sm: true, label: nameLabel, onChange: (v) => edit(it.id, { name: v.trim() || it.name }) }),
              (() => {
                const f = field({ value: it[second] || '', sm: true, mono: true, label: secondPlaceholder, placeholder: secondPlaceholder, onChange: (v) => edit(it.id, { [second]: v.trim() }) })
                f.classList.add('wide')
                return f
              })(),
              iconButton({ icon: 'trash', title: 'Remove', kind: 'danger', onClick: () => write(items().filter((x) => x.id !== it.id)) }),
            ),
          )
        : [h('div', { class: 'ed-empty' }, empty)]),
    )
  }
  bound.push(() => {
    if (items().map((x) => x.id).join('|') !== sig) render()
  })
  const nameIn = field({ sm: true, placeholder: nameLabel, label: nameLabel })
  const valIn = field({ sm: true, mono: true, placeholder: secondPlaceholder, label: secondPlaceholder })
  const add = () => {
    const name = nameIn.input.value.trim()
    const val = valIn.input.value.trim()
    if (!name || !val) {
      toast('warn', `Give it a name and ${secondPlaceholder.toLowerCase()}.`)
      return
    }
    write([...items(), mk({ id: uid(key === 'hosts' ? 'h' : 'a'), name, [second]: val })])
    nameIn.setValue('')
    valIn.setValue('')
    nameIn.input.focus()
  }
  for (const f of [nameIn, valIn]) f.input.addEventListener('keydown', (e) => e.key === 'Enter' && add())
  render()
  return bare(q, row({ title, desc }), list, h('div', { class: 'ed-form' }, nameIn, valIn, button({ label: addLabel, icon: 'plus', small: true, onClick: add })))
}

function agents() {
  return [
    section('ACP chats', [R('Open agent commands as ACP chats', "Typing claude, codex or copilot in a new shell opens it in Pager's chat over ACP. `command claude` runs its own interface.", tog('auto_acp', 'Open agent commands as ACP chats'))]),
  ]
}

/* ------------------------------------------------------------------ 03 Appearance */

let themeFilter = 'all'

const LAYOUTS = [
  { id: 'rail', name: 'Rail', desc: 'Arc: two-line tabs down the left edge, no top bar.' },
  { id: 'float', name: 'Float', desc: 'Zen: the terminal fills the window; a glass pill holds the tabs and fades while you type.' },
  { id: 'tiles', name: 'Tiles', desc: 'Tiling: every pane its own card on the glass: the default.' },
  { id: 'studio', name: 'Studio', desc: 'Tabs as pills inside a 38px titlebar, every pane headed, the whole window one tinted surface.' },
]

const DEFAULT_LOOK = {
  dark: { page: '#000000', accent: '#5a8cff', dots: ['#ff6166', '#f5b13d', '#3ecf8e', '#35c7e6', '#5b8dff', '#b98cff', '#5a8cff'] },
  light: { page: '#efefec', accent: '#4a6d6e', dots: ['#b63337', '#8b5800', '#18714a', '#0d6d7e', '#2c59d3', '#7b46c0', '#4a6d6e'] },
}

function themeSection() {
  const grid = h('div', { class: 'th-grid' })
  const count = h('div', { class: 'pf-d' })
  const cards = []

  const preview = (id) => {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => previewTheme(id), 40)
  }
  const leave = () => {
    clearTimeout(hoverTimer)
    hoverTimer = 0
    previewTheme(null)
  }

  const card = (id, name, look, mode) => {
    const well = h('div', { class: 'th-well', style: { background: look.page } }, h('span', { class: 'th-aa', style: { color: look.accent } }, 'Aa'), h('span', { class: 'th-dots' }, look.dots.map((c) => h('i', { style: { background: c } }))))
    const nameEl = h('span', null, name)
    const b = h('button', { class: 'th', type: 'button', dataset: { id: id || 'default', mode }, attrs: { 'aria-label': name, 'aria-pressed': 'false' } }, well, h('div', { class: 'th-n' }, nameEl, icon('check', 12)))
    b.addEventListener('mouseenter', () => preview(id || 'default'))
    b.addEventListener('focus', () => preview(id || 'default'))
    b.addEventListener('click', () => {
      clearTimeout(hoverTimer)
      pickTheme(id)
    })
    cards.push({ el: b, id, mode, well, nameEl })
    return b
  }

  const dflt = card(null, 'Pager default', DEFAULT_LOOK.dark, 'default')
  grid.append(dflt, ...THEMES.map((t) => card(t.id, t.name, t, t.mode)))
  grid.addEventListener('mouseleave', leave)
  grid.addEventListener('focusout', (e) => {
    if (!grid.contains(e.relatedTarget)) leave()
  })

  const applyFilter = () => {
    let n = 0
    for (const c of cards) {
      const show = c.mode === 'default' || themeFilter === 'all' || c.mode === themeFilter
      c.el.hidden = !show
      if (show && c.mode !== 'default') n++
    }
    count.textContent = `${n} theme${n === 1 ? '' : 's'}`
  }
  const paint = () => {
    const cur = currentThemeId()
    const look = DEFAULT_LOOK[resolvedMode()]
    cards[0].well.style.background = look.page
    cards[0].well.firstChild.style.color = look.accent
    cards[0].well.lastChild.replaceChildren(...look.dots.map((c) => h('i', { style: { background: c } })))
    for (const c of cards) {
      const on = c.mode === 'default' ? cur === null : c.id === cur
      c.el.classList.toggle('on', on)
      c.el.setAttribute('aria-pressed', String(on))
    }
    omp.classList.toggle('on', get('theme_dark') === 'titanium' && get('theme_light') === 'light')
  }

  const scroll = h('div', { class: 'th-scroll' }, grid)
  const filter = segmented({
    options: [{ value: 'all', label: 'All' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
    value: themeFilter,
    sm: true,
    label: 'Theme brightness',
    onChange: (v) => {
      themeFilter = v
      applyFilter()
      scroll.scrollTop = 0
    },
  })
  const omp = h(
    'button',
    { class: 'th-omp', type: 'button', onClick: () => app.set({ theme_dark: 'titanium', theme_light: 'light' }) },
    h('div', { class: 'pf-t' }, 'Following omp'),
    h('div', { class: 'pf-d' }, "The themes omp shows: titanium when dark, light when light. From omp's default profile (~/.omp/agent)."),
    icon('check', 14, 'ico-ck'),
  )
  const body = h('div', { class: 'pf-card th-card' }, h('div', { class: 'th-bar' }, filter, count), scroll, h('div', { class: 'th-sep' }), omp)
  body.dataset.q = 'theme themes hover preview keep dark light following omp titanium default'
  bound.push(() => {
    filter.setValue(themeFilter)
    paint()
  })
  applyFilter()
  paint()
  return h('section', { class: 'pf-sec' }, h('h3', { class: 'pf-sec-h' }, 'Theme'), body)
}

function layoutCards() {
  const grid = h('div', { class: 'card-grid', attrs: { role: 'radiogroup', 'aria-label': 'Layout' } })
  for (const l of LAYOUTS) {
    const b = h('button', { class: 'cg', type: 'button', attrs: { role: 'radio', 'aria-checked': 'false' }, onClick: () => put('layout', l.id) }, h('div', { class: 'cg-h' }, icon(`layout-${l.id}`, 18), l.name), h('div', { class: 'cg-d' }, l.desc))
    const paint = () => {
      const on = get('layout') === l.id
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    }
    bound.push(paint)
    paint()
    grid.append(b)
  }
  return grid
}

function appearance() {
  return [
    themeSection(),
    section('Appearance', [
      R('Appearance', 'Light, dark, or following the system.', seg('theme', [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], { label: 'Appearance' }), { kw: 'theme mode scheme' }),
      R('Layout', 'The interface style around the terminals.', layoutCards(), { block: true, kw: 'rail float tiles studio interface style' }),
    ]),
    section('Tabs and panes', [
      R('Tabs', 'Across the top, or down the left edge.', seg('tabs', [{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }], { label: 'Tabs' })),
      R('Auto-hide tabs', 'Vertical tabs slide away until the pointer reaches the edge.', tog('tabs_autohide', 'Auto-hide tabs')),
      R('Pane headers', 'A title strip above each pane.', seg('pane_headers', [{ value: 'never', label: 'Never' }, { value: 'split', label: 'Split' }, { value: 'always', label: 'Always' }], { label: 'Pane headers' })),
      R('Status bar', 'Working directory, git, last command and size along the bottom.', tog('status_bar', 'Status bar')),
    ]),
    section('Window', [
      R('Material', 'How much of the desktop shows through the window.', seg('material', [{ value: 'glass', label: 'Glass' }, { value: 'clear', label: 'Clear' }, { value: 'solid', label: 'Solid' }], { label: 'Material' })),
      R('Opacity', 'How much of the window background covers the desktop.', sld('opacity', { min: 20, max: 100, step: 1, unit: '%', label: 'Opacity' })),
      R('Blur', 'How strongly the desktop behind the window is blurred.', sld('blur', { min: 0, max: 100, step: 1, label: 'Blur' })),
      R('Density', 'Compact packs panes edge to edge; Islands floats each one.', seg('density', [{ value: 'compact', label: 'Compact' }, { value: 'islands', label: 'Islands' }], { label: 'Density' })),
    ]),
    section('Interface', [
      R('UI size', 'The size of the interface text; terminals have their own font size.', num('ui_font_size', { min: 11, max: 18, step: 0.5, unit: 'px', label: 'UI size', from: (v) => Number(v) || 13.5 })),
      R('Reduce motion', 'Cut animation. System follows the OS setting.', seg('reduce_motion', [{ value: 'system', label: 'System' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], { label: 'Reduce motion' })),
      R('Contrast correction', 'Nudges low-contrast text colours until they read clearly (WCAG AA).', seg('contrast', [{ value: 'light', label: 'Light themes' }, { value: 'always', label: 'Always' }, { value: 'off', label: 'Off' }], { label: 'Contrast correction' }), { block: true }),
    ]),
  ]
}

/* ------------------------------------------------------------------ 04 Terminal + prompt styles */

const A = (n) => `var(--ansi${n})`
const pt = (text, color) => h('span', { class: 'pp-t', style: color ? { color } : null }, text)
const pi = (name, color) => h('span', { class: 'pp', style: color ? { color } : null }, icon(name, 11))
const sp = () => h('span', { class: 'pp-sp' })
const hex = (color) => h('span', { class: 'pp-hex', style: { background: color } })
const chip = (...c) => h('span', { class: 'pp-chip' }, ...c)

/** Powerline-style blocks: each block is {c: nodes, bg, fg}; arrows are CSS triangles, not font glyphs. */
function blocks(list) {
  const out = []
  list.forEach((b, i) => {
    out.push(h('span', { class: 'pp-blk', style: { background: b.bg, color: b.fg } }, ...b.c))
    out.push(h('span', { class: 'pp-arr', style: { background: list[i + 1] ? list[i + 1].bg : 'transparent', '--from': b.bg } }, h('i')))
  })
  return out
}
const ink = '#14161b'

const PROMPTS = [
  { id: 'tern', name: 'Tern', make: () => [chip(pi('folder', A(8)), pt('~/stencil/termview', 'var(--t2)')), chip(pi('branch', A(8)), pt('main'), pi('arrow-up', A(6)), pt('2', A(6)), pt(' !2', A(3)), pt(' ?1', A(5))), sp(), pt('10:42', A(8))] },
  { id: 'lean', name: 'Lean', make: () => [pt('~/work/stencil/crates/termview', A(4)), pt('  main ', A(8)), pi('arrow-up', A(6)), pt('2 ', A(6)), pt('!2 ', A(3)), pt('?1', A(5)), sp(), pt('10:42:31', A(8))] },
  { id: 'classic', name: 'Classic', make: () => [pt('welov@pager', A(2)), pt(' ~/stencil ', A(4)), pt('$')] },
  { id: 'rainbow', name: 'Rainbow', make: () => [...blocks([{ c: [pt('~/stencil/termview')], bg: A(4), fg: ink }, { c: [pi('branch'), pt('main')], bg: A(2), fg: ink }, { c: [pt('⇡2 !2 ?1')], bg: A(3), fg: ink }]), sp(), ...blocks([{ c: [pt('10:42')], bg: A(5), fg: ink }])] },
  { id: 'pure', name: 'Pure', make: () => [pt('~/stencil/termview ', A(4)), pt('main*', A(8)), pi('arrow-up', A(6)), pt('  2s', A(3)), sp(), pi('chev-right', A(5))] },
  { id: 'starship', name: 'Starship', make: () => [pt('stencil/crates/termview', A(6)), pt(' on ', A(8)), pi('branch', A(5)), pt('main ', A(5)), pt('[!?', A(1)), pi('arrow-up', A(1)), pt('] ', A(1)), pt('via ', A(8)), hex(A(2)), pt(' v22.11.0 ', A(2)), pt('took ', A(8)), pt('2s ', A(3)), pi('sparkle', A(3))] },
  { id: 'spaceship', name: 'Spaceship', make: () => [pt('termview', A(6)), pt(' on ', A(8)), pi('branch', A(5)), pt('main ', A(5)), pt('[!?', A(1)), pi('arrow-up', A(1)), pt('] ', A(1)), pt('via ', A(8)), hex(A(2)), pt(' v22.11.0 ', A(2)), pt('took 2.3s ', A(3)), pi('sparkle', A(3)), pi('arrow-right', A(2))] },
  { id: 'robby', name: 'Robby Russell', make: () => [pi('arrow-right', A(2)), pt(' termview ', A(6)), pt('git:(', A(4)), pt('main', A(1)), pt(')', A(4)), pi('close', A(3))] },
  { id: 'agnoster', name: 'Agnoster', make: () => blocks([{ c: [pi('close', '#ff6b6b'), pi('bolt', '#ffd166')], bg: '#383b43', fg: '#e8e9ee' }, { c: [pt('~/work/stencil/…')], bg: '#00b4ff', fg: '#06202e' }, { c: [pi('branch'), pt('main ±')], bg: '#ffb347', fg: '#2b1a00' }]) },
  { id: 'catppuccin', name: 'Catppuccin Powerline', make: () => blocks([{ c: [pt('~/stencil/termview')], bg: '#89b4fa', fg: '#1e1e2e' }, { c: [pi('branch'), pt('main')], bg: '#a6e3a1', fg: '#1e1e2e' }, { c: [pt('!2 ?1')], bg: '#f9e2af', fg: '#1e1e2e' }]) },
  { id: 'gruvbox', name: 'Gruvbox Rainbow', make: () => blocks([{ c: [pt('~/stencil')], bg: '#d65d0e', fg: '#fbf1c7' }, { c: [pi('branch'), pt('main')], bg: '#d79921', fg: '#282828' }, { c: [pt('!2')], bg: '#689d6a', fg: '#282828' }, { c: [pt('10:42')], bg: '#458588', fg: '#fbf1c7' }]) },
  { id: 'pastel', name: 'Pastel Powerline', make: () => blocks([{ c: [pt('~/stencil')], bg: '#ffb3c1', fg: '#2b2d42' }, { c: [pi('branch'), pt('main')], bg: '#ffd6a5', fg: '#2b2d42' }, { c: [pt('!2 ?1')], bg: '#caffbf', fg: '#2b2d42' }, { c: [pt('10:42')], bg: '#a0c4ff', fg: '#2b2d42' }]) },
  { id: 'tokyo', name: 'Tokyo Night', make: () => blocks([{ c: [pt('~/stencil/termview')], bg: '#7aa2f7', fg: '#1a1b26' }, { c: [pi('branch'), pt('main')], bg: '#bb9af7', fg: '#1a1b26' }, { c: [pt('!2 ?1')], bg: '#9ece6a', fg: '#1a1b26' }]) },
]

function promptGrid() {
  const grid = h('div', { class: 'pr-grid', attrs: { role: 'radiogroup', 'aria-label': 'Prompt style' } })
  for (const p of PROMPTS) {
    const b = h(
      'button',
      { class: 'pr', type: 'button', attrs: { role: 'radio', 'aria-checked': 'false' }, onClick: () => put('prompt_style', p.id) },
      h('div', { class: 'pr-h' }, h('span', null, p.name), icon('check', 13)),
      h('div', { class: 'pr-well' }, h('i', { class: 'pp-frame' }), ...p.make()),
    )
    const paint = () => {
      const on = (get('prompt_style') || 'tern') === p.id
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    }
    bound.push(paint)
    paint()
    grid.append(b)
  }
  const frame = () => (grid.dataset.frame = get('prompt_frame') || 'none')
  bound.push(frame)
  frame()
  return grid
}

function terminal() {
  const cursorShape = seg('cursor.shape', [{ value: 'auto', label: 'Auto' }, { value: 'block', label: 'Block' }, { value: 'bar', label: 'Bar' }, { value: 'underline', label: 'Underline' }], { label: 'Cursor shape', from: (v) => v || 'auto', to: (v) => (v === 'auto' ? null : v) })
  return [
    section('Text', [
      R('Font family', 'A monospace font installed on this PC. Empty uses Geist Mono.', fld('font_family', { mono: true, placeholder: 'Geist Mono', live: true, label: 'Font family' }), { block: true }),
      R('Font size', 'Terminal text size in pixels. Ctrl+= and Ctrl+- change it on the fly.', num('font_size', { min: 9, max: 28, step: 1, unit: 'px', label: 'Font size' })),
      R('Font weight', 'From thin (100) to black (900).', num('font_weight', { min: 100, max: 900, step: 100, label: 'Font weight' })),
      R('Line height', 'Row height as a multiple of the font size.', num('line_height', { min: 1, max: 2, step: 0.02, label: 'Line height' })),
    ]),
    section('Cursor', [
      R('Cursor shape', 'Auto lets each program choose; the others always win.', cursorShape, { block: true }),
      R('Cursor blink', 'Blink while the terminal has focus.', tog('cursor.blink', 'Cursor blink')),
    ]),
    section('Scrolling', [
      R('Smooth scrolling', 'Ease mouse-wheel steps in terminals, files and lists. Off, scrolling is immediate. Respects Reduce motion.', tog('smooth_scroll', 'Smooth scrolling')),
      R('Elastic overscroll', 'Stretch and spring back when scrolling past the top or bottom.', tog('elastic_overscroll', 'Elastic overscroll')),
      R('Scroll speed', "How far the mouse wheel and trackpad scroll, against the system's own speed.", sld('scroll_speed', { min: 25, max: 500, step: 5, unit: '%', label: 'Scroll speed' })),
      R('Scrollback', 'Lines each terminal keeps in the session daemon and in this window; lowering it frees the oldest at once.', num('scrollback_lines', { min: 1000, max: 2000000, step: 10000, unit: 'lines', label: 'Scrollback lines' })),
    ]),
    section('Rendering', [
      R('Renderer', 'Auto picks WebGL when the GPU allows it, otherwise Canvas.', seg('renderer', [{ value: 'auto', label: 'Auto' }, { value: 'webgl', label: 'WebGL' }, { value: 'canvas', label: 'Canvas' }], { label: 'Renderer' })),
      R('Antialiasing', 'Smooth glyph edges.', tog('antialias', 'Antialiasing')),
      R('Snap text to pixels', 'Align glyphs to whole pixels: crisper, but spacing can look uneven.', tog('snap_text', 'Snap text to pixels')),
      R('Sync to display', 'Paint once per display refresh.', tog('sync_to_display', 'Sync to display')),
      R('Frames queued', 'How many frames the renderer may prepare ahead of the display.', num('frames_queued', { min: 1, max: 8, step: 1, label: 'Frames queued' })),
    ]),
    section('Prompt', [
      R('Native prompt', "Pager draws the shell's prompt line itself (zsh, bash, fish and PowerShell), so it never wraps or smears.", tog('native_prompt', 'Native prompt')),
      R('Prompt style', 'How the native prompt bar looks.', promptGrid(), { block: true, off: 'native_prompt', kw: 'tern lean classic rainbow pure starship spaceship robby agnoster catppuccin gruvbox pastel tokyo' }),
      R('Prompt frame', 'Corners drawn around the prompt line.', seg('prompt_frame', [{ value: 'none', label: 'None' }, { value: 'rounded', label: 'Rounded' }, { value: 'square', label: 'Square' }], { label: 'Prompt frame' }), { off: 'native_prompt' }),
    ]),
  ]
}

/* ------------------------------------------------------------------ 05 Databases / 06 Notebooks */

function databases() {
  return [
    section('Browsing', [R('Rows per page', 'How many rows a table loads at a time.', num('database.page_size', { min: 10, max: 10000, step: 50, label: 'Rows per page' }))]),
    section('Safety', [R('Confirm destructive changes', 'Ask before dropping tables or deleting rows.', tog('database.confirm_destructive', 'Confirm destructive changes'))]),
  ]
}

function notebooks() {
  return [
    section('Python', [
      R('Python', 'The interpreter notebooks run on. Empty uses the first python on your PATH.', fld('notebook.python', { mono: true, placeholder: 'python', live: true, label: 'Python path' }), { block: true }),
      R('Start the kernel automatically', 'Start a kernel when a notebook opens instead of on the first run.', tog('notebook.autostart', 'Start the kernel automatically')),
    ]),
  ]
}

/* ------------------------------------------------------------------ 07 Keyboard */

const KEYMAPS = [
  { value: 'tern', label: 'Tern' },
  { value: 'ghostty', label: 'Ghostty' },
  { value: 'kitty', label: 'kitty' },
  { value: 'cmux', label: 'cmux' },
  { value: 'tmux', label: 'tmux' },
]

const overrides = () => app.settings.keybinds || {}
const UNBOUND = 'none'

function keyRow(cmd) {
  const def = cmd.keys0
  const bindBtn = h('button', { class: 'kb-bind', type: 'button', attrs: { 'aria-label': `Shortcut for ${cmd.title}` } })
  const reset = iconButton({ icon: 'undo', title: 'Reset to default', onClick: () => release(false) })
  reset.classList.add('kb-reset')
  const write = (chord) => {
    const next = { ...overrides() }
    if (chord === undefined) delete next[cmd.id]
    else next[cmd.id] = chord
    return app.set({ keybinds: next })
  }
  const effective = () => {
    const o = overrides()[cmd.id]
    return o === UNBOUND ? '' : o || def || ''
  }
  const el = h('div', { class: 'kb-row' }, h('div', { class: 'pf-txt' }, h('div', { class: 'pf-t' }, cmd.title), h('div', { class: 'kb-id' }, cmd.id)), reset, bindBtn)
  const paint = () => {
    const chord = effective()
    const custom = overrides()[cmd.id] !== undefined
    bindBtn.classList.toggle('custom', custom)
    bindBtn.classList.remove('cap')
    bindBtn.replaceChildren(chord ? keycaps(chord) : h('span', { class: 'kb-add' }, 'Set shortcut'))
    reset.hidden = !custom
    el.dataset.q = `${cmd.title} ${cmd.id} ${cmd.group || ''} ${chord}`.toLowerCase()
  }
  const end = () => {
    if (cap && cap.owner === el) cap = null
    paint()
  }
  const release = (unbind) => {
    if (cap && cap.owner === el) cap = null
    if (unbind) write(def ? UNBOUND : undefined)
    else write(undefined)
    paint()
  }
  bindBtn.addEventListener('click', () => {
    if (cap && cap.owner === el) return
    cap?.end()
    bindBtn.classList.add('cap')
    bindBtn.replaceChildren(h('span', { class: 'kb-add' }, 'Press keys… (Esc cancels, Backspace unbinds)'))
    cap = {
      owner: el,
      end,
      clear: () => release(true),
      commit: (chord) => {
        const other = commandForChord(chord)
        cap = null
        write(chord)
        paint()
        if (other && other.id !== cmd.id) toast('warn', `${chord} is also used by "${other.title}".`)
      },
    }
  })
  bound.push(() => {
    if (!(cap && cap.owner === el)) paint()
  })
  paint()
  return el
}

function keyboard() {
  const cmds = allCommands().filter((c) => c.kind === 'command')
  // keys0 = the command's own default (allCommands already folded overrides into .keys)
  const groups = new Map()
  for (const c of cmds) {
    const g = c.group || 'Commands'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(c)
  }
  const reset = button({
    label: 'Reset all',
    icon: 'undo',
    small: true,
    onClick: () => {
      cap?.end()
      app.set({ keybinds: {} })
    },
  })
  const sections = [
    section('Keymap', [
      R('Keymap preset', 'The starting set of shortcuts. Your own changes below stay on top of it.', select({ options: KEYMAPS, value: get('keymap'), label: 'Keymap preset', onChange: (v) => put('keymap', v) }) && bind(select({ options: KEYMAPS, value: get('keymap'), label: 'Keymap preset', onChange: (v) => put('keymap', v) }), 'keymap'), { kw: 'tern ghostty kitty cmux tmux' }),
      R('Prefix', 'The tmux-style prefix chord for the tmux preset.', fld('keymap_prefix', { mono: true, placeholder: 'Ctrl+B', live: true, label: 'Prefix' })),
      R('Reset all shortcuts', 'Throw away every shortcut you changed.', reset),
    ]),
  ]
  for (const [g, list] of groups) {
    sections.push(
      section(
        g,
        list.map((c) => keyRow({ id: c.id, title: c.title, group: c.group, keys0: defaultKeys(c) })),
      ),
    )
  }
  return sections
}

// allCommands() reports the override in .keys; the command's own default is whatever it has with no override.
function defaultKeys(c) {
  const o = overrides()[c.id]
  return o === undefined ? c.keys : DEFAULT_KEYS.get(c.id) || ''
}
const DEFAULT_KEYS = new Map()

/* ------------------------------------------------------------------ 08 Git */

function git() {
  return [
    section('Remote', [
      R('Fetch automatically', 'Fetch every N minutes while a repository is open. 0 turns it off.', num('git.auto_fetch_minutes', { min: 0, max: 120, step: 1, unit: 'min', label: 'Fetch interval' })),
      R('Pull with', 'What Pull does when the branches have diverged.', seg('git.pull_mode', [{ value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }, { value: 'ff-only', label: 'Fast-forward' }], { label: 'Pull with' }), { block: true }),
    ]),
    section('Commits', [
      R('Sign commits', 'Sign every commit with your configured GPG or SSH key.', tog('git.sign', 'Sign commits')),
      R('Name', 'The author name for commits made here. Empty uses your git config.', fld('git.name', { placeholder: 'Your name', live: true, label: 'Author name' })),
      R('Email', 'The author email for commits made here. Empty uses your git config.', fld('git.email', { placeholder: 'you@example.com', live: true, label: 'Author email' })),
    ]),
    section('Diffs and editing', [
      R('Diff layout', 'Changes in one column, or old and new side by side.', seg('git.diff_layout', [{ value: 'inline', label: 'Inline' }, { value: 'split', label: 'Split' }], { label: 'Diff layout' })),
      R('External editor', 'A command that opens a file: `code -g`, `zed`… Empty uses the built-in editor.', fld('git.external_editor', { mono: true, placeholder: 'code -g', live: true, label: 'External editor' }), { block: true }),
    ]),
  ]
}

/* ------------------------------------------------------------------ 09 Sessions / 10 Hosts */

async function daemonAction(kind) {
  const fn = app.d && app.d[kind]
  if (typeof fn !== 'function') {
    toast('info', app.mock ? 'The mock daemon has nothing to ' + kind + '.' : 'This build cannot control the daemon from the window.')
    return
  }
  if (kind === 'quit') {
    const ok = await confirmDialog({ title: 'Quit the daemon?', body: 'Every terminal and agent it runs will stop, and the window will close.', confirm: 'Quit daemon', danger: true })
    if (!ok) return
  }
  try {
    await fn.call(app.d)
    toast('ok', kind === 'quit' ? 'Daemon stopped.' : 'Daemon restarting…')
  } catch (e) {
    toast('error', (e && e.message) || String(e))
  }
}

function sessions() {
  const dot = h('span', { class: 'stat-dot' })
  const title = h('div', { class: 'stat-t' })
  const desc = h('div', { class: 'stat-d' })
  const paint = () => {
    const n = app.state.clients || 0
    const panes = (app.state.panes || []).length
    dot.className = 'stat-dot' + (app.mock ? ' warn' : '')
    title.textContent = app.mock ? 'Mock daemon (browser preview)' : 'Daemon running'
    desc.textContent = app.mock ? 'Terminals here are simulated; nothing is kept when the page closes.' : `${n} window${n === 1 ? '' : 's'} attached · ${panes} terminal${panes === 1 ? '' : 's'} running`
  }
  live.push(paint)
  paint()
  const socket = app.state.socket || (app.d && (app.d.socket || app.d.socketPath)) || ''
  const restart = button({ label: 'Restart daemon', icon: 'refresh', small: true, onClick: () => daemonAction('restart') })
  const quit = button({ label: 'Quit daemon', icon: 'stop', small: true, kind: 'danger', onClick: () => daemonAction('quit') })
  return [
    section('Daemon', [
      bare('daemon status running mock terminals windows attached', h('div', { class: 'stat' }, dot, h('div', null, title, desc))),
      R('Socket', 'Where windows and the CLI reach the daemon.', h('div', { class: 'mono-box' }, socket || 'Managed by the desktop app'), { block: true }),
      R('Restart or quit', 'Restarting keeps your layout and reopens every terminal in its folder. Quitting stops everything.', h('div', { class: 'pf-actions' }, restart, quit), { block: true, kw: 'restart quit daemon stop' }),
    ]),
    section('Sharing and updates', [
      R('Share sessions', 'Let `pager attach` and other windows join your sessions.', tog('share_sessions', 'Share sessions')),
      R('Reconnect hosts', 'Reopen remote tabs when a connection drops or the app restarts.', tog('reconnect_hosts', 'Reconnect hosts')),
      R('Update automatically', 'Download updates in the background and ask before restarting.', tog('auto_update', 'Update automatically')),
    ]),
  ]
}

function hosts() {
  return [
    section('Hosts', [
      listEditor({ key: 'hosts', q: 'hosts ssh remote machines address', title: 'Remote hosts', desc: 'Machines you can open a shell on from the palette or a new tab.', second: 'address', secondPlaceholder: 'user@address', nameLabel: 'Name', empty: 'No hosts yet.', addLabel: 'Add host', mk: (x) => x }),
    ]),
  ]
}

/* ------------------------------------------------------------------ 11 Files */

function files() {
  return [
    section('Viewing', [
      R('Render Markdown', 'Open Markdown files rendered; switch to source from the file header.', tog('files.markdown_rendered', 'Render Markdown')),
      R('Wrap code', 'Wrap long lines in code files.', tog('files.wrap_code', 'Wrap code')),
      R('Wrap prose', 'Wrap long lines in Markdown and text.', tog('files.wrap_prose', 'Wrap prose')),
      R('Line numbers', 'Show line numbers in code files.', tog('files.line_numbers', 'Line numbers')),
    ]),
    section('Editing', [
      R('Tab width', 'Columns a tab takes in code files.', num('files.tab_width', { min: 1, max: 16, step: 1, label: 'Tab width' })),
      R('Auto-save', 'Save files without asking.', sel('files.auto_save', [{ value: 'off', label: 'Off' }, { value: 'delay', label: 'After a delay' }, { value: 'focus', label: 'When focus leaves' }], { label: 'Auto-save', minWidth: 150 })),
    ]),
    section('Sidebar', [
      R('Files sidebar', 'Show the file tree beside the terminals. Ctrl+Shift+E toggles it.', tog('files_sidebar', 'Files sidebar')),
      R('Sidebar width', 'The width of the sidebar card.', num('sidebar_width', { min: 180, max: 560, step: 10, unit: 'px', label: 'Sidebar width', write: (v) => app.set({ sidebar_width: v, file_tree: { ...NESTED.file_tree, ...(app.settings.file_tree || {}), width: v } }) })),
      R('Show hidden files', 'Dotfiles and dot-folders.', tog('file_tree.hidden', 'Show hidden files')),
      R('Show ignored files', 'Files that .gitignore leaves out, such as node_modules.', tog('file_tree.ignored', 'Show ignored files')),
      R('Compact folders', 'Fold folders that hold a single folder into one row.', tog('file_tree.compact', 'Compact folders')),
      R('Reveal the active file', 'Scroll the tree to the file you are looking at.', tog('file_tree.reveal', 'Reveal the active file')),
    ]),
  ]
}

/* ------------------------------------------------------------------ registry */

export const PAGES = [
  { id: 'general', name: 'General', icon: 'sliders', title: 'Shell, tabs and selection', blurb: 'What new blocks run, where new tabs start, and what a selection does.', build: general },
  { id: 'agents', name: 'Agents', icon: 'user', title: 'Coding agents', blurb: 'How agent commands typed in a terminal open.', build: agents },
  { id: 'appearance', name: 'Appearance', icon: 'sun', title: 'Themes and interface style', blurb: 'Hover a theme to try it on the whole window; click to keep it. Layout, material and density change the chrome around the terminals.', build: appearance },
  { id: 'terminal', name: 'Terminal', icon: 'terminal', title: 'The terminal itself', blurb: 'Type, cursor, scrolling, rendering and the prompt line.', build: terminal },
  { id: 'databases', name: 'Databases', icon: 'database', title: 'SQLite databases', blurb: 'How database blocks page through tables and guard destructive changes.', build: databases },
  { id: 'notebooks', name: 'Notebooks', icon: 'python', title: 'Jupyter notebooks', blurb: 'Notebook blocks run on a plain Python you choose.', build: notebooks },
  { id: 'keyboard', name: 'Keyboard', icon: 'keyboard', title: 'Shortcuts', blurb: 'Pick a keymap preset, then click any shortcut to record a new one. Esc cancels, Backspace unbinds.', build: keyboard, volatile: true },
  { id: 'git', name: 'Git', icon: 'branch', title: 'Git blocks', blurb: 'Fetching, pulling, signing and how diffs look.', build: git },
  { sep: true },
  { id: 'sessions', name: 'Sessions', icon: 'layers', title: 'Sessions and the daemon', blurb: 'Terminals live in a background daemon, so closing the window never stops anything.', build: sessions },
  { id: 'hosts', name: 'Hosts', icon: 'server', title: 'Remote hosts', blurb: 'Machines you open shells on over SSH.', build: hosts },
  { id: 'files', name: 'Files', icon: 'file', title: 'Files and the sidebar', blurb: 'How files open, wrap and save, and what the tree shows.', build: files },
]

// Remember each command's own default chord once, before any override can hide it.
export function rememberDefaultKeys() {
  const o = overrides()
  for (const c of allCommands()) if (!DEFAULT_KEYS.has(c.id) && o[c.id] === undefined) DEFAULT_KEYS.set(c.id, c.keys || '')
}
