# Chats wire contract (daemon <-> renderer) v2

Code: `src/daemon/chats.ts` (host, events), `chatsHandlers.ts` + `chatsShares.ts` (requests), `src/chat/blockShare.ts` (shared-block transport), wire frame `share` in `src/net/wire.ts`. Requests ride the daemon protocol: `window.pager.d.call(type, args)` -> `{id,type,...args}` -> `{id,ok,result}|{id,ok:false,error}`. The renderer must `events.subscribe{filter:[...]}` for: `chats_changed chat_message chat_presence chat_call chat_request chat_toast chat_status chat_share chat_share_op` (`chat_typing` reserved). Unsubscribed clients get nothing.

## Scope (per Main)
The Chats block = chat + SHARED AGENTS + SHARED BLOCKS. Calls, bots, AI settings, docs/studio, usage, settings screens are NOT in Chats; their requests still exist (section "Other surfaces") for Home/palette/Settings to use.

## Reality check (flags in `chats.caps` / `chats.state.caps`)
Wire protocol has: text (<=4000 chars, `:emoji:`), reactions (toggle), groups (create/rename/invite/leave; creator-only rename/invite), contact requests, delivery/read status (pending|sent|delivered|read), presence (link open = online), calls, pings, bots, agents, shared agent sessions, shared Markdown docs. It does NOT have: edit, delete, reply, attachments, typing, avatars (only the `me.badge` emoji), kick, last-seen. `caps.edit/delete/reply/attachments/typing/avatars/removeMember/lastSeen = false`: `chats.edit`/`chats.delete`/`chats.send{replyTo|attachments}` fail `unsupported: …`; `chats.typing` returns `{supported:false}`; `chat_typing` never fires. pin/mute/archive are LOCAL view prefs of this machine (`<dir>/chats-view.json`), real and working, never sent to peers.
`caps.share = { transport:true, blocks:['canvas','board','notebook','files','tasks','git','screen','agent'], modes:['live','readonly','snapshot'], agent:'live'|false }` = what the *daemon* carries. Whether a block is live, read-only or snapshot-only is decided by the renderer's adapter registry (`blocks/share.js`); the Share menu should list only blocks that have an adapter and label the mode.

## Conventions
- Chat ids: `dm:<32hex>`, `grp:<32hex>`, and (agents on) `agents`, `agent:<name>`, `ai`, `shared:<hostPk>`. `ChatSummary.kind` = `dm|group|room|agent|ai|shared`. Shares live in dm/grp chats.
- Errors: `{ok:false,error:"<code>: <text>"}`; codes `not_ready locked conflict unsupported invalid rejected not_found failed`. `chats.state` reports engine problems as `status`, never as an error.
- Action results: `{message?, toasts:[{level,text}], ...extra}`; an engine refusal (error toast) is error `rejected: <text>`.
- Requests execute one at a time (engine commands act on the "open chat"; the bridge opens the right chat first). All times ms epoch. Message `key` = `<authorPk>:<seq>`.
- Peer text is untrusted: render as text. Share payloads (`op`, `snapshot`, `args`) are opaque strings from peers: parse defensively, never eval, never innerHTML.

