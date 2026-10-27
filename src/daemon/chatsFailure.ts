export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * What the Chats block shows when the engine will not start. A native addon that Windows refused to load (Smart App Control or an
 * Application Control policy) is the one failure the user can act on, so it is named. Node keeps a module whose evaluation failed,
 * so the daemon has to restart once the file is allowed; Retry alone cannot recover.
 */
export function startFailure(e: unknown): string {
  const cause = e instanceof Error ? e.cause : undefined
  if (cause instanceof Error && /Application Control|blocked this file/i.test(cause.message)) {
    const addon = /([\w.-]+\.node)/.exec(errText(e))?.[1] ?? 'a native module'
    return `Windows blocked ${addon} (Smart App Control or an Application Control policy), and chat needs it. Chat stays off until the file is allowed and the daemon restarts (pager daemon stop). Terminals and the other blocks are unaffected.`
  }
  return `Chat could not start: ${errText(e)}`
}
