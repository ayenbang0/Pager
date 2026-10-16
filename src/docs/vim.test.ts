import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Effect, KeyInput, Register, VimState } from './vim.js'
import { clampCursor, handleKey, initialVim, selection } from './vim.js'

interface Run {
  text: string
  cursor: number
  mode: VimState['mode']
  register: Register
  effects: Effect[]
  message: string
  state: VimState
  edits: number
}

const NAMED: Record<string, NonNullable<KeyInput['named']>> = {
  Esc: 'escape',
  CR: 'return',
  BS: 'backspace',
  Del: 'delete',
  Left: 'left',
  Right: 'right',
  Up: 'up',
  Down: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Tab: 'tab',
}

/** `<Esc>` `<CR>` `<BS>` `<C-r>` `<Left>` ... tokens; `<lt>` is a literal '<'. Everything else is one key per char. */
function parseKeys(keys: string): KeyInput[] {
  const out: KeyInput[] = []
  for (const m of keys.matchAll(/<([A-Za-z-]+)>|([\s\S])/gu)) {
    const tok = m[1]
    if (tok === undefined) {
      out.push({ input: m[2] ?? '' })
    } else if (tok === 'lt') {
      out.push({ input: '<' })
    } else if (tok.startsWith('C-')) {
      out.push({ input: tok.slice(2), ctrl: true })
    } else if (Object.hasOwn(NAMED, tok)) {
      out.push({ input: '', named: NAMED[tok] })
    } else {
      throw new Error(`unknown key token <${tok}>`)
    }
  }
  return out
}

function run(text: string, keys: string, start = 0, opts: { height?: number; state?: VimState } = {}): Run {
  let state: VimState = opts.state ?? { ...initialVim(), cursor: start }
  let cur = text
  const effects: Effect[] = []
  let edits = 0
  for (const key of parseKeys(keys)) {
    const res = handleKey(state, key, { text: cur, height: opts.height ?? 10 })
    for (const e of res.edits) {
      assert.ok(e.pos >= 0 && e.del >= 0 && e.pos + e.del <= cur.length, `edit ${JSON.stringify(e)} out of range for ${JSON.stringify(cur)}`)
      cur = cur.slice(0, e.pos) + e.ins + cur.slice(e.pos + e.del)
      edits++
    }
    effects.push(...res.effects)
    state = res.state
    assert.ok(state.cursor >= 0 && state.cursor <= cur.length, `cursor ${state.cursor} outside ${JSON.stringify(cur)}`)
    if (state.mode !== 'insert') {
      const onNewline = cur.charAt(state.cursor) === '\n' && state.cursor > 0 && cur.charAt(state.cursor - 1) !== '\n'
      const pastEnd = state.cursor === cur.length && cur.length > 0 && cur.charAt(cur.length - 1) !== '\n'
      assert.ok(!onNewline && !pastEnd, `cursor ${state.cursor} rests off-line in ${JSON.stringify(cur)}`)
    }
  }
  return { text: cur, cursor: state.cursor, mode: state.mode, register: state.register, effects, message: state.message, state, edits }
}

test('h and l stay on their line and clamp at the ends', () => {
  assert.equal(run('abc', 'l').cursor, 1)
  assert.equal(run('abc', '3l').cursor, 2)
  assert.equal(run('abc', 'h').cursor, 0)
  assert.equal(run('ab\ncd', 'l', 1).cursor, 1)
  assert.equal(run('ab\ncd', 'h', 3).cursor, 3)
  assert.equal(run('abc', '<Right><Right><Left>').cursor, 1)
})

test('j and k keep the goal column across short lines', () => {
  const text = 'abcdef\nab\nabcdef'
  assert.equal(run(text, 'j', 5).cursor, 8)
  assert.equal(run(text, 'jj', 5).cursor, 15)
  assert.equal(run(text, 'jjk', 5).cursor, 8)
  assert.equal(run(text, '<Down><Down><Up>', 5).cursor, 8)
  assert.equal(run(text, 'k', 5).cursor, 5)
  assert.equal(run(text, 'j', 5).state.goal, 5)
  assert.equal(run(text, 'jjl', 5).state.goal, -1)
})

test('0 ^ $ and Home/End', () => {
  assert.equal(run('  foo bar', '0', 5).cursor, 0)
  assert.equal(run('  foo bar', '^', 5).cursor, 2)
  assert.equal(run('  foo bar', '$').cursor, 8)
  assert.equal(run('  foo bar', '<Home>', 5).cursor, 0)
  assert.equal(run('  foo bar', '<End>').cursor, 8)
  assert.equal(run('ab\n\ncd', '$', 3).cursor, 3)
  assert.equal(run('ab\ncd\nef', '2$').cursor, 4)
})

test('word motions: w W b B e E', () => {
  const t = 'foo.bar baz'
  assert.equal(run(t, 'w').cursor, 3)
  assert.equal(run(t, 'ww').cursor, 4)
  assert.equal(run(t, '3w').cursor, 8)
  assert.equal(run(t, 'W').cursor, 8)
  assert.equal(run(t, 'e').cursor, 2)
  assert.equal(run(t, 'ee').cursor, 3)
  assert.equal(run(t, 'eee').cursor, 6)
  assert.equal(run(t, 'E').cursor, 6)
  assert.equal(run(t, 'b', 10).cursor, 8)
  assert.equal(run(t, '3b', 10).cursor, 3)
  assert.equal(run(t, 'BB', 10).cursor, 0)
})

