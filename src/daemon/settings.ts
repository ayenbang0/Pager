import fs from 'node:fs'
import path from 'node:path'

// The desktop Settings object (Tern's settings sheet, arch spec section 7). `desktop.json` in the data dir keeps only
// values that differ from DEFAULTS, so a default a later version changes reaches everyone who never picked it.
// `material`, `opacity` and `fontSize` are the keys the old window host already stored there.

export type Material = 'glass' | 'clear' | 'mica' | 'solid'

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  /** omp theme names; null follows omp's own config. */
  themeDark: string | null
  themeLight: string | null
  layout: 'tiles' | 'rail' | 'float' | 'studio'
  tabs: 'horizontal' | 'vertical'
  tabsAutohide: boolean
  systemTitleBar: boolean
  paneHeaders: 'never' | 'split' | 'always'
  statusBar: boolean
  material: Material
  /** Percent of the window background that covers the desktop behind it. */
  opacity: number
  blur: number
  density: 'compact' | 'islands'
  fontSize: number
  uiFontSize: number | null
  fontFamily: string
  uiFontFamily: string
  lineHeight: number
  fontWeight: number
  snapText: boolean
  contrast: number
  reduceMotion: boolean
  cursor: {
    shape: 'block' | 'rounded' | 'bar' | 'underline' | null
    programs: boolean
    blink: boolean
    smoothBlink: boolean
    glide: number
    trail: 'off' | 'warp' | 'comet' | 'blaze' | 'sparks' | 'echo'
    pulse: 'off' | 'ripple' | 'boom'
  }
  copyOnSelect: boolean
  smoothScroll: boolean
  overscroll: boolean
  scrollSpeed: number
  scrollbackLines: number
  linkClick: 'click' | 'command'
  linkTarget: 'pager' | 'browser'
  clipboardWrite: 'allow' | 'ask' | 'deny'
  hyperlinks: 'allow' | 'deny'
  notifications: boolean
  paste: { quoteUrlsAtPrompt: boolean; confirm: boolean; confirmIfLarge: boolean; replaceDangerousControlCodes: boolean; replaceNewline: boolean }
  confirmClose: 'never' | 'running' | 'always'
  /** The shell panes run; empty is the platform default (PAGER_SHELL, pwsh, powershell, cmd). */
  shell: string
  newBlocks: 'shell' | 'agent'
  newTabsStartIn: 'current' | 'home'
  nativePrompt: boolean
  nativeSurfaces: boolean
  commandLenses: boolean
  programColors: boolean
  keymap: 'pager' | 'ghostty' | 'kitty' | 'cmux' | 'tmux'
  keymapPrefix: string
  keybinds: Record<string, unknown>
  globalHotkey: string
  agents: {
    command: string
    placement: 'split' | 'replace_if_alone' | 'new_tab'
    autoAcp: boolean
    keepTui: string[]
    custom: unknown[]
    mcp: unknown[]
    showClaudeThinking: boolean
  }
  files: {
    markdownRendered: boolean
    wrapCode: boolean
    wrapProse: boolean
    lineNumbers: boolean
    tabWidth: number
    autoSave: 'off' | 'after_delay' | 'on_focus_change'
    autoSaveDelayMs: number
  }
  fileTree: { open: boolean; width: number; hidden: boolean; ignored: boolean; searchIgnored: boolean; compact: boolean; reveal: boolean; previewClick: boolean }
  notebook: { python: string; startOnOpen: boolean; stopAfterError: boolean; askBeforeRestart: boolean; lineNumbers: boolean; wrap: boolean; completeWhileTyping: boolean }
  shareSessions: boolean
  autoUpdate: boolean
  renderer: 'auto' | 'gpu' | 'integrated' | 'cpu'
  antialias: boolean
  syncToDisplay: boolean
  framesQueued: number
  [extra: string]: unknown
}

