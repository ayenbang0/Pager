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
import type { AdapterSpec } from '../agents/run/adapters.js'
import { agentTabId } from '../agents/ids.js'
import { ROOM_ID } from '../agents/orchestrator.js'
import { Engine, type EngineOptions, type Toast } from './engine.js'
import { dmConvId } from '../chat/events.js'
import { resetDesktopState } from '../platform/desktop.js'
import { DEFAULT_SETTINGS } from './settings.js'
import { VERSION } from './version.js'
import { SETTINGS_ID } from './settingsView.js'
import { AI_ID } from '../ai/chat.js'
import { sharedTabId } from '../agents/ids.js'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../chat/db.js'
import { deriveSecrets } from '../chat/secrets.js'
import { Net, type PeerLink } from '../net/net.js'
import { removeTmpDirs, tmpDir, waitFor } from '../testing/testutil.js'

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
  dir = tmpDir('pager-e-'),
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
  engine.setName(name)
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

test('contactNames lists accepted contacts only', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await a.engine.submit(`/add ${b.engine.me.code}`)
  await waitFor(() => b.engine.pending().length > 0, 20_000, 'bob pending')
  assert.deepEqual(a.engine.contactNames(), [])
  await b.engine.submit('/accept 1')
  await waitFor(() => a.engine.contactNames().includes('bob'), 20_000, 'alice lists bob')
})

test('desktop alerts fire for an accepted request and a message; a read receipt is a tick, not an alert', async () => {
  const file = path.join(tmpDir('pager-n-'), 'alerts.jsonl')
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
    await waitFor(() => a.engine.messages(conv, 10).at(-1)?.status === 'read', 15_000, 'read tick on alice')
    const all = alerts()
    assert.ok(all.some((l) => l.startsWith('alice: alice wants to connect')), 'request alert')
    assert.ok(all.includes('bob: bob accepted your contact request'), 'accept alert')
    assert.ok(!all.some((l) => l.includes('read your message')), 'no alert for a read receipt')
    assert.ok(!a.toasts.some((t) => t.text.includes('read your message')), 'no popup for a read receipt')
    assert.equal(a.engine.messages(conv, 10).at(-1)?.status, 'read')
  } finally {
    delete process.env.PAGER_NOTIFY_FILE
  }
})

test('own message ticks only climb: pending while offline, then sent, delivered, read', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  await b.engine.close()
  await waitFor(() => a.engine.convs().every((c) => c.online === false), 15_000, 'a sees b offline')
  a.engine.activate(conv)
  await a.engine.submit('later')
  assert.equal(a.engine.messages(conv, 10).at(-1)?.status, 'pending')
  const b2 = await boot('bob', b.dir)
  b2.engine.activate(conv)
  const seen: string[] = []
  await waitFor(
    () => {
      const status = a.engine.messages(conv, 10).at(-1)?.status ?? ''
      if (seen.at(-1) !== status) seen.push(status)
      return status === 'read'
    },
    20_000,
    'read tick',
  )
  const order = ['pending', 'sent', 'delivered', 'read']
  assert.deepEqual(seen, order.filter((s) => seen.includes(s)), `statuses ${seen.join(',')}`)
})

test('desktop alerts are skipped only while pager has trusted focus', async () => {
  const file = path.join(tmpDir('pager-n-'), 'alerts.jsonl')
  process.env.PAGER_NOTIFY_FILE = file
  resetDesktopState()
  try {
    const a = await boot('alice')
    const b = await boot('bob')
    await befriend(a, b)
    const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
    a.engine.activate(conv)
    const bodies = (): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const x = JSON.parse(l) as { body: string }; return x.body }) : [])
    b.engine.setFocused(true, true)
    await a.engine.submit('quiet')
    await waitFor(() => texts(b, conv).includes('quiet'), 15_000, 'b gets quiet')
    assert.ok(!bodies().includes('quiet'), 'no alert while focused')
    b.engine.setFocused(false, true)
    await a.engine.submit('loud')
    await waitFor(() => bodies().includes('loud'), 15_000, 'alert while away')
    b.engine.setFocused(true, false)
    await a.engine.submit('again')
    await waitFor(() => bodies().includes('again'), 15_000, 'alert when focus is not trustworthy')
  } finally {
    delete process.env.PAGER_NOTIFY_FILE
  }
})

