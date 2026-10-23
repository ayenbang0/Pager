#!/usr/bin/env node
// Generates desktop/renderer/ui/themes.js from the oh-my-pi (omp) bundled theme JSON files.
//
//   node scripts/desktop/gen-themes.mjs [themesDir] [--out file]
//
// themesDir is either the `src/theme` directory of @oh-my-pi/pi-tui (contains `defaults/*.json`, plus dark.json and
// light.json one level up) or any flat folder of theme JSON files. Without an argument it uses $OMP_THEMES_DIR, then
// looks for @oh-my-pi/pi-tui in the bun and npm global installs.
//
// Per theme: `vars` references are resolved (chains, xterm-256 numbers), then
//   page   = darker derivative of terminal.chrome (dark: x.55 toward black, light: x.96), titanium pinned to Tern's #0b0e16
//   bg/fg  = terminal.background / foreground       accent = colors.accent
//   dots   = [red, yellow, green, cyan, blue, magenta, accent] (ansi 1,3,2,6,4,5 + accent)
//   pop    = terminal.widget   sel = colors.selectedBg   ok/warn/bad = colors.success/warning/error   live = ansi 5
// Sort order matches Tern's grid: dark-* then light-* then the unprefixed names, alphabetical inside each group.

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')

// ---------------------------------------------------------------- colour helpers
const clamp8 = (n) => Math.max(0, Math.min(255, Math.round(n)))
const hex2 = (n) => clamp8(n).toString(16).padStart(2, '0')

