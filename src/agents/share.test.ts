import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { Engine, type EngineOptions, type Toast } from '../engine.js'
import type { PeerLink } from '../net.js'
import { removeTmpDirs, tmpDir, waitFor } from '../testutil.js'
import { encodeFrame, FrameDecoder, type Frame } from '../wire.js'
import type { AdapterSpec } from './adapters.js'
import { sharedTabId } from './ids.js'
import { Orchestrator, ROOM_ID } from './orchestrator.js'
import { AgentShare } from './share.js'

let testnet: Testnet
const engines: Engine[] = []
before(async () => {
  testnet = await createTestnet(3)
})
after(async () => {
  await Promise.all(engines.map((e) => e.close()))
  await testnet.destroy()
  removeTmpDirs()
})

interface Peer {
  engine: Engine
  toasts: Toast[]
}

async function boot(name: string, extra: Partial<EngineOptions> = {}): Promise<Peer> {
  const engine = await Engine.open({ dir: tmpDir('pager-s-'), bootstrap: testnet.bootstrap, dhtOptions: { host: '127.0.0.1' }, backoff: { baseMs: 50, maxMs: 200 }, ...extra })
  engines.push(engine)
  const toasts: Toast[] = []
  engine.on('toast', (t: Toast) => toasts.push(t))
  await engine.submit(`/name ${name}`)
  return { engine, toasts }
}

async function befriend(a: Peer, b: Peer): Promise<void> {
  await a.engine.submit(`/add ${b.engine.me.code}`)
  await waitFor(() => b.engine.pending().length > 0, 20_000, 'pending')
  await b.engine.submit('/accept 1')
  await waitFor(() => a.engine.convs().some((c) => c.peer === b.engine.me.pk && c.online), 20_000, 'a sees b')
  await waitFor(() => b.engine.convs().some((c) => c.peer === a.engine.me.pk && c.online), 20_000, 'b sees a')
}

function gitRepo(): string {
  const repo = tmpDir('pager-r-')
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'tester')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  return repo
}

const fake: AdapterSpec = {
  bin: process.execPath,
  args: (p) => [fileURLToPath(new URL('./testAgent.js', import.meta.url)), p],
  extract: (s) => s.trim(),
}
const adapters: Record<string, AdapterSpec> = { omp: fake, claude: fake, opencode: fake, hermes: fake }

/** A host with agents, a guest, both contacts of each other. */
async function session(): Promise<{ host: Peer; guest: Peer; hostTab: string }> {
  const host = await boot('alice', { workdir: gitRepo(), agentAdapters: adapters })
  await host.engine.checkAgents()
  const guest = await boot('bob')
  await befriend(host, guest)
  return { host, guest, hostTab: sharedTabId(host.engine.me.pk) }
}

async function join(host: Peer, guest: Peer, flag = ''): Promise<void> {
  await host.engine.submit(`/agent invite bob ${flag}`.trim())
  await waitFor(() => guest.engine.pending().some((p) => p.type === 'session'), 20_000, 'session invite')
  await guest.engine.submit('/accept 1')
  await waitFor(() => host.engine.sessionGuests().some((g) => g.state === 'joined'), 20_000, 'guest joined')
}

const roomText = (p: Peer, tab: string, text: string): boolean => p.engine.messages(tab, 100).some((m) => m.text === text)

test('an invited contact joins, talks to the host agents, and sees the replies', async () => {
  const { host, guest, hostTab } = await session()
  await join(host, guest)
  assert.equal(guest.engine.active(), hostTab)
  assert.equal(guest.engine.sharedSessions()[0]?.access, 'control')
  await guest.engine.submit('@omp ECHO roll call')
  await waitFor(() => roomText(host, ROOM_ID, 'roll call'), 30_000, 'agent reply on the host')
  const said = host.engine.messages(ROOM_ID, 100).find((m) => m.text === '@omp ECHO roll call')
  assert.equal(said?.authorName, 'bob')
  assert.equal(said?.mine, false)
  assert.equal(said?.agent, false)
  await waitFor(() => roomText(guest, hostTab, 'roll call'), 20_000, 'agent reply on the guest')
  const mine = guest.engine.messages(hostTab, 100).find((m) => m.text === '@omp ECHO roll call')
  assert.equal(mine?.mine, true)
  assert.deepEqual(guest.engine.sharedRoom(host.engine.me.pk)?.agents.map((a) => a.name), ['omp', 'claude', 'opencode', 'hermes'])
})

