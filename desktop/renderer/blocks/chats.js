// Chats block: the desktop chat UI (replaces the Ink TUI inside the window). A conversation list beside a thread, over the
// session daemon's chats.* requests and events (src/daemon/chats.ts, local://chats-contract.md): bubbles, reactions, replies,
// shared blocks and shared agent sessions. Everything from other people is rendered as text nodes only (chats-dom.js).
import { makeBuilder } from './chats-dom.js'
import { ChatsStore } from './chats-store.js'
import { daemonApi } from './chats-api.js'
import { createList } from './chats-list.js'
import { createThread } from './chats-thread.js'
import { createInfo } from './chats-info.js'
import { createDialogs, openNewChat, buildRequests } from './chats-dialogs.js'
import { createPopovers } from './chats-popups.js'
import { openLink } from './chats-ui.js'
import { shareMenuItems, blockMeta } from './chats-share.js'
import { shareables, routeEvents, bindDaemonApi, setMe } from './share.js'
import { totalUnread } from './chats-model.js'
import { commandsFor, runLocalCommand, LOCAL_COMMANDS } from './chats-commands.js'

const CSS = new URL('./chats.css', import.meta.url).href
if (typeof document !== 'undefined' && !document.querySelector(`link[href="${CSS}"]`)) {
  const l = document.createElement('link')
  l.rel = 'stylesheet'
  l.href = CSS
  document.head.append(l)
}

const ICON = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 8a5.6 5.4 0 0 1 11.2 0 5.6 5.4 0 0 1-8.2 4.7L2.6 13.6l.9-2.6A5.4 5.4 0 0 1 2.4 8z"/></svg>'
const NARROW = 700
const LS_KEY = 'pager.chats.v1'

/** Tiny persisted prefs (collapsed sections, last chat, info panel); memory only when storage is unavailable. */
function makePrefs(storage) {
  let data = {}
  try {
    data = JSON.parse(storage?.getItem(LS_KEY) || '{}') || {}
  } catch {
    data = {}
  }
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set(k, v) {
      data[k] = v
      try {
        storage?.setItem(LS_KEY, JSON.stringify(data))
      } catch {
        /* storage full or blocked */
      }
    },
  }
}

/** An api that forwards to the real one once it lands; calls before that reject with `starting`. */
function lazyApi() {
  let real = null
  const subs = new Set()
  const emit = (ev) => {
    for (const fn of [...subs]) {
      try {
        fn(ev)
      } catch {
        /* a broken subscriber must not kill the event stream */
      }
    }
  }
  return {
    call: (type, args) => (real ? real.call(type, args) : Promise.reject(new Error('starting: chat is connecting'))),
    onEvent: (fn) => (subs.add(fn), () => subs.delete(fn)),
    onStatus: null,
    setReal(r) {
      real = r
      if (r && typeof r.onEvent === 'function') r.onEvent(emit)
      return real
    },
  }
}

/**
 * mountChats(el, ctx, deps?) -> { dispose, focus, resize, ... }. deps (tests and the harness): { api, doc, storage, menuApi, pickerApi }.
 * Without deps the daemon api is window.pager.d.
 */
