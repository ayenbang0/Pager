import { createRequire } from 'node:module'
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from '@xterm/headless'

export type XTerm = Terminal
type Options = ITerminalOptions & ITerminalInitOnlyOptions

/** The headless xterm is CommonJS; load it on first use so `pager --help`/`update` never touch it. */
export function newTerm(options: Options): XTerm {
  const mod = createRequire(import.meta.url)('@xterm/headless') as { Terminal: new (o: Options) => Terminal }
  return new mod.Terminal(options)
}
