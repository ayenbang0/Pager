// Pager window bootstrap. The skeleton in index.html is already on screen; this wires the daemon, the chrome and the panes.
import { app } from './ui/store.js'
import { createMockDaemon } from './ui/mock-daemon.js'
import { initAppearance } from './ui/appearance.js'
import { initTooltips, showMenu } from './ui/popover.js'
import { toast } from './ui/toast.js'
import { initActions } from './ui/actions.js'
import { initTopbar, setBell, showUpdate } from './ui/topbar.js'
import { initPanes, viewOf } from './ui/panes.js'
import { initSidebar } from './ui/sidebar.js'
import { initStatusbar } from './ui/statusbar.js'
import { runCommand } from './ui/commands.js'
import { loadXterm } from './ui/terminal.js'
import { h } from './ui/dom.js'
import { icon } from './ui/icons.js'

// Warm up what the first terminal needs while the chrome builds.
loadXterm().catch(() => {})
document.fonts.load('13px "Geist Mono"').catch(() => {})
document.fonts.load('13.5px "Geist"').catch(() => {})

const root = document.documentElement
const real = window.pager && window.pager.d
app.d = real || createMockDaemon()
app.mock = !real
root.classList.toggle('is-mock', app.mock)

initAppearance()
initTooltips()
initActions()

/* Daemon toasts and local errors feed the toast stack and the bell's inbox. */
const inbox = []
let unseen = 0
const note = (level, text, action) => {
  inbox.unshift({ level, text, at: Date.now() })
  inbox.length = Math.min(inbox.length, 30)
  unseen++
  setBell(unseen)
  toast(level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'info', text, action ? { action } : undefined)
}
const daemonAction = (t) => (t && t.action === 'restart' ? { label: 'Restart', run: () => (app.d.restart ? app.d.restart() : runCommand('daemon.restart')) } : undefined)
if (app.d.onToast) app.d.onToast((t) => note(t.level || 'info', t.text || '', daemonAction(t)))
app.on('error', (e) => note('error', e && e.message ? e.message : String(e)))
window.addEventListener('unhandledrejection', (e) => {
  const m = e.reason && e.reason.message ? e.reason.message : String(e.reason)
  console.error('unhandled rejection', e.reason)
  if (!/ResizeObserver|aborted/i.test(m)) note('error', m)
})

function bellMenu(anchor) {
  unseen = 0
  setBell(0)
  const items = inbox.length
    ? inbox.slice(0, 10).map((n) => ({ label: n.text.length > 70 ? `${n.text.slice(0, 69)}…` : n.text, icon: n.level === 'error' ? 'error' : n.level === 'warn' ? 'warn' : n.level === 'ok' ? 'check-circle' : 'info', hint: new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))
    : [{ label: 'Nothing new', icon: 'bell-off', disabled: true }]
  if (inbox.length) items.push({ sep: true }, { label: 'Clear', icon: 'trash', onClick: () => (inbox.length = 0) })
  showMenu({ anchor, items, align: 'end' })
}

if (app.d.onStatus) {
  app.d.onStatus((s) => {
    if (s === 'lost') showUpdate('Daemon lost · restart', () => (app.d.restart ? app.d.restart() : runCommand('daemon.restart')))
    else showUpdate('')
  })
}

/* Discrete pane events the coalesced state snapshots cannot express: a bell (flash the pane, or ring the inbox bell when the pane lives in another tab or session), and a pane opened from the CLI or another window (`pager open`) - focus its tab the way a click would. Chat and block events have their own subscribers and are ignored here. */
if (app.d.onEvent) {
  app.d.onEvent((ev) => {
    if (!ev || typeof ev.event !== 'string' || !ev.paneId) return
    if (ev.event === 'bell') {
      const view = viewOf(ev.paneId)
      if (view) {
        view.el.classList.add('bell')
        setTimeout(() => view.el.classList.remove('bell'), 600)
      } else {
        const p = app.paneById(ev.paneId)
        if (p) note('ok', `Bell in ${p.title || p.kind || 'a pane'}`)
      }
    } else if (ev.event === 'open_path') {
      app.call('pane.focus', { paneId: ev.paneId }).catch(() => {})
    }
  })
}

/* Legacy host config (material / opacity / font size set by the main process hotkeys). */
if (window.pager && window.pager.onConfig) {
  window.pager.onConfig((c) => {
    const patch = {}
    if (c.material && c.material !== app.settings.material) patch.material = c.material
    if (typeof c.opacity === 'number' && c.opacity !== app.settings.opacity) patch.opacity = c.opacity
    if (typeof c.fontSize === 'number' && c.fontSize !== app.settings.font_size) patch.font_size = c.fontSize
    if (Object.keys(patch).length) app.set(patch)
  })
}

/* Float layout: the glass pill fades while typing and comes back on hover or after a pause. */
let typingTimer = 0
window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length > 1) return
    root.classList.add('tn-typing')
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => root.classList.remove('tn-typing'), 2500)
  },
  true,
)
window.addEventListener('pointermove', (e) => e.clientY < 64 && root.classList.remove('tn-typing'))

initTopbar(bellMenu)

try {
  const state = await app.d.state()
  app.setState(state)
} catch (e) {
  const p = document.getElementById('panes')
  p.replaceChildren(h('div', { class: 'tn-nope', style: 'display:grid;place-items:center;height:100%;color:var(--t3);gap:8px;text-align:center' }, h('div', {}, icon('error', 24), h('p', {}, `Cannot reach the Pager daemon: ${e && e.message ? e.message : e}`))))
  throw e
}
app.d.onState((s) => app.setState(s))
initPanes()
initSidebar()
initStatusbar()
performance.mark('shell-ready')
