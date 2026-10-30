// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { excerptOf, languageOf, tokenize } from './code'
import { blocks, inline, items, wrap } from './markdown'
import { lineOf, pathOfSpan, pathsIn, resolve } from './paths'
import { WINDOWS, WINDOWS_TYPES, encodedCommand } from './window'

const VIDEO = '/Users/ana/videos/borrador.mp4'
const FOLDER = '/Users/ana/videos'
const README = '/project/app/README.md'
const SOURCE = '/project/app/src/app.ts'
const CODE = ['import { run } from \'./run\'', '', '// Starts it', 'export async function start (port: number) {', '  const server = await run(port)', '  return server', '}', ''].join('\n')
// The engine hands a hook the path as the host writes it: on a Windows host, `/a/b` is `C:\a\b`.
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
const SCREEN = { columns: 60, rows: 40, isFullscreen: true }

/**
 * Everything beneath the mod: the session, the files that are there, the programs it runs, the
 * window's program, and what the engine draws.
 */
function world (on: On, { system = 'Darwin', env = {}, cwd = '/project/app', program = 'shows' }: { system?: string; env?: Record<string, string>; cwd?: string; program?: 'shows' | 'fails' } = {}) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/Users/ana', ...env })
  const there: Record<string, 'file' | 'dir'> = { [VIDEO]: 'file', [FOLDER]: 'dir', [README]: 'file', [SOURCE]: 'file' }
  const runs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: '/project/app' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? `${system}\n` : e.argv[0] === 'wslpath' ? 'C:\\Users\\ana\\videos\\borrador.mp4\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) => {
    const path = posix(e.path)
    const kind = there[path]
    if (!kind) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind, size: path === SOURCE ? CODE.length : 12 * 1024 * 1024, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => (posix(e.path) === SOURCE ? { value: CODE } : { deny: `ENOENT: ${e.path}` }))
  // The window's program: it says `shown`, then `.` every tenth of a second till it is ended; or,
  // where the system lets it show none, an error, and it ends.
  const windows: { argv: string[]; env: Record<string, string>; isEnded: boolean }[] = []
  on('process.spawn', async function * ($, e) {
    const opened = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    windows.push(opened)
    try {
      if (program === 'fails') {
        yield { stream: 'stdout' as const, text: 'error: Cannot add type. Compilation is not allowed here.\n' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout' as const, text: 'shown\n' }
      for (;;) {
        await clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.\n' }
      }
    } finally {
      opened.isEnded = true
    }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  return { clock, runs, windows, logs }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project/app', surface: 'terminal', isInteractive: true })
const reply = ($: Engine, text: string, viewport: { columns: number; rows: number; isFullscreen: boolean } = SCREEN) =>
  $.ui.mount({ plugin: 'quick-peek', surface: 'terminal', component: 'AssistantMessage', requestId: 'a-1', props: { text, isFirstOfReply: true }, viewport })

// The terminal shows a card over the path, not a window by the pointer.
const cards = { options: { window: false } }

test('finds absolute, home, relative and bare paths, and cuts what a sentence adds', () => {
  const found = (text: string) => pathsIn(text).map(({ start, end, target }) => [text.slice(start, end), target])
  expect(found('Lo dejé en /Users/ana/x.mp4. Y en ~/notas.md, ¿vale?')).toEqual([['/Users/ana/x.mp4', '/Users/ana/x.mp4'], ['~/notas.md', '~/notas.md']])
  expect(found('Mira src/app.ts:42 y README.md (la raíz).')).toEqual([['src/app.ts:42', 'src/app.ts'], ['README.md', 'README.md']])
  expect(found('see https://example.com/a/b.html and/or 1/2')).toEqual([['and/or', 'and/or'], ['1/2', '1/2']])
  expect(found('a word, then this')).toEqual([])
  expect(pathOfSpan('~/My Videos/a b.mp4')).toBe('~/My Videos/a b.mp4')
  expect(pathOfSpan('npm run build')).toBeUndefined()
  expect(resolve('../b/./c.txt', '/project/app', '/Users/ana')).toBe('/project/b/c.txt')
  expect(resolve('~/x', '/project/app', '/Users/ana')).toBe('/Users/ana/x')
  // On Windows the session names its folders `C:\…`: a path that lands in one keeps the drive.
  expect(resolve('src/../README.md', 'C:\\project\\app', 'C:\\Users\\ana')).toBe('C:/project/app/README.md')
  expect(resolve('~/x', 'C:\\project\\app', 'C:\\Users\\ana')).toBe('C:/Users/ana/x')
  expect(resolve('C:\\Users\\ana\\x.mp4', '/project/app', undefined)).toBe('C:\\Users\\ana\\x.mp4')
  expect(found('Mira C:/Users/ana/x.mp4 y C:\\Users\\ana\\y.md')).toEqual([['C:/Users/ana/x.mp4', 'C:/Users/ana/x.mp4'], ['C:\\Users\\ana\\y.md', 'C:\\Users\\ana\\y.md']])
})

test('a path with a line names it; a file of code or text is known by its name, and its lines are tokens', () => {
  expect(lineOf('src/app.ts:42')).toBe(42)
  expect(lineOf('src/app.ts:42:7.')).toBe(42)
  expect(lineOf('src/app.ts')).toBeUndefined()
  expect(['a.ts', 'b.tsx', 'c.html', 'd.css', 'e.json', 'f.md', 'Dockerfile', '.env.local', 'g.svg', 'h.mp4'].map(path => languageOf(path)?.name)).toEqual(['TypeScript', 'TypeScript JSX', 'HTML', 'CSS', 'JSON', 'Markdown', 'Dockerfile', 'Environment', undefined, undefined])
  expect(tokenize('const a = "x" // y', languageOf('a.js')!.grammar)).toEqual([[['k', 'const'], ['', ' a = '], ['s', '"x"'], ['', ' '], ['c', '// y']]])
  expect(tokenize('<a href="/x">hi</a>', languageOf('a.html')!.grammar)[0]).toEqual([['', '<'], ['k', 'a'], ['', ' '], ['a', 'href'], ['', '='], ['s', '"/x"'], ['', '>hi</'], ['k', 'a'], ['', '>']])
  expect(tokenize('.card { color: #fff; }', languageOf('a.css')!.grammar)[0]).toEqual([['t', '.card'], ['', ' { '], ['a', 'color'], ['', ': '], ['n', '#fff'], ['', '; }']])
  // A block comment that spans lines is a comment on each.
  expect(tokenize('/* a\nb */ x', languageOf('a.ts')!.grammar)).toEqual([[['c', '/* a']], [['c', 'b */'], ['', ' x']]])
})

test('a preview shows the first lines, or those around the one named, that one marked and the shared indent cut', () => {
  const ts = languageOf(SOURCE)!
  expect(excerptOf(CODE, ts, undefined, 3)).toMatchObject({ language: 'TypeScript', count: 7, first: 1, mark: 0, source: "import { run } from './run'\n\n// Starts it" })
  const around = excerptOf(CODE, ts, 5, 3)!
  expect(around).toMatchObject({ first: 4, mark: 5, source: 'export async function start (port: number) {\n  const server = await run(port)\n  return server' })
  expect(excerptOf('    a\n\tb\n      c', ts, undefined, 5)!.source).toBe('  a\nb\n    c')
  // Past its end, the line names nothing; a file with a NUL, or none, shows no lines.
  expect(excerptOf(CODE, ts, 99, 3)).toMatchObject({ first: 1, mark: 0 })
  expect(excerptOf('G\u0000\u0000x', ts, undefined, 3)).toBeUndefined()
  expect(excerptOf('\n  \n', ts, undefined, 3)).toBeUndefined()
})

test('wraps as the engine does: a path that does not fit moves down; one longer than a row is cut after a folder', () => {
  const rows = (text: string, width: number) => wrap([{ text, style: {}, link: 0 }], width).map(row => row.map(run => run.text).join(''))
  expect(wrap(inline('see **this** and /a/very/long/path'), 16).map(row => row.map(run => run.text))).toEqual([['see ', 'this', ' and /a/'], ['very/long/path']])
  expect(rows('/Users/ana/videos/borrador-final.mp4', 20)).toEqual(['/Users/ana/videos/', 'borrador-final.mp4'])
  expect(rows('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
})

test('cuts a reply into blocks: a list of another kind is a list of its own; a fence stays whole', () => {
  const text = 'Intro:\n\n- a\n- b\n\n1. uno\n2. dos\n\n```\n/Users/ana/x\n\n```\nfin'
  expect(blocks(text).map(block => [block.kind, block.gap])).toEqual([['paragraph', 0], ['list', 1], ['list', 1], ['other', 1], ['paragraph', 0]])
  const [first] = items('- **A**: x\n  - nested\n- B\n  more')
  expect(first).toMatchObject({ text: '**A**: x', children: [{ text: 'nested' }] })
  expect(items('- B\n  more')[0]!.text).toBe('B\nmore')
})

test('a path that leads somewhere is a link; the blocks without one are the engine\'s Markdown', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `## Hecho\n\nEl vídeo: \`${VIDEO}\`\n\nY ${FOLDER}/nada.mp4 no está.\n\n- uno\n- dos con README.md`)
  expect(await ui.find({ key: 'engine' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: '## Hecho' })).toBeDefined()
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ type: 'Client', props: { props: { label: VIDEO, path: VIDEO } } })
  expect(await ui.find({ type: 'Text', text: 'El vídeo: ' })).toBeDefined()
  // A path that is not there stays as written: its paragraph is the engine's.
  expect(await ui.find({ type: 'Markdown', text: /nada\.mp4 no está/ })).toBeDefined()
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: 'README.md', path: README } } })
  expect(await ui.find({ type: 'Text', text: '-' })).toBeDefined()
})

