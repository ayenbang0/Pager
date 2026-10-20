import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type SelfTestChild = Pick<ChildProcess, 'stdout' | 'on' | 'kill'>
export type SelfTestSpawn = (file: string, args: string[], o: SpawnOptions) => SelfTestChild

/**
 * Can this executable start on this PC? Runs `exe --selftest`, which the desktop host answers with `ok`. Windows Smart
 * App Control refuses unsigned executables at process creation, which shows up here as a spawn error.
 */
export function selftest(exe: string, spawnFn: SelfTestSpawn = (f, a, o) => spawn(f, a, o), timeoutMs = 30_000): Promise<{ ok: boolean; reason?: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; reason?: string }>()
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env
  let out = ''
  let child: SelfTestChild
  const timer = setTimeout(() => {
    child.kill()
    resolve({ ok: false, reason: 'did not answer within 30 s' })
  }, timeoutMs)
  try {
    child = spawnFn(exe, ['--selftest'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (e) {
    clearTimeout(timer)
    return Promise.resolve({ ok: false, reason: `cannot start: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` })
  }
  child.stdout?.on('data', (d: Buffer | string) => (out += d.toString()))
  child.on('error', (e: NodeJS.ErrnoException) => {
    clearTimeout(timer)
    resolve({ ok: false, reason: `cannot start: ${e.code ?? e.message}` })
  })
  child.on('close', (code: number | null) => {
    clearTimeout(timer)
    resolve(code === 0 && out.includes('ok') ? { ok: true } : { ok: false, reason: `exited with code ${code ?? '?'}` })
  })
  return promise
}
