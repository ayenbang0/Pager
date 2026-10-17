import { EventEmitter } from 'node:events'
import { isRecord } from '../guards.js'

export interface QuestionOption {
  value: string
  label: string
  description?: string
}

/** One thing the user is asked. `choice` fields pick from `options`; `confirm` is yes/no; `text` is free text. */
export interface QuestionField {
  key: string
  label: string
  options: QuestionOption[]
  multi: boolean
  recommended?: string
  /** The user may type an answer of their own, reported under `${key}__other`. */
  allowOther: boolean
  kind: 'choice' | 'text' | 'confirm'
}

export interface QuestionView {
  id: string
  agent: string
  message: string
  fields: QuestionField[]
}

/** Field key -> chosen value(s). Text typed into "Other" goes under `${key}__other`. */
export type AnswerMap = Record<string, string | string[]>

const OTHER = '__other'
const YES_NO: QuestionOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
]

function scalar(x: unknown): string | undefined {
  return typeof x === 'string' || typeof x === 'number' ? String(x) : undefined
}

function optionsOf(list: unknown): QuestionOption[] {
  const out: QuestionOption[] = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    const value = isRecord(item) ? scalar(item['const']) : scalar(item)
    if (value === undefined) continue
    const opt: QuestionOption = { value, label: isRecord(item) && typeof item['title'] === 'string' ? item['title'] : value }
    if (isRecord(item) && typeof item['description'] === 'string' && item['description'] !== '') opt.description = item['description']
    out.push(opt)
  }
  return out
}

function fieldFromSchema(key: string, prop: Record<string, unknown>, allowOther: boolean): QuestionField | undefined {
  const title = typeof prop['title'] === 'string' && prop['title'] !== '' ? prop['title'] : undefined
  const description = typeof prop['description'] === 'string' && prop['description'] !== '' ? prop['description'] : undefined
  const label = title ?? description ?? key
  const base = { key, label, allowOther }
  const fallback = prop['default']
  if (prop['type'] === 'boolean') {
    const field: QuestionField = { ...base, options: structuredClone(YES_NO), multi: false, kind: 'confirm', allowOther: false }
    if (typeof fallback === 'boolean') field.recommended = String(fallback)
    return field
  }
  if (prop['type'] === 'array') {
    const items = isRecord(prop['items']) ? prop['items'] : {}
    const options = optionsOf(items['anyOf'] ?? items['oneOf'] ?? items['enum'])
    if (options.length === 0) return undefined
    const field: QuestionField = { ...base, options, multi: true, kind: 'choice' }
    const first = Array.isArray(fallback) ? scalar(fallback[0]) : undefined
    if (first !== undefined) field.recommended = first
    return field
  }
  if (prop['type'] === 'string') {
    const options = optionsOf(prop['oneOf'] ?? prop['enum'])
    if (options.length === 0) return { ...base, options: [], multi: false, kind: 'text', allowOther: false }
    const field: QuestionField = { ...base, options, multi: false, kind: 'choice' }
    const chosen = scalar(fallback)
    if (chosen !== undefined && options.some((o) => o.value === chosen)) field.recommended = chosen
    return field
  }
  return undefined
}

/**
 * Maps the `elicitation/create` form an agent sends (omp's schemas) to fields the picker can show.
 * A property `${key}__other` is folded into `key` as `allowOther`. Returns undefined when nothing is askable.
 */
export function fieldsFromElicitation(params: Record<string, unknown>): { message: string; fields: QuestionField[] } | undefined {
  const schema = params['requestedSchema']
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : undefined
  if (props === undefined) return undefined
  const fields: QuestionField[] = []
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue
    if (key.endsWith(OTHER) && key.length > OTHER.length && isRecord(props[key.slice(0, -OTHER.length)])) continue
    const field = fieldFromSchema(key, prop, isRecord(props[`${key}${OTHER}`]))
    if (field !== undefined) fields.push(field)
  }
  if (fields.length === 0) return undefined
  return { message: typeof params['message'] === 'string' ? params['message'] : '', fields }
}

