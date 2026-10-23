// Modal dialogs. confirmDialog({title, body?, confirm?, cancel?, danger?}) -> Promise<boolean>
//                promptDialog({title, label?, value?, placeholder?, confirm?}) -> Promise<string|null>
import { h } from './dom.js'
import { icon } from './icons.js'
import { overlayEl, closeMenus } from './popover.js'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Mount one dialog; `ask()` is called on confirm and returns { value } to resolve with or null to refuse (shake). */
function mount({ title, iconName, danger, body, confirmLabel, cancelLabel, ask, focus, cancelValue, scrimCancels }) {
  closeMenus()
  return new Promise((resolve) => {
    const prev = document.activeElement
    let done = false

    const go = h('button', { class: 'btn mdl-go ' + (danger ? 'danger' : 'accent'), type: 'button' }, confirmLabel)
    const cancel = cancelLabel === false ? null : h('button', { class: 'btn', type: 'button' }, cancelLabel)
    const card = h(
      'div',
      { class: 'mdl' + (danger ? ' danger' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'mdl-head' }, h('span', { class: 'mdl-ic' }, icon(iconName, 17)), h('div', { class: 'mdl-ttl' }, title)),
      body,
      h('div', { class: 'mdl-foot' }, cancel, go),
    )
    const layer = h('div', { class: 'scrim mdl-layer' }, card)

    const finish = (value) => {
      if (done) return
      done = true
      layer.remove()
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true })
      resolve(value)
    }
    const shake = () => {
      card.animate(
        [{ transform: 'none' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }],
        { duration: 400, easing: 'cubic-bezier(.2,.7,.2,1)' },
      )
    }
    const confirm = () => {
      const r = ask()
      if (r) finish(r.value)
      else shake()
    }

    go.addEventListener('click', confirm)
    if (cancel) cancel.addEventListener('click', () => finish(cancelValue))
    let downOnScrim = false
    layer.addEventListener('pointerdown', (e) => (downOnScrim = e.target === layer))
    layer.addEventListener('click', (e) => {
      if (scrimCancels && downOnScrim && e.target === layer) finish(cancelValue)
    })
    layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(cancelValue)
      } else if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
        if (e.target === cancel) return
        e.preventDefault()
        e.stopPropagation()
        confirm()
      } else if (e.key === 'Tab') {
        const f = Array.from(card.querySelectorAll(FOCUSABLE))
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    })
    layer.addEventListener('focusin', (e) => {
      if (!card.contains(e.target)) (focus ? focus() : go).focus()
    })

    overlayEl().append(layer)
    const target = focus ? focus() : go
    target.focus()
    if (target.select) target.select()
  })
}

export function confirmDialog({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return mount({
    title,
    iconName: danger ? 'alert' : 'help',
    danger,
    body: body ? h('div', { class: 'mdl-body' }, h('p', null, body)) : h('div', { style: { height: '4px' } }),
    confirmLabel: confirm,
    cancelLabel: cancel,
    ask: () => ({ value: true }),
    cancelValue: false,
    scrimCancels: true,
  })
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'OK' } = {}) {
  const input = h('input', { class: 'mdl-in', type: 'text', value, placeholder, attrs: { spellcheck: 'false', autocomplete: 'off', 'aria-label': label || title } })
  input.addEventListener('input', () => input.classList.remove('bad'))
  return mount({
    title,
    iconName: 'edit',
    danger: false,
    body: h('div', { class: 'mdl-body' }, label && h('label', { class: 'mdl-lbl' }, label), input),
    confirmLabel: confirm,
    cancelLabel: 'Cancel',
    ask: () => {
      const v = input.value.trim()
      if (!v) {
        input.classList.add('bad')
        input.focus()
        return null
      }
      return { value: v }
    },
    focus: () => input,
    cancelValue: null,
    scrimCancels: false,
  })
}