test('word motions cross newlines and stop on empty lines', () => {
  assert.equal(run('foo\nbar', 'w').cursor, 4)
  assert.equal(run('a\n\nb', 'w').cursor, 2)
  assert.equal(run('a\n\nb', 'ww').cursor, 3)
  assert.equal(run('a\n\nb', 'b', 3).cursor, 2)
  assert.equal(run('foo bar', 'w', 4).cursor, 6)
})

test('gg and G, with counts as line numbers', () => {
  const t = 'a\nb\nc\nd'
  assert.equal(run(t, 'G').cursor, 6)
  assert.equal(run(t, 'gg', 6).cursor, 0)
  assert.equal(run(t, '2G').cursor, 2)
  assert.equal(run(t, '3gg', 6).cursor, 4)
  assert.equal(run(t, '9G').cursor, 6)
  assert.equal(run('a\n  b', 'G').cursor, 4)
})

test('paragraph motions } and {', () => {
  const t = 'a\nb\n\nc\nd\n\ne'
  assert.equal(run(t, '}').cursor, 4)
  assert.equal(run(t, '}}').cursor, 9)
  assert.equal(run(t, '}}}').cursor, 10)
  assert.equal(run(t, '{', 10).cursor, 9)
  assert.equal(run(t, '{{', 10).cursor, 4)
  assert.equal(run(t, '{{{', 10).cursor, 0)
  assert.equal(run(t, '2}').cursor, 9)
})

test('f F t T with ; and , repeats', () => {
  const t = 'ab-cd-ef'
  assert.equal(run(t, 'f-').cursor, 2)
  assert.equal(run(t, 'f-;').cursor, 5)
  assert.equal(run(t, 'f-;,').cursor, 2)
  assert.equal(run(t, '2f-').cursor, 5)
  assert.equal(run(t, 't-').cursor, 1)
  assert.equal(run(t, 't-;').cursor, 4)
  assert.equal(run(t, 'F-', 7).cursor, 5)
  assert.equal(run(t, 'T-', 7).cursor, 6)
  assert.equal(run(t, 'fz').cursor, 0)
  assert.equal(run('abc,def', 'df,').text, 'def')
  assert.equal(run('abcxdef', 'dtx').text, 'xdef')
  assert.equal(run('abcxdef', 'dFx', 4).text, 'abcdef')
  assert.equal(run(t, 'f-', 0).state.lastFind, 'f-')
})

test('Ctrl+D/U move half a page and PageDown/PageUp a whole page', () => {
  const t = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
  assert.equal(run(t, '<C-d>', 0, { height: 4 }).cursor, 6)
  assert.equal(run(t, '<PageDown>', 0, { height: 4 }).cursor, 12)
  assert.equal(run(t, '<C-d><C-u>', 0, { height: 4 }).cursor, 0)
  assert.equal(run(t, '<PageDown><PageUp>', 6, { height: 4 }).cursor, 6)
  assert.equal(run(t, '<PageDown><PageDown><PageDown><PageDown>', 0, { height: 4 }).cursor, 27)
})

test('d with charwise motions', () => {
  assert.equal(run('one two three', 'dw').text, 'two three')
  assert.equal(run('foo bar', 'de').text, ' bar')
  assert.equal(run('foo bar', 'db', 4).text, 'bar')
  const dollar = run('foo bar', 'd$', 4)
  assert.equal(dollar.text, 'foo ')
  assert.equal(dollar.cursor, 3)
  assert.equal(run('foo bar', 'D', 4).text, 'foo ')
  assert.equal(run('foo bar', 'd0', 4).text, 'bar')
  assert.equal(run('  foo', 'd^', 4).text, '  o')
  assert.equal(run('foo bar', 'dl').text, 'oo bar')
  assert.equal(run('foo bar', 'dh', 3).text, 'fo bar')
})

test('dw on the last word of a line keeps the line break', () => {
  assert.equal(run('foo\nbar', 'dw').text, '\nbar')
  assert.equal(run('foo bar\nbaz', 'dw', 4).text, 'foo \nbaz')
  assert.equal(run('foo', 'dw').text, '')
})

test('d with linewise motions j k G gg', () => {
  assert.equal(run('a\nb\nc', 'dj').text, 'c')
  assert.equal(run('a\nb\nc', 'dk', 2).text, 'c')
  assert.equal(run('a\nb\nc', 'dG', 2).text, 'a')
  assert.equal(run('a\nb\nc', 'dgg', 2).text, 'c')
  assert.deepEqual(run('a\nb\nc', 'dgg', 2).register, { text: 'a\nb\n', line: true })
  assert.equal(run('a\nb\nc', 'd2G').text, 'c')
  assert.equal(run('a', 'dj').text, 'a')
})

test('d} and d{ are charwise exclusive', () => {
  const r = run('a\nb\n\nc', 'd}')
  assert.equal(r.text, '\n\nc')
  assert.deepEqual(r.register, { text: 'a\nb', line: false })
  assert.equal(run('a\n\nb\nc', 'd{', 5).text, 'a\n\nc')
})