test('a contact who comes back online raises a desktop alert and a popup, once', async () => {
  const file = path.join(tmpDir('pager-n-'), 'alerts.jsonl')
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

  // The group screen's data; `(you)` marks the reader.
  const members = (p: Peer): string => (p.engine.groupView(group)?.people ?? []).map((m) => `${m.name}${m.me ? ' (you)' : ''}`).join('\n')
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

test('group rename: the creator renames, members follow, others are refused, and it never counts as unread', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  await a.engine.submit('/group new team')
  const group = a.engine.active()
  assert.ok(group)
  await a.engine.submit('/group invite bob')
  await waitFor(() => b.engine.pending().some((p) => p.type === 'group'), 20_000, 'invite')
  await b.engine.submit('/accept 1')
  b.engine.activate(group)
  const title = (p: Peer): string | undefined => p.engine.convs().find((c) => c.id === group)?.title
  await a.engine.submit('/group rename crew')
  assert.equal(a.toasts.at(-1)?.text, 'Group renamed to "crew"')
  assert.equal(title(a), 'crew')
  await waitFor(() => title(b) === 'crew', 20_000, 'bob sees the new name')
  assert.ok(b.engine.messages(group, 50).some((m) => m.kind === 'system' && m.text === 'alice renamed the group to "crew"'))
  assert.equal(b.engine.convs().find((c) => c.id === group)?.unread, 0)
  // a member cannot rename
  await b.engine.submit('/group rename hax')
  assert.equal(b.toasts.at(-1)?.text, 'Only the group creator can rename it')
  assert.equal(title(b), 'crew')
  await a.engine.submit('/group rename crew')
  assert.equal(a.toasts.at(-1)?.text, 'Already named that')
  await a.engine.submit('/group rename ')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  // an offline member catches up on reconnect
  await b.engine.close()
  await a.engine.submit('/group rename crew2')
  const again = await boot('bob', b.dir)
  await waitFor(() => title(again) === 'crew2', 25_000, 'bob catches up')
})

test('reactions: add, repeat removes, relay to a third member, never unread, never a line', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  const c = await boot('carol')
  await befriend(a, b)
  await befriend(a, c)
  const dm = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(dm)
  b.engine.activate(dm)
  await a.engine.submit('react to me')
  await waitFor(() => texts(b, dm).includes('react to me'), 20_000, 'b gets it')
  const target = a.engine.messages(dm, 10).find((m) => m.text === 'react to me')
  assert.ok(target?.reactable)
  const unreadBefore = a.engine.convs().find((v) => v.id === dm)?.unread ?? 0
  b.engine.react(target.key, '🔥')
  await waitFor(() => (a.engine.messages(dm, 10).find((m) => m.key === target.key)?.reactions ?? []).length === 1, 20_000, 'a sees the reaction')
  assert.deepEqual(a.engine.messages(dm, 10).find((m) => m.key === target.key)?.reactions, [{ emoji: '🔥', count: 1, mine: false }])
  assert.deepEqual(b.engine.messages(dm, 10).find((m) => m.key === target.key)?.reactions, [{ emoji: '🔥', count: 1, mine: true }])
  assert.equal(a.engine.convs().find((v) => v.id === dm)?.unread ?? 0, unreadBefore)
  assert.ok(a.engine.messages(dm, 50).every((m) => !m.text.includes('rx:') && !m.text.startsWith('\u2063')), 'reaction events are not lines')
  assert.equal(a.engine.messages(dm, 50).length, 1)
  b.engine.react(target.key, '🔥')
  await waitFor(() => a.engine.messages(dm, 10).find((m) => m.key === target.key)?.reactions === undefined, 20_000, 'repeat removes it')
  b.engine.react('0'.repeat(64) + ':99', '🔥')
  assert.equal(b.toasts.at(-1)?.text, 'That message is gone')
  b.engine.react(target.key, 'nope')
  assert.equal(b.toasts.at(-1)?.text, 'Not an emoji: nope')
  // a group: bob reacts, carol (a third member) sees it after the relay
  await a.engine.submit('/group new crew')
  const group = a.engine.active()!
  await a.engine.submit('/group invite bob')
  await a.engine.submit('/group invite carol')
  await waitFor(() => b.engine.pending().some((p) => p.type === 'group') && c.engine.pending().some((p) => p.type === 'group'), 20_000, 'invites')
  await b.engine.submit('/accept 1')
  await c.engine.submit('/accept 1')
  a.engine.activate(group)
  b.engine.activate(group)
  c.engine.activate(group)
  await a.engine.submit('hello crew')
  await waitFor(() => texts(b, group).includes('hello crew') && texts(c, group).includes('hello crew'), 25_000, 'fan-out')
  const gt = a.engine.messages(group, 10).find((m) => m.text === 'hello crew')!
  b.engine.react(gt.key, '🎉')
  await waitFor(() => (c.engine.messages(group, 10).find((m) => m.key === gt.key)?.reactions ?? []).length === 1, 25_000, 'carol sees it')
  assert.deepEqual(c.engine.messages(group, 10).find((m) => m.key === gt.key)?.reactions, [{ emoji: '🎉', count: 1, mine: false }])
})

