// Shared control kit: small DOM factories (no framework). Styles live in kit.css.
// Every control returns one element with `.setValue(v)` so a page can update it in place when a setting changes elsewhere
// (the element keeps focus and caret; nothing is re-rendered).

import { h, clamp, rafThrottle } from './dom.js'
import { icon as mkIcon } from './icons.js'
import { showMenu } from './popover.js'
import { splitChord } from './commands.js'

const norm = (o) => (typeof o === 'string' || typeof o === 'number' ? { value: o, label: String(o) } : o)

/* ------------------------------------------------------------------ toggle */

/** 44x26 pill switch. */
export function toggle({ value = false, onChange, label, disabled = false } = {}) {
  let on = !!value
  const el = h('button', { class: 'toggle', type: 'button', attrs: { role: 'switch', 'aria-checked': String(on) } }, h('span', { class: 'toggle-knob' }))
  if (label) el.setAttribute('aria-label', label)
  el.disabled = !!disabled
  el.classList.toggle('on', on)
  el.setValue = (v) => {
    on = !!v
    el.classList.toggle('on', on)
    el.setAttribute('aria-checked', String(on))
  }
  el.addEventListener('click', () => {
    el.setValue(!on)
    onChange?.(on)
  })
  return el
}

/* --------------------------------------------------------------- segmented */

/** Segmented control with a sliding thumb. options: [{value,label,icon?}] or strings. */
export function segmented({ options, value, onChange, label, sm = false }) {
  const opts = options.map(norm)
  const root = h('div', { class: 'seg' + (sm ? ' sm' : ''), attrs: { role: 'radiogroup' } })
  if (label) root.setAttribute('aria-label', label)
  const thumb = h('span', { class: 'seg-thumb', attrs: { 'aria-hidden': 'true' } })
  root.append(thumb)
  let cur = value
  const btns = opts.map((o) => {
    const b = h(
      'button',
      { class: 'seg-b', type: 'button', attrs: { role: 'radio', 'aria-checked': 'false', tabindex: '-1' }, dataset: { v: String(o.value) } },
      o.icon ? mkIcon(o.icon, 14) : null,
      o.label !== undefined && o.label !== '' ? h('span', null, o.label) : null,
    )
    if (o.tip) b.dataset.tip = o.tip
    root.append(b)
    return b
  })
  let placed = false
  const layout = () => {
    const i = opts.findIndex((o) => o.value === cur)
    const b = btns[i]
    if (!b || !b.offsetWidth) {
      thumb.style.opacity = '0'
      return
    }
    thumb.style.opacity = '1'
    thumb.style.width = `${b.offsetWidth}px`
    thumb.style.transform = `translateX(${b.offsetLeft}px)`
    if (!placed) {
      placed = true
      requestAnimationFrame(() => root.classList.add('ready'))
    }
  }
  const paint = () => {
    const i = opts.findIndex((o) => o.value === cur)
    btns.forEach((b, j) => {
      b.classList.toggle('on', j === i)
      b.setAttribute('aria-checked', String(j === i))
      b.tabIndex = j === i || (i < 0 && j === 0) ? 0 : -1
    })
    layout()
  }
  const pick = (j, focus) => {
    const o = opts[j]
    if (!o) return
    const changed = o.value !== cur
    cur = o.value
    paint()
    if (focus) btns[j].focus()
    if (changed) onChange?.(o.value)
  }
  btns.forEach((b, j) => {
    b.addEventListener('click', () => pick(j, false))
    b.addEventListener('keydown', (e) => {
      const n = opts.length
      let t = -1
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') t = (j + 1) % n
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') t = (j - 1 + n) % n
      else if (e.key === 'Home') t = 0
      else if (e.key === 'End') t = n - 1
      if (t < 0) return
      e.preventDefault()
      pick(t, true)
    })
  })
  root.setValue = (v) => {
    cur = v
    paint()
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layout).observe(root)
  paint()
  return root
}

/* ------------------------------------------------------------------ select */

/** Dropdown button; the list is a popover menu. options: [{value,label,icon?}] or strings. */
export function select({ options, value, onChange, placeholder = 'Choose', label, sm = false, minWidth }) {
  let opts = options.map(norm)
  let cur = value
  const txt = h('span', { class: 'sel-t' })
  const el = h('button', { class: 'sel-btn' + (sm ? ' sm' : ''), type: 'button', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } }, txt, mkIcon('chev-down', 13, 'sel-c'))
  if (label) el.setAttribute('aria-label', label)
  if (minWidth) el.style.minWidth = `${minWidth}px`
  const paint = () => {
    const o = opts.find((x) => x.value === cur)
    txt.textContent = o ? o.label : placeholder
    txt.classList.toggle('ph', !o)
  }
  el.setValue = (v) => {
    cur = v
    paint()
  }
  el.setOptions = (next) => {
    opts = next.map(norm)
    paint()
  }
  const shut = () => {
    el.classList.remove('open')
    el.setAttribute('aria-expanded', 'false')
  }
  el.addEventListener('click', () => {
    el.classList.add('open')
    el.setAttribute('aria-expanded', 'true')
    showMenu({
      anchor: el,
      align: 'start',
      items: opts.map((o) => ({
        label: o.label,
        icon: o.icon,
        check: o.value === cur,
        onClick: () => {
          const changed = o.value !== cur
          cur = o.value
          paint()
          if (changed) onChange?.(o.value)
        },
      })),
      onClose: shut,
    })
  })
  paint()
  return el
}