export const DEFAULTS: Settings = {
  theme: 'system',
  themeDark: null,
  themeLight: null,
  layout: 'tiles',
  tabs: 'horizontal',
  tabsAutohide: false,
  systemTitleBar: false,
  paneHeaders: 'never',
  statusBar: false,
  material: 'clear',
  opacity: 60,
  blur: 56,
  density: 'compact',
  fontSize: 13,
  uiFontSize: null,
  fontFamily: '',
  uiFontFamily: '',
  lineHeight: 1.2,
  fontWeight: 400,
  snapText: false,
  contrast: 0,
  reduceMotion: false,
  cursor: { shape: null, programs: false, blink: true, smoothBlink: false, glide: 0, trail: 'off', pulse: 'off' },
  copyOnSelect: false,
  smoothScroll: true,
  overscroll: true,
  scrollSpeed: 100,
  scrollbackLines: 200000,
  linkClick: 'click',
  linkTarget: 'pager',
  clipboardWrite: 'allow',
  hyperlinks: 'allow',
  notifications: true,
  paste: { quoteUrlsAtPrompt: true, confirm: true, confirmIfLarge: false, replaceDangerousControlCodes: false, replaceNewline: false },
  confirmClose: 'running',
  shell: '',
  newBlocks: 'shell',
  newTabsStartIn: 'current',
  nativePrompt: true,
  nativeSurfaces: true,
  commandLenses: true,
  programColors: true,
  keymap: 'pager',
  keymapPrefix: 'ctrl+b',
  keybinds: {},
  globalHotkey: '',
  agents: { command: 'omp', placement: 'split', autoAcp: false, keepTui: [], custom: [], mcp: [], showClaudeThinking: true },
  files: { markdownRendered: true, wrapCode: false, wrapProse: true, lineNumbers: true, tabWidth: 4, autoSave: 'off', autoSaveDelayMs: 1000 },
  fileTree: { open: false, width: 256, hidden: true, ignored: true, searchIgnored: false, compact: true, reveal: true, previewClick: false },
  notebook: { python: '', startOnOpen: false, stopAfterError: true, askBeforeRestart: true, lineNumbers: true, wrap: false, completeWhileTyping: true },
  shareSessions: true,
  autoUpdate: true,
  renderer: 'auto',
  antialias: true,
  syncToDisplay: true,
  framesQueued: 3,
}

/** Numeric limits applied after load and after every patch (Tern's `clamp()`); keyed by the dotted path. */
const RANGES: Record<string, [number, number]> = {
  opacity: [0, 100],
  blur: [0, 100],
  fontSize: [8, 40],
  lineHeight: [1, 2.5],
  fontWeight: [100, 900],
  contrast: [0, 100],
  'cursor.glide': [0, 240],
  scrollSpeed: [25, 500],
  scrollbackLines: [100, 10_000_000],
  framesQueued: [1, 3],
  'files.tabWidth': [1, 16],
  'files.autoSaveDelayMs': [100, 600_000],
  'fileTree.width': [180, 560],
}
const NULLABLE_NUMBERS = new Set(['uiFontSize'])
const BAD_KEY = /^(__proto__|constructor|prototype)$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Accepts `raw` where it matches the default's type (and enum), else keeps the default; unknown keys pass through. */
function normalizeInto(defaults: Record<string, unknown>, raw: unknown, prefix: string): Record<string, unknown> {
  const src = isObject(raw) ? raw : {}
  const out: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(defaults)) {
    const v = src[key]
    const at = prefix + key
    if (v === undefined) {
      out[key] = structuredClone(def)
    } else if (isObject(def) && key !== 'keybinds') out[key] = normalizeInto(def, v, `${at}.`)
    else if (key === 'keybinds') out[key] = isObject(v) ? structuredClone(v) : {}
    else if (typeof def === 'number') {
      const range = RANGES[at]
      out[key] = typeof v === 'number' && Number.isFinite(v) ? (range ? Math.min(range[1], Math.max(range[0], v)) : v) : def
    } else if (def === null) {
      const range = RANGES[at]
      if (NULLABLE_NUMBERS.has(at)) out[key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(range?.[1] ?? 400, Math.max(range?.[0] ?? 6, v)) : null
      else out[key] = typeof v === 'string' ? v : (def as null)
    } else if (typeof def === 'string') out[key] = typeof v === 'string' && (enumOf(at) ?? [v]).includes(v) ? v : def
    else if (typeof def === 'boolean') out[key] = typeof v === 'boolean' ? v : def
    else if (Array.isArray(def)) out[key] = Array.isArray(v) ? structuredClone(v) : []
    else out[key] = structuredClone(def)
  }
  // Keys this build does not know (a newer renderer's preferences) are kept as they came.
  if (prefix === '') {
    for (const [key, v] of Object.entries(src)) {
      if (!(key in defaults) && !BAD_KEY.test(key) && /^[\w.-]{1,64}$/.test(key) && v !== undefined) out[key] = structuredClone(v)
    }
  }
  return out
}

