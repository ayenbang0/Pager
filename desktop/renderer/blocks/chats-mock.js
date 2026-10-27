// Chats block: an in-memory stand-in for the daemon's chats.* requests and events (local://chats-contract.md), used by the
// harness page, the plain-browser mock window and the tests. It follows the contract's shapes and ALSO exercises the optional
// features the real engine lacks (reply quotes, edit/delete, attachments, typing); those ride on `caps`, which the mock sets true.
// NOTHING here proves the real daemon: it only proves the UI against these shapes.

const HOUR = 3_600_000
const DAY = 86_400_000

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PK = (n) => String(n).padStart(2, '0').repeat(32).slice(0, 64)
const hex32 = (n) => PK(n).slice(0, 32)

// 1x1 transparent png: the fallback when no canvas exists (node tests)
const PNG_1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A calm gradient image with a few soft shapes; real pixels in a browser, a 1x1 png under node. */
export function makeImage(w, h, hue) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return PNG_1
  try {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    if (!g) return PNG_1
    const grad = g.createLinearGradient(0, 0, w, h)
    grad.addColorStop(0, `hsl(${hue} 52% 38%)`)
    grad.addColorStop(1, `hsl(${(hue + 48) % 360} 58% 22%)`)
    g.fillStyle = grad
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < 5; i++) {
      g.beginPath()
      g.fillStyle = `hsla(${(hue + i * 30) % 360} 70% 70% / .16)`
      g.arc(((i * 0.23 + 0.12) % 1) * w, ((i * 0.37 + 0.2) % 1) * h, h * (0.18 + i * 0.05), 0, Math.PI * 2)
      g.fill()
    }
    return c.toDataURL('image/png')
  } catch {
    return PNG_1
  }
}

export const MOCK_COMMANDS = [
  { name: 'help', usage: '/help', summary: 'List commands' },
  { name: 'code', usage: '/code', summary: 'Show your contact code' },
  { name: 'add', usage: '/add <code> [note]', summary: 'Send a contact request' },
  { name: 'accept', usage: '/accept [n]', summary: 'Accept a pending request or invite' },
  { name: 'decline', usage: '/decline [n]', summary: 'Decline a pending request or invite' },
  { name: 'open', usage: '/open <name>', summary: 'Open a conversation' },
  { name: 'remove', usage: '/remove <name>', summary: 'Remove a contact' },
  {
    name: 'group',
    usage: '/group new|invite|rename|members|leave',
    summary: 'Manage groups',
    subs: [
      { name: 'new', usage: '/group new <name>', summary: 'Create a group' },
      { name: 'invite', usage: '/group invite <name>', summary: 'Invite a contact (creator only)' },
      { name: 'rename', usage: '/group rename <new name>', summary: 'Rename this group (creator only)' },
      { name: 'members', usage: '/group members', summary: 'People, bots and call rooms' },
      { name: 'leave', usage: '/group leave', summary: 'Leave this group for good' },
    ],
  },
  { name: 'bot', usage: '/bot add|edit|model|effort|list', summary: 'AI bots in the open group that reply when relevant' },
  { name: 'call', usage: '/call [room|setup]', summary: 'Voice call in the open chat, or a named room in a group' },
  { name: 'hangup', usage: '/hangup', summary: 'Leave the call' },
  { name: 'mute', usage: '/mute', summary: 'Mute or unmute your microphone' },
  { name: 'ping', usage: '/ping <name>', summary: 'Play a sound on their machine' },
  { name: 'requests', usage: '/requests', summary: 'Requests and invites to accept or decline' },
  { name: 'terminal', usage: '/terminal [new|close]', summary: 'Open the Terminal tab', hostOnly: 'The desktop has real terminal panes' },
  { name: 'doc', usage: '/doc new <name> [in <chat>]', summary: 'Shared Markdown documents (Docs tab)' },
  { name: 'agent', usage: '/agent <name> <task>', summary: 'Run coding agents in isolated worktrees' },
  { name: 'search', usage: '/search <text>', summary: 'Find text in your chats and the agent room (newest 20 matches)' },
  { name: 'settings', usage: '/settings [section]', summary: 'Open Settings' },
]

const WORDS = 'ship the build before lunch and then check logs deploy review merge ping again later maybe tomorrow works fine sounds good agreed lets sync about that the new design feels calmer smaller radius softer shadow should we keep it nice thanks done running tests green flaky retry cache fixed typo docs update release notes'.split(' ')

/**
 * createMockChats({ now, seed, long, caps, delayMs }) -> { api, state, emit, simulate }
 * `long` is the number of messages in the long fixture thread (default 420).
 */
