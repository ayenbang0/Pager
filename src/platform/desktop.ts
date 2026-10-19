// Notifications that show outside the terminal, with a chime, whether or not pager is the active window.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { Socket } from 'node:net'
import { chimePath } from './chime.js'

/** Two alerts closer than this share one chime, so a burst of messages is one sound, not a machine gun. */
export const CHIME_GAP_MS = 1500
/** The same title and body within this window is shown once (a sync replay or a reconnect flap). */
export const DUPLICATE_WINDOW_MS = 4000
const MAX_TITLE = 64
const MAX_BODY = 200

export interface DesktopAlert {
  title: string
  body: string
  /** Play the chime with this alert. */
  sound: boolean
}

// Windows: a real toast in the action center through the WinRT API (no module needed), silent so the chime is the only sound.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command']
const WINDOWS_PRELUDE = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)
$players = @{}
function Show-Alert($title, $body, $sound, $wav, $sync) {
  $t = [Security.SecurityElement]::Escape($title)
  $b = [Security.SecurityElement]::Escape($body)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio silent='true'/></toast>")
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  if (-not $sound) { return }
  if (-not $wav -or -not (Test-Path $wav)) { $wav = Join-Path $env:WINDIR 'Media\\Windows Notify Messaging.wav' }
  if (-not (Test-Path $wav)) { [System.Media.SystemSounds]::Asterisk.Play(); return }
  if (-not $players.ContainsKey($wav)) { $p = New-Object Media.SoundPlayer $wav; $p.Load(); $players[$wav] = $p }
  if ($sync) { $players[$wav].PlaySync() } else { $players[$wav].Play() }
}
`
/** One-shot fallback: a fresh process for one alert (the old behaviour). */
const WINDOWS_ONESHOT = `${WINDOWS_PRELUDE}
Show-Alert $env:PAGER_N_TITLE $env:PAGER_N_BODY ($env:PAGER_N_SOUND -eq '1') $env:PAGER_N_WAV $true
if ($env:PAGER_N_SOUND -ne '1') { Start-Sleep -Milliseconds 400 }
`
/** Resident notifier: reads one base64(UTF-8 JSON {title, body, sound, wav}) per line from stdin until it closes. Exported for the latency smoke. */
export const WINDOWS_HELPER = `${WINDOWS_PRELUDE}
$warm = New-Object Windows.Data.Xml.Dom.XmlDocument
$warm.LoadXml('<toast/>')
[Windows.UI.Notifications.ToastNotification]::new($warm) | Out-Null
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -eq '') { continue }
  $m = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  Show-Alert $m.title $m.body ([bool]$m.sound) $m.wav $false
  [Console]::Out.WriteLine('ok'); [Console]::Out.Flush()
}
`

const MAC_SCRIPT = 'display notification (system attribute "PAGER_N_BODY") with title (system attribute "PAGER_N_TITLE")'

const clean = (s: string, max: number): string => s.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, max)

let lastChime = 0
let lastKey = ''
let lastKeyAt = 0

const HELPER_RETRY_MS = 30_000
let helper: ChildProcess | undefined
let helperTriedAt = 0

function startHelper(): ChildProcess | undefined {
  try {
    const child = spawn('powershell.exe', [...POWERSHELL_ARGS, WINDOWS_HELPER], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', () => undefined)
    child.stdin?.on('error', () => undefined)
    child.on('exit', () => {
      if (helper === child) helper = undefined
    })
    child.unref()
    if (child.stdin instanceof Socket) child.stdin.unref()
    return child
  } catch {
    return undefined
  }
}

/** The resident notifier, started if it is not running (at most one start per HELPER_RETRY_MS). */
function ensureHelper(): ChildProcess | undefined {
  if (helper === undefined && Date.now() - helperTriedAt >= HELPER_RETRY_MS) {
    helperTriedAt = Date.now()
    helper = startHelper()
  }
  return helper
}

/** Hands one alert to the resident notifier. False = it is not available: use the one-shot fallback. */
function sendToHelper(a: DesktopAlert, wav: string): boolean {
  const stdin = ensureHelper()?.stdin
  if (stdin === undefined || stdin === null || stdin.destroyed || !stdin.writable) return false
  stdin.write(`${Buffer.from(JSON.stringify({ title: a.title, body: a.body, sound: a.sound, wav }), 'utf8').toString('base64')}\n`)
  return true
}

/** Starts the resident Windows notifier before the first alert so that alert does not wait for PowerShell. No-op elsewhere, with PAGER_NO_NOTIFY=1, and under the test runner. */
export function warmDesktop(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== 'win32' || env.PAGER_NO_NOTIFY === '1' || env.NODE_TEST_CONTEXT !== undefined) return
  ensureHelper()
}

/** Ends the resident notifier (closing its stdin makes it exit; the kill is a backstop). */
export function closeDesktop(): void {
  const child = helper
  helper = undefined
  if (child === undefined) return
  child.stdin?.end()
  setTimeout(() => child.kill(), 1000).unref()
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(command, args, { env, stdio: 'ignore', windowsHide: true, detached: false })
    child.on('error', () => undefined) // no notifier installed: the in-app popup and the terminal bell still work
    child.unref()
  } catch {
    // spawn can throw synchronously on a bad command; nothing to do
  }
}

function spawnDesktop(a: DesktopAlert, env: NodeJS.ProcessEnv): void {
  const e = { ...env, PAGER_N_TITLE: a.title, PAGER_N_BODY: a.body, PAGER_N_SOUND: a.sound ? '1' : '0', PAGER_N_WAV: a.sound ? (chimePath() ?? '') : '' }
  if (process.platform === 'win32') {
    if (!sendToHelper(a, e.PAGER_N_WAV ?? '')) run('powershell.exe', [...POWERSHELL_ARGS, WINDOWS_ONESHOT], e)
  } else if (process.platform === 'darwin') {
    run('osascript', ['-e', MAC_SCRIPT], e)
    if (a.sound) run('afplay', [e.PAGER_N_WAV || '/System/Library/Sounds/Glass.aiff'], e)
  } else {
    run('notify-send', ['--app-name=pager', '--', a.title, a.body], e)
    if (a.sound) {
      const wav = e.PAGER_N_WAV
      if (wav) {
        run('paplay', [wav], e)
      } else {
        run('canberra-gtk-play', ['-i', 'message-new-instant'], e)
        run('paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga'], e)
      }
    }
  }
}

/**
 * Shows `title`/`body` as a desktop notification and, when `sound` is set and the last chime was long enough ago, plays the system
 * chime. Returns what it did, for tests. `PAGER_NOTIFY_FILE` appends each alert as a JSON line instead of touching the OS.
 */
export function desktopNotify(alert: DesktopAlert, now = Date.now(), env: NodeJS.ProcessEnv = process.env): 'shown' | 'duplicate' | 'off' {
  const file = env.PAGER_NOTIFY_FILE
  const seam = file !== undefined && file !== ''
  // PAGER_NO_NOTIFY switches it off; test runs never reach the real OS unless they use the file seam.
  if (env.PAGER_NO_NOTIFY === '1' || (!seam && env.NODE_TEST_CONTEXT !== undefined)) return 'off'
  const title = clean(alert.title, MAX_TITLE)
  const body = clean(alert.body, MAX_BODY)
  const key = `${title}\0${body}`
  if (key === lastKey && now - lastKeyAt < DUPLICATE_WINDOW_MS) return 'duplicate'
  lastKey = key
  lastKeyAt = now
  const sound = alert.sound && now - lastChime >= CHIME_GAP_MS
  if (sound) lastChime = now
  const out: DesktopAlert = { title, body, sound }
  if (seam) {
    try {
      fs.appendFileSync(file ?? '', `${JSON.stringify(out)}\n`)
    } catch {
      // a test seam must never break the app
    }
    return 'shown'
  }
  spawnDesktop(out, env)
  return 'shown'
}

/** Test hook: forget the throttling state. */
export function resetDesktopState(): void {
  lastChime = 0
  lastKey = ''
  lastKeyAt = 0
}