function listOf(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/** The `content` of the elicitation response: typed per field (boolean, string[], string). Unanswered fields are left out. */
export function contentFromAnswers(fields: QuestionField[], answers: AnswerMap): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const field of fields) {
    const given = answers[field.key]
    if (given !== undefined) {
      const [first] = listOf(given)
      if (field.kind === 'confirm') content[field.key] = first === 'true'
      else if (field.multi) content[field.key] = listOf(given)
      else content[field.key] = first ?? ''
    }
    const other = answers[`${field.key}${OTHER}`]
    if (field.allowOther && typeof other === 'string' && other !== '') content[`${field.key}${OTHER}`] = other
  }
  return content
}

/** The fields for the `ask_user` tool: keys q0, q1… and the option text is also its value. */
export function fieldsFromAskUser(questions: { question: string; options: string[]; multi?: boolean; recommended?: number }[]): QuestionField[] {
  return questions.map((q, i) => {
    const field: QuestionField = {
      key: `q${i}`,
      label: q.question,
      options: q.options.map((o) => ({ value: o, label: o })),
      multi: q.multi === true,
      allowOther: true,
      kind: 'choice',
    }
    const pick = q.recommended === undefined ? undefined : q.options[q.recommended]
    if (pick !== undefined) field.recommended = pick
    return field
  })
}

/** What the `ask_user` tool returns to the agent. */
export function askUserResult(
  fields: QuestionField[],
  answers: AnswerMap | null,
): { answers: { question: string; selected: string[]; other?: string }[] } | { cancelled: true } {
  if (answers === null) return { cancelled: true }
  return {
    answers: fields.map((f) => {
      const out: { question: string; selected: string[]; other?: string } = { question: f.label, selected: listOf(answers[f.key]) }
      const other = answers[`${f.key}${OTHER}`]
      if (typeof other === 'string' && other !== '') out.other = other
      return out
    }),
  }
}

interface Pending {
  id: string
  agent: string
  message: string
  fields: QuestionField[]
  seq: number
  settle: (answers: AnswerMap | null) => void
}

/**
 * Questions agents have for the user. Each agent has one visible question at a time; the next one
 * appears when the previous is answered or cancelled. Emits 'change' whenever the visible set may differ.
 */
export class Questions extends EventEmitter {
  private readonly queues = new Map<string, Pending[]>()
  private seq = 0

  ask(agent: string, message: string, fields: QuestionField[]): Promise<AnswerMap | null> {
    const done = Promise.withResolvers<AnswerMap | null>()
    const seq = ++this.seq
    const entry: Pending = { id: `q${seq}`, agent, message, fields, seq, settle: done.resolve }
    const queue = this.queues.get(agent)
    if (queue === undefined) this.queues.set(agent, [entry])
    else queue.push(entry)
    this.emit('change')
    if (queue === undefined) this.announce(entry)
    return done.promise
  }

  /** Tells listeners (toast, bell) that `entry` is now the question the user sees for its agent. */
  private announce(entry: Pending): void {
    this.emit('asked', { id: entry.id, agent: entry.agent, message: entry.message, fields: entry.fields } satisfies QuestionView)
  }

  /** The question each agent currently has open, oldest first. */
  views(): QuestionView[] {
    return [...this.queues.values()]
      .flatMap((queue) => queue.slice(0, 1))
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({ id: p.id, agent: p.agent, message: p.message, fields: p.fields }))
  }

  /** Answers a visible question (null cancels it). False when the id is unknown or still waiting behind another. */
  answer(id: string, answers: AnswerMap | null): boolean {
    for (const [agent, queue] of this.queues) {
      const head = queue[0]
      if (head?.id !== id) continue
      queue.shift()
      if (queue.length === 0) this.queues.delete(agent)
      head.settle(answers)
      this.emit('change')
      const next = queue[0]
      if (next !== undefined) this.announce(next)
      return true
    }
    return false
  }

  /** Cancels everything one agent has pending, e.g. when its turn is stopped. */
  cancelAgent(agent: string): void {
    const queue = this.queues.get(agent)
    if (queue === undefined) return
    this.queues.delete(agent)
    for (const entry of queue) entry.settle(null)
    this.emit('change')
  }

  pendingFor(agent: string): number {
    return this.queues.get(agent)?.length ?? 0
  }
}
