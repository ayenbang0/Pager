import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { MessageView } from '../app/engine.js'
import type { ChatResult } from '../agents/chat.js'
import { buildChatPrompt } from '../agents/chat.js'
import { effectiveAi, loadAiConfig, saveAiConfig, type AiConfig, type AiLock } from './config.js'
import { streamOllama, streamOpenAi, type ChatMessage } from './http.js'
import { Transcript, type AiEntry } from './transcript.js'

/** The id of the AI chat tab. */
export const AI_ID = 'ai'

const CONTEXT_ENTRIES = 40
const CONTEXT_CHARS = 60_000
const CHANGE_THROTTLE_MS = 80
const MENTION = /^@([a-z0-9][a-z0-9_-]*)\s+([\s\S]+)$/i

export interface AiDeps {
  /** The data directory: `ai.json`, `ai-chat.jsonl` and the scratch folder `ai/work` live here. */
  dir: string
  /** Names of the teammates whose CLI is ready, in listing order. */
  readyAgents(): string[]
  /** Runs one headless turn of a teammate's CLI. */
  runCli(agent: string, prompt: string, cwd: string, signal: AbortSignal): Promise<ChatResult>
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** The name the transcript calls the user. */
  user?: string
}

interface Queued {
  text: string
  done(): void
}

/**
 * The AI tab: a chat with one of the installed agents (headless, in a scratch folder), a local Ollama or any OpenAI-compatible API.
 * Turns run one at a time in the order they were sent. History lives in `ai-chat.jsonl`.
 */