test('the AI tab: /open ai, text reaches a ready agent headless, settings round-trip, and clearing empties it', async () => {
  const fake: AdapterSpec = {
    bin: process.execPath,
    args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
    extract: (s) => s.trim(),
  }
  const repo = tmpDir('pager-ai-repo-')
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: { omp: fake } })
  await a.engine.checkAgents()
  await a.engine.submit('/open ai')
  assert.equal(a.engine.active(), AI_ID)
  await a.engine.submit('ECHO from the ai tab')
  await waitFor(() => a.engine.messages(AI_ID, 20).some((m) => m.text === 'from the ai tab' && m.agent === true), 20_000, 'ai reply')
  assert.deepEqual(a.engine.messages(AI_ID, 20).map((m) => m.authorName), ['you', 'omp'])
  assert.equal(a.engine.aiBusy(), false)
  assert.equal(a.engine.convs().some((c) => c.id === AI_ID), false)
  // the scratch folder is not a git repository and not the work dir
  assert.ok(!fs.existsSync(path.join(a.dir, 'ai', 'work', '.git')))
  await a.engine.submit('WRITE note.txt=hi')
  await waitFor(() => fs.existsSync(path.join(a.dir, 'ai', 'work', 'note.txt')), 20_000, 'file in the scratch folder')
  // settings
  a.engine.setAi('ollama.model', 'llama3')
  a.engine.setAi('openai.key', 'sk-abcdef1234')
  a.engine.setAi('ollama.url', 'not a url')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  const view = a.engine.settingsView().ai
  assert.equal(view?.ollama.model, 'llama3')
  assert.equal(view?.openai.keyHint, '••••1234')
  assert.deepEqual(view?.backends.slice(-2), ['ollama', 'openai'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a.dir, 'ai.json')).mode & 0o777, 0o600)
  a.engine.clearAi()
  assert.deepEqual(a.engine.messages(AI_ID, 20), [])
  assert.deepEqual(fs.readdirSync(path.join(a.dir, 'ai', 'work')), [])
  await a.engine.close()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('group bots: added with /bot, pass when their job does not call for it, answer @name, and every member sees them under their own name', async () => {
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content: string }[] }
    const news = body.messages?.at(-1)?.content.split('--- NEW MESSAGES ---\n')[1] ?? ''
    const reply = news.includes('write notes') ? 'Done.\n@@doc notes\n# Notes\nhi\n@@end' : news.includes('@grumpy') ? 'you are **wrong**\nentirely' : 'NO_REPLY'
    return new Response(`${JSON.stringify({ message: { content: reply } })}\n`)
  }
  const a = await boot('alice', undefined, { fetch })
  const b = await boot('bob')
  await befriend(a, b)
  await a.engine.submit('/group new crew')
  const group = a.engine.active()
  assert.ok(group)
  await a.engine.submit('/group invite bob')
  await waitFor(() => b.engine.pending().length > 0, 20_000, 'bob invited')
  await b.engine.submit('/accept 1')
  a.engine.setAi('ollama.model', 'm')
  await a.engine.submit('/bot add grumpy @ollama argue with everything')
  assert.deepEqual(a.engine.groupBots(group).map((bot) => [bot.name, bot.backend]), [['grumpy', 'ollama']])
  await waitFor(() => b.engine.messages(group, 50).some((m) => m.authorName === 'grumpy (alice)' && m.text.startsWith('👋')), 20_000, 'intro reaches bob')
  b.engine.activate(group)
  await b.engine.submit('nice weather')
  await b.engine.submit('right @grumpy?')
  const wrong = 'you are **wrong**\nentirely'
  await waitFor(() => b.engine.messages(group, 50).some((m) => m.text === wrong), 20_000, 'the reply reaches bob')
  const seen = b.engine.messages(group, 50).find((m) => m.text === wrong)
  assert.deepEqual([seen?.authorName, seen?.agent, seen?.markdown, seen?.mine, seen?.reactable], ['grumpy (alice)', true, true, false, true])
  assert.equal(a.engine.messages(group, 50).find((m) => m.text === wrong)?.authorName, 'grumpy')
  assert.equal(a.engine.messages(group, 50).filter((m) => m.agent === true).length, 2, 'the intro and one reply: it passed on the weather')
  await b.engine.submit('@grumpy write notes')
  await waitFor(() => b.engine.docList().some((d) => d.name === 'notes.md' && b.engine.docs.text(d.id) === '# Notes\nhi'), 20_000, 'the bot document reaches bob')
  assert.ok(b.engine.messages(group, 50).some((m) => m.text === 'Done.\n\n_✎ created notes.md_'))
  await a.engine.submit('/bot remove grumpy')
  assert.deepEqual(a.engine.groupBots(group), [])
  await b.engine.submit('/bot add mine @nope x')
  assert.match(b.toasts.at(-1)?.text ?? '', /No AI backend named "nope"/)
})

