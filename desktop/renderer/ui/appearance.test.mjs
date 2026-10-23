import test from 'node:test'
import assert from 'node:assert/strict'
import { themeCssVars, contrastRatio, THEMES } from './appearance.js'

const get = (id) => THEMES.find((t) => t.id === id)
const HEX = /^#[0-9a-f]{6}$/
const TOKENS = [
  '--page', '--panel', '--card', '--raise', '--code-bg', '--tbl-head', '--ink', '--t1', '--t2', '--t3', '--t4', '--ink2', '--ink3', '--ink4',
  '--l1', '--l2', '--l3', '--l4', '--accent', '--accent-ink', '--accent-fill', '--a1', '--a2', '--grad-ink', '--ok', '--warn', '--bad', '--live',
  '--ok-fill', '--bad-fill', '--live-fill', '--pop-bg', '--topbar-bg', '--glow-a', '--glow-b', '--tv-bg', '--tv-fg', '--tv-cur', '--tv-cur-ink',
  '--tv-sel', '--chip-bg', '--well', '--well-line', '--dim', '--glass-hi', '--sheet-drop',
]

test('theme data: 102 themes, ordered dark-* then light-* then base names, modes match names', () => {
  assert.equal(THEMES.length, 102)
  const group = (id) => (id.startsWith('dark-') ? 0 : id.startsWith('light-') ? 1 : 2)
  for (let i = 1; i < THEMES.length; i++) {
    const a = THEMES[i - 1]
    const b = THEMES[i]
    assert.ok(group(a.id) < group(b.id) || (group(a.id) === group(b.id) && a.id < b.id), `${a.id} before ${b.id}`)
  }
  for (const t of THEMES) {
    assert.equal(t.dots.length, 7)
    assert.equal(t.ansi.length, 16)
    for (const c of [t.page, t.bg, t.fg, t.accent, ...t.dots, ...t.ansi]) assert.match(c, HEX, t.id)
    if (t.id.startsWith('dark-')) assert.equal(t.mode, 'dark', t.id)
    if (t.id.startsWith('light-')) assert.equal(t.mode, 'light', t.id)
  }
})

test('dark-github maps to the spec tokens', () => {
  const t = get('dark-github')
  const v = themeCssVars(t, 'dark')
  for (const k of TOKENS) assert.ok(v[k], k)
  for (let i = 0; i < 16; i++) assert.equal(v[`--ansi${i}`], t.ansi[i])
  assert.equal(v['--page'], t.page)
  assert.equal(v['--panel'], t.bg)
  assert.equal(v['--card'], t.bg)
  assert.equal(v['--tv-bg'], t.bg)
  assert.equal(v['--tv-fg'], t.fg)
  assert.equal(v['--ink'], t.fg)
  assert.equal(v['--accent'], t.accent)
  assert.equal(v['--ok'], t.ok)
  assert.equal(v['--l1'], 'rgba(201, 209, 217, 0.06)')
  assert.equal(v['--l4'], 'rgba(201, 209, 217, 0.22)')
  assert.equal(v['--ink3'], 'rgba(201, 209, 217, 0.44)')
  assert.match(v['--pop-bg'], /, 0\.98\)$/)
  assert.match(v['--topbar-bg'], /, 0\.56\)$/)
  // blue wash top-left (accent), green wash bottom (ansi green)
  assert.equal(v['--glow-a'], 'rgba(88, 166, 255, 0.12)')
  assert.equal(v['--glow-b'], 'rgba(63, 185, 80, 0.09)')
  assert.ok(contrastRatio(v['--accent-ink'], t.bg) >= 4.5)
  assert.ok(contrastRatio('#ffffff', v['--accent-fill']) >= 4.5)
})

test('titanium', () => {
  const t = get('titanium')
  assert.equal(t.page, '#0b0e16')
  assert.equal(t.bg, '#151820')
  assert.equal(t.accent, '#00b4ff')
  assert.equal(t.mode, 'dark')
  const v = themeCssVars(t, 'dark')
  assert.equal(v['--page'], '#0b0e16')
  assert.equal(v['--tv-bg'], '#151820')
  assert.equal(v['--accent'], '#00b4ff')
  assert.equal(v['--tv-cur-ink'], '#151820')
  assert.equal(v['--ansi1'], '#ff4757')
  assert.equal(v['--ansi2'], '#00ff88')
})

test('light theme: light derivations and contrast nudge', () => {
  const t = get('light-github')
  assert.equal(t.mode, 'light')
  const plain = themeCssVars(t, 'light')
  const nudged = themeCssVars(t, 'light', { contrast: true })
  assert.match(plain['--pop-bg'], /, 0\.84\)$/)
  assert.match(plain['--topbar-bg'], /, 0\.72\)$/)
  assert.equal(plain['--glass-hi'], '#ffffff')
  assert.equal(plain['--well'], 'rgba(255, 255, 255, .62)')
  assert.equal(plain['--glow-a'], 'rgba(9, 105, 218, 0.16)')
  assert.ok(contrastRatio(nudged['--t3'], t.bg) >= 4.5)
  assert.ok(contrastRatio(nudged['--t4'], t.bg) >= 4.5)
  assert.ok(contrastRatio(nudged['--accent-ink'], t.bg) >= 4.5)
  assert.ok(contrastRatio(plain['--t4'], t.bg) < 4.5, 'without the nudge t4 is the faint placeholder tone')
  assert.ok(contrastRatio(nudged['--t4'], t.bg) >= contrastRatio(plain['--t4'], t.bg))
  for (const k of ['--ok-fill', '--bad-fill', '--live-fill', '--accent-fill']) assert.ok(contrastRatio('#ffffff', nudged[k]) >= 4.5, k)
})