/** Allowed values of the string settings that are enums; strings not listed here (shell, fonts, commands) are free text. */
const ENUMS: Record<string, readonly string[]> = {
  theme: ['system', 'light', 'dark'],
  layout: ['tiles', 'rail', 'float', 'studio'],
  tabs: ['horizontal', 'vertical'],
  paneHeaders: ['never', 'split', 'always'],
  material: ['glass', 'clear', 'mica', 'solid'],
  density: ['compact', 'islands'],
  linkClick: ['click', 'command'],
  linkTarget: ['pager', 'browser'],
  clipboardWrite: ['allow', 'ask', 'deny'],
  hyperlinks: ['allow', 'deny'],
  confirmClose: ['never', 'running', 'always'],
  newBlocks: ['shell', 'agent'],
  newTabsStartIn: ['current', 'home'],
  keymap: ['pager', 'ghostty', 'kitty', 'cmux', 'tmux'],
  renderer: ['auto', 'gpu', 'integrated', 'cpu'],
  'cursor.trail': ['off', 'warp', 'comet', 'blaze', 'sparks', 'echo'],
  'cursor.pulse': ['off', 'ripple', 'boom'],
  'agents.placement': ['split', 'replace_if_alone', 'new_tab'],
  'files.autoSave': ['off', 'after_delay', 'on_focus_change'],
}
const enumOf = (at: string): readonly string[] | undefined => ENUMS[at]

// `cursor.shape` is a nullable enum.
const SHAPES = ['block', 'rounded', 'bar', 'underline']

export function normalizeSettings(raw: unknown): Settings {
  const s = normalizeInto(DEFAULTS as unknown as Record<string, unknown>, raw, '') as Settings
  if (s.cursor.shape !== null && !SHAPES.includes(s.cursor.shape)) s.cursor.shape = null
  return s
}

/** Deep-merges a patch: objects merge key by key, `null` puts a key back to its default, anything else replaces. */
export function applyPatch(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) return current
  const merged = mergeInto(structuredClone(current) as Record<string, unknown>, DEFAULTS as unknown as Record<string, unknown>, patch)
  return normalizeSettings(merged)
}

function mergeInto(target: Record<string, unknown>, defaults: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, v] of Object.entries(patch)) {
    if (BAD_KEY.test(key)) continue
    const def = defaults[key]
    if (v === null && key in defaults && def !== null) target[key] = structuredClone(def)
    else if (isObject(v) && isObject(def) && key !== 'keybinds') target[key] = mergeInto(isObject(target[key]) ? (target[key] as Record<string, unknown>) : {}, def, v)
    else target[key] = v
  }
  return target
}

/** Only what differs from the defaults (nested sections pruned to their changed keys). */
export function changes(s: Settings): Record<string, unknown> {
  return diff(s as unknown as Record<string, unknown>, DEFAULTS as unknown as Record<string, unknown>)
}

function diff(value: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    const def = defaults[key]
    if (isObject(v) && isObject(def) && key !== 'keybinds') {
      const sub = diff(v, def)
      if (Object.keys(sub).length > 0) out[key] = sub
    } else if (!(key in defaults) || JSON.stringify(v) !== JSON.stringify(def)) out[key] = v
  }
  return out
}

export function loadSettings(file: string): Settings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return normalizeSettings({})
  }
}

let seq = 0
/** Atomic (temp file + rename), changed values only. Async so a slow disk never holds up the daemon's loop. */
export async function saveSettings(file: string, s: Settings): Promise<void> {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(tmp, `${JSON.stringify(changes(s), null, 2)}\n`)
  await fs.promises.rename(tmp, file)
}

const MATERIALS: readonly Material[] = ['clear', 'glass', 'mica', 'solid']
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)))

/** The window hotkeys (material, opacity, font size) as settings patches. */
export function stepPatch(s: Settings, name: string): Record<string, unknown> | undefined {
  switch (name) {
    case 'material':
      return { material: MATERIALS[(MATERIALS.indexOf(s.material) + 1) % MATERIALS.length] }
    case 'opacity+':
      return { opacity: clamp(s.opacity + 10, 0, 100) }
    case 'opacity-':
      return { opacity: clamp(s.opacity - 10, 0, 100) }
    case 'font+':
      return { fontSize: clamp(s.fontSize + 1, 8, 40) }
    case 'font-':
      return { fontSize: clamp(s.fontSize - 1, 8, 40) }
    case 'font0':
      return { fontSize: DEFAULTS.fontSize }
    default:
      return undefined
  }
}
