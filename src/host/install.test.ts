import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import type { ControlRequest, SendResult } from '../app/control.js'
import { install, type InstallOptions } from './install.js'
import type { ExecResult, InstallIo } from './io.js'
import { launch, type LaunchIo } from './launch.js'
import { status } from './status.js'
import { uninstall } from './uninstall.js'

const env = { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\A', USERPROFILE: 'C:\\U', SystemRoot: 'C:\\W' }
const WT = 'C:\\L\\Microsoft\\WindowsApps\\wt.exe'
const CONHOST = 'C:\\W\\System32\\conhost.exe'

interface Fake extends InstallIo {
  log: string[]
  files: Map<string, string>
  existing: Set<string>
  execs: { file: string; args: string[]; env?: Record<string, string> }[]
  powershell: number
  reg: number
  self: { ok: boolean; reason?: string }
}

function fake(over: Partial<Pick<Fake, 'powershell' | 'reg' | 'self'>> = {}, platform: NodeJS.Platform = 'win32'): Fake {
  const f: Fake = {
    platform,
    env,
    log: [],
    files: new Map(),
    existing: new Set([WT, CONHOST]),
    execs: [],
    powershell: 0,
    reg: 0,
    self: { ok: false, reason: 'cannot start: UNKNOWN' },
    ...over,
    exists: (p) => f.existing.has(p) || f.files.has(p),
    read: (p) => f.files.get(p),
    mkdir() {},
    write(p, data) {
      f.log.push(`write ${p}`)
      f.files.set(p, data)
    },
    copy(a, b) {
      f.log.push(`copy ${path.basename(a)} -> ${b}`)
      f.files.set(b, '')
    },
    remove(p) {
      f.log.push(`remove ${p}`)
      f.files.delete(p)
    },
    async exec(file, args, e): Promise<ExecResult> {
      f.execs.push({ file, args, ...(e === undefined ? {} : { env: e }) })
      return { code: file === 'powershell.exe' ? f.powershell : f.reg, out: 'denied' }
    },
    selftest: async () => f.self,
  }
  return f
}

const opts: InstallOptions = { node: 'C:\\n\\node.exe', cli: 'C:\\p\\dist\\cli.js', assetsDir: 'C:\\p\\desktop', dataDir: 'C:\\D', exe: 'C:\\P\\Pager.exe' }
const shortcutEnv = (f: Fake) => f.execs.find((e) => e.file === 'powershell.exe')?.env

test('install with an exe that cannot start uses Windows Terminal, via conhost, and records it', async () => {
  const f = fake()
  const r = await install(opts, f)
  assert.equal(r.host, 'wt')
  assert.match(r.note ?? '', /Pager\.exe: cannot start: UNKNOWN; using Windows Terminal/)
  assert.equal(r.shortcut, 'lnk')
  assert.equal(shortcutEnv(f)?.PAGER_TARGET, CONHOST)
  assert.equal(shortcutEnv(f)?.PAGER_ARGS, '--headless "C:\\n\\node.exe" "C:\\p\\dist\\cli.js" desktop launch')
  assert.equal(shortcutEnv(f)?.PAGER_STYLE, '1')
  const menu = f.execs.filter((e) => e.file === 'reg.exe').map((e) => e.args.join(' '))
  assert.ok(menu.some((a) => a.includes('conhost.exe" --headless') && a.endsWith('desktop launch --cwd "%V" /f')), menu.join('\n'))
  assert.deepEqual(JSON.parse(f.files.get('C:\\D\\desktop-host.json') ?? ''), { host: 'wt' })
  const frag = JSON.parse(f.files.get('C:\\L\\Microsoft\\Windows Terminal\\Fragments\\Pager\\pager.json') ?? '{}') as { profiles: { name: string }[] }
  assert.deepEqual(frag.profiles.map((p) => p.name), ['Pager', 'Pager Solid'])
  assert.ok(f.log.some((l) => l.startsWith('copy pager.ico -> C:\\L\\Microsoft\\Windows Terminal\\Fragments\\Pager\\pager.ico')))
})

test('install with a working exe targets the exe directly', async () => {
  const f = fake({ self: { ok: true } })
  const r = await install(opts, f)
  assert.equal(r.host, 'exe')
  assert.equal(r.note, undefined)
  assert.equal(shortcutEnv(f)?.PAGER_TARGET, 'C:\\P\\Pager.exe')
  assert.equal(shortcutEnv(f)?.PAGER_ARGS, '')
  assert.ok(f.execs.some((e) => e.args.includes('"C:\\P\\Pager.exe" --cwd "%1"')))
  assert.deepEqual(JSON.parse(f.files.get('C:\\D\\desktop-host.json') ?? ''), { host: 'exe', exe: 'C:\\P\\Pager.exe' })
})

test('without conhost the shortcut starts node minimized', async () => {
  const f = fake()
  f.existing.delete(CONHOST)
  await install({ ...opts, exe: undefined }, f)
  assert.equal(shortcutEnv(f)?.PAGER_TARGET, 'C:\\n\\node.exe')
  assert.equal(shortcutEnv(f)?.PAGER_STYLE, '7')
})

test('a failing PowerShell falls back to a .cmd file; a failing registry write aborts with its message', async () => {
  const f = fake({ powershell: 1 })
  const r = await install({ ...opts, exe: undefined }, f)
  assert.equal(r.shortcut, 'cmd')
  assert.equal(r.shortcutPath, 'C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\Pager.cmd')
  assert.match(f.files.get(r.shortcutPath) ?? '', /^@echo off\r\nstart "" "C:\\W\\System32\\conhost\.exe" --headless/)

  const g = fake({ reg: 1 })
  await assert.rejects(install({ ...opts, exe: undefined }, g), /context menu: denied/)
})

test('running install twice gives the same report and does not throw', async () => {
  const f = fake()
  const a = await install(opts, f)
  const b = await install(opts, f)
  assert.deepEqual(b, a)
})

test('install needs Windows and Windows Terminal', async () => {
  await assert.rejects(install(opts, fake({}, 'linux')), /Windows only/)
  const f = fake()
  f.existing.delete(WT)
  await assert.rejects(install(opts, f), /Windows Terminal is not installed \(Microsoft Store: 9N0DX20HK701\)/)
  assert.equal(f.execs.length, 0, 'nothing was changed')
})

test('uninstall removes files, the menu and the font, and tolerates keys that are already gone', async () => {
  const f = fake({ reg: 1 })
  await install(opts, fake())
  const problems = await uninstall('C:\\D', f)
  assert.deepEqual(problems, [])
  const removed = f.log.filter((l) => l.startsWith('remove ')).join('\n')
  for (const part of ['Fragments\\Pager', 'Pager.lnk', 'Pager.cmd', 'desktop-host.json']) assert.ok(removed.includes(part), part)
  assert.equal(f.execs.filter((e) => e.args[0] === 'delete').length, 2)
  f.remove = () => {
    throw new Error('EBUSY')
  }
  assert.equal((await uninstall('C:\\D', f)).length, 4)
})

test('status lists every piece', async () => {
  const f = fake()
  const lines = await status('C:\\D', f)
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['windows terminal', 'host', 'fragment', 'shortcut', 'context menu', 'record'])
  await install(opts, f)
  const after = await status('C:\\D', f)
  assert.ok(after.includes('host: wt'))
})