test('calls, pings and the panels: a DM call rings and carries sound both ways, /ping plays a sound in pings-only mode, /requests and /group members open screens, bots take a model', async () => {
  const file = path.join(tmpDir('pager-n-'), 'alerts.jsonl')
  process.env.PAGER_NOTIFY_FILE = file
  const fakeAudio = (heard: Buffer[]) => {
    const mics: ((pcm: Buffer) => void)[] = []
    const audio = async () => ({ mic: (onChunk: (pcm: Buffer) => void) => (mics.push(onChunk), { stop: () => undefined }), speaker: () => ({ write: (pcm: Buffer) => void heard.push(pcm), stop: () => undefined }) })
    return { audio, talk: (pcm: Buffer) => mics.at(-1)?.(pcm) }
  }
  const tone = Buffer.alloc(2048)
  for (let i = 0; i < tone.length; i += 2) tone.writeInt16LE(i % 4 === 0 ? 9000 : -9000, i)
  const aHeard: Buffer[] = []
  const bHeard: Buffer[] = []
  const aIo = fakeAudio(aHeard)
  const bIo = fakeAudio(bHeard)
  const a = await boot('alice', undefined, { audio: aIo.audio })
  const b = await boot('bob', undefined, { audio: bIo.audio })
  const overlays: string[] = []
  b.engine.on('overlay', (kind: string) => overlays.push(kind))
  await befriend(a, b)
  await b.engine.submit('/requests')
  assert.deepEqual(overlays, ['requests'])
  const dm = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(dm)
  await a.engine.submit('/call')
  await waitFor(() => b.toasts.some((t) => t.text.startsWith('alice is calling')), 20_000, 'bob is rung')
  assert.equal(b.engine.convs().find((v) => v.id === dm)?.call, 1)
  b.engine.activate(dm)
  await b.engine.submit('/call')
  await waitFor(() => a.engine.myCall()?.people.length === 2, 20_000, 'bob is in alice view')
  aIo.talk(tone)
  bIo.talk(tone)
  await waitFor(() => aHeard.length > 0 && bHeard.length > 0, 20_000, 'sound both ways')
  assert.deepEqual(bHeard[0], tone)
  await b.engine.submit('/mute')
  assert.equal(b.engine.myCall()?.muted, true)
  await b.engine.submit('/hangup')
  await waitFor(() => a.engine.myCall()?.people.length === 1, 20_000, 'bob left')
  assert.equal(b.engine.myCall(), undefined)
  // pings: bob only wants sounds from pings; an ordinary message stays silent, a ping plays
  b.engine.setSoundMode('pings')
  b.engine.setFocused(false, true)
  const read = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { play?: string; sound?: boolean; body?: string })
  const before = read().length
  await a.engine.submit('hello bob')
  await waitFor(() => read().slice(before).some((l) => l.body?.includes('hello bob')), 20_000, 'message alert')
  await a.engine.submit('/ping')
  await waitFor(() => b.toasts.some((t) => t.text === '🔔 alice pinged you'), 20_000, 'ping arrives')
  const lines = read().slice(before)
  assert.ok(lines.some((l) => l.play === 'chime'), 'the ping played the message sound')
  assert.ok(lines.filter((l) => l.body?.includes('hello bob')).every((l) => l.sound === false), 'the message alert was silent')
  b.engine.setSoundPreset('notifySound', 'kazoo')
  assert.equal(b.toasts.at(-1)?.kind, 'error')
  // the group screen and a bot's model
  await a.engine.submit('/group new crew')
  a.engine.on('overlay', (kind: string) => overlays.push(`a:${kind}`))
  await a.engine.submit('/group members')
  assert.equal(overlays.at(-1), 'a:group')
  const crew = a.engine.active() ?? ''
  assert.deepEqual(a.engine.groupView(crew)?.people.map((p) => [p.name, p.me, p.creator]), [['alice', true, true]])
  a.engine.setAi('ollama.model', 'm')
  await a.engine.submit('/bot add grumpy @ollama argue')
  await a.engine.submit('/bot model grumpy llama3:8b')
  await a.engine.submit('/bot effort grumpy high')
  assert.match(a.toasts.at(-1)?.text ?? '', /Effort is for agent CLIs/)
  assert.deepEqual(a.engine.groupView(crew)?.bots.map((x) => [x.name, x.model, x.effort]), [['grumpy', 'llama3:8b', 'default']])
  await a.engine.submit('/bot model grumpy default')
  assert.equal(a.engine.groupView(crew)?.bots[0]?.model, 'default')
  delete process.env.PAGER_NOTIFY_FILE
})

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

const fakeAgent: AdapterSpec = {
  bin: process.execPath,
  args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
  extract: (s) => s.trim(),
}