test('after a `cd` into a folder of the project, a relative path leads from there or else from the project', async ($, on) => {
  world(on, { cwd: '/project/app/src' })
  await startSession($)
  const ui = await reply($, 'Mira `src/app.ts`, app.ts y README.md')
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: 'src/app.ts', path: SOURCE } } })
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: 'app.ts', path: SOURCE } } })
  expect(await ui.find({ key: 'path:2:0' })).toMatchObject({ props: { props: { label: 'README.md', path: README } } })
})

test('on Windows a relative path and one from home lead from the session\'s `C:\\` folders', async ($, on) => {
  world(on, { system: '', cwd: 'C:\\project\\app', env: { OS: 'Windows_NT', HOME: 'C:\\Users\\ana' } })
  await startSession($)
  const ui = await reply($, 'Mira `src/app.ts:5` y ~/videos/borrador.mp4')
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: 'src/app.ts:5', path: 'C:/project/app/src/app.ts', line: 5 } } })
  expect(await ui.find({ key: 'path:1:0' })).toMatchObject({ props: { props: { label: '~/videos/borrador.mp4', path: 'C:/Users/ana/videos/borrador.mp4' } } })
})

test('a reply naming no path that is there is the engine\'s, and so is one off fullscreen', async ($, on) => {
  world(on)
  await startSession($)
  const missing = await reply($, 'Nada que ver en /no/existe.txt')
  expect(await missing.find({ key: 'engine' })).toBeDefined()
  await missing.unmount()
  expect(await (await reply($, `Mira ${VIDEO}`, { ...SCREEN, isFullscreen: false })).find({ key: 'engine' })).toBeDefined()
})

