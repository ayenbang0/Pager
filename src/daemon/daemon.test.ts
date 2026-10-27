import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import type { Engine } from '../app/engine.js'
import { DaemonClient, tryConnect } from './client.js'
import { detachPane, focusAfterClose, movePane, newTab, paneIds, removePane, setRatio, setRatioAt, splitCount, splitPane } from './layout.js'
import { usableCwd, type LaunchSpec } from './launch.js'
import { encodeData, encodeJson, FRAME_DATA, FrameDecoder, MAX_FRAME, type DaemonState, type Node, type Pane, type Session } from './protocol.js'
import { startDaemon, type DaemonHandle } from './server.js'
import { decodeState, encodeState, loadState, ScrollbackCache, StateWriter, type LayoutSource } from './state.js'

const pane = (id: string): Node => ({ type: 'pane', paneId: id })

/** Windows keeps a folder busy for a moment after the program that had it as its cwd is killed. */
async function cleanup(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {})
}

describe('framing', () => {
  test('json and data frames round trip, however the bytes arrive', () => {
    const bytes = Buffer.concat([encodeJson({ id: 1, type: 'state', text: 'héllo' }), encodeData(7, Buffer.from([0, 1, 2, 255])), encodeJson({ event: 'x' })])
    const dec = new FrameDecoder()
    const frames = []
    for (const b of bytes) frames.push(...dec.push(Buffer.from([b])))
    assert.equal(frames.length, 3)
    assert.deepEqual(frames[0], { kind: 'json', json: { id: 1, type: 'state', text: 'héllo' } })
    assert.equal(frames[1]?.kind === 'data' && frames[1].paneId, 7)
    assert.deepEqual(frames[1]?.kind === 'data' ? [...frames[1].data] : [], [0, 1, 2, 255])
    assert.deepEqual(new FrameDecoder().push(bytes).length, 3)
  })

  test('unknown frame types and corrupt json are skipped, not fatal', () => {
    const unknown = Buffer.from([3, 0, 0, 0, 9, 1, 2])
    const bad = Buffer.concat([Buffer.from([4, 0, 0, 0, 0]), Buffer.from('{x}')])
    const frames = new FrameDecoder().push(Buffer.concat([unknown, bad, encodeJson({ ok: true })]))
    assert.equal(frames[0]?.kind, 'other')
    assert.deepEqual(frames[1], { kind: 'json', json: { ok: true } })
    assert.equal(frames.length, 2)
  })

  test('an absurd length closes the stream', () => {
    const head = Buffer.alloc(5)
    head.writeUInt32LE(MAX_FRAME + 1, 0)
    head[4] = FRAME_DATA
    assert.throws(() => new FrameDecoder().push(head))
    assert.throws(() => new FrameDecoder().push(Buffer.alloc(4)))
  })
})

