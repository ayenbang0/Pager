// The `surface` block: one surface (mermaid / math / diff / image / html-sandbox) at full pane size, opened from a terminal
// block's "open in a pane" button. args = { stash } (see stash.js); a pane restored after a reload has lost it and says so.
import { mountSurface } from './render.js'
import { takeSurface } from './stash.js'

const ICON = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2"/><path d="M4.6 10.4l2.2-2.6 1.8 1.7 2.8-3.3"/></svg>'

export default {
  id: 'surface',
  title: 'Surface',
  icon: ICON,
  mount(el, ctx) {
    const msg = ctx.args && ctx.args.stash ? takeSurface(ctx.args.stash) : null
    el.classList.add('pgs-pane')
    if (!msg) {
      const note = document.createElement('div')
      note.className = 'pgs-gone'
      note.textContent = 'This surface was shown from a terminal in a window that has since reloaded. Run the command again to show it.'
      el.append(note)
      return { dispose: () => note.remove() }
    }
    ctx.setTitle(msg.title || msg.kind)
    const view = mountSurface(el, msg, { fill: true })
    return { dispose: () => view.dispose() }
  },
}
