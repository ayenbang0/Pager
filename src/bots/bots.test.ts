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
function harness(answer: (backend: string, prompt: string) => Promise<string> | string = (_b, p) => (p.includes('SILENT') ? NO_REPLY : 'ok'), dir = tmpDir('pager-bots-'), extra: Partial<BotDeps> = {}): Harness {
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
    ...extra,
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
  assert.deepEqual(h.bots.remove(G, 'helper'), { leftover: undefined })
  assert.equal(fs.existsSync(cwd), false)
})

test('removing a bot whose sandbox Windows holds open still removes the bot and reports the leftover folder', () => {
  const seen: string[] = []
  const h = harness(undefined, undefined, {
    rm: (target) => {
      seen.push(target)
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${target}'`), { code: 'EPERM' })
    },
  })
  h.bots.add(G, 'helper', 'claude', 'help')
  const sandbox = h.bots.sandbox(G, 'helper')
  const gone = h.bots.remove(G, 'helper')
  assert.deepEqual(seen, [sandbox])
  assert.match(gone?.leftover ?? '', /EPERM/)
  assert.ok((gone?.leftover ?? '').startsWith(sandbox))
  assert.deepEqual(h.bots.list(G), [])
  assert.equal(h.bots.remove(G, 'helper'), undefined)
  assert.ok(fs.existsSync(sandbox), 'the folder stays for the user to delete')
  assert.deepEqual(harness(undefined, h.dir).bots.list(G), [], 'the bot list was saved before the delete was tried')
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
test('mention mode and keywords: only a call wakes the bot; persona, cap and history ride in the prompt', async () => {
  const h = harness(() => 'x'.repeat(50))
  assert.equal(h.bots.add(G, 'scribe', 'ollama', 'take notes', { mode: 'mention', keywords: ['Deploy'], maxChars: 20, persona: 'terse and dry', contextLines: 5 }), undefined)
  h.say('bob', 'lunch anyone?')
  await idle(h)
  assert.equal(h.asks.length, 0, 'an uncalled mention-mode bot never asks its model')
  h.say('bob', 'we deploy at noon')
  await idle(h)
  assert.equal(h.asks.length, 1, 'a keyword calls it')
  assert.match(h.asks[0]?.prompt ?? '', /How you talk \(style only[^)]*\): terse and dry/)
  assert.match(h.asks[0]?.prompt ?? '', /under 20 characters/)
  assert.match(h.asks[0]?.prompt ?? '', /Someone called you/)
  assert.equal(h.posts[0]?.text, `${'x'.repeat(19)}…`, 'the cap cuts the reply')
})

test('cooldown, ignoring bots and pausing', async () => {
  const h = harness()
  h.bots.add(G, 'slow', 'ollama', 'answer', { cooldownSec: 600 })
  h.say('bob', 'one')
  await idle(h)
  h.say('bob', 'two')
  await idle(h)
  assert.equal(h.posts.length, 1, 'inside the cooldown it stays quiet')
  h.say('bob', 'hey @slow')
  await idle(h)
  assert.equal(h.posts.length, 2, 'a person calling it overrides the cooldown')

  const g = harness()
  g.bots.add(G, 'loner', 'ollama', 'answer', { talkToBots: false })
  const other: BotLine = { key: 'c:1', ts: Date.now(), from: 'carol', bot: { name: 'robo', mine: false }, text: 'beep' }
  g.chat.push(other)
  g.bots.hear(G, other)
  await idle(g)
  assert.equal(g.asks.length, 0, 'a bot that ignores bots does not hear them')

  const p = harness()
  p.bots.add(G, 'sleeper', 'ollama', 'answer')
  assert.equal(p.bots.edit(G, 'sleeper', { enabled: false }), undefined)
  p.say('bob', 'hello @sleeper')
  await idle(p)
  assert.equal(p.asks.length, 0, 'a paused bot says nothing')
})

test('settings are validated, saved, reloaded; old bots.json entries get defaults', () => {
  const h = harness()
  assert.match(h.bots.add(G, 'a1', 'ollama', 'x', { maxChars: -1 }) ?? '', /maxChars is a whole number/)
  assert.match(h.bots.add(G, 'a1', 'ollama', 'x', { keywords: ['two words'] }) ?? '', /not a keyword/)
  assert.match(h.bots.add(G, 'a1', 'ollama', 'x', { contextLines: 1 }) ?? '', /contextLines/)
  assert.equal(h.bots.add(G, 'a1', 'ollama', 'x', { keywords: ['Ship', 'ship'], mode: 'mention' }), undefined)
  assert.match(h.bots.edit(G, 'a1', { mode: 'sometimes' as 'auto' }) ?? '', /mode is auto or mention/)
  const again = harness(undefined, h.dir)
  assert.deepEqual(again.bots.list(G).map((b) => [b.keywords, b.mode, b.enabled, b.contextLines]), [[['ship'], 'mention', true, 40]])
  fs.writeFileSync(path.join(h.dir, 'bots.json'), JSON.stringify({ bots: [{ conv: G, name: 'old', backend: 'ollama', instructions: 'legacy' }] }))
  assert.deepEqual(harness(undefined, h.dir).bots.list(G).map((b) => [b.name, b.mode, b.docs, b.talkToBots]), [['old', 'auto', true, true]])
})

test('preview shows the prompt and test runs once without posting', async () => {
  const h = harness(() => 'hello there')
  h.bots.add(G, 'demo', 'ollama', 'greet people', { persona: 'pirate' })
  const cfg = h.bots.list(G)[0]!
  const p = h.bots.preview(cfg, '@demo hi')
  assert.match(p.system, /pirate/)
  assert.match(p.chat, /\[friend\] @demo hi/)
  assert.equal(await h.bots.test(cfg, '@demo hi', new AbortController().signal), 'hello there')
  assert.equal(h.posts.length, 0)
  await assert.rejects(h.bots.test({ ...cfg, backend: 'nope' }, 'x', new AbortController().signal), /No AI backend/)
})