test('dd, counts and the last line', () => {
  assert.equal(run('a\nb\nc', 'dd', 2).text, 'a\nc')
  assert.equal(run('a\nb\nc', '2dd').text, 'c')
  assert.deepEqual(run('a\nb\nc', 'dd', 2).register, { text: 'b\n', line: true })
  const last = run('a\nb\nc', 'dd', 4)
  assert.equal(last.text, 'a\nb')
  assert.equal(last.cursor, 2)
  assert.deepEqual(last.register, { text: 'c\n', line: true })
  assert.equal(run('only', 'dd').text, '')
  assert.equal(run('a\nb', '5dd').text, '')
  assert.equal(run('  a\n  b', 'dd').cursor, 2)
})

test('counts multiply: 3x, 2dw, d2w, 2d3w, and 0 after a digit', () => {
  assert.equal(run('abcdef', '3x').text, 'def')
  assert.deepEqual(run('abcdef', '3x').register, { text: 'abc', line: false })
  assert.equal(run('a b c d', '2dw').text, 'c d')
  assert.equal(run('a b c d', 'd2w').text, 'c d')
  assert.equal(run('a b c d e f g h', '2d3w').text, 'g h')
  assert.equal(run('abcdefghijkl', '10x').text, 'kl')
  assert.equal(run('a b c d', '3dw').state.pending, '')
})

test('pending shows the partial command and Escape clears it', () => {
  assert.equal(run('abc', '2d').state.pending, '2d')
  assert.equal(run('abc', 'g').state.pending, 'g')
  assert.equal(run('abc', '"').state.pending, '"')
  assert.equal(run('abc', 'r').state.pending, 'r')
  assert.equal(run('abc', 'd<Esc>').state.pending, '')
  assert.equal(run('abc', 'dz').state.pending, '')
  assert.equal(run('abc', 'dz').text, 'abc')
  assert.equal(run('abc', '"ayy').register.text, 'abc\n')
})

test('c operators end in insert mode', () => {
  const cw = run('foo bar', 'cw')
  assert.equal(cw.text, ' bar')
  assert.equal(cw.mode, 'insert')
  assert.equal(run('foo bar', 'cwx<Esc>').text, 'x bar')
  assert.equal(run('foo bar', 'cw', 2).text, 'fo bar')
  assert.equal(run('a   b', 'cw', 1).text, 'ab')
  assert.equal(run('foo bar baz', 'c2w').text, ' baz')
  assert.equal(run('foo bar', 'cc').text, '')
  assert.equal(run('foo\nbar', 'ccX<Esc>').text, 'X\nbar')
  assert.equal(run('foo bar', 'C', 4).text, 'foo ')
  assert.equal(run('foo bar', 'ce').text, ' bar')
  assert.equal(run('a\nb\nc', 'cj').text, '\nc')
})

test('y operators fill the register and emit yank effects', () => {
  const yw = run('foo bar', 'yw')
  assert.deepEqual(yw.register, { text: 'foo ', line: false })
  assert.deepEqual(yw.effects, [{ kind: 'yank', text: 'foo ' }])
  assert.equal(yw.text, 'foo bar')
  const yy = run('foo\nbar', 'yy')
  assert.deepEqual(yy.register, { text: 'foo\n', line: true })
  assert.deepEqual(yy.effects, [{ kind: 'yank', text: 'foo\n' }])
  assert.equal(run('a\nb', 'Y', 2).register.text, 'b\n')
  assert.equal(run('a\nb\nc', '2yy').register.text, 'a\nb\n')
  assert.equal(run('a\nb', 'yk', 2).cursor, 0)
  assert.equal(run('foo bar', 'yb', 4).cursor, 0)
  assert.equal(run('foo bar', 'y$', 4).register.text, 'bar')
})

test('x X s S and the register they fill', () => {
  const x = run('abc', 'x', 2)
  assert.equal(x.text, 'ab')
  assert.equal(x.cursor, 1)
  assert.deepEqual(x.register, { text: 'c', line: false })
  assert.equal(run('abc', 'X', 2).text, 'ac')
  const s = run('abc', 'sZ<Esc>')
  assert.equal(s.text, 'Zbc')
  assert.equal(run('a\nb', 'SZ<Esc>').text, 'Z\nb')
  assert.equal(run('', 'x').register.text, '')
})

test('p and P with charwise registers', () => {
  const p = run('ab', 'ylp')
  assert.equal(p.text, 'aab')
  assert.equal(p.cursor, 1)
  assert.equal(run('ab', 'ylP').text, 'aab')
  assert.equal(run('foo bar', 'dw$p').text, 'barfoo ')
  assert.equal(run('foo bar', 'dw$p').cursor, 6)
  assert.equal(run('ab', 'yl3p').text, 'aaaab')
  assert.equal(run('a b', 'dwP').text, 'a b')
  assert.equal(run('p', 'p').text, 'p')
})

