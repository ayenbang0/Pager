import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir, waitFor } from '../testing/testutil.js'
import type { ChatResult } from '../agents/chat.js'
import { AiChat, type AiDeps } from './chat.js'
import { effectiveAi, loadAiConfig } from './config.js'

after(removeTmpDirs)

const ndjson = (parts: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p))
        c.close()
      },
    }),
  )

interface Setup {
  chat: AiChat
  dir: string
  cli: { agent: string; prompt: string; cwd: string }[]
}

function setup(over: Partial<AiDeps> & { reply?: (agent: string, prompt: string, signal: AbortSignal) => Promise<ChatResult> } = {}, dir = tmpDir('pager-ai-')): Setup {
  const cli: Setup['cli'] = []
  const { reply, ...rest } = over
  const chat = new AiChat({
    dir,
    readyAgents: () => ['omp', 'claude'],
    runCli: async (agent, prompt, cwd, signal) => {
      cli.push({ agent, prompt, cwd })
      return reply === undefined ? { ok: true, text: `${agent} says hi` } : reply(agent, prompt, signal)
    },
    ...rest,
  })
  return { chat, dir, cli }
}

const texts = (chat: AiChat): string[] => chat.messages(100).map((m) => `${m.authorName}: ${m.text}`)

test('with no preference the first ready agent answers, and the reply is Markdown from an agent', async () => {
  const { chat, cli } = setup()
  await chat.say('hello')
  assert.deepEqual(texts(chat), ['you: hello', 'omp: omp says hi'])
  assert.equal(cli[0]?.agent, 'omp')
  const [mine, reply] = chat.messages(10)
  assert.deepEqual([mine?.mine, mine?.agent, reply?.mine, reply?.agent, reply?.markdown, reply?.authorKey], [true, undefined, false, true, true, 'ai:omp'])
  assert.equal(reply?.key, 'ai:2')
})

test('@name picks the backend and sticks; an unknown name explains itself; the configured default applies before auto', async () => {
  const { chat, cli, dir } = setup()
  await chat.say('@claude first')
  await chat.say('second')
  assert.deepEqual(cli.map((c) => c.agent), ['claude', 'claude'])
  assert.match(cli[0]?.prompt ?? '', /--- NEW MESSAGES ---\nfirst$/)
  await chat.say('@nope hi')
  assert.ok(texts(chat).includes('pager: No AI backend named "nope"'))
  assert.equal(cli.length, 2)
  chat.clear()
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ default: 'claude' }))
  const configured = setup({}, dir)
  await configured.chat.say('x')
  assert.equal(configured.cli[0]?.agent, 'claude')
  // a default that is not installed falls back to auto
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ default: 'ghost' }))
  const fallback = setup({}, dir)
  await fallback.chat.say('x')
  assert.equal(fallback.cli[0]?.agent, 'omp')
})

test('turns run one at a time in the order they were sent', async () => {
  const gates: PromiseWithResolvers<ChatResult>[] = []
  const order: string[] = []
  const { chat } = setup({
    reply: (_agent, prompt) => {
      order.push(prompt.split('--- NEW MESSAGES ---\n')[1] ?? '')
      const g = Promise.withResolvers<ChatResult>()
      gates.push(g)
      return g.promise
    },
  })
  const a = chat.say('one')
  const b = chat.say('two')
  const c = chat.say('three')
  await waitFor(() => gates.length === 1, 2000, 'first turn')
  assert.equal(chat.busy, true)
  assert.deepEqual(order, ['one'])
  gates[0]?.resolve({ ok: true, text: 'r1' })
  await a
  await waitFor(() => gates.length === 2, 2000, 'second turn')
  assert.deepEqual(order, ['one', 'two'])
  gates[1]?.resolve({ ok: true, text: 'r2' })
  await b
  await waitFor(() => gates.length === 3, 2000, 'third turn')
  gates[2]?.resolve({ ok: true, text: 'r3' })
  await c
  assert.equal(chat.busy, false)
  assert.deepEqual(texts(chat).filter((t) => t.startsWith('omp:')), ['omp: r1', 'omp: r2', 'omp: r3'])
})

test('stop aborts the running turn and drops the queue behind it', async () => {
  let aborted = false
  const { chat, cli } = setup({
    reply: (_a, _p, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve({ ok: false, error: 'stopped' })
        })
      }),
  })
  const first = chat.say('long')
  const second = chat.say('never runs')
  await waitFor(() => cli.length === 1, 2000, 'turn started')
  assert.equal(chat.stop(), true)
  await Promise.all([first, second])
  assert.equal(aborted, true)
  assert.equal(cli.length, 1)
  assert.ok(texts(chat).includes('pager: stopped'))
  assert.equal(chat.busy, false)
  assert.equal(chat.stop(), false)
})

