// Fake coding agent used by orchestrator and engine tests: `node testAgent.js <prompt>`.
// Message lines: WRITE f=x | APPEND f=x | ECHO text | HAS f | UNDONE | SLEEP ms | FAIL | MEM | DOCSEEN | BOARD | TOOL name {json}
// A review request (a message of kind "review") is answered with submit_review: verdict TEST_REVIEW_VERDICT (default approve).
import fs from 'node:fs'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { DOCS_MARKER, MEMORY_MARKER, MESSAGES_MARKER, ROOM_MARKER } from './protocol.js'

const prompt = process.argv[2] ?? ''
const self = /You are "([\w-]+)"/.exec(prompt)?.[1] ?? 'unknown'
const block = prompt.split(MESSAGES_MARKER)[1] ?? ''
if (!prompt.includes(MESSAGES_MARKER)) console.log(`raw: ${prompt}`) // verbatim slash-command prompts carry no preamble
const PREFIX = /^\[([^\]\s]+) (\w+)\](?: \(also sent to: [^)]*\))? ?/

const kinds = [...block.matchAll(/^\[([^\]\s]+) (\w+)\]/gm)].map((m) => m[2])
const chainedFrom = /Another agent \((\S+)\)/.exec(block)?.[1]
if (chainedFrom !== undefined) console.log(`chained from ${chainedFrom}`)

if (process.env.TEST_AGENT_PIDFILE !== undefined) fs.appendFileSync(process.env.TEST_AGENT_PIDFILE, `${process.pid}\n`)

/** One request to the pager tool server, as the MCP shim would send it. */
function callTool(tool: string, args: unknown): Promise<string> {
  const port = Number(process.env.PAGER_TOOL_PORT)
  const token = process.env.PAGER_TOOL_TOKEN ?? ''
  const { promise, resolve } = Promise.withResolvers<string>()
  const socket = net.connect(port, '127.0.0.1', () => socket.write(`${JSON.stringify({ id: 1, token, tool, args })}\n`))
  let buf = ''
  socket.on('data', (d) => {
    buf += d.toString()
    if (!buf.includes('\n')) return
    socket.end()
    const res: unknown = JSON.parse(buf.split('\n')[0] ?? '{}')
    const r = res as { ok?: boolean; result?: string; error?: string }
    resolve(r.ok === true ? `ok ${r.result}` : `error ${r.error}`)
  })
  socket.on('error', (e) => resolve(`error ${e.message}`))
  return promise
}

for (const raw of block.split('\n')) {
  const line = raw.replace(PREFIX, '').replace(/^(?:@[\w-]+\s+)+/, '').trim() // typed @mentions address the agent; they are not part of the directive
  const [, op = '', arg = ''] = /^(\w+)\s?(.*)$/.exec(line) ?? []
  if (op === 'WRITE' || op === 'APPEND') {
    const eq = arg.indexOf('=')
    const file = arg.slice(0, eq)
    const content = arg.slice(eq + 1)
    if (op === 'WRITE') fs.writeFileSync(file, content)
    else fs.appendFileSync(file, content)
  } else if (op === 'TOOL') {
    const space = arg.indexOf(' ')
    const name = space < 0 ? arg : arg.slice(0, space)
    const json = space < 0 ? '{}' : arg.slice(space + 1)
    console.log(`tool ${name}: ${await callTool(name, JSON.parse(json))}`)
  } else if (op === 'DOCSEEN') {
    const section = prompt.split(DOCS_MARKER)[1]?.split(ROOM_MARKER)[0]
    console.log(`docs: ${[...(section ?? '').matchAll(/^## (\S+)/gm)].map((m) => m[1]).join(',') || 'none'}`)
  } else if (op === 'MEM') {
    const memory = prompt.split(MEMORY_MARKER)[1]?.split(ROOM_MARKER)[0]?.trim()
    console.log(`mem: ${memory ?? 'none'}`)
  } else if (op === 'ALSO') {
    console.log(`also: ${/\(also sent to: ([^)]*)\)/.exec(block)?.[1] ?? 'none'}`)
  } else if (op === 'BOARD') {
    console.log(`board: ${prompt.split('--- BOARD ---')[1]?.split('\n--- ')[0]?.replaceAll('\n', ' | ').trim() ?? 'none'}`)
  } else if (op === 'ECHO') {
    console.log(arg)
  } else if (op === 'HAS') {
    console.log(`${fs.existsSync(arg) ? 'has' : 'missing'} ${arg}`)
  } else if (op === 'UNDONE') {
    console.log(`undo note: ${block.includes('undone by the user') ? 'told' : 'not told'}`)
  } else if (op === 'SLEEP') {
    await sleep(Number(arg))
  } else if (op === 'FAIL') {
    console.error('boom')
    process.exit(3)
  }
}
if (kinds.includes('feedback') && process.env.TEST_AGENT_FEEDBACK_WRITE === '1') fs.writeFileSync(`fix-${Date.now()}.txt`, 'fix')
const verdict = process.env.TEST_REVIEW_VERDICT ?? 'approve'
if (kinds.includes('review') && verdict !== 'none') {
  console.log(`review by ${self}: ${await callTool('submit_review', { verdict, comments: 'checked the diff' })}`)
}