test('no-agents mode: no agent process starts, agent commands and tabs refuse, the AI tab is unavailable, and agent frames are ignored', async () => {
  const repo = gitRepo()
  const marker = path.join(repo, 'ran.txt')
  const spy: AdapterSpec = { ...fakeAgent, args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), `WRITE ${marker}=1\n${p}`] }
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: { claude: spy }, agents: false })
  await a.engine.checkAgents()
  assert.equal(a.engine.agentsEnabled(), false)
  assert.deepEqual(a.engine.agentNames(), [])
  assert.equal(a.engine.ai, undefined)
  await a.engine.submit('/agent claude hi')
  assert.equal(a.toasts.at(-1)?.text, 'Agents are off (Settings > Privacy and Network)')
  await a.engine.submit('/agent')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  for (const tab of [AI_ID, ROOM_ID, agentTabId('claude'), sharedTabId('ab'.repeat(32))]) {
    a.engine.activate(tab)
    assert.equal(a.toasts.at(-1)?.text, 'Agents are off (Settings > Privacy and Network)', tab)
    assert.notEqual(a.engine.active(), tab)
  }
  assert.equal(a.engine.settingsView().agentsOn, false)
  assert.equal(a.engine.settingsView().ai, undefined)
  await sleep(300)
  assert.equal(fs.existsSync(marker), false, 'no agent ran')
  await a.engine.close()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('secure sessions (encryption or LAN) keep documents out of agent turns; an ordinary session shows them', async () => {
  const salt = Buffer.alloc(16, 8)
  const secrets = deriveSecrets('correct-horse', salt)
  const cases: [string, Partial<EngineOptions>, string][] = [
    ['open', {}, 'docs: plan.md'],
    ['encrypted', { secrets }, 'docs: none'],
    ['lan', { lan: { hosting: true, address: '127.0.0.1' } }, 'docs: none'],
  ]
  for (const [name, extra, expected] of cases) {
    const repo = gitRepo()
    const a = await boot('alice', undefined, { workdir: repo, agentAdapters: { omp: fakeAgent }, ...extra })
    await a.engine.checkAgents()
    const doc = a.engine.newDoc('plan')
    assert.ok('id' in doc, name)
    if ('id' in doc) a.engine.docs.insert(doc.id, 0, 'the plan')
    await a.engine.submit('/agent omp see #plan.md\nDOCSEEN\nTOOL doc_write {"name":"plan.md","text":"hacked"}')
    await waitFor(() => a.engine.messages(agentTabId('omp'), 50).some((m) => m.text.startsWith('docs:')), 20_000, `${name} turn`)
    const said = a.engine.messages(agentTabId('omp'), 50).map((m) => m.text)
    assert.ok(said.some((t) => t.includes(expected)), `${name}: ${said.join(' | ')}`)
    if (expected === 'docs: none') {
      assert.ok(said.some((t) => /not shown to the agent|documents are unavailable/.test(t)), `${name}: the doc tool is refused: ${said.join(" | ")}`)
      assert.equal(a.engine.docs.text(doc.id as string), 'the plan')
      assert.ok(a.engine.messages(ROOM_ID, 50).some((m) => m.text === '#name references are off in a secure session (encryption or LAN mode)'), `${name}: told once`)
      assert.equal(a.engine.secure, true)
    } else assert.equal(a.engine.secure, false)
    await a.engine.close()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('LAN mode shows on Home and in the privacy view', async () => {
  const dir = tmpDir('pager-e-')
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lastSeenVersion: VERSION })) // no "what's new" screen in the way
  const a = await boot('alice', dir, { lan: { hosting: false, address: '192.168.1.9' } })
  assert.ok(a.engine.home().includes('LAN mode: joined 192.168.1.9'))
  assert.deepEqual(a.engine.settingsView().privacy.lan, { hosting: false, address: '192.168.1.9' })
  assert.equal(a.engine.settingsView().privacy.encrypted, false)
  await a.engine.close()
})

test('/changelog shows what is new, one exact version, or explains itself', async () => {
  const a = await boot('alice')
  await a.engine.submit('/changelog 1.5.1')
  const lines = a.engine.home()
  assert.ok(lines[0]?.startsWith('1.5.1'), lines[0])
  assert.ok(lines.includes('Added:') && lines.includes('Fixed:'))
  assert.ok(!lines.some((l) => l.startsWith('1.2.1')), 'only that version')
  await a.engine.submit('/changelog v1.2.1')
  assert.ok(a.engine.home()[0]?.startsWith('1.2.1'))
  await a.engine.submit('/changelog 9.9.9')
  assert.equal(a.toasts.at(-1)?.text, 'No changelog entry for 9.9.9')
  await a.engine.submit('/changelog banana')
  assert.equal(a.toasts.at(-1)?.text, 'Usage: /changelog [version]')
  await a.engine.submit('/changelog')
  assert.ok(a.engine.home().length > 0)
})

test('a user upgrading from 1.4.1 sees "What\'s new" for this version on the first start only', async () => {
  const dir = tmpDir('pager-e-')
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lastSeenVersion: '1.4.1' }))
  const first = await boot('alice', dir)
  assert.equal(first.engine.home()[0], `What's new in pager ${VERSION}`)
  assert.equal(first.engine.settings().lastSeenVersion, VERSION)
  await first.engine.close()
  const second = await boot('alice', dir)
  assert.notEqual(second.engine.home()[0], `What's new in pager ${VERSION}`)
})

test('name change propagates to contacts', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  a.engine.setName('alicia')
  await waitFor(() => b.engine.convs().some((v) => v.title === 'alicia'), 15_000, 'new name')
  // The re-sent hello must keep advertising capabilities, or read receipts silently stop until reconnect.
  const info = b.engine.netInfo()
  const contact = info.contacts.find((c) => c.name === 'alicia')
  assert.equal(contact?.online, true)
  assert.ok(contact?.caps.includes('read'))
  assert.match(info.stats, /^nodes=\d+ online=true/)
})

