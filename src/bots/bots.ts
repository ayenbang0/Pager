import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatResult } from '../agents/chat.js'
import type { ChatMessage } from '../ai/http.js'
import { botNameProblem, instructionsProblem, loadBots, MAX_BOTS_PER_GROUP, saveBots, type BotConfig } from './config.js'
import { docCap } from '../agents/run/protocol.js'
import { docName } from '../docs/store.js'
import { botReply, buildBotPrompt, extractDocEdits, mentions, type BotLine } from './prompt.js'

/** Chat lines (besides the new ones) a turn shows the model. */
const CONTEXT_LINES = 40
/** Messages older than this when they arrive (a sync catching up after time offline) wake no bot. */
const FRESH_MS = 10 * 60_000
/** Bot turns running at once across every group; the rest wait for a slot. */
const MAX_CONCURRENT = 3
/** After this many bot messages in a row nobody but a person can wake the bots again: the backstop against two bots talking forever. */
export const MAX_BOT_STREAK = 6
/** New messages one bot keeps while it is busy; older ones are dropped. */
const MAX_HEARD = 50

export interface BotDeps {
  /** The data directory: `bots.json` and the sandbox folders under `bots/` live here. */
  dir: string
  /** Backends that can answer now: ready agents, then `ollama` and `openai`. */
  backends(): string[]
  /** One headless turn of a teammate's CLI in `cwd`, with the bot's own model and effort when it has them. */
  runCli(agent: string, prompt: string, cwd: string, signal: AbortSignal, want: { model?: string; effort?: string }): Promise<ChatResult>
  /** One whole reply from Ollama or the OpenAI-compatible API; `model` replaces the configured one. */
  complete(backend: 'ollama' | 'openai', messages: ChatMessage[], signal: AbortSignal, model?: string): Promise<string>
  /** The newest `limit` chat lines of a group, oldest first. */
  lines(conv: string, limit: number): BotLine[]
  /** The group as the bot meets it; undefined once it is gone or left. */
  group(conv: string): { title: string; host: string; people: string[] } | undefined
  /** Sends the bot's message to the group, as its host. */
  post(conv: string, name: string, text: string): void
  /** The group's shared documents, or undefined when bots may not see documents (secure session). */
  docs(conv: string): { name: string; text: string }[] | undefined
  /** Writes (or creates) a group document for a bot; `base` is the text it was shown. Returns a short note of what happened. */
  writeDoc(conv: string, name: string, text: string, append: boolean, base: string | undefined): string
  /** A turn failed. Called once until the bot succeeds again, so a dead backend does not repeat itself on every message. */
  failed(conv: string, name: string, error: string): void
}

export interface BotView extends BotConfig {
  /** Deciding or writing right now. */
  busy: boolean
}

interface Live {
  cfg: BotConfig
  /** Messages heard since its last turn started. */
  heard: BotLine[]
  running: boolean
  controller: AbortController | undefined
  failing: boolean
}

const keyOf = (conv: string, name: string): string => `${conv}\n${name}`

/**
 * AI bots in group chats. Every message a group hears is offered to each of its bots; a bot answers when its job makes it
 * relevant (else its model says NO_REPLY), and always when a person calls it with `@name`. One bot takes one turn at a
 * time: messages that arrive meanwhile are answered together in its next turn. Events: 'change'.
 */
