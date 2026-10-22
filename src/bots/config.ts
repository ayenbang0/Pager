import fs from 'node:fs'
import path from 'node:path'
import { RESERVED_NAMES } from '../agents/run/registry.js'
import { BOT_NAME_RE } from '../chat/botMessage.js'
import { isRecord } from '../util/guards.js'

/** A bot in one chat (a group or a DM): its name (what `@name` calls), who answers for it (a ready agent, `ollama` or `openai`), its job, and optionally the model and effort it asks for. */
export interface BotConfig {
  conv: string
  name: string
  backend: string
  instructions: string
  model?: string
  effort?: string
  /** Only the host can talk to it: other people's and bots' messages never wake it or reach its prompt. */
  private?: true
}

/** Bots one chat may have here. */
export const MAX_BOTS_PER_CHAT = 8
export const MAX_INSTRUCTIONS = 1000

/** Why `name` cannot name a bot, or undefined when it can. */
export function botNameProblem(name: string): string | undefined {
  if (RESERVED_NAMES.includes(name)) return `"${name}" is reserved`
  if (!BOT_NAME_RE.test(name)) return `"${name.slice(0, 30)}" is not a valid bot name: use 2-24 lowercase letters, digits, - or _, starting with a letter`
  return undefined
}

/** Why `text` cannot be a bot's job, or undefined when it can. */
export function instructionsProblem(text: string): string | undefined {
  if (text === '') return 'Say what the bot does, e.g. "argue with every point anyone makes"'
  if (text.length > MAX_INSTRUCTIONS || /\p{Cc}/u.test(text)) return `A bot's job is 1-${MAX_INSTRUCTIONS} characters on one line`
  return undefined
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
    if (typeof conv !== 'string' || !/^(grp|dm):[0-9a-f]{32}$/.test(conv) || typeof name !== 'string' || botNameProblem(name) !== undefined) continue
    if (typeof backend !== 'string' || backend === '' || typeof instructions !== 'string' || instructionsProblem(instructions) !== undefined) continue
    if (out.some((b) => b.conv === conv && b.name === name)) continue
    const ok = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 100 && !/\p{Cc}/u.test(v)
    out.push({ conv, name, backend, instructions, ...(ok(model) ? { model } : {}), ...(ok(effort) ? { effort } : {}), ...(e.private === true ? { private: true as const } : {}) })
  }
  return out
}

/** Atomic: a crash mid-write leaves the previous file. */
export function saveBots(dir: string, bots: readonly BotConfig[]): void {
  const tmp = `${file(dir)}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ bots }, null, 2)}\n`)
  fs.renameSync(tmp, file(dir))
}