test('a path a row cannot hold is drawn in parts, each its own link', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`, { ...SCREEN, columns: 22 })
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: '/Users/ana/', path: VIDEO } } })
  expect(await ui.find({ key: 'path:0:1' })).toMatchObject({ props: { props: { label: 'videos/borrador.mp4', path: VIDEO } } })
})

test('the pointer on a path opens its preview by the pointer; off it, the preview closes', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]!.env).toMatchObject({ QUICK_PEEK_FILE: VIDEO })
  // A video is no code: no lines, its thumbnail shows.
  expect(w.windows[0]!.env.QUICK_PEEK_CODE).toBeUndefined()
  expect(w.windows[0]!.isEnded).toBe(false)
  await ui.pointer({ type: 'leave', x: 3, y: 0, in: 'path:0:0' })
  await w.clock.advance(300)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('a file of code shows its lines in the window, around the line its path names', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, 'El arranque está en `src/app.ts:5`.')
  expect(await ui.find({ key: 'path:0:0' })).toMatchObject({ props: { props: { label: 'src/app.ts:5', path: SOURCE, line: 5 } } })
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  const code = JSON.parse(w.windows[0]!.env.QUICK_PEEK_CODE!)
  expect(code).toMatchObject({ language: 'TypeScript', count: 7, first: 1, mark: 5 })
  expect(code.lines[4]).toEqual([['', '  '], ['k', 'const'], ['', ' server = '], ['k', 'await'], ['', ' '], ['f', 'run'], ['', '(port)']])
  expect(code.source).toBeUndefined()
  await ui.pointer({ type: 'leave', x: 3, y: 0, in: 'path:0:0' })
  await w.clock.advance(300)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('a click shows the path in Finder; an alt-click opens it', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.resize({ columns: VIDEO.length, rows: 1, in: 'path:0:0' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', '-R', VIDEO])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', VIDEO])
  // Let go away from where it went down, it is no click.
  const before = w.runs.length
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 5, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs.slice(before).filter(argv => argv[0] === 'open')).toEqual([])
})

test('without a window, each path carries a card the terminal reveals over it', cards, async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /borrador\.mp4 · 12\.0 MB · .* ago · click: show in folder/ })).toBeDefined()
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(0)
})

test('without a window, the card of a file of code shows its first lines, coloured by the engine', cards, async ($, on) => {
  world(on)
  await startSession($)
  const ui = await reply($, 'Mira src/app.ts y el vídeo ' + VIDEO)
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: CODE.trimEnd(), path: SOURCE, startLine: 1 } })
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /app\.ts · \d+ B · .* ago · click: show in folder/ })).toBeDefined()
})

test('on Linux a click asks the file manager to select the path, with no window', async ($, on) => {
  const w = world(on, { system: 'Linux' })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs.find(argv => argv[0] === 'dbus-send')).toContain(`array:string:file://${VIDEO}`)
  expect(w.windows).toHaveLength(0)
})

