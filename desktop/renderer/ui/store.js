// App state: the daemon's DaemonState, the merged settings, a tiny event bus, and thin helpers over window.pager.d.
// Everything in the renderer reads from here; nothing else talks to the daemon except pane IO (panes.js) and blocks.

export const DEFAULT_SETTINGS = {
  theme: 'dark', // system | light | dark (Pager defaults to pitch black; Tern's own default is System)
  theme_dark: null, // omp theme id used when dark (null = Pager's built-in pitch black)
  theme_light: null,
  layout: 'tiles', // rail | float | tiles | studio
  tabs: 'horizontal',
  tabs_autohide: false,
  pane_headers: 'never', // never | split | always
  status_bar: false,
  material: 'glass', // glass | clear | solid
  opacity: 80, // percent of the window background that covers the desktop
  blur: 56,
  density: 'compact', // compact | islands
  font_size: 13,
  ui_font_size: null,
  font_family: '',
  font_weight: 400,
  line_height: 1.28,
  cursor: { shape: null, blink: true, programs: false },
  contrast: 'light', // light themes | always | off
  reduce_motion: 'system',
  keymap: 'tern',
  scrollback_lines: 200000,
  smooth_scroll: true,
  elastic_overscroll: true,
  scroll_speed: 100,
  copy_on_select: false,
  link_click: 'click',
  link_target: 'pager',
  native_prompt: true,
  prompt_style: 'tern',
  prompt_frame: 'none', // none | rounded | square
  renderer: 'auto', // auto | webgl | canvas
  files_sidebar: false,
  sidebar_tab: 'files', // files | changes | git
  sidebar_width: 260,
  sheet_width: 440,
  confirm_close: 'running', // never | running | always
  new_blocks: 'shell', // shell | agent
  new_tabs_start: 'current', // current | home
  agent: 'omp',
  agent_opens: 'split', // split | replace | tab
  shell: '',
  snap_text: false,
  antialias: true,
  frames_queued: 3,
  sync_to_display: true,
  keybinds: {}, // commandId -> chord override
  hosts: [], // [{ id, name, address }]
  agents_custom: [], // [{ id, name, command }]
  agent_composer: true, // new agent panes open with the wordmark + composer until the first prompt
  share_sessions: true,
  reconnect_hosts: true,
  auto_update: true,
}

const bus = new Map()
export const on = (evt, fn) => {
  let set = bus.get(evt)
  if (!set) bus.set(evt, (set = new Set()))
  set.add(fn)
  return () => set.delete(fn)
}
export const emit = (evt, payload) => {
  const set = bus.get(evt)
  if (set) for (const fn of Array.from(set)) fn(payload)
}

const CACHE_KEY = 'pager.ui.v1'
const CACHED = ['theme', 'theme_dark', 'theme_light', 'layout', 'material', 'opacity', 'density', 'pane_headers', 'status_bar', 'files_sidebar', 'sidebar_width', 'font_size', 'reduce_motion', 'tabs']

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}
function writeCache(s) {
  try {
    const o = {}
    for (const k of CACHED) o[k] = s[k]
    localStorage.setItem(CACHE_KEY, JSON.stringify(o))
  } catch {
    // storage unavailable: first paint just uses defaults
  }
}

export const app = {
  /** window.pager.d, or the in-renderer mock (ui/mock-daemon.js) when the preload does not provide it. */
  d: null,
  mock: false,
  state: { sessions: [], panes: [], activeSession: '', clients: 0, settings: {} },
  settings: { ...DEFAULT_SETTINGS, ...readCache() },
  /** Which pane has keyboard focus right now (set by panes.js); falls back to the tab's own focus. */
  focusedPaneId: null,
  /** Per-pane live info the daemon does not carry (cwd follow, git, size). */
  paneInfo: new Map(),
  on,
  emit,

  call(type, args) {
    return this.d.call(type, args)
  },

  /** Apply a settings patch locally at once, then persist it through the daemon. */
  set(patch) {
    const next = { ...this.settings }
    for (const k in patch) next[k] = patch[k]
    this.settings = next
    writeCache(next)
    emit('settings', patch)
    return this.d.call('settings.set', { patch }).catch(() => {})
  },

  setState(state) {
    this.state = state
    if (state.settings && Object.keys(state.settings).length) {
      const merged = { ...this.settings, ...state.settings }
      const changed = {}
      for (const k in state.settings) if (JSON.stringify(this.settings[k]) !== JSON.stringify(state.settings[k])) changed[k] = state.settings[k]
      this.settings = merged
      if (Object.keys(changed).length) {
        writeCache(merged)
        emit('settings', changed)
      }
    }
    emit('state', state)
  },

  activeSession() {
    const s = this.state
    return s.sessions.find((x) => x.id === s.activeSession) || s.sessions[0] || null
  },
  activeTab() {
    const s = this.activeSession()
    return s ? s.tabs.find((t) => t.id === s.activeTab) || s.tabs[0] || null : null
  },
  paneById(id) {
    return this.state.panes.find((p) => p.id === id) || null
  },
  focusedPane() {
    const t = this.activeTab()
    return this.paneById(this.focusedPaneId && tabPaneIds(t).includes(this.focusedPaneId) ? this.focusedPaneId : t ? t.focus : null)
  },
  focusedCwd() {
    const p = this.focusedPane()
    return p ? p.cwd || '' : ''
  },
}

export function leaves(node, out = []) {
  if (!node) return out
  if (node.type === 'pane') out.push(node.paneId)
  else {
    leaves(node.a, out)
    leaves(node.b, out)
  }
  return out
}
export const tabPaneIds = (tab) => (tab ? leaves(tab.root) : [])

/** Layout rects (fractions of the stage) for every leaf and divider of a tree. */
export function layoutTree(node, rect = { x: 0, y: 0, w: 1, h: 1 }, out = { panes: new Map(), dividers: [] }, path = '') {
  if (node.type === 'pane') {
    out.panes.set(node.paneId, rect)
    return out
  }
  const r = Math.min(0.9, Math.max(0.1, node.ratio ?? 0.5))
  const row = node.dir === 'row'
  const ra = row ? { x: rect.x, y: rect.y, w: rect.w * r, h: rect.h } : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * r }
  const rb = row ? { x: rect.x + rect.w * r, y: rect.y, w: rect.w * (1 - r), h: rect.h } : { x: rect.x, y: rect.y + rect.h * r, w: rect.w, h: rect.h * (1 - r) }
  out.dividers.push({ node, path, dir: node.dir, rect, at: row ? rect.x + rect.w * r : rect.y + rect.h * r, a: leaves(node.a)[0], b: leaves(node.b)[0] })
  layoutTree(node.a, ra, out, path + 'a')
  layoutTree(node.b, rb, out, path + 'b')
  return out
}

export const PANE_KINDS = ['pager', 'shell', 'omp', 'claude', 'opencode', 'hermes', 'custom']
export const isBlock = (pane) => !!pane && typeof pane.kind === 'string' && pane.kind.startsWith('block:')
export const blockName = (pane) => (isBlock(pane) ? pane.kind.slice(6) : null)