describe('layout', () => {
  const tree: Node = { type: 'split', dir: 'row', ratio: 0.5, a: pane('1'), b: { type: 'split', dir: 'col', ratio: 0.5, a: pane('2'), b: pane('3') } }

  test('split puts the new pane after (or before) and clamps the ratio', () => {
    const t = splitPane(pane('1'), '1', 'row', '2', { ratio: 5 })
    assert.deepEqual(t, { type: 'split', dir: 'row', ratio: 0.9, a: pane('1'), b: pane('2') })
    const before = splitPane(pane('1'), '1', 'col', '2', { before: true, ratio: 0.3 })
    assert.deepEqual(paneIds(before), ['2', '1'])
    assert.equal(splitCount(tree), 2)
  })

  test('removing a leaf promotes its sibling; the last leaf leaves null', () => {
    assert.deepEqual(removePane(tree, '1'), tree.type === 'split' ? tree.b : null)
    assert.deepEqual(paneIds(removePane(tree, '3')!), ['1', '2'])
    assert.equal(removePane(pane('1'), '1'), null)
  })

  test('ratios: by sibling leaf and by route', () => {
    const direct = setRatio(tree, '2', 0.2)
    assert.equal(direct.type === 'split' && direct.b.type === 'split' && direct.b.ratio, 0.2)
    assert.equal(direct.type === 'split' && direct.ratio, 0.5)
    const both: Node = { type: 'split', dir: 'row', ratio: 0.5, a: tree, b: tree }
    const routed = setRatioAt(both, 'bb', 0.7)
    assert.equal(routed.type === 'split' && routed.b.type === 'split' && routed.b.b.type === 'split' && routed.b.b.ratio, 0.7)
    assert.equal(routed.type === 'split' && routed.b.type === 'split' && routed.b.ratio, 0.5)
    const root = setRatioAt(both, '', 0.05)
    assert.equal(root.type === 'split' && root.ratio, 0.1)
  })

  test('focus after close lands on the nearest sibling leaf', () => {
    assert.equal(focusAfterClose(tree, '1'), '2')
    assert.equal(focusAfterClose(tree, '3'), '2')
    assert.equal(focusAfterClose(tree, '2'), '3')
  })

  test('detach closes an emptied tab, move re-homes a pane', () => {
    const sessions: Session[] = [{ id: 's1', name: 'a', tabs: [newTab('t1', 'one', '1'), { id: 't2', title: 'two', root: tree.type === 'split' ? tree.b : tree, focus: '2' }], activeTab: 't1' }]
    assert.equal(movePane(sessions, '3', 't1'), true)
    assert.deepEqual(paneIds(sessions[0]!.tabs[0]!.root), ['1', '3'])
    assert.deepEqual(paneIds(sessions[0]!.tabs[1]!.root), ['2'])
    const gone = detachPane(sessions, '2')
    assert.equal(gone?.tabClosed, true)
    assert.deepEqual(
      sessions[0]!.tabs.map((t) => t.id),
      ['t1'],
    )
    assert.equal(movePane(sessions, '1', 'nope'), false)
  })
})

describe('state file', () => {
  const meta = (id: string, over: Partial<Pane> = {}): Pane => ({ id, kind: 'shell', title: 't', cwd: os.tmpdir(), cols: 80, rows: 24, state: 'running', pid: 4, ...over })
  const source = (panes: { pane: Pane; out: Buffer }[]): LayoutSource => ({
    nextPane: 9,
    nextTab: 3,
    nextSession: 2,
    activeSession: 's1',
    sessions: [{ id: 's1', name: 'main', tabs: [newTab('t1', 'x', '1')], activeTab: 't1' }],
    renamedTabs: ['t1'],
    panes: panes.map((p) => ({ pane: p.pane, total: p.out.length, tail: (n) => (p.out.length <= n ? p.out : p.out.subarray(p.out.length - n)) })),
  })

  test('round trip keeps layout, cwd, kind and the newest scrollback', async () => {
    const big = Buffer.from('x'.repeat(5000) + 'NEWEST')
    const text = await encodeState(source([{ pane: meta('1'), out: big }, { pane: meta('2', { state: 'exited', exitCode: 3, kind: 'omp' }), out: Buffer.from('bye') }]), new ScrollbackCache(), 1000)
    const s = await decodeState(text)
    assert.ok(s)
    assert.equal(s.nextPane, 9)
    assert.deepEqual(s.renamedTabs, ['t1'])
    assert.equal(s.panes.length, 2)
    assert.equal(s.panes[0]!.scrollback.length, 1000)
    assert.ok(s.panes[0]!.scrollback.toString().endsWith('NEWEST'))
    assert.equal(s.panes[0]!.pane.cwd, os.tmpdir())
    assert.equal('pid' in s.panes[0]!.pane, false)
    assert.equal(s.panes[1]!.exited, true)
    assert.equal(s.panes[1]!.pane.kind, 'omp')
  })

  test('the total cap trims the biggest pane first', async () => {
    const noise = (n: number): Buffer => randomBytes(n)
    const text = await encodeState(source([{ pane: meta('1'), out: noise(60_000) }, { pane: meta('2'), out: noise(2000) }]), new ScrollbackCache(), 60_000, 20_000)
    const s = (await decodeState(text))!
    assert.ok(s.panes[0]!.scrollback.length < 60_000)
    assert.equal(s.panes[1]!.scrollback.length, 2000)
  })

  test('unreadable files are refused', async () => {
    assert.equal(await decodeState('not json'), undefined)
    assert.equal(await decodeState(JSON.stringify({ version: 99, sessions: [], panes: [] })), undefined)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-state-'))
    try {
      const file = path.join(dir, 'daemon.state')
      fs.writeFileSync(file, '{broken')
      assert.equal(await loadState(file), undefined)
      assert.equal(fs.existsSync(`${file}.bad`), true)
      assert.equal(fs.existsSync(file), false)
    } finally {
      await cleanup(dir)
    }
  })

  test('the writer debounces, writes atomically and flushes on demand', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-writer-'))
    try {
      const file = path.join(dir, 'daemon.state')
      let calls = 0
      const w = new StateWriter(file, () => {
        calls++
        return source([{ pane: meta('1'), out: Buffer.from('hi') }])
      }, { layoutMs: 30, dataMs: 10_000 })
      for (let i = 0; i < 5; i++) w.touch('layout')
      w.touch('data')
      await sleep(250)
      assert.equal(calls, 1)
      assert.equal((await loadState(file))?.panes[0]?.scrollback.toString(), 'hi')
      w.touch('data')
      await w.flush()
      assert.equal(calls, 2)
      await w.flush() // nothing changed
      assert.equal(calls, 2)
      assert.deepEqual(
        fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
        [],
      )
    } finally {
      await cleanup(dir)
    }
  })
})