export class AiChat extends EventEmitter {
  private readonly transcript: Transcript
  private config: AiConfig
  private sticky: string | undefined
  private readonly queue: Queued[] = []
  private running = false
  private controller: AbortController | undefined
  private changeTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: AiDeps) {
    super()
    this.transcript = new Transcript(path.join(deps.dir, 'ai-chat.jsonl'))
    this.config = loadAiConfig(deps.dir)
    this.scratch()
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0
  }

  /** The scratch folder CLI backends work in (created on demand). */
  scratch(): string {
    const dir = path.join(this.deps.dir, 'ai', 'work')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** The configuration as used (environment variables applied) and what the environment fixes. */
  effective(): { config: AiConfig; locks: AiLock[] } {
    return effectiveAi(this.config, this.deps.env ?? process.env)
  }

  /** The stored configuration (what Settings edits). */
  stored(): AiConfig {
    return this.config
  }

  update(change: (c: AiConfig) => AiConfig): void {
    this.config = change(structuredClone(this.config))
    saveAiConfig(this.deps.dir, this.config)
    this.emit('change')
  }

  /** Every backend id, in the order `auto` prefers them: ready CLI agents, then ollama, then openai. */
  backends(): string[] {
    return [...this.deps.readyAgents(), 'ollama', 'openai']
  }

  /** Who answers when nobody is named: the configured default when it is available, else the first ready agent, else ollama. */
  defaultBackend(): string {
    const backends = this.backends()
    return this.config.default !== 'auto' && backends.includes(this.config.default) ? this.config.default : (this.deps.readyAgents()[0] ?? 'ollama')
  }

  /** The backend a message goes to, and the message without its `@name`. `error` when `@name` is unknown. */
  resolve(text: string): { backend: string; text: string } | { error: string } {
    const m = MENTION.exec(text)
    if (m !== null) {
      const name = (m[1] ?? '').toLowerCase()
      if (!this.backends().includes(name)) return { error: `No AI backend named "${m[1]}"` }
      this.sticky = name
      return { backend: name, text: (m[2] ?? '').trim() }
    }
    return { backend: this.sticky ?? this.defaultBackend(), text }
  }

  /** One whole reply from Ollama or the OpenAI-compatible API, outside this tab's history (group bots ask through it). */
  async complete(backend: 'ollama' | 'openai', messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const { config } = this.effective()
    let text = ''
    const onChunk = (chunk: string): void => {
      text += chunk
    }
    if (backend === 'ollama') await streamOllama(config.ollama, messages, signal, onChunk, this.httpDeps())
    else await streamOpenAi(config.openai, messages, signal, onChunk, this.httpDeps())
    return text
  }

  /** Queues one message; resolves when its turn is over. */
  say(text: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.queue.push({ text, done: resolve })
    this.emit('change')
    void this.drain()
    return promise
  }

  /** Aborts the running turn and drops everything queued behind it. */
  stop(): boolean {
    const had = this.busy
    for (const q of this.queue.splice(0)) q.done()
    this.controller?.abort(new Error('stopped'))
    if (had) this.emit('change')
    return had
  }

  /** Empties the history and the scratch folder and forgets the sticky backend. */
  clear(): void {
    this.stop()
    this.transcript.clear()
    this.sticky = undefined
    fs.rmSync(path.join(this.deps.dir, 'ai', 'work'), { recursive: true, force: true })
    this.scratch()
    this.emit('change')
  }

  messages(limit: number): MessageView[] {
    return this.transcript
      .entries()
      .slice(-limit)
      .map((e): MessageView => {
        const base = { key: `ai:${e.n}`, ts: e.ts, authorName: e.author, authorKey: `ai:${e.author}`, mine: e.author === 'you', status: null }
        if (e.kind === 'system') return { ...base, authorName: 'pager', kind: 'system', text: e.text }
        if (e.kind === 'user') return { ...base, kind: 'text', text: e.text }
        return { ...base, kind: 'text', text: e.text === '' ? '…' : e.text, agent: true, markdown: true }
      })
  }

  close(): void {
    this.stop()
    clearTimeout(this.changeTimer)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        try {
          await this.turn(next.text)
        } finally {
          next.done()
        }
      }
    } finally {
      this.running = false
      this.controller = undefined
      this.emit('change')
    }
  }

  private changed(): void {
    if (this.changeTimer !== undefined) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      this.emit('change')
    }, CHANGE_THROTTLE_MS)
  }

  /** The last entries as prompt history, newest kept, capped in characters. */
  private history(): AiEntry[] {
    const picked: AiEntry[] = []
    let chars = 0
    for (const e of [...this.transcript.entries()].reverse()) {
      if (e.kind === 'system' || e.text === '') continue
      if (picked.length >= CONTEXT_ENTRIES || chars + e.text.length > CONTEXT_CHARS) break
      chars += e.text.length
      picked.unshift(e)
    }
    return picked
  }

  private async turn(raw: string): Promise<void> {
    const resolved = this.resolve(raw.trim())
    if ('error' in resolved) {
      this.transcript.add('you', 'user', raw.trim())
      this.transcript.add('pager', 'system', resolved.error)
      return void this.emit('change')
    }
    const history = this.history()
    this.transcript.add('you', 'user', resolved.text)
    this.emit('change')
    const controller = new AbortController()
    this.controller = controller
    const { backend } = resolved
    try {
      if (backend === 'ollama' || backend === 'openai') await this.http(backend, history, resolved.text, controller.signal)
      else await this.cli(backend, history, resolved.text, controller.signal)
    } catch (err) {
      if (controller.signal.aborted) this.transcript.add('pager', 'system', 'stopped')
      else this.transcript.add('pager', 'system', `failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
    this.emit('change')
  }

  private async cli(agent: string, history: readonly AiEntry[], message: string, signal: AbortSignal): Promise<void> {
    const cwd = this.scratch()
    const prompt = buildChatPrompt({ agent, user: this.deps.user ?? 'you', cwd, history: history.map((e) => ({ author: e.author, text: e.text })), message })
    const res = await this.deps.runCli(agent, prompt, cwd, signal)
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('stopped')
    if (!res.ok) throw new Error(res.error)
    this.transcript.add(agent, 'reply', res.text === '' ? '(no text; it may have worked on files in the scratch folder)' : res.text)
  }

  private httpDeps(): { fetch?: typeof fetch; lan: boolean } {
    return { ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }), lan: (this.deps.env ?? process.env).PAGER_LAN === '1' }
  }

  private async http(backend: 'ollama' | 'openai', history: readonly AiEntry[], message: string, signal: AbortSignal): Promise<void> {
    const { config } = this.effective()
    const messages: ChatMessage[] = [
      { role: 'system', content: `You are chatting with ${this.deps.user ?? 'the user'} through pager's AI tab. Reply in Markdown.` },
      ...history.map((e): ChatMessage => ({ role: e.kind === 'user' ? 'user' : 'assistant', content: e.text })),
      { role: 'user', content: message },
    ]
    const http = this.httpDeps()
    let entry: AiEntry | undefined
    const onChunk = (text: string): void => {
      entry ??= this.transcript.add(backend, 'reply', '', false)
      entry.text += text
      this.changed()
    }
    try {
      if (backend === 'ollama') await streamOllama(config.ollama, messages, signal, onChunk, http)
      else await streamOpenAi(config.openai, messages, signal, onChunk, http)
    } finally {
      if (entry !== undefined && entry.text !== '') this.transcript.persist(entry)
    }
    if (entry === undefined) throw new Error('the model sent no reply')
  }
}
