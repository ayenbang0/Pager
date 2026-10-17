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
import type { AdapterSpec } from './agents/adapters.js'
import { agentTabId } from './agents/ids.js'
import { ROOM_ID } from './agents/orchestrator.js'
import { Engine, type EngineOptions, type Toast } from './engine.js'
import { dmConvId } from './events.js'
import { resetDesktopState } from './desktop.js'
import { DEFAULT_SETTINGS } from './settings.js'
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
  await waitFor(() => ['delivered', 'read'].includes(a.engine.messages(conv, 10).at(-1)?.status ?? ''), 15_000, 'delivered')
})

test('desktop alerts fire for an accepted request, a message and a read receipt', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pager-n-')), 'alerts.jsonl')
  process.env.PAGER_NOTIFY_FILE = file
  resetDesktopState()
  try {
    const a = await boot('alice')
    const b = await boot('bob')
    await befriend(a, b)
    const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
    a.engine.activate(conv)
    b.engine.activate(conv) // bob has the chat open, so he reads it as it arrives
    await a.engine.submit('ping from alice')
    const alerts = (): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const x = JSON.parse(l) as { title: string; body: string }; return `${x.title}: ${x.body}` }) : [])
    await waitFor(() => alerts().includes('alice: ping from alice'), 15_000, 'message alert on bob')
    await waitFor(() => alerts().includes('bob: bob read your message'), 15_000, 'read receipt alert on alice')
    const all = alerts()
    assert.ok(all.some((l) => l.startsWith('alice: alice wants to connect')), 'request alert')
    assert.ok(all.includes('bob: bob accepted your contact request'), 'accept alert')
    assert.ok(a.toasts.some((t) => t.text === 'bob read your message'), 'and a popup in pager')
    assert.equal(a.engine.messages(conv, 10).at(-1)?.status, 'read')
  } finally {
    delete process.env.PAGER_NOTIFY_FILE
  }
})

test('a contact who comes back online raises a desktop alert and a popup, once', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pager-n-')), 'alerts.jsonl')
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  await b.engine.close()
  await waitFor(() => a.engine.convs().every((c) => c.online === false), 15_000, 'a sees b offline')
  process.env.PAGER_NOTIFY_FILE = file
  resetDesktopState()
  try {
    await boot('bob', b.dir)
    await waitFor(() => a.toasts.some((t) => t.text === 'bob is online'), 20_000, 'online popup')
    await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('bob is online'), 5_000, 'online alert')
    assert.equal(a.toasts.filter((t) => t.text === 'bob is online').length, 1)
  } finally {
    delete process.env.PAGER_NOTIFY_FILE
  }
})

test(':shortcode: emoji expand when a chat message is sent, on the wire and locally, but not inside code', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(conv)
  await a.engine.submit('ship it :rocket: :nope: `:fire:`')
  const sent = 'ship it 🚀 :nope: `:fire:`'
  assert.deepEqual(texts(a, conv), [sent])
  await waitFor(() => texts(b, conv).includes(sent), 15_000, 'b gets the expanded text')
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
  await waitFor(() => a.engine.messages(conv, 10).every((m) => m.status === 'delivered' || m.status === 'read'), 15_000, 'both delivered')
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
  assert.deepEqual(again.engine.settings(), { ...DEFAULT_SETTINGS, theme: 'mono', sidebar: false })
})

test('/theme with no argument opens the picker; /theme list names the themes', async () => {
  const a = await boot('alice')
  const opened: unknown[][] = []
  a.engine.on('overlay', (...args: unknown[]) => opened.push(args))
  await a.engine.submit('/theme')
  assert.deepEqual(opened, [['theme']])
  await a.engine.submit('/theme list')
  assert.match(a.toasts.at(-1)?.text ?? '', /Available: .*neon.*sunset.*aurora/)
  await a.engine.close()
})

test('/accent, /badge and /density persist, validate and reset', async () => {
  const a = await boot('alice')
  await a.engine.submit('/accent #F0A')
  assert.equal(a.engine.settings().accent, '#ff00aa')
  await a.engine.submit('/accent not-a-color')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().accent, '#ff00aa')
  await a.engine.submit('/badge :rocket:')
  assert.equal(a.engine.settings().badge, '🚀')
  await a.engine.submit('/badge :nosuchcode:')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  await a.engine.submit('/badge ab')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().badge, '🚀')
  await a.engine.submit('/density roomy')
  assert.equal(a.engine.settings().density, 'roomy')
  await a.engine.submit('/density huge')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().density, 'roomy')
  await a.engine.close()
  const again = await boot('alice', a.dir)
  assert.deepEqual(again.engine.settings(), { ...DEFAULT_SETTINGS, accent: '#ff00aa', badge: '🚀', density: 'roomy' })
  await again.engine.submit('/accent auto')
  await again.engine.submit('/badge none')
  assert.equal(again.engine.settings().accent, '')
  assert.equal(again.engine.settings().badge, 'none')
  await again.engine.close()
})

test('/quit and /exit both ask the app to quit', async () => {
  const a = await boot('quitter')
  let quits = 0
  a.engine.on('quit', () => quits++)
  await a.engine.submit('/quit')
  await a.engine.submit('/exit')
  assert.equal(quits, 2)
  await a.engine.close()
})

