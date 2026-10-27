import type { Engine, MessageView } from '../app/engine.js'
import { SHARE_BLOCKS, type ShareMode, type ShareRecord, type ShareView } from '../chat/blockShare.js'
import { dmConvId } from '../chat/convId.js'
import { ChatsError, type ChatToast, type Ctx } from './chats.js'
import { action, chatId, oneLine, opt, slash, str, type Args, type Handler } from './chatsUtil.js'

// Shared blocks and shared agent sessions as the Chats block sees them: one `ShareView` list, one set of requests.
// Block shares ride BlockShares (src/chat/blockShare.ts); agent sessions are the engine's existing shared-agent code.

/** A timeline item: a share card sits among the messages of its chat, ordered by when it was offered. */
export type ShareMessage = Omit<MessageView, 'kind' | 'status'> & { kind: 'share'; status: null; share: ShareView }

const hueOf = (pk: string): number => Number.parseInt(pk.slice(0, 6), 16) % 360
const AGENT_PREFIX = 'agent:'
const firstSeen = new WeakMap<Engine, Map<string, number>>()

function stamp(e: Engine, id: string): number {
  let seen = firstSeen.get(e)
  if (seen === undefined) firstSeen.set(e, (seen = new Map()))
  let at = seen.get(id)
  if (at === undefined) seen.set(id, (at = Date.now()))
  return at
}

const STATE_RANK = { asking: 3, working: 2, reviewing: 2, idle: 1 } as const

function agentSummary(agents: readonly { name: string; state: 'idle' | 'working' | 'asking' | 'reviewing'; task: string }[]): ShareView['agent'] {
  const top = [...agents].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state])[0]
  if (top === undefined) return undefined
  return { name: top.name, state: top.state === 'reviewing' ? 'working' : top.state, ...(top.task === '' ? {} : { summary: top.task.slice(0, 140) }) }
}

/** Shared agent sessions as share cards: offered to me, joined by me, and mine with the people I let in. */
export function agentShares(e: Engine): ShareView[] {
  if (!e.agentsEnabled()) return []
  const me = e.me
  const out: ShareView[] = []
  const keys = e.pendingKeys()
  e.pending().forEach((p, i) => {
    if (p.type !== 'session') return
    const pk = (keys[i]?.id ?? '').slice('session:'.length)
    const shareId = `${AGENT_PREFIX}${pk}`
    out.push({
      shareId,
      chatId: dmConvId(me.pk, pk),
      block: 'agent',
      title: p.label,
      hostPk: pk,
      hostName: /^(.*)'s agents/.exec(p.label)?.[1] ?? pk.slice(0, 8),
      mine: false,
      mode: p.label.includes('(view)') ? 'readonly' : 'live',
      state: 'live',
      joined: false,
      hostOnline: true,
      members: [],
      startedAt: stamp(e, shareId),
    })
  })
  for (const s of e.sharedSessions()) {
    const room = e.sharedRoom(s.pk)
    const shareId = `${AGENT_PREFIX}${s.pk}`
    const guests = room?.guests ?? []
    out.push({
      shareId,
      chatId: dmConvId(me.pk, s.pk),
      block: 'agent',
      title: `${s.name}'s agents`,
      hostPk: s.pk,
      hostName: s.name,
      mine: false,
      mode: s.access === 'view' ? 'readonly' : 'live',
      state: 'live',
      joined: true,
      hostOnline: s.connected,
      members: [{ pk: s.pk, name: s.name, me: false, hue: hueOf(s.pk), active: s.connected }, ...guests.filter((g) => g.pk !== s.pk).map((g) => ({ pk: g.pk, name: g.name, me: g.pk === me.pk, hue: hueOf(g.pk), active: g.online }))],
      startedAt: stamp(e, shareId),
      openChatId: `shared:${s.pk}`,
      ...(room === undefined ? {} : { agent: agentSummary(room.agents) }),
      ...(s.asking ? { asking: true } : {}),
    })
  }
  const mine = e.agentRoom().agents
  for (const g of e.sessionGuests()) {
    const shareId = `${AGENT_PREFIX}me:${g.pk}`
    out.push({
      shareId,
      chatId: dmConvId(me.pk, g.pk),
      block: 'agent',
      title: 'Your agent session',
      hostPk: me.pk,
      hostName: me.name,
      mine: true,
      mode: g.access === 'view' ? 'readonly' : 'live',
      state: 'live',
      joined: true,
      hostOnline: true,
      members: [
        { pk: me.pk, name: me.name, me: true, hue: hueOf(me.pk), active: true },
        { pk: g.pk, name: g.name, me: false, hue: hueOf(g.pk), active: g.state === 'joined' && g.online },
      ],
      startedAt: stamp(e, shareId),
      openChatId: 'agents',
      ...(agentSummary(mine) === undefined ? {} : { agent: agentSummary(mine) }),
    })
  }
  return out
}

