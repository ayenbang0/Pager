// Chats block composer: autogrowing textarea (Enter sends, Shift+Enter newline), reply / edit modes, emoji picker, slash command and
// @mention suggestions, pasted and dropped images and files (capped), drafts per chat.
import { commandSuggestions, mentionAt, quoteText } from './chats-model.js'
import { createSuggest, openEmojiPicker } from './chats-popups.js'
import { avatar } from './chats-ui.js'
import { fmtSize } from './chats-util.js'

export const MAX_ATTACH_BYTES = 8 * 1024 * 1024
export const MAX_ATTACH_COUNT = 6
export const MAX_TEXT = 4000
const MAX_LINES_PX = 176

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read the file'))
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(file)
  })

/** Validates a file for sending; returns an error string or ''. */
export function attachProblem(file, count, max = MAX_ATTACH_BYTES) {
  if (count >= MAX_ATTACH_COUNT) return `At most ${MAX_ATTACH_COUNT} files per message`
  if (!file.size) return `${file.name || 'That file'} is empty`
  if (file.size > max) return `${file.name || 'That file'} is ${fmtSize(file.size)}; the limit is ${fmtSize(max)}`
  return ''
}

export function createComposer(ui) {
  const { h, icon } = ui.b
  const store = ui.store
  let chatId = null
  let replyTo = null
  let editing = null // { key, original }
  let files = [] // { name, mime, size, data, dataUrl? }
  let sel = 0
  let sug = [] // current suggestions
  let sugKind = ''
  let composing = false
  let typingAt = 0

  const input = h('textarea', { class: 'cm-input', rows: 1, placeholder: 'Message', spellcheck: true, autocomplete: 'off', 'aria-label': 'Message', enterkeyhint: 'send' })
  const attachBtn = h('button', { class: 'cm-cbtn', type: 'button', title: 'Attach a file', 'aria-label': 'Attach a file', on: { click: () => fileInput.click() } }, icon('paperclip', 17))
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: -1 })
  const emojiBtn = h('button', { class: 'cm-cbtn', type: 'button', title: 'Emoji', 'aria-label': 'Emoji', on: { click: () => openEmojiPicker(ui, emojiBtn, (e) => insert(e), { keepOpen: false }) } }, icon('smile', 17))
  const sendBtn = h('button', { class: 'cm-send', type: 'button', title: 'Send (Enter)', 'aria-label': 'Send', disabled: true, on: { click: () => submit() } }, icon('send', 16))
  const banner = h('div', { class: 'cm-ctx', hidden: true })
  const chips = h('div', { class: 'cm-chips', hidden: true })
  const bar = h('div', { class: 'cm-cbar' }, attachBtn, input, emojiBtn, sendBtn)
  const drop = h('div', { class: 'cm-drop', hidden: true }, h('span', null, icon('upload', 18), 'Drop to attach'))
  const el = h('div', { class: 'cm-composer' }, banner, chips, bar, fileInput, drop)
  const suggest = createSuggest(ui, bar)

  // ---------------------------------------------------------------- state
  const persist = () => store.setDraft(chatId, { text: input.value, replyTo, editing })

  function grow() {
    input.style.height = 'auto'
    const full = input.scrollHeight || 0
    // A pane restored in a background tab has no layout (scrollHeight 0): leave the CSS height, never pin 0px.
    input.style.height = full ? Math.min(full, MAX_LINES_PX) + 'px' : ''
    input.classList.toggle('scroll', full > MAX_LINES_PX)
  }

  // Re-measure when the bar first gets a width (shown after a restore) or its width changes and the text rewraps. Height is
  // ignored so growing the field cannot re-trigger itself.
  let barWidth = 0
  const sizer = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width)
    if (w === barWidth) return
    barWidth = w
    grow()
  })
  sizer.observe(bar)

  function refresh() {
    const has = input.value.trim().length > 0 || files.length > 0
    sendBtn.disabled = !has || !!ui.locked()
    sendBtn.classList.toggle('ready', has && !ui.locked())
    attachBtn.hidden = !store.caps.attachments
    input.placeholder = ui.locked() ? 'Not connected' : editing ? 'Edit message' : replyTo ? 'Reply' : ui.placeholder?.() || 'Message'
  }

  function paintBanner() {
    banner.replaceChildren()
    banner.hidden = !(replyTo || editing)
    if (!replyTo && !editing) return
    banner.append(
      h('span', { class: 'cm-ctx-ic' }, icon(editing ? 'edit' : 'reply', 14)),
      h('span', { class: 'cm-ctx-t' }, h('span', { class: 'cm-ctx-n' }, editing ? 'Editing message' : `Replying to ${replyTo.authorName || 'message'}`), h('span', { class: 'cm-ctx-q' }, quoteText(editing ? { text: editing.original } : replyTo, 120))),
      h('button', { class: 'icon-btn', type: 'button', title: 'Cancel (Esc)', 'aria-label': 'Cancel', on: { click: () => cancelMode() } }, icon('close', 14)),
    )
  }

  function paintChips() {
    chips.replaceChildren()
    chips.hidden = !files.length
    files.forEach((f, i) => {
      const thumb = f.mime.startsWith('image/') && f.dataUrl ? h('img', { class: 'cm-chip-img', src: f.dataUrl, alt: '' }) : h('span', { class: 'cm-chip-ic' }, icon('file', 15))
      chips.append(h('div', { class: 'cm-chip' }, thumb, h('span', { class: 'cm-chip-t' }, h('span', { class: 'cm-chip-n' }, f.name), h('span', { class: 'cm-chip-s' }, fmtSize(f.size))), h('button', { class: 'cm-chip-x', type: 'button', title: 'Remove', 'aria-label': `Remove ${f.name}`, on: { click: () => (files.splice(i, 1), paintChips(), refresh()) } }, icon('close', 12))))
    })
  }

  function cancelMode() {
    if (editing) input.value = ''
    replyTo = null
    editing = null
    paintBanner()
    grow()
    refresh()
    persist()
    input.focus()
  }

  function setChat(id) {
    if (chatId) persist()
    chatId = id
    const d = store.draft(id)
    input.value = d.text || ''
    replyTo = d.replyTo || null
    editing = d.editing || null
    files = []
    suggest.close()
    paintBanner()
    paintChips()
    grow()
    refresh()
  }

  function insert(text) {
    const a = input.selectionStart ?? input.value.length
    const b = input.selectionEnd ?? a
    input.setRangeText(text, a, b, 'end')
    input.focus()
    onInput()
  }

  // ---------------------------------------------------------------- suggestions
  function computeSuggestions() {
    const v = input.value
    const caret = input.selectionStart ?? v.length
    sug = []
    sugKind = ''
    if (editing) return
    if (v.startsWith('/') && !v.includes('\n')) {
      sug = commandSuggestions(ui.commands(), v, 8)
      sugKind = 'cmd'
    } else {
      const m = mentionAt(v, caret)
      const people = ui.mentionable?.() || []
      if (m && people.length) {
        const q = m.query.toLowerCase()
        sug = people
          .filter((p) => p.name.toLowerCase().includes(q))
          .slice(0, 6)
          .map((p) => ({ insert: '@' + p.name + ' ', name: p.name, usage: '', summary: p.online ? 'online' : '', avatar: avatar(ui.b, { title: p.name, pk: p.pk }, { size: 22, dot: false }), start: m.start, end: caret }))
        sugKind = 'mention'
      }
    }
    if (sel >= sug.length) sel = 0
  }

  function paintSuggest() {
    if (!sug.length) return suggest.close()
    suggest.update(sug, sel, accept)
  }

  function accept(it) {
    if (!it || it.disabled) return
    if (sugKind === 'mention') {
      input.setRangeText(it.insert, it.start, it.end, 'end')
    } else input.value = it.insert
    suggest.close()
    input.focus()
    onInput()
  }

  // ---------------------------------------------------------------- input
  function onInput() {
    grow()
    refresh()
    sel = 0
    computeSuggestions()
    paintSuggest()
    persist()
    if (store.caps.typing && chatId && !input.value.startsWith('/') && input.value && Date.now() - typingAt > 3000) {
      typingAt = Date.now()
      store.sendTyping(chatId)
    }
  }

  async function submit() {
    const text = input.value.trim()
    if (ui.locked() || !chatId || (!text && !files.length)) return
    if (text.length > MAX_TEXT) return ui.toast('error', `Messages are limited to ${MAX_TEXT} characters (this one is ${text.length})`)
    const id = chatId
    const mode = editing
    const reply = replyTo
    const atts = files
    suggest.close()
    input.value = ''
    files = []
    replyTo = null
    editing = null
    paintBanner()
    paintChips()
    grow()
    refresh()
    store.setDraft(id, { text: '', replyTo: null, editing: null })
    try {
      if (mode) await store.editMessage(id, mode.key, text)
      else if (text.startsWith('/')) await ui.runCommand(id, text)
      else {
        ui.thread?.sentByMe()
        await store.send(id, text, { replyTo: reply, attachments: atts })
      }
    } catch (e) {
      // a failed send is shown on its own bubble (retry / discard); edits and commands report here
      if (mode || text.startsWith('/')) {
        ui.toast('error', e.message || 'Failed')
        if (mode) {
          input.value = text
          editing = mode
          paintBanner()
          grow()
        }
      }
    }
  }

  input.addEventListener('input', onInput)
  input.addEventListener('compositionstart', () => (composing = true))
  input.addEventListener('compositionend', () => (composing = false))
  input.addEventListener('click', onInput)
  input.addEventListener('blur', () => setTimeout(() => suggest.close(), 120))
  input.addEventListener('keydown', (e) => {
    if (composing || e.isComposing) return
    if (suggest.open && sug.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + sug.length) % sug.length
        return paintSuggest()
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && sug[sel] && (sugKind === 'mention' || sug[sel].insert.trim() !== input.value.trim()))) {
        e.preventDefault()
        return accept(sug[sel])
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return suggest.close()
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      return void submit()
    }
    if (e.key === 'Escape' && (replyTo || editing)) {
      e.preventDefault()
      e.stopPropagation()
      return cancelMode()
    }
    if (e.key === 'ArrowUp' && !input.value && store.caps.edit && chatId) {
      const last = ui.lastOwn?.(chatId)
      if (last) {
        e.preventDefault()
        startEdit(last)
      }
    }
  })

  // ---------------------------------------------------------------- files
  async function addFiles(list) {
    if (!store.caps.attachments) return ui.toast('info', 'This chat cannot send files yet')
    for (const f of Array.from(list || [])) {
      const bad = attachProblem(f, files.length, store.caps.maxAttachmentBytes || MAX_ATTACH_BYTES)
      if (bad) {
        ui.toast('warn', bad)
        continue
      }
      try {
        const data = await readBase64(f)
        const mime = f.type || 'application/octet-stream'
        files.push({ name: f.name || 'file', mime, size: f.size, data, dataUrl: mime.startsWith('image/') && /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) ? `data:${mime};base64,${data}` : '' })
      } catch (e) {
        ui.toast('error', e.message)
      }
    }
    paintChips()
    refresh()
    input.focus()
  }
  fileInput.addEventListener('change', () => {
    void addFiles(fileInput.files)
    fileInput.value = ''
  })
  input.addEventListener('paste', (e) => {
    const f = Array.from(e.clipboardData?.files || [])
    if (!f.length) return
    e.preventDefault()
    void addFiles(f)
  })

  function startEdit(msg) {
    if (!store.caps.edit || !msg.mine) return
    replyTo = null
    editing = { key: msg.key, original: msg.text }
    input.value = msg.text
    paintBanner()
    grow()
    refresh()
    input.focus()
    input.setSelectionRange?.(msg.text.length, msg.text.length)
  }

  return {
    el,
    input,
    setChat,
    refresh,
    addFiles,
    startEdit,
    reply(msg) {
      if (!store.caps.reply) return
      editing = null
      replyTo = { key: msg.key, authorName: msg.authorName, text: msg.text }
      paintBanner()
      refresh()
      persist()
      input.focus()
    },
    insert,
    focus: () => input.focus(),
    showDrop: (on) => (drop.hidden = !on),
    cancel: () => (replyTo || editing ? (cancelMode(), true) : false),
    get busyMode() {
      return !!(replyTo || editing)
    },
    destroy() {
      if (chatId) persist()
      suggest.close()
      sizer.disconnect()
    },
  }
}