test('agent tabs: /agent and @name drive agents, plain text is refused in the hub, the hub is not a conversation', async () => {
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
  const adapters: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: adapters })
  await a.engine.checkAgents()
  assert.deepEqual(a.engine.agentNames(), ['omp', 'claude', 'opencode', 'hermes'])
  const has = (tab: string, text: string): boolean => a.engine.messages(tab, 50).some((m) => m.text === text)

  await a.engine.submit('/agent omp ECHO hi')
  assert.equal(a.engine.active(), agentTabId('omp'))
  await waitFor(() => has(agentTabId('omp'), 'hi'), 20_000, 'omp reply')
  assert.ok(has(ROOM_ID, 'hi'), 'the hub shows it too')
  await a.engine.submit('@claude ECHO yo')
  await waitFor(() => has(agentTabId('claude'), 'yo'), 20_000, 'claude reply')
  assert.ok(!has(agentTabId('omp'), 'yo'), "omp's tab does not show claude's reply")

  const runs = a.engine.agentRoom().runs.length
  await a.engine.submit('hello')
  assert.equal(a.engine.active(), agentTabId('omp'), 'plain text in an agent tab goes to that agent')
  await waitFor(() => a.engine.agentRoom().runs.length === runs + 1, 20_000, 'omp turn for plain text')
  await a.engine.submit('/agent nope x')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  a.engine.activate(ROOM_ID)
  const before = a.engine.agentRoom().runs.length
  await a.engine.submit('hello')
  assert.equal(a.toasts.at(-1)?.kind, 'warn')
  assert.equal(a.engine.agentRoom().runs.length, before)
  assert.ok(a.engine.convs().every((c) => c.id !== ROOM_ID))
  await a.engine.submit('/agent color omp #ff8800')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#ff8800')
  await a.engine.submit('/agent color omp teal')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#14d8c4')
  await a.engine.submit('/agent color omp blorple')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#14d8c4')
  await a.engine.submit('/agent color omp auto')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, undefined)
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
})

test("a command an agent advertises runs verbatim in that agent's tab; pager commands win; elsewhere it is unknown", async () => {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-e-'))
  fs.writeFileSync(path.join(dir, 'agents-commands.json'), JSON.stringify({ omp: [{ name: 'usage', description: 'limits' }, { name: 'help', description: 'clash' }] }))
  const a = await boot('alice', dir, { workdir: repo, agentAdapters: { omp: fake, claude: fake, opencode: fake, hermes: fake } })
  await a.engine.checkAgents()
  assert.deepEqual(a.engine.agentCommands('omp').map((c) => c.name), ['usage', 'help'])
  a.engine.activate(agentTabId('omp'))
  await a.engine.submit('/usage')
  await waitFor(() => a.engine.agentRoom().runs.length === 1, 20_000, 'verbatim turn')
  assert.ok(a.engine.messages(agentTabId('omp'), 20).some((m) => m.text.startsWith('@omp /usage')))
  const before = a.toasts.length
  await a.engine.submit('/help')
  assert.equal(a.engine.agentRoom().runs.length, 1, 'a pager command is not sent to the agent')
  assert.equal(a.toasts.length, before)
  await a.engine.submit('/nothing')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  a.engine.activate(ROOM_ID)
  await a.engine.submit('/usage')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.agentRoom().runs.length, 1)
  assert.equal(typeof a.engine.agentReview(), 'boolean')
  assert.equal(a.engine.agentStats().week.length, 14)
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
})

test('input history is de-duplicated, newest last, and survives a restart', async () => {
  const a = await boot('hist')
  await a.engine.submit('/theme nord')
  await a.engine.submit('/theme dracula')
  await a.engine.submit('/theme nord')
  assert.deepEqual(a.engine.history().slice(-2), ['/theme dracula', '/theme nord'])
  assert.equal(a.engine.history().filter((h) => h === '/theme nord').length, 1)
  await a.engine.close()
  const again = await boot('hist', a.dir)
  assert.deepEqual(again.engine.history().slice(-3, -1), ['/theme dracula', '/theme nord'])
})

test('docs: a shared document syncs between peers and its operations never show up as chat', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(conv)
  await a.engine.submit('/doc new plan in bob')
  const id = a.engine.openedDoc()
  assert.ok(id)
  a.engine.docs.insert(id, 0, '# Plan\n')
  a.engine.docs.flush()
  await waitFor(() => b.engine.docList().some((d) => d.name === 'plan.md' && d.where === 'alice'), 20_000, 'bob sees the doc')
  assert.equal(b.engine.docs.text(id), '# Plan\n')
  b.engine.docs.insert(id, 7, 'from bob')
  a.engine.docs.insert(id, 7, 'from alice')
  b.engine.docs.flush()
  a.engine.docs.flush()
  await waitFor(() => a.engine.docs.text(id) === b.engine.docs.text(id) && a.engine.docs.text(id).includes('from bob') && a.engine.docs.text(id).includes('from alice'), 20_000, 'both edits merge')
  assert.deepEqual(texts(b, conv), [])
  assert.deepEqual(texts(a, conv), [])
  assert.equal(b.engine.convs().find((c) => c.id === conv)?.unread, 0)
  // Documents survive a restart: operations are replayed from the stored events.
  await b.engine.close()
  const again = await boot('bob', b.dir)
  assert.equal(again.engine.docs.text(id), a.engine.docs.text(id))
})
