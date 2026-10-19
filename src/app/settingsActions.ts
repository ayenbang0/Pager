import { copyText } from '../platform/clipboard.js'
import type { Engine, Toast, ToggleKey } from './engine.js'

/** A one-shot text field the app shows in place of the prompt. */
export interface FieldRequest {
  label: string
  initial: string
  masked: boolean
  onSubmit(text: string): void
}

const TOGGLES: readonly string[] = ['sidebar', 'reduceMotion', 'mouse', 'alerts', 'updateCheck', 'acp', 'web', 'agents', 'lan']

/** A toggle flipped or a choice cycled in the Settings tab. */
export function applySettingSet(engine: Engine, id: string, value: boolean | string): void {
  if (typeof value === 'boolean') {
    if (id === 'notify') return engine.setNotify(value)
    if (id === 'sound') return engine.setSound(value)
    if (TOGGLES.includes(id)) return engine.setSetting(id as ToggleKey, value)
    throw new Error(`unknown setting ${id}`)
  }
  switch (id) {
    case 'theme':
      return engine.setTheme(value)
    case 'accent':
      return engine.setAccent(value)
    case 'badge':
      return engine.setBadge(value)
    case 'density':
      return engine.setDensity(value)
    default:
      throw new Error(`unknown setting ${id}`)
  }
}

/** Text submitted from the one-shot field of a text row. */
export function applySettingEdit(engine: Engine, id: string, text: string): void {
  switch (id) {
    case 'name':
      return engine.setName(text.trim())
    case 'badge':
      return engine.setBadge(text)
    case 'accent':
      return engine.setAccent(text)
    default:
      throw new Error(`unknown setting ${id}`)
  }
}

/** An action row, after any confirmation. */
export function runSettingAction(engine: Engine, id: string, _ask: (field: FieldRequest) => void): void {
  switch (id) {
    case 'code':
      copyText(engine.me.code)
      engine.emit('toast', { kind: 'success', text: 'Contact code copied' } satisfies Toast)
      return
    case 'update.check':
      void engine.checkForUpdate()
      return
    case 'changelog':
      engine.showChangelog()
      engine.activate(null)
      return
    default:
      throw new Error(`unknown action ${id}`)
  }
}