## Types
```
ChatsStatus = 'off'|'starting'|'ready'|'locked'|'conflict'|'error'
ChatSummary = { id, kind, title, peer: string|null, online: boolean|null, unread, last?:{ts,text<=140,mine,authorName,status}, call?:number, thinking?:boolean, asking?:boolean, pinned, muted, archived, folder? }
MessageView = { key, ts, authorName, authorKey, mine, kind:'text'|'system', text, markdown?, agent?, status:'pending'|'sent'|'delivered'|'read'|null, reactions?:[{emoji,count,mine}], reactable? }
ShareMessage = { key:'share:<shareId>', ts:<startedAt>, authorName:hostName, authorKey:hostPk, mine, kind:'share', text:'', status:null, share: ShareView }   // timeline item, returned inside chats.open().messages
ShareView = {
  shareId, chatId, block:'canvas'|'board'|'notebook'|'files'|'tasks'|'git'|'screen'|'agent', title, hostPk, hostName, mine /*I host*/,
  mode:'live'|'readonly'|'snapshot', state:'live'|'ended', joined /*I take part*/, hostOnline,
  members:[{pk,name,me,hue:0..359,active}], startedAt, endedAt?, args?: string /*opaque, set by the host's block*/,
  agent?:{name,state:'idle'|'working'|'asking',summary?}, asking?:boolean, openChatId?: string /*agent shares: 'shared:<pk>' (joined) or 'agents' (mine)*/
}
PendingView = { n, id:'contact:<pk>'|'group:<convId>'|'session:<pk>', type:'contact'|'group'|'session', label, note }
```