/** Every share the Chats block may show: block shares (live and ended) plus agent sessions. */
export function allShares(c: Ctx, conv?: string): ShareView[] {
  const e = c.engine
  const blocks = e.blockShares.records(conv).map((r) => e.blockShares.view(r))
  return [...blocks, ...agentShares(e).filter((s) => conv === undefined || s.chatId === conv)].sort((a, b) => a.startedAt - b.startedAt)
}

export function shareMessage(v: ShareView): ShareMessage {
  return { key: `share:${v.shareId}`, ts: v.startedAt, authorName: v.hostName, authorKey: v.hostPk, mine: v.mine, kind: 'share', text: '', status: null, share: v }
}

/** The share cards that belong in a page of messages: those offered since the page's oldest message (all of them when it reaches the start). */
export function timelineShares(c: Ctx, conv: string, since: number): ShareMessage[] {
  return allShares(c, conv).filter((s) => s.startedAt >= since).map(shareMessage)
}

const wrap = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (e) {
    throw e instanceof ChatsError ? e : new ChatsError('rejected', e instanceof Error ? e.message : String(e))
  }
}

const shareId = (a: Args): string => oneLine(str(a, 'shareId', 80), 'shareId')

/** An opaque block payload from the renderer: a string is sent as is, anything else as JSON. */
function payload(a: Args, k: string): string {
  const v = a[k]
  if (typeof v === 'string') return v
  if (v === undefined || v === null) throw new ChatsError('invalid', `${k} is required`)
  return JSON.stringify(v)
}

function viewOf(c: Ctx, id: string): ShareView {
  const r = c.engine.blockShares.get(id)
  if (r === undefined) throw new ChatsError('not_found', 'no such share')
  return c.engine.blockShares.view(r)
}

function blockShare(c: Ctx, id: string): ShareRecord {
  const r = c.engine.blockShares.get(id)
  if (r === undefined) throw new ChatsError('not_found', 'no such share')
  return r
}

function needAgents(c: Ctx): void {
  if (!c.agentsOn) throw new ChatsError('unsupported', 'Agents are off (Settings > Privacy and Network)')
}

async function startAgent(c: Ctx, id: string, mode: ShareMode): Promise<Args> {
  needAgents(c)
  const e = c.engine
  const chat = c.summary(id)
  const pks = chat.kind === 'dm' && chat.peer !== null ? [chat.peer] : (e.groupView(id)?.people ?? []).filter((p) => !p.me && p.contact).map((p) => p.pk)
  if (pks.length === 0) throw new ChatsError('invalid', 'nobody in this chat can be invited to an agent session')
  const toasts: ChatToast[] = []
  for (const pk of pks) {
    const r = await action(c, undefined, () => e.run(slash('agent', 'invite', pk, mode === 'readonly' ? '--view' : undefined)))
    toasts.push(...(r.toasts as ChatToast[]))
  }
  return { toasts, message: toasts.at(-1)?.text ?? 'Invited', shares: agentShares(e).filter((s) => s.mine) }
}

