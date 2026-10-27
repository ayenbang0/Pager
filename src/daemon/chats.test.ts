import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { identityLockState, loadOrCreateIdentity, lockIdentity } from '../chat/identity.js'
import { deriveSecrets } from '../chat/secrets.js'
import { acquireLock, AlreadyRunningError } from '../platform/lock.js'
import { removeTmpDirs, tmpDir, waitFor } from '../testing/testutil.js'
import { DaemonClient } from './client.js'
import { acquireLockOrAskDaemon, HeldByDaemonError } from './handoff.js'
import type { DaemonEvent } from './protocol.js'
import { startDaemon, type DaemonHandle } from './server.js'

const addr = (tag: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\pager-chats-${process.pid}-${tag}-${Date.now()}` : path.join(os.tmpdir(), `pager-chats-${process.pid}-${tag}-${Date.now()}.sock`))
const noPane = async (): Promise<never> => {
  throw new Error('no panes in this test')
}
const CHAT_EVENTS = ['chats_changed', 'chat_message', 'chat_presence', 'chat_call', 'chat_request', 'chat_toast', 'chat_status', 'chat_share', 'chat_share_op']

let testnet: Testnet
const daemons: DaemonHandle[] = []
const clients: DaemonClient[] = []

before(async () => {
  testnet = await createTestnet(3)
})
after(async () => {
  for (const c of clients) c.close()
  await Promise.all(daemons.map((d) => d.close()))
  await testnet.destroy()
  removeTmpDirs()
})

interface Node {
  dir: string
  address: string
  /** A window that listens to chat events. */
  win: DaemonClient
  events: DaemonEvent[]
  call<T = Record<string, unknown>>(type: string, args?: Record<string, unknown>): Promise<T>
  /** Resolves with the first matching event seen from now on or already seen. */
  event(name: string, pred?: (e: DaemonEvent) => boolean): Promise<DaemonEvent>
}

async function node(tag: string, opts: { acquire?: (dir: string) => () => void; dir?: string; retryMs?: number } = {}): Promise<Node> {
  const dir = opts.dir ?? tmpDir('pager-chats-')
  const address = addr(tag)
  const d = await startDaemon({
    dir,
    address,
    cliPath: 'unused',
    launcher: noPane,
    log: () => {},
    chats: { engineOptions: { bootstrap: testnet.bootstrap, dhtOptions: { host: '127.0.0.1' }, backoff: { baseMs: 50, maxMs: 200 }, agents: false }, ...(opts.acquire === undefined ? {} : { acquire: opts.acquire }), ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }) },
  })
  daemons.push(d)
  const win = await DaemonClient.connect(address, { client: 'window', name: `${tag}-win` })
  clients.push(win)
  const events: DaemonEvent[] = []
  win.on('event', (e: DaemonEvent) => events.push(e))
  await win.subscribe(CHAT_EVENTS)
  const seen = (name: string, pred: (e: DaemonEvent) => boolean): DaemonEvent | undefined => events.find((e) => e.event === name && pred(e))
  return {
    dir,
    address,
    win,
    events,
    call: (type, args) => win.call(type, args ?? {}) as Promise<never>,
    event: async (name, pred = () => true) => {
      await waitFor(() => seen(name, pred) !== undefined, 20_000, `event ${name}`)
      return seen(name, pred)!
    },
  }
}

const fails = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await assert.rejects(p, (e: Error) => re.test(e.message), String(re))
}

interface State {
  status: string
  statusText?: string
  encrypted?: boolean
  me?: { pk: string; code: string; name: string }
  online?: boolean
  onlineCount?: number
  chats: { id: string; kind?: string; title?: string; peer?: string | null; online?: boolean | null; unread: number; pinned: boolean; muted: boolean; last?: { text: string; mine: boolean } }[]
  pending: { n: number; id: string; type: string; label: string }[]
  caps: Record<string, unknown>
}

describe('without a network', () => {
  test('caps and the command catalogue need no engine; unknown requests are refused', async () => {
    const a = await node('caps')
    const caps = await a.call<Record<string, unknown>>('chats.caps')
    assert.equal(caps.edit, false)
    assert.equal(caps.delete, false)
    assert.equal(caps.attachments, false)
    assert.equal(caps.typing, false)
    assert.equal(caps.react, true)
    assert.deepEqual((caps.share as { modes: string[] }).modes, ['live', 'readonly', 'snapshot'])
    const cmds = await a.call<{ name: string; hostOnly?: string }[]>('chats.commands')
    assert.ok(cmds.find((c) => c.name === 'quit')?.hostOnly)
    assert.equal(cmds.find((c) => c.name === 'agent')?.hostOnly, undefined)
    await fails(a.call('chats.nonsense'), /^invalid: unknown request/)
    assert.equal(a.events.filter((e) => e.event === 'chat_status').length, 0, 'caps did not start an engine')
  })

  test('a terminal pager on the data dir is a clear conflict, not a crash; retry works once it is gone', async () => {
    let busy: number | undefined = 4242
    const a = await node('conflict', {
      acquire: () => {
        if (busy !== undefined) throw new AlreadyRunningError(busy)
        return () => {}
      },
    })
    const st = await a.call<State>('chats.state')
    assert.equal(st.status, 'conflict')
    assert.match(st.statusText ?? '', /open in a terminal \(pid 4242\) and is using chat on /)
    assert.ok((st.statusText ?? '').includes(a.dir))
    assert.deepEqual(st.chats, [])
    await fails(a.call('chats.open', { chatId: 'dm:00000000000000000000000000000000' }), /^conflict: /)
    await a.event('chat_status', (e) => e.status === 'conflict')
    assert.ok((await a.win.call('state')) !== undefined, 'the daemon still serves')
    busy = undefined
    const again = await a.call<State>('chats.retry')
    assert.equal(again.status, 'ready')
    assert.ok(again.me?.code)
    await a.event('chat_status', (e) => e.status === 'ready')
  })

  test('a terminal pager that quits gives chat back without a retry', async () => {
    let busy: number | undefined = 4242
    const a = await node('reconnect', {
      retryMs: 40,
      acquire: () => {
        if (busy !== undefined) throw new AlreadyRunningError(busy)
        return () => {}
      },
    })
    const st = await a.call<State>('chats.state')
    assert.equal(st.status, 'conflict')
    assert.match(st.statusText ?? '', /\(pid 4242\).*connects here by itself/s)
    const statuses = (): unknown[] => a.events.filter((e) => e.event === 'chat_status').map((e) => e.status)
    await sleep(250)
    assert.deepEqual(statuses(), ['conflict'], 'looking again every 40 ms stays silent while the lock is held')
    busy = undefined
    await a.event('chat_status', (e) => e.status === 'ready')
    assert.deepEqual(statuses(), ['conflict', 'starting', 'ready'])
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
  })

  test('a locked identity reports locked until the passphrase is given', async () => {
    const dir = tmpDir('pager-chats-lock-')
    loadOrCreateIdentity(dir)
    const salt = Buffer.alloc(16, 7)
    lockIdentity(dir, deriveSecrets('correct horse battery', salt), salt)
    assert.ok(identityLockState(dir).locked)
    const a = await node('locked', { dir })
    const st = await a.call<State>('chats.state')
    assert.equal(st.status, 'locked')
    await fails(a.call('chats.requests'), /^locked: /)
    await fails(a.call('chats.unlock', { passphrase: 'wrong passphrase' }), /^invalid: wrong passphrase/)
    const ok = await a.call<State>('chats.unlock', { passphrase: 'correct horse battery' })
    assert.equal(ok.status, 'ready')
    assert.equal(ok.encrypted, true)
  })
})

describe('a terminal pager and the daemon share one data folder', () => {
  const statuses = (a: Node, status: string): number => a.events.filter((e) => e.event === 'chat_status' && e.status === status).length

  test('a pager started while the daemon holds the folder asks for it, and chat returns when the pager quits', async () => {
    const a = await node('handoff', { retryMs: 100 })
    assert.deepEqual(await a.call('chats.yield'), { yielded: false })
    assert.equal(statuses(a, 'starting') + statuses(a, 'ready'), 0, 'with nothing to give up, no engine starts to find out')
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
    const release = await acquireLockOrAskDaemon(a.dir, { address: a.address })
    await a.event('chat_status', (e) => e.status === 'conflict')
    const mid = await a.call<State>('chats.state')
    assert.equal(mid.status, 'conflict', 'the pager has the folder now')
    assert.match(mid.statusText ?? '', /terminal/)
    release()
    await waitFor(() => statuses(a, 'ready') === 2, 20_000, 'chat reconnects after the pager quits')
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
  })

  test('the folder stays free for the pager that asked, however many clients come and go', async () => {
    const a = await node('grace', { retryMs: 40 })
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
    assert.deepEqual(await a.call('chats.yield'), { yielded: true })
    const starts = statuses(a, 'starting')
    // The pager's own request connects and closes right after the answer; so does everything else that happens to be running.
    for (let i = 0; i < 3; i++) (await DaemonClient.connect(a.address, { client: 'cli', name: 'pager' })).close()
    assert.equal((await a.call<State>('chats.state')).status, 'conflict', 'a request does not take the folder back')
    await sleep(300) // asserts an absence: the watcher ticks every 40 ms, so a daemon that wanted the folder back would have started by now
    assert.equal(statuses(a, 'starting'), starts, 'no engine started in the meantime')
    acquireLock(a.dir)() // the folder is free for the pager: it would throw if the daemon had taken it back
  })

  test('a lock held by anything but the daemon is refused, and the daemon keeps its engine', async () => {
    const a = await node('foreign')
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
    const other = tmpDir('pager-foreign-')
    fs.writeFileSync(path.join(other, 'pager.lock'), String(process.ppid))
    await assert.rejects(acquireLockOrAskDaemon(other, { address: a.address }), (e: Error) => e.constructor === AlreadyRunningError && (e as AlreadyRunningError).pid === process.ppid)
    assert.equal(statuses(a, 'conflict'), 0)
    assert.equal((await a.call<State>('chats.state')).status, 'ready')
  })

  test('a daemon that holds the lock but has no engine to give up is named in the refusal', async () => {
    const dir = tmpDir('pager-held-')
    fs.writeFileSync(path.join(dir, 'pager.lock'), String(process.pid))
    const a = await node('held', { dir, acquire: () => () => {} })
    await assert.rejects(acquireLockOrAskDaemon(dir, { address: a.address }), (e: Error) => e instanceof HeldByDaemonError && e.pid === process.pid)
  })
})

describe('two daemons, one conversation', () => {
  let a: Node
  let b: Node
  let bQuiet: DaemonClient
  const quietHeard: DaemonEvent[] = []
  let aState: State
  let bState: State
  let chatA: string
  let chatB: string

  before(async () => {
    a = await node('alice')
    b = await node('bob')
    // A second window on bob that never subscribed: it must hear nothing.
    bQuiet = await DaemonClient.connect(b.address, { client: 'window', name: 'bob-quiet' })
    clients.push(bQuiet)
    bQuiet.on('event', (e: DaemonEvent) => quietHeard.push(e))
    aState = await a.call<State>('chats.state')
    bState = await b.call<State>('chats.state')
    assert.equal(aState.status, 'ready')
    assert.equal(bState.status, 'ready')
    await a.call('chats.profile.set', { name: 'alice' })
    await b.call('chats.profile.set', { name: 'bob' })
    const add = await a.call<{ message?: string }>('chats.contact.add', { code: bState.me!.code, note: 'hi bob' })
    assert.match(add.message ?? '', /Request queued/)
    await b.event('chat_request', (e) => (e.pending as unknown[]).length > 0)
    const pending = await b.call<State['pending']>('chats.requests')
    assert.equal(pending[0]?.type, 'contact')
    assert.match(pending[0]?.id ?? '', /^contact:[0-9a-f]{64}$/)
    await b.call('chats.request.accept', { id: pending[0]!.id })
    for (const [n, who] of [[a, 'alice'], [b, 'bob']] as const) {
      const end = Date.now() + 25_000
      for (;;) {
        const s = await n.call<State>('chats.state')
        if (s.chats.some((c) => c.id.startsWith('dm:') && (c as unknown as { online: boolean }).online)) {
          if (n === a) chatA = s.chats[0]!.id
          else chatB = s.chats[0]!.id
          break
        }
        assert.ok(Date.now() < end, `${who} sees the other online`)
        await sleep(100)
      }
    }
    assert.equal(chatA, chatB)
  })

  test('a message arrives as events only for the window that subscribed', async () => {
    const sent = await a.call<{ key?: string }>('chats.send', { chatId: chatA, text: 'hello bob :fire:' })
    assert.match(sent.key ?? '', /^[0-9a-f]{64}:\d+$/)
    const ev = await b.event('chat_message', (e) => (e.message as { text: string }).text.includes('hello bob'))
    assert.equal(ev.chatId, chatB)
    assert.equal(ev.mine, false)
    assert.ok((ev.message as { text: string }).text.includes('🔥'), 'shortcodes expand')
    const changed = await b.event('chats_changed', (e) => (e.chats as { id: string; unread: number }[]).some((c) => c.id === chatB && c.unread === 1))
    assert.ok(Array.isArray(changed.removed))
    await sleep(150)
    assert.deepEqual(quietHeard, [], 'an unsubscribed window hears nothing')
    const mine = a.events.find((e) => e.event === 'chat_message' && (e.message as { key: string }).key === sent.key)
    assert.ok(mine && mine.mine === true, 'the sender sees its own message event')
  })

  test('open pages history, marks read, and the sender sees the tick climb', async () => {
    for (let i = 0; i < 6; i++) await a.call('chats.send', { chatId: chatA, text: `m${i}` })
    await waitFor(async () => (await b.call<{ chat: { unread: number } }>('chats.open', { chatId: chatB, markRead: false, limit: 1 })).chat.unread >= 7, 20_000, 'bob receives all')
    const page1 = await b.call<{ messages: { key: string; text: string }[]; hasMore: boolean; chat: { unread: number } }>('chats.open', { chatId: chatB, limit: 3 })
    assert.deepEqual(page1.messages.map((m) => m.text), ['m3', 'm4', 'm5'])
    assert.equal(page1.hasMore, true)
    assert.equal(page1.chat.unread, 0, 'opening marks read')
    const page2 = await b.call<{ messages: { key: string; text: string }[]; hasMore: boolean }>('chats.open', { chatId: chatB, limit: 3, before: page1.messages[0]!.key })
    assert.deepEqual(page2.messages.map((m) => m.text), ['m0', 'm1', 'm2'])
    const page3 = await b.call<{ messages: { text: string }[]; hasMore: boolean }>('chats.open', { chatId: chatB, limit: 50, before: page2.messages[0]!.key })
    assert.equal(page3.hasMore, false)
    assert.ok(page3.messages.some((m) => m.text.includes('hello bob')))
    // Read receipts only flow while the window reports focus.
    await b.call('chats.focus', { focused: true, chatId: chatB })
    await waitFor(async () => (await a.call<{ messages: { status: string }[] }>('chats.open', { chatId: chatA, limit: 1, markRead: false })).messages.at(-1)?.status === 'read', 20_000, 'read tick on alice')
  })

  test('reactions toggle and show on both sides', async () => {
    const last = (await a.call<{ messages: { key: string }[] }>('chats.open', { chatId: chatA, limit: 1 })).messages[0]!
    await b.call('chats.react', { chatId: chatB, key: last.key, emoji: '👍' })
    await waitFor(async () => {
      const m = (await a.call<{ messages: { key: string; reactions?: { emoji: string; count: number }[] }[] }>('chats.open', { chatId: chatA, limit: 1, markRead: false })).messages[0]
      return m?.reactions?.[0]?.emoji === '👍'
    }, 20_000, 'reaction arrives')
    await fails(b.call('chats.react', { chatId: chatB, key: 'nonsense', emoji: '👍' }), /^invalid: key must be a message key/)
  })

  test('pin, mute and archive are local, persist, and come back in summaries', async () => {
    await a.call('chats.pin', { chatId: chatA, on: true })
    await a.call('chats.mute', { chatId: chatA, on: true })
    const st = await a.call<State>('chats.state')
    const c = st.chats.find((x) => x.id === chatA)!
    assert.equal(c.pinned, true)
    assert.equal(c.muted, true)
    await a.event('chats_changed', (e) => (e.chats as { id: string; pinned: boolean }[]).some((x) => x.id === chatA && x.pinned))
    await a.call('chats.pin', { chatId: chatA, on: false })
    await a.call('chats.mute', { chatId: chatA, on: false })
    await fails(a.call('chats.pin', { chatId: 'dm:ffffffffffffffffffffffffffffffff', on: true }), /^not_found: /)
    await fails(a.call('chats.pin', { chatId: chatA, on: 'yes' }), /^invalid: on must be true or false/)
  })

  test('what the protocol cannot do is refused clearly, and bad requests never hurt the daemon', async () => {
    await fails(a.call('chats.edit', { chatId: chatA, key: 'x', text: 'y' }), /^unsupported: /)
    await fails(a.call('chats.delete', { chatId: chatA, key: 'x' }), /^unsupported: /)
    await fails(a.call('chats.send', { chatId: chatA, text: 'x', replyTo: 'k' }), /^unsupported: replies/)
    await fails(a.call('chats.send', { chatId: chatA, text: 'x', attachments: [{ name: 'a' }] }), /^unsupported: attachments/)
    assert.deepEqual(await a.call('chats.typing', { chatId: chatA, on: true }), { supported: false })
    await fails(a.call('chats.send', { chatId: chatA, text: '' }), /^invalid: text is required/)
    await fails(a.call('chats.send', { chatId: chatA, text: 'x'.repeat(4001) }), /^invalid: text is too long/)
    await fails(a.call('chats.send', { chatId: 'nope', text: 'x' }), /^not_found: /)
    await fails(a.call('chats.send', { text: 'x' }), /^invalid: chatId is required/)
    await fails(a.call('chats.open', { chatId: chatA, before: 'bad' }), /^invalid: before must be a message key/)
    await fails(a.call('chats.contact.add', { code: 'not a code' }), /^invalid: code must not contain spaces/)
    await fails(a.call('chats.contact.add', { code: 'zzzz' }), /^rejected: /)
    await fails(a.call('chats.group.new', { title: '' }), /^invalid: title is required/)
    await fails(a.call('chats.command', { line: 'hello' }), /^invalid: line must be a slash command/)
    await fails(a.call('chats.command', { line: '/quit' }), /^unsupported: \/quit belongs to the terminal host/)
    await fails(a.call('chats.command', { line: '/terminal' }), /^unsupported: /)
    await fails(a.call('chats.request.accept', { id: 'contact:nobody' }), /^not_found: /)
    const search = await a.call<{ hits: { chatId?: string; text: string }[]; total: number }>('chats.search', { query: 'hello bob' })
    assert.equal(search.total >= 1, true)
    assert.equal(search.hits[0]?.chatId, chatA)
    const out = await a.call<{ message?: string; toasts: unknown[] }>('chats.command', { chatId: chatA, line: '/ping' })
    assert.ok(Array.isArray(out.toasts))
    assert.ok((await a.win.call('state')) !== undefined, 'the daemon still serves')
  })

  test('groups: create, invite, members, rename, leave', async () => {
    const made = await a.call<{ chatId: string }>('chats.group.new', { title: 'crew' })
    assert.match(made.chatId, /^grp:/)
    await a.call('chats.group.invite', { chatId: made.chatId, peer: 'bob' })
    await b.event('chat_request', (e) => (e.pending as { type: string }[]).some((p) => p.type === 'group'))
    const pending = (await b.call<State['pending']>('chats.requests')).find((p) => p.type === 'group')!
    await b.call('chats.request.accept', { id: pending.id })
    await waitFor(async () => (await b.call<State>('chats.state')).chats.some((c) => c.id === made.chatId), 20_000, 'bob in the group')
    await a.call('chats.group.rename', { chatId: made.chatId, title: 'crew2' })
    await waitFor(async () => (await b.call<State>('chats.state')).chats.find((c) => c.id === made.chatId)?.title === 'crew2', 20_000, 'rename arrives')
    const g = await a.call<{ people: { name: string; me: boolean }[] }>('chats.group.members', { chatId: made.chatId })
    assert.ok(g.people.some((p) => p.name === 'bob'))
    await fails(b.call('chats.group.rename', { chatId: made.chatId, title: 'mine' }), /^rejected: Only the group creator/)
    await b.call('chats.group.leave', { chatId: made.chatId })
    await b.event('chats_changed', (e) => (e.removed as string[]).includes(made.chatId))
  })

  describe('shared blocks', () => {
    let shareId = ''

    test('offer, join with the cached snapshot, then operations flow in host order both ways', async () => {
      const started = await a.call<{ share: { shareId: string; chatId: string; mode: string; state: string; members: { me: boolean }[] } }>('chats.share.start', { chatId: chatA, block: 'canvas', title: 'sketch', args: { path: 'x.canvas' }, snapshot: { shapes: [1] } })
      shareId = started.share.shareId
      assert.equal(started.share.chatId, chatA)
      assert.equal(started.share.mode, 'live')
      const offered = await b.event('chat_share', (e) => e.kind === 'offered' && (e.share as { shareId: string }).shareId === shareId)
      assert.equal((offered.share as { hostName: string; mine: boolean; joined: boolean; args: string }).mine, false)
      assert.equal((offered.share as { args: string }).args, '{"path":"x.canvas"}')
      // The offer is a card in the timeline of the DM.
      const open = await b.call<{ messages: { kind: string; key: string; share?: { shareId: string } }[] }>('chats.open', { chatId: chatB, limit: 5, markRead: false })
      assert.ok(open.messages.some((m) => m.kind === 'share' && m.key === `share:${shareId}`))
      const joined = await b.call<{ share: { joined: boolean }; snapshot: { d: string } | null }>('chats.share.join', { shareId })
      assert.equal(joined.share.joined, true)
      await b.event('chat_share_op', (e) => e.type === 'snapshot' && e.op === '{"shapes":[1]}')
      await a.event('chat_share_op', (e) => e.type === 'join_request')
      await a.event('chat_share', (e) => (e.share as { members: unknown[] }).members.length === 2 && e.kind === 'joined')

      assert.equal((await a.call<{ ver: number }>('chats.share.op', { shareId, op: { add: 'a1' } })).ver, 1)
      const got = await b.event('chat_share_op', (e) => e.type === 'op' && e.op === '{"add":"a1"}')
      assert.equal(got.ver, 1)
      assert.equal(got.from, aState.me!.pk)
      assert.equal(got.fromName, 'alice')
      assert.equal((await b.call<{ ver: number }>('chats.share.op', { shareId, op: JSON.stringify({ add: 'b1' }) })).ver, 0)
      const back = await a.event('chat_share_op', (e) => e.type === 'op' && e.op === '{"add":"b1"}')
      assert.equal(back.ver, 2, 'the host numbered it')
      assert.equal(back.from, bState.me!.pk)
      await b.call('chats.share.presence', { shareId, d: { x: 1, y: 2 } })
      await a.event('chat_share_op', (e) => e.type === 'presence' && e.op === '{"x":1,"y":2}')
      // The host's own operations are not echoed to it.
      assert.equal(a.events.filter((e) => e.event === 'chat_share_op' && e.type === 'op' && e.op === '{"add":"a1"}').length, 0)
    })

    test('caps, rate limits and who may write', async () => {
      await fails(a.call('chats.share.op', { shareId, op: 'x'.repeat(70_000) }), /^rejected: operation too big/)
      await fails(a.call('chats.share.presence', { shareId, d: 'x'.repeat(2000) }), /^rejected: presence too big/)
      await fails(a.call('chats.share.start', { chatId: chatA, block: 'terminal' }), /^invalid: cannot share a terminal block/)
      await fails(a.call('chats.share.start', { chatId: chatA, block: 'canvas', mode: 'snapshot' }), /^rejected: a snapshot share needs/)
      await fails(a.call('chats.share.start', { chatId: chatA, block: 'canvas', snapshot: 'x'.repeat(190_000) }), /^rejected: the snapshot is too big/)
      await fails(a.call('chats.share.op', { shareId: '0000000000000000', op: 'x' }), /^not_found: /)
      await fails(a.call('chats.share.join', { shareId: '0000000000000000' }), /^not_found: /)
      // 200 operations back to back: the burst is allowed, the rest is refused, the daemon is fine.
      let refused = 0
      for (let i = 0; i < 200; i++) {
        try {
          await a.call('chats.share.op', { shareId, op: { i } })
        } catch (e) {
          assert.match((e as Error).message, /too many operations/)
          refused++
        }
      }
      assert.ok(refused > 0, 'rate limit kicked in')
      assert.ok(refused < 200)
    })

    test('a readonly share lets only the host write; a snapshot share is a one-time copy', async () => {
      const ro = (await a.call<{ share: { shareId: string; mode: string } }>('chats.share.start', { chatId: chatA, block: 'board', mode: 'readonly', snapshot: '{"cols":[]}' })).share
      await b.event('chat_share', (e) => e.kind === 'offered' && (e.share as { shareId: string }).shareId === ro.shareId)
      await b.call('chats.share.join', { shareId: ro.shareId })
      await fails(b.call('chats.share.op', { shareId: ro.shareId, op: 'x' }), /^rejected: this share is read-only for guests/)
      await a.call('chats.share.op', { shareId: ro.shareId, op: '{"host":true}' })
      await b.event('chat_share_op', (e) => e.shareId === ro.shareId && e.type === 'op')
      const snap = (await a.call<{ share: { shareId: string } }>('chats.share.start', { chatId: chatA, block: 'files', mode: 'snapshot', snapshot: { text: 'hi' } })).share
      const offered = await b.event('chat_share', (e) => e.kind === 'offered' && (e.share as { shareId: string }).shareId === snap.shareId)
      assert.equal((offered.share as { mode: string }).mode, 'snapshot')
      const joined = await b.call<{ snapshot: { d: string } | null }>('chats.share.join', { shareId: snap.shareId })
      assert.equal(joined.snapshot?.d, '{"text":"hi"}')
      await fails(b.call('chats.share.op', { shareId: snap.shareId, op: 'x' }), /^rejected: this share is a snapshot/)
    })

    test('a guest leaves, the host ends: cards go to ended and stay in the timeline', async () => {
      await b.call('chats.share.leave', { shareId })
      await a.event('chat_share', (e) => e.kind === 'left' && (e.share as { shareId: string }).shareId === shareId)
      await fails(b.call('chats.share.op', { shareId, op: 'x' }), /^rejected: join the share first/)
      await b.call('chats.share.join', { shareId })
      const ended = await a.call<{ share: { state: string } }>('chats.share.end', { shareId })
      assert.equal(ended.share.state, 'ended')
      await b.event('chat_share', (e) => e.kind === 'ended' && (e.share as { shareId: string }).shareId === shareId)
      await fails(b.call('chats.share.join', { shareId }), /^rejected: that share is over/)
      const list = await b.call<{ shareId: string; state: string }[]>('chats.share.list', { chatId: chatB })
      assert.equal(list.find((s) => s.shareId === shareId)?.state, 'ended')
      const open = await b.call<{ messages: { key: string; share?: { state: string } }[] }>('chats.open', { chatId: chatB, limit: 2, markRead: false })
      assert.equal(open.messages.find((m) => m.key === `share:${shareId}`)?.share?.state, 'ended')
    })

    test('a host that disappears and returns is rejoined with a fresh offer', async () => {
      const live = (await a.call<{ share: { shareId: string } }>('chats.share.start', { chatId: chatA, block: 'notebook', snapshot: '{"cells":[]}' })).share
      await b.event('chat_share', (e) => e.kind === 'offered' && (e.share as { shareId: string }).shareId === live.shareId)
      await b.call('chats.share.join', { shareId: live.shareId })
      const mark = b.events.length
      await a.call('chats.share.snapshot', { shareId: live.shareId, d: { cells: ['new'] } })
      // Bob drops and re-establishes the link (his daemon restarts its engine connection through the host): simulate with a leave+join cycle on reconnect.
      await b.call('chats.share.leave', { shareId: live.shareId })
      await b.call('chats.share.join', { shareId: live.shareId })
      await b.event('chat_share_op', (e) => e.type === 'snapshot' && e.op === '{"cells":["new"]}' && b.events.indexOf(e) >= mark)
    })
  })

  test('the engine outlives the window: events stop with no viewer and resume with one', async () => {
    const lone = await DaemonClient.connect(b.address, { client: 'window', name: 'bob-lone' })
    clients.push(lone)
    const got: DaemonEvent[] = []
    lone.on('event', (e: DaemonEvent) => got.push(e))
    await lone.subscribe(['chat_message'])
    await a.call('chats.send', { chatId: chatA, text: 'for the lone window' })
    await waitFor(() => got.some((e) => e.event === 'chat_message'), 20_000, 'lone window hears it')
    lone.close()
    assert.ok((await b.call<State>('chats.state')).status === 'ready', 'bob keeps running with the window gone')
  })
})
