// Chats block slash commands. Deliberately short: anything that fits a button or a menu is not here.
//   /share   the Share menu            /invite <name>  invite a contact to this group
//   /agent   share my agent session, or `/agent <name> <task>` to ask an agent        /me <name>  change my display name
//   /mute    mute or unmute this chat  /clear          hide this chat's history in this window only
export const LOCAL_COMMANDS = [
  { name: 'share', usage: '/share', summary: 'Share a block or an agent session into this chat' },
  { name: 'invite', usage: '/invite <name>', summary: 'Invite a contact to this group', only: ['group'] },
  { name: 'agent', usage: '/agent [name task]', summary: 'Share my agents here, or ask one: /agent omp fix the tests' },
  { name: 'me', usage: '/me <name>', summary: 'Change the name people see' },
  { name: 'mute', usage: '/mute', summary: 'Mute or unmute this chat' },
  { name: 'clear', usage: '/clear', summary: 'Hide this chat\'s history here (nothing is deleted)' },
]

/** Commands offered in a chat of this kind. */
export const commandsFor = (chat) => LOCAL_COMMANDS.filter((c) => !c.only || (chat && c.only.includes(chat.kind)))

/**
 * Runs a slash line. `act` supplies the effects so this is testable without a DOM:
 *   { store, chat, openShareMenu(), toast(level,text), clear(chatId) }
 * Returns { ok:boolean, message? }; throws the daemon's error for failed requests.
 */
export async function runLocalCommand(act, line) {
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(line.trim())
  const name = (m?.[1] || '').toLowerCase()
  const rest = (m?.[2] || '').trim()
  const { store, chat } = act
  switch (name) {
    case 'share':
      act.openShareMenu()
      return { ok: true }
    case 'invite': {
      if (!chat || chat.kind !== 'group') return { ok: false, message: '/invite works inside a group' }
      if (!rest) return { ok: false, message: 'Usage: /invite <name>' }
      await store.api.call('chats.group.invite', { chatId: chat.id, peer: rest })
      void store.refreshGroup(chat.id).catch(() => {})
      return { ok: true, message: `Invited ${rest}` }
    }
    case 'agent': {
      if (!rest) {
        act.openAgentShare?.()
        return { ok: true }
      }
      await store.runCommand(chat.id, `/agent ${rest}`)
      return { ok: true }
    }
    case 'me': {
      if (!rest) return { ok: false, message: 'Usage: /me <name>' }
      await store.api.call('chats.profile.set', { name: rest })
      void store.init().catch(() => {})
      return { ok: true, message: `You are now ${rest}` }
    }
    case 'mute': {
      if (!chat) return { ok: false }
      await store.setPref(chat.id, 'mute', !chat.muted)
      return { ok: true, message: chat.muted ? 'Unmuted' : 'Muted' }
    }
    case 'clear': {
      if (!chat) return { ok: false }
      act.clear(chat.id)
      return { ok: true, message: 'History hidden here' }
    }
    default:
      return { ok: false, message: `Unknown command /${name}. Try /share, /invite, /agent, /me, /mute or /clear` }
  }
}
