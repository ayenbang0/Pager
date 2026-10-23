// The agent pane's welcome surface: big wordmark and a floating composer. The first prompt is typed into the agent's own
// terminal (bracketed paste + Enter) and the surface steps aside; the terminal underneath is the real agent.
import { h } from './dom.js'
import { app } from './store.js'
import { icon, agentTile, ompWordmark } from './icons.js'
import { shortPath } from './labels.js'
import { showMenu } from './popover.js'

const NAMES = { omp: 'omp', claude: 'Claude Code', opencode: 'opencode', hermes: 'Hermes', custom: 'agent' }

/** Returns { el, focus(), dispose() }. `done()` is called once the surface should give way to the terminal. */
export function mountAgent(pane, view, done) {
  const name = pane.kind === 'custom' ? pane.title || NAMES.custom : NAMES[pane.kind] || pane.kind
  const mark = pane.kind === 'omp' ? ompWordmark() : agentTile(pane.kind, 44)
  const ta = h('textarea', { rows: 1, placeholder: pane.kind === 'omp' ? 'What are we cooking?' : `Ask ${name} anything`, spellcheck: false, attrs: { 'aria-label': 'Prompt' } })
  const send = h('button', { class: 'ag-send', type: 'button', attrs: { 'data-tip': 'Send', 'data-tip-keys': 'Enter' } }, icon('arrow-up'))
  const branch = h('span', { class: 'ag-chip', hidden: true })
  const cwd = h('span', { class: 'ag-chip', attrs: { title: pane.cwd || '' } }, icon('folder'), h('span', { class: 'ttl' }, shortPath(pane.cwd) || '~'))
  const model = h('button', { class: 'ag-chip model', type: 'button' }, h('span', { class: 'ttl' }, name), icon('chev-down'))
  const termBtn = h('button', { class: 'icon-btn', type: 'button', attrs: { 'data-tip': 'Show the terminal', 'data-tip-keys': 'Escape' }, onClick: () => done() }, icon('terminal'))
  const el = h(
    'div',
    { class: 'ag' },
    h('div', { class: 'ag-brand' }, mark, pane.kind === 'omp' ? h('div', {}, h('div', { class: 'nm' }, 'omp'), h('span', { class: 'ver' }, pane.version ? `v${pane.version}` : '')) : h('div', { class: 'nm' }, name)),
    h('div', { class: 'ag-composer' }, ta, h('div', { class: 'ag-chips' }, model, cwd, branch, h('span', { class: 'sp' }), termBtn, send)),
  )

  const sync = () => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`
    send.classList.toggle('ready', !!ta.value.trim())
  }
  const submit = async () => {
    const text = ta.value.trim()
    if (!text) return
    await view.start()
    if (view.term) view.term.paste(text)
    app.d.write(pane.id, '\r')
    done()
  }
  ta.addEventListener('input', sync)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      done()
    }
  })
  send.addEventListener('click', submit)
  model.addEventListener('click', () => showMenu({ anchor: model, items: [{ label: 'Show the terminal', icon: 'terminal', onClick: () => done() }] }))

  let dead = false
  if (pane.cwd && app.d && app.d.block) {
    Promise.resolve(app.d.block('git', 'summary', { cwd: pane.cwd }))
      .then((g) => {
        if (dead || !g || !g.branch) return
        branch.hidden = false
        const n = g.changed ?? (g.modified || 0) + (g.staged || 0)
        branch.replaceChildren(icon('branch'), h('span', { class: 'ttl' }, g.branch), n ? h('span', { class: 'm' }, `*${n}`) : '', g.untracked ? h('span', { class: 'u' }, `?${g.untracked}`) : '')
      })
      .catch(() => {})
  }
  return {
    el,
    focus: () => ta.focus(),
    dispose: () => {
      dead = true
      el.remove()
    },
  }
}
