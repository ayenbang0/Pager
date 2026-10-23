import { botNameProblem, DEFAULT_SETTINGS, instructionsProblem, MAX_BOTS_PER_GROUP, MAX_COOLDOWN_SEC, MAX_INSTRUCTIONS, MAX_KEYWORDS, MAX_PERSONA, MAX_REPLY_CHARS, CONTEXT_RANGE, settingsFrom, type BotConfig, type BotSettings } from '../bots/config.js'
import { isRecord } from '../util/guards.js'

/** One of my bots as the bot studio shows it. */
export interface StudioBot extends BotConfig {
  /** The group's title, for people. */
  where: string
  busy: boolean
}

export interface StudioState {
  groups: { id: string; title: string }[]
  /** Backends that can answer now. */
  backends: string[]
  bots: StudioBot[]
  defaults: BotSettings
  limits: Record<string, number>
}

/** What the studio page may do; the engine implements it on top of its bots. */
export interface StudioApi {
  state(): StudioState
  /** Adds (`create`) or changes a bot. Returns why not, or undefined. */
  save(input: BotConfig, create: boolean): string | undefined
  remove(conv: string, name: string): boolean
  preview(input: BotConfig, message: string): { system: string; chat: string }
  /** One dry run on a pretend message. `reply` is undefined when the bot would stay silent. */
  test(input: BotConfig, message: string, signal: AbortSignal): Promise<{ reply?: string }>
}

export const STUDIO_LIMITS = {
  maxBots: MAX_BOTS_PER_GROUP,
  instructions: MAX_INSTRUCTIONS,
  persona: MAX_PERSONA,
  keywords: MAX_KEYWORDS,
  maxChars: MAX_REPLY_CHARS,
  cooldownSec: MAX_COOLDOWN_SEC,
  contextMin: CONTEXT_RANGE[0],
  contextMax: CONTEXT_RANGE[1],
} as const

const CONV_RE = /^grp:[0-9a-f]{32}$/

/** A bot sent by the studio page, checked field by field; the text says what is wrong. */
export function parseBotInput(raw: unknown): BotConfig | string {
  if (!isRecord(raw)) return 'Expected a JSON object'
  const { conv, name, backend, instructions } = raw
  if (typeof conv !== 'string' || !CONV_RE.test(conv)) return 'Pick a group'
  if (typeof name !== 'string') return 'Give the bot a name'
  const bad = botNameProblem(name)
  if (bad !== undefined) return bad
  if (typeof backend !== 'string' || backend === '') return 'Pick a backend'
  if (typeof instructions !== 'string') return 'Say what the bot does'
  const job = instructionsProblem(instructions)
  if (job !== undefined) return job
  const settings = settingsFrom(raw)
  if (typeof settings === 'string') return settings
  const want: { model?: string; effort?: string } = {}
  for (const key of ['model', 'effort'] as const) {
    const v = raw[key]
    if (v === undefined || v === '') continue
    if (typeof v !== 'string' || v.length > 100 || /\p{Cc}/u.test(v)) return `${key} is a short word or name`
    want[key] = v
  }
  return { conv, name, backend, instructions, ...want, ...settings }
}

export const STUDIO_DEFAULTS: Readonly<BotSettings> = DEFAULT_SETTINGS
