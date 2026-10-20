import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir, waitFor } from '../testing/testutil.js'
import type { ChatResult } from '../agents/chat.js'
import { GroupBots, MAX_BOT_STREAK, type BotDeps } from './bots.js'
import { botReply, mentions, NO_REPLY, type BotLine } from './prompt.js'

after(removeTmpDirs)

const G = `grp:${'ab'.repeat(16)}`

interface Harness {
  bots: GroupBots
  dir: string
  chat: BotLine[]
  posts: { name: string; text: string }[]
  asks: { backend: string; prompt: string; cwd?: string }[]
  failures: string[]
  say(from: string, text: string): void
}

/** `answer` sees the backend and the whole prompt; by default it replies `ok` unless the prompt carries SILENT. */
function harness(answer: (backend: string, prompt: string) => Promise<string> | string = (_b, p) => (p.includes('SILENT') ? NO_REPLY : 'ok'), dir = tmpDir('pager-bots-')): Harness {
  const chat: BotLine[] = []
  const posts: Harness['posts'] = []
  const docs = new Map<string, string>([['plan.md', 'step 1']])
  const asks: Harness['asks'] = []
  const failures: string[] = []
  let seq = 0
  const deps: BotDeps = {
    dir,
    backends: () => ['claude', 'ollama', 'openai'],
    runCli: async (backend, prompt, cwd): Promise<ChatResult> => {
      asks.push({ backend, prompt, cwd })
      return { ok: true, text: await answer(backend, prompt) }
    },
    complete: async (backend, messages) => {
      const prompt = messages.map((m) => m.content).join('\n')
      asks.push({ backend, prompt })
      return answer(backend, prompt)
    },
    lines: (_conv, limit) => chat.slice(-limit),
    group: () => ({ title: '#team', host: 'alice', people: ['alice', 'bob'] }),
    post: (conv, name, text) => {
      posts.push({ name, text })
      const line: BotLine = { key: `a:${++seq}`, ts: Date.now(), from: 'alice', bot: { name, mine: true }, text }
      chat.push(line)
      bots.hear(conv, line)
    },
    failed: (_conv, name, error) => void failures.push(`${name}: ${error}`),
    docs: () => [...docs].map(([name, text]) => ({ name, text })),
    writeDoc: (_conv, name, text, append) => {
      docs.set(name, append ? `${docs.get(name) ?? ''}${text}` : text)
      return `${append ? 'added to' : 'wrote'} ${name}`
    },
  }
  const bots = new GroupBots(deps)
  const say = (from: string, text: string): void => {
    const line: BotLine = { key: `${from}:${++seq}`, ts: Date.now(), from, text }
    chat.push(line)
    bots.hear(G, line)
  }
  return { bots, dir, chat, posts, asks, failures, say }
}

const idle = (h: Harness): Promise<void> => waitFor(() => !h.bots.busy(G), 5000, 'bots idle')

