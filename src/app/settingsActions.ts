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
    if (id === 'agents.review') return engine.setAgentReview(value)
    if (id === 'agents.risk') return engine.setAgentRisk(value)
    if (TOGGLES.includes(id)) return engine.setSetting(id as ToggleKey, value)
    throw new Error(`unknown setting ${id}`)
  }
  if (id === 'ai.default') return engine.setAi('default', value)
  if (id.startsWith('agent.color:')) return engine.setAgentColor(id.slice('agent.color:'.length), value)
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
    case 'ai.ollama.url':
    case 'ai.ollama.model':
    case 'ai.openai.url':
    case 'ai.openai.model':
    case 'ai.openai.key':
      return engine.setAi(id.slice('ai.'.length), text)
    case 'agents.verify':
      return engine.setAgentVerify(text)
    case 'agents.goal':
      return engine.setAgentGoal(text)
    case 'agents.memory.add':
      return engine.agentMemory('add', text)
    default:
      if (id.startsWith('folder:')) return engine.folderRename(id.slice('folder:'.length), text)
      if (id.startsWith('agent.color:')) return engine.setAgentColor(id.slice('agent.color:'.length), text)
      if (id.startsWith('agents.budget:')) return engine.setAgentBudget(id.slice('agents.budget:'.length), text)
      throw new Error(`unknown setting ${id}`)
  }
}

/** An action row, after any confirmation. */
export function runSettingAction(engine: Engine, id: string, ask: (field: FieldRequest) => void): void {
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
    case 'ai.clear':
      return engine.clearAi()
    case 'net.log':
      copyText(engine.netInfo().logPath)
      engine.emit('toast', { kind: 'success', text: 'Path of net.log copied' } satisfies Toast)
      return
    case 'folder.new':
      return ask({ label: 'New folder name', initial: '', masked: false, onSubmit: (text) => engine.folderNew(text) })
    case 'agents.setup':
      return engine.openAgentSetup()
    case 'agents.memory.show':
      return engine.agentMemory('show')
    case 'agents.memory.clear':
      return engine.agentMemory('clear')
    case 'guest.kickall':
      return engine.agentKick('all')
    default:
      if (id.startsWith('folder-up:')) return engine.folderMove(id.slice('folder-up:'.length), -1)
      if (id.startsWith('folder-down:')) return engine.folderMove(id.slice('folder-down:'.length), 1)
      if (id.startsWith('folder.delete:')) return engine.folderRemove(id.slice('folder.delete:'.length))
      if (id.startsWith('agent.model:')) return engine.openModelPicker(id.slice('agent.model:'.length))
      if (id.startsWith('guest.kick:')) return engine.agentKick(id.slice('guest.kick:'.length))
      if (id.startsWith('session.leave:')) return engine.agentLeave(id.slice('session.leave:'.length))
      throw new Error(`unknown action ${id}`)
  }
}
