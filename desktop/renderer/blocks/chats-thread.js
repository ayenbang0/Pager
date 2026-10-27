// Chats block thread view: header, windowed message list with scroll anchoring (sticks to the bottom unless the user scrolled up,
// "N new messages" pill, older messages load on scroll), typing indicator, composer, and the info panel slot.
import { buildTimeline, firstUnreadKey, isAgentChat, isLocal } from './chats-model.js'
import { FlowLayout, anchorScrollTop, estimateRow, nearBottom } from './chats-virtual.js'
import { buildRow, rowSig } from './chats-bubble.js'
import { createComposer } from './chats-composer.js'
import { openReactionBar, openLightbox } from './chats-popups.js'
import { avatar, setPresence, frameOnce, reducedMotion, copyText } from './chats-ui.js'
import { plural, safeImageSrc } from './chats-util.js'
import { canShare } from './chats-share.js'

export function createThread(ui) {
  const { h, icon } = ui.b
  const store = ui.store
  const layout = new FlowLayout((it) => estimateRow(it, scroller.clientWidth || 520))
  const rows = new Map() // key -> { el, sig, index, fresh }
  let chatId = null
  let items = []
  let stick = true
  let newCount = 0
  let lastSet = -1
  let sentFlag = 0
  let animate = new Set()
  let ro = null
  let loadingOlder = false
  let headerAv = null
  const loadedOnce = new Set()

  // ---------------------------------------------------------------- skeleton
  const backBtn = h('button', { class: 'icon-btn cm-back', type: 'button', title: 'Back to chats', 'aria-label': 'Back to chats', on: { click: () => ui.showList() } }, icon('chev-left', 17))
  const titleEl = h('div', { class: 'cm-h-t' })
  const subEl = h('div', { class: 'cm-h-s' })
  const avHost = h('div', { class: 'cm-h-av' })
  const shareBtn = h('button', { class: 'cm-hbtn', type: 'button', title: 'Share a block or an agent session into this chat', 'aria-label': 'Share', 'aria-haspopup': 'menu', on: { click: (e) => openShareMenu(e.currentTarget) } }, icon('upload', 15), h('span', null, 'Share'))
  const infoBtn = h('button', { class: 'icon-btn cm-info-btn', type: 'button', title: 'Chat info', 'aria-label': 'Chat info', on: { click: () => ui.toggleInfo() } }, icon('sidebar-right', 16))
  const moreBtn = h('button', { class: 'icon-btn', type: 'button', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', on: { click: (e) => ui.chatMenu(chatId, e.currentTarget) } }, icon('ellipsis', 16))
  const header = h('div', { class: 'cm-head' }, backBtn, h('button', { class: 'cm-h-who', type: 'button', title: 'Chat info', on: { click: () => ui.toggleInfo() } }, avHost, h('span', { class: 'cm-h-txt' }, titleEl, subEl)), h('div', { class: 'cm-h-btns' }, shareBtn, infoBtn, moreBtn))

  const spacer = h('div', { class: 'cm-spacer' })
  const scroller = h('div', { class: 'cm-scroll', tabindex: 0, role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', on: { scroll: () => onScroll() } }, spacer)
  const empty = h('div', { class: 'cm-thread-empty', hidden: true })
  const typing = h('div', { class: 'cm-typing', hidden: true })
  const newPill = h('button', { class: 'cm-newpill', type: 'button', hidden: true, on: { click: () => toBottom(true) } }, icon('arrow-down', 13), h('span', null, 'New messages'))
  const composer = createComposer(Object.assign(Object.create(ui), { thread: { sentByMe: () => (sentFlag = Date.now()) } }))
  const stage = h('div', { class: 'cm-stage' }, scroller, empty, newPill, typing)
  const dropZone = h('div', { class: 'cm-dropzone' })
  const column = h('div', { class: 'cm-mcol' }, header, stage, composer.el)
  const infoSlot = h('div', { class: 'cm-info-slot' })
  const el = h('section', { class: 'cm-main', 'aria-label': 'Conversation' }, column, infoSlot)
  ui.infoSlot = infoSlot

  // drag and drop files anywhere on the conversation
  let dragDepth = 0
  el.addEventListener('dragenter', (e) => {
    if (!store.caps.attachments || !e.dataTransfer?.types?.includes('Files')) return
    dragDepth++
    composer.showDrop(true)
  })
  el.addEventListener('dragover', (e) => {
    if (store.caps.attachments && e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
  el.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) (dragDepth = 0), composer.showDrop(false)
  })
  el.addEventListener('drop', (e) => {
    dragDepth = 0
    composer.showDrop(false)
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    void composer.addFiles(e.dataTransfer.files)
  })

  // ---------------------------------------------------------------- row context
  const ctx = {
    b: ui.b,
    get caps() {
      return store.caps
    },
    names: [],
    me: '',
    openLink: (href) => ui.openLink(href),
    copy: async (text, btn) => {
      if (await copyText(text)) {
        btn?.classList.add('done')
        setTimeout(() => btn?.classList.remove('done'), 1200)
      } else ui.toast('error', 'Could not copy')
    },
    react: (key, emoji) => void store.react(chatId, key, emoji).catch((e) => ui.toast('error', e.message)),
    reply: (m) => composer.reply(m),
    pickReaction: (m, anchor) => openReactionBar(ui, anchor, (e) => ctx.react(m.key, e), { current: m.reactions.filter((r) => r.mine).map((r) => r.emoji) }),
    actions: (m, anchor) => messageMenu(m, anchor),
    openImage: (a) => {
      const src = safeImageSrc(a.dataUrl || a.url)
      if (src) openLightbox(ui, a, src)
    },
    openFile: (a) => ui.openFile(a),
    retry: (key) => void store.retrySend(chatId, key).catch(() => {}),
    discard: (key) => store.discardLocal(chatId, key),
    jump: (key) => jumpTo(key),
    share: {
      open: (s) => ui.openShare(s),
      join: (s) => ui.joinShare(s),
      leave: (s) => ui.leaveShare(s),
      end: (s) => ui.endShare(s),
    },
    openShareIds: ui.openShareIds,
  }

  function messageMenu(m, anchor) {
    const items = []
    const caps = store.caps
    items.push({ label: 'React', icon: 'smile', onClick: () => setTimeout(() => ctx.pickReaction(m, anchor.getBoundingClientRect ? anchor : stage), 0) })
    if (caps.reply && m.kind === 'text' && !m.deleted) items.push({ label: 'Reply', icon: 'reply', onClick: () => composer.reply(m) })
    if (m.text && !m.deleted) items.push({ label: 'Copy text', icon: 'copy', onClick: () => void copyText(m.text).then((ok) => ui.toast(ok ? 'ok' : 'error', ok ? 'Copied' : 'Could not copy')) })
    if (m.mine && caps.edit && !m.deleted && m.kind === 'text') items.push({ label: 'Edit', icon: 'edit', onClick: () => composer.startEdit(m) })
    if (m.mine && caps.delete && !m.deleted && m.kind === 'text') items.push({ sep: true }, { label: 'Delete', icon: 'trash', danger: true, onClick: () => ui.confirm({ title: 'Delete this message?', body: 'It disappears for everyone in the chat.', confirm: 'Delete', danger: true }).then((ok) => ok && store.deleteMessage(chatId, m.key).catch((e) => ui.toast('error', e.message))) })
    ui.menu(items, anchor)
  }

  function openShareMenu(anchor) {
    ui.openShareMenu(chatId, anchor)
  }

  // ---------------------------------------------------------------- scrolling core
  function onScroll() {
    const top = scroller.scrollTop
    const programmatic = Math.abs(top - lastSet) < 1.5
    if (!programmatic) {
      stick = nearBottom(top, scroller.clientHeight, layout.total)
      if (stick) clearNew()
    }
    paintPill()
    schedule()
    const t = store.thread(chatId)
    if (top < 320 && t?.hasMore && !t.loading && !loadingOlder) {
      loadingOlder = true
      store
        .loadOlder(chatId)
        .catch(() => {})
        .finally(() => (loadingOlder = false))
    }
  }

  function setScroll(v) {
    const max = Math.max(0, layout.total - scroller.clientHeight)
    const t = Math.max(0, Math.min(v, max))
    lastSet = t
    scroller.scrollTop = t
  }

  function toBottom(smooth = false) {
    stick = true
    clearNew()
    layout.layout()
    const target = Math.max(0, layout.total - scroller.clientHeight)
    if (smooth && !reducedMotion() && scroller.scrollTo) {
      lastSet = target
      scroller.scrollTo({ top: target, behavior: 'smooth' })
    } else setScroll(target)
    pass()
  }

  function clearNew() {
    newCount = 0
    paintPill()
  }
  function paintPill() {
    const show = !stick && newCount > 0
    newPill.hidden = !show
    if (show) newPill.lastChild.textContent = newCount === 1 ? '1 new message' : `${newCount} new messages`
  }

  function captureAnchor() {
    if (!items.length) return null
    const i = layout.indexAt(scroller.scrollTop)
    return { key: items[i].key, offset: layout.topOf(i) - scroller.scrollTop }
  }

  const schedule = frameOnce(() => pass())

  function syncRows(start, end) {
    const want = new Set()
    for (let i = start; i < end; i++) {
      const it = items[i]
      want.add(it.key)
      const sig = rowSig(it, ctx)
      let r = rows.get(it.key)
      if (!r) {
        const inner = buildRow(ctx, it)
        const cls = 'cm-item t-' + it.type + (it.type === 'msg' && it.newRun ? ' run' : '') + (it.type === 'msg' && it.msg.mine ? ' mine' : '')
        const wrap = h('div', { class: cls, 'data-key': it.key }, inner)
        if (animate.has(it.key)) {
          wrap.classList.add('new')
          if (it.msg?.mine && sentFlag && Date.now() - sentFlag < 2500) wrap.classList.add('sent')
        }
        r = { el: wrap, sig, index: i, fresh: true }
        rows.set(it.key, r)
        scroller.append(wrap)
        ro?.observe(wrap)
        wrap.__key = it.key
      } else if (r.sig !== sig) {
        r.el.replaceChildren(buildRow(ctx, it))
        r.el.classList.toggle('run', it.type === 'msg' && it.newRun)
        r.sig = sig
        r.fresh = true
      }
      r.index = i
    }
    for (const [key, r] of rows) {
      if (!want.has(key)) {
        ro?.unobserve(r.el)
        r.el.remove()
        rows.delete(key)
      }
    }
  }

  /** Render the visible window; measure new rows; repeat until heights settle. */
  function pass() {
    if (!chatId) return
    const viewH = scroller.clientHeight
    for (let n = 0; n < 4; n++) {
      layout.layout()
      spacer.style.height = layout.total + 'px'
      const { start, end } = layout.range(scroller.scrollTop, viewH)
      syncRows(start, end)
      let changed = false
      for (const [key, r] of rows) {
        if (r.fresh) {
          r.fresh = false
          changed = layout.setHeight(key, r.el.offsetHeight) || changed
        }
      }
      if (!changed) break
    }
    layout.layout()
    spacer.style.height = layout.total + 'px'
    for (const r of rows.values()) r.el.style.top = layout.topOf(r.index) + 'px'
    if (animate.size) animate = new Set()
  }

  function onResize(entries) {
    let changed = false
    for (const e of entries) {
      const key = e.target.__key
      if (key !== undefined && rows.has(key)) changed = layout.setHeight(key, e.target.offsetHeight) || changed
    }
    if (!changed) return
    const anchor = stick ? null : captureAnchor()
    pass()
    if (stick) setScroll(layout.total)
    else if (anchor) {
      const t = anchorScrollTop(layout, anchor.key, anchor.offset)
      if (t !== null) setScroll(t)
    }
    pass()
  }

  // ---------------------------------------------------------------- data -> items
  function rebuild() {
    const t = store.thread(chatId)
    const chat = store.chat(chatId)
    const cleared = ui.clearedAt(chatId)
    const messages = t ? (cleared ? t.messages.filter((m) => m.ts > cleared || m.kind === 'share') : t.messages) : []
    const group = chat && (chat.kind === 'group' || chat.kind === 'shared' || chat.kind === 'room')
    ctx.names = namesOf(t, chat)
    ctx.me = store.me?.name || ''
    items = buildTimeline(messages, { unreadFromKey: t?.firstUnread || '', showNames: group || (chat && isAgentChat(chat) && chat.kind !== 'dm'), showAvatars: group })
    layout.setItems(items)
    const liveKeys = new Set(items.map((i) => i.key))
    for (const [key, r] of rows) if (!liveKeys.has(key)) (ro?.unobserve(r.el), r.el.remove(), rows.delete(key))
    const showEmpty = !!t && t.loaded && !items.length
    empty.hidden = !(showEmpty || (t && t.error && !items.length) || (t && t.loading && !items.length))
    if (!empty.hidden) {
      empty.replaceChildren(
        t.error ? h('div', { class: 'cm-empty-card' }, icon('warn', 22), h('b', null, 'Could not load this chat'), h('span', null, t.error), h('button', { class: 'btn sm', type: 'button', on: { click: () => void store.open(chatId).catch(() => {}) } }, 'Try again')) : t.loading && !t.loaded ? h('div', { class: 'cm-spinner', role: 'status', 'aria-label': 'Loading' }, icon('spinner', 20)) : h('div', { class: 'cm-empty-card' }, icon('chat', 24), h('b', null, 'No messages yet'), h('span', null, chat?.kind === 'dm' ? 'Say hello. Messages are end-to-end encrypted.' : 'Start the conversation.')),
      )
    }
  }

  function namesOf(t, chat) {
    const set = new Set()
    for (const p of t?.group?.people || []) if (p.name) set.add(p.name)
    if (chat && chat.kind === 'dm' && chat.title) set.add(chat.title)
    if (store.me?.name) set.add(store.me.name)
    return [...set]
  }

  function jumpTo(key) {
    const i = layout.indexOfKey(key)
    if (i < 0) return ui.toast('info', 'That message is further back')
    stick = false
    setScroll(layout.topOf(i) - scroller.clientHeight / 3)
    pass()
    const r = rows.get(key)
    r?.el.classList.remove('flash')
    void r?.el.offsetWidth
    r?.el.classList.add('flash')
  }

  // ---------------------------------------------------------------- header
  function paintHeader() {
    const chat = store.chat(chatId)
    if (!chat) return
    titleEl.textContent = chat.title
    const typers = store.typingNames(chatId)
    const t = store.thread(chatId)
    let sub = ''
    let cls = ''
    if (typers.length) {
      sub = typers.length === 1 ? `${typers[0]} is typing…` : `${typers.join(', ')} are typing…`
      cls = 'typing'
    } else if (chat.thinking) {
      sub = 'thinking…'
      cls = 'typing'
    } else if (chat.kind === 'dm') {
      sub = chat.online ? 'online' : 'offline'
      cls = chat.online ? 'on' : ''
    } else if (chat.kind === 'group') {
      const people = t?.group?.people
      const on = people ? people.filter((p) => p.online || p.me).length : 0
      sub = plural(chat.members || people?.length || 0, 'member') + (people ? ` · ${on} online` : '')
    } else sub = chat.kind === 'room' ? 'Your coding agents' : chat.kind === 'ai' ? 'AI assistant' : chat.kind === 'shared' ? 'Shared agent session' : 'Agent'
    subEl.textContent = sub
    subEl.className = 'cm-h-s ' + cls
    if (headerAv && headerAv.__id === chat.id && headerAv.__kind === chat.kind) setPresence(ui.b, headerAv, chat.kind === 'dm' ? chat.online : null)
    else {
      headerAv = avatar(ui.b, chat, { size: 36 })
      headerAv.__id = chat.id
      headerAv.__kind = chat.kind
      avHost.replaceChildren(headerAv)
    }
    shareBtn.hidden = !canShare(store.caps) || !chat || chat.kind === 'room' || chat.kind === 'ai' || chat.kind === 'agent' || chat.kind === 'shared'
    paintTyping(typers, chat)
  }

  function paintTyping(typers = store.typingNames(chatId), chat = store.chat(chatId)) {
    const busy = typers.length > 0 || !!chat?.thinking
    typing.hidden = !busy
    if (busy && !typing.firstChild) typing.append(h('span', { class: 'cm-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'cm-typing-t' }))
    if (busy) typing.lastChild.textContent = typers.length ? `${typers[0]}${typers.length > 1 ? ` +${typers.length - 1}` : ''}` : chat.title
  }

  // ---------------------------------------------------------------- public
  function show(id) {
    if (chatId === id) return
    chatId = id
    for (const r of rows.values()) r.el.remove()
    rows.clear()
    layout.heights.clear()
    animate = new Set()
    newCount = 0
    stick = true
    composer.setChat(id)
    ro?.disconnect()
    ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    paintHeader()
    rebuild()
    const t = store.thread(id)
    pass()
    if (t?.firstUnread && t.loaded) {
      const i = layout.indexOfKey('unread:' + t.firstUnread)
      stick = false
      setScroll(i >= 0 ? layout.topOf(i) - 40 : layout.total)
      stick = i < 0
    } else setScroll(layout.total)
    pass()
    paintPill()
    if (!ui.isNarrow()) composer.focus()
  }

  function onThread(ev) {
    if (ev.id !== chatId) return
    if (ev.change === 'reset') {
      const wasLoaded = loadedOnce.has(chatId)
      const t = store.thread(chatId)
      rebuild()
      pass()
      paintHeader()
      if (t?.loaded && !wasLoaded) {
        loadedOnce.add(chatId)
        if (t.firstUnread) {
          const i = layout.indexOfKey('unread:' + t.firstUnread)
          if (i >= 0) {
            stick = false
            setScroll(layout.topOf(i) - 40)
            pass()
            return
          }
        }
        stick = true
        setScroll(layout.total)
        pass()
        setScroll(layout.total)
      }
      return
    }
    const anchor = stick ? null : captureAnchor()
    if (ev.change === 'append') {
      const t = store.thread(chatId)
      const fresh = (ev.keys || []).filter((k) => t?.messages.some((m) => m.key === k))
      for (const k of fresh) animate.add(k)
      const incoming = fresh.filter((k) => {
        const m = t.messages.find((x) => x.key === k)
        return m && !m.mine && m.kind === 'text'
      }).length
      if (!stick) {
        newCount += incoming
        paintPill()
      }
    }
    rebuild()
    pass()
    if (stick) {
      setScroll(layout.total)
      pass()
      setScroll(layout.total)
    } else if (anchor) {
      const t = anchorScrollTop(layout, anchor.key, anchor.offset)
      if (t !== null) setScroll(t)
      pass()
    }
    paintHeader()
  }

  const offs = [
    store.on('thread', onThread),
    store.on('typing', (e) => e.id === chatId && paintHeader()),
    store.on('list', () => chatId && paintHeader()),
  ]

  return {
    el,
    composer,
    show,
    get chatId() {
      return chatId
    },
    toBottom,
    focusComposer: () => composer.focus(),
    relayout: pass,
    setInfoOpen: (on) => {
      infoBtn.classList.toggle('on', on)
      el.classList.toggle('info-open', on)
    },
    shareAnchor: () => shareBtn,
    lastOwn: (id) => {
      const t = store.thread(id)
      return t ? [...t.messages].reverse().find((m) => m.mine && m.kind === 'text' && !m.deleted && !isLocal(m)) : null
    },
    rows,
    items: () => items,
    dispose() {
      for (const o of offs) o()
      ro?.disconnect()
      composer.destroy()
    },
  }
}