test('a bot answers when its model has something to say and stays quiet on NO_REPLY', async () => {
  const h = harness()
  assert.equal(h.bots.add(G, 'grumpy', 'ollama', 'argue with every point'), undefined)
  h.say('bob', 'cats are great')
  await idle(h)
  h.say('bob', 'SILENT please')
  await idle(h)
  assert.deepEqual(h.posts, [{ name: 'grumpy', text: 'ok' }])
  assert.match(h.asks[0]?.prompt ?? '', /Your job, in alice's words: argue with every point/)
  assert.match(h.asks[0]?.prompt ?? '', /--- NEW MESSAGES ---\n\[bob\] cats are great$/)
})

test('a person calling @name gets told to reply; a bot never hears itself', async () => {
  const h = harness()
  h.bots.add(G, 'grumpy', 'ollama', 'be grumpy')
  h.say('bob', 'what do you think @Grumpy?')
  await idle(h)
  assert.equal(h.asks.length, 1, 'its own reply woke nobody')
  assert.match(h.asks[0]?.prompt ?? '', /Someone called you with @grumpy/)
  assert.ok(mentions('hey @grumpy.', 'grumpy') && !mentions('@grumpy2', 'grumpy') && !mentions('me@grumpy', 'grumpy'))
})

test('messages heard while a bot thinks are answered together in its next turn', async () => {
  const gate = Promise.withResolvers<string>()
  let calls = 0
  const h = harness(async () => (++calls === 1 ? gate.promise : 'second'))
  h.bots.add(G, 'grumpy', 'ollama', 'reply')
  h.say('bob', 'one')
  await waitFor(() => h.asks.length === 1, 5000, 'first turn')
  h.say('bob', 'two')
  h.say('carol', 'three')
  gate.resolve('first')
  await idle(h)
  assert.equal(h.asks.length, 2)
  assert.match(h.asks[1]?.prompt ?? '', /--- NEW MESSAGES ---\n\[bob\] two\n\[carol\] three$/)
  assert.match(h.asks[1]?.prompt ?? '', /\[grumpy \(you\)\] first/)
})

test('two bots may answer each other, but a long run of bot messages stops them', async () => {
  const h = harness()
  h.bots.add(G, 'ping', 'ollama', 'answer every message')
  h.bots.add(G, 'pong', 'openai', 'answer every message')
  h.say('bob', 'go')
  await waitFor(() => h.posts.length >= MAX_BOT_STREAK, 5000, 'bots talk')
  await idle(h)
  assert.ok(h.posts.length <= MAX_BOT_STREAK + 1, `${h.posts.length}: two turns may start just under the cap, none after it`)
  assert.match(h.asks.at(-1)?.prompt ?? '', /written by bots/)
  assert.match(h.asks.at(-1)?.prompt ?? '', /\[pong, alice's bot\]|\[ping, alice's bot\]/)
})

test('a CLI bot works in its own sandbox under the data dir; removing it deletes the folder', async () => {
  const h = harness()
  h.bots.add(G, 'helper', 'claude', 'help')
  h.say('bob', 'hi')
  await idle(h)
  const cwd = h.asks[0]?.cwd ?? ''
  assert.equal(path.relative(h.dir, cwd), path.join('bots', 'ab'.repeat(8), 'helper'))
  assert.ok(fs.statSync(cwd).isDirectory())
  assert.match(h.asks[0]?.prompt ?? '', /own sandbox folder/)
  assert.equal(h.bots.remove(G, 'helper'), true)
  assert.equal(fs.existsSync(cwd), false)
})

test('validation, persistence across a restart, and one failure notice until the bot recovers', async () => {
  let fail = true
  const h = harness(() => {
    if (fail) throw new Error('down')
    return 'back'
  })
  assert.match(h.bots.add(G, 'all', 'ollama', 'x') ?? '', /reserved/)
  assert.match(h.bots.add(G, 'Bad Name', 'ollama', 'x') ?? '', /not a valid bot name/)
  assert.match(h.bots.add(G, 'grumpy', 'nope', 'x') ?? '', /No AI backend named "nope"/)
  assert.match(h.bots.add(G, 'grumpy', 'ollama', '') ?? '', /Say what the bot does/)
  assert.equal(h.bots.add(G, 'grumpy', 'ollama', 'x'), undefined)
  assert.match(h.bots.add(G, 'grumpy', 'ollama', 'y') ?? '', /already has a bot/)
  h.say('bob', 'a')
  await idle(h)
  h.say('bob', 'b')
  await idle(h)
  assert.deepEqual(h.failures, ['grumpy: down'])
  fail = false
  h.say('bob', 'c')
  await idle(h)
  assert.deepEqual(h.posts.map((p) => p.text), ['back'])
  assert.equal(h.bots.edit(G, 'grumpy', { instructions: 'be nice', backend: 'openai' }), undefined)
  const again = harness(undefined, h.dir)
  assert.deepEqual(again.bots.list(G).map((b) => [b.name, b.backend, b.instructions]), [['grumpy', 'openai', 'be nice']])
})

test('botReply drops NO_REPLY and an echoed speaker tag', () => {
  assert.equal(botReply(`  ${NO_REPLY}  `, 'grumpy'), undefined)
  assert.equal(botReply(`Nothing to add. ${NO_REPLY}`, 'grumpy'), undefined)
  assert.equal(botReply('[grumpy (you)] wrong.', 'grumpy'), 'wrong.')
  assert.equal(botReply('grumpy: wrong.', 'grumpy'), 'wrong.')
  assert.equal(botReply('grumpy thinks so', 'grumpy'), 'grumpy thinks so')
})

test('a bot sees the group documents and writes them with @@doc blocks; the chat gets the rest and a note', async () => {
  const h = harness((_b, prompt) => (prompt.includes('[bob] write it') ? 'Done.\n@@doc plan.md\nstep 1\nstep 2\n@@end\n@@docappend log.md\nentry\n@@end' : NO_REPLY))
  h.bots.add(G, 'scribe', 'ollama', 'keep the plan')
  h.say('bob', 'write it')
  await idle(h)
  assert.match(h.asks[0]?.prompt ?? '', /--- DOCS ---\n## plan\.md\nstep 1\n--- CHAT ---/)
  assert.deepEqual(h.posts, [{ name: 'scribe', text: 'Done.\n\n_✎ wrote plan.md_\n\n_✎ added to log.md_' }])
})