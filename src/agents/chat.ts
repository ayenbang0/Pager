import type { ChildProcess } from 'node:child_process'
import { ADAPTERS, findBinary, type AdapterSpec } from './run/adapters.js'
import { killTree } from './run/process.js'
import { MESSAGES_MARKER } from './run/protocol.js'
import type { Registry } from './run/registry.js'
import { runOneShot } from './run/turn.js'

export interface ChatDeps {
  registry: Registry
  /** Test seam: replaces entries of ADAPTERS. */
  adapters?: Record<string, AdapterSpec>
}

export interface ChatTurn {
  /** A teammate's name (its CLI, model and effort are used). */
  agent: string
  prompt: string
  cwd: string
  signal: AbortSignal
}

export type ChatResult = { ok: true; text: string } | { ok: false; error: string }

const CHAT_TIMEOUT_MS = 10 * 60_000

/** One history line per entry: `you: hello`, `omp: hi`. */
export interface ChatLine {
  author: string
  text: string
}

/** The prompt of one AI-tab turn. The messages marker splits the conversation so far from the new message. */
export function buildChatPrompt(input: { agent: string; user: string; cwd: string; history: readonly ChatLine[]; message: string }): string {
  return [
    `You are "${input.agent}". You are chatting with ${input.user} through pager's AI tab. Reply in Markdown. There is no git repository; your working directory ${input.cwd} is a scratch folder you may use for files and commands.`,
    '--- CHAT ---',
    ...input.history.map((l) => `${l.author}: ${l.text}`),
    MESSAGES_MARKER,
    input.message,
  ].join('\n')
}

/**
 * One headless run of a teammate's CLI for the AI tab: no ACP, no tool server, no git, no board or memory. The reply arrives whole.
 * It mirrors the one-shot branch of an agent turn (same environment scrub, same model and effort flags) but runs in a scratch folder.
 */
export async function runChatTurn(deps: ChatDeps, turn: ChatTurn): Promise<ChatResult> {
  const cfg = deps.registry.instances().find((c) => c.name === turn.agent)
  if (cfg === undefined) return { ok: false, error: `${turn.agent} is not a teammate` }
  const spec = { ...ADAPTERS, ...deps.adapters }[cfg.cli]
  if (spec?.args === undefined) return { ok: false, error: `${cfg.cli} has no headless mode here` }
  const bin = await findBinary(spec.bin)
  if (bin === undefined) return { ok: false, error: `${spec.bin} was not found on PATH` }
  if (/\.(cmd|bat)$/i.test(bin)) return { ok: false, error: `${spec.bin} resolves to a .cmd shim; install its native binary` }
  let child: ChildProcess | undefined
  const stop = (): void => {
    if (child !== undefined) killTree(child)
  }
  turn.signal.addEventListener('abort', stop, { once: true })
  try {
    const reply = await runOneShot({
      bin,
      spec,
      prompt: turn.prompt,
      cwd: turn.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
      want: { model: cfg.model, effort: cfg.effort },
      timeoutMs: CHAT_TIMEOUT_MS,
      isCancelled: () => turn.signal.aborted,
      onChild: (c) => {
        child = c
      },
      timeoutReason: () => `no answer within ${CHAT_TIMEOUT_MS / 60_000} minutes`,
    })
    if (reply.kind === 'cancelled') return { ok: false, error: 'stopped' }
    if (reply.kind === 'failed') return { ok: false, error: reply.reason }
    if (reply.kind === 'text') return { ok: true, text: reply.text }
    return { ok: false, error: 'the agent sent no reply' }
  } finally {
    turn.signal.removeEventListener('abort', stop)
  }
}