/* ------------------------------------------------------------------- field */

/** Text input in a `.fld` shell. `live` fires onChange (debounced) while typing, not only on commit. */
export function field({ value = '', placeholder = '', mono = false, onChange, onInput, type = 'text', live = false, sm = false, unit, label, spellcheck = false, name } = {}) {
  const input = h('input', { type, placeholder, spellcheck, autocomplete: 'off' })
  if (name) input.name = name
  if (label) input.setAttribute('aria-label', label)
  input.value = value ?? ''
  input.spellcheck = !!spellcheck
  const el = h('div', { class: 'fld' + (mono ? ' mono' : '') + (sm ? ' sm' : '') }, input, unit ? h('span', { class: 'fld-u' }, unit) : null)
  let committed = input.value
  let timer = 0
  const commit = () => {
    clearTimeout(timer)
    timer = 0
    if (input.value === committed) return
    committed = input.value
    onChange?.(input.value)
  }
  input.addEventListener('input', () => {
    onInput?.(input.value)
    if (live) {
      clearTimeout(timer)
      timer = setTimeout(commit, 220)
    }
  })
  input.addEventListener('change', commit)
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit()
      e.preventDefault()
    } else if (e.key === 'Escape' && input.value !== committed) {
      input.value = committed
      onInput?.(committed)
      e.stopPropagation()
    }
  })
  el.input = input
  el.setValue = (v) => {
    const s = v ?? ''
    if (input.value === s) return
    input.value = s
    committed = s
  }
  el.focus = () => input.focus()
  return el
}

/* ------------------------------------------------------- stepper / number */

const decimalsOf = (step) => (String(step).split('.')[1] || '').length
const fmt = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '')

function numberCore({ min = -Infinity, max = Infinity, step = 1, value = 0, unit, onChange, label, buttons }) {
  const dec = decimalsOf(step)
  let cur = Number(value)
  const input = h('input', { type: 'text', spellcheck: false, autocomplete: 'off', attrs: { inputmode: dec ? 'decimal' : 'numeric' } })
  if (label) input.setAttribute('aria-label', label)
  const size = () => {
    input.style.width = `${Math.max(2, input.value.length) + 0.4}ch`
  }
  const show = () => {
    input.value = fmt(cur, dec)
    size()
  }
  const apply = (n, fire = true) => {
    if (!Number.isFinite(n)) {
      show()
      return
    }
    const v = Number(clamp(n, min, max).toFixed(dec))
    const changed = v !== cur
    cur = v
    show()
    if (changed && fire) onChange?.(v)
  }
  const bump = (dir) => apply(Math.round((cur + dir * step) / step) * step)
  const mid = h('span', { class: 'stp-v' }, input, unit ? h('span', { class: 'stp-u' }, unit) : null)
  let minus
  let plus
  const root = h('div', { class: buttons ? 'stp' : 'fld num mono' })
  if (buttons) {
    let hold = 0
    let repeat = 0
    const stop = () => {
      clearTimeout(hold)
      clearInterval(repeat)
      hold = repeat = 0
    }
    const mk = (dir, ic, lab) => {
      const b = h('button', { class: 'stp-b', type: 'button', attrs: { 'aria-label': lab, tabindex: '-1' } }, mkIcon(ic, 14))
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        stop()
        bump(dir)
        hold = setTimeout(() => {
          repeat = setInterval(() => bump(dir), 70)
        }, 420)
      })
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(t, stop)
      return b
    }
    minus = mk(-1, 'minus', 'Decrease')
    plus = mk(1, 'plus', 'Increase')
    root.append(minus, mid, plus)
  } else root.append(mid)
  input.addEventListener('input', size)
  input.addEventListener('change', () => apply(parseFloat(input.value.replace(',', '.'))))
  input.addEventListener('blur', () => apply(parseFloat(input.value.replace(',', '.'))))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      bump(1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      bump(-1)
    } else if (e.key === 'Enter') {
      apply(parseFloat(input.value.replace(',', '.')))
      e.preventDefault()
    } else if (e.key === 'Escape') {
      show()
    }
  })
  root.setValue = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n === cur) return
    cur = n
    show()
  }
  root.input = input
  show()
  return root
}