test('p and P with linewise registers', () => {
  const p = run('a\nb', 'yyp')
  assert.equal(p.text, 'a\na\nb')
  assert.equal(p.cursor, 2)
  const P = run('a\nb', 'yyjP')
  assert.equal(P.text, 'a\na\nb')
  assert.equal(P.cursor, 2)
  assert.equal(run('a\nb', 'yyjp').text, 'a\nb\na')
  assert.equal(run('a\nb', 'yyjp').cursor, 4)
  assert.equal(run('a', 'yy2p').text, 'a\na\na')
  assert.equal(run('a\nb\n', 'yyjp').text, 'a\nb\na\n')
  assert.equal(run('  a\nb', 'yyjp').cursor, 8)
  assert.equal(run('a\nb\nc', 'ddp').text, 'b\na\nc')
})

test('J joins with a single space', () => {
  const j = run('a\n  b\nc', 'J')
  assert.equal(j.text, 'a b\nc')
  assert.equal(j.cursor, 1)
  assert.equal(run('a\n  b\nc', '3J').text, 'a b c')
  assert.equal(run('a \nb', 'J').text, 'a b')
  assert.equal(run('a\n)', 'J').text, 'a)')
  assert.equal(run('a\n\nb', 'J').text, 'a\nb')
  assert.equal(run('a\nb', 'J', 2).text, 'a\nb')
  assert.equal(run('a\nb\nc', '9J').text, 'a b c')
})

test('r, ~, u and Ctrl+R', () => {
  assert.equal(run('abc', 'rx').text, 'xbc')
  const r2 = run('abc', '2rx')
  assert.equal(r2.text, 'xxc')
  assert.equal(r2.cursor, 1)
  assert.equal(run('abc', '5rx').text, 'abc')
  assert.equal(run('abc', 'r<Left>').text, 'abc')
  assert.equal(run('aBc', '~').text, 'ABc')
  assert.equal(run('aBc', '~').cursor, 1)
  const t3 = run('aBc', '3~')
  assert.equal(t3.text, 'AbC')
  assert.equal(t3.cursor, 2)
  assert.deepEqual(run('abc', 'u').effects, [{ kind: 'undo' }])
  assert.deepEqual(run('abc', '<C-r>').effects, [{ kind: 'redo' }])
})

test('entering insert mode: i a I A', () => {
  assert.equal(run('abc', 'a').cursor, 1)
  assert.equal(run('abc', 'a').mode, 'insert')
  assert.equal(run('abc', 'A').cursor, 3)
  assert.equal(run('  abc', 'I', 4).cursor, 2)
  assert.equal(run('abc', 'ix<Esc>').text, 'xabc')
  assert.equal(run('abc', 'Ax<Esc>').text, 'abcx')
  assert.equal(run('', 'a').cursor, 0)
})

test('o and O copy indentation and continue markdown lists', () => {
  assert.equal(run('- foo', 'o').text, '- foo\n- ')
  assert.equal(run('- foo', 'o').cursor, 8)
  assert.equal(run('1. foo', 'o').text, '1. foo\n2. ')
  assert.equal(run('9. foo', 'o').text, '9. foo\n10. ')
  assert.equal(run('  * foo', 'o').text, '  * foo\n  * ')
  assert.equal(run('+ foo', 'o').text, '+ foo\n+ ')
  assert.equal(run('  foo', 'o').text, '  foo\n  ')
  assert.equal(run('foo', 'o').text, 'foo\n')
  assert.equal(run('- ', 'o').text, '- \n')
  assert.equal(run('- foo', 'obar<Esc>').text, '- foo\n- bar')
  assert.equal(run('- foo', 'O').text, '- \n- foo')
  assert.equal(run('- foo', 'O').cursor, 2)
  assert.equal(run('a\n  b', 'Ox<Esc>', 2).text, 'a\n  x\n  b')
  assert.equal(run('**bold**', 'o').text, '**bold**\n')
})

test('Enter in insert mode continues lists and removes an empty marker', () => {
  assert.equal(run('- foo', 'A<CR>bar').text, '- foo\n- bar')
  assert.equal(run('- foo', 'A<CR><CR>').text, '- foo\n')
  assert.equal(run('- foo', 'A<CR><CR>').cursor, 6)
  assert.equal(run('1. a', 'A<CR>').text, '1. a\n2. ')
  assert.equal(run('  foo', 'A<CR>x').text, '  foo\n  x')
  assert.equal(run('- foo bar', 'i<CR>').text, '\n- foo bar')
  assert.equal(run('- foo bar', 'llllli<CR>').text, '- foo\n-  bar')
  assert.equal(run('- foo', 'I<CR>').text, '\n- foo')
  assert.equal(run('abc', 'A<CR>').text, 'abc\n')
})

