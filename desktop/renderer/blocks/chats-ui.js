// Chats block: small shared UI helpers (avatars, presence dot, popover placement, copy, toasts-in-block). Every function takes the
// builder `b` (makeBuilder) so the whole block runs against the fake DOM in tests.
import { hueIndex, initials } from './chats-util.js'
import { isAgentChat } from './chats-model.js'

/** 40px (default) avatar: initials on a calm tinted gradient; groups are squircles, agents get a glyph. `who` = chat summary or person. */
export function avatar(b, who, { size = 40, dot = true } = {}) {
  const { h, icon } = b
  const kind = who.kind || 'dm'
  const group = kind === 'group'
  const agent = isAgentChat(who) || who.agent
  const hue = hueIndex(who.peer || who.pk || who.id || who.title || who.name, 8)
  const label = who.title || who.name || ''
  const inner = agent ? icon(kind === 'ai' ? 'sparkle' : kind === 'shared' ? 'users' : 'bot', Math.round(size * 0.46)) : group ? icon('users', Math.round(size * 0.46)) : who.badge ? who.badge : initials(label)
  const online = who.online === true
  const el = h('span', { class: `cm-av hue${hue}${group ? ' group' : ''}${agent ? ' agent' : ''}`, style: { '--sz': size + 'px' }, 'aria-hidden': 'true' }, h('span', { class: 'cm-av-in' }, inner))
  if (dot && (kind === 'dm' || who.online !== undefined) && who.online !== null && who.online !== undefined) el.append(h('i', { class: 'cm-dot' + (online ? ' on' : '') }))
  return el
}

/** Updates the presence dot of an avatar made by avatar() without rebuilding it. */
export function setPresence(b, av, online) {
  let d = av.querySelector?.('.cm-dot')
  if (online === null || online === undefined) return void d?.remove()
  if (!d) av.append((d = b.h('i', { class: 'cm-dot' })))
  d.classList.toggle('on', online === true)
}

/** Places `pop` (position:absolute inside `host`) next to `anchor`, preferring above; keeps it inside host. */
export function placePopover(host, pop, anchor, { prefer = 'up', align = 'start', gap = 8 } = {}) {
  const hr = host.getBoundingClientRect()
  const ar = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor
  const pw = pop.offsetWidth
  const ph = pop.offsetHeight
  let left = align === 'end' ? ar.right - hr.left - pw : ar.left - hr.left
  left = Math.max(8, Math.min(left, hr.width - pw - 8))
  const roomAbove = ar.top - hr.top - gap
  const roomBelow = hr.bottom - ar.bottom - gap
  let up = prefer === 'up' ? roomAbove >= ph || roomAbove >= roomBelow : !(roomBelow >= ph || roomBelow >= roomAbove)
  let top = up ? ar.top - hr.top - ph - gap : ar.bottom - hr.top + gap
  top = Math.max(8, Math.min(top, hr.height - ph - 8))
  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
  pop.classList.toggle('up', up)
  pop.style.transformOrigin = `${align === 'end' ? 'right' : 'left'} ${up ? 'bottom' : 'top'}`
}

/** Copies text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.append(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Opens a link in the window's browser pane (http/https only); falls back to a new window outside Electron. */
export function openLink(href) {
  const pager = typeof window !== 'undefined' ? window.pager : undefined
  if (pager && typeof pager.browser === 'function') pager.browser('open', href)
  else if (typeof window !== 'undefined') window.open(href, '_blank', 'noopener,noreferrer')
}

/** True when the user (or the OS) asked for less motion. */
export function reducedMotion() {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('reduce-motion')) return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Keeps a tiny debounce so burst renders collapse into one frame. */
export function frameOnce(fn) {
  let id = 0
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16)
  return () => {
    if (id) return
    id = raf(() => {
      id = 0
      fn()
    })
  }
}
