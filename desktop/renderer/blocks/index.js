// The blocks a pane can show. Each module default-exports { id, title, icon, hotkey?, mount(el, ctx) }.
export const BLOCKS = [
  { id: 'home', load: () => import('./home.js') },
  { id: 'files', load: () => import('./files.js') },
  { id: 'git', load: () => import('./git.js') },
  { id: 'database', load: () => import('./database.js') },
  { id: 'notebook', load: () => import('./notebook.js') },
  { id: 'board', load: () => import('./board.js') },
  { id: 'tasks', load: () => import('./tasks.js') },
  { id: 'screen', load: () => import('./screen.js') },
  { id: 'canvas', load: () => import('./canvas.js') },
  { id: 'chats', load: () => import('./chats.js') },
  { id: 'surface', load: () => import('../surface/block.js') },
]