test('setTheme switches, persists across restarts, and rejects unknown names', async () => {
  const a = await boot('alice')
  a.engine.setTheme('MONO')
  assert.equal(a.engine.settings().theme, 'mono')
  assert.equal(a.toasts.at(-1)?.kind, 'success')
  a.engine.setTheme('nope')
  assert.equal(a.engine.settings().theme, 'mono')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  a.engine.toggleSidebar()
  await a.engine.close()
  const again = await boot('alice', a.dir)
  assert.deepEqual(again.engine.settings(), { ...DEFAULT_SETTINGS, lastSeenVersion: VERSION, theme: 'mono', sidebar: false })
})

test('/search needs text; a restart recaps what the agents did while closed and /search finds agent room text', async () => {
  const a = await boot('alice')
  await a.engine.submit('/search')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  await a.engine.submit('/search anything')
  assert.deepEqual(a.engine.home(), ['No matches for "anything"'])
  assert.equal(fs.existsSync(path.join(a.dir, 'last-seen.json')), true)
  await a.engine.close()
  const quiet = await boot('alice', a.dir)
  assert.ok(!quiet.engine.home().some((l) => l.startsWith('Since you left')), 'nothing happened, nothing shown')
  await quiet.engine.close()
  fs.writeFileSync(path.join(a.dir, 'last-seen.json'), JSON.stringify({ at: Date.now() - 3 * 3_600_000 }))
  const entry = { n: 1, ts: Date.now() - 1000, author: 'omp', authorKey: '0'.repeat(64), kind: 'text', text: 'Found the Needle in src/a.ts' }
  fs.appendFileSync(path.join(a.dir, 'agents-room.jsonl'), `${JSON.stringify(entry)}\n`)
  const b = await boot('alice', a.dir)
  assert.ok(b.engine.home().includes('Since you left (3h ago): agents: 1 turn'))
  await b.engine.submit('/search needle')
  assert.match(b.engine.home().at(-1) ?? '', /^\[agents\] omp, \d\d:\d\d: Found the Needle in src\/a\.ts$/)
  await b.engine.close()
})

test('openThemePicker asks the app for the picker overlay', async () => {
  const a = await boot('alice')
  const opened: unknown[][] = []
  a.engine.on('overlay', (...args: unknown[]) => opened.push(args))
  a.engine.openThemePicker()
  assert.deepEqual(opened, [['theme']])
  await a.engine.close()
})

test('setAccent, setBadge and setDensity persist, validate and reset', async () => {
  const a = await boot('alice')
  a.engine.setAccent('#F0A')
  assert.equal(a.engine.settings().accent, '#ff00aa')
  a.engine.setAccent('not-a-color')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().accent, '#ff00aa')
  a.engine.setBadge(':rocket:')
  assert.equal(a.engine.settings().badge, '🚀')
  a.engine.setBadge(':nosuchcode:')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  a.engine.setBadge('ab')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().badge, '🚀')
  a.engine.setDensity('roomy')
  assert.equal(a.engine.settings().density, 'roomy')
  a.engine.setDensity('huge')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.settings().density, 'roomy')
  await a.engine.close()
  const again = await boot('alice', a.dir)
  assert.deepEqual(again.engine.settings(), { ...DEFAULT_SETTINGS, lastSeenVersion: VERSION, accent: '#ff00aa', badge: '🚀', density: 'roomy' })
  again.engine.setAccent('auto')
  again.engine.setBadge('none')
  assert.equal(again.engine.settings().accent, '')
  assert.equal(again.engine.settings().badge, 'none')
  await again.engine.close()
})

test('removed commands point at Settings; /settings opens the tab and validates its section', async () => {
  const a = await boot('alice')
  for (const [cmd, section] of [['/theme', 'Appearance'], ['/accent red', 'Appearance'], ['/name x', 'Profile'], ['/net', 'Privacy and Network'], ['/notify on', 'Notifications']] as const) {
    await a.engine.submit(cmd)
    assert.equal(a.toasts.at(-1)?.text, `Moved to Settings > ${section} (Alt+S, or Ctrl+P → Settings)`, cmd)
  }
  await a.engine.submit('/settings foo')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.match(a.toasts.at(-1)?.text ?? '', /^Unknown section\. Try: profile, appearance/)
  assert.notEqual(a.engine.active(), SETTINGS_ID)
  await a.engine.submit('/settings appearance')
  assert.equal(a.engine.active(), SETTINGS_ID)
  assert.equal(a.engine.takeSettingsFocus(), 'appearance')
  assert.equal(a.engine.takeSettingsFocus(), undefined)
  await a.engine.close()
})