## Core requests (Chats uses these)
| type | params | result |
|---|---|---|
| `chats.caps` | – | caps (no engine start) |
| `chats.state` | – | `{status, statusText?, me?:{pk,code,name,badge}, online, onlineCount, lan?, encrypted, agentsOn, version, update, caps, chats:ChatSummary[] /*pinned first, then newest*/, pending:PendingView[], call, openChat}` — starts the engine on first call |
| `chats.retry` / `chats.unlock{passphrase}` | | same as state (conflict retry / locked identity) |
| `chats.yield` | | `{yielded:boolean}` — a terminal pager that finds `<dir>/pager.lock` held by this daemon asks for it. The engine is closed and the lock released before the reply; `false` when there is no engine. Does not start one. |
| `chats.focus` | `{focused:boolean, chatId?:string\|null}` | `{}` — report window focus + chat on screen (read receipts depend on it) |
| `chats.open` | `{chatId, before?:key, limit?:1..200=50, markRead?=true}` | `{chat, messages:(MessageView\|ShareMessage)[] /*oldest first*/, hasMore, call, rooms?, group?:GroupView, bots?, agents?:AgentsState, shared?}`. Paging: `before` = key of your oldest message; share cards offered since the page's oldest message are included in every page (dedupe by key). Opening marks read. agents/ai/shared tabs return their newest `limit` only. |
| `chats.send` | `{chatId, text}` | `{key?}` (text starting `/` is sent literally; slash commands go through `chats.command`) |
| `chats.react` | `{chatId,key,emoji}` | `{}` toggle |
| `chats.read` / `chats.stop` | `{chatId}` | `{}` / `{stopped}` (interrupt AI/agent turn) |
| `chats.pin` `chats.mute` `chats.archive` | `{chatId,on}` | `{}` |
| `chats.search` | `{query,limit?}` | `{hits:[{chatId?,where,author,ts,text,snippet}],total}` |
| `chats.contact.add` | `{code,note?}` | action result (rejected for bad/own/blocked code) |
| `chats.contact.remove` | `{peer: name\|pk}` | action result |
| `chats.requests` / `chats.request.accept` / `chats.request.decline` | `{id}` (or `{n}`) | `PendingView[]` / action result — contact request, group invite, agent-session invite |
| `chats.group.new{title}` `.rename{chatId,title}` `.invite{chatId,peer}` `.leave{chatId}` `.members{chatId}` | | `{chatId}` / action result / GroupView |
| `chats.profile.set` | `{name?,badge?}` | `{me}` |
| `chats.ping` | `{chatId,peer?}` | action result |
| `chats.command` | `{chatId?,line}` | `{toasts, lines?}` — escape hatch for any engine slash line (not needed for Chats' own short list below). Refused: `/quit /exit /terminal /run /docs /studio /update /settings /requests /help`. |
| `chats.commands` | – | engine command catalogue with `hostOnly` reasons (informational) |

**Chats composer commands (client side, per Main):** `/share` → opens the Share menu (`chats.share.start`), `/invite` → `chats.group.invite`, `/agent` → `chats.share.start{block:'agent'}` or `chats.command` for `/agent <name> <task>`, `/me` → `chats.profile.set`, `/mute` → `chats.mute`, `/clear` → local only (hide history in your view; nothing is deleted anywhere).

## Sharing (blocks and agents)
Topology: star. The host of a share numbers and relays every operation (`ver`), guests only talk to the host (peers need a link to the host; group members are linked to each other). Host offline = guests see `hostOnline:false` and rejoin (and receive a fresh snapshot) when the host returns. A share never survives a daemon restart (its card stays in the timeline as `ended`). Frames go only to peers that speak the `share` capability (older Pager builds are skipped silently).
Limits: operation <= 65 536 bytes, snapshot <= 180 000 bytes, cursor/presence <= 1 024 bytes; per sender 60 ops/s (burst 120) and 20 cursors/s (burst 40), over-limit is dropped (ops) / rejected for yourself (`rejected: too many operations`); max 8 live shares hosted, 8 live shares offered per peer. Modes: `live` (everyone edits), `readonly` (host edits; guests receive and may send cursors), `snapshot` (one-time copy inside the offer, no session).
| type | params | result |
|---|---|---|
| `chats.share.list` | `{chatId?, live?:boolean}` | `ShareView[]` (block shares + agent sessions, oldest first) |
| `chats.share.start` | `{chatId, block, title?, mode?='live', args?, snapshot?}` | block: `{share:ShareView}`. `args`/`snapshot` are strings (objects are JSON-stringified); `snapshot` is required for `snapshot` mode and recommended for others (cached for late joiners). `block:'agent'`: invites the DM peer (or every contact in the group) to your agent session (`mode:'readonly'` = view-only): `{message,toasts,shares}` |
| `chats.share.join` | `{shareId}` | `{share, snapshot:{d,ver}\|null}` — live blocks: the snapshot may arrive afterwards as `chat_share_op{type:'snapshot'}`; agent: accepts the invite |
| `chats.share.leave` / `chats.share.end` | `{shareId}` | `{share}` (host `leave` = end; agent: leave / kick) |
| `chats.share.op` | `{shareId, op}` | `{ver}` (`op`: string; host gets the number, guests `0`) — apply it locally first, then send |
| `chats.share.presence` | `{shareId, d}` | `{}` cursors/selection, relayed not stored |
| `chats.share.snapshot` | `{shareId, d, ver?, to?}` | `{}` host only: cache the current state for late joiners; with `to` (answer to `join_request`) it is sent to that guest now |

Agent sessions reuse the engine's shared-agent code: `shareId` = `agent:<hostPk>` (offered to me / joined by me) or `agent:me:<guestPk>` (mine, one card per invited person, placed in that DM); state/summary come from the live room (`agent.state` working/asking). Opening the live thing = `chats.open{chatId: share.openChatId}`; sending/answering questions uses `chats.send` / `chats.agent.answer{chatId,id,answers}`. An offered agent session is also a `PendingView` (`type:'session'`).

## Events (JSON `{event,...}`)
| event | payload |
|---|---|
| `chats_changed` | `{ids:string[]\|null, chats:ChatSummary[], removed:string[], pending?:PendingView[], online, onlineCount, reason}` coalesced <=1/50 ms; apply `chats` over your store |
| `chat_message` | `{chatId, message:MessageView, mine}` a new message was stored; status changes arrive as `chats_changed` (and your next `open`) |
| `chat_share` | `{chatId, kind:'offered'\|'joined'\|'left'\|'ended'\|'presence', share:ShareView}` replace the card by `shareId` (agent sessions too: kinds `offered`/`presence`/`ended`) |
| `chat_share_op` | `{shareId, type:'op'\|'presence'\|'snapshot'\|'join_request', from:pk, fromName, ver?, op:string}` — `op` is the sender's opaque text (for `snapshot` the snapshot text, for `join_request` empty: host answers with `chats.share.snapshot{to:from}`). Apply `op`s in `ver` order; the host's own ops are never echoed back to it. |
| `chat_presence` | `{pk, chatId, online}` (DMs) |
| `chat_request` | `{pending, added?}` |
| `chat_toast` | `{level,text}` engine one-liners |
| `chat_status` | `{status, statusText?}` |
| `chat_call` | `{chatId, kind:'ring'\|'state', call, rooms, from?}` (for other surfaces) |

## Renderer adapter interface (`desktop/renderer/blocks/share.js`)
```
registerShare(blockName, factory)   // factory(ctx) -> adapter
adapter = {
  modes: ('live'|'readonly'|'snapshot')[],          // what this block can really do
  snapshot(): any,                                  // JSON-able whole state (host: for chats.share.snapshot / start)
  applyOp(op: any, meta:{from,ver,mine}): void,     // apply a remote operation to the live block
  applySnapshot(s: any): void,                      // guest: replace state (also after a rejoin)
  onLocalOp(cb: (op:any)=>void): unsubscribe,       // the block emits user edits here; share.js sends chats.share.op
  presence?: { local(cb:(d:any)=>void): unsubscribe, remote(from:{pk,name,hue}, d:any): void },  // cursors
  readonly?: (on:boolean)=>void,                    // guests of a readonly share
}
```
`share.js` owns the RPC/event plumbing (start/join/leave, queue ops while the snapshot is pending, rejoin on `chat_share presence`). Canvas reuses `canvas-sync.js` (`mergeShapes` as the op = full shapes array, merged on arrival).

## Other surfaces (not Chats; same daemon, available now)
Calls: `chats.call.state|join|hangup|mute|setup` + `chat_call`. Bots: `chats.bots.list|add|edit|model|effort|remove|stop`. Agents: `chats.agents.state`, `chats.agent.add|remove|custom|recheck|set|choices|config|action|cli|commands|answer|invite|kick|leave`, `chats.ai.set|clear`. Docs: `chats.docs.list|url|get|new|set|rename|remove`. Settings: `chats.settings.get`, `chats.settings.set{key:notify|soundMode|notifySound|ringSound|alerts|updateCheck|acp|web|agents|lan|folder.*|section.toggle, value}`. Stats: `chats.stats`. Not exposed at all: Terminal tab/`/terminal`/`/run` (desktop has real panes), theme/accent/density/mouse/sidebar (Ink host), `/update`, `/quit`.

## Engine hosting (daemon)
One `Engine` in the daemon on the same data dir as the terminal pager, same PAGER_* env projection. Created on the first `chats.*` request except `chats.caps`/`chats.commands`/`chats.yield`, or at daemon start when the desktop setting `chatsOn` is true. It holds `<dir>/pager.lock`, and the engine outlives the Chats block and windows, so the lock is held until the daemon stops or yields. A terminal pager started later (this build or newer) finds the holder is the daemon, sends `chats.yield`, and takes the lock; an older terminal pager cannot be asked and prints "pager is already running (pid <daemon>)". After a yield the daemon stays off the lock for `HANDOFF_SETTLE_MS` (3 s) whatever asks it to start (a request, a client disconnecting, the watcher below), so the pager that asked cannot lose the race for the file. When the terminal pager was first, `chats.state` returns `status:'conflict'` with its pid and `chats_status` events carry the same. While a window is subscribed, the daemon looks at the lock again every 1.5 s (silently: one `conflict` event, no flicker) and starts the engine as soon as it is free, so the block flips to ready by itself when the terminal pager quits; `chats.retry` still tries at once. With no window subscribed the daemon does not take the lock back. Locked identity: `status:'locked'` until `chats.unlock` (or `PAGER_PASSPHRASE`). The engine stops with the daemon. With no client subscribed to chat events no chat is "open" and no read receipts are sent. OS notifications/sounds follow the user's notify/sound settings.
