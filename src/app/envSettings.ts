import type { Settings } from './settings.js'

export interface EnvLock {
  key: keyof Settings
  source: string
}

type Switch = { key: keyof Settings; env: string; /** the persisted value that sets the variable */ sets: boolean }

const SWITCHES: readonly Switch[] = [
  { key: 'reduceMotion', env: 'PAGER_REDUCE_MOTION', sets: true },
  { key: 'mouse', env: 'PAGER_NO_MOUSE', sets: false },
  { key: 'alerts', env: 'PAGER_NO_NOTIFY', sets: false },
  { key: 'updateCheck', env: 'PAGER_NO_UPDATE_CHECK', sets: false },
  { key: 'acp', env: 'PAGER_NO_ACP', sets: false },
  { key: 'web', env: 'PAGER_NO_WEB', sets: false },
  { key: 'agents', env: 'PAGER_NO_AGENTS', sets: false },
  { key: 'lan', env: 'PAGER_LAN', sets: true },
]

/**
 * Settings that modules read from the environment at load time are projected onto it before those modules load.
 * A variable (or flag) the user already set wins and locks the matching setting; otherwise a persisted value that
 * means "on" sets the variable. Returns every lock.
 */
export function applyEnvFromSettings(settings: Settings, env: NodeJS.ProcessEnv, flags: { lan: boolean; noAgents: boolean }): EnvLock[] {
  const locks: EnvLock[] = []
  for (const sw of SWITCHES) {
    if (sw.key === 'agents' && flags.noAgents) {
      env[sw.env] = '1'
      locks.push({ key: sw.key, source: '--no-agents' })
    } else if (sw.key === 'lan' && flags.lan) {
      env[sw.env] = '1'
      locks.push({ key: sw.key, source: '--lan' })
    } else if (env[sw.env] === '1') {
      locks.push({ key: sw.key, source: sw.env })
    } else if (settings[sw.key] === sw.sets) {
      env[sw.env] = '1'
    }
  }
  return locks
}