test('setSetting persists a switch, and a locked one refuses with the source', async () => {
  const a = await boot('alice')
  a.engine.setSetting('mouse', false)
  assert.equal(a.engine.settings().mouse, false)
  await a.engine.close()
  const locked = await boot('alice', a.dir, { envLocks: [{ key: 'mouse', source: 'PAGER_NO_MOUSE' }] })
  locked.engine.setSetting('mouse', true)
  assert.equal(locked.toasts.at(-1)?.text, 'Locked by PAGER_NO_MOUSE')
  assert.equal(locked.engine.settings().mouse, false)
  assert.deepEqual(locked.engine.settingsView().locks, { mouse: 'PAGER_NO_MOUSE' })
  await locked.engine.close()
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
  const repo = tmpDir('pager-r-')
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
    args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
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
  a.engine.setAgentColor('omp', '#ff8800')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#ff8800')
  a.engine.setAgentColor('omp', 'teal')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#14d8c4')
  a.engine.setAgentColor('omp', 'blorple')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, '#14d8c4')
  a.engine.setAgentColor('omp', 'auto')
  assert.equal(a.engine.agentRoom().agents.find((v) => v.name === 'omp')?.color, undefined)
  await a.engine.close()
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('removeAgent deletes a teammate, and names the choices when the name is wrong', async () => {
  const repo = tmpDir('pager-r-')
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
    args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
    extract: (s) => s.trim(),
  }
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: { omp: fake, claude: fake, opencode: fake, hermes: fake } })
  await a.engine.checkAgents()
  await a.engine.removeAgent('nobody')
  assert.match(a.toasts.at(-1)?.text ?? '', /^No teammate named nobody\. Teammates: /)
  assert.equal(await a.engine.addAgent('omp', 'ui'), undefined)
  assert.ok(a.engine.agentTeam().includes('ui'))
  await a.engine.removeAgent('ui')
  assert.equal(a.toasts.at(-1)?.text, 'ui was deleted')
  assert.ok(!a.engine.agentTeam().includes('ui'))
})

test('folders: create, file, rename, move and remove round-trip through settings and survive a restart', async () => {
  const a = await boot('alice')
  const b = await boot('bob')
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.folderNew('work')
  assert.equal(a.toasts.at(-1)?.text, 'Folder "work" created')
  a.engine.folderNew('WORK')
  assert.equal(a.toasts.at(-1)?.text, 'Folder "WORK" already exists')
  a.engine.folderNew('  ')
  assert.equal(a.toasts.at(-1)?.text, 'A folder needs a name (1-24 characters)')
  a.engine.folderNew('home')
  a.engine.folderFile(conv, 'work')
  assert.deepEqual(a.engine.settings().folders, [{ name: 'work', ids: [conv] }, { name: 'home', ids: [] }])
  a.engine.folderFile(conv, 'home')
  assert.deepEqual(a.engine.settings().folders, [{ name: 'work', ids: [] }, { name: 'home', ids: [conv] }])
  a.engine.folderFile('terminal', 'home')
  assert.equal(a.toasts.at(-1)?.text, 'Only chats, docs, the AI tab and the agents room can be filed')
  a.engine.folderFile(conv, 'nope')
  assert.equal(a.toasts.at(-1)?.text, 'No folder named "nope"')
  a.engine.toggleSection('folder:home')
  a.engine.folderRename('home', 'house')
  assert.deepEqual(a.engine.settings().collapsed, ['folder:house'])
  a.engine.folderMove('house', -1)
  assert.deepEqual(a.engine.settings().folders.map((f) => f.name), ['house', 'work'])
  a.engine.folderMove('house', -1)
  assert.deepEqual(a.engine.settings().folders.map((f) => f.name), ['house', 'work'])
  assert.deepEqual(a.engine.settingsView().folders, [{ name: 'house', count: 1 }, { name: 'work', count: 0 }])
  await a.engine.close()
  const again = await boot('alice', a.dir)
  assert.deepEqual(again.engine.settings().folders, [{ name: 'house', ids: [conv] }, { name: 'work', ids: [] }])
  again.engine.folderFile(conv, null)
  assert.deepEqual(again.engine.settings().folders[0], { name: 'house', ids: [] })
  again.engine.folderRemove('house')
  assert.deepEqual(again.engine.settings().folders.map((f) => f.name), ['work'])
  assert.deepEqual(again.engine.settings().collapsed, [])
  again.engine.folderRemove('house')
  assert.equal(again.toasts.at(-1)?.kind, 'error')
})

test('removed /agent subcommands point at Settings or the palette; /agent <name> <task> still runs', async () => {
  const repo = tmpDir('pager-r-')
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
    args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
    extract: (s) => s.trim(),
  }
  const a = await boot('alice', undefined, { workdir: repo, agentAdapters: { omp: fake, claude: fake, opencode: fake, hermes: fake } })
  await a.engine.checkAgents()
  await a.engine.submit('/agent model omp')
  assert.equal(a.toasts.at(-1)?.text, 'Moved to Settings > Agents (Alt+S, or Ctrl+P → Settings)')
  await a.engine.submit('/agent compact omp')
  assert.match(a.toasts.at(-1)?.text ?? '', /^Moved to the palette \(Ctrl\+P → "Agent <name>: compact"\)$/)
  await a.engine.submit('/agent whatever')
  assert.match(a.toasts.at(-1)?.text ?? '', /^Usage: \/agent <name> <task> \| chain a>b <task> \| runs \| stop \| merge \| drop \| undo \| log \| invite$/)
  await a.engine.submit('/agent claude ECHO still works')
  await waitFor(() => a.engine.messages(agentTabId('claude'), 50).some((m) => m.text === 'still works'), 20_000, 'claude reply')
  // agentAction('reset') forgets the saved session and says so.
  a.engine.agentAction('reset', 'claude')
  await waitFor(() => /fresh session/.test(a.toasts.at(-1)?.text ?? ''), 10_000, 'reset toast')
  const view = a.engine.agentSettingsView()
  assert.deepEqual(view.agents.map((t) => t.name), ['omp', 'claude', 'opencode', 'hermes'])
  a.engine.setAgentBudget('claude', 'turns=4')
  assert.deepEqual(a.engine.agentSettingsView().budgets, [{ key: 'claude', text: 'turns=4' }])
  a.engine.setAgentReview(true)
  assert.equal(a.engine.agentSettingsView().review, true)
  await a.engine.close()
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a command an agent advertises runs verbatim in that agent's tab; pager commands win; elsewhere it is unknown", async () => {
  const repo = tmpDir('pager-r-')
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
    args: (p) => [fileURLToPath(new URL('../agents/testing/testAgent.js', import.meta.url)), p],
    extract: (s) => s.trim(),
  }
  const dir = tmpDir('pager-e-')
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
  await a.engine.close()
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
  assert.deepEqual(again.engine.history().slice(-2), ['/theme dracula', '/theme nord'])
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

