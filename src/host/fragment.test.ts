import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFragment } from './fragment.js'
import { contextMenuAdd, contextMenuRemove } from './registry.js'
import { passArgs, wtArgs } from './wt.js'

const frag = buildFragment({ node: 'C:\\n\\node.exe', cli: 'C:\\p\\cli.js' })

test('both profiles use a defined scheme with all 16 colours', () => {
  const scheme = frag.schemes[0] as Record<string, string>
  for (const p of frag.profiles) assert.equal(p.colorScheme, scheme.name)
  const colors = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white']
  for (const c of [...colors, ...colors.map((c) => `bright${c[0]!.toUpperCase()}${c.slice(1)}`), 'background', 'foreground']) assert.match(scheme[c] ?? '', /^#[0-9a-f]{6}$/, c)
})

test('the default profile is opaque black; the glass profile is translucent acrylic', () => {
  const [black, glass] = frag.profiles as [Record<string, unknown>, Record<string, unknown>]
  assert.equal(black.name, 'Pager')
  assert.equal(black.commandline, '"C:\\n\\node.exe" "C:\\p\\cli.js"')
  assert.equal(black.opacity, 100)
  assert.equal(black.useAcrylic, false)
  assert.equal(glass.name, 'Pager Glass')
  assert.equal(glass.opacity, 55)
  assert.equal(glass.useAcrylic, true)
  assert.deepEqual(black.font, { face: 'Cascadia Mono', size: 12, weight: 'normal' })
  assert.equal((frag.schemes[0] as Record<string, string>).background, '#000000')
  for (const p of [black, glass]) assert.equal('experimental.pixelShaderPath' in p, false, 'no shader: nothing hazes the glass')
  assert.equal(buildFragment({ node: 'n', cli: 'c', opacity: 45 }).profiles[1]?.opacity, 45)
})

test('passArgs and wtArgs: words, cwd, glass, and ; escaping', () => {
  assert.deepEqual(passArgs({}), [])
  assert.deepEqual(passArgs({ words: [] }), [])
  assert.deepEqual(passArgs({ cwd: 'd' }), ['run', '--cwd', 'd'])
  assert.deepEqual(passArgs({ cwd: 'd', words: ['echo', 'hi'] }), ['run', '--cwd', 'd', '--', 'echo', 'hi'])
  assert.deepEqual(wtArgs({ node: 'n', cli: 'c' }), ['-w', 'pager', 'new-tab', '--title', 'pager', '-p', 'Pager', 'n', 'c'])
  assert.deepEqual(wtArgs({ node: 'n', cli: 'c', glass: true, cwd: 'C:\\w', words: ['a;b'] }), ['-w', 'pager', 'new-tab', '--title', 'pager', '-p', 'Pager Glass', '-d', 'C:\\w', 'n', 'c', 'run', '--cwd', 'C:\\w', '--', 'a\\;b'])
})

test('registry builders produce exact reg.exe argument lists', () => {
  const add = contextMenuAdd({ launch: '"C:\\x\\Pager.exe"', icon: 'C:\\i.ico' })
  assert.equal(add.length, 6)
  assert.deepEqual(add[2], ['add', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pager\\command', '/ve', '/d', '"C:\\x\\Pager.exe" --cwd "%V"', '/f'])
  assert.deepEqual(add[5], ['add', 'HKCU\\Software\\Classes\\Directory\\shell\\Pager\\command', '/ve', '/d', '"C:\\x\\Pager.exe" --cwd "%1"', '/f'])
  assert.deepEqual(add[1], ['add', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pager', '/v', 'Icon', '/t', 'REG_SZ', '/d', 'C:\\i.ico', '/f'])
  assert.deepEqual(contextMenuRemove(), [
    ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pager', '/f'],
    ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Pager', '/f'],
  ])
})