export class GroupBots extends EventEmitter {
  private readonly live = new Map<string, Live>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly deps: BotDeps) {
    super()
    for (const cfg of loadBots(deps.dir)) this.live.set(keyOf(cfg.conv, cfg.name), { cfg, heard: [], running: false, controller: undefined, failing: false })
  }

  /** Bots in adding order; only those of `conv` when given. */
  list(conv?: string): BotView[] {
    return [...this.live.values()].filter((b) => conv === undefined || b.cfg.conv === conv).map((b) => ({ ...b.cfg, busy: b.running }))
  }

  busy(conv: string): boolean {
    return this.list(conv).some((b) => b.busy)
  }

  /** The bot's own folder for files and commands (CLI backends work in it). Created on demand. */
  sandbox(conv: string, name: string): string {
    const dir = path.join(this.deps.dir, 'bots', conv.replace(/^grp:/, '').slice(0, 16), name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Adds a bot to a group. Returns why it could not, or undefined. */
  add(conv: string, name: string, backend: string, instructions: string): string | undefined {
    const problem = botNameProblem(name) ?? instructionsProblem(instructions) ?? this.backendProblem(backend)
    if (problem !== undefined) return problem
    const here = this.list(conv)
    if (here.some((b) => b.name === name)) return `This group already has a bot named ${name}`
    if (here.length >= MAX_BOTS_PER_GROUP) return `A group can have ${MAX_BOTS_PER_GROUP} bots`
    this.live.set(keyOf(conv, name), { cfg: { conv, name, backend, instructions }, heard: [], running: false, controller: undefined, failing: false })
    this.save()
    this.sandbox(conv, name)
    this.emit('change')
    return undefined
  }

  /**
   * Changes a bot's backend, job, model or effort (null puts model or effort back to the backend's default); it applies from its
   * next turn. A new backend drops the model and effort, which belonged to the old one. Returns why it could not, or undefined.
   */
  edit(conv: string, name: string, change: { backend?: string; instructions?: string; model?: string | null; effort?: string | null }): string | undefined {
    const bot = this.live.get(keyOf(conv, name))
    if (bot === undefined) return `No bot named ${name} in this group`
    const problem = (change.instructions === undefined ? undefined : instructionsProblem(change.instructions)) ?? (change.backend === undefined ? undefined : this.backendProblem(change.backend))
    if (problem !== undefined) return problem
    const { model, effort, ...rest } = change
    const next: BotConfig = { ...bot.cfg, ...rest }
    if (change.backend !== undefined && change.backend !== bot.cfg.backend) {
      delete next.model
      delete next.effort
    }
    if (model === null) delete next.model
    else if (model !== undefined) next.model = model
    if (effort === null) delete next.effort
    else if (effort !== undefined) next.effort = effort
    bot.cfg = next
    bot.failing = false
    this.save()
    this.emit('change')
    return undefined
  }

  /** Stops a bot, forgets it and deletes its sandbox folder. False when there is no such bot. */
  remove(conv: string, name: string): boolean {
    const key = keyOf(conv, name)
    const bot = this.live.get(key)
    if (bot === undefined) return false
    this.halt(bot)
    this.live.delete(key)
    this.save()
    fs.rmSync(path.join(this.deps.dir, 'bots', conv.replace(/^grp:/, '').slice(0, 16), name), { recursive: true, force: true })
    this.emit('change')
    return true
  }

  /** Removes every bot of a group (it was left). */
  forget(conv: string): void {
    for (const b of this.list(conv)) this.remove(conv, b.name)
  }

  /** A new chat line in `conv`: each of its bots (but the one that wrote it) gets to react. */
  hear(conv: string, line: BotLine): void {
    if (Date.now() - line.ts > FRESH_MS) return
    for (const bot of this.live.values()) {
      if (bot.cfg.conv !== conv || (line.bot?.mine === true && line.bot.name === bot.cfg.name)) continue
      bot.heard.push(line)
      if (bot.heard.length > MAX_HEARD) bot.heard.splice(0, bot.heard.length - MAX_HEARD)
      void this.drain(bot)
    }
  }

  /** Stops the bots (of `conv`, or all) mid-turn and drops what they heard. True when one was busy. */
  stop(conv?: string): boolean {
    let had = false
    for (const bot of this.live.values()) {
      if (conv !== undefined && bot.cfg.conv !== conv) continue
      had ||= bot.running
      this.halt(bot)
    }
    return had
  }

  close(): void {
    this.stop()
  }

  private halt(bot: Live): void {
    bot.heard = []
    bot.controller?.abort(new Error('stopped'))
  }

  private backendProblem(backend: string): string | undefined {
    const ready = this.deps.backends()
    return ready.includes(backend) ? undefined : `No AI backend named "${backend}". Ready: ${ready.join(', ')}`
  }

  private save(): void {
    saveBots(this.deps.dir, [...this.live.values()].map((b) => b.cfg))
  }

  /** A turn slot; the returned function gives it back (straight to the next waiter, so the cap holds). */
  private async slot(): Promise<() => void> {
    if (this.active < MAX_CONCURRENT) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    return () => {
      const next = this.waiting.shift()
      if (next === undefined) this.active--
      else next()
    }
  }

  private async drain(bot: Live): Promise<void> {
    if (bot.running) return
    bot.running = true
    this.emit('change')
    try {
      while (bot.heard.length > 0 && this.live.get(keyOf(bot.cfg.conv, bot.cfg.name)) === bot) await this.turn(bot, bot.heard.splice(0))
    } finally {
      bot.running = false
      bot.controller = undefined
      this.emit('change')
    }
  }

  private async turn(bot: Live, heard: BotLine[]): Promise<void> {
    const controller = new AbortController()
    bot.controller = controller
    const release = await this.slot()
    try {
      if (controller.signal.aborted) return
      const { conv, name, backend, instructions } = bot.cfg
      const group = this.deps.group(conv)
      if (group === undefined) return
      const lines = this.deps.lines(conv, CONTEXT_LINES + heard.length)
      let streak = 0
      while (streak < lines.length && lines[lines.length - 1 - streak]?.bot !== undefined) streak++
      if (streak >= MAX_BOT_STREAK) return
      const fresh = new Set(heard.map((l) => l.key))
      const others = new Map<string, string>()
      for (const b of this.list(conv)) if (b.name !== name) others.set(`${b.name}\n${group.host}`, `${b.name} (${group.host}'s bot)`)
      for (const l of lines) if (l.bot !== undefined && !(l.bot.mine && l.bot.name === name)) others.set(`${l.bot.name}\n${l.from}`, `${l.bot.name} (${l.from}'s bot)`)
      const http = backend === 'ollama' || backend === 'openai'
      const cwd = this.sandbox(conv, name)
      const docs = this.deps.docs(conv)
      const { system, chat } = buildBotPrompt({
        name,
        host: group.host,
        instructions,
        title: group.title,
        people: group.people,
        bots: [...others.values()],
        ...(http ? {} : { cwd }),
        history: lines.filter((l) => !fresh.has(l.key)).slice(-CONTEXT_LINES),
        news: heard,
        called: heard.some((l) => l.bot === undefined && mentions(l.text, name)) ? 'person' : heard.some((l) => mentions(l.text, name)) ? 'bot' : undefined,
        streak,
        ...(docs === undefined ? {} : { docs }),
      })
      if (!this.deps.backends().includes(backend)) throw new Error(`${backend} is not ready (Settings > Agents)`)
      let raw: string
      if (backend === 'ollama' || backend === 'openai') {
        raw = await this.deps.complete(backend, [{ role: 'system', content: system }, { role: 'user', content: chat }], controller.signal, bot.cfg.model)
      } else {
        const want = { ...(bot.cfg.model === undefined ? {} : { model: bot.cfg.model }), ...(bot.cfg.effort === undefined ? {} : { effort: bot.cfg.effort }) }
        const res = await this.deps.runCli(backend, `${system}\n${chat}`, cwd, controller.signal, want)
        if (!res.ok) throw new Error(res.error)
        raw = res.text
      }
      if (controller.signal.aborted || this.live.get(keyOf(conv, name)) !== bot) return
      bot.failing = false
      // Document blocks are applied, then the rest is the chat reply; a note says what changed, so everyone knows.
      const { text: said, edits } = docs === undefined ? { text: raw, edits: [] } : extractDocEdits(raw)
      const notes = edits.map((e) => {
        const shown = docs?.find((d) => d.name.toLowerCase() === docName(e.name).toLowerCase())
        if (!e.append && shown !== undefined && shown.text.length > docCap(docs?.length ?? 1)) return `${shown.name} is too long to rewrite; append instead`
        return this.deps.writeDoc(conv, e.name, e.text, e.append, shown?.text)
      })
      const text = [botReply(said, name), ...notes.map((n) => `_✎ ${n}_`)].filter((t) => t !== undefined).join('\n\n')
      if (text !== '') this.deps.post(conv, name, text)
    } catch (err) {
      if (controller.signal.aborted || bot.failing) return
      bot.failing = true
      this.deps.failed(bot.cfg.conv, bot.cfg.name, err instanceof Error ? err.message : String(err))
    } finally {
      release()
      if (bot.controller === controller) bot.controller = undefined
    }
  }
}
