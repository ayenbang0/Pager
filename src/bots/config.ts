import fs from 'node:fs'
import path from 'node:path'
import { RESERVED_NAMES } from '../agents/run/registry.js'
import { BOT_NAME_RE } from '../chat/botMessage.js'
import { isRecord } from '../util/guards.js'

/** The fine-grained knobs of a bot; `/bot` leaves them at their defaults, the local bot studio sets them. */
export interface BotSettings {
  /** How it talks: tone, voice, quirks. Optional, on top of the job. */
  persona: string
  /** `auto`: the model decides when to speak. `mention`: only when called with @name or one of its keywords. */
  mode: 'auto' | 'mention'
  /** Words that call the bot like @name does (case-insensitive, whole words). */
  keywords: string[]
  /** Longest reply it may post, in characters; 0 = no cap. */
  maxChars: number
  /** Least seconds between two of its replies, unless a person calls it; 0 = none. */
  cooldownSec: number
  /** Chat lines of history each turn shows the model. */
  contextLines: number
  /** May it read and write the group's shared documents. */
  docs: boolean
  /** May it react to other bots' messages. */
  talkToBots: boolean
  /** Off = paused: it hears nothing and says nothing. */
  enabled: boolean
}

/** A bot in one group: its name (what `@name` calls), who answers for it (a ready agent, `ollama` or `openai`), its job, its settings, and optionally the model and effort it asks for. */
export interface BotConfig extends BotSettings {
  conv: string
  name: string
  backend: string
  instructions: string
  model?: string
  effort?: string
}

export const DEFAULT_SETTINGS: Readonly<BotSettings> = { persona: '', mode: 'auto', keywords: [], maxChars: 0, cooldownSec: 0, contextLines: 40, docs: true, talkToBots: true, enabled: true }

export const MAX_PERSONA = 2000
export const MAX_KEYWORDS = 12
export const KEYWORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,29}$/u
export const CONTEXT_RANGE = [5, 100] as const
export const MAX_REPLY_CHARS = 8000
export const MAX_COOLDOWN_SEC = 3600

/** Bots one group may have here. */
export const MAX_BOTS_PER_GROUP = 8
export const MAX_INSTRUCTIONS = 4000

/** Why `name` cannot name a bot, or undefined when it can. */
export function botNameProblem(name: string): string | undefined {
  if (RESERVED_NAMES.includes(name)) return `"${name}" is reserved`
  if (!BOT_NAME_RE.test(name)) return `"${name.slice(0, 30)}" is not a valid bot name: use 2-24 lowercase letters, digits, - or _, starting with a letter`
  return undefined
}

/** Why `text` cannot be a bot's job, or undefined when it can. */
export function instructionsProblem(text: string): string | undefined {
  if (text === '') return 'Say what the bot does, e.g. "argue with every point anyone makes"'
  if (text.length > MAX_INSTRUCTIONS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return `A bot's job is 1-${MAX_INSTRUCTIONS} characters of text`
  return undefined
}

/** The settings in `raw` laid over the defaults, or why they cannot be used. Unknown keys are ignored. */
export function settingsFrom(raw: Record<string, unknown>): BotSettings | string {
  const s: BotSettings = { ...DEFAULT_SETTINGS, keywords: [] }
  const { persona, mode, keywords, maxChars, cooldownSec, contextLines } = raw
  if (persona !== undefined) {
    if (typeof persona !== 'string' || persona.length > MAX_PERSONA || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(persona)) return `The persona is text of at most ${MAX_PERSONA} characters`
    s.persona = persona.trim()
  }
  if (mode !== undefined) {
    if (mode !== 'auto' && mode !== 'mention') return 'mode is auto or mention'
    s.mode = mode
  }
  if (keywords !== undefined) {
    if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS) return `At most ${MAX_KEYWORDS} keywords`
    const seen = new Set<string>()
    for (const k of keywords) {
      if (typeof k !== 'string' || !KEYWORD_RE.test(k.trim())) return `"${String(k).slice(0, 30)}" is not a keyword: one word of letters, digits, - or _`
      seen.add(k.trim().toLowerCase())
    }
    s.keywords = [...seen]
  }
  const int = (v: unknown, lo: number, hi: number, what: string): number | string => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : `${what} is a whole number from ${lo} to ${hi}`)
  for (const [key, v, lo, hi] of [['maxChars', maxChars, 0, MAX_REPLY_CHARS], ['cooldownSec', cooldownSec, 0, MAX_COOLDOWN_SEC], ['contextLines', contextLines, CONTEXT_RANGE[0], CONTEXT_RANGE[1]]] as const) {
    if (v === undefined) continue
    const n = int(v, lo, hi, key)
    if (typeof n === 'string') return n
    s[key] = n
  }
  for (const key of ['docs', 'talkToBots', 'enabled'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'boolean') return `${key} is true or false`
    s[key] = v
  }
  return s
}

const file = (dir: string): string => path.join(dir, 'bots.json')

/** `bots.json`; a missing or damaged file means no bots, and damaged entries are skipped. */
export function loadBots(dir: string): BotConfig[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file(dir), 'utf8'))
  } catch {
    return []
  }
  const out: BotConfig[] = []
  for (const e of isRecord(raw) && Array.isArray(raw.bots) ? raw.bots : []) {
    if (!isRecord(e)) continue
    const { conv, name, backend, instructions, model, effort } = e
    if (typeof conv !== 'string' || !/^grp:[0-9a-f]{32}$/.test(conv) || typeof name !== 'string' || botNameProblem(name) !== undefined) continue
    if (typeof backend !== 'string' || backend === '' || typeof instructions !== 'string' || instructionsProblem(instructions) !== undefined) continue
    if (out.some((b) => b.conv === conv && b.name === name)) continue
    const settings = settingsFrom(e)
    const ok = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 100 && !/\p{Cc}/u.test(v)
    out.push({ conv, name, backend, instructions, ...(ok(model) ? { model } : {}), ...(ok(effort) ? { effort } : {}), ...(typeof settings === 'string' ? DEFAULT_SETTINGS : settings) })
  }
  return out
}

/** Atomic: a crash mid-write leaves the previous file. */
export function saveBots(dir: string, bots: readonly BotConfig[]): void {
  const tmp = `${file(dir)}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ bots }, null, 2)}\n`)
  fs.renameSync(tmp, file(dir))
}