test('insert mode editing keys', () => {
  assert.equal(run('ab', 'A<BS>').text, 'a')
  assert.equal(run('a\nb', 'i<BS>', 2).text, 'ab')
  assert.equal(run('a\nb', 'i<BS>', 2).cursor, 1)
  assert.equal(run('ab', 'i<BS>').text, 'ab')
  assert.equal(run('abc', 'i<Del>').text, 'bc')
  assert.equal(run('abc', 'A<Del>').text, 'abc')
  assert.equal(run('abc', 'A<Left>X').text, 'abXc')
  assert.equal(run('abc', 'A<Home>X').text, 'Xabc')
  assert.equal(run('abc', 'i<End>X').text, 'abcX')
  assert.equal(run('abc', 'i<Right>X').text, 'aXbc')
  assert.equal(run('ab', 'i<Tab>').text, '  ab')
  assert.equal(run('foo bar', 'A<C-w>').text, 'foo ')
  assert.equal(run('foo bar', 'A<C-w><C-w>').text, '')
  assert.equal(run('foo bar', 'A<C-u>').text, '')
  assert.equal(run('a\nfoo', 'A<C-u>', 2).text, 'a\n')
  assert.equal(run('abc\nde', 'A<Down>X').text, 'abc\ndeX')
  assert.equal(run('abc\nde', 'A<Down><Up>X').text, 'abcX\nde')
})

test('pasted multi-character input is inserted at once, and replayed as keys in normal mode', () => {
  const ins = handleKey({ ...initialVim(), mode: 'insert' }, { input: 'hello world' }, { text: '', height: 5 })
  assert.deepEqual(ins.edits, [{ pos: 0, del: 0, ins: 'hello world' }])
  assert.equal(ins.state.cursor, 11)
  const keys = handleKey(initialVim(), { input: '2dw' }, { text: 'a b c d', height: 5 })
  assert.deepEqual(keys.edits, [{ pos: 0, del: 4, ins: '' }])
  const combo = handleKey(initialVim(), { input: 'ixyz' }, { text: 'a', height: 5 })
  assert.equal(combo.edits.map((e) => e.ins).join(''), 'xyz')
  assert.equal(combo.state.mode, 'insert')
  assert.equal(combo.state.cursor, 3)
})

test('Escape leaves insert one column left, and cancels everything else', () => {
  assert.equal(run('abc', 'A<Esc>').cursor, 2)
  assert.equal(run('abc', 'I<Esc>').cursor, 0)
  assert.equal(run('abc', 'i<Esc>', 2).cursor, 1)
  assert.equal(run('abc', 'A<Esc>').mode, 'normal')
  assert.equal(run('abc', 'vl<Esc>').mode, 'normal')
  assert.equal(run('abc', ':w<Esc>').mode, 'normal')
  assert.equal(run('abc', ':w<Esc>').state.cmdline, '')
  assert.equal(run('abc', '/a<Esc>').mode, 'normal')
  assert.equal(run('abc', '3<Esc>').state.pending, '')
})

test('text objects iw and aw', () => {
  assert.equal(run('foo bar baz', 'diw', 5).text, 'foo  baz')
  assert.equal(run('foo bar baz', 'daw', 5).text, 'foo baz')
  assert.equal(run('foo bar baz', 'daw', 5).cursor, 4)
  assert.equal(run('foo bar', 'daw', 5).text, 'foo')
  assert.equal(run('foo bar baz', 'ciwX<Esc>', 5).text, 'foo X baz')
  assert.equal(run('a   b', 'diw', 2).text, 'ab')
  assert.equal(run('foo bar baz', 'd2aw').text, 'baz')
  assert.equal(run('foo bar baz', 'yiw', 5).register.text, 'bar')
  assert.equal(run('foo.bar', 'diw', 4).text, 'foo.')
  assert.equal(run('foo bar', 'diW').text, ' bar')
})

test('text objects ip and ap', () => {
  const t = 'a\nb\n\nc'
  assert.equal(run(t, 'dip').text, '\nc')
  assert.equal(run(t, 'dap').text, 'c')
  assert.deepEqual(run(t, 'yip').register, { text: 'a\nb\n', line: true })
  assert.equal(run('a\n\nb\nc', 'dap', 3).text, 'a')
  assert.equal(run('a\n\nb', 'dip', 2).text, 'a\nb')
})

test('text objects for quotes and brackets', () => {
  assert.equal(run('say "hi there" now', 'di"').text, 'say "" now')
  assert.equal(run('say "hi there" now', 'di"', 7).text, 'say "" now')
  assert.equal(run('say "hi there" now', 'da"', 7).text, 'say now')
  assert.equal(run('say "hi" now', 'ci"X<Esc>', 6).text, 'say "X" now')
  assert.equal(run('say "" now', 'ci"X<Esc>', 4).text, 'say "X" now')
  assert.equal(run('say now', 'di"').text, 'say now')
  assert.equal(run('f(a, (b))', 'di(', 6).text, 'f(a, ())')
  assert.equal(run('f(a, (b))', 'di(', 3).text, 'f()')
  assert.equal(run('f(a, (b))', 'da(', 6).text, 'f(a, )')
  assert.equal(run('x [1, 2] y', 'di[', 4).text, 'x [] y')
  assert.equal(run('x {a} y', 'ci{Q<Esc>', 3).text, 'x {Q} y')
  assert.equal(run('x `a b` y', 'di`', 4).text, 'x `` y')
  assert.equal(run('no parens', 'di(').text, 'no parens')
})