export function createMockChats(opts = {}) {
  const now = opts.now ?? Date.now()
  const rand = rng(opts.seed ?? 7)
  const delay = opts.delayMs ?? 0
  const caps = { edit: true, delete: true, reply: true, attachments: true, typing: true, avatars: false, removeMember: false, lastSeen: true, react: true, groups: true, bots: true, calls: true, agents: true, ai: true, ping: true, docs: true, search: true, pin: true, mute: true, archive: true, share: { transport: true, blocks: ['canvas', 'board', 'notebook', 'files', 'tasks', 'git', 'screen', 'agent'], modes: ['live', 'readonly', 'snapshot'], agent: 'live' }, ...(opts.caps || {}) }
  const me = { pk: PK(1), code: 'pgr1-' + 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(2).slice(0, 56), name: 'Mira', badge: '🌿' }
  const listeners = new Set()
  const timers = new Set()
  let seqNo = 100
  let tick = 0
  let status = opts.status || 'ready'
  let call = null
  const settings = { notify: true, soundMode: 'all', notifySound: 'chime', ringSound: 'ring', alerts: true, updateCheck: true, acp: true, web: true, agents: true, lan: false, folders: [{ name: 'Work', ids: [] }], name: me.name, badge: 'auto' }

  const people = [
    { pk: PK(2), name: 'Ada Lovelace', online: true, ls: now - 4 * 60_000 },
    { pk: PK(3), name: 'Grace Hopper', online: true, ls: now },
    { pk: PK(4), name: 'Linus T', online: false, ls: now - 3 * HOUR },
    { pk: PK(5), name: 'Margaret H', online: false, ls: now - 30 * HOUR },
    { pk: PK(6), name: 'Alan Turing', online: false, ls: now - 6 * DAY },
    { pk: PK(7), name: 'Katherine J', online: true, ls: now },
  ]
  const byName = (n) => people.find((p) => p.name === n)

  const chats = new Map()
  const msgs = new Map()
  const view = new Map() // chatId -> { pinned, muted, archived, folder }
  const groups = new Map()

  const add = (c) => {
    chats.set(c.id, { call: 0, thinking: false, unread: 0, badge: '', members: 0, ...c })
    if (!msgs.has(c.id)) msgs.set(c.id, [])
    if (!view.has(c.id)) view.set(c.id, { pinned: false, muted: false, archived: false, folder: '' })
    return c
  }
  const push = (chatId, m) => {
    const list = msgs.get(chatId)
    const n = ++seqNo
    const authorKey = m.mine ? me.pk : m.authorKey
    const msg = { key: `${authorKey}:${n}`, kind: 'text', status: m.mine ? 'read' : null, reactions: [], ...m, authorKey }
    list.push(msg)
    return msg
  }

  // --- people and groups
  for (const p of people) add({ id: `dm:${hex32(Number(p.pk.slice(0, 2)))}`, kind: 'dm', title: p.name, peer: p.pk, online: p.online })
  const dm = (name) => chats.get(`dm:${hex32(Number(byName(name).pk.slice(0, 2)))}`)
  const mkGroup = (n, title, memberNames, extra = {}) => {
    const id = `grp:${hex32(n + 40)}`
    add({ id, kind: 'group', title, peer: null, online: null, creator: !!extra.creator, members: memberNames.length + 1 })
    groups.set(id, { creator: !!extra.creator, members: memberNames, bots: extra.bots || [], rooms: extra.rooms || [] })
    return chats.get(id)
  }
  const crew = mkGroup(1, 'Pager crew', ['Ada Lovelace', 'Grace Hopper', 'Linus T', 'Katherine J'], { creator: true, bots: [{ name: 'scribe', host: me.pk, mine: true, backend: 'omp', model: 'sonnet-5.5', job: 'Summarise threads and keep the changelog tidy', busy: false }], rooms: [{ room: 'main', people: [], mine: false }] })
  const hike = mkGroup(2, 'Weekend hike', ['Margaret H', 'Alan Turing'])
  const review = mkGroup(3, 'Design review', ['Ada Lovelace', 'Katherine J'], { creator: true })
  const old = mkGroup(4, 'Old project', ['Linus T'])
  add({ id: 'agents', kind: 'room', title: 'Agents', peer: null, online: null })
  add({ id: 'agent:omp', kind: 'agent', title: 'omp', peer: null, online: null })
  add({ id: 'ai', kind: 'ai', title: 'AI', peer: null, online: null })

  view.get(dm('Ada Lovelace').id).pinned = true
  view.get(crew.id).pinned = true
  view.get(hike.id).muted = true
  view.get(review.id).folder = 'Work'
  view.get(old.id).archived = true
  settings.folders[0].ids.push(review.id)

  // --- a long thread with every feature in it
  const ada = byName('Ada Lovelace')
  const longN = opts.long ?? 420
  let t = now - 12 * DAY
  const adaId = dm('Ada Lovelace').id
  const adaList = msgs.get(adaId)
  for (let i = 0; i < longN; i++) {
    t += Math.floor(rand() * (i % 17 === 0 ? 9 * HOUR : 14 * 60_000)) + 20_000
    if (t > now - 5 * 60_000) t = now - 5 * 60_000 - (longN - i) * 1000
    const mine = rand() < 0.45
    const words = Array.from({ length: 2 + Math.floor(rand() * 18) }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')
    const n = ++seqNo
    const authorKey = mine ? me.pk : ada.pk
    const m = { key: `${authorKey}:${n}`, ts: t, authorName: mine ? me.name : ada.name, authorKey, mine, kind: 'text', text: words.charAt(0).toUpperCase() + words.slice(1) + (rand() < 0.3 ? '.' : ''), status: mine ? 'read' : null, reactions: [] }
    adaList.push(m)
  }
  // sprinkle: reactions, replies, links, code, mentions, images, edits, deletes near the end so screenshots show them
  const at = (back) => adaList[adaList.length - 1 - back]
  const sprinkle = () => {
    at(24).reactions = [{ emoji: '👍', count: 2, mine: true }, { emoji: '🎉', count: 1, mine: false }]
    at(21).text = 'Release notes are here: https://example.com/pager/changelog?v=1.6 (the section on chats is new).'
    at(18).text = 'Try this:\n```js\nconst unread = chats.filter((c) => c.unread > 0)\nconsole.log(unread.length)\n```\nit keeps the order.'
    at(15).text = 'Can you review `chats.js` before lunch?'
    at(14).replyTo = { key: at(15).key, authorName: at(15).authorName, text: at(15).text }
    at(14).text = 'Yes, on it. Back in ten.'
    at(14).reactions = [{ emoji: '❤️', count: 1, mine: false }]
    at(11).edited = true
    at(11).text = 'Moved the standup to 10:30, sorry for the churn'
    at(9).deleted = true
    at(9).text = ''
    at(6).attachments = [{ id: 'img1', name: 'sunrise.png', mime: 'image/png', size: 183_204, w: 640, h: 400, dataUrl: makeImage(640, 400, 210) }]
    at(6).text = 'Look at this light'
    at(5).attachments = [{ id: 'f1', name: 'pager-design-notes-final-v3.pdf', mime: 'application/pdf', size: 2_481_000 }]
    at(5).text = ''
    at(3).text = '@Mira can you also check the narrow layout?'
    at(3).mine = false
    at(3).authorKey = ada.pk
    at(3).authorName = ada.name
    at(2).text = 'Doing that now'
    at(1).text = '😄'
    at(0).text = 'Ship it when ready, I will be offline for an hour'
    at(0).mine = false
    at(0).authorKey = ada.pk
    at(0).authorName = ada.name
    at(0).status = null
    // statuses on my newest messages
    let k = 0
    for (let i = adaList.length - 1; i >= 0 && k < 8; i--) if (adaList[i].mine) adaList[i].status = ['sent', 'delivered', 'delivered', 'read', 'read', 'read', 'read', 'read'][k++]
  }
  sprinkle()

  const gm = (chatId, who, text, ago, extra = {}) => {
    const p = who === 'me' ? me : byName(who)
    const n = ++seqNo
    msgs.get(chatId).push({ key: `${p.pk}:${n}`, ts: now - ago, authorName: who === 'me' ? me.name : who, authorKey: p.pk, mine: who === 'me', kind: 'text', text, status: who === 'me' ? 'read' : null, reactions: [], ...extra })
  }
  gm(crew.id, 'Ada Lovelace', 'Morning all. Who is taking the release today?', 3 * DAY + HOUR)
  gm(crew.id, 'Grace Hopper', 'I can. Checking the changelog first.', 3 * DAY)
  msgs.get(crew.id).push({ key: `sys:${++seqNo}`, ts: now - 2 * DAY, authorName: '', authorKey: '', mine: false, kind: 'system', text: 'Katherine J joined the group', status: null, reactions: [] })
  gm(crew.id, 'Katherine J', 'Hi! Happy to be here.', 2 * DAY - 60_000)
  gm(crew.id, 'me', 'Welcome! The design notes live in the shared docs.', 2 * DAY - 90_000)
  gm(crew.id, 'Linus T', 'Reminder: `npm run build` before you push, the lint step is picky.', 20 * HOUR, { reactions: [{ emoji: '👍', count: 3, mine: true }] })
  gm(crew.id, 'Ada Lovelace', 'New rule of thumb: calmer is better. https://pager.example/chats', 3 * HOUR)
  gm(crew.id, 'Grace Hopper', 'Agreed. @Mira can you take the bubble shadows?', 2 * HOUR)
  gm(crew.id, 'me', 'On it. Softer, layered, no hard edges.', 2 * HOUR - 120_000, { status: 'read' })
  gm(hike.id, 'Margaret H', 'Trail is dry, boots optional.', 5 * HOUR)
  gm(hike.id, 'Alan Turing', 'Bring water. Lots of water.', 4 * HOUR)
  for (let i = 0; i < 12; i++) gm(hike.id, i % 2 ? 'Alan Turing' : 'Margaret H', ['Meet at 8?', 'Parking is full', 'Taking the 7:40 bus', 'See you at the gate'][i % 4], 3 * HOUR - i * 60_000)
  gm(review.id, 'Katherine J', 'Mock-ups are in the board.', 26 * HOUR)
  gm(dm('Grace Hopper').id, 'Grace Hopper', 'Do you have the cert for the build server?', 40 * 60_000)
  gm(dm('Linus T').id, 'me', 'Merged, thanks for the fix.', 8 * HOUR)
  gm(dm('Linus T').id, 'Linus T', 'Anytime.', 7 * HOUR + 50 * 60_000)
  gm(dm('Margaret H').id, 'Margaret H', 'Lunch Thursday?', 2 * DAY)
  gm(dm('Alan Turing').id, 'Alan Turing', 'Sent the draft. No rush.', 9 * DAY)
  gm(dm('Katherine J').id, 'Katherine J', 'Welcome aboard!', 2 * DAY)
  gm(old.id, 'Linus T', 'Archiving this one.', 40 * DAY)
  gm('agents', 'me', '@omp tidy the readme', 50 * 60_000)
  msgs.get('agents').push({ key: `${PK(9)}:${++seqNo}`, ts: now - 49 * 60_000, authorName: 'omp', authorKey: PK(9), mine: false, agent: true, markdown: true, kind: 'text', text: 'Done. I rewrote the **Install** section and fixed two broken links:\n\n- `docs/setup.md`\n- `docs/calls.md`\n\n```diff\n- Run pager install\n+ Run `pager desktop install`\n```', status: null, reactions: [] })
  msgs.get('ai').push({ key: `${PK(9)}:${++seqNo}`, ts: now - 6 * HOUR, authorName: 'AI', authorKey: PK(9), mine: false, agent: true, markdown: true, kind: 'text', text: 'Ask me anything about your chats. I only see this conversation.', status: null, reactions: [] })
  msgs.get('agent:omp').push({ key: `${PK(9)}:${++seqNo}`, ts: now - 70 * 60_000, authorName: 'omp', authorKey: PK(9), mine: false, agent: true, markdown: true, kind: 'text', text: 'Ready when you are.', status: null, reactions: [] })

  // --- shared blocks and shared agent sessions (timeline share cards; local://chats-contract.md "Sharing")
  const shares = new Map() // shareId -> ShareView
  let shareSeq = 0
  const shareMsg = (s) => ({ key: 'share:' + s.shareId, ts: s.startedAt, authorName: s.hostName, authorKey: s.hostPk, mine: s.mine, kind: 'share', text: '', status: null, share: s })
  const pushShare = (s) => {
    shares.set(s.shareId, s)
    msgs.get(s.chatId)?.push(shareMsg(s))
  }
  const labelOf = (b) => ({ canvas: 'Canvas', board: 'Board', notebook: 'Notebook', files: 'Files', tasks: 'Tasks', git: 'Git', screen: 'Screen', agent: 'Agent session' })[b] || 'Block'
  const snapshotOf = (s) => (s.block === 'canvas' ? { shapes: [] } : s.block === 'board' ? { lanes: [] } : { md: '# ' + (s.title || 'notes') })
  const adaShared = 'shared:' + ada.pk
  add({ id: adaShared, kind: 'shared', title: 'Agents with Ada', peer: null, online: null, members: 2 })
  pushShare({ shareId: 'sh:cv1', chatId: crew.id, block: 'canvas', title: 'Release warm-up', hostPk: ada.pk, hostName: 'Ada Lovelace', mine: false, mode: 'live', state: 'live', joined: true, hostOnline: true, members: [{ pk: ada.pk, name: 'Ada Lovelace', hue: 200, active: true }, { pk: me.pk, name: me.name, me: true, hue: 120, active: true }], startedAt: now - 26 * HOUR })
  pushShare({ shareId: 'sh:fs1', chatId: review.id, block: 'files', title: 'pager-design-notes.md', hostPk: me.pk, hostName: me.name, mine: true, mode: 'snapshot', state: 'live', joined: true, hostOnline: true, members: [{ pk: me.pk, name: me.name, me: true, hue: 120, active: true }], startedAt: now - 3 * DAY })
  pushShare({ shareId: 'sh:bd1', chatId: hike.id, block: 'board', title: 'Trail planning', hostPk: PK(5), hostName: 'Margaret H', mine: false, mode: 'readonly', state: 'ended', joined: false, hostOnline: false, endedAt: now - 5 * HOUR, members: [{ pk: PK(5), name: 'Margaret H', hue: 280, active: false }], startedAt: now - 2 * DAY })
  pushShare({ shareId: 'agent:' + ada.pk, chatId: adaId, block: 'agent', title: 'omp · fix the login bug', hostPk: ada.pk, hostName: 'Ada Lovelace', mine: false, mode: 'readonly', state: 'live', joined: false, hostOnline: true, members: [{ pk: ada.pk, name: 'Ada Lovelace', hue: 200, active: true }], startedAt: now - 40 * 60_000, agent: { name: 'omp', state: 'asking', summary: 'Which draft do you prefer?' }, asking: true, openChatId: adaShared })
  gm(adaShared, 'Ada Lovelace', 'omp is fixing the login bug — watch along live', 39 * 60_000)
  msgs.get(adaShared).push({ key: `${PK(9)}:${++seqNo}`, ts: now - 38 * 60_000, authorName: 'omp', authorKey: PK(9), mine: false, agent: true, markdown: true, kind: 'text', text: 'I found two call sites that skip the refresh. Which draft do you prefer?\n\n**A** — refresh after every save\n**B** — refresh on focus only', status: null, reactions: [] })
  msgs.get(adaShared).push({ key: `${PK(9)}:${++seqNo}`, ts: now - 20 * 60_000, authorName: 'omp', authorKey: PK(9), mine: false, agent: true, markdown: true, kind: 'text', text: 'Done. Both call sites now refresh on save.', status: null, reactions: [] })
  chats.get(dm('Grace Hopper').id).unread = 1
  chats.get(hike.id).unread = 12
  chats.get(crew.id).unread = 2
  chats.get('agents').asking = true
  chats.get('agents').unread = 1
  chats.get(dm('Katherine J').id).unread = 0

  let pending = [
    { n: 1, id: `contact:${PK(8)}`, type: 'contact', label: 'Dennis R', note: 'We met at the meetup, saying hi!' },
    { n: 2, id: `group:grp:${hex32(77)}`, type: 'group', label: 'Compilers club', note: 'Invited by Grace Hopper' },
    { n: 3, id: `session:${PK(2)}`, type: 'session', label: "Ada's omp session", note: 'Ada Lovelace invited you to watch her agents fix the login bug' },
  ]
  if (opts.noRequests) pending = []

  // --- views
  const lastOf = (id) => {
    const list = msgs.get(id).filter((m) => m.kind === 'text' && !m.deleted)
    const l = list[list.length - 1]
    if (!l) return undefined
    return { ts: l.ts, text: (l.attachments?.length && !l.text ? `📎 ${l.attachments[0].name}` : l.text).slice(0, 140), mine: l.mine, authorName: l.authorName, status: l.status }
  }
  const summary = (id) => {
    const c = chats.get(id)
    const v = view.get(id)
    const out = { ...c, ...v }
    const l = lastOf(id)
    if (l) out.last = l
    else delete out.last
    if (!out.folder) delete out.folder
    return out
  }
  const sorted = () =>
    [...chats.keys()]
      .map(summary)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.last?.ts ?? 0) - (a.last?.ts ?? 0))

  const groupView = (id) => {
    const g = groups.get(id)
    const c = chats.get(id)
    if (!g) return undefined
    return {
      id,
      title: c.title,
      people: [{ pk: me.pk, name: me.name, me: true, creator: g.creator, online: true, contact: false }, ...g.members.map((n) => ({ pk: byName(n).pk, name: n, me: false, creator: !g.creator && n === g.members[0], online: byName(n).online, contact: true, room: undefined }))],
      bots: g.bots,
      rooms: g.rooms,
    }
  }

  const emit = (ev) => {
    for (const fn of [...listeners]) fn(ev)
  }
  const changed = (ids, reason = 'mock') => emit({ event: 'chats_changed', ids, chats: ids ? ids.map((i) => summary(i)) : sorted(), removed: [], pending, online: true, onlineCount: people.filter((p) => p.online).length, reason })
  const later = (ms, fn) => {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
    return id
  }
  const fail = (code, text) => Promise.reject(new Error(`${code}: ${text}`))
  const ok = (extra = {}) => ({ toasts: [], ...extra })

  const stateResult = () => ({ status, statusText: status === 'conflict' ? 'Pager is open in a terminal (pid 4321) and is using chat on C:\\Users\\mira\\.pager. Chat connects here by itself when you quit it.' : status === 'locked' ? 'Passphrase needed' : '', me, online: true, onlineCount: people.filter((p) => p.online).length, encrypted: false, agentsOn: true, version: '1.6.0', update: null, caps, chats: sorted(), pending, call, openChat: null })

  const handlers = {
    'chats.caps': () => caps,
    'chats.state': () => stateResult(),
    'chats.unlock': ({ passphrase }) => {
      if (passphrase !== 'pager') return fail('invalid', 'Wrong passphrase')
      status = 'ready'
      return stateResult()
    },
    'chats.retry': () => ({}),
    'chats.focus': () => ({}),
    'chats.commands': () => MOCK_COMMANDS,
    'chats.command': ({ line }) => ok({ lines: [`ran ${line}`] }),
    'chats.stats': () => ({}),
    'chats.search': ({ query }) => {
      const q = String(query || '').toLowerCase()
      const hits = []
      for (const [id, list] of msgs) {
        for (let i = list.length - 1; i >= 0 && hits.length < 20; i--) {
          const m = list[i]
          if (m.kind === 'text' && m.text.toLowerCase().includes(q)) hits.push({ chatId: id, where: chats.get(id).title, author: m.authorName, ts: m.ts, text: m.text, snippet: m.text.slice(0, 120) })
        }
      }
      return { hits, total: hits.length }
    },
    'chats.open': ({ chatId, before, limit = 50, markRead = true }) => {
      const c = chats.get(chatId)
      if (!c) return fail('not_found', 'No such chat')
      const all = msgs.get(chatId)
      let end = all.length
      if (before) {
        const i = all.findIndex((m) => m.key === before)
        end = i < 0 ? 0 : i
      }
      const start = Math.max(0, end - limit)
      if (markRead && !before) c.unread = 0
      const out = { chat: summary(chatId), messages: all.slice(start, end).map((m) => ({ ...m })), hasMore: start > 0, call }
      if (c.kind === 'group') {
        out.group = groupView(chatId)
        out.bots = groups.get(chatId).bots
        out.rooms = groups.get(chatId).rooms
      }
      return out
    },
    'chats.send': ({ chatId, text, replyTo, attachments }) => {
      const c = chats.get(chatId)
      if (!c) return fail('not_found', 'No such chat')
      if (String(text).length > 4000) return fail('invalid', 'Message too long (4000 max)')
      if (opts.failSend) return fail('failed', 'The peer link is down')
      const r = replyTo && msgs.get(chatId).find((m) => m.key === replyTo)
      const m = push(chatId, {
        ts: Date.now(),
        authorName: me.name,
        mine: true,
        status: 'sent',
        text,
        replyTo: r ? { key: r.key, authorName: r.authorName, text: r.text } : undefined,
        attachments: (attachments || []).map((a, i) => ({ id: `up${Date.now()}${i}`, name: a.name, mime: a.mime, size: a.size, dataUrl: a.mime?.startsWith('image/') && typeof a.data === 'string' ? `data:${a.mime};base64,${a.data}` : undefined })),
      })
      changed([chatId], 'send')
      later(500 + delay, () => ((m.status = 'delivered'), changed([chatId], 'ack')))
      if (c.kind === 'dm' || c.kind === 'group') {
        later(900 + delay, () => {
          if (caps.typing) emit({ event: 'chat_typing', chatId, name: c.kind === 'dm' ? c.title : 'Ada Lovelace', on: true })
        })
        later(2400 + delay, () => {
          m.status = 'read'
          if (caps.typing) emit({ event: 'chat_typing', chatId, name: c.kind === 'dm' ? c.title : 'Ada Lovelace', on: false })
          const who = c.kind === 'dm' ? byName(c.title) : byName('Ada Lovelace')
          const reply = push(chatId, { ts: Date.now(), authorName: who.name, authorKey: who.pk, mine: false, text: ['Got it, thanks!', 'Makes sense.', 'Sounds good to me', 'Haha, nice 😄', 'Will look at it after lunch.'][tick++ % 5] })
          emit({ event: 'chat_message', chatId, message: { ...reply }, mine: false })
        })
      }
      return ok({ key: m.key })
    },
    'chats.edit': ({ chatId, key, text }) => {
      const m = msgs.get(chatId)?.find((x) => x.key === key)
      if (!m || !m.mine) return fail('not_found', 'No such message')
      m.text = text
      m.edited = true
      changed([chatId], 'edit')
      return {}
    },
    'chats.delete': ({ chatId, key }) => {
      const m = msgs.get(chatId)?.find((x) => x.key === key)
      if (!m || !m.mine) return fail('not_found', 'No such message')
      m.deleted = true
      m.text = ''
      m.attachments = []
      changed([chatId], 'delete')
      return {}
    },
    'chats.react': ({ chatId, key, emoji }) => {
      const m = msgs.get(chatId)?.find((x) => x.key === key)
      if (!m) return fail('not_found', 'No such message')
      const mineR = m.reactions.find((r) => r.emoji === emoji && r.mine)
      if (mineR) {
        mineR.count--
        mineR.mine = false
        m.reactions = m.reactions.filter((r) => r.count > 0)
      } else {
        const same = m.reactions.find((r) => r.emoji === emoji)
        if (same) (same.count++, (same.mine = true))
        else m.reactions.push({ emoji, count: 1, mine: true })
      }
      return {}
    },
    'chats.read': ({ chatId }) => {
      const c = chats.get(chatId)
      if (c) c.unread = 0
      return {}
    },
    'chats.stop': () => ({ stopped: false }),
    'chats.typing': () => ({ supported: caps.typing }),
    'chats.pin': ({ chatId, on }) => (view.get(chatId) && (view.get(chatId).pinned = !!on), changed([chatId], 'pin'), {}),
    'chats.mute': ({ chatId, on }) => (view.get(chatId) && (view.get(chatId).muted = !!on), changed([chatId], 'mute'), {}),
    'chats.archive': ({ chatId, on }) => (view.get(chatId) && (view.get(chatId).archived = !!on), changed([chatId], 'archive'), {}),
    'chats.contact.add': ({ code }) => {
      const c = String(code || '').trim().toLowerCase()
      if (c === me.code) return fail('rejected', 'That is your own code')
      if (!/^pgr1-[ybndrfg8ejkmcpqxot1uwisza345h769]{56}$/.test(c)) return fail('rejected', 'Not a pager contact code (expected pgr1-…)')
      return ok({ message: 'Request queued. They will see it when they are online.' })
    },
    'chats.contact.remove': ({ peer }) => ok({ message: `Removed ${peer}` }),
    'chats.requests': () => pending,
    'chats.request.accept': ({ id }) => {
      const p = pending.find((x) => x.id === id)
      pending = pending.filter((x) => x.id !== id)
      if (p?.type === 'contact') {
        add({ id: `dm:${hex32(88)}`, kind: 'dm', title: p.label, peer: PK(8), online: false })
        people.push({ pk: PK(8), name: p.label, online: false, ls: now })
      }
      changed(null, 'accept')
      emit({ event: 'chat_request', pending })
      return ok({ message: `Accepted ${p?.label ?? ''}` })
    },
    'chats.request.decline': ({ id }) => {
      pending = pending.filter((x) => x.id !== id)
      emit({ event: 'chat_request', pending })
      return ok({ message: 'Declined' })
    },
    'chats.ping': () => ok({ message: 'Pinged' }),
    'chats.group.new': ({ title }) => {
      const g = mkGroup(50 + chats.size, String(title), [], { creator: true })
      changed(null, 'group')
      return { chatId: g.id }
    },
    'chats.group.rename': ({ chatId, title }) => {
      chats.get(chatId).title = String(title)
      changed([chatId], 'rename')
      return {}
    },
    'chats.group.invite': ({ chatId, peer }) => {
      const g = groups.get(chatId)
      const p = people.find((x) => x.name === peer || x.pk === peer)
      if (!p) return fail('not_found', 'No such contact')
      if (!g.members.includes(p.name)) g.members.push(p.name)
      chats.get(chatId).members = g.members.length + 1
      changed([chatId], 'invite')
      return {}
    },
    'chats.group.leave': ({ chatId }) => {
      chats.delete(chatId)
      groups.delete(chatId)
      emit({ event: 'chats_changed', ids: [chatId], chats: [], removed: [chatId], pending, online: true, onlineCount: 3, reason: 'leave' })
      return {}
    },
    'chats.group.members': ({ chatId }) => groupView(chatId),
    'chats.bots.list': ({ chatId }) => ({ bots: groups.get(chatId)?.bots ?? [], backends: ['omp', 'claude', 'ollama'], default: 'omp' }),
    'chats.bots.add': ({ chatId, name, backend, job }) => {
      groups.get(chatId).bots.push({ name, host: me.pk, mine: true, backend: backend || 'omp', job, busy: false })
      return ok({ bots: groups.get(chatId).bots })
    },
    'chats.bots.remove': ({ chatId, name }) => {
      const g = groups.get(chatId)
      g.bots = g.bots.filter((b) => b.name !== name)
      return ok({ bots: g.bots })
    },
    'chats.bots.stop': () => ok(),
    'chats.call.state': () => ({ call, ready: true, rooms: [] }),
    'chats.call.join': ({ chatId, room }) => {
      const c = chats.get(chatId)
      call = { conv: chatId, label: c.kind === 'dm' ? c.title : `#${c.title} · ${room || 'main'}`, room: room || (c.kind === 'dm' ? 'call' : 'main'), muted: false, people: [{ name: me.name, me: true, speaking: false }, { name: c.kind === 'dm' ? c.title : 'Ada Lovelace', me: false, speaking: true }] }
      emit({ event: 'chat_call', chatId, kind: 'state', call, rooms: [{ room: call.room, people: call.people.map((p) => p.name), mine: true }] })
      return ok()
    },
    'chats.call.hangup': () => {
      const chatId = call?.conv
      call = null
      emit({ event: 'chat_call', chatId: chatId || '', kind: 'state', call: null, rooms: [] })
      return ok()
    },
    'chats.call.mute': () => {
      if (call) call.muted = !call.muted
      emit({ event: 'chat_call', chatId: call?.conv || '', kind: 'state', call, rooms: [] })
      return { muted: !!call?.muted }
    },
    'chats.profile.set': ({ name, badge }) => {
      if (name) me.name = String(name)
      if (badge !== undefined) me.badge = String(badge)
      return { me }
    },
    'chats.settings.get': () => ({ settings, name: me.name, code: me.code, version: '1.6.0', update: null, locks: {}, folders: settings.folders.map((f) => ({ name: f.name, count: f.ids.length })), agentsOn: true, privacy: { encrypted: false, net: { listening: true, contacts: people.map((p) => ({ name: p.name, pending: false, online: p.online, caps: [] })), stats: '', logPath: '' } } }),
    'chats.settings.set': ({ key, value }) => {
      if (key === 'folder.new') {
        settings.folders.push({ name: value?.name ?? value, ids: [] })
        return ok()
      }
      if (key === 'folder.remove') {
        settings.folders = settings.folders.filter((f) => f.name !== (value?.name ?? value))
        return ok()
      }
      if (key === 'folder.file') {
        view.get(value.id).folder = value.folder || ''
        changed([value.id], 'folder')
        return ok()
      }
      settings[key] = value
      return ok({ message: key === 'agents' || key === 'lan' ? 'Restart the daemon to apply' : undefined })
    },
    'chats.docs.url': () => ({ url: 'http://127.0.0.1:1/' }),
    'chats.agents.state': () => ({ on: true }),
    'chats.share.list': ({ chatId, live }) => [...shares.values()].filter((s) => (!chatId || s.chatId === chatId) && (!live || s.state === 'live')).map((s) => ({ ...s, members: s.members.map((m) => ({ ...m })), agent: s.agent ? { ...s.agent } : null })),
    'chats.share.start': ({ chatId, block, title, mode, args }) => {
      if (!chats.get(chatId)) return fail('not_found', 'No such chat')
      const shareId = block === 'agent' ? `agent:me:${hex32(++shareSeq)}` : `sh:${++shareSeq}`
      const s = { shareId, chatId, block, title: title || labelOf(block), hostPk: me.pk, hostName: me.name, mine: true, mode: mode === 'readonly' ? 'readonly' : mode === 'snapshot' ? 'snapshot' : 'live', state: 'live', joined: true, hostOnline: true, members: [{ pk: me.pk, name: me.name, me: true, hue: 120, active: true }], startedAt: Date.now(), args: typeof args === 'string' ? args : JSON.stringify(args || {}), agent: block === 'agent' ? { name: 'omp', state: 'working', summary: 'Reading the repository…' } : null, openChatId: block === 'agent' ? 'agents' : '' }
      shares.set(shareId, s)
      const m = shareMsg(s)
      msgs.get(chatId)?.push(m)
      emit({ event: 'chat_share', chatId, kind: 'offered', share: s })
      emit({ event: 'chat_message', chatId, message: { ...m }, mine: true })
      if (block === 'agent') return ok({ message: 'This chat can now watch your agents', shares: [s] })
      return { share: s }
    },
    'chats.share.join': ({ shareId }) => {
      const s = shares.get(shareId)
      if (!s) return fail('not_found', 'No such share')
      s.joined = true
      if (!s.members.some((m) => m.me)) s.members.push({ pk: me.pk, name: me.name, me: true, hue: 120, active: true })
      emit({ event: 'chat_share', chatId: s.chatId, kind: 'joined', share: s })
      const snapshot = s.mode === 'snapshot' || s.block === 'agent' ? null : { d: JSON.stringify(snapshotOf(s)), ver: 1 }
      return { share: s, snapshot }
    },
    'chats.share.leave': ({ shareId }) => {
      const s = shares.get(shareId)
      if (!s) return fail('not_found', 'No such share')
      s.members = s.members.filter((m) => !m.me)
      s.joined = false
      emit({ event: 'chat_share', chatId: s.chatId, kind: 'left', share: s })
      return { share: s }
    },
    'chats.share.end': ({ shareId }) => {
      const s = shares.get(shareId)
      if (!s) return fail('not_found', 'No such share')
      s.state = 'ended'
      s.endedAt = Date.now()
      emit({ event: 'chat_share', chatId: s.chatId, kind: 'ended', share: s })
      return { share: s }
    },
    'chats.share.op': ({ shareId, op }) => {
      const s = shares.get(shareId)
      if (!s) return fail('not_found', 'No such share')
      s.ver = (s.ver || 0) + 1
      emit({ event: 'chat_share_op', shareId, type: 'op', from: me.pk, fromName: me.name, ver: s.ver, op: typeof op === 'string' ? op : JSON.stringify(op ?? '') })
      return { ver: s.ver }
    },
    'chats.share.presence': ({ shareId, d }) => {
      const s = shares.get(shareId)
      if (s) emit({ event: 'chat_share_op', shareId, type: 'presence', from: me.pk, fromName: me.name, op: typeof d === 'string' ? d : JSON.stringify(d ?? {}) })
      return {}
    },
    'chats.share.snapshot': ({ shareId, d, ver }) => {
      const s = shares.get(shareId)
      if (s) s.snapshot = { d, ver: ver || 1 }
      return {}
    },
    'chats.agent.answer': () => ok({ message: 'Answer sent' }),
  }

  const api = {
    async call(type, args) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const h = Object.hasOwn(handlers, type) ? handlers[type] : null
      if (!h) throw new Error(`invalid: unknown request ${type}`)
      return structuredClone(await h(args || {}))
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onStatus: null,
  }

  /** Test/harness controls. */
  const simulate = {
    incoming(chatId, text, who) {
      const c = chats.get(chatId)
      const p = who ? byName(who) : c.kind === 'dm' ? byName(c.title) : byName('Grace Hopper')
      const m = push(chatId, { ts: Date.now(), authorName: p.name, authorKey: p.pk, mine: false, text })
      c.unread += 1
      emit({ event: 'chat_message', chatId, message: { ...m }, mine: false })
      return m
    },
    presence(name, online) {
      const p = byName(name)
      p.online = online
      const c = [...chats.values()].find((x) => x.peer === p.pk)
      if (c) c.online = online
      emit({ event: 'chat_presence', pk: p.pk, chatId: c ? c.id : null, online })
    },
    request(label, note) {
      const p = { n: pending.length + 1, id: `contact:${PK(60 + pending.length)}`, type: 'contact', label, note }
      pending.push(p)
      emit({ event: 'chat_request', pending, added: p })
    },
    ring(chatId, from) {
      emit({ event: 'chat_call', chatId, kind: 'ring', call: null, rooms: [{ room: 'call', people: [from], mine: false }], from })
    },
    status(next) {
      status = next
      emit({ event: 'chat_status', status, statusText: '' })
    },
    thinking(chatId, on) {
      chats.get(chatId).thinking = on
      changed([chatId], 'thinking')
    },
    toast: (level, text) => emit({ event: 'chat_toast', level, text }),
  }

  return {
    api,
    me,
    emit,
    simulate,
    ids: { ada: adaId, crew: crew.id, hike: hike.id, review: review.id, grace: dm('Grace Hopper').id, agents: 'agents', ai: 'ai' },
    dispose() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      listeners.clear()
    },
  }
}
