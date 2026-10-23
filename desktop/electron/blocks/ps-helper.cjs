'use strict'
// A small C# program kept running by Windows PowerShell and spoken to over stdio: one request line -> one reply line.
// Used by the Task manager (process counters) and the Screen block (input injection); Windows only.
//
// The C# source is compiled once with Add-Type into a DLL cached under %LOCALAPPDATA%\Pager and later loaded from
// its bytes (a file path load is refused by Application Control policies on some machines; bytes are not).
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REQUEST_TIMEOUT = 15000 // the first request also waits for the one-off compile
const START_TIMEOUT = 60000

const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

function cacheDir(name) {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'Pager', name)
}

/** The PowerShell program that compiles (once) / loads the helper and then serves requests on stdio. */
function bootScript(cs, dll, type) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $cs = ${psq(cs)}; $dll = ${psq(dll)}`,
    '  if (-not (Test-Path -LiteralPath $dll)) {',
    "    $tmp = $dll + '.' + $PID + '.tmp'",
    '    Add-Type -Path $cs -OutputAssembly $tmp -OutputType Library',
    '    Move-Item -LiteralPath $tmp -Destination $dll -Force',
    '  }',
    '  $asm = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll))',
    `  $handle = $asm.GetType(${psq(type)}).GetMethod('Handle')`,
    '} catch {',
    "  [Console]::Out.WriteLine('{\"fatal\":\"' + (($_.Exception.Message -replace '[^\\x20-\\x7e]', '?') -replace '[\"\\\\]', \"'\") + '\"}')",
    '  exit 1',
    '}',
    '[Console]::Out.WriteLine(\'{"ready":true}\')',
    '$in = [Console]::In',
    'while (($l = $in.ReadLine()) -ne $null) { [Console]::Out.WriteLine($handle.Invoke($null, @($l))) }',
  ].join('\n')
}

class Helper {
  /** @param {{ name: string, source: string, type: string }} o  cache folder name, C# source, class with `public static string Handle(string)` */
  constructor({ name, source, type }) {
    this.name = name
    this.source = source
    this.type = type
    this.hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10)
    this.child = null
    this.ready = null
    this.queue = Promise.resolve()
    this.waiting = null // { resolve, reject, timer }
    this.onLine = null
    this.buf = ''
  }

  get pid() {
    return this.child ? this.child.pid : null
  }

  start() {
    if (this.ready) return this.ready
    if (process.platform !== 'win32') return Promise.reject(new Error('This needs Windows.'))
    const dir = cacheDir(this.name)
    fs.mkdirSync(dir, { recursive: true })
    const cs = path.join(dir, `helper-${this.hash}.cs`)
    const dll = path.join(dir, `helper-${this.hash}.dll`)
    if (!fs.existsSync(dll)) fs.writeFileSync(cs, this.source)
    const script = bootScript(cs, dll, this.type)
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.buf = ''
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    this.ready = new Promise((resolve, reject) => {
      this.onLine = (line) => {
        let j
        try {
          j = JSON.parse(line)
        } catch {
          return false
        }
        if (j.fatal) {
          reject(new Error(`The ${this.name} helper could not start: ${j.fatal}`))
          return true
        }
        if (j.ready) {
          resolve()
          return true
        }
        return false
      }
      child.once('error', (e) => reject(new Error('Cannot run PowerShell: ' + e.message)))
      child.once('exit', (code) => reject(new Error(`The ${this.name} helper exited (${code}) ${stderr.trim().split('\n')[0] || ''}`.trim())))
      setTimeout(() => reject(new Error(`The ${this.name} helper took too long to start`)), START_TIMEOUT).unref()
    })
    this.ready.catch(() => {})
    child.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        if (this.onLine && this.onLine(line)) {
          this.onLine = null
          continue
        }
        const w = this.waiting
        if (w) {
          this.waiting = null
          clearTimeout(w.timer)
          w.resolve(line)
        }
      }
    })
    child.once('exit', () => {
      if (this.child === child) this.reset(new Error(`The ${this.name} helper stopped`))
    })
    return this.ready
  }

  reset(err) {
    const child = this.child
    this.child = null
    this.ready = null
    const w = this.waiting
    this.waiting = null
    if (w) {
      clearTimeout(w.timer)
      w.reject(err || new Error(`The ${this.name} helper stopped`))
    }
    if (child && child.exitCode === null) child.kill()
  }

  /** One request line -> { j: parsed reply, raw }. Requests are serialised; a silent helper is killed and restarted next time. */
  request(line) {
    const run = async () => {
      await this.start()
      const child = this.child
      const raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = null
          this.reset(new Error(`The ${this.name} helper did not answer`))
          reject(new Error(`The ${this.name} helper did not answer`))
        }, REQUEST_TIMEOUT)
        this.waiting = { resolve, reject, timer }
        child.stdin.write(line + '\n', (e) => {
          if (e) reject(e)
        })
      })
      return { j: JSON.parse(raw), raw }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  stop() {
    this.reset(new Error(`The ${this.name} helper stopped`))
  }
}

module.exports = { Helper, bootScript, psq }