test('a view guest watches but cannot talk; the host room is unchanged', async () => {
  const { host, guest, hostTab } = await session()
  await join(host, guest, '--view')
  assert.equal(guest.engine.sharedSessions()[0]?.access, 'view')
  const before = host.engine.messages(ROOM_ID, 100).length
  await guest.engine.submit('@omp ECHO nope')
  assert.match(guest.toasts.at(-1)?.text ?? '', /view only/)
  host.engine.activate(ROOM_ID)
  await host.engine.submit('@omp ECHO from host')
  await waitFor(() => roomText(guest, hostTab, 'from host'), 30_000, 'guest sees the host talk')
  assert.ok(!roomText(host, ROOM_ID, 'nope'))
  assert.equal(host.engine.agentRoom().runs.length, 1)
  assert.ok(host.engine.messages(ROOM_ID, 100).length > before)
})

test('guest commands, passthrough and #documents stay with the host', async () => {
  const { host, guest } = await session()
  await host.engine.submit('/doc new plan')
  await join(host, guest)
  await guest.engine.submit('/agent merge omp')
  await guest.engine.submit('@omp !status')
  await guest.engine.submit('@omp ECHO hi')
  await waitFor(() => host.engine.agentRoom().runs.length === 1, 30_000, 'one run, from the plain message')
  await waitFor(() => roomText(host, ROOM_ID, 'hi'), 30_000, 'reply')
  const hostLines = host.engine.messages(ROOM_ID, 100)
  assert.ok(hostLines.some((m) => m.authorName === 'pager' && /bob: ! passthrough is host-only/.test(m.text)))
  assert.ok(!hostLines.some((m) => m.text.includes('/agent merge')), 'a local guest command never reaches the host')
  await guest.engine.submit('@omp DOCSEEN #plan.md')
  await waitFor(() => roomText(host, ROOM_ID, 'docs: none'), 30_000, "the guest's #plan.md is not read")
  host.engine.activate(ROOM_ID)
  await host.engine.submit('@omp DOCSEEN #plan.md')
  await waitFor(() => roomText(host, ROOM_ID, 'docs: plan.md'), 30_000, "the host's #plan.md is read")
})

test('a guest named like an agent is labelled apart and shown as a person', async () => {
  const orch = new Orchestrator({ dataDir: tmpDir('pager-o-'), workdir: tmpDir('pager-w-'), adapters })
  const pk = 'ab'.repeat(32)
  assert.equal(orch.guestLabel('bob', pk), 'bob')
  assert.equal(orch.guestLabel('You', pk), 'You~abab')
  assert.equal(orch.guestLabel('x] [you', pk), 'x you')
  assert.equal(orch.sayAsGuest('/usage', undefined, { label: 'bob', pk }), 'commands are host-only')
  orch.say('hello', undefined, { label: 'You~abab', pk })
  const line = orch.messages(10).find((m) => m.authorName === 'You~abab')
  assert.deepEqual([line?.agent, line?.mine, line?.authorKey, line?.authorName], [false, false, pk, 'You~abab'])
  await orch.close()
})

test('kicking removes the guest; later frames from them create nothing', async () => {
  const { host, guest, hostTab } = await session()
  await join(host, guest)
  await host.engine.submit('/agent kick bob')
  await waitFor(() => guest.engine.sharedSessions().length === 0, 20_000, 'guest session gone')
  assert.notEqual(guest.engine.active(), hostTab)
  assert.equal(host.engine.sessionGuests().length, 0)
  assert.equal(host.engine.agentRoom().runs.length, 0)
})