// A program that prints its folder, then echoes what it is typed (after Enter) with a marker the typed text cannot contain.
const ECHO = "process.stdout.write('cwd:'+process.cwd()+'\\r\\n');process.stdin.on('data',d=>process.stdout.write('echo['+String(d).trim()+']\\r\\n'));setInterval(()=>{},1e6)"
const FLOOD = "const s='z'.repeat(60000);process.stdin.once('data',()=>{let n=0;const t=setInterval(()=>{process.stdout.write(s+'\\r\\n');if(++n>=20){clearInterval(t);process.stdout.write('FLOOD-END\\r\\n');process.stdin.on('data',d=>process.stdout.write('live['+String(d).trim()+']\\r\\n'))}},2)});setInterval(()=>{},1e6)"

const launcher = async (req: { cwd: string; argv?: string[]; command?: string }): Promise<LaunchSpec> => ({
  file: process.execPath,
  args: ['-e', req.command === 'flood' ? FLOOD : ECHO],
  cwd: usableCwd(req.cwd),
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  integrated: false,
  shell: false,
})

const addr = (tag: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\pager-test-${process.pid}-${tag}-${Date.now()}` : path.join(os.tmpdir(), `pager-test-${process.pid}-${tag}-${Date.now()}.sock`))

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function collect(c: DaemonClient): { text(id: string): string } {
  const got = new Map<number, Buffer[]>()
  c.on('data', (id: number, d: Buffer) => got.set(id, [...(got.get(id) ?? []), d]))
  return { text: (id) => Buffer.concat(got.get(Number(id)) ?? []).toString('utf8') }
}

describe('daemon', () => {
  let dir: string
  let daemon: DaemonHandle
  let address: string
  const open: DaemonClient[] = []

  const connect = async (client = 'window'): Promise<DaemonClient> => {
    const c = await DaemonClient.connect(address, { client, name: `t${open.length}` })
    open.push(c)
    return c
  }
  const boot = async (over: { slowBytes?: number } = {}): Promise<void> => {
    daemon = await startDaemon({ dir, address, cliPath: 'unused', launcher, log: () => {}, layoutSaveMs: 20, dataSaveMs: 50, ...over })
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-daemon-test-'))
    address = addr('main')
    await boot()
  })

  after(async () => {
    for (const c of open) c.close()
    await daemon.close()
    await cleanup(dir)
  })

  test('hello comes first; the daemon reports who is attached', async () => {
    const raw = (await import('node:net')).createConnection(address)
    const got = Promise.withResolvers<unknown>()
    const dec = new FrameDecoder()
    raw.on('data', (d) => {
      const f = dec.push(d)[0]
      if (f?.kind === 'json') got.resolve(f.json)
    })
    raw.write(encodeJson({ id: 1, type: 'state' }))
    assert.deepEqual(await got.promise, { id: 1, ok: false, error: 'the first request must be hello' })
    raw.destroy()
    const w = await connect()
    assert.equal(((await w.call('state')) as DaemonState).clients, open.filter((c) => c.alive).length)
    const cli = await connect('cli')
    assert.equal(((await cli.call('state')) as DaemonState).clients, open.filter((c) => c.alive).length - 1)
  })

  test('the first pane of a session is the Home block: no process, never closes, by pane or by tab', async () => {
    const c = await connect()
    const made = (await c.call('session.new', { name: 'home', cwd: os.tmpdir() })) as { paneId: string; tabId: string; sessionId: string }
    let state = (await c.call('state')) as DaemonState
    const home = state.panes.find((p) => p.id === made.paneId)
    assert.equal(home?.kind, 'block:home')
    assert.equal(home?.state, 'running')
    assert.equal(home?.pid, undefined)
    await assert.rejects(c.call('pane.close', { paneId: made.paneId }), /stays open/)
    await assert.rejects(c.call('tab.close', { tabId: made.tabId }), /stays open/)
    // With a Home alive, a new tab is a shell; once it is gone, the next session starts with Home again.
    const tab = (await c.call('tab.new', { kind: 'shell' })) as { paneId: string }
    state = (await c.call('state')) as DaemonState
    assert.equal(state.panes.find((p) => p.id === tab.paneId)?.kind, 'shell')
    assert.equal(state.panes.find((p) => p.id === made.paneId)?.kind, 'block:home')
    await c.call('session.close', { sessionId: made.sessionId })
  })

  test('the classic pager terminal is an ordinary pane: two clients see the same output, input from either reaches it', async () => {
    const a = await connect()
    const b = await connect()
    const seenA = collect(a)
    const seenB = collect(b)
    const made = (await a.call('session.new', { name: 'main', cwd: os.tmpdir(), kind: 'pager' })) as { paneId: string }
    const state = (await a.call('state')) as DaemonState
    assert.equal(state.panes.find((p) => p.id === made.paneId)?.kind, 'pager')
    await a.attach(made.paneId, { cols: 100, rows: 30 })
    await b.attach(made.paneId)
    await until('startup line', () => seenA.text(made.paneId).includes('cwd:') && seenB.text(made.paneId).includes('cwd:'))
    a.input(made.paneId, 'from-a\r')
    await until('echo from a on both', () => seenA.text(made.paneId).includes('echo[from-a]') && seenB.text(made.paneId).includes('echo[from-a]'))
    await b.call('pane.input', { paneId: made.paneId, data: 'from-b\r' })
    await until('echo from b on both', () => seenA.text(made.paneId).includes('echo[from-b]') && seenB.text(made.paneId).includes('echo[from-b]'))
    assert.equal(((await a.call('state')) as DaemonState).panes.find((p) => p.id === made.paneId)?.cols, 100)
  })

  test('capture returns the screen as text', async () => {
    const c = await connect('cli')
    const state = (await c.call('state')) as DaemonState
    const id = state.panes[0]!.id
    const cap = (await c.call('pane.capture', { paneId: id })) as { text: string; cols: number }
    assert.match(cap.text, /echo\[from-a\]/)
    assert.match(cap.text, /cwd:/)
    const last = (await c.call('pane.capture', { paneId: id, lines: 1 })) as { text: string }
    assert.equal(last.text.split('\n').length, 1)
    const raw = (await c.call('pane.capture', { paneId: id, plain: false })) as { text: string }
    assert.match(raw.text, /echo\[from-b\]/)
    await assert.rejects(c.call('pane.capture', { paneId: '999' }), /no such pane/)
  })

  test('the daemon survives its last client detaching, and a new client replays the output', async () => {
    for (const c of open.splice(0)) c.close()
    await sleep(150)
    const again = await connect()
    const state = (await again.call('state')) as DaemonState
    assert.equal(state.panes.length, 1)
    assert.equal(state.panes[0]!.state, 'running')
    const at = await again.attach(state.panes[0]!.id, { cols: 90, rows: 20 })
    const replay = at.replay.toString('utf8')
    assert.match(replay, /echo\[from-a\]/)
    assert.match(replay, /echo\[from-b\]/)
    assert.equal(at.cols, 90)
    assert.ok(at.seq >= at.replay.length)
    // After a detach the pane keeps its last size (nobody votes), and keeps running.
    again.close()
    await sleep(100)
    const cli = await connect('cli')
    assert.equal(((await cli.call('state')) as DaemonState).panes[0]!.state, 'running')
  })

  test('layout requests: split, ratio by route, focus, rename, move, close', async () => {
    const c = await connect()
    const s0 = (await c.call('state')) as DaemonState
    const first = s0.panes[0]!.id
    const split = (await c.call('pane.split', { paneId: first, dir: 'row', kind: 'shell', ratio: 0.3 })) as { paneId: string }
    const tab = (await c.call('tab.new', { kind: 'shell' })) as { tabId: string; paneId: string }
    let s = (await c.call('state')) as DaemonState
    const sess = s.sessions[0]!
    assert.equal(sess.tabs.length, 2)
    assert.equal(s.activeSession, sess.id)
    assert.equal(sess.activeTab, tab.tabId)
    await c.call('pane.ratio', { paneId: first, ratio: 0.8, path: '' })
    await c.call('pane.focus', { paneId: first })
    await c.call('tab.rename', { tabId: sess.tabs[0]!.id, title: 'Mine' })
    await c.call('session.rename', { sessionId: sess.id, name: 'Work' })
    await c.call('pane.move', { paneId: split.paneId, toTab: tab.tabId })
    s = (await c.call('state')) as DaemonState
    const t0 = s.sessions[0]!.tabs[0]!
    assert.equal(t0.title, 'Mine')
    assert.equal(s.sessions[0]!.name, 'Work')
    assert.equal(t0.root.type, 'pane')
    assert.equal(s.sessions[0]!.tabs[1]!.root.type, 'split')
    await c.call('pane.close', { paneId: split.paneId })
    await c.call('tab.close', { tabId: tab.tabId })
    s = (await c.call('state')) as DaemonState
    assert.equal(s.panes.length, 1)
    assert.equal(s.sessions[0]!.tabs.length, 1)
    await assert.rejects(c.call('pane.split', { paneId: first, dir: 'sideways' }), /dir must be/)
    await assert.rejects(c.call('nope'), /unknown request/)
  })

  test('events reach subscribers, filtered by name', async () => {
    const c = await connect()
    const seen: string[] = []
    c.on('event', (e: { event: string }) => seen.push(e.event))
    await c.subscribe(['pane_spawned', 'pane_closed'])
    await assert.rejects(c.subscribe(['bogus']), /unknown event/)
    await c.subscribe(['pane_spawned', 'pane_closed'])
    const t = (await c.call('tab.new', { kind: 'shell' })) as { paneId: string; tabId: string }
    await c.call('pane.close', { paneId: t.paneId })
    await until('both events', () => seen.includes('pane_spawned') && seen.includes('pane_closed'))
    assert.deepEqual([...new Set(seen)].sort(), ['pane_closed', 'pane_spawned'])
  })

  test('settings persist to desktop.json and reach the state', async () => {
    const c = await connect()
    const s = (await c.call('settings.set', { patch: { fontSize: 17, cursor: { blink: false } } })) as { fontSize: number; cursor: { blink: boolean; trail: string } }
    assert.equal(s.fontSize, 17)
    assert.equal(s.cursor.blink, false)
    assert.equal(s.cursor.trail, 'off')
    await until('desktop.json', () => fs.existsSync(path.join(dir, 'desktop.json')))
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop.json'), 'utf8')).fontSize, 17)
    assert.equal(((await c.call('state')) as DaemonState).settings.fontSize, 17)
  })
})

describe('slow clients', () => {
  test('a client that cannot keep up loses output, is told, and recovers through attach', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-daemon-slow-'))
    const address = addr('slow')
    const d = await startDaemon({ dir, address, cliPath: 'unused', launcher, log: () => {}, slowBytes: 256 * 1024 })
    const c = await DaemonClient.connect(address, { client: 'window' })
    try {
      const made = (await c.call('session.new', { cwd: os.tmpdir(), command: 'flood', kind: 'shell' })) as { paneId: string }
      await c.attach(made.paneId)
      const resync = Promise.withResolvers<void>()
      c.on('event', (e: { event: string }) => e.event === 'pane_resync' && resync.resolve())
      // The window stops reading while the program prints 1.2 MB: far more than its 256 KB allowance.
      c.pause()
      const other = await DaemonClient.connect(address, { client: 'cli' })
      await other.call('pane.input', { paneId: made.paneId, data: 'go\r' })
      await until('the flood to end', async () => ((await other.call('pane.capture', { paneId: made.paneId, lines: 3 })) as { text: string }).text.includes('FLOOD-END'))
      c.resume()
      await Promise.race([resync.promise, sleep(8000).then(() => assert.fail('no pane_resync arrived'))])
      const at = await c.attach(made.paneId)
      assert.ok(at.replay.toString().includes('FLOOD-END'))
      assert.ok(at.seq > 1_000_000)
      // Attached again: live output flows once more, continuing from the replay's sequence number.
      const live = collect(c)
      await other.call('pane.input', { paneId: made.paneId, data: 'again\r' })
      await until('live output after resync', () => live.text(made.paneId).includes('live[again]'))
      assert.ok(c.seqOf(made.paneId) > at.seq)
      other.close()
    } finally {
      c.close()
      await d.close()
      await cleanup(dir)
    }
  })
})

describe('shutdown', () => {
  test('a client that connects while the chat engine is still closing is refused and cannot keep the daemon alive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-daemon-stop-'))
    fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify({ chatsOn: true }))
    const address = addr('stop')
    const opening = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<Engine>()
    const openEngine = (): Promise<Engine> => {
      opening.resolve()
      return gate.promise
    }
    const d = await startDaemon({ dir, address, cliPath: 'unused', launcher, log: () => {}, chats: { acquire: () => () => {}, openEngine } })
    try {
      await Promise.race([opening.promise, sleep(10_000).then(() => assert.fail('the chat engine never began opening'))])
      // Closing the chats host is the slow step of shutdown, and it waits for the engine that is still opening.
      const stopping = d.close()
      await assert.rejects(DaemonClient.connect(address, { client: 'window', timeoutMs: 1000 }), 'a stopping daemon must not accept clients')
      gate.reject(new Error('engine opening abandoned'))
      const outcome = await Promise.race([stopping.then(() => 'stopped'), sleep(5000).then(() => 'still waiting')])
      assert.equal(outcome, 'stopped')
    } finally {
      gate.reject(new Error('test over'))
      await d.close()
      await cleanup(dir)
    }
  })
})

describe('restore', () => {
  test('after a restart panes come back in their folder over their old output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-daemon-restore-'))
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-restore-cwd-'))
    const address = addr('restore')
    const opts = { dir, address, cliPath: 'unused', launcher, log: () => {}, layoutSaveMs: 20, dataSaveMs: 50 }
    let d: DaemonHandle | undefined = await startDaemon(opts)
    try {
      let c = await DaemonClient.connect(address, { client: 'window' })
      const first = (await c.call('session.new', { name: 'Home', cwd: work })) as { paneId: string; tabId: string; sessionId: string }
      const second = (await c.call('pane.split', { paneId: first.paneId, dir: 'col', kind: 'shell', cwd: work })) as { paneId: string }
      await c.call('tab.rename', { tabId: first.tabId, title: 'Kept' })
      await c.attach(second.paneId)
      const seen = collect(c)
      c.input(second.paneId, 'before-restart\r')
      await until('output', () => seen.text(second.paneId).includes('echo[before-restart]'))
      c.close()
      await d.close() // the final flush writes daemon.state
      assert.equal(fs.existsSync(path.join(dir, 'daemon.state')), true)
      assert.equal(await tryConnect(address), undefined)

      d = await startDaemon(opts)
      c = await DaemonClient.connect(address, { client: 'window' })
      const state = (await c.call('state')) as DaemonState
      assert.equal(state.panes.length, 2)
      assert.equal(state.sessions[0]!.name, 'Home')
      assert.equal(state.sessions[0]!.tabs[0]!.title, 'Kept')
      const back = state.panes.find((p) => p.id === second.paneId)!
      assert.equal(back.state, 'restored')
      assert.equal(back.cwd, work)
      assert.equal(back.kind, 'shell')
      assert.equal(state.panes.find((p) => p.id === first.paneId)?.kind, 'block:home')
      const at = await c.attach(second.paneId)
      const replay = at.replay.toString('utf8')
      assert.match(replay, /echo\[before-restart\]/)
      assert.match(replay, /restored/)
      await until('the new program in the old folder', async () => ((await c.attach(second.paneId)).replay.toString().match(/cwd:/g) ?? []).length >= 2)
      assert.ok((await c.attach(second.paneId)).replay.toString().includes(`cwd:${fs.realpathSync(work)}`) || (await c.attach(second.paneId)).replay.toString().includes(`cwd:${work}`))
      // New ids continue after the restored ones.
      const next = (await c.call('tab.new', { kind: 'shell' })) as { paneId: string }
      assert.ok(Number(next.paneId) > Number(second.paneId))
      // Typing marks the pane running again.
      c.input(second.paneId, 'hello\r')
      await until('state running', async () => ((await c.call('state')) as DaemonState).panes.find((p) => p.id === second.paneId)?.state === 'running')
      c.close()
    } finally {
      await d?.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })

  test('state from before Home was a block gets a Home tab first; the old pager pane stays and can close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-daemon-oldhome-'))
    const address = addr('oldhome')
    const opts = { dir, address, cliPath: 'unused', launcher, log: () => {}, layoutSaveMs: 20, dataSaveMs: 50 }
    let d: DaemonHandle | undefined = await startDaemon(opts)
    try {
      let c = await DaemonClient.connect(address, { client: 'window' })
      const old = (await c.call('session.new', { name: 'Old', cwd: os.tmpdir(), kind: 'pager' })) as { paneId: string }
      c.close()
      await d.close()
      d = await startDaemon(opts)
      c = await DaemonClient.connect(address, { client: 'window' })
      const state = (await c.call('state')) as DaemonState
      const root = state.sessions[0]!.tabs[0]!.root
      const firstPane = root.type === 'pane' ? state.panes.find((p) => p.id === root.paneId) : undefined
      assert.equal(firstPane?.kind, 'block:home')
      assert.equal(state.sessions[0]!.tabs.length, 2)
      assert.equal(state.panes.find((p) => p.id === old.paneId)?.kind, 'pager')
      const oldTab = state.sessions[0]!.tabs[1]!
      await c.call('tab.close', { tabId: oldTab.id })
      c.close()
    } finally {
      await d?.close()
      await cleanup(dir)
    }
  })
})

// node-pty on Windows keeps its two pipes open after kill(); left alone they hold this test process open after the last test.
after(() => {
  setTimeout(() => process.exit(), 300).unref()
})