test('under WSL a click selects the path in Explorer', async ($, on) => {
  const w = world(on, { system: 'Linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', '/select,C:\\Users\\ana\\videos\\borrador.mp4'])
})

// A Windows session: its folders are `C:\…`, and no `uname` answers.
const WINDOWS_HOST = { system: '', cwd: 'C:\\project\\app', env: { OS: 'Windows_NT', HOME: 'C:\\Users\\ana' } }
// The longest command line Windows starts, and the longest variable it holds, in characters.
const WINDOWS_LIMIT = 32_767

test('on Windows the pointer on a path opens PowerShell\'s window, the C# it compiles told in the environment', async ($, on) => {
  const w = world(on, WINDOWS_HOST)
  await startSession($)
  const ui = await reply($, 'El arranque está en `src/app.ts:5`.')
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]!.argv).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(WINDOWS)])
  expect(w.windows[0]!.env).toMatchObject({ QUICK_PEEK_FILE: 'C:/project/app/src/app.ts', QUICK_PEEK_TYPES: WINDOWS_TYPES, QUICK_PEEK_HINT: 'click: show in Explorer · Alt click: open' })
  expect(JSON.parse(w.windows[0]!.env.QUICK_PEEK_CODE!)).toMatchObject({ language: 'TypeScript', first: 1, mark: 5 })
  await ui.pointer({ type: 'leave', x: 3, y: 0, in: 'path:0:0' })
  await w.clock.advance(300)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('on Windows the window\'s command line, and the C# in QUICK_PEEK_TYPES, fit what Windows holds', async ($, on) => {
  const w = world(on, WINDOWS_HOST)
  await startSession($)
  const ui = await reply($, 'El arranque está en `src/app.ts:5`.')
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  const { argv, env } = w.windows[0]!
  // Each argument, quoted, and a space between: the line CreateProcess is given.
  expect(argv.reduce((length, arg) => length + arg.length + 3, 0)).toBeLessThan(WINDOWS_LIMIT)
  // A variable is held as NAME=value.
  expect(`QUICK_PEEK_TYPES=${env.QUICK_PEEK_TYPES}`.length).toBeLessThan(WINDOWS_LIMIT)
  for (const [name, value] of Object.entries(env)) expect(`${name}=${value}`.length).toBeLessThan(WINDOWS_LIMIT)
})

test('on Windows, with "Preview in a window" off, the terminal shows the cards', cards, async ($, on) => {
  const w = world(on, WINDOWS_HOST)
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(0)
})

test('over SSH the window would open on the other machine: the terminal shows the cards', async ($, on) => {
  const w = world(on, { ...WINDOWS_HOST, env: { ...WINDOWS_HOST.env, SSH_CONNECTION: '10.0.0.2 52000 10.0.0.1 22' } })
  await startSession($)
  const ui = await reply($, `Listo: ${VIDEO}`)
  expect(await ui.find({ key: 'card:0:0' })).toBeDefined()
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(0)
})

test('on Windows a window that cannot show (no compiling allowed) gives the terminal the cards', async ($, on) => {
  const w = world(on, { ...WINDOWS_HOST, program: 'fails' })
  await startSession($)
  const first = await reply($, `Listo: ${VIDEO}`)
  expect(await first.find({ key: 'card:0:0' })).toBeUndefined()
  await first.pointer({ type: 'enter', x: 0, y: 0, in: 'path:0:0' })
  await w.clock.advance(100)
  expect(w.windows[0]!.isEnded).toBe(true)
  expect(w.logs).toContainEqual(expect.stringMatching(/no window \(error: Cannot add type/))
  await first.unmount()
  const again = await reply($, `Listo: ${VIDEO}`)
  expect(await again.find({ key: 'card:0:0' })).toBeDefined()
})

test('on Windows a click selects the path in Explorer; an alt-click opens it', async ($, on) => {
  const w = world(on, WINDOWS_HOST)
  await startSession($)
  const ui = await reply($, 'Mira `src/app.ts`')
  await ui.resize({ columns: 10, rows: 1, in: 'path:0:0' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer', '/select,C:\\project\\app\\src\\app.ts'])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', alt: true, in: 'path:0:0' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer', 'C:\\project\\app\\src\\app.ts'])
})