test('indent and outdent', () => {
  assert.equal(run('a\nb', '>>').text, '  a\nb')
  assert.equal(run('a\nb\nc', '2>>').text, '  a\n  b\nc')
  assert.equal(run('    a', '<<').text, '  a')
  assert.equal(run(' a', '<<').text, 'a')
  assert.equal(run('a\n\nb', '3>>').text, '  a\n\n  b')
  assert.equal(run('\ta', '<<').text, 'a')
  assert.equal(run('a', '>>').cursor, 2)
  const three = run('a\nb\nc', '3>>')
  assert.equal(three.text, '  a\n  b\n  c')
  assert.equal(three.edits, 3)
  assert.equal(run('a', '>j').text, 'a')
})

test('visual mode: motions move the cursor, anchor stays, o swaps', () => {
  const v = run('abcd', 'vll')
  assert.equal(v.mode, 'visual')
  assert.equal(v.state.anchor, 0)
  assert.equal(v.cursor, 2)
  assert.deepEqual(selection(v.state, 'abcd'), { start: 0, end: 3, line: false })
  const swapped = run('abcd', 'vlo', 1)
  assert.equal(swapped.cursor, 1)
  assert.equal(swapped.state.anchor, 2)
  assert.deepEqual(selection(run('abcd', 'vlloh', 1).state, 'abcd'), { start: 0, end: 4, line: false })
  assert.equal(selection(initialVim(), 'abc'), null)
  assert.equal(selection(run('abc', 'i').state, 'abc'), null)
})

test('visual-line mode selects whole lines', () => {
  const v = run('ab\ncd\nef', 'Vj', 1)
  assert.equal(v.mode, 'vline')
  assert.deepEqual(selection(v.state, 'ab\ncd\nef'), { start: 0, end: 5, line: true })
  assert.equal(run('a\nb', 'vV').mode, 'vline')
  assert.equal(run('a\nb', 'Vv').mode, 'visual')
  assert.equal(run('a\nb', 'vv').mode, 'normal')
  assert.equal(run('a\nb', 'VV').mode, 'normal')
})

test('visual d x y c s', () => {
  const d = run('foo bar', 'vlld')
  assert.equal(d.text, ' bar')
  assert.equal(d.mode, 'normal')
  assert.deepEqual(d.register, { text: 'foo', line: false })
  assert.equal(run('foo bar', 'vex').text, ' bar')
  const y = run('foo bar', 'vey')
  assert.equal(y.text, 'foo bar')
  assert.deepEqual(y.register, { text: 'foo', line: false })
  assert.deepEqual(y.effects, [{ kind: 'yank', text: 'foo' }])
  assert.equal(y.cursor, 0)
  assert.equal(run('foo bar', 'wvey').cursor, 4)
  assert.equal(run('foo bar', 'vecX<Esc>').text, 'X bar')
  assert.equal(run('abc', 'vlsX<Esc>').text, 'Xc')
  assert.equal(run('abc', 'vlc').mode, 'insert')
  assert.equal(run('foo bar', 'wvbd').text, 'ar')
})

test('visual-line d y c', () => {
  assert.equal(run('a\nb\nc', 'Vjd').text, 'c')
  assert.equal(run('a\nb\nc', 'jVd').text, 'a\nc')
  assert.equal(run('a\nb\nc', 'jVjd').text, 'a')
  assert.deepEqual(run('a\nb\nc', 'Vjy').register, { text: 'a\nb\n', line: true })
  assert.equal(run('a\nb\nc', 'jVky').cursor, 0)
  assert.equal(run('a\nb\nc', 'Vjcx<Esc>').text, 'x\nc')
  assert.equal(run('a\nb', 'Vyjp').text, 'a\nb\na')
  assert.equal(run('a\nb\nc', 'VGd').text, '')
})

test('visual > < ~ J and text objects', () => {
  assert.equal(run('a\nb', 'Vj>').text, '  a\n  b')
  assert.equal(run('a\nb', 'Vj2>').text, '    a\n    b')
  assert.equal(run('    a\n    b', 'Vj<').text, '  a\n  b')
  assert.equal(run('abc', 'vl~').text, 'ABc')
  assert.equal(run('a\nb\nc', 'VjJ').text, 'a b\nc')
  assert.equal(run('foo bar', 'viwd').text, ' bar')
  assert.equal(run('a\nb\n\nc', 'vipd').text, '\nc')
  assert.equal(run('say "hi"', 'vi"y', 5).register.text, 'hi')
  assert.equal(run('abc', 'v>').text, '  abc')
})

test('command mode: w q q! wq x qa rename', () => {
  const w = run('abc', ':w<CR>')
  assert.deepEqual(w.effects, [{ kind: 'save' }])
  assert.equal(w.message, 'saved (changes sync automatically)')
  assert.equal(w.mode, 'normal')
  for (const cmd of ['q', 'q!', 'wq', 'x']) assert.deepEqual(run('abc', `:${cmd}<CR>`).effects, [{ kind: 'close' }], cmd)
  for (const cmd of ['qa', 'qa!']) assert.deepEqual(run('abc', `:${cmd}<CR>`).effects, [{ kind: 'quit' }], cmd)
  assert.deepEqual(run('abc', ':rename My notes<CR>').effects, [{ kind: 'rename', name: 'My notes' }])
  assert.deepEqual(run('abc', 'ZZ').effects, [{ kind: 'close' }])
  assert.equal(run('abc', ':rename<CR>').effects.length, 0)
})

