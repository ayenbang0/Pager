import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveShell } from './shell.js'

const have = (...bins: string[]) => async (bin: string): Promise<string | undefined> => (bins.includes(bin) ? `/x/${bin}` : undefined)

test('windows prefers pwsh, then powershell, then ComSpec', async () => {
  const a = await resolveShell({}, 'win32', '/d', have('pwsh', 'powershell'))
  assert.equal(a.label, 'pwsh')
  assert.equal(a.integrated, true)
  assert.deepEqual(a.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command'])
  assert.match(a.args[3] ?? '', /^\. '.*pwsh\.ps1'$/)
  assert.equal((await resolveShell({}, 'win32', '/d', have('powershell'))).label, 'powershell')
  const c = await resolveShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32', '/d', have())
  assert.equal(c.label, 'cmd')
  assert.equal(c.integrated, false)
  assert.deepEqual(c.args, [])
})

test('PAGER_SHELL wins, by name or path', async () => {
  assert.equal((await resolveShell({ PAGER_SHELL: 'fish' }, 'win32', '/d', have('pwsh', 'fish'))).file, '/x/fish')
  const s = await resolveShell({ PAGER_SHELL: '/opt/zsh' }, 'linux', '/d', have())
  assert.equal(s.file, '/opt/zsh')
  assert.equal(s.label, 'zsh')
})

test('zsh gets a ZDOTDIR and remembers the real one', async () => {
  const s = await resolveShell({ SHELL: '/bin/zsh', ZDOTDIR: '/home/u/z', HOME: '/home/u' }, 'linux', '/d', have())
  assert.equal(s.env.PAGER_ZDOTDIR, '/home/u/z')
  assert.match(s.env.ZDOTDIR ?? '', /zsh$/)
  assert.equal((await resolveShell({ SHELL: '/bin/zsh', HOME: '/home/u' }, 'linux', '/d', have())).env.PAGER_ZDOTDIR, '/home/u')
})

test('bash loads its rcfile; unknown shells are plain', async () => {
  const b = await resolveShell({ SHELL: '/usr/bin/bash' }, 'linux', '/d', have())
  assert.equal(b.args[0], '--rcfile')
  assert.equal(b.args.at(-1), '-i')
  const k = await resolveShell({ SHELL: '/usr/bin/ksh' }, 'linux', '/d', have())
  assert.equal(k.label, 'sh')
  assert.equal(k.integrated, false)
  assert.equal((await resolveShell({}, 'linux', '/d', have())).file, '/bin/sh')
})

test('quotes in the shell dir are escaped for pwsh', async () => {
  const s = await resolveShell({}, 'win32', "C:\\it's", have('pwsh'))
  assert.match(s.args[3] ?? '', /it''s/)
})
