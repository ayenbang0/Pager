// Chats block: shared blocks and shared agent sessions inside a conversation.
// A share is a timeline item (message kind 'share') carrying a ShareView; the card shows who is in it, whether it is live, read-only
// or a snapshot, and Join / Open / Leave / Stop. Which blocks can be shared is decided by the renderer's adapter registry
// (blocks/share.js: `shareables()`), never by this file. See local://chats-contract.md (sharing).
import { fmtClock, plural } from './chats-util.js'
import { avatar } from './chats-ui.js'
export { normalizeShare } from './chats-model.js'

export const BLOCK_META = [
  { id: 'canvas', label: 'Canvas', icon: 'palette', blurb: 'Sketch and arrange together' },
  { id: 'board', label: 'Board', icon: 'board', blurb: 'A kanban board you both move cards on' },
  { id: 'notebook', label: 'Notebook', icon: 'notebook', blurb: 'Cells and results side by side' },
  { id: 'files', label: 'Files', icon: 'files', blurb: 'A folder or file to read and edit' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', blurb: 'What is running on this machine' },
  { id: 'git', label: 'Git', icon: 'branch', blurb: 'Repository status snapshot' },
  { id: 'screen', label: 'Screen', icon: 'screen', blurb: 'See this machine together' },
  { id: 'agent', label: 'Agent session', icon: 'bot', blurb: 'Let them watch or steer your agents' },
]
const META = new Map(BLOCK_META.map((x) => [x.id, x]))
export const blockMeta = (id) => META.get(id) || { id, label: String(id || 'Block'), icon: 'layers', blurb: '' }

export const MODE_LABEL = { live: 'Live', readonly: 'Read-only', snapshot: 'Snapshot' }
const MODE_ORDER = ['live', 'readonly', 'snapshot']

/** The daemon can carry shares at all (the Share button is hidden otherwise). */
export const canShare = (caps) => !!(caps && caps.share && caps.share.transport)

/**
 * Menu entries for the Share button.
 *   instances: shareables() from share.js, mounted blocks with an adapter [{ instanceId, block, title, modes }]
 *   chat: the conversation (agent sessions only go into dm / group chats)
 *   pick({ instance?, block?, mode })
 */
export function shareMenuItems(caps, instances, chat, pick) {
  if (!canShare(caps)) return []
  const carried = new Set(caps.share.blocks || [])
  const daemonModes = new Set(caps.share.modes || MODE_ORDER)
  const items = []
  for (const inst of instances || []) {
    if (!carried.has(inst.block)) continue
    const modes = MODE_ORDER.filter((m) => inst.modes.includes(m) && daemonModes.has(m))
    if (!modes.length) continue
    const meta = blockMeta(inst.block)
    const label = `${meta.label}${inst.title ? ' · ' + inst.title : ''}`
    if (modes.length === 1) items.push({ label, icon: meta.icon, hint: MODE_LABEL[modes[0]], onClick: () => pick({ instance: inst, mode: modes[0] }) })
    else items.push({ label, icon: meta.icon, children: modes.map((m) => ({ label: m === 'live' ? 'Live: everyone edits' : m === 'readonly' ? 'Read-only: only you edit' : 'Snapshot: a one-time copy', icon: m === 'live' ? 'zap' : m === 'readonly' ? 'eye' : 'image', onClick: () => pick({ instance: inst, mode: m }) })) })
  }
  if (caps.share.agent && carried.has('agent') && chat && (chat.kind === 'dm' || chat.kind === 'group')) {
    if (items.length) items.push({ sep: true })
    items.push({
      label: 'Agent session',
      icon: 'bot',
      children: [
        { label: 'Let them steer my agents', icon: 'zap', onClick: () => pick({ block: 'agent', mode: 'live' }) },
        { label: 'View only', icon: 'eye', onClick: () => pick({ block: 'agent', mode: 'readonly' }) },
      ],
    })
  }
  return items
}

/** Who is in a share right now, with the host first. */
export function activeMembers(s) {
  return [...s.members].sort((a, b) => Number(b.pk === s.hostPk) - Number(a.pk === s.hostPk)).filter((m) => m.active)
}

export function shareSubtitle(s) {
  const meta = blockMeta(s.block)
  if (s.state === 'ended') return `${meta.label} · ended${s.endedAt ? ' ' + fmtClock(s.endedAt) : ''}`
  const n = activeMembers(s).length
  const mode = s.block === 'agent' ? (s.mode === 'readonly' ? 'View only' : 'Live') : MODE_LABEL[s.mode]
  return `${meta.label} · ${mode}${n ? ' · ' + plural(n, 'person', 'people') + ' here' : ''}${s.hostOnline ? '' : ' · host offline'}`
}

/** The card's primary action: what clicking the main button does. */
export function primaryAction(s) {
  if (s.state !== 'live') return null
  if (s.mine || s.joined) return { kind: 'open', label: s.block === 'agent' ? 'Open chat' : 'Open beside chat' }
  if (s.mode === 'snapshot') return { kind: 'join', label: 'View' }
  return { kind: 'join', label: s.block === 'agent' ? 'Accept' : 'Join' }
}

/**
 * ctx.share = { open(share), join(share), leave(share), end(share) }; each returns a promise or nothing.
 * Agent sessions carry share.agent = { name, state, summary } and show live status.
 */
export function shareCard(ctx, msg) {
  const { h, icon } = ctx.b
  const b = ctx.b
  const s = msg.share
  if (!s) return h('div', { class: 'cm-sys' }, h('span', { class: 'cm-sys-t' }, 'Shared item'))
  const meta = blockMeta(s.block)
  const live = s.state === 'live'
  const members = activeMembers(s)
  const cls = ['cm-share', s.mine ? 'mine' : 'theirs', live ? 'live' : 'ended', 'blk-' + s.block, 'mode-' + s.mode]
  if (s.agent) cls.push('agent-' + s.agent.state)
  if (s.asking) cls.push('asking')
  const btn = (label, fn, kind = '') => h('button', { class: `cm-sbtn btn sm ${kind === 'primary' ? 'accent' : kind}`, type: 'button', on: { click: (e) => (e.stopPropagation(), fn(s)) } }, label)
  const btns = []
  const main = primaryAction(s)
  if (main) btns.push(btn(main.label, (x) => (main.kind === 'open' ? ctx.share?.open(x) : ctx.share?.join(x)), 'primary'))
  if (live) {
    if (s.mine) btns.push(btn('Stop', (x) => ctx.share?.end(x), 'danger'))
    else if (s.joined) btns.push(btn('Leave', (x) => ctx.share?.leave(x)))
  }
  const stack = h(
    'div',
    { class: 'cm-share-who', title: members.map((m) => m.name).join(', ') },
    members.slice(0, 4).map((m) => avatar(b, { title: m.name, pk: m.pk }, { size: 22, dot: false })),
    members.length > 4 ? h('span', { class: 'cm-share-more' }, '+' + (members.length - 4)) : null,
  )
  const agent = s.agent
    ? h('div', { class: 'cm-agent-st' }, h('i', { class: 'cm-agent-dot ' + s.agent.state }), h('span', { class: 'cm-agent-name' }, s.agent.name || 'agent'), h('span', { class: 'cm-agent-state' }, s.agent.state === 'working' ? 'working' : s.agent.state === 'asking' ? 'waiting for an answer' : 'idle'), s.agent.summary ? h('span', { class: 'cm-agent-sum' }, s.agent.summary) : null)
    : null
  return h(
    'div',
    { class: cls.join(' '), 'data-share': s.shareId },
    h('div', { class: 'cm-share-ic' }, icon(meta.icon, 20)),
    h(
      'div',
      { class: 'cm-share-main' },
      h('div', { class: 'cm-share-t' }, s.title || meta.label),
      h('div', { class: 'cm-share-sub' }, shareSubtitle(s)),
      agent,
      live && members.length ? stack : null,
    ),
    btns.length ? h('div', { class: 'cm-share-btns' }, btns) : null,
  )
}