after(removeTmpDirs)

test('a locked engine keeps history sealed on disk, reads it back with the key, and refuses without it', async () => {
  const salt = Buffer.alloc(16, 2)
  const secrets = deriveSecrets('correct-horse', salt)
  const dir = tmpDir('pager-lk-')
  const a = await boot('alice', dir, { secrets })
  const b = await boot('bob')
  assert.equal(a.engine.locked, true)
  assert.equal(b.engine.locked, false)
  await befriend(a, b)
  const conv = dmConvId(a.engine.me.pk, b.engine.me.pk)
  a.engine.activate(conv)
  await a.engine.submit('sealed hello')
  await waitFor(() => texts(b, conv).includes('sealed hello'), 15_000, 'b gets it')
  await a.engine.close()
  const raw = new DatabaseSync(path.join(dir, 'pager.db'))
  const bodies = raw.prepare("SELECT body FROM events WHERE op IS NULL").all().map((r) => String(r.body))
  raw.close()
  assert.ok(bodies.length > 0 && bodies.every((x) => x.startsWith('pgrenc1:')))
  const plain = new Store(path.join(dir, 'pager.db'))
  try {
    assert.throws(() => plain.listMessages(conv, 5), /passphrase is required/)
  } finally {
    plain.close()
  }
  const again = await boot('alice', dir, { secrets })
  assert.ok(texts(again, conv).includes('sealed hello'))
  await again.engine.close() // an open database keeps its folder locked on Windows
})

test('/run opens and activates a new terminal tab; bad folders and control characters are refused', async () => {
  const a = await boot('runner')
  const dir = tmpDir('pager-run-')
  await a.engine.submit(`/run --cwd "${dir}"`) // no command, so no shell is typed into
  assert.equal(a.engine.active(), 'terminal:2')
  assert.equal(a.engine.terms.info('terminal:2')?.cwd, dir)

  await a.engine.submit('/run --cwd C:\\definitely\\not\\here')
  assert.equal(a.toasts.at(-1)?.kind, 'error')
  assert.match(a.toasts.at(-1)?.text ?? '', /^cwd is not a folder: /)
  assert.equal(a.engine.terms.ids().length, 2, 'a refused request opens nothing')

  assert.deepEqual(a.engine.runInTerminal({ command: 'echo a\nrm b' }), { ok: false, error: 'command has control characters' })
  assert.deepEqual(a.engine.runInTerminal({ cwd: 'relative' }), { ok: false, error: 'cwd is not a folder: relative' })
  assert.equal(a.engine.terms.ids().length, 2)
})

test('goHome returns to the welcome screen after a command replaced it, and bumps the animation epoch', async () => {
  const a = await boot('homer')
  await a.engine.submit('/code')
  assert.equal(a.engine.welcome(), false, 'the command output replaced the banner')
  a.engine.activate('terminal')
  const epoch = a.engine.homeEpoch
  a.engine.goHome()
  assert.equal(a.engine.active(), null)
  assert.equal(a.engine.welcome(), true)
  assert.equal(a.engine.homeEpoch, epoch + 1)
  a.engine.goHome()
  assert.equal(a.engine.homeEpoch, epoch + 2, 'also replays when Home was already showing')
})

test('/docs serves the site and opens its url; the engine stops it on close', async () => {
  const a = await boot('docsy')
  const opened = path.join(tmpDir('pager-open-'), 'opened.txt')
  process.env.PAGER_OPEN_FILE = opened
  try {
    const reply = await a.engine.openDocs()
    assert.equal(reply.ok, true)
    const url = reply.ok ? (reply.url ?? '') : ''
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/)
    assert.equal(fs.readFileSync(opened, 'utf8').trim(), url)
    assert.equal(await a.engine.docsUrl(), url, 'one server per run')
    const stats = (await (await fetch(`${url}api/stats`)).json()) as { version: string }
    assert.ok(stats.version.length > 0)
  } finally {
    delete process.env.PAGER_OPEN_FILE
  }
})
