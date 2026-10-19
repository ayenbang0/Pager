// Classifies what an ACP agent asks permission for: pushes, destructive deletes, publishes, deploys, pipes into a shell and
// writes outside the agent's worktree are "risky" and go to the user; everything else stays auto-approved.
// Pure functions over the `toolCall` of a `session/request_permission` request; nothing here touches git or the network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../../util/guards.js'
import type { AnswerMap, QuestionField } from '../run/questions.js'

type Json = Record<string, unknown>

/** Tool kinds whose paths are written to; reads outside the worktree are fine. */
const WRITE_KINDS: Record<string, true> = { edit: true, delete: true, move: true }
/** Kinds whose title may be a command line (agents differ in whether they also send `rawInput`). */
const COMMAND_TITLE_KINDS: Record<string, true> = { execute: true, other: true }
const COMMAND_KEYS = ['command', 'cmd', 'script', 'commandLine', 'command_line', 'shell_command', 'shellCommand']
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'file', 'target', 'destination', 'new_path', 'newPath', 'old_path', 'oldPath', 'source', 'from', 'to']
/** Words that may precede the real command in a segment or title without making the rest "just an argument". */
const WRAPPERS: Record<string, true> = Object.fromEntries(
  ['sudo', 'doas', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'xargs', 'call', 'start', 'cmd', 'bash', 'sh', 'zsh', 'dash', 'fish', 'powershell', 'pwsh', 'wsl', 'npx', 'pnpx', 'bunx', 'dlx', 'run', 'x', 'npm', 'pnpm', 'yarn', 'bun', 'then', 'do', 'else', '!'].map((w) => [w, true]),
)
const TITLE_FLUFF = /^(?:run(?:ning)?|execute|executing|bash|shell|terminal|command|exec|powershell|cmd|\$|>)(?![\w-])[:\s-]*/i
const PROTECTED_BRANCH = /^(?:main|master|prod|production|release|releases)(?:[/-].*)?$/i
const SHELLS = '(?:(?:ba|z|da|k)?sh|pwsh|powershell|iex|invoke-expression)'
const FETCHERS = '(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)'
const FETCH_PIPES: RegExp[] = [
  new RegExp(`(?<![\\w.-])${FETCHERS}(?![\\w-])[^\\n]*\\|\\s*(?:sudo\\s+)?${SHELLS}(?![\\w-])`, 'i'),
  new RegExp(`(?<![\\w.-])(?:iex|invoke-expression)(?![\\w-])[^\\n]*(?:${FETCHERS}|downloadstring)`, 'i'),
  new RegExp(`(?<![\\w.-])(?:ba|z)?sh\\s+-c\\s+["']?\\$\\(\\s*(?:curl|wget)`, 'i'),
  new RegExp(`(?<![\\w.-])(?:ba|z)?sh\\s+<\\(\\s*(?:curl|wget)`, 'i'),
]

