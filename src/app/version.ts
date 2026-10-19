import { createRequire } from 'node:module'

/** The running pager's version, from package.json (one level above dist/). */
export const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