function launchIo(o: { live: boolean; host?: string; exeExists?: boolean }): { io: LaunchIo; sent: ControlRequest[]; spawned: string[][] } {
  const sent: ControlRequest[] = []
  const spawned: string[][] = []
  const io: LaunchIo = {
    send: async (req): Promise<SendResult> => {
      sent.push(req)
      return o.live ? { kind: 'ok', reply: { ok: true, pid: 1 } } : { kind: 'none' }
    },
    spawnDetached: async (file, args) => {
      spawned.push([file, ...args])
    },
    exists: () => o.exeExists ?? false,
    read: () => o.host,
    print() {},
    wt: WT,
  }
  return { io, sent, spawned }
}
const lo = { node: 'n', cli: 'c', dataDir: 'C:\\D' }

test('launch: a live pager gets the request over the control pipe, no new window', async () => {
  const { io, sent, spawned } = launchIo({ live: true })
  assert.equal(await launch({ ...lo, cwd: 'C:\\w', words: ['echo', 'hi'] }, io), 0)
  assert.deepEqual(sent, [{ type: 'ping' }, { type: 'run', cwd: 'C:\\w', command: 'echo hi' }])
  assert.deepEqual(spawned.map((s) => s.slice(0, 4)), [[WT, '-w', 'pager', 'focus-tab']])
})

test('launch: no live pager starts a wt window; the exe host spawns the exe, which forwards requests itself', async () => {
  const wt = launchIo({ live: false })
  await launch({ ...lo, words: ['dir'] }, wt.io)
  assert.deepEqual(wt.spawned, [[WT, '-w', 'pager', 'new-tab', '--title', 'pager', '-p', 'Pager', 'n', 'c', 'run', '--', 'dir']])

  const exe = launchIo({ live: true, host: JSON.stringify({ host: 'exe', exe: 'C:\\P\\Pager.exe' }), exeExists: true })
  await launch({ ...lo, cwd: 'C:\\w' }, exe.io)
  assert.deepEqual(exe.spawned, [['C:\\P\\Pager.exe', 'run', '--cwd', 'C:\\w']])
  assert.deepEqual(exe.sent, [])
})
