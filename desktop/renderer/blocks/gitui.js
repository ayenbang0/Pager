// Small overlay toolkit of the git block: popovers, context menus and confirm/prompt dialogs. Everything lives inside
// the block's own root (position: absolute), so it can never escape the pane card or be clipped by it.
import { h } from '../ui/dom.js'
import { icon } from './giticons.js'

/** @param {HTMLElement} root the block root (position: relative) */
export function createOverlay(root) {
  const layer = h('div', { class: 'gt-layer', hidden: true })
  root.append(layer)
  let onClose = null
  let returnFocus = null

  function close() {
    if (layer.hidden) return
    layer.hidden = true
    layer.replaceChildren()
    layer.className = 'gt-layer'
    const cb = onClose
    onClose = null
    cb?.()
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }

  layer.addEventListener('pointerdown', (e) => {
    if (e.target === layer) {
      e.preventDefault()
      close()
    }
  })
  root.addEventListener(
    'keydown',
    (e) => {
      if (!layer.hidden && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    },
    true,
  )

  function place(node, anchor, align) {
    const box = root.getBoundingClientRect()
    let x
    let y
    if (anchor instanceof Element) {
      const r = anchor.getBoundingClientRect()
      x = (align === 'right' ? r.right : r.left) - box.left
      y = r.bottom - box.top + 4
    } else {
      x = anchor.x - box.left
      y = anchor.y - box.top
    }
    layer.append(node)
    const w = node.offsetWidth
    const hgt = node.offsetHeight
    if (align === 'right' && anchor instanceof Element) x -= w
    x = Math.max(6, Math.min(x, box.width - w - 6))
    if (y + hgt > box.height - 6) {
      const flip = anchor instanceof Element ? anchor.getBoundingClientRect().top - box.top - hgt - 4 : y - hgt
      y = flip >= 6 ? flip : Math.max(6, box.height - hgt - 6)
    }
    node.style.left = `${x}px`
    node.style.top = `${y}px`
  }

  /** Opens `node` as a popover next to `anchor` (an element or `{x, y}` in viewport coordinates). */
  function popover(anchor, build, { align = 'left', cls = '' } = {}) {
    close()
    returnFocus = document.activeElement
    layer.hidden = false
    layer.className = 'gt-layer pop'
    const node = build(close)
    node.classList.add('gt-pop')
    if (cls) node.classList.add(cls)
    place(node, anchor, align)
    return node
  }

  /**
   * Context menu. Items: { label, icon?, kbd?, danger?, disabled?, onClick } | { sep: true } | { header: 'text' }.
   */
  function menu(anchor, items, opts) {
    return popover(
      anchor,
      () => {
        const node = h('div', { class: 'gt-menu', role: 'menu' })
        const real = []
        for (const it of items) {
          if (!it) continue
          if (it.sep) node.append(h('div', { class: 'gt-sep' }))
          else if (it.header) node.append(h('div', { class: 'gt-mh' }, it.header))
          else {
            const b = h(
              'button',
              {
                class: 'gt-mi' + (it.danger ? ' danger' : ''),
                role: 'menuitem',
                disabled: !!it.disabled,
                onClick: () => {
                  close()
                  it.onClick?.()
                },
              },
              it.icon ? icon(it.icon) : h('span', { class: 'gt-mi-gap' }),
              h('span', { class: 'gt-mi-label' }, it.label),
              it.kbd ? h('kbd', { class: 'gt-kbd' }, it.kbd) : null,
            )
            real.push(b)
            node.append(b)
          }
        }
        node.addEventListener('keydown', (e) => {
          const live = real.filter((b) => !b.disabled)
          const i = live.indexOf(document.activeElement)
          if (e.key === 'ArrowDown') live[(i + 1) % live.length]?.focus()
          else if (e.key === 'ArrowUp') live[(i - 1 + live.length) % live.length]?.focus()
          else return
          e.preventDefault()
        })
        queueMicrotask(() => real.find((b) => !b.disabled)?.focus({ preventScroll: true }))
        return node
      },
      opts,
    )
  }

  /**
   * Modal dialog.
   * @param {{ title: string, text?: string, fields?: {name:string,label:string,value?:string,placeholder?:string}[],
   *   ok?: string, danger?: boolean }} o
   * @returns {Promise<Record<string,string>|null>} the field values (empty object without fields), null when cancelled
   */
  function dialog(o) {
    close()
    returnFocus = document.activeElement
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        resolve(v)
        close()
      }
      layer.hidden = false
      layer.className = 'gt-layer modal'
      const inputs = (o.fields ?? []).map((f) =>
        h('label', { class: 'gt-field' }, h('span', {}, f.label), h('input', { type: 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder ?? '', spellcheck: false, autocomplete: 'off' })),
      )
      const submit = () => {
        const out = {}
        for (const l of inputs) {
          const i = l.querySelector('input')
          out[i.name] = i.value.trim()
        }
        if ((o.fields ?? []).some((f) => f.required !== false) && Object.values(out).some((v) => !v)) return
        finish(out)
      }
      const ok = h('button', { class: 'gt-btn ' + (o.danger ? 'danger' : 'accent'), onClick: submit }, o.ok ?? 'OK')
      const card = h(
        'form',
        { class: 'gt-dialog', onSubmit: (e) => (e.preventDefault(), submit()) },
        h('div', { class: 'gt-dialog-title' }, o.title),
        o.text ? h('div', { class: 'gt-dialog-text' }, o.text) : null,
        ...inputs,
        h('div', { class: 'gt-dialog-foot' }, h('button', { type: 'button', class: 'gt-btn quiet', onClick: () => finish(null) }, 'Cancel'), ok),
      )
      onClose = () => finish(null)
      layer.append(card)
      queueMicrotask(() => {
        const first = card.querySelector('input')
        if (first) {
          first.focus()
          first.select()
        } else ok.focus()
      })
    })
  }

  return { popover, menu, dialog, close, get open() { return !layer.hidden } }
}
