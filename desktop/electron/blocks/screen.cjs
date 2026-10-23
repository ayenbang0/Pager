'use strict'
// Main-process handler of the Screen block: see and drive THIS machine's displays.
//
// Nothing is captured until the user picks a display in the block (`select`); there is no remembered default and no
// way to capture anything the block did not list. Frames normally come straight from Chromium's capture API in the
// renderer (smooth, hardware accelerated); `frame` is the main-process fallback if that is unavailable.
// Driving needs a second, explicit step per session (`mode` with confirm:true, behind a banner in the UI), only works
// on the display that session selected, auto-drops to view-only after 10 idle minutes, and releases every key and
// button it pressed when it ends. Input is injected with SendInput through a small C# helper (Windows).
// Sharing a screen with another machine is NOT implemented here.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Helper } = require('./ps-helper.cjs')

const IDLE_CONTROL_MS = 10 * 60 * 1000
const MAX_EVENTS = 256
const MAX_RECORDING = 1024 * 1024 * 1024

const SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

public static class PagerInput
{
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);

    static readonly CultureInfo inv = CultureInfo.InvariantCulture;
    static readonly HashSet<int> keys = new HashSet<int>();     // pressed: vk | 0x10000 when extended
    static readonly HashSet<string> buttons = new HashSet<string>();
    static bool dpi = Init();
    static bool Init() { SetProcessDPIAware(); return true; }

    static bool Send(INPUT i)
    {
        return SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    static bool Mouse(int dx, int dy, uint data, uint flags)
    {
        INPUT i = new INPUT();
        i.type = 0;
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
        return Send(i);
    }

    static bool Key(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = 1;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
        return Send(i);
    }

    static bool Move(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        if (x < vx) x = vx; if (x > vx + vw - 1) x = vx + vw - 1;
        if (y < vy) y = vy; if (y > vy + vh - 1) y = vy + vh - 1;
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        return Mouse(nx, ny, 0, 0x0001 | 0x8000 | 0x4000);
    }

    static bool Button(string b, bool down)
    {
        uint f;
        uint data = 0;
        switch (b)
        {
            case "left": f = down ? 0x0002u : 0x0004u; break;
            case "right": f = down ? 0x0008u : 0x0010u; break;
            case "middle": f = down ? 0x0020u : 0x0040u; break;
            case "back": f = down ? 0x0080u : 0x0100u; data = 1; break;
            case "forward": f = down ? 0x0080u : 0x0100u; data = 2; break;
            default: return false;
        }
        if (down) buttons.Add(b); else buttons.Remove(b);
        return Mouse(0, 0, data, f);
    }

    static bool Wheel(int dx, int dy)
    {
        bool ok = true;
        if (dy != 0) ok &= Mouse(0, 0, unchecked((uint)dy), 0x0800);
        if (dx != 0) ok &= Mouse(0, 0, unchecked((uint)dx), 0x1000);
        return ok;
    }

    static bool VKey(int vk, bool ext, bool down)
    {
        int id = vk | (ext ? 0x10000 : 0);
        if (down) keys.Add(id); else keys.Remove(id);
        uint f = (ext ? 0x1u : 0u) | (down ? 0u : 0x2u);
        return Key((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), f);
    }

    static bool Unit(int code, bool down)
    {
        return Key(0, (ushort)code, 0x4u | (down ? 0u : 0x2u));
    }

    static int ReleaseAll()
    {
        int n = 0;
        foreach (string b in new List<string>(buttons)) { Button(b, false); n++; }
        foreach (int id in new List<int>(keys)) { VKey(id & 0xFFFF, (id & 0x10000) != 0, false); n++; }
        return n;
    }

    public static string Handle(string line)
    {
        try
        {
            int ok = 0, fail = 0;
            foreach (string cmd in line.Trim().Split(';'))
            {
                if (cmd.Length == 0) continue;
                string[] a = cmd.Split(' ');
                bool r;
                switch (a[0])
                {
                    case "i":
                        return "{\"vx\":" + GetSystemMetrics(76) + ",\"vy\":" + GetSystemMetrics(77) + ",\"vw\":" + GetSystemMetrics(78) + ",\"vh\":" + GetSystemMetrics(79) + "}";
                    case "ping": return "{\"pong\":true}";
                    case "r": return "{\"released\":" + ReleaseAll() + "}";
                    case "m": r = Move(int.Parse(a[1], inv), int.Parse(a[2], inv)); break;
                    case "b": r = Button(a[1], a[2] == "d"); break;
                    case "w": r = Wheel(int.Parse(a[1], inv), int.Parse(a[2], inv)); break;
                    case "k": r = VKey(int.Parse(a[1], inv), a[3] == "1", a[2] == "d"); break;
                    case "c": r = Unit(int.Parse(a[1], inv), a[2] == "d"); break;
                    default: r = false; break;
                }
                if (r) ok++; else fail++;
            }
            return "{\"ok\":" + ok + ",\"fail\":" + fail + "}";
        }
        catch (Exception e)
        {
            return "{\"error\":\"" + e.Message.Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ") + "\"}";
        }
    }
}
`

// ---------------------------------------------------------------- pure parts (unit-tested)

/** KeyboardEvent.code -> [virtual-key code, extended?]. Physical keys: the host applies its own layout, as for a real keyboard. */
const KEYS = (() => {
  const t = {}
  for (let i = 0; i < 26; i++) t['Key' + String.fromCharCode(65 + i)] = [0x41 + i, 0]
  for (let i = 0; i < 10; i++) {
    t['Digit' + i] = [0x30 + i, 0]
    t['Numpad' + i] = [0x60 + i, 0]
  }
  for (let i = 1; i <= 24; i++) t['F' + i] = [0x6f + i, 0]
  Object.assign(t, {
    Enter: [0x0d, 0], NumpadEnter: [0x0d, 1], Escape: [0x1b, 0], Tab: [0x09, 0], Backspace: [0x08, 0], Space: [0x20, 0],
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    Home: [0x24, 1], End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1], Insert: [0x2d, 1], Delete: [0x2e, 1],
    ShiftLeft: [0xa0, 0], ShiftRight: [0xa1, 0], ControlLeft: [0xa2, 0], ControlRight: [0xa3, 1], AltLeft: [0xa4, 0], AltRight: [0xa5, 1],
    MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1], CapsLock: [0x14, 0], NumLock: [0x90, 1], ScrollLock: [0x91, 0],
    PrintScreen: [0x2c, 1], Pause: [0x13, 0],
    Minus: [0xbd, 0], Equal: [0xbb, 0], BracketLeft: [0xdb, 0], BracketRight: [0xdd, 0], Backslash: [0xdc, 0], Semicolon: [0xba, 0],
    Quote: [0xde, 0], Backquote: [0xc0, 0], Comma: [0xbc, 0], Period: [0xbe, 0], Slash: [0xbf, 0], IntlBackslash: [0xe2, 0],
    NumpadAdd: [0x6b, 0], NumpadSubtract: [0x6d, 0], NumpadMultiply: [0x6a, 0], NumpadDecimal: [0x6e, 0], NumpadDivide: [0x6f, 1],
  })
  return t
})()

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] // MouseEvent.button order

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Normalised point inside a display's physical rect -> physical desktop pixel. */
function mapPoint(rect, nx, ny) {
  return { x: Math.round(rect.x + clamp01(nx) * (rect.width - 1)), y: Math.round(rect.y + clamp01(ny) * (rect.height - 1)) }
}

/** Renderer input events -> helper command string. Throws on anything malformed; never emits a command for a point off the display. */
function commandsFor(events, rect) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error('Bad input batch')
  const out = []
  for (const e of events) {
    switch (e && e.t) {
      case 'move': {
        const p = mapPoint(rect, e.x, e.y)
        out.push(`m ${p.x} ${p.y}`)
        break
      }
      case 'down':
      case 'up': {
        const b = BUTTONS[e.button]
        if (!b) throw new Error('Bad mouse button')
        if (e.x !== undefined) {
          const p = mapPoint(rect, e.x, e.y)
          out.push(`m ${p.x} ${p.y}`)
        }
        out.push(`b ${b} ${e.t === 'down' ? 'd' : 'u'}`)
        break
      }
      case 'wheel': {
        // browser deltaY > 0 scrolls down, WHEEL_DELTA > 0 scrolls up (flip); deltaX > 0 and HWHEEL > 0 both mean right
        const dx = Math.max(-1200, Math.min(1200, Math.round(Number(e.dx) || 0)))
        const dy = Math.max(-1200, Math.min(1200, Math.round(-Number(e.dy) || 0)))
        if (e.x !== undefined) {
          const p = mapPoint(rect, e.x, e.y)
          out.push(`m ${p.x} ${p.y}`)
        }
        out.push(`w ${dx} ${dy}`)
        break
      }
      case 'key': {
        const k = KEYS[e.code]
        if (!k) break // an unmapped key is dropped, never guessed
        out.push(`k ${k[0]} ${e.down ? 'd' : 'u'} ${k[1]}`)
        break
      }
      case 'text': {
        const s = String(e.text || '').slice(0, 512)
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i)
          out.push(`c ${c} d`, `c ${c} u`)
        }
        break
      }
      default:
        throw new Error('Bad input event')
    }
  }
  return out.join(';')
}

// ---------------------------------------------------------------- electron side

const input = new Helper({ name: 'screen', source: SOURCE, type: 'PagerInput' })
const sessions = new Map() // sid -> { sid, sourceId, displayId, mode, lastInput, emit }
let seq = 0
let reaper = null

function electron() {
  const e = require('electron')
  if (!e || !e.desktopCapturer || !e.screen) throw new Error('Screen capture needs the desktop app.')
  return e
}

function displayInfo(d) {
  const sf = d.scaleFactor || 1
  return {
    displayId: String(d.id),
    bounds: d.bounds,
    scale: sf,
    size: { w: Math.round(d.size.width * sf), h: Math.round(d.size.height * sf) },
    primary: false,
  }
}

function physicalRect(d) {
  const { screen } = electron()
  try {
    if (process.platform === 'win32' && typeof screen.dipToScreenRect === 'function') {
      const r = screen.dipToScreenRect(null, d.bounds)
      if (r && r.width > 0) return r
    }
  } catch {
    /* fall through to the scale-factor estimate */
  }
  const sf = d.scaleFactor || 1
  return { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf), width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) }
}

/** The screens, as the user will see them. Source -> display by id, else by order. */
async function listScreens(thumb) {
  const { desktopCapturer, screen, BrowserWindow } = electron()
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay().id
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb ? { width: 320, height: 200 } : { width: 0, height: 0 }, fetchWindowIcons: false })
  const here = new Set()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible()) continue
    here.add(screen.getDisplayMatching(w.getBounds()).id)
  }
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id) || displays[i]
    const info = displayInfo(d)
    return {
      id: s.id,
      name: `Display ${i + 1}`,
      ...info,
      primary: d.id === primary,
      hostsPager: here.has(d.id),
      thumb: thumb && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      _display: d,
    }
  })
}

const pub = ({ _display, ...rest }) => rest

function sessionOf(sid) {
  const s = sessions.get(String(sid))
  if (!s) throw new Error('This screen session is closed.')
  return s
}

async function releaseInput() {
  if (!input.pid) return
  try {
    await input.request('r')
  } catch {
    /* helper already gone: nothing is held */
  }
}

function setMode(s, mode, reason) {
  if (s.mode === mode) return
  s.mode = mode
  s.lastInput = Date.now()
  if (mode !== 'control') releaseInput()
  if (reason) s.emit('mode', { sid: s.sid, mode, reason })
  const anyControl = [...sessions.values()].some((x) => x.mode === 'control')
  if (anyControl && !reaper) {
    reaper = setInterval(() => {
      for (const x of sessions.values()) if (x.mode === 'control' && Date.now() - x.lastInput > IDLE_CONTROL_MS) setMode(x, 'view', 'idle')
    }, 15000)
    reaper.unref()
  } else if (!anyControl && reaper) {
    clearInterval(reaper)
    reaper = null
    input.stop() // nothing to drive: no helper process lingers
  }
}

const methods = {
  /** The displays of this machine, with small previews, for the picker. Captures nothing until `select`. */
  async sources() {
    return (await listScreens(true)).map(pub)
  },

  /** The user's explicit choice of one display. Starts a view-only session. */
  async select({ sourceId } = {}, ctx) {
    const screens = await listScreens(false)
    const s = screens.find((x) => x.id === sourceId)
    if (!s) throw new Error('That display is no longer available.')
    const sid = 's' + ++seq
    sessions.set(sid, { sid, sourceId: s.id, displayId: s.displayId, mode: 'view', lastInput: Date.now(), emit: ctx && typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : () => {} })
    return { sid, source: pub(s) }
  },

  /** view <-> control. Control needs `confirm: true` (the UI's per-session opt-in); it is never inherited by another session. */
  async mode({ sid, mode, confirm } = {}) {
    const s = sessionOf(sid)
    if (mode === 'control') {
      if (confirm !== true) throw new Error('Control needs your confirmation.')
      if (process.platform !== 'win32') throw new Error('Driving the screen is only available on Windows for now.')
      await input.start()
      setMode(s, 'control')
    } else if (mode === 'view') setMode(s, 'view')
    else throw new Error('Unknown mode')
    return { mode: s.mode }
  },

  /** Pointer / wheel / key events in display-normalised coordinates; only while this session is in control mode. */
  async input({ sid, events } = {}) {
    const s = sessionOf(sid)
    if (s.mode !== 'control') throw new Error('This session is view only.')
    const { screen } = electron()
    const d = screen.getAllDisplays().find((x) => String(x.id) === s.displayId)
    if (!d) {
      setMode(s, 'view', 'display-gone')
      throw new Error('The display went away.')
    }
    const line = commandsFor(events, physicalRect(d))
    s.lastInput = Date.now()
    if (!line) return { ok: 0, fail: 0 }
    const { j } = await input.request(line)
    if (j.error) throw new Error(j.error)
    return j
  },

  /** Fallback frame (JPEG data URL) of the session's display, for when the renderer cannot capture itself. */
  async frame({ sid, maxWidth = 1600 } = {}) {
    const s = sessionOf(sid)
    const { desktopCapturer, screen } = electron()
    const d = screen.getAllDisplays().find((x) => String(x.id) === s.displayId)
    if (!d) throw new Error('The display went away.')
    const sf = d.scaleFactor || 1
    const w = Math.min(Math.round(maxWidth), Math.round(d.size.width * sf))
    const h = Math.round((w * d.size.height) / d.size.width)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h }, fetchWindowIcons: false })
    const src = sources.find((x) => x.id === s.sourceId)
    if (!src) throw new Error('The display went away.')
    return { url: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(70).toString('base64'), w, h }
  },

  /** Save a finished recording (webm bytes from the renderer) where the user says. */
  async saveRecording({ sid, data } = {}) {
    sessionOf(sid)
    const { dialog, BrowserWindow, app } = electron()
    const bytes = Buffer.from(data)
    if (!bytes.length || bytes.length > MAX_RECORDING) throw new Error('The recording is empty or too large.')
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const dir = (() => {
      try {
        return app.getPath('videos')
      } catch {
        return os.homedir()
      }
    })()
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: 'Save screen recording',
      defaultPath: path.join(dir, `Pager-screen-${stamp}.webm`),
      filters: [{ name: 'WebM video', extensions: ['webm'] }],
    })
    if (r.canceled || !r.filePath) return { saved: false }
    fs.writeFileSync(r.filePath, bytes)
    return { saved: true, path: r.filePath, bytes: bytes.length }
  },

  /** End a session: releases anything held and forgets the selection. */
  async release({ sid } = {}) {
    const s = sessions.get(String(sid))
    if (!s) return true
    setMode(s, 'view')
    sessions.delete(s.sid)
    if (![...sessions.values()].some((x) => x.mode === 'control')) input.stop()
    return true
  },
}

async function dispose() {
  await releaseInput()
  sessions.clear()
  clearInterval(reaper)
  reaper = null
  input.stop()
}

module.exports = { methods, dispose, SOURCE, _t: { KEYS, mapPoint, commandsFor, sessions, input } }
