import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../util/guards.js'

export interface AiConfig {
  /** `auto` or a backend id (a ready agent's name, `ollama` or `openai`). */
  default: string
  ollama: { url: string; model: string }
  openai: { url: string; model: string; key: string }
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  default: 'auto',
  ollama: { url: 'http://127.0.0.1:11434', model: '' },
  openai: { url: 'https://api.openai.com/v1', model: '', key: '' },
}

const str = (v: unknown, fallback: string, max = 500): string => (typeof v === 'string' && v.length <= max && !/\p{Cc}/u.test(v) ? v.trim() : fallback)

/** Tolerant, field by field: a missing or damaged file yields the defaults. */
export function loadAiConfig(dir: string): AiConfig {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'))
  } catch {
    return structuredClone(DEFAULT_AI_CONFIG)
  }
  const o = isRecord(raw) ? raw : {}
  const ollama = isRecord(o.ollama) ? o.ollama : {}
  const openai = isRecord(o.openai) ? o.openai : {}
  return {
    default: str(o.default, DEFAULT_AI_CONFIG.default, 64) || 'auto',
    ollama: { url: str(ollama.url, DEFAULT_AI_CONFIG.ollama.url), model: str(ollama.model, '') },
    openai: { url: str(openai.url, DEFAULT_AI_CONFIG.openai.url), model: str(openai.model, ''), key: str(openai.key, '', 2000) },
  }
}

/** Atomic and private: the file may hold an API key. */
export function saveAiConfig(dir: string, config: AiConfig): void {
  const file = path.join(dir, 'ai.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export interface AiLock {
  key: 'ai.openai.key' | 'ai.openai.url'
  /** The environment variable that fixes the value. */
  source: string
}

/** The configuration in force: environment variables win over the file (key: PAGER_AI_KEY, then OPENAI_API_KEY; url: PAGER_AI_URL). */
export function effectiveAi(config: AiConfig, env: NodeJS.ProcessEnv): { config: AiConfig; locks: AiLock[] } {
  const locks: AiLock[] = []
  const out = structuredClone(config)
  const keySource = (['PAGER_AI_KEY', 'OPENAI_API_KEY'] as const).find((v) => (env[v] ?? '') !== '')
  if (keySource !== undefined) {
    out.openai.key = env[keySource] ?? ''
    locks.push({ key: 'ai.openai.key', source: keySource })
  }
  if ((env.PAGER_AI_URL ?? '') !== '') {
    out.openai.url = env.PAGER_AI_URL ?? ''
    locks.push({ key: 'ai.openai.url', source: 'PAGER_AI_URL' })
  }
  return { config: out, locks }
}
