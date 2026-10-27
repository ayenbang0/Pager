// Chats block: in-block popovers (emoji picker, quick reactions, slash/mention suggestions) and the image lightbox.
// They live inside the block's own root so they share its theme, clipping and stacking, and so tests can mount them.
import { EMOJI, QUICK, searchEmoji } from './chats-emoji.js'
import { placePopover } from './chats-ui.js'

/** One popover at a time. show(content, anchor, opts) -> close(); outside pointerdown, Escape and scroll close it. */
export function createPopovers(b, host) {
  let cur = null
  const close = () => {
    if (!cur) return
    const c = cur
    cur = null
    c.el.classList.add('out')
    setTimeout(() => c.el.remove(), 120)
    document.removeEventListener('pointerdown', c.down, true)
    document.removeEventListener('keydown', c.key, true)
    c.opts.onClose?.()
  }
  const show = (content, anchor, opts = {}) => {
    close()
    const el = b.h('div', { class: 'cm-pop ' + (opts.cls || ''), role: opts.role || 'dialog' }, content)
    host.append(el)
    placePopover(host, el, anchor, opts)
    const down = (e) => {
      if (el.contains(e.target) || (opts.keep && opts.keep(e.target))) return
      close()
    }
    const key = (e) => {
      if (e.key === 'Escape' && !opts.noEsc) {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    cur = { el, down, key, opts }
    return close
  }
  return { show, close, get open() { return cur?.el || null } }
}

/** Six quick reactions plus a button that opens the full picker. */
export function openReactionBar(ui, anchor, onPick, { current = [] } = {}) {
  const { h, icon } = ui.b
  const pick = (e) => {
    ui.pop.close()
    onPick(e)
  }
  const bar = h(
    'div',
    { class: 'cm-qr' },
    QUICK.map((e, i) => h('button', { class: 'cm-qr-b' + (current.includes(e) ? ' on' : ''), type: 'button', style: { '--i': i }, title: e, on: { click: () => pick(e) } }, e)),
    h('button', { class: 'cm-qr-b more', type: 'button', title: 'More emoji', 'aria-label': 'More emoji', on: { click: () => openEmojiPicker(ui, anchor, onPick) } }, icon('plus', 14)),
  )
  return ui.pop.show(bar, anchor, { cls: 'qr', prefer: 'up' })
}

export function openEmojiPicker(ui, anchor, onPick, { keepOpen = false } = {}) {
  const { h } = ui.b
  const grid = h('div', { class: 'cm-eg', role: 'listbox' })
  const search = h('input', { class: 'cm-es', placeholder: 'Search emoji', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search emoji' })
  const cell = (e) => h('button', { class: 'cm-ec', type: 'button', title: e, on: { click: () => { onPick(e); if (!keepOpen) ui.pop.close() } } }, e)
  const paint = () => {
    const q = search.value.trim()
    grid.replaceChildren()
    if (q) {
      const found = searchEmoji(q)
      if (!found.length) grid.append(h('div', { class: 'cm-empty-s' }, 'No emoji found'))
      else grid.append(h('div', { class: 'cm-eg-row' }, found.map(cell)))
      return
    }
    for (const [name, list] of EMOJI) grid.append(h('div', { class: 'cm-eg-h' }, name), h('div', { class: 'cm-eg-row' }, list.map(([e]) => cell(e))))
  }
  search.addEventListener('input', paint)
  paint()
  const close = ui.pop.show(h('div', { class: 'cm-ep' }, search, grid), anchor, { cls: 'ep', prefer: 'up' })
  setTimeout(() => search.focus?.(), 0)
  return close
}

/** Slash command / @mention suggestions above the composer. Returns { update(items, sel), close }. */
export function createSuggest(ui, anchorEl) {
  const { h } = ui.b
  let el = null
  return {
    get open() {
      return !!el
    },
    update(items, sel, onPick) {
      if (!items.length) return this.close()
      const list = items.map((it, i) =>
        h(
          'button',
          { class: 'cm-sug' + (i === sel ? ' sel' : '') + (it.disabled ? ' dis' : ''), type: 'button', role: 'option', 'aria-selected': i === sel ? 'true' : 'false', on: { pointerdown: (e) => { e.preventDefault(); onPick(it) } } },
          it.avatar || null,
          h('span', { class: 'cm-sug-n' }, it.name),
          h('span', { class: 'cm-sug-u' }, it.usage || ''),
          h('span', { class: 'cm-sug-s' }, it.disabled ? it.disabled : it.summary || ''),
        ),
      )
      if (!el) {
        el = h('div', { class: 'cm-pop cm-suggest', role: 'listbox' }, list)
        ui.root.append(el)
      } else el.replaceChildren(...list)
      placePopover(ui.root, el, anchorEl, { prefer: 'up', gap: 6 })
      el.children[sel]?.scrollIntoView?.({ block: 'nearest' })
    },
    close() {
      if (!el) return
      el.remove()
      el = null
    },
  }
}

/** Full-size image over the block; Esc, click or the close button dismisses it. */
export function openLightbox(ui, att, src) {
  const { h, icon } = ui.b
  const close = () => {
    document.removeEventListener('keydown', key, true)
    box.classList.add('out')
    setTimeout(() => box.remove(), 140)
  }
  const key = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  const box = h(
    'div',
    { class: 'cm-lb', role: 'dialog', 'aria-label': att.name, on: { click: close } },
    h('div', { class: 'cm-lb-bar' }, h('span', { class: 'cm-lb-n' }, att.name), h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', on: { click: (e) => (e.stopPropagation(), close()) } }, icon('close', 16))),
    h('img', { class: 'cm-lb-img', src, alt: att.name, on: { click: (e) => e.stopPropagation() } }),
  )
  document.addEventListener('keydown', key, true)
  ui.root.append(box)
  return close
}
