import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { findBinary } from '../../agents/run/adapters.js'
import type { CommandBlock } from './blocks.js'
import { writeShellFiles } from './integration.js'
import { PtySession } from './pty.js'
import { resolveShell } from './shell.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

after(removeTmpDirs)

const win = process.platform === 'win32'

async function open(t: TestContext): Promise<PtySession | undefined> {
  const bin = win ? ((await findBinary('pwsh')) ?? (await findBinary('powershell'))) : await findBinary('bash')
  if (bin === undefined) {
    t.skip(`${win ? 'powershell' : 'bash'} not installed`)
    return undefined
  }
  const dir = tmpDir('pager-pty-')
  writeShellFiles(path.join(dir, 'shell'))
  const shell = await resolveShell({ PAGER_SHELL: bin }, process.platform, path.join(dir, 'shell'))
  const s = await PtySession.start({ cwd: fs.realpathSync(dir), cols: 80, rows: 24, shell, env: process.env })
  t.after(() => s.kill())
  return s
}

const next = (s: PtySession): Promise<CommandBlock> => {
  const { promise, resolve } = Promise.withResolvers<CommandBlock>()
  s.once('finished', resolve)
  return promise
}

/** Polls a PTY-driven condition; the shell is a real child process, so there is no event to await for these. */
const until = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  for (let waited = 0; !cond() && waited < ms; waited += 50) await new Promise<void>((r) => setTimeout(r, 50))
}

test('runs commands, records exit codes and output, resizes, and interrupts', async (t) => {
  const s = await open(t)
  if (s === undefined) return
  await until(() => s.blocks.seen())
  assert.equal(s.blocks.seen(), true, 'shell emitted OSC 133 marks')

  const ok = next(s)
  s.write('echo pager-ok\r')
  const b = await ok
  assert.equal(b.exit, 0)
  assert.match(s.blocks.text(b.id), /pager-ok/)

  const bad = next(s)
  s.write(win ? 'cmd /c exit 3\r' : 'sh -c "exit 3"\r')
  assert.equal((await bad).exit, 3)

  s.resize(100, 30)
  const size = next(s)
  s.write(win ? '$Host.UI.RawUI.WindowSize.Width\r' : 'stty size\r')
  const sz = await size
  assert.match(s.blocks.text(sz.id), win ? /\b100\b/ : /30 100/)

  const slow = next(s)
  s.write(win ? 'Write-Output ready; Start-Sleep 30\r' : 'echo ready; sleep 30\r')
  // Ctrl+C sent before the command is executing is swallowed by the line editor: wait for its first output.
  await until(() => {
    const r = s.blocks.running()
    return r !== undefined && s.blocks.text(r.id).includes('ready')
  })
  s.write('\x03')
  const stopped = await slow
  assert.ok((stopped.endedAt ?? 0) - stopped.startedAt < 20_000)
})
