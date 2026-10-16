import type { AgentName } from './adapters.js'

export const TASK_MARKER = '--- TASK ---'
export const REPLIES_MARKER = '--- REPLIES ---'
export const EARLIER_MARKER = '--- YOUR EARLIER REPLY ---'
export const MAX_ASKS_PER_RUN = 3
export const REQUEST_MAX_CHARS = 8000
export const CONTEXT_MESSAGES = 40
export const CONTEXT_MESSAGE_CHARS = 4000
export const PROMPT_MAX_CHARS = 60_000

export interface Ask {
  agent: string
  request: string
}

const ASK_BLOCK = /^[ \t]*@@ask[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*@@end[ \t]*$/gm

/** Extracts `@@ask <agent>` blocks. Only the first MAX_ASKS_PER_RUN are returned; all matched blocks leave `clean`. */
export function parseAsks(text: string): { clean: string; asks: Ask[] } {
  const asks: Ask[] = []
  const clean = text
    .replace(ASK_BLOCK, (_m, agent: string, request: string) => {
      const body = request.trim().slice(0, REQUEST_MAX_CHARS)
      if (body !== '' && asks.length < MAX_ASKS_PER_RUN) asks.push({ agent: agent.toLowerCase(), request: body })
      return ''
    })
    .trim()
  return { clean, asks }
}

const preamble = (agent: string, peers: string, branch: string): string =>
  [
    `You are "${agent}", one of several coding agents (${peers}) collaborating through pager. You work alone in an isolated git worktree on branch ${branch}; nobody else edits your files. Your edits are committed automatically when you finish, and later agents in this task continue from your commit.`,
    'To delegate work to another agent, end your reply with one or more blocks, exactly:',
    '@@ask <agent>',
    '<request text>',
    '@@end',
    'Each request runs after you finish, in order, on top of your commit; you are then resumed with every reply and with your own earlier reply. Ask only agents from the list above, never yourself. Delegate when another agent is better placed (a second opinion or review, a different model, a separate part of the work); do the work yourself otherwise. Do not run git commands that change branches or the worktree location.',
    'The ROOM section below is the shared transcript of this session, including what the other agents said and which files they changed. Treat it as your memory.',
  ].join('\n')

export function buildPrompt(input: {
  agent: AgentName
  branch: string
  peers: AgentName[]
  room: { author: string; text: string }[]
  task: string
}): string {
  const head = preamble(input.agent, input.peers.filter((p) => p !== input.agent).join(', '), input.branch)
  const room = input.room.slice(-CONTEXT_MESSAGES).map((m) => `[${m.author}] ${m.text.slice(0, CONTEXT_MESSAGE_CHARS)}`)
  const assemble = (task: string): string => [head, '--- ROOM ---', ...room, TASK_MARKER, task].join('\n')
  let prompt = assemble(input.task)
  while (prompt.length > PROMPT_MAX_CHARS && room.length > 0) {
    room.shift()
    prompt = assemble(input.task)
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    const suffix = '\n[truncated]'
    const overflow = prompt.length - PROMPT_MAX_CHARS + suffix.length
    prompt = assemble(input.task.slice(0, Math.max(0, input.task.length - overflow)) + suffix)
  }
  return prompt
}

export function withReplies(task: string, replies: { run: string; text: string }[], earlier = ''): string {
  const joined = `${task}\n\n${REPLIES_MARKER}\n${replies.map((r) => `[${r.run}] ${r.text}`).join('\n\n')}`
  return earlier === '' ? joined : `${joined}\n\n${EARLIER_MARKER}\n${earlier}`
}

/** Splits a command line into arguments; single or double quotes group words, backslashes stay literal. */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur !== '') out.push(cur)
      cur = ''
      started = false
    } else cur += ch
  }
  if (started || cur !== '') out.push(cur)
  return out
}
