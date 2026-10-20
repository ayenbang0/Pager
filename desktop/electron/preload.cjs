'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The renderer gets exactly these calls and nothing else.
contextBridge.exposeInMainWorld('pager', {
  ready: (cols, rows) => ipcRenderer.send('ready', cols, rows),
  input: (s) => ipcRenderer.send('input', s),
  resize: (cols, rows) => ipcRenderer.send('resize', cols, rows),
  title: (t) => ipcRenderer.send('title', String(t)),
  hotkey: (name) => ipcRenderer.send('hotkey', String(name)),
  onData: (fn) => ipcRenderer.on('data', (_e, s) => fn(s)),
  onExit: (fn) => ipcRenderer.on('exit', (_e, code) => fn(code)),
  onConfig: (fn) => ipcRenderer.on('config', (_e, c) => fn(c)),
})