test('command line editing and unknown commands', () => {
  const typing = run('abc', ':wq')
  assert.equal(typing.mode, 'command')
  assert.equal(typing.state.cmdline, 'wq')
  assert.equal(run('abc', ':wq<BS>').state.cmdline, 'w')
  assert.equal(run('abc', ':<BS>').mode, 'normal')
  assert.equal(run('abc', ':foo<CR>').message, 'not a command: foo')
  assert.equal(run('abc', ':<CR>').mode, 'normal')
  assert.equal(run('abc', ':q<CR>x').message, '')
  assert.equal(run('abc', ':w<CR>x').text, 'bc')
})

test(':N jumps to a line, clamped', () => {
  const t = 'a\n  b\nc'
  assert.equal(run(t, ':2<CR>').cursor, 4)
  assert.equal(run(t, ':1<CR>', 6).cursor, 0)
  assert.equal(run(t, ':99<CR>').cursor, 6)
  assert.equal(run(t, ':0<CR>', 6).cursor, 0)
})

test(':s substitutes on the current line, all lines or the visual lines', () => {
  const g = run('aXa\naXa', ':%s/a/b/g<CR>')
  assert.equal(g.text, 'bXb\nbXb')
  assert.equal(g.message, '4 substitutions')
  assert.equal(run('aXa\naXa', ':%s/a/b/<CR>').text, 'bXa\nbXa')
  assert.equal(run('aXa\naXa', ':s/a/b/<CR>', 4).text, 'aXa\nbXa')
  assert.equal(run('aXa\naXa', ':s/a/b/g<CR>', 4).text, 'aXa\nbXb')
  assert.equal(run('one two', ':s/(\\w+) (\\w+)/$2 $1/<CR>').text, 'two one')
  assert.equal(run('abc', ':s/b/[$&]/<CR>').text, 'a[b]c')
  assert.equal(run('a/b', ':s#/#-#<CR>').text, 'a-b')
  assert.equal(run('a\na\na', 'Vj:s/a/b/<CR>').text, 'b\nb\na')
  assert.equal(run('a\na\na', 'Vj:').state.cmdline, "'<,'>")
  assert.equal(run('a\na\na', ':%s/a//<CR>').text, '\n\n')
})

test(':s with a bad pattern or no match changes nothing', () => {
  const bad = run('a(b', ':%s/(/x/<CR>')
  assert.equal(bad.message, 'bad pattern')
  assert.equal(bad.text, 'a(b')
  assert.equal(bad.edits, 0)
  assert.equal(run('abc', ':%s/z/y/<CR>').message, '0 substitutions')
  assert.equal(run('abc', ':%s/a/b/q<CR>').message, 'not a command: s/a/b/q')
})

test('search with / jumps, n and N repeat, with wrap', () => {
  const t = 'foo bar foo baz'
  const s = run(t, '/foo<CR>')
  assert.equal(s.cursor, 8)
  assert.equal(s.state.search, 'foo')
  assert.equal(s.mode, 'normal')
  const wrapped = run(t, '/foo<CR>n')
  assert.equal(wrapped.cursor, 0)
  assert.equal(wrapped.message, 'search hit BOTTOM, continuing at TOP')
  assert.equal(run(t, '/foo<CR>nN').cursor, 8)
  assert.equal(run(t, '/foo<CR>N').cursor, 0)
  assert.equal(run(t, '/foo<CR>N').message, '')
  assert.equal(run(t, '/zzz<CR>').message, 'pattern not found: zzz')
  assert.equal(run(t, '/zzz<CR>').cursor, 0)
  assert.equal(run(t, 'n').message, 'no previous search pattern')
  assert.equal(run(t, '/bar<CR>').cursor, 4)
  assert.equal(run(t, '/b<BS>').state.cmdline, '')
  assert.equal(run(t, '/<BS>').mode, 'normal')
  assert.equal(run(t, '/o<CR>2n').cursor, 9)
})

test('edits come out in order against the evolving text', () => {
  const three = handleKey(initialVim(), { input: '3' }, { text: 'a\nb\nc', height: 5 })
  const shifted = handleKey(three.state, { input: '>' }, { text: 'a\nb\nc', height: 5 })
  const done = handleKey(shifted.state, { input: '>' }, { text: 'a\nb\nc', height: 5 })
  assert.deepEqual(done.edits, [
    { pos: 4, del: 0, ins: '  ' },
    { pos: 2, del: 0, ins: '  ' },
    { pos: 0, del: 0, ins: '  ' },
  ])
  const j = run('a\nb\nc', '3J')
  assert.equal(j.text, 'a b c')
  assert.equal(j.edits, 2)
  const sub = run('a\nb', ':%s/./x/<CR>')
  assert.equal(sub.edits, 1)
  assert.equal(sub.text, 'x\nx')
})

