// Notifications that show outside the terminal, with a chime, whether or not pager is the active window.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

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

// Windows: a real toast in the action center through the WinRT API (no module needed), silent so the chime below is the only sound.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Security.SecurityElement]::Escape($env:PAGER_N_TITLE)
$b = [Security.SecurityElement]::Escape($env:PAGER_N_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio silent='true'/></toast>")
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
if ($env:PAGER_N_SOUND -eq '1') {
  $wav = Join-Path $env:WINDIR 'Media\\Windows Notify Messaging.wav'
  if (Test-Path $wav) { (New-Object Media.SoundPlayer $wav).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900 }
} else { Start-Sleep -Milliseconds 400 }
`

const MAC_SCRIPT = 'display notification (system attribute "PAGER_N_BODY") with title (system attribute "PAGER_N_TITLE")'

const clean = (s: string, max: number): string => s.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, max)

let lastChime = 0
let lastKey = ''
let lastKeyAt = 0

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
  const e = { ...env, PAGER_N_TITLE: a.title, PAGER_N_BODY: a.body, PAGER_N_SOUND: a.sound ? '1' : '0' }
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SCRIPT], e)
  } else if (process.platform === 'darwin') {
    run('osascript', ['-e', MAC_SCRIPT], e)
    if (a.sound) run('afplay', ['/System/Library/Sounds/Glass.aiff'], e)
  } else {
    run('notify-send', ['--app-name=pager', '--', a.title, a.body], e)
    if (a.sound) {
      run('canberra-gtk-play', ['-i', 'message-new-instant'], e)
      run('paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga'], e)
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
