// Fake coding agent used by orchestrator and engine tests: `node testAgent.js <prompt>`.
// Task lines: WRITE f=x | APPEND f=x | ASK agent: request | ECHO text | HAS f | SLEEP ms | FAIL | LOOP agent | REMEMBER text | MEM | DOCEDIT name=text | DOCSEEN
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { DOCS_MARKER, MEMORY_MARKER, REPLIES_MARKER, TASK_MARKER } from './protocol.js'

const prompt = process.argv[2] ?? ''
const self = /You are "(\w+)"/.exec(prompt)?.[1] ?? 'unknown'
const [task = '', replyText] = (prompt.split(TASK_MARKER)[1] ?? '').split(REPLIES_MARKER)
const replies = replyText !== undefined
if (!prompt.includes(TASK_MARKER)) console.log(`raw: ${prompt}`) // verbatim slash-command prompts carry no preamble

const chainedFrom = /^\s*Another agent \((\S+)\)/.exec(task)?.[1]
if (chainedFrom !== undefined) console.log(`chained from ${chainedFrom}`)

if (process.env.TEST_AGENT_PIDFILE !== undefined) fs.appendFileSync(process.env.TEST_AGENT_PIDFILE, `${process.pid}\n`)

for (const line of task.split('\n')) {
  const [, op = '', arg = ''] = /^(\w+)\s?(.*)$/.exec(line.trim()) ?? []
  if (op === 'WRITE' || op === 'APPEND') {
    const eq = arg.indexOf('=')
    const file = arg.slice(0, eq)
    const content = arg.slice(eq + 1)
    if (op === 'WRITE') fs.writeFileSync(file, content)
    else fs.appendFileSync(file, content)
  } else if (op === 'ASK' && !replies) {
    const colon = arg.indexOf(':')
    console.log(`@@ask ${arg.slice(0, colon).trim()}\n${arg.slice(colon + 1).trim()}\n@@end`)
  } else if (op === 'LOOP' && !replies) {
    console.log(`@@ask ${arg}\nLOOP ${self}\n@@end`)
  } else if (op === 'REMEMBER') {
    console.log(`@@remember\n${arg}\n@@end`)
  } else if (op === 'DOCEDIT') {
    const eq = arg.indexOf('=')
    console.log(`@@doc ${arg.slice(0, eq)}\n${arg.slice(eq + 1)}\n@@end`)
  } else if (op === 'DOCSEEN') {
    const section = prompt.split(DOCS_MARKER)[1]?.split('--- ROOM ---')[0]
    console.log(`docs: ${[...(section ?? '').matchAll(/^## (\S+)/gm)].map((m) => m[1]).join(',') || 'none'}`)
  } else if (op === 'MEM') {
    const memory = prompt.split(MEMORY_MARKER)[1]?.split('--- ROOM ---')[0]?.trim()
    console.log(`mem: ${memory ?? 'none'}`)
  } else if (op === 'ECHO') {
    console.log(arg)
  } else if (op === 'HAS') {
    console.log(`${fs.existsSync(arg) ? 'has' : 'missing'} ${arg}`)
  } else if (op === 'SLEEP') {
    await sleep(Number(arg))
  } else if (op === 'FAIL') {
    console.error('boom')
    process.exit(3)
  }
}
if (replies) console.log(`replies: ${replyText.trim()}`)
