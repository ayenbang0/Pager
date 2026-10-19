import fs from 'node:fs'
import path from 'node:path'
import { parseColor } from '../../ui/theme/colors.js'
import { isRecord } from '../../util/guards.js'
import { type AgentPreset, launch, PRESETS } from './catalog.js'

/** One named teammate: an instance of an agent CLI with its own model and effort. */
export interface AgentConfig {
  name: string
  cli: string
  model?: string
  effort?: string
  /** Personal color (`#rrggbb` or an Ink name) for this agent's sidebar row, author line, tab header and Home row. Absent = picked by the theme. */
  color?: string
}

/** A user-defined ACP agent: `command args…` speaks ACP over stdio. */
export interface CustomAgent {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type Readiness = { state: 'unknown' | 'checking' | 'ready' } | { state: 'missing' | 'failed'; reason: string }

/** Names that already mean something in pager: tabs, mentions and chat authors. */
export const RESERVED_NAMES = ['all', 'you', 'pager', 'agents', 'home', 'terminal', 'docs']

const ID_RE = /^[a-z][a-z0-9_-]{1,23}$/
const UNKNOWN: Readiness = { state: 'unknown' }

/** Instance names and custom agent ids: lowercase, 2-24 chars, and not reserved. */
export function isValidAgentId(s: string): boolean {
  return ID_RE.test(s) && !RESERVED_NAMES.includes(s)
}

function parseEnv(x: unknown): Record<string, string> | undefined {
  if (!isRecord(x)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(x)) if (typeof value === 'string') env[key] = value
  return Object.keys(env).length > 0 ? env : undefined
}

/** Which agents exist, what they are called and whether they passed their readiness check. Persisted to `<dataDir>/agents.json`. */
export class Registry {
  /** Set when the last save failed; the in-memory state still stands. */
  saveError: string | undefined
  private readonly file: string
  private customAgents: Record<string, CustomAgent> = {}
  private list: AgentConfig[] = []
  private reviewOn = true
  private compactOn = true
  private riskOn = true
  private readonly states = new Map<string, Readiness>()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'agents.json')
    this.load()
  }

  get review(): boolean {
    return this.reviewOn
  }

  get autoCompact(): boolean {
    return this.compactOn
  }

  setReview(on: boolean): void {
    this.reviewOn = on
    this.save()
  }

  setAutoCompact(on: boolean): void {
    this.compactOn = on
    this.save()
  }

  /** Whether risky permission requests (push, force, rm -rf, publish…) are put to the user instead of auto-approved. */
  get riskApproval(): boolean {
    return this.riskOn
  }

  setRiskApproval(on: boolean): void {
    this.riskOn = on
    this.save()
  }

  presets(): AgentPreset[] {
    return Object.values(PRESETS)
  }

  custom(): Record<string, CustomAgent> {
    return structuredClone(this.customAgents)
  }

  instances(): AgentConfig[] {
    return this.list.map((cfg) => ({ ...cfg }))
  }

  hasInstances(): boolean {
    return this.list.length > 0
  }

  isKnownCli(cli: string): boolean {
    return Object.hasOwn(this.customAgents, cli) || Object.hasOwn(PRESETS, cli)
  }

  /** Adds a teammate. Returns the new config, or the reason it could not be added. */
  addInstance(cli: string, name?: string): AgentConfig | string {
    if (!this.isKnownCli(cli)) return `unknown agent "${cli}"`
    let chosen = name
    if (chosen === undefined) {
      chosen = cli
      for (let n = 2; this.list.some((c) => c.name === chosen); n++) chosen = `${cli}-${n}`
    }
    if (!isValidAgentId(chosen)) {
      return RESERVED_NAMES.includes(chosen)
        ? `"${chosen}" is reserved`
        : `"${chosen}" is not a valid name: use 2-24 lowercase letters, digits, - or _, starting with a letter`
    }
    if (this.list.some((c) => c.name === chosen)) return `an agent named "${chosen}" already exists`
    const cfg: AgentConfig = { name: chosen, cli }
    this.list.push(cfg)
    this.save()
    return { ...cfg }
  }

  removeInstance(name: string): boolean {
    const at = this.list.findIndex((c) => c.name === name)
    if (at < 0) return false
    this.list.splice(at, 1)
    this.save()
    return true
  }

  /** Forgets a custom ACP agent made with /agent add. Refuses while teammates still run it. Null = done, else the reason. */
  removeCustom(id: string): string | null {
    if (!Object.hasOwn(this.customAgents, id)) return `no custom agent "${id}"`
    if (this.list.some((c) => c.cli === id)) return `${id} still has teammates: remove them first`
    delete this.customAgents[id]
    this.states.delete(id)
    this.save()
    return null
  }

  /** Defines (or replaces) a custom ACP agent. Returns null on success, else the reason. */
  addCustom(id: string, command: string[], env?: Record<string, string>): string | null {
    if (!isValidAgentId(id)) {
      return RESERVED_NAMES.includes(id)
        ? `"${id}" is reserved`
        : `"${id}" is not a valid id: use 2-24 lowercase letters, digits, - or _, starting with a letter`
    }
    const [bin, ...args] = command
    if (bin === undefined || bin.trim() === '') return 'a command is required'
    const entry: CustomAgent = { command: bin, args }
    if (env !== undefined && Object.keys(env).length > 0) entry.env = { ...env }
    this.customAgents[id] = entry
    this.states.delete(id)
    this.save()
    return null
  }

  setModel(name: string, model: string | undefined): void {
    const cfg = this.list.find((c) => c.name === name)
    if (cfg === undefined) return
    if (model === undefined) delete cfg.model
    else cfg.model = model
    this.save()
  }

  setEffort(name: string, effort: string | undefined): void {
    const cfg = this.list.find((c) => c.name === name)
    if (cfg === undefined) return
    if (effort === undefined) delete cfg.effort
    else cfg.effort = effort
    this.save()
  }

  setColor(name: string, color: string | undefined): void {
    const cfg = this.list.find((c) => c.name === name)
    if (cfg === undefined) return
    const valid = color === undefined ? undefined : parseColor(color)
    if (valid === undefined) delete cfg.color
    else cfg.color = valid
    this.save()
  }

  readiness(cli: string): Readiness {
    return this.states.get(cli) ?? UNKNOWN
  }

  setReadiness(cli: string, r: Readiness): void {
    this.states.set(cli, r)
  }

  /** Instances whose CLI passed its readiness check, in config order. */
  ready(): AgentConfig[] {
    return this.list.filter((c) => this.readiness(c.cli).state === 'ready').map((c) => ({ ...c }))
  }

  /** How to start `cli` over ACP. A custom entry wins over a preset with the same id. */
  launchFor(cli: string): { bin: string; args: string[]; env?: Record<string, string> } | undefined {
    const custom = Object.hasOwn(this.customAgents, cli) ? this.customAgents[cli] : undefined
    if (custom !== undefined) {
      const spec: { bin: string; args: string[]; env?: Record<string, string> } = { bin: custom.command, args: [...custom.args] }
      if (custom.env !== undefined) spec.env = { ...custom.env }
      return spec
    }
    const preset = Object.hasOwn(PRESETS, cli) ? PRESETS[cli] : undefined
    return preset === undefined ? undefined : launch(preset)
  }

  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      data = undefined
    }
    if (!isRecord(data)) {
      try {
        fs.renameSync(this.file, `${this.file}.bad`)
      } catch {
        // An unreadable file we cannot move is simply overwritten by the next save.
      }
      return
    }
    if (isRecord(data['custom'])) {
      for (const [id, entry] of Object.entries(data['custom'])) {
        if (!isValidAgentId(id) || !isRecord(entry)) continue
        const command = entry['command']
        if (typeof command !== 'string' || command.trim() === '') continue
        const args = Array.isArray(entry['args']) ? entry['args'].filter((a): a is string => typeof a === 'string') : []
        const env = parseEnv(entry['env'])
        this.customAgents[id] = env === undefined ? { command, args } : { command, args, env }
      }
    }
    if (Array.isArray(data['instances'])) {
      for (const entry of data['instances']) {
        if (!isRecord(entry)) continue
        const { name, cli, model, effort, color } = entry
        if (typeof name !== 'string' || typeof cli !== 'string') continue
        if (!isValidAgentId(name) || !this.isKnownCli(cli) || this.list.some((c) => c.name === name)) continue
        const cfg: AgentConfig = { name, cli }
        if (typeof model === 'string' && model !== '') cfg.model = model
        if (typeof effort === 'string' && effort !== '') cfg.effort = effort
        const parsed = typeof color === 'string' ? parseColor(color) : undefined
        if (parsed !== undefined) cfg.color = parsed
        this.list.push(cfg)
      }
    }
    if (typeof data['review'] === 'boolean') this.reviewOn = data['review']
    if (typeof data['autoCompact'] === 'boolean') this.compactOn = data['autoCompact']
    if (typeof data['riskApproval'] === 'boolean') this.riskOn = data['riskApproval']
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    const body = { custom: this.customAgents, instances: this.list, review: this.reviewOn, autoCompact: this.compactOn, riskApproval: this.riskOn }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
      fs.renameSync(tmp, this.file)
      this.saveError = undefined
    } catch (err) {
      this.saveError = err instanceof Error ? err.message : String(err)
    }
  }
}