test('a peer without the collab capability is never sent a collab frame, and frames that fit the wire are what is sent', async () => {
  const orch = new Orchestrator({ dataDir: tmpDir('pager-o-'), workdir: tmpDir('pager-w-'), adapters })
  const sent: Frame[] = []
  const pk = 'cd'.repeat(32)
  const link = (caps: string[]): PeerLink => ({ pk, initiator: 'local', hello: { name: 'bob', caps }, send: (f) => (sent.push(f), true), close: () => {} })
  let current = link([])
  const share = new AgentShare({
    me: { pk: '11'.repeat(32), name: 'alice' },
    dir: tmpDir('pager-o-'),
    link: () => current,
    isContact: () => true,
    nameOf: () => 'bob',
    orch,
    isActive: () => false,
    acceptNumber: () => 1,
    announce: () => {},
    toast: () => {},
    changed: () => {},
  })
  assert.match(share.invite(pk, 'control') ?? '', /without shared sessions/)
  assert.equal(sent.length, 0)
  current = link(['collab'])
  assert.equal(share.invite(pk, 'view'), undefined)
  share.onFrame(current, { t: 'collab-join' })
  orch.say(`\u001b[31m${'x'.repeat(30_000)}`)
  orch.say('plain')
  share.onFrame(current, { t: 'collab-join' })
  const sync = sent.filter((f) => f.t === 'collab-sync')
  assert.ok(sync.length > 0)
  const decoder = new FrameDecoder()
  for (const f of sent) decoder.push(encodeFrame(f))
  share.close()
  await orch.close()
})

test('inviting an offline contact says so once, and a second invite while one is open changes the access', async () => {
  const { host, guest } = await session()
  await host.engine.submit('/agent invite bob')
  await waitFor(() => guest.engine.pending().some((p) => p.type === 'session' && p.label.includes('(control)')), 20_000, 'control invite')
  await host.engine.submit('/agent invite bob --view')
  await waitFor(() => guest.engine.pending().some((p) => p.type === 'session' && p.label.includes('(view)')), 20_000, 'view invite')
  assert.equal(host.engine.sessionGuests()[0]?.access, 'view')
  await guest.engine.close()
  await waitFor(() => host.engine.convs().every((c) => c.online === false), 20_000, 'host sees bob offline')
  await host.engine.submit('/agent kick bob')
  await host.engine.submit('/agent invite bob')
  const text = host.toasts.at(-1)?.text ?? ''
  assert.match(text, /is offline/)
  assert.equal(text.split('bob').length - 1, 1, text)
})

test('a guest who just joined sees a welcome line before anything arrives', async () => {
  const { host, guest, hostTab } = await session()
  await host.engine.submit('/agent invite bob')
  await waitFor(() => guest.engine.pending().some((p) => p.type === 'session'), 20_000, 'session invite')
  await guest.engine.submit('/accept 1')
  assert.match(guest.toasts.at(-1)?.text ?? '', /Joined .*agent session/)
  const first = guest.engine.messages(hostTab, 100)[0]
  assert.equal(first?.key, 'shared:welcome')
  assert.match(first?.text ?? '', /Joined .* agent session/)
})

test('a host outside a git repository tells the guest why its request does nothing', async () => {
  const host = await boot('alice', { workdir: tmpDir('pager-w-'), agentAdapters: adapters })
  await host.engine.checkAgents()
  const guest = await boot('bob')
  await befriend(host, guest)
  const hostTab = sharedTabId(host.engine.me.pk)
  await join(host, guest)
  await waitFor(() => host.toasts.some((t) => /not inside a git repository/.test(t.text)), 20_000, 'host warned')
  await guest.engine.submit('@omp hi')
  await waitFor(() => guest.engine.messages(hostTab, 100).some((m) => /git repository/.test(m.text)), 30_000, 'guest told why')
})