test('a failing backend leaves a system line, the queue carries on', async () => {
  let n = 0
  const { chat } = setup({ reply: async () => (++n === 1 ? { ok: false, error: 'boom' } : { ok: true, text: 'fine' }) })
  await chat.say('a')
  await chat.say('b')
  assert.deepEqual(texts(chat), ['you: a', 'pager: failed: boom', 'you: b', 'omp: fine'])
  assert.equal(chat.messages(10)[1]?.kind, 'system')
})

test('history survives a restart, is part of the next prompt, and clear wipes it and the scratch folder', async () => {
  const dir = tmpDir('pager-ai-')
  const first = setup({}, dir)
  await first.chat.say('remember me')
  fs.writeFileSync(path.join(first.chat.scratch(), 'junk.txt'), 'x')
  first.chat.close()
  const second = setup({}, dir)
  assert.deepEqual(texts(second.chat), ['you: remember me', 'omp: omp says hi'])
  await second.chat.say('again')
  assert.match(second.cli[0]?.prompt ?? '', /--- CHAT ---\nyou: remember me\nomp: omp says hi\n--- NEW MESSAGES ---\nagain$/)
  assert.equal(second.cli[0]?.cwd, path.join(dir, 'ai', 'work'))
  second.chat.clear()
  assert.deepEqual(texts(second.chat), [])
  assert.equal(fs.existsSync(path.join(dir, 'ai-chat.jsonl')), false)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'ai', 'work')), [])
  assert.deepEqual(texts(setup({}, dir).chat), [])
})

test('Ollama and OpenAI-compatible backends stream into one entry that is saved once', async () => {
  const dir = tmpDir('pager-ai-')
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ ollama: { url: 'http://127.0.0.1:11434', model: 'm' }, openai: { url: 'https://api.example.com/v1', model: 'gpt', key: 'sk-test' } }))
  const seen: string[] = []
  const fetchStub: typeof fetch = async (input) => {
    seen.push(String(input))
    return String(input).includes('/api/chat')
      ? ndjson(['{"message":{"content":"Hel"}}\n', '{"message":{"content":"lo"}}\n{"done":true}\n'])
      : ndjson(['data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n'])
  }
  const { chat } = setup({ fetch: fetchStub }, dir)
  await chat.say('@ollama hi')
  await chat.say('@openai hi')
  assert.deepEqual(texts(chat), ['you: hi', 'ollama: Hello', 'you: hi', 'openai: AB'])
  assert.deepEqual(seen, ['http://127.0.0.1:11434/api/chat', 'https://api.example.com/v1/chat/completions'])
  const lines = fs.readFileSync(path.join(dir, 'ai-chat.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 4)
  // a missing key is an error line, not a crash
  const bare = setup({ fetch: fetchStub })
  await bare.chat.say('@openai hi')
  assert.ok(texts(bare.chat).some((t) => t.startsWith('pager: failed: Set a model in Settings > AI chat and Web')))
})

test('LAN mode (PAGER_LAN=1) refuses a public API host', async () => {
  const dir = tmpDir('pager-ai-')
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ openai: { url: 'https://api.openai.com/v1', model: 'gpt', key: 'k' } }))
  const { chat } = setup({ env: { ...process.env, PAGER_LAN: '1' }, fetch: async () => ndjson([]) }, dir)
  await chat.say('@openai hi')
  assert.ok(texts(chat).includes('pager: failed: LAN mode blocks internet access (api.openai.com)'))
})

test('the config loader is tolerant and the environment wins over the file', () => {
  const dir = tmpDir('pager-ai-')
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ default: 5, ollama: { url: 'http://h:1', model: 7 }, openai: { key: 'file-key', url: 'https://file.example/v1' } }))
  const c = loadAiConfig(dir)
  assert.deepEqual([c.default, c.ollama.url, c.ollama.model, c.openai.key], ['auto', 'http://h:1', '', 'file-key'])
  assert.deepEqual(effectiveAi(c, {}).locks, [])
  const both = effectiveAi(c, { PAGER_AI_KEY: 'env-key', OPENAI_API_KEY: 'other', PAGER_AI_URL: 'https://env.example/v1' })
  assert.equal(both.config.openai.key, 'env-key')
  assert.equal(both.config.openai.url, 'https://env.example/v1')
  assert.deepEqual(both.locks, [{ key: 'ai.openai.key', source: 'PAGER_AI_KEY' }, { key: 'ai.openai.url', source: 'PAGER_AI_URL' }])
  assert.deepEqual(effectiveAi(c, { OPENAI_API_KEY: 'o' }).locks, [{ key: 'ai.openai.key', source: 'OPENAI_API_KEY' }])
  assert.equal(c.openai.key, 'file-key', 'the stored config is not changed')
})
