import { z } from 'zod'
import { isPrivateHost } from '../tools/web/host.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface HttpDeps {
  fetch?: typeof fetch
  /** LAN mode: only private-network hosts may be called. */
  lan?: boolean
  /** Milliseconds to wait for the first byte (default 20,000). */
  firstByteMs?: number
}

const FIRST_BYTE_MS = 20_000

const ollamaLine = z.object({ message: z.object({ content: z.string() }).optional(), done: z.boolean().optional(), error: z.string().optional() })
const ollamaTags = z.object({ models: z.array(z.object({ name: z.string() })) })
const sseChunk = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }).optional() })).optional(), error: z.object({ message: z.string().optional() }).optional() })

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function guardHost(url: string, deps: HttpDeps): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error(`"${url.slice(0, 60)}" is not a valid address`)
  }
  if (deps.lan === true && !isPrivateHost(host)) throw new Error(`LAN mode blocks internet access (${host})`)
}

/** `signal` aborts the request; the first byte must arrive within `firstByteMs`, after which the stream may take as long as it likes. */
async function open(url: string, init: RequestInit, signal: AbortSignal, deps: HttpDeps): Promise<Response> {
  const control = new AbortController()
  const abort = (): void => control.abort(signal.reason)
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => control.abort(new Error('No answer within 20 seconds')), deps.firstByteMs ?? FIRST_BYTE_MS)
  try {
    return await (deps.fetch ?? fetch)(url, { ...init, signal: control.signal })
  } catch (err) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('stopped')
    throw err instanceof Error && control.signal.aborted && control.signal.reason instanceof Error ? control.signal.reason : err
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Feeds `onLine` each complete line of the response body as it arrives. */
async function eachLine(res: Response, onLine: (line: string) => void): Promise<void> {
  if (res.body === null) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl = pending.indexOf('\n')
    while (nl >= 0) {
      onLine(pending.slice(0, nl).replace(/\r$/, ''))
      pending = pending.slice(nl + 1)
      nl = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending !== '') onLine(pending)
}

export async function streamOllama(cfg: { url: string; model: string }, messages: ChatMessage[], signal: AbortSignal, onChunk: (text: string) => void, deps: HttpDeps = {}): Promise<void> {
  guardHost(cfg.url, deps)
  let model = cfg.model
  try {
    if (model === '') {
      const tags = await open(join(cfg.url, '/api/tags'), {}, signal, deps)
      if (!tags.ok) throw new Error(`Ollama answered ${tags.status}`)
      const parsed = ollamaTags.safeParse(await tags.json())
      model = parsed.success ? (parsed.data.models[0]?.name ?? '') : ''
      if (model === '') throw new Error('Ollama has no models. Run: ollama pull <model>')
    }
    const res = await open(join(cfg.url, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true }) }, signal, deps)
    if (!res.ok) throw new Error(`Ollama answered ${res.status}${res.status === 404 ? `: is "${model}" pulled? Run: ollama pull ${model}` : ''}`)
    await eachLine(res, (line) => {
      if (line.trim() === '') return
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        return
      }
      const parsed = ollamaLine.safeParse(json)
      if (!parsed.success) return
      if (parsed.data.error !== undefined) throw new Error(parsed.data.error)
      const text = parsed.data.message?.content
      if (text !== undefined && text !== '') onChunk(text)
    })
  } catch (err) {
    if (signal.aborted) throw err
    if (err instanceof TypeError) throw new Error(`Could not reach Ollama at ${cfg.url}`)
    throw err
  }
}

export async function streamOpenAi(cfg: { url: string; model: string; key: string }, messages: ChatMessage[], signal: AbortSignal, onChunk: (text: string) => void, deps: HttpDeps = {}): Promise<void> {
  guardHost(cfg.url, deps)
  if (cfg.model === '') throw new Error('Set a model in Settings > AI chat and Web')
  if (cfg.key === '') throw new Error('Set an API key in Settings > AI chat and Web (or PAGER_AI_KEY)')
  let res: Response
  try {
    res = await open(
      join(cfg.url, '/chat/completions'),
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` }, body: JSON.stringify({ model: cfg.model, messages, stream: true }) },
      signal,
      deps,
    )
  } catch (err) {
    if (!signal.aborted && err instanceof TypeError) throw new Error(`Could not reach ${new URL(cfg.url).host}`)
    throw err
  }
  if (res.status === 401) throw new Error('The API rejected the key')
  if (!res.ok) throw new Error(`The API answered ${res.status}`)
  let finished = false
  await eachLine(res, (line) => {
    if (finished || !line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      finished = true
      return
    }
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    const parsed = sseChunk.safeParse(json)
    if (!parsed.success) return
    if (parsed.data.error !== undefined) throw new Error(parsed.data.error.message ?? 'The API reported an error')
    const text = parsed.data.choices?.[0]?.delta?.content
    if (text !== undefined && text !== null && text !== '') onChunk(text)
  })
}