test('the cursor never rests on a newline in normal mode', () => {
  assert.equal(run('ab\ncd', '$x').text, 'a\ncd')
  assert.equal(run('ab\ncd', '$x').cursor, 0)
  assert.equal(run('ab\ncd', 'A<Esc>').cursor, 1)
  assert.equal(run('ab\ncd', 'lllll').cursor, 1)
  assert.equal(run('ab\n\ncd', 'j$').cursor, 3)
  assert.equal(run('ab\ncd', 'vj$').cursor, 4)
  assert.equal(run('ab\ncd\n', 'G').cursor, 6)
  assert.equal(run('ab\ncd', 'dw', 3).text, 'ab\n')
})

test('clampCursor pulls cursor and anchor into the new text', () => {
  const st: VimState = { ...initialVim(), cursor: 9, anchor: 8 }
  assert.equal(clampCursor(st, 'abc').cursor, 2)
  assert.equal(clampCursor(st, 'abc').anchor, 2)
  assert.equal(clampCursor({ ...st, cursor: 3 }, 'abc\n').cursor, 2)
  assert.equal(clampCursor({ ...st, cursor: 9 }, 'abc\n').cursor, 4)
  assert.equal(clampCursor({ ...st, cursor: 4 }, 'abc\nd').cursor, 4)
  assert.equal(clampCursor({ ...st, cursor: 4 }, 'abc\n\n').cursor, 4)
  assert.equal(clampCursor({ ...st, cursor: 3 }, 'abc\nx').mode, 'normal')
  assert.equal(clampCursor({ ...st, mode: 'insert', cursor: 9 }, 'abc').cursor, 3)
  assert.equal(clampCursor(st, '').cursor, 0)
})

test('empty document: every command is safe', () => {
  const keys = ['x', 'X', 'dd', 'cc<Esc>', 'D', 'p', 'P', 'J', 'rx', '~', 'w', 'b', 'e', '$', '0', '^', 'G', 'gg', '}', '{', 'j', 'k', 'dw', 'yy', 'yw', '>>', '<<', 'diw', 'dap', 'ci"', 'f,', ';', 'n', 'u', 'vd', 'Vd', 'vy', ':%s/a/b/<CR>', ':3<CR>', '/a<CR>', 'A<BS><Del><C-w><C-u><Esc>', '<C-d><C-u><PageDown><PageUp>']
  for (const k of keys) {
    const r = run('', k)
    assert.equal(r.text, '', k)
    assert.equal(r.cursor, 0, k)
  }
  assert.equal(run('', 'o').text, '\n')
  assert.equal(run('', 'ihi<Esc>').text, 'hi')
  assert.equal(run('', 'O').text, '\n')
  assert.equal(run('', 'yyp').text, '\n')
})

test('unknown keys do nothing and clear pending and message', () => {
  const base = run('abc', 'l')
  const q = handleKey(base.state, { input: 'Q' }, { text: 'abc', height: 5 })
  assert.equal(q.edits.length, 0)
  assert.equal(q.effects.length, 0)
  assert.equal(q.state.cursor, 1)
  assert.equal(q.state.mode, 'normal')
  const z = handleKey({ ...base.state, pending: '2', message: 'old' }, { input: 'z', ctrl: true }, { text: 'abc', height: 5 })
  assert.equal(z.state.pending, '')
  assert.equal(z.state.message, '')
  const tab = handleKey(base.state, { input: '', named: 'tab' }, { text: 'abc', height: 5 })
  assert.equal(tab.edits.length, 0)
  assert.equal(handleKey(base.state, { input: '' }, { text: 'abc', height: 5 }).state.cursor, 1)
})

test('handleKey does not mutate its inputs', () => {
  const state = Object.freeze({ ...initialVim(), register: Object.freeze({ text: 'x', line: false }) })
  const key = Object.freeze({ input: 'd' })
  const r = handleKey(state, key, { text: 'abc', height: 5 })
  assert.equal(state.pending, '')
  assert.equal(r.state.pending, 'd')
  assert.notEqual(r.state, state)
  const del = handleKey(Object.freeze({ ...initialVim(), pending: 'd' }), Object.freeze({ input: 'd' }), { text: 'abc', height: 5 })
  assert.equal(del.state.register.text, 'abc\n')
})

test('unicode and CR are ordinary characters', () => {
  assert.equal(run('héllo wörld', 'dw').text, 'wörld')
  assert.equal(run('a\r\nb', '$').cursor, 1)
  assert.equal(run('a\r\nb', 'dd').text, 'b')
  assert.equal(run('😀 ab', 'x').text, '\uDE00 ab')
})

test('every printable ASCII character types literally in insert mode and in the : and / command lines', () => {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
  // Single keys, as a terminal delivers them: no character may act as a shortcut once typing has started.
  const insert = run('', 'i')
  let state = insert.state
  let text = ''
  for (const ch of printable) {
    const res = handleKey(state, { input: ch }, { text, height: 10 })
    for (const e of res.edits) text = text.slice(0, e.pos) + e.ins + text.slice(e.pos + e.del)
    state = res.state
  }
  assert.equal(text, printable)
  assert.equal(state.mode, 'insert')
  for (const lead of [':', '/']) {
    let s = initialVim()
    s = handleKey(s, { input: lead }, { text: 'abc', height: 10 }).state
    for (const ch of printable) s = handleKey(s, { input: ch }, { text: 'abc', height: 10 }).state
    assert.equal(s.cmdline, printable, `after ${lead}`)
  }
})