const isPrefix = (t: string): boolean => /^\w+=/.test(t) || Object.hasOwn(WRAPPERS, baseName(t)) || /^[-/][A-Za-z-]*$/.test(t)
const baseName = (token: string): string => (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
const isFlag = (t: string): boolean => t.startsWith('-')
const shortCluster = (t: string): string | undefined => (/^-[A-Za-z]{1,4}$/.test(t) ? t.slice(1) : undefined)

/** Flag letters/names of `-rf`, `-Recurse`, `--force` style arguments, lowercased where case does not matter. */
function recursiveForce(args: string[]): { recursive: boolean; force: boolean } {
  let recursive = false
  let force = false
  for (const a of args) {
    if (a === '--') break
    if (!isFlag(a)) continue
    const name = a.replace(/^--?/, '').replace(/[:=].*$/, '').toLowerCase()
    if (a.startsWith('--')) {
      if (name === 'recursive') recursive = true
      if (name === 'force') force = true
      continue
    }
    const cluster = shortCluster(a)
    if (cluster !== undefined) {
      if (/[rR]/.test(cluster)) recursive = true
      if (/[fF]/.test(cluster)) force = true
    } else {
      if (name.startsWith('rec')) recursive = true
      if (name === 'force') force = true
    }
  }
  return { recursive, force }
}

function gitReason(args: string[]): string | undefined {
  let i = 0
  while (i < args.length) {
    const a = args[i] ?? ''
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i += 2
    else if (isFlag(a)) i++
    else break
  }
  const sub = args[i]?.toLowerCase()
  const rest = args.slice(i + 1)
  const flags = rest.filter(isFlag)
  const plain = rest.filter((a) => !isFlag(a))
  const letters = (f: string): string => shortCluster(f) ?? ''
  switch (sub) {
    case 'push': {
      const force = flags.some((f) => /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(f) || /f/.test(letters(f))) || plain.some((a) => a.startsWith('+'))
      const destructive = flags.some((f) => f === '--mirror' || f === '--delete' || /d/.test(letters(f)))
      const target = plain
        .map((a) => (a.includes(':') ? (a.split(':').pop() ?? '') : a).replace(/^\+/, '').replace(/^refs\/heads\//, ''))
        .find((a) => PROTECTED_BRANCH.test(a))
      return `git push${force ? ' --force' : ''}${destructive ? ' (deletes remote refs)' : ''}${target === undefined ? '' : ` to ${target}`}`
    }
    case 'reset':
      return flags.includes('--hard') ? 'git reset --hard (discards uncommitted work)' : undefined
    case 'clean': {
      const dry = flags.some((f) => f === '--dry-run' || /n/.test(letters(f)))
      const force = flags.some((f) => f === '--force' || /f/.test(letters(f)))
      return force && !dry ? 'git clean -f (deletes untracked files)' : undefined
    }
    case 'checkout':
      return plain.includes('.') || flags.some((f) => f === '--force' || letters(f) === 'f') ? 'git checkout discards local changes' : undefined
    case 'restore': {
      const stagedOnly = flags.includes('--staged') && !flags.includes('--worktree')
      return plain.includes('.') && !stagedOnly ? 'git restore . discards local changes' : undefined
    }
    case 'branch': {
      const forceDelete = flags.some((f) => /D/.test(letters(f))) || (flags.some((f) => f === '--delete' || /d/.test(letters(f))) && flags.some((f) => f === '--force' || /f/.test(letters(f))))
      return forceDelete ? 'git branch -D (force-deletes a branch)' : undefined
    }
    default:
      return undefined
  }
}

/** The risk of one command (`name` is its lowercased base name) with the tokens after it. */
function commandReason(name: string, args: string[]): string | undefined {
  const nonFlag = args.filter((a) => !isFlag(a))
  switch (name) {
    case 'git':
      return gitReason(args)
    case 'rm':
    case 'remove-item':
    case 'ri': {
      const { recursive, force } = recursiveForce(args)
      return recursive && force ? `recursive force delete (${name})` : undefined
    }
    case 'del':
    case 'erase':
    case 'rd':
    case 'rmdir': {
      const { recursive, force } = recursiveForce(args)
      return args.some((a) => a.toLowerCase() === '/s') || (recursive && force) ? `recursive delete (${name})` : undefined
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const head = nonFlag.slice(0, 2)
      return head.includes('publish') && !['run', 'run-script', 'exec', 'dlx', 'x'].includes(head[0] ?? '') ? `${name} publish` : undefined
    }
    case 'cargo':
    case 'poetry':
      return nonFlag[0] === 'publish' ? `${name} publish` : undefined
    case 'twine':
      return nonFlag[0] === 'upload' ? 'twine upload' : undefined
    case 'gem':
      return nonFlag[0] === 'push' ? 'gem push' : undefined
    case 'wrangler':
      return nonFlag.some((a) => a === 'deploy' || a === 'publish') ? 'wrangler deploy' : undefined
    case 'vercel':
      return args.some((a) => a === '--prod' || a === '--production') ? 'vercel --prod deploy' : undefined
    case 'docker':
    case 'podman':
      return nonFlag.includes('push') ? `${name} push` : undefined
    case 'kubectl': {
      if (args.some((a) => a.startsWith('--dry-run'))) return undefined
      const verb = nonFlag.find((a) => a === 'apply' || a === 'delete')
      return verb === undefined ? undefined : `kubectl ${verb}`
    }
    default:
      return undefined
  }
}

/** Splits a command line into segments (`;`, `&`, `|`, newlines) and finds the commands in command position. */
function segmentReasons(commandLine: string, fluff: boolean): string[] {
  const reasons: string[] = []
  for (const segment of commandLine.split(/[;&|\r\n]+/)) {
    let text = segment.trim()
    if (fluff) while (TITLE_FLUFF.test(text)) text = text.replace(TITLE_FLUFF, '').trim()
    const tokens = text.split(/\s+/).map((t) => t.replace(/^[("'`{$]+|[)"'`};]+$/g, '')).filter((t) => t !== '')
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      if (!tokens.slice(0, i).every(isPrefix)) break
      const reason = commandReason(baseName(token), tokens.slice(i + 1))
      if (reason !== undefined) {
        reasons.push(reason)
        break
      }
    }
  }
  return reasons
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ')
  return undefined
}

/** The command lines in the tool call's input (`rawInput.command` and friends, or a bare string input). */
function commandLines(call: Json): string[] {
  const raw = call.rawInput
  if (typeof raw === 'string') return call.kind === 'execute' ? [raw] : []
  if (!isRecord(raw)) return []
  const out: string[] = []
  for (const key of COMMAND_KEYS) {
    const text = asText(raw[key])
    if (text === undefined) continue
    const args = Array.isArray(raw.args) ? asText(raw.args) : undefined
    out.push(args === undefined ? text : `${text} ${args}`)
  }
  return out
}

function realish(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    const parent = path.dirname(p)
    return parent === p ? p : path.join(realish(parent), path.basename(p))
  }
}

function outside(root: string, file: string): boolean {
  const expanded = file === '~' || /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(1)) : file
  const rel = path.relative(realish(path.resolve(root)), realish(path.resolve(root, expanded)))
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

function writtenPaths(call: Json): string[] {
  if (typeof call.kind !== 'string' || !Object.hasOwn(WRITE_KINDS, call.kind)) return []
  const found: string[] = []
  const add = (v: unknown): void => void (typeof v === 'string' && v !== '' && found.push(v))
  if (Array.isArray(call.locations)) for (const l of call.locations) if (isRecord(l)) add(l.path)
  if (Array.isArray(call.content)) for (const c of call.content) if (isRecord(c)) add(c.path)
  if (isRecord(call.rawInput)) for (const key of PATH_KEYS) add(call.rawInput[key])
  return [...new Set(found)]
}

/**
 * Why a permission request needs the user's say, or undefined when it is fine to approve. `toolCall` is the request's
 * `toolCall` (title, kind, rawInput, locations); `worktree` is the agent's working directory, used to spot writes outside it.
 * Several findings are joined with "; ".
 */
export function classifyRisk(toolCall: Json, worktree?: string): string | undefined {
  const reasons: string[] = []
  const lines = commandLines(toolCall)
  for (const line of lines) reasons.push(...segmentReasons(line, false))
  const title = typeof toolCall.title === 'string' ? toolCall.title : ''
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
  const titleIsCommand = Object.hasOwn(COMMAND_TITLE_KINDS, kind) && lines.length === 0
  if (title !== '' && titleIsCommand) reasons.push(...segmentReasons(title, true))
  for (const text of titleIsCommand ? [title] : lines) {
    if (FETCH_PIPES.some((re) => re.test(text))) reasons.push('pipes a download into a shell')
  }
  if (worktree !== undefined) {
    const away = writtenPaths(toolCall).filter((p) => outside(worktree, p))
    if (away.length > 0) reasons.push(`${kind === 'delete' ? 'deletes' : 'writes'} outside the worktree: ${away.slice(0, 3).join(', ')}${away.length > 3 ? ', …' : ''}`)
  }
  const unique = [...new Set(reasons)]
  return unique.length === 0 ? undefined : unique.join('; ')
}

const DESCRIBE_MAX = 200

/** One line saying what the agent wants to do: its command line, else the tool call's title, else the files. */
export function describeCall(toolCall: Json): string {
  const text = commandLines(toolCall)[0] ?? (typeof toolCall.title === 'string' && toolCall.title !== '' ? toolCall.title : writtenPaths(toolCall).join(', '))
  const oneLine = text.replace(/\s+/g, ' ').trim() || 'a tool call'
  return oneLine.length > DESCRIBE_MAX ? `${oneLine.slice(0, DESCRIBE_MAX - 1)}…` : oneLine
}

export type RiskDecision = 'once' | 'run' | 'deny'

/** The question put to the user for a risky permission request: one choice, deny recommended. */
export function riskQuestion(reason: string, what: string): { message: string; fields: QuestionField[] } {
  return {
    message: `${reason}: ${what}`,
    fields: [
      {
        key: 'decision',
        label: 'Allow this action?',
        options: [
          { value: 'once', label: 'Allow once' },
          { value: 'run', label: 'Allow for this run', description: 'Same kind of action is not asked again until the agent finishes this turn' },
          { value: 'deny', label: 'Deny' },
        ],
        multi: false,
        recommended: 'deny',
        allowOther: false,
        kind: 'choice',
      },
    ],
  }
}

/** The user's pick; a cancelled question, a missing answer or anything unexpected is a denial. */
export function riskDecision(answers: AnswerMap | null): RiskDecision {
  const given = answers?.decision
  const pick = Array.isArray(given) ? given[0] : given
  return pick === 'once' || pick === 'run' ? pick : 'deny'
}
