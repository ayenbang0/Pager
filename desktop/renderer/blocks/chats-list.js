// Chats block conversation list: search, filter chips, requests banner, sections (Pinned, folders, People, Groups, Agents, Archived),
// rows with presence dots, last-message preview, time, unread bubble, mute / pin markers and hover actions. Rows are keyed and
// updated in place so hover, press and entrance animations are never restarted by a data update.
import { FILTERS, previewOf, sectionize, unreadLabel } from './chats-model.js'
import { avatar, frameOnce, setPresence } from './chats-ui.js'
import { fmtListTime, plural } from './chats-util.js'

const FILTER_LABEL = { all: 'All', unread: 'Unread', groups: 'Groups', agents: 'Agents' }

/** Moves/creates children so `parent` holds exactly `nodes` in order, touching only what changed. */
export function syncChildren(parent, nodes) {
  let ref = parent.firstChild
  for (const n of nodes) {
    if (n === ref) ref = ref.nextSibling
    else parent.insertBefore(n, ref)
  }
  while (ref) {
    const next = ref.nextSibling
    parent.removeChild(ref)
    ref = next
  }
}

export function createList(ui) {
  const { h, icon } = ui.b
  const store = ui.store
  const rows = new Map() // chat id -> { el, parts }
  const heads = new Map() // section id -> el
  let query = ''
  let filter = 'all'
  let collapsed = new Set(ui.prefs.get('collapsed', []))
  let flat = [] // visible chat ids in order (keyboard nav)
  let hits = []
  let searchSeq = 0
  let searchTimer = 0

  const newBtn = h('button', { class: 'icon-btn cm-new', type: 'button', title: 'New chat', 'aria-label': 'New chat', on: { click: () => ui.openNewChat() } }, icon('chat-plus', 17))
  const headEl = h('div', { class: 'cm-side-head' }, h('h2', { class: 'cm-side-t' }, 'Chats'), h('span', { class: 'cm-side-tot', hidden: true, title: 'Unread messages' }), newBtn)
  const input = h('input', { class: 'cm-sin', placeholder: 'Search chats and messages', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search chats', on: { input: () => onQuery() } })
  const clear = h('button', { class: 'cm-sclear', type: 'button', hidden: true, title: 'Clear', 'aria-label': 'Clear search', on: { click: () => (setQuery(''), input.focus()) } }, icon('close', 12))
  const search = h('label', { class: 'cm-search' }, icon('search', 15), input, clear)
  const chipEls = new Map()
  const chips = h(
    'div',
    { class: 'cm-fchips', role: 'tablist', 'aria-label': 'Filter chats' },
    FILTERS.map((f) => {
      const b = h('button', { class: 'cm-fchip', type: 'button', role: 'tab', 'data-f': f, on: { click: () => setFilter(f) } }, FILTER_LABEL[f], h('i', { class: 'cm-fcount', hidden: true }))
      chipEls.set(f, b)
      return b
    }),
  )
  const reqCard = h('button', { class: 'cm-reqcard', type: 'button', hidden: true, on: { click: () => ui.openRequests() } }, h('span', { class: 'cm-reqcard-ic' }, icon('inbox', 16)), h('span', { class: 'cm-reqcard-t' }), h('span', { class: 'cm-reqcard-n' }), icon('chev-right', 14))
  const list = h('div', { class: 'cm-list', role: 'list', 'aria-label': 'Conversations' })
  const empty = h('div', { class: 'cm-list-empty', hidden: true })
  const hitList = h('div', { class: 'cm-hits', hidden: true })
  const scroll = h('div', { class: 'cm-list-scroll' }, list, hitList, empty)
  const foot = h('div', { class: 'cm-side-foot' }, h('i', { class: 'cm-net' }), h('span', { class: 'cm-net-t' }))
  const el = h('aside', { class: 'cm-side', 'aria-label': 'Chats' }, headEl, search, chips, reqCard, scroll, foot)

  // ---------------------------------------------------------------- queries
  function setQuery(q) {
    input.value = q
    onQuery()
  }
  function onQuery() {
    query = input.value
    clear.hidden = !query
    paint()
    clearTimeout(searchTimer)
    hits = []
    paintHits()
    if (query.trim().length >= 2 && store.caps.search) {
      const seq = ++searchSeq
      searchTimer = setTimeout(async () => {
        try {
          const r = await store.api.call('chats.search', { query: query.trim(), limit: 20 })
          if (seq === searchSeq) {
            hits = r.hits || []
            paintHits()
          }
        } catch {
          /* search is best effort */
        }
      }, 260)
    }
  }
  function setFilter(f) {
    filter = f
    paint()
  }

  function paintHits() {
    hitList.hidden = !hits.length || !query.trim()
    if (hitList.hidden) return void hitList.replaceChildren()
    hitList.replaceChildren(
      h('div', { class: 'cm-sec-h static' }, h('span', null, 'Messages')),
      ...hits.slice(0, 12).map((x) =>
        h('button', { class: 'cm-hit', type: 'button', on: { click: () => x.chatId && ui.openChat(x.chatId) } }, h('span', { class: 'cm-hit-w' }, x.where, h('time', null, fmtListTime(x.ts))), h('span', { class: 'cm-hit-s' }, h('b', null, x.author ? x.author + ': ' : ''), x.snippet || x.text || '')),
      ),
    )
  }

  // ---------------------------------------------------------------- rows
  function makeRow(chat) {
    const title = h('span', { class: 'cm-crow-t' })
    const time = h('time', { class: 'cm-crow-time' })
    const prev = h('span', { class: 'cm-crow-p' })
    const badges = h('span', { class: 'cm-crow-b' })
    const quick = h('span', { class: 'cm-crow-q' })
    const main = h('span', { class: 'cm-crow-main' }, h('span', { class: 'cm-crow-l1' }, title, h('span', { class: 'cm-crow-tm' }, time, quick)), h('span', { class: 'cm-crow-l2' }, prev, badges))
    const avHost = h('span', { class: 'cm-crow-av' })
    const btn = h('button', { class: 'cm-crow', type: 'button', role: 'listitem', on: { click: () => ui.openChat(btn.__id), contextmenu: (e) => (e.preventDefault(), ui.chatMenu(btn.__id, { x: e.clientX, y: e.clientY, left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY })) } }, avHost, main)
    const r = { el: btn, title, time, prev, badges, quick, avHost, av: null, sig: '' }
    return r
  }

  function paintRow(r, chat) {
    const el = r.el
    el.__id = chat.id
    const sel = store.openId === chat.id
    el.classList.toggle('sel', sel)
    el.classList.toggle('unread', chat.unread > 0)
    el.classList.toggle('muted', chat.muted)
    el.setAttribute('aria-current', sel ? 'true' : 'false')
    el.setAttribute('data-id', chat.id)
    r.title.textContent = chat.title
    r.time.textContent = fmtListTime(chat.last?.ts)
    const p = previewOf(chat)
    r.prev.className = 'cm-crow-p ' + p.kind
    if (p.kind === 'thinking') {
      if (!r.prev.firstChild || r.prev.firstChild.className !== 'cm-dots') r.prev.replaceChildren(h('span', { class: 'cm-dots' }, h('i'), h('i'), h('i')), h('span', null, ' thinking'))
    } else r.prev.textContent = p.text
    const avSig = chat.id + chat.kind + chat.badge + chat.title
    if (r.sig !== avSig) {
      r.sig = avSig
      r.av = avatar(ui.b, chat, { size: 42 })
      r.avHost.replaceChildren(r.av)
    } else setPresence(ui.b, r.av, chat.kind === 'dm' ? chat.online : null)
    const bs = []
    if (chat.asking) bs.push(h('span', { class: 'cm-badge ask', title: 'An agent is waiting for an answer' }, icon('help', 12)))
    if (chat.pinned) bs.push(h('span', { class: 'cm-badge pin', title: 'Pinned' }, icon('pin', 12)))
    if (chat.muted) bs.push(h('span', { class: 'cm-badge mute', title: 'Muted' }, icon('bell-off', 12)))
    if (chat.unread > 0) bs.push(h('span', { class: 'cm-unread-b' + (chat.muted ? ' quiet' : ''), 'aria-label': plural(chat.unread, 'unread message') }, unreadLabel(chat.unread)))
    r.badges.replaceChildren(...bs)
    r.quick.replaceChildren(
      h('span', { class: 'cm-qa', role: 'button', tabindex: -1, title: chat.muted ? 'Unmute' : 'Mute', 'aria-label': chat.muted ? 'Unmute' : 'Mute', on: { click: (e) => (e.stopPropagation(), ui.setPref(chat.id, 'mute', !chat.muted)) } }, icon(chat.muted ? 'bell' : 'bell-off', 13)),
      h('span', { class: 'cm-qa', role: 'button', tabindex: -1, title: chat.archived ? 'Unarchive' : 'Archive', 'aria-label': chat.archived ? 'Unarchive' : 'Archive', on: { click: (e) => (e.stopPropagation(), ui.setPref(chat.id, 'archive', !chat.archived)) } }, icon('archive', 13)),
    )
  }

  function sectionHead(sec) {
    let hd = heads.get(sec.id)
    if (!hd) {
      const label = h('span', { class: 'cm-sec-l' })
      const n = h('span', { class: 'cm-sec-n' })
      hd = h('button', { class: 'cm-sec-h', type: 'button', 'aria-expanded': 'true', on: { click: () => toggle(hd.__id) } }, icon('chev-down', 12), label, n)
      hd.__label = label
      hd.__n = n
      heads.set(sec.id, hd)
    }
    hd.__id = sec.id
    hd.__label.textContent = sec.title
    hd.__n.textContent = sec.count
    hd.classList.toggle('closed', sec.collapsed)
    hd.setAttribute('aria-expanded', sec.collapsed ? 'false' : 'true')
    return hd
  }
  function toggle(id) {
    const key = id === 'archived' ? 'archived:open' : id
    if (id === 'archived') collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key)
    else collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id)
    ui.prefs.set('collapsed', [...collapsed])
    paint()
  }

  // ---------------------------------------------------------------- paint
  const paintSoon = frameOnce(() => paintNow())
  function paint() {
    paintNow()
  }

  function paintNow() {
    const chats = store.chats
    const secs = sectionize(chats, { query, filter, collapsed })
    const nodes = []
    flat = []
    const seen = new Set()
    for (const sec of secs) {
      if (secs.length > 1 || sec.id !== 'results') nodes.push(sectionHead(sec))
      if (sec.collapsed) continue
      for (const c of sec.items) {
        let r = rows.get(c.id)
        if (!r) rows.set(c.id, (r = makeRow(c)))
        paintRow(r, c)
        nodes.push(r.el)
        flat.push(c.id)
        seen.add(c.id)
      }
    }
    for (const [id, r] of rows) if (!seen.has(id)) (r.el.remove(), rows.delete(id))
    for (const [id, hd] of heads) if (!secs.some((s) => s.id === id)) (hd.remove(), heads.delete(id))
    syncChildren(list, nodes)

    // counts on chips, totals, empty state, requests, footer
    const unread = chats.filter((c) => !c.archived && c.unread > 0).length
    for (const [f, b] of chipEls) {
      b.classList.toggle('on', f === filter)
      b.setAttribute('aria-selected', f === filter ? 'true' : 'false')
      const n = b.lastChild
      if (f === 'unread' && unread) (n.textContent = unread), (n.hidden = false)
      else n.hidden = true
    }
    const pend = store.pending.length
    reqCard.hidden = !pend
    if (pend) {
      reqCard.querySelector('.cm-reqcard-t').textContent = 'Requests'
      reqCard.querySelector('.cm-reqcard-n').textContent = pend
    }
    empty.hidden = nodes.length > 0 || !!(hits.length && query.trim())
    if (!empty.hidden) {
      empty.replaceChildren(
        query.trim()
          ? h('div', { class: 'cm-empty-card' }, icon('search', 22), h('b', null, 'No matches'), h('span', null, 'Try another name or word.'))
          : filter !== 'all'
            ? h('div', { class: 'cm-empty-card' }, icon('check-circle', 22), h('b', null, filter === 'unread' ? 'All caught up' : 'Nothing here'), h('span', null, filter === 'unread' ? 'No unread chats.' : 'No chats in this view.'))
            : h('div', { class: 'cm-empty-card' }, icon('chat', 24), h('b', null, 'No chats yet'), h('span', null, 'Add a friend with their contact code to start.'), h('button', { class: 'btn sm accent', type: 'button', on: { click: () => ui.openNewChat() } }, 'New chat')),
      )
    }
    const status = store.status
    foot.classList.toggle('bad', status !== 'ready')
    foot.classList.toggle('off', status === 'ready' && !store.online)
    foot.lastChild.textContent = status !== 'ready' ? statusLabel(status) : store.online ? (store.onlineCount ? `${store.onlineCount} online` : 'Connected') : 'Offline'
    const totalUnread = chats.filter((c) => !c.archived && !c.muted).reduce((a, c) => a + c.unread, 0)
    const tot = headEl.children[1]
    tot.hidden = !totalUnread
    tot.textContent = totalUnread > 99 ? '99+' : String(totalUnread)
  }

  const statusLabel = (s) => ({ off: 'Chat is off', starting: 'Connecting…', locked: 'Locked', conflict: 'In use by a terminal', error: 'Not connected' })[s] || s

  const offs = [store.on('list', () => paintSoon()), store.on('open', () => paintSoon())]

  // keyboard: arrows move between rows, Enter opens, Escape clears the search
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation()
      return setQuery('')
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cur = e.target.closest?.('.cm-crow')
      if (!cur && e.target !== input) return
      const ids = flat
      if (!ids.length) return
      const i = cur ? ids.indexOf(cur.__id) : -1
      const next = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)
      e.preventDefault()
      rows.get(ids[next])?.el.focus()
    }
    if (e.key === 'Enter' && e.target === input && flat[0]) ui.openChat(flat[0])
  })

  return {
    el,
    paint,
    focusSearch: () => (input.focus(), input.select?.()),
    visibleIds: () => flat,
    setQuery,
    get query() {
      return query
    },
    dispose() {
      for (const o of offs) o()
      clearTimeout(searchTimer)
    },
  }
}
