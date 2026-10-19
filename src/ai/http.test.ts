import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamOllama, streamOpenAi, type ChatMessage } from './http.js'

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
const never = new AbortController().signal

/** A body that arrives in the given pieces, so lines can be split across chunks. */
function body(pieces: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p))
        c.close()
      },
    }),
    init,
  )
}

const collect = async (run: (onChunk: (t: string) => void) => Promise<void>): Promise<string> => {
  let out = ''
  await run((t) => (out += t))
  return out
}

test('Ollama NDJSON: chunks join, split lines are reassembled, junk lines are skipped, a blank model uses the first installed one', async () => {
  const calls: { url: string; body?: unknown }[] = []
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3' }, { name: 'other' }] })
    return body(['{"message":{"content":"Hel', 'lo"},"done":false}\n{"message":{"con', 'tent":" there"},"done":false}\nnot json\n{"unexpected":1}\n{"done":true}'])
  }
  const text = await collect((on) => streamOllama({ url: 'http://127.0.0.1:11434/', model: '' }, messages, never, on, { fetch: fetchStub }))
  assert.equal(text, 'Hello there')
  assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/chat'])
  assert.deepEqual(calls[1]?.body, { model: 'llama3', messages, stream: true })
})

test('Ollama: no models, an unreachable server, a 404 and an error line each say what to do', async () => {
  await assert.rejects(streamOllama({ url: 'http://127.0.0.1:1', model: '' }, messages, never, () => {}, { fetch: async () => Response.json({ models: [] }) }), /Ollama has no models\. Run: ollama pull <model>/)
  await assert.rejects(streamOllama({ url: 'http://127.0.0.1:1', model: 'x' }, messages, never, () => {}, { fetch: async () => Promise.reject(new TypeError('fetch failed')) }), /Could not reach Ollama at http:\/\/127\.0\.0\.1:1/)
  await assert.rejects(streamOllama({ url: 'http://127.0.0.1:1', model: 'nope' }, messages, never, () => {}, { fetch: async () => new Response('', { status: 404 }) }), /ollama pull nope/)
  await assert.rejects(streamOllama({ url: 'http://127.0.0.1:1', model: 'x' }, messages, never, () => {}, { fetch: async () => body(['{"error":"model not found"}\n']) }), /model not found/)
})

test('OpenAI SSE: deltas join, [DONE] ends, split events and non-data lines are handled', async () => {
  let seen: { url: string; auth: string | null; body: unknown } | undefined
  const fetchStub: typeof fetch = async (input, init) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) }
    return body([': keep-alive\n\ndata: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"del', 'ta":{"content":"llo"}}]}\n\ndata: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"after"}}]}\n\n'])
  }
  const text = await collect((on) => streamOpenAi({ url: 'https://api.example.com/v1/', model: 'm', key: 'sk-1' }, messages, never, on, { fetch: fetchStub }))
  assert.equal(text, 'Hello')
  assert.deepEqual(seen, { url: 'https://api.example.com/v1/chat/completions', auth: 'Bearer sk-1', body: { model: 'm', messages, stream: true } })
})

test('OpenAI: a blank model or key, a 401, other statuses and an error object are refused with clear messages', async () => {
  const ok: typeof fetch = async () => body(['data: [DONE]\n'])
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: '', key: 'k' }, messages, never, () => {}, { fetch: ok }), /Set a model in Settings > AI chat and Web/)
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: 'm', key: '' }, messages, never, () => {}, { fetch: ok }), /Set an API key in Settings > AI chat and Web \(or PAGER_AI_KEY\)/)
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: 'm', key: 'k' }, messages, never, () => {}, { fetch: async () => new Response('', { status: 401 }) }), /The API rejected the key/)
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: 'm', key: 'k' }, messages, never, () => {}, { fetch: async () => new Response('', { status: 503 }) }), /The API answered 503/)
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: 'm', key: 'k' }, messages, never, () => {}, { fetch: async () => body(['data: {"error":{"message":"quota"}}\n']) }), /quota/)
})

test('LAN mode refuses a public host before any request is made', async () => {
  let called = false
  const fetchStub: typeof fetch = async () => {
    called = true
    return body([])
  }
  await assert.rejects(streamOpenAi({ url: 'https://api.openai.com/v1', model: 'm', key: 'k' }, messages, never, () => {}, { fetch: fetchStub, lan: true }), /LAN mode blocks internet access \(api\.openai\.com\)/)
  await assert.rejects(streamOllama({ url: 'http://ollama.example.com', model: 'm' }, messages, never, () => {}, { fetch: fetchStub, lan: true }), /LAN mode blocks internet access/)
  assert.equal(called, false)
  await streamOllama({ url: 'http://192.168.1.9:11434', model: 'm' }, messages, never, () => {}, { fetch: async () => body(['{"done":true}\n']), lan: true })
})

test('aborting stops a stream and the first byte has a deadline', async () => {
  const c = new AbortController()
  const pending: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted'))))
  const run = streamOllama({ url: 'http://127.0.0.1:1', model: 'x' }, messages, c.signal, () => {}, { fetch: pending })
  c.abort(new Error('stopped'))
  await assert.rejects(run, /stopped/)
  await assert.rejects(streamOpenAi({ url: 'https://a.b', model: 'm', key: 'k' }, messages, never, () => {}, { fetch: pending, firstByteMs: 20 }), /No answer within 20 seconds/)
})
