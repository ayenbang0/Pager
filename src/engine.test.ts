import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import DHT from 'hyperdht'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AGENT_NAMES, type AdapterSpec, type AgentName } from './agents/adapters.js'
import { ROOM_ID } from './agents/orchestrator.js'
import { Engine, type EngineOptions, type Toast } from './engine.js'
import { dmConvId } from './events.js'
import { Net, type PeerLink } from './net.js'
import { waitFor } from './testutil.js'

let testnet: Testnet
const engines: Engine[] = []
const nets: Net[] = []

before(async () => {
  testnet = await createTestnet(3)
})
after(async () => {
  await Promise.all(engines.map((e) => e.close()))
  await Promise.all(nets.map((n) => n.stop()))
  await testnet.destroy()
})

interface Peer {
  engine: Engine
  dir: string
  toasts: Toast[]
}

async function boot(
  name: string,
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-e-')),
  extra: Partial<EngineOptions> = {},
): Promise<Peer> {
  const engine = await Engine.open({
    dir,
    bootstrap: testnet.bootstrap,
    dhtOptions: { host: '127.0.0.1' },
    backoff: { baseMs: 50, maxMs: 200 },
    ...extra,
  })
  engines.push(engine)
  const toasts: Toast[] = []
  engine.on('toast', (t: Toast) => toasts.push(t))
  await engine.submit(`/name ${name}`)
  return { engine, dir, toasts }
}

async function befriend(a: Peer, b: Peer): Promise<void> {
  await a.engine.submit(`/add ${b.engine.me.code}`)
  await waitFor(() => b.engine.pending().length > 0, 20_000, `${b.engine.me.name} pending`)
  await b.engine.submit('/accept 1')
  await waitFor(() => a.engine.convs().some((c) => c.peer === b.engine.me.pk && c.online), 20_000, 'a sees b online')
  await waitFor(() => b.engine.convs().some((c) => c.peer === a.engine.me.pk && c.online), 20_000, 'b sees a online')
}

const texts = (p: Peer, conv: string): string[] =>
  p.engine
    .messages(conv, 100)
    .filter((m) => m.kind === 'text')
    .map((m) => m.text)

test('mutual contact, message, delivery receipt', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(conv)
  await a.engine.submit('hi')
  await waitFor(() => texts(b, conv).includes('hi'), 15_000, 'b gets hi')
  await waitFor(() => a.engine.messages(conv, 10).at(-1)?.status === 'delivered', 15_000, 'delivered')
})

test('offline delivery after the recipient restarts', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  await b.engine.close()
  await waitFor(() => a.engine.convs().every((c) => c.online === false), 15_000, 'a sees b offline')
  a.engine.activate(conv)
  await a.engine.submit('one')
  await a.engine.submit('two')
  assert.deepEqual(a.engine.messages(conv, 10).map((m) => m.status), ['pending', 'pending'])
  const b2 = await boot('bob', b.dir)
  await waitFor(() => texts(b2, conv).length === 2, 20_000, 'b gets both')
  assert.deepEqual(texts(b2, conv), ['one', 'two'])
  await waitFor(() => a.engine.messages(conv, 10).every((m) => m.status === 'delivered'), 15_000, 'both delivered')
})

test('strangers are gated; a declined request is blocked', async () => {
  const a = await boot('alice')
  // A raw stranger sending a non-contact-request frame first is dropped.
  const kp = DHT.keyPair()
  const stranger = new Net({
    keyPair: kp,
    bootstrap: testnet.bootstrap,
    dhtOptions: { host: '127.0.0.1' },
    backoff: { baseMs: 50, maxMs: 200 },
    getName: () => 'mallory',
    isBlocked: () => false,
    wanted: () => [a.engine.me.pk],
  })
  nets.push(stranger)
  let closed = 0
  stranger.on('close', () => closed++)
  stranger.on('open', (link: PeerLink) => {
    link.send({ t: 'sync-state', have: {} })
  })
  stranger.start()
  await waitFor(() => closed > 0, 20_000, 'stranger link closed')
  await stranger.stop()

  const c = await boot('carol')
  await c.engine.submit(`/add ${a.engine.me.code} let me in`)
  await waitFor(() => a.engine.pending().length === 1, 20_000, 'a pending')
  assert.equal(a.engine.pending()[0]?.note, 'let me in')
  await a.engine.submit('/decline 1')
  assert.equal(a.engine.pending().length, 0)
  await c.engine.submit(`/remove ${a.engine.me.pk.slice(0, 8)}`)
  await c.engine.submit(`/add ${a.engine.me.code}`)
  // Real time on purpose: negative assertion (no request ever surfaces) has no event to await.
  await sleep(2000)
  assert.equal(a.engine.pending().length, 0)
})