export function mountChats(el, ctx = {}, deps = {}) {
  const doc = deps.doc || document
  const b = makeBuilder(doc)
  const { h, icon } = b

  // The daemon api, resolved asynchronously: the injected one (tests, harness), or the window's daemon client, or the in-page
  // mock in a plain browser (no window.pager, or the browser preview's mock daemon, which has no chats). A real daemon is never
  // swapped for the mock: when it fails the store shows the error and a retry, not made-up conversations.
  const api = lazyApi()
  const store = new ChatsStore(api)
  bindDaemonApi(api) // share.js rides the same connection
  let routeOff = null
  const apiReady = (async () => {
    if (deps.api) return api.setReal(deps.api)
    const d = typeof window !== 'undefined' ? window.pager?.d : null
    if (d && !d.mock) return api.setReal(daemonApi(d))
    const mod = await import('./chats-mock.js')
    const mock = mod.createMockChats()
    if (typeof window !== 'undefined') window.__pagerChatsMock = mock
    return api.setReal(mock.api)
  })()
  apiReady.catch(() => {})
  let disposed = false
  let view = 'list' // narrow layouts show one pane
  const prefs = makePrefs(deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null))
  let infoOpen = prefs.get('info', false)
  const openShareIds = new Set() // shareIds open in a pane beside the chat (marks the timeline card)
  let pageEl = null
  const cleanups = []

  const root = h('div', { class: 'cm', 'data-layout': 'wide', 'data-view': 'list', tabindex: -1 })
  const popHost = root
  const ui = { b, store, root, prefs }
  ui.pop = createPopovers(b, popHost)
  ui.dialogs = createDialogs(ui)
  ui.confirm = (o) => ui.dialogs.confirm(o)
  ui.prompt = (o) => ui.dialogs.prompt(o)
  ui.isNarrow = () => root.getAttribute('data-layout') === 'narrow'
  ui.locked = () => !store.ready
  ui.openLink = (href) => (deps.openLink || ctx.openUrl || openLink)(href)
  ui.openFile = (a) => ui.toast('info', `${a.name}: saving files is not available yet`)
  ui.toast = (level, text) => {
    const l = level === 'success' ? 'ok' : level
    if (typeof ctx.toast === 'function') ctx.toast(l, text)
    else if (typeof console !== 'undefined') console.info('[chats]', l, text)
  }
  store.on('toast', (t) => ui.toast(t.level, t.text))

  // ---------------------------------------------------------------- menus (the shell's popover menu, loaded on demand)
  let showMenu = deps.menuApi || null
  let pendingMenu = null
  const menuReady = deps.menuApi
    ? Promise.resolve()
    : import('../ui/popover.js')
        .then((m) => {
          showMenu = m.showMenu
          if (pendingMenu) {
            const [items, anchor] = pendingMenu
            pendingMenu = null
            showMenu({ anchor, items, align: 'end' })
          }
        })
        .catch(() => {})
  void menuReady
  ui.menu = (items, anchor) => {
    ui.pop.close()
    if (showMenu) typeof showMenu === 'function' ? showMenu({ anchor, items, align: 'end' }) : showMenu.show({ anchor, items })
    else pendingMenu = [items, anchor]
  }

  // ---------------------------------------------------------------- pieces
  const list = createList(ui)
  const thread = createThread(ui)
  ui.thread = thread
  const info = createInfo(ui)
  ui.infoSlot.append(info.el)
  const requests = buildRequests(ui)
  const hero = h('div', { class: 'cm-hero' }, h('div', { class: 'cm-hero-ic' }, icon('chat', 28)), h('h3', null, 'Pick a chat'), h('p', null, 'Choose a conversation on the left, or start a new one.'), h('div', { class: 'cm-hero-btns' }, h('button', { class: 'btn accent', type: 'button', on: { click: () => ui.openNewChat() } }, icon('chat-plus', 15), 'New chat'), h('button', { class: 'btn', type: 'button', on: { click: () => ui.openRequests() } }, icon('inbox', 15), 'Requests')))
  const mainHost = h('div', { class: 'cm-mainhost' }, thread.el, hero)
  const gate = h('div', { class: 'cm-gate', hidden: true })
  root.append(list.el, mainHost, gate)
  el.append(root)

  // ---------------------------------------------------------------- navigation
  function setView(v) {
    view = v
    root.setAttribute('data-view', v)
  }
  function paintMain() {
    const open = store.openId
    const showThread = !!open && !pageEl
    thread.el.hidden = !showThread
    hero.hidden = showThread || !!pageEl
    if (pageEl) pageEl.hidden = false
  }

  ui.openChat = async (id) => {
    if (!store.chat(id)) return
    closePage(false)
    setView('thread')
    const p = store.open(id).catch((e) => ui.toast('error', e.message))
    thread.show(id)
    info.show(id)
    prefs.set('last', id)
    paintMain()
    await p
    paintMain()
  }
  ui.showList = () => {
    closePage(false)
    setView('list')
    if (ui.isNarrow()) store.close()
    paintMain()
    list.focusSearch()
  }
  ui.toggleInfo = (on) => {
    infoOpen = on === undefined ? !infoOpen : on
    prefs.set('info', infoOpen)
    thread.setInfoOpen(infoOpen)
    root.classList.toggle('info-open', infoOpen)
    if (infoOpen && store.openId) info.show(store.openId)
    requestAnimationFrame?.(() => thread.relayout())
    setTimeout(() => thread.relayout(), 260)
  }
  ui.openNewChat = (tab) => openNewChat(ui, tab)
  ui.openRequests = () => {
    if (!pageEl) {
      pageEl = requests.el
      mainHost.append(pageEl)
    }
    setView('thread')
    paintMain()
  }
  function closePage(repaint = true) {
    if (!pageEl) return
    pageEl.remove()
    pageEl = null
    if (repaint) paintMain()
  }
  ui.closePage = () => {
    closePage(false)
    if (ui.isNarrow() && !store.openId) setView('list')
    paintMain()
  }

  // ---------------------------------------------------------------- actions used by the list, header and info panel
  ui.setPref = (id, kind, on) =>
    store.setPref(id, kind, on).catch((e) => ui.toast('error', e.message))

  ui.chatMenu = (id, anchor) => {
    const c = store.chat(id)
    if (!c) return
    const items = [
      { label: c.pinned ? 'Unpin' : 'Pin to top', icon: c.pinned ? 'pin-off' : 'pin', onClick: () => ui.setPref(id, 'pin', !c.pinned) },
      { label: c.muted ? 'Unmute' : 'Mute notifications', icon: c.muted ? 'bell' : 'bell-off', onClick: () => ui.setPref(id, 'mute', !c.muted) },
      { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => ui.setPref(id, 'archive', !c.archived) },
    ]
    if (c.unread) items.push({ label: 'Mark as read', icon: 'check', onClick: () => store.markRead(id) })
    items.push({ sep: true }, { label: 'Chat info', icon: 'info', onClick: () => (store.openId === id ? ui.toggleInfo(true) : ui.openChat(id).then(() => ui.toggleInfo(true))) })
    if (c.kind === 'dm') items.push({ label: 'Remove contact', icon: 'trash', danger: true, onClick: () => void ui.removeContact(c) })
    if (c.kind === 'group') items.push({ label: 'Leave group', icon: 'close', danger: true, onClick: () => void ui.leaveGroup(c) })
    ui.menu(items, anchor)
  }

  ui.removeContact = async (c) => {
    if (!(await ui.confirm({ title: `Remove ${c.title}?`, body: 'You will no longer see each other online. You can add them again with their contact code.', confirm: 'Remove', danger: true }))) return
    try {
      const r = await store.api.call('chats.contact.remove', { peer: c.peer || c.title })
      ui.toast('ok', r?.message || 'Removed')
      void store.init().catch(() => {})
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  ui.renameGroup = async (c) => {
    const name = await ui.prompt({ title: 'Rename group', label: 'Name', value: c.title, confirm: 'Rename' })
    if (!name || name === c.title) return
    try {
      await store.api.call('chats.group.rename', { chatId: c.id, title: name })
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  ui.leaveGroup = async (c) => {
    if (!(await ui.confirm({ title: `Leave ${c.title}?`, body: 'You leave for good. Someone has to invite you again to come back.', confirm: 'Leave group', danger: true }))) return
    try {
      await store.api.call('chats.group.leave', { chatId: c.id })
      if (store.openId === c.id) store.close()
      void store.init().catch(() => {})
      ui.showList()
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  // The short composer command list (/share /invite /agent /me /mute /clear) is client side; anything else goes to the engine.
  const LOCAL = new Set(LOCAL_COMMANDS.map((c) => c.name))
  ui.commands = () => commandsFor(store.chat(store.openId))
  ui.runCommand = (id, line) => {
    const m = /^\/(\S*)/.exec(String(line ?? '').trim())
    if (m && LOCAL.has(m[1].toLowerCase())) {
      const act = {
        store,
        chat: store.chat(id),
        toast: (l, t) => ui.toast(l, t),
        openShareMenu: () => ui.openShareMenu(id, thread.shareAnchor()),
        openAgentShare: () => void ui.startShare(id, 'agent', 'live'),
        clear: (cid) => ui.clearChat(cid),
      }
      return runLocalCommand(act, line).then((r) => {
        if (r?.message) ui.toast(r.ok ? 'ok' : 'warn', r.message)
        return r
      })
    }
    return store.runCommand(id, line)
  }
  ui.clearedAt = (id) => prefs.get('cleared', {})[id] || 0
  ui.clearChat = (id) => {
    if (!store.chat(id)) return
    prefs.set('cleared', { ...prefs.get('cleared', {}), [id]: Date.now() })
    store.addLocalSystem(id, 'History hidden in this window — nothing was deleted, your peers keep everything.')
  }
  ui.openAgentShare = (chatId) => void ui.startShare(chatId, 'agent', 'live')
  ui.openShareIds = openShareIds
  ui.openShareMenu = (chatId, anchor) => {
    const chat = store.chat(chatId)
    if (!chat) return
    const pick = ({ instance, block, mode }) => {
      if (instance) void ui.startShare(chatId, instance, mode)
      else void ui.startShare(chatId, block, mode)
    }
    const items = shareMenuItems(store.caps, shareables(), chat, pick)
    if (!items.length) {
      ui.toast('info', 'Nothing shareable from this window yet — open a block first')
      return
    }
    ui.menu(items, anchor || thread.shareAnchor())
  }
  ui.lastOwn = (id) => thread.lastOwn(id)
  ui.placeholder = () => {
    const c = store.chat(store.openId)
    return c ? (c.kind === 'dm' ? `Message ${c.title}` : c.kind === 'group' ? `Message ${c.title}` : c.kind === 'ai' ? 'Ask the assistant' : 'Message your agents') : 'Message'
  }
  ui.mentionable = () => {
    const t = store.thread(store.openId)
    return (t?.group?.people || []).filter((p) => !p.me).map((p) => ({ name: p.name, pk: p.pk, online: p.online }))
  }

  // ---------------------------------------------------------------- shared blocks and agents
  ui.openShare = async (s) => {
    openShareIds.add(s.shareId)
    if (s.block === 'agent') {
      const chat = store.chat('shared:' + s.hostPk) || (s.mine ? store.chat('agents') : null)
      if (chat) return ui.openChat(chat.id)
      return ui.toast('info', 'Join the session first')
    }
    if (typeof ctx.openBlock !== 'function') return ui.toast('info', 'Open it from a window with panes')
    ctx.openBlock(s.block, { share: { shareId: s.shareId, chatId: s.chatId, mode: s.mode, hostPk: s.hostPk, hostName: s.hostName }, readOnly: s.mode !== 'live' && !s.mine })
  }
  ui.joinShare = async (s) => {
    try {
      await store.shareJoin(s)
      ui.toast('ok', s.block === 'agent' ? `Joined ${s.hostName || 'the'} session` : `Joined ${blockMeta(s.block).label}`)
      void ui.openShare({ ...s, members: [...s.members, { me: true, active: true }] })
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  ui.leaveShare = async (s) => {
    try {
      await store.shareLeave(s)
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  ui.endShare = async (s) => {
    if (!(await ui.confirm({ title: 'Stop sharing?', body: `Everyone loses access to ${s.title || blockMeta(s.block).label}.`, confirm: 'Stop sharing', danger: true }))) return
    try {
      await store.shareEnd(s)
    } catch (e) {
      ui.toast('error', e.message)
    }
  }
  /** Share into a chat: `block` is a block kind, or a mounted instance from share.js ({ instanceId, block, title, modes }). */
  ui.startShare = (chatId, blockOrInstance, mode = 'live') => {
    const inst = blockOrInstance && typeof blockOrInstance === 'object' ? blockOrInstance : null
    const block = inst ? inst.block : blockOrInstance
    const meta = blockMeta(block)
    const pathInput = h('input', { class: 'cm-field mono', value: ctx.cwd || '', placeholder: 'Folder or file path', spellcheck: false, 'aria-label': 'Path', 'data-autofocus': '1' })
    const needsPath = !inst && ['files', 'git', 'board', 'notebook', 'canvas'].includes(block)
    let view = false
    const seg = h('div', { class: 'cm-seg' }, [['Can control', false], ['View only', true]].map(([label, v]) => h('button', { class: 'cm-seg-b' + (v === view ? ' on' : ''), type: 'button', on: { click: (e) => { view = v; for (const x of seg.children) x.classList.remove('on'); e.currentTarget.classList.add('on') } } }, label)))
    const go = h('button', { class: 'btn accent', type: 'button', on: { click: async () => {
      go.disabled = true
      try {
        const args = inst ? { instanceId: inst.instanceId } : block === 'agent' ? { view } : needsPath ? { path: pathInput.value.trim() } : {}
        await store.shareStart(chatId, block, args, mode, { title: inst?.title })
        ui.toast('ok', `Shared ${inst ? `“${inst.title}”` : meta.label} with this chat`)
        d.close()
      } catch (e) {
        ui.toast('error', e.message)
        go.disabled = false
      }
    } } }, mode === 'live' ? 'Share live' : 'Share snapshot')
    const d = ui.dialogs.open({
      title: `Share ${meta.label}`,
      icon: meta.icon,
      body: [
        h('p', { class: 'cm-hint' }, inst ? `People in this chat join the ${meta.label.toLowerCase()} you have open (“${inst.title}”) — live where the block supports it.` : meta.blurb + '.'),
        h('div', { class: 'cm-modeline ' + mode }, icon(mode === 'live' ? 'zap' : 'eye', 14), h('span', null, mode === 'live' ? 'Everyone in this chat can join and edit together, live.' : 'People in this chat get a read-only snapshot of this.')),
        needsPath ? [h('label', { class: 'cm-lbl' }, block === 'git' ? 'Repository' : block === 'files' ? 'Folder' : 'Path'), pathInput] : null,
        block === 'agent' ? [h('label', { class: 'cm-lbl' }, 'Access'), seg] : null,
      ],
      actions: [h('button', { class: 'btn quiet', type: 'button', on: { click: () => d.close() } }, 'Cancel'), go],
    })
  }

  // ---------------------------------------------------------------- quick switch (the shell palette) and commands
  async function quickSwitch() {
    const chats = store.chats.filter((c) => !c.archived || c.id === store.openId)
    const items = chats.map((c) => ({ id: c.id, label: c.title, sub: c.last ? c.last.text : '', icon: c.kind === 'group' ? 'users' : c.kind === 'dm' ? 'user' : 'bot', hint: c.unread ? String(c.unread) : '', group: c.pinned ? 'Pinned' : 'Chats' }))
    try {
      const pal = deps.pickerApi || (await import('../ui/palette.js'))
      pal.openPicker({ placeholder: 'Switch conversation…', items, current: store.openId || undefined, onPick: (it) => ui.openChat(it.id) })
    } catch {
      list.focusSearch()
    }
  }
  ui.quickSwitch = quickSwitch

  if (!deps.noCommands) {
    import('../ui/commands.js')
      .then((m) => {
        if (disposed) return
        const offs = m.registerCommands
          ? m.registerCommands([
              { id: 'chats.switch', title: 'Chats: Switch conversation…', group: 'Chats', icon: 'chat', run: () => quickSwitch() },
              { id: 'chats.new', title: 'Chats: New chat', group: 'Chats', icon: 'chat-plus', run: () => ui.openNewChat() },
              { id: 'chats.requests', title: 'Chats: Requests', group: 'Chats', icon: 'inbox', run: () => ui.openRequests() },
            ])
          : null
        if (typeof offs === 'function') cleanups.push(offs)
      })
      .catch(() => {})
  }

  // ---------------------------------------------------------------- keyboard
  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      e.stopPropagation()
      return void quickSwitch()
    }
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const ids = list.visibleIds()
      if (!ids.length) return
      e.preventDefault()
      const i = ids.indexOf(store.openId)
      const n = e.key === 'ArrowDown' ? (i + 1) % ids.length : (i <= 0 ? ids.length : i) - 1
      return void ui.openChat(ids[n])
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (pageEl) return ui.closePage()
      if (infoOpen && store.openId) return ui.toggleInfo(false)
      if (ui.isNarrow() && view === 'thread') return ui.showList()
    }
  })

  // ---------------------------------------------------------------- gate screens (locked / conflict / error / connecting)
  function paintGate() {
    const s = store.status
    const bad = s !== 'ready'
    gate.hidden = !bad
    root.classList.toggle('gated', bad)
    if (!bad) return void gate.replaceChildren()
    let card
    if (s === 'starting') card = h('div', { class: 'cm-gate-card' }, h('div', { class: 'cm-spinner', role: 'status', 'aria-label': 'Connecting' }, icon('spinner', 22)), h('b', null, 'Connecting to chat…'), h('span', null, 'Starting the engine in the background.'))
    else if (s === 'locked') {
      const pass = h('input', { class: 'cm-field', type: 'password', placeholder: 'Passphrase', autocomplete: 'off', 'aria-label': 'Passphrase', 'data-autofocus': '1' })
      const msg = h('div', { class: 'cm-form-msg bad', hidden: true })
      const go = async () => {
        try {
          await store.unlock(pass.value)
        } catch (e) {
          msg.hidden = false
          msg.textContent = e.message
        }
      }
      pass.addEventListener('keydown', (e) => e.key === 'Enter' && go())
      card = h('div', { class: 'cm-gate-card' }, icon('lock', 26), h('b', null, 'Your chats are locked'), h('span', null, 'Enter the passphrase to unlock your identity and history.'), pass, msg, h('button', { class: 'btn accent', type: 'button', on: { click: go } }, 'Unlock'))
      setTimeout(() => pass.focus?.(), 30)
    } else
      card = h('div', { class: 'cm-gate-card' }, icon(s === 'conflict' ? 'terminal' : 'warn', 26), h('b', null, s === 'conflict' ? 'Chat is open in a terminal' : s === 'off' ? 'Chat is turned off' : 'Chat is not connected'), h('span', null, store.statusText || 'Something went wrong starting chat.'), h('button', { class: 'btn accent', type: 'button', on: { click: () => void store.retry().catch(() => {}) } }, 'Try again'))
    gate.replaceChildren(card)
  }
  store.on('list', paintGate)

  // ---------------------------------------------------------------- layout, focus, title
  const applyLayout = () => {
    const w = root.getBoundingClientRect().width || el.clientWidth || 1000
    const narrow = w < NARROW
    root.setAttribute('data-layout', narrow ? 'narrow' : 'wide')
    if (!narrow && view === 'list' && !store.openId && prefs.get('last')) void ui.openChat(prefs.get('last'))
  }
  let ro = null
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      applyLayout()
      thread.relayout()
    })
    ro.observe(root)
  }
  const onFocus = () => store.setWindowFocus(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const onBlur = () => store.setWindowFocus(false)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onFocus)
  }
  store.on('list', () => {
    const n = totalUnread(store.chats)
    ctx.setTitle?.(n ? `Chats (${n})` : 'Chats')
  })
  store.on('open', () => {
    paintMain()
    if (!store.openId && ui.isNarrow()) setView('list')
  })
  store.on('share', (e) => {
    if (e.kind === 'ended' || e.kind === 'left') openShareIds.delete(e.share?.shareId)
    if (e.kind === 'offered' && !e.share.mine && store.openId !== e.chatId) ui.toast('info', `${e.share.hostName || 'Someone'} shared ${blockMeta(e.share.block).label}`)
    if (e.kind === 'joined' && e.share.mine && !e.share.members.every((m) => m.me)) ui.toast('info', `Someone joined your ${blockMeta(e.share.block).label}`)
  })

  // ---------------------------------------------------------------- boot
  applyLayout()
  thread.setInfoOpen(infoOpen)
  paintMain()
  paintGate()
  list.paint()
  apiReady
    .then(() => {
      routeOff = routeEvents(api) // share frames reach the block adapters (share.js)
      return store.init()
    })
    .then(() => {
      setMe(store.me?.pk || '')
      if (disposed) return
      list.paint()
      const args = ctx.args && typeof ctx.args === 'object' ? ctx.args : {}
      const want = args.chatId || args.chat || prefs.get('last')
      if (want && store.chat(want) && !ui.isNarrow()) void ui.openChat(want)
      else if (!ui.isNarrow() && !store.openId) {
        const first = list.visibleIds()[0]
        if (first && args.autoOpen !== false) void ui.openChat(first)
      }
    })
    .catch(() => paintGate())

  return {
    store,
    ui,
    list,
    thread,
    root,
    dispose() {
      disposed = true
      ro?.disconnect()
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
        document.removeEventListener('visibilitychange', onFocus)
      }
      for (const c of cleanups) c()
      list.dispose()
      thread.dispose()
      info.dispose()
      requests.dispose()
      ui.dialogs.close()
      ui.pop.close()
      routeOff?.()
      bindDaemonApi(null)
      store.dispose()
      root.remove()
    },
    focus: () => (store.openId ? thread.focusComposer() : list.focusSearch()),
    resize: () => {
      applyLayout()
      thread.relayout()
    },
  }
}

/** The block registered in blocks/index.js. */
export default {
  id: 'chats',
  title: 'Chats',
  icon: ICON,
  hotkey: 'Ctrl+Alt+C',
  mount(el, ctx) {
    return mountChats(el, ctx)
  },
}
