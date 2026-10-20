import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { SHELL_FILES, writeShellFiles } from './integration.js'
import { resolveShell } from './shell.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

after(removeTmpDirs)

test('every script a shell spec references exists in SHELL_FILES', async () => {
  const find = async (): Promise<undefined> => undefined
  const dir = '/d'
  const refs = new Map([
    ['bash', 'bash.sh'],
    ['zsh', 'zsh'],
    ['fish', 'fish.fish'],
    ['pwsh', 'pwsh.ps1'],
  ])
  for (const [shell, file] of refs) {
    const spec = await resolveShell({ PAGER_SHELL: `/x/${shell}` }, 'linux', dir, find)
    const text = [...spec.args, ...Object.values(spec.env)].join(' ').replaceAll('\\', '/')
    assert.ok(text.includes(path.join(dir, file).replaceAll('\\', '/')), shell)
    assert.ok(Object.keys(SHELL_FILES).some((k) => k === file || k.startsWith(`${file}/`)), file)
  }
})

test('scripts contain real escapes and interpolation, not template leftovers', () => {
  assert.match(SHELL_FILES['bash.sh'] ?? '', /\\e\]133;D;%s\\a/)
  assert.match(SHELL_FILES['bash.sh'] ?? '', /\$\{PROMPT_COMMAND:\+;\$PROMPT_COMMAND\}/)
  for (const s of Object.values(SHELL_FILES)) assert.ok(s.includes('133;A') && s.includes('133;B') && s.includes('133;C'.slice(0, 5)))
})

test('writeShellFiles creates the files and then rewrites nothing', () => {
  const dir = tmpDir('pager-shell-')
  writeShellFiles(dir)
  const file = path.join(dir, 'zsh', '.zshrc')
  assert.equal(fs.readFileSync(file, 'utf8'), SHELL_FILES['zsh/.zshrc'])
  const before = fs.statSync(file).mtimeMs
  const past = new Date(before - 60_000)
  fs.utimesSync(file, past, past)
  writeShellFiles(dir)
  assert.equal(fs.statSync(file).mtimeMs, past.getTime())
})