function normHex(v) {
  let s = String(v).trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + [...s.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7)
  return /^#[0-9a-f]{6}$/.test(s) ? s : null
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const toHex = (c) => '#' + c.map(hex2).join('')
const lum = (h) => {
  const [r, g, b] = rgb(h).map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const scale = (h, k) => toHex(rgb(h).map((v) => v * k))

/** xterm 256-colour index -> #rrggbb. */
function xterm256(n) {
  if (n < 16) {
    const base = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']
    return base[n]
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return toHex([v, v, v])
  }
  const i = n - 16
  const lv = [0, 95, 135, 175, 215, 255]
  return toHex([lv[Math.floor(i / 36)], lv[Math.floor(i / 6) % 6], lv[i % 6]])
}

// ---------------------------------------------------------------- locate the themes
function findThemeFiles(arg) {
  const candidates = []
  if (arg) candidates.push(arg)
  if (process.env.OMP_THEMES_DIR) candidates.push(process.env.OMP_THEMES_DIR)
  const roots = [join(homedir(), '.bun', 'install', 'global', 'node_modules'), join(process.env.APPDATA || '', 'npm', 'node_modules')]
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch {
    // npm not on PATH
  }
  for (const r of roots) candidates.push(join(r, '@oh-my-pi', 'pi-tui', 'src', 'theme'))

  for (const c of candidates) {
    if (!c || !existsSync(c) || !statSync(c).isDirectory()) continue
    const files = []
    const defaults = join(c, 'defaults')
    if (existsSync(defaults)) {
      for (const f of readdirSync(defaults)) if (f.endsWith('.json')) files.push(join(defaults, f))
      for (const f of ['dark.json', 'light.json']) if (existsSync(join(c, f))) files.push(join(c, f))
    } else {
      for (const f of readdirSync(c)) if (f.endsWith('.json')) files.push(join(c, f))
    }
    if (files.length) return { dir: c, files }
  }
  throw new Error('omp theme JSON not found: pass the theme directory (…/@oh-my-pi/pi-tui/src/theme) or set OMP_THEMES_DIR')
}

// ---------------------------------------------------------------- resolve one theme
function resolver(vars) {
  const res = (v, depth = 0) => {
    if (typeof v === 'number') return xterm256(v)
    if (typeof v !== 'string' || v === '') return null
    const h = normHex(v)
    if (h) return h
    if (depth > 12 || !(v in vars)) return null
    return res(vars[v], depth + 1)
  }
  return res
}

function build(json) {
  const res = resolver(json.vars || {})
  const t = json.terminal
  if (!t || !Array.isArray(t.ansi) || t.ansi.length !== 16) throw new Error(`${json.name}: no terminal block with 16 ansi colours`)
  const need = (v, what) => {
    const c = res(v)
    if (!c) throw new Error(`${json.name}: cannot resolve ${what} (${JSON.stringify(v)})`)
    return c
  }
  const bg = need(t.background, 'terminal.background')
  const fg = need(t.foreground, 'terminal.foreground')
  const chrome = need(t.chrome, 'terminal.chrome')
  const pop = need(t.widget, 'terminal.widget')
  const ansi = t.ansi.map((v, i) => need(v, `terminal.ansi[${i}]`))
  const accent = need(json.colors.accent, 'colors.accent')
  const mode = lum(bg) < 0.4 ? 'dark' : 'light'

  const pageBase = lum(chrome) <= lum(bg) ? chrome : bg
  let page = mode === 'dark' ? scale(pageBase, 0.55) : scale(pageBase, 0.96)
  if (json.name === 'titanium') page = '#0b0e16'

  const o = { id: json.name, name: json.name, mode, page, bg, fg, accent, dots: [ansi[1], ansi[3], ansi[2], ansi[6], ansi[4], ansi[5], accent], ansi, pop }
  const opt = { sel: json.colors.selectedBg, ok: json.colors.success, warn: json.colors.warning, bad: json.colors.error }
  for (const k in opt) {
    const c = res(opt[k])
    if (c) o[k] = c
  }
  o.live = ansi[5]
  return o
}

// ---------------------------------------------------------------- emit
const q = (s) => `'${s}'`
const arr = (a) => `[${a.map(q).join(',')}]`
function emit(t) {
  const parts = [`id:${q(t.id)}`, `name:${q(t.name)}`, `mode:${q(t.mode)}`, `page:${q(t.page)}`, `bg:${q(t.bg)}`, `fg:${q(t.fg)}`, `accent:${q(t.accent)}`, `dots:${arr(t.dots)}`, `ansi:${arr(t.ansi)}`]
  for (const k of ['pop', 'sel', 'ok', 'warn', 'bad', 'live']) if (t[k]) parts.push(`${k}:${q(t[k])}`)
  return `  {${parts.join(',')}},`
}
const group = (id) => (id.startsWith('dark-') ? 0 : id.startsWith('light-') ? 1 : 2)

function main() {
  const argv = process.argv.slice(2)
  const oi = argv.indexOf('--out')
  const out = oi >= 0 ? resolve(argv.splice(oi, 2)[1]) : join(repo, 'desktop', 'renderer', 'ui', 'themes.js')
  const { dir, files } = findThemeFiles(argv[0])

  const themes = files.map((f) => build(JSON.parse(readFileSync(f, 'utf8'))))
  const ids = new Set(themes.map((t) => t.id))
  if (ids.size !== themes.length) throw new Error('duplicate theme names')
  themes.sort((a, b) => group(a.id) - group(b.id) || (a.id < b.id ? -1 : 1))

  let version = 'unknown'
  for (let d = dir, i = 0; i < 4; i++, d = dirname(d)) {
    const p = join(d, 'package.json')
    if (existsSync(p)) {
      version = `${JSON.parse(readFileSync(p, 'utf8')).version}`
      break
    }
  }
  const mism = themes.filter((t) => (t.id.startsWith('dark-') && t.mode !== 'dark') || (t.id.startsWith('light-') && t.mode !== 'light'))
  const head = [
    '// GENERATED by scripts/desktop/gen-themes.mjs. Do not edit; rerun the script.',
    `// ${themes.length} omp themes read from ${basename(dirname(dirname(dir)))}/${basename(dirname(dir))}/${basename(dir)} (@oh-my-pi/pi-tui ${version}; Tern bundles the same set from oh-my-pi commit 8ebb7daf2ee0735c5f6047f4da93795355f8706b).`,
    '// All values are READ from the theme JSON (vars resolved), except page, which is derived: darker of chrome/background x.55 (dark) or x.96 (light); titanium is pinned to #0b0e16.',
    '// Shape: id,name,mode,page(window),bg(terminal/card),fg,accent,dots[red,yellow,green,cyan,blue,magenta,accent],ansi[16],pop(widget),sel,ok,warn,bad,live(=ansi magenta).',
    'export const THEMES = [',
    ...themes.map(emit),
    ']',
    '',
  ].join('\n')
  writeFileSync(out, head)
  console.log(`wrote ${themes.length} themes to ${out}`)
  if (mism.length) console.warn('mode vs name mismatch:', mism.map((t) => `${t.id}=${t.mode}`).join(', '))
}

main()
