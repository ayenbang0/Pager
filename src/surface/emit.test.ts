import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { buildSurface, imageMime, parseShowArgs, renderShow, runShow, type ShowArgs, type ShowIo } from './emit.js'
import { decodeOsc, MAX_PAYLOAD_BYTES, rowsOf, type Checked } from './protocol.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function io(stdin: Buffer | null = null, tty = false): ShowIo & { out: string; err: string } {
  const r = { out: '', err: '' } as ShowIo & { out: string; err: string }
  r.stdin = Object.assign(Readable.from(stdin === null ? [] : [stdin]), { isTTY: tty })
  r.write = async (t) => void (r.out += t)
  r.error = (t) => void (r.err += t)
  return r
}

/** Pull the one surface sequence and the trailing line feeds out of what `pager show` printed. */
function parseOutput(out: string): { msg: Checked; feeds: number } {
  const m = /^\x1b\]7777;(.*?)\x1b\\((?:\r\n)*)$/s.exec(out)
  assert.ok(m, 'one sequence then line feeds')
  const r = decodeOsc(m[1]!)
  assert.ok(r)
  return { msg: r, feeds: m[2]!.length / 2 }
}

test('parseShowArgs', () => {
  assert.deepEqual(parseShowArgs(['diff', 'a.patch']), { kind: 'diff', input: 'a.patch' })
  assert.deepEqual(parseShowArgs(['math', '-']), { kind: 'math', input: '-' })
  assert.deepEqual(parseShowArgs(['image', 'x.png', '--title', 'T', '--id', 'i1', '--height', '12']), { kind: 'image', input: 'x.png', title: 'T', id: 'i1', height: 12 })
  assert.deepEqual(parseShowArgs(['mermaid', '--height', '9', 'g.mmd']), { kind: 'mermaid', input: 'g.mmd', height: 9 })
  for (const bad of [[], ['html-sandbox', 'x'], ['diff'], ['diff', 'a', 'b'], ['diff', 'a', '--wat'], ['diff', 'a', '--height'], ['diff', 'a', '--height', '0'], ['diff', 'a', '--height', '61'], ['diff', 'a', '--height', 'x']]) {
    assert.ok('error' in parseShowArgs(bad), bad.join(' '))
  }
})

test('imageMime reads magic bytes', () => {
  assert.equal(imageMime(PNG), 'png')
  assert.equal(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), 'jpeg')
  assert.equal(imageMime(Buffer.from('GIF87a')), 'gif')
  assert.equal(imageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp')
  assert.equal(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined)
  assert.equal(imageMime(Buffer.alloc(0)), undefined)
})

test('buildSurface: text kinds, BOM, binary and empty input', () => {
  const m = buildSurface('math', Buffer.from('\uFEFFx^2', 'utf8'), { id: 'a' })
  assert.deepEqual(m, { kind: 'math', id: 'a', source: 'x^2' })
  assert.throws(() => buildSurface('diff', Buffer.from([0x40, 0x00, 0x40]), { id: 'a' }), /not text/)
  assert.throws(() => buildSurface('diff', Buffer.from([0xc3, 0x28]), { id: 'a' }), /UTF-8/)
  assert.throws(() => buildSurface('mermaid', Buffer.from('  \n'), { id: 'a' }), /empty/)
  assert.throws(() => buildSurface('image', Buffer.from('not an image'), { id: 'a' }), /png, jpeg, gif or webp/)
})

test('renderShow prints the sequence then one CRLF per covered row', () => {
  const msg = buildSurface('image', PNG, { id: 'i', height: 6 })
  const { msg: back, feeds } = parseOutput(renderShow(msg))
  assert.ok(back.ok && back.msg.kind === 'image' && back.msg.source.startsWith('data:image/png;base64,'))
  assert.equal(feeds, 6)
  assert.equal(parseOutput(renderShow(buildSurface('math', Buffer.from('x'), { id: 'm' }))).feeds, rowsOf({ kind: 'math', id: 'm', source: 'x' }))
})

test('runShow reads a file and titles it by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-show-'))
  try {
    const f = path.join(dir, 'change.patch')
    fs.writeFileSync(f, '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
    const o = io()
    const args: ShowArgs = { kind: 'diff', input: f }
    assert.equal(await runShow(args, o), 0)
    const { msg } = parseOutput(o.out)
    assert.ok(msg.ok && msg.msg.title === 'change.patch' && msg.msg.kind === 'diff' && /^diff-[0-9a-f]{8}$/.test(msg.msg.id))
    const o2 = io()
    assert.equal(await runShow({ kind: 'diff', input: f, title: 'Mine', id: 'fixed', height: 4 }, o2), 0)
    const p2 = parseOutput(o2.out)
    assert.ok(p2.msg.ok && p2.msg.msg.title === 'Mine' && p2.msg.msg.id === 'fixed' && p2.feeds === 4)
    // an image file
    const img = path.join(dir, 'p.png')
    fs.writeFileSync(img, PNG)
    const o3 = io()
    assert.equal(await runShow({ kind: 'image', input: img }, o3), 0)
    assert.ok(parseOutput(o3.out).msg.ok)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runShow reads standard input for -', async () => {
  const o = io(Buffer.from('graph TD\n A-->B\n'))
  assert.equal(await runShow({ kind: 'mermaid', input: '-' }, o), 0)
  const { msg } = parseOutput(o.out)
  assert.ok(msg.ok && msg.msg.source === 'graph TD\n A-->B\n' && msg.msg.title === undefined)
})

test('runShow failures exit 1 with a message and print nothing', async () => {
  const tty = io(null, true)
  assert.equal(await runShow({ kind: 'math', input: '-' }, tty), 1)
  assert.match(tty.err, /pipe something/)
  const missing = io()
  assert.equal(await runShow({ kind: 'math', input: path.join(os.tmpdir(), 'pager-no-such-file.tex') }, missing), 1)
  assert.match(missing.err, /no such file/)
  const big = io(Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61))
  assert.equal(await runShow({ kind: 'math', input: '-' }, big), 1)
  assert.match(big.err, /larger than/)
  const full = io(Buffer.alloc(MAX_PAYLOAD_BYTES, 0x61))
  assert.equal(await runShow({ kind: 'math', input: '-' }, full), 1, 'source fits but the JSON around it does not')
  assert.match(full.err, /limit/)
  for (const o of [tty, missing, big, full]) assert.equal(o.out, '')
})
