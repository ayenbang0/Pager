// Toasts: bottom-centre stack in #toasts. toast(level, text, { action?, ms? }) -> { dismiss() }
import { h } from './dom.js'
import { icon } from './icons.js'
import { toastsEl } from './popover.js'

const ICON = { ok: 'check', info: 'info', warn: 'alert', error: 'error' }
const MAX = 5

export function toast(level, text, opts = {}) {
  const lvl = ICON[level] ? level : 'info'
  const root = toastsEl()
  const { action } = opts
  const ms = opts.ms ?? (lvl === 'error' ? 7000 : 4000)
  let timer = 0
  let remaining = ms
  let started = 0
  let gone = false

  const el = h(
    'div',
    { class: `toast ${lvl}`, role: lvl === 'error' || lvl === 'warn' ? 'alert' : 'status' },
    h('span', { class: 'toast-ic' }, icon(ICON[lvl], 16)),
    h('span', { class: 'toast-t' }, String(text ?? '')),
    action &&
      h(
        'button',
        {
          class: 'toast-act',
          type: 'button',
          onClick: () => {
            dismiss()
            action.run && action.run()
          },
        },
        action.label,
      ),
  )

  function dismiss() {
    if (gone) return
    gone = true
    clearTimeout(timer)
    el.classList.add('out')
    const done = () => el.remove()
    el.addEventListener('transitionend', done, { once: true })
    setTimeout(done, 260)
  }
  const arm = () => {
    if (!(remaining > 0) || !isFinite(remaining)) return
    started = performance.now()
    timer = setTimeout(dismiss, remaining)
  }
  el.addEventListener('pointerenter', () => {
    if (gone || !timer) return
    clearTimeout(timer)
    timer = 0
    remaining = Math.max(1200, remaining - (performance.now() - started))
  })
  el.addEventListener('pointerleave', () => {
    if (!gone && !timer) arm()
  })

  root.append(el)
  const live = Array.from(root.children).filter((c) => !c.classList.contains('out'))
  for (const old of live.slice(0, Math.max(0, live.length - MAX))) old.remove()
  arm()
  return { dismiss }
}