/** [-] 123 unit [+] with press-and-hold repeat, arrow keys and typed values (clamped). */
export const stepper = (o) => numberCore({ ...o, buttons: true })
/** Plain numeric field in a `.fld`. */
export const numberField = (o) => numberCore({ ...o, buttons: false })

/* ------------------------------------------------------------------ slider */

/** Range slider with a mono value readout. Applies at most once per frame while dragging. */
export function slider({ min = 0, max = 100, step = 1, value = 0, unit = '', onChange, format, label }) {
  const dec = decimalsOf(step)
  const input = h('input', { type: 'range', min, max, step, class: 'sld-r' })
  if (label) input.setAttribute('aria-label', label)
  const out = h('span', { class: 'sld-v' })
  const el = h('div', { class: 'sld' }, input, out)
  const show = () => {
    const n = Number(input.value)
    input.style.setProperty('--p', `${((n - min) / (max - min)) * 100}%`)
    out.textContent = format ? format(n) : `${fmt(n, dec)}${unit ? ` ${unit}` : ''}`
  }
  input.value = String(value)
  const fire = rafThrottle(() => onChange?.(Number(input.value)))
  input.addEventListener('input', () => {
    show()
    fire()
  })
  input.addEventListener('change', () => onChange?.(Number(input.value)))
  el.setValue = (v) => {
    if (Number(input.value) === Number(v)) return
    input.value = String(v)
    show()
  }
  show()
  return el
}

/* ------------------------------------------------------------------ button */

/** kind: undefined | 'accent' | 'quiet' | 'danger' */
export function button({ label, icon: ic, kind, onClick, small = false, title, disabled = false } = {}) {
  const lab = h('span', { class: 'pbtn-l' }, label)
  const el = h('button', { class: `pbtn${small ? ' sm' : ''}${kind ? ` ${kind}` : ''}`, type: 'button' }, ic ? mkIcon(ic, small ? 14 : 15) : null, label ? lab : null)
  if (title) el.dataset.tip = title
  el.disabled = !!disabled
  el.setLabel = (t) => {
    lab.textContent = t
  }
  el.setBusy = (b) => {
    el.disabled = !!b
    el.classList.toggle('busy', !!b)
  }
  if (onClick) el.addEventListener('click', (e) => onClick(e, el))
  return el
}

/** Square icon-only button (remove, clear). */
export function iconButton({ icon: ic, title, onClick, kind } = {}) {
  const el = h('button', { class: 'pico' + (kind ? ` ${kind}` : ''), type: 'button', attrs: { 'aria-label': title || '' } }, mkIcon(ic, 14))
  if (title) el.dataset.tip = title
  if (onClick) el.addEventListener('click', onClick)
  return el
}

/* ---------------------------------------------------- row / section / page */

/** A settings row: title + description left, control right (or full width below with block). */
export function row({ title, desc, control, block = false, id, className = '' } = {}) {
  const txt = h('div', { class: 'pf-txt' }, title ? h('div', { class: 'pf-t' }, title) : null, desc ? h('div', { class: 'pf-d' }, desc) : null)
  const el = h('div', { class: `pf-row${block ? ' block' : ''}${control ? '' : ' plain'}${className ? ` ${className}` : ''}` }, txt)
  if (control) el.append(h('div', { class: 'pf-c' }, control))
  if (id) el.dataset.row = id
  return el
}

/** A labelled group: small heading above one rounded card of rows. */
export function section(title, rows) {
  const card = h('div', { class: 'pf-card' }, rows.flat().filter(Boolean))
  return h('section', { class: 'pf-sec' }, title ? h('h3', { class: 'pf-sec-h' }, title) : null, card)
}

/** A page: mono eyebrow, title, blurb, then sections (elements). */
export function page({ eyebrow, title, blurb, sections = [] } = {}) {
  return h(
    'div',
    { class: 'pf-page' },
    h('header', { class: 'pf-head' }, eyebrow ? h('div', { class: 'pf-eyebrow' }, eyebrow) : null, h('h2', { class: 'pf-title' }, title), blurb ? h('p', { class: 'pf-blurb' }, blurb) : null),
    sections.flat().filter(Boolean),
  )
}

/** Key caps for a chord string. 'Ctrl+Shift+T' -> three caps; a space separates the steps of a sequence ('Ctrl+B C'). */
export function keycaps(chord) {
  const el = h('span', { class: 'kcs' })
  const text = (chord || '').trim()
  if (!text) {
    el.classList.add('none')
    return el
  }
  text.split(/\s+/).forEach((step, i) => {
    if (i) el.append(h('span', { class: 'kcs-then' }, 'then'))
    for (const k of splitChord(step)) el.append(h('kbd', { class: 'kc' }, k))
  })
  return el
}
