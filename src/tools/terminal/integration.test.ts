import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { SHELL_FILES, writeShellFiles } from './integration.js'
import { resolveShell } from './shell.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

after(removeTmpDirs)

const norm = (s: string): string => s.replaceAll('\\', '/').replaceAll('//', '/')

test('every script a shell spec references exists in SHELL_FILES', async () => {
  const find = async (): Promise<undefined> => undefined
  const dir = '/d'
  const refs: Record<string, string> = { bash: 'bash.sh', zsh: 'zsh', fish: 'fish.fish', pwsh: 'pwsh.ps1' }
  for (const [shell, file] of Object.entries(refs)) {
    const spec = await resolveShell({ PAGER_SHELL: `/x/${shell}` }, 'linux', dir, find)
    const text = norm([...spec.args, ...Object.values(spec.env)].join(' '))
    assert.ok(text.includes(norm(path.join(dir, file))), shell)
    assert.ok(Object.keys(SHELL_FILES).some((k) => k === file || k.startsWith(`${file}/`)), file)
  }
})

test('scripts contain real escapes and interpolation, not template leftovers', () => {
  assert.match(SHELL_FILES['bash.sh'] ?? '', /\\e\]133;D;%s\\a/)
  assert.match(SHELL_FILES['bash.sh'] ?? '', /\$\{PROMPT_COMMAND:\+;\$PROMPT_COMMAND\}/)
  for (const [name, s] of Object.entries(SHELL_FILES)) if (name !== 'zsh/.zshenv') assert.ok(s.includes('133;A') && s.includes('133;B'), name)
})

test('writeShellFiles creates the files and then rewrites nothing', () => {
  const dir = tmpDir('pager-shell-')
  writeShellFiles(dir)
  const file = path.join(dir, 'zsh', '.zshrc')
  assert.equal(fs.readFileSync(file, 'utf8'), SHELL_FILES['zsh/.zshrc'])
  const past = new Date(fs.statSync(file).mtimeMs - 60_000)
  fs.utimesSync(file, past, past)
  writeShellFiles(dir)
  assert.equal(fs.statSync(file).mtimeMs, past.getTime())
})