export const shareHandlers: Record<string, Handler> = {
  'chats.share.list': {
    run: (c, a) => allShares(c, opt(a, 'chatId', 100)).filter((s) => a.live !== true || s.state === 'live'),
  },
  'chats.share.start': {
    run: async (c, a) => {
      const id = chatId(a)
      const block = oneLine(str(a, 'block', 24), 'block')
      const mode = a.mode === undefined ? 'live' : a.mode
      if (mode !== 'live' && mode !== 'readonly' && mode !== 'snapshot') throw new ChatsError('invalid', "mode must be 'live', 'readonly' or 'snapshot'")
      if (!/^(dm|grp):/.test(id)) throw new ChatsError('invalid', 'blocks are shared into a contact or group chat')
      if (block === 'agent') return startAgent(c, id, mode)
      if (!SHARE_BLOCKS.includes(block)) throw new ChatsError('invalid', `cannot share a ${block} block (can: ${[...SHARE_BLOCKS, 'agent'].join(', ')})`)
      c.summary(id)
      const e = c.engine
      const rec = wrap(() =>
        e.blockShares.start({
          conv: id,
          block,
          title: oneLine(opt(a, 'title', 64) ?? block, 'title'),
          mode,
          ...(a.args === undefined || a.args === null ? {} : { args: payload(a, 'args') }),
          ...(a.snapshot === undefined || a.snapshot === null ? {} : { snapshot: payload(a, 'snapshot') }),
        }),
      )
      return { share: e.blockShares.view(rec) }
    },
  },
  'chats.share.join': {
    run: async (c, a) => {
      const sid = shareId(a)
      const e = c.engine
      if (sid.startsWith(AGENT_PREFIX)) {
        needAgents(c)
        const pk = sid.slice(AGENT_PREFIX.length)
        const row = c.pending().find((p) => p.id === `session:${pk}`)
        if (row !== undefined) await action(c, undefined, () => e.run(`/accept ${row.n}`))
        const share = agentShares(e).find((s) => s.shareId === sid && s.joined)
        if (share === undefined) throw new ChatsError('not_found', 'no such agent session to join')
        return { share, snapshot: null }
      }
      blockShare(c, sid)
      const rec = wrap(() => e.blockShares.join(sid))
      return { share: e.blockShares.view(rec), snapshot: e.blockShares.snapshotOf(sid) ?? null }
    },
  },
  'chats.share.leave': {
    run: async (c, a) => {
      const sid = shareId(a)
      const e = c.engine
      if (sid.startsWith(AGENT_PREFIX)) {
        needAgents(c)
        const pk = sid.slice(AGENT_PREFIX.length)
        if (pk.startsWith('me:')) return endAgent(c, pk.slice(3))
        const pend = c.pending().find((p) => p.id === `session:${pk}`)
        if (pend !== undefined) await action(c, undefined, () => e.run(`/decline ${pend.n}`))
        else await action(c, undefined, () => e.agentLeave(pk))
        return { share: null }
      }
      blockShare(c, sid)
      return { share: e.blockShares.view(wrap(() => e.blockShares.leave(sid))) }
    },
  },
  'chats.share.end': {
    run: async (c, a) => {
      const sid = shareId(a)
      if (sid.startsWith(AGENT_PREFIX)) {
        needAgents(c)
        const pk = sid.slice(AGENT_PREFIX.length)
        return endAgent(c, pk.startsWith('me:') ? pk.slice(3) : 'all')
      }
      blockShare(c, sid)
      return { share: c.engine.blockShares.view(wrap(() => c.engine.blockShares.end(sid))) }
    },
  },
  'chats.share.op': {
    run: (c, a) => {
      blockShare(c, shareId(a))
      return { ver: wrap(() => c.engine.blockShares.op(shareId(a), payload(a, 'op'))) }
    },
  },
  'chats.share.presence': {
    run: (c, a) => {
      blockShare(c, shareId(a))
      wrap(() => c.engine.blockShares.presence(shareId(a), payload(a, 'd')))
      return {}
    },
  },
  'chats.share.snapshot': {
    run: (c, a) => {
      const sid = shareId(a)
      blockShare(c, sid)
      const d = payload(a, 'd')
      const ver = typeof a.ver === 'number' ? a.ver : undefined
      const to = opt(a, 'to', 64)
      wrap(() => (to === undefined ? c.engine.blockShares.setSnapshot(sid, d, ver) : c.engine.blockShares.sendSnapshot(sid, to, d, ver)))
      return {}
    },
  },
}

async function endAgent(c: Ctx, query: string): Promise<Args> {
  return { ...(await action(c, undefined, () => c.engine.agentKick(query))), share: null }
}