test('group: invite, chat across members, leave is permanent', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  const c = await boot('carol')
  await befriend(a, b)
  await befriend(a, c)
  await a.engine.submit('/group new team')
  const group = a.engine.active()
  assert.ok(group)
  await a.engine.submit('/group invite bob')
  await a.engine.submit('/group invite carol')
  await waitFor(() => b.engine.pending().some((p) => p.type === 'group'), 20_000, 'bob invite')
  await waitFor(() => c.engine.pending().some((p) => p.type === 'group'), 20_000, 'carol invite')
  await b.engine.submit('/accept 1')
  await c.engine.submit('/accept 1')
  b.engine.activate(group)
  c.engine.activate(group)
  await waitFor(() => b.engine.active() === group && c.engine.active() === group, 5000, 'activated')

  await b.engine.submit('hello team')
  await waitFor(() => texts(a, group).includes('hello team') && texts(c, group).includes('hello team'), 25_000, 'fan-out')

  // `/group members` writes to the home view, so re-activate the group before each use.
  const members = (p: Peer): string => {
    p.engine.activate(group)
    void p.engine.submit('/group members')
    return p.engine.home().join('\n')
  }
  // Names of non-contacts are learned once a direct link to them opens.
  await waitFor(() => /alice/.test(members(c)) && /bob/.test(members(c)) && /carol \(you\)/.test(members(c)), 20_000, 'member names')

  c.engine.activate(group)
  await c.engine.submit('/group leave')
  assert.equal(c.engine.convs().some((v) => v.id === group), false)
  await waitFor(() => !/carol/.test(members(a)) && !/carol/.test(members(b)), 20_000, 'carol gone from views')
  a.engine.activate(group)
  await a.engine.submit('/group invite carol')
  assert.equal(a.toasts.at(-1)?.text, 'Already invited to this group')
  assert.doesNotMatch(members(a), /carol/)
})

test('name change propagates to contacts', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  await a.engine.submit('/name alicia')
  await waitFor(() => b.engine.convs().some((v) => v.title === 'alicia'), 15_000, 'new name')
})

test('/theme switches, persists across restarts, and rejects unknown names', async () => {
  const a = await boot('alice')
  await a.engine.submit('/theme MONO')
  assert.equal(a.engine.settings().theme, 'mono')
  assert.equal(a.toasts.at(-1)?.kind, 'success')
  await a.engine.submit('/theme nope')
  assert.equal(a.engine.settings().theme, 'mono')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  a.engine.toggleSidebar()
  await a.engine.close()
  const again = await boot('alice', a.dir)
  assert.deepEqual(again.engine.settings(), { theme: 'mono', sidebar: false })
})

test('agents room: /agent and @name drive agents, plain text is refused, the room is not a conversation', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-r-'))
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'tester')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const fake: AdapterSpec = {
    bin: process.execPath,
    args: (p) => [fileURLToPath(new URL('./agents/testAgent.js', import.meta.url)), p],
    extract: (s) => s.trim(),
  }
  const adapters = Object.fromEntries(AGENT_NAMES.map((n) => [n, fake])) as Record<AgentName, AdapterSpec> // every key is filled by the map above
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: adapters })
  const has = (text: string): boolean => a.engine.messages(ROOM_ID, 50).some((m) => m.text === text)

  await a.engine.submit('/agent omp ECHO hi')
  assert.equal(a.engine.active(), ROOM_ID)
  await waitFor(() => has('hi'), 20_000, 'omp reply')
  await a.engine.submit('@claude ECHO yo')
  await waitFor(() => has('yo'), 20_000, 'claude reply')

  const runs = a.engine.agentRoom().runs.length
  await a.engine.submit('hello')
  assert.equal(a.toasts.at(-1)?.kind, 'warn')
  await a.engine.submit('/agent nope x')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.agentRoom().runs.length, runs)
  assert.ok(a.engine.convs().every((c) => c.id !== ROOM_ID))
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
})
