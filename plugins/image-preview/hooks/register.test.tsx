// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { fit, parseBmp, toCells } from './pixels'

const FOLDER = '/tmp/claude-501/-project-app/s-1'
const RED = 0xff0000
const BLUE = 0x0000ff
// What sips writes for the terminal to draw: a PNG, one red pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

/** A 24-bit bottom-up BMP, as ImageMagick writes one: `rows` top first, each pixel `0xRRGGBB`. */
function bmp (rows: number[][]) {
  const width = rows[0]!.length
  const height = rows.length
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  rows.forEach((row, y) => row.forEach((color, x) => {
    const at = 54 + (height - 1 - y) * stride + x * 3
    bytes.set([color & 0xff, (color >> 8) & 0xff, color >> 16], at)
  }))
  return bytes
}

/**
 * The path as the mocked session wrote it. A Windows host hands the handlers `C:\tmp\claude-501\...`
 * for the `/tmp/claude-501/...` the mod asked about, so the world compares them the POSIX way.
 */
const posix = (path: string) => path.replace(/^[A-Za-z]:(?=[\\/])/, '').replaceAll('\\', '/')

/**
 * Everything beneath the mod: the session, its temp folder with the stored images, the prompt box,
 * sips, and what the engine draws. (A test cannot type into the box: the draft is there at start.)
 */
function world (
  on: On,
  { files = { '1.png': 300 * 1024 }, draft = '', env = {}, window = 'shown', system = 'Darwin', temp = '/tmp/claude-501', missing = [] }: { files?: Record<string, number>; draft?: string; env?: Record<string, string>; window?: 'shown' | 'error'; system?: string; temp?: string; missing?: string[] } = {}
) {
  const folder = `${temp}/-project-app/s-1`
  const box = { text: draft }
  const session = { id: 's-1' }
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { TERM_PROGRAM: 'WarpTerminal', ...env })
  const runs: string[][] = []
  // The variables each run was given, in the order of `runs`.
  const runEnvs: Record<string, string>[] = []
  // What `wslpath -w` prints for a path of the WSL distro.
  const windowsPath = (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: session.id }))
  on('session.root', () => ({ value: '/project/app' }))
  on('session.cwd', () => ({ value: '/project/app' }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    runEnvs.push({ ...e.init?.env })
    const stdout = e.argv[0] === 'id' ? '501\n' : e.argv[0] === 'uname' ? `${system}\n` : e.argv[0] === 'wslpath' ? `${windowsPath(e.argv[2]!)}\n` : ''
    return { value: { exitCode: missing.includes(e.argv[0]!) ? 127 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: posix(e.path) === `${temp}/-project-app/${session.id}/images` && session.id === 's-1' }))
  on('fs.list', ($, e) => ({
    value: posix(e.path) === `${folder}/images`
      ? Object.entries(files).map(([name, size]) => ({ name, kind: 'file' as const, size, mtimeMs: 0, isLink: false }))
      : []
  }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: files[posix(e.path).split('/').pop()!] ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => ({ value: { base64: posix(e.path).endsWith('.png') ? PNG : bmp([[RED, RED], [BLUE, BLUE]]).toBase64() } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // A window's program: it says `shown` (or an error), then `.` every tenth of a second till it is ended.
  const windows: { argv: string[]; env: Record<string, string>; isEnded: boolean }[] = []
  on('process.spawn', async function * ($, e) {
    const opened = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    windows.push(opened)
    try {
      if (window === 'error') {
        yield { stream: 'stdout' as const, text: 'error: no display\n' }
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
  return { clock, runs, runEnvs, box, session, windows }
}

type Drawn = RenderElement & { children?: Drawn[]; props?: { key?: string } }

/** The element keyed `key` in a drawn tree, props and all. */
function keyed (tree: RenderElement, key: string): Drawn | undefined {
  const node = tree as Drawn
  if (node.props?.key === key) return node
  for (const child of node.children ?? []) {
    if (typeof child === 'object') {
      const found = keyed(child, key)
      if (found) return found
    }
  }
  return undefined
}

// The cards drawn in the terminal, not in a window of their own.
const cells = { options: { window: false } }

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const SCREEN = { columns: 120, rows: 40, isFullscreen: true }
type Shown = { first: number; last: number; of: number } | null

const startSession = ($: Engine) => $.session.start({ cwd: '/project/app', surface: 'terminal', isInteractive: true })
/** A session already running: past the rows it drew at its start, so each row drawn now is a new one. */
const running = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await startSession($)
  await clock.advance(1000)
}
const band = ($: Engine) => $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND })
const sent = ($: Engine, text: string, onScreen?: Shown, requestId = 'm-1') =>
  $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text, origin: { kind: 'composer' }, isExpanded: false, ...(onScreen !== undefined && { onScreen }) },
    viewport: SCREEN
  })
const reply = ($: Engine, requestId: string, onScreen: Shown, viewport = SCREEN) =>
  $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Done.', isFirstOfReply: true, onScreen },
    viewport
  })
/** The pointer onto (or off) a chip: the band's, `chip:N`, or the one over a sent prompt's list, `sent:N`. */
const point = (ui: { pointer: (event: { type: 'enter' | 'leave'; x: number; y: number; in?: string }) => Promise<void> }, chip: string, type: 'enter' | 'leave' = 'enter') =>
  ui.pointer({ type, x: 0, y: 0, in: chip })

test('reads a BMP bottom-up into RGBA, top row first', () => {
  const { width, height, data } = parseBmp(bmp([[RED, BLUE], [BLUE, RED]]))
  expect([width, height]).toEqual([2, 2])
  expect([...data.slice(0, 8)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  expect([...data.slice(8, 16)]).toEqual([0, 0, 255, 255, 255, 0, 0, 255])
})

test('fits a picture in the bounds, keeping its shape', () => {
  expect(fit(1280, 800, 64, 18)).toEqual({ columns: 58, rows: 18 })
  expect(fit(1600, 400, 64, 18)).toEqual({ columns: 64, rows: 8 })
  expect(fit(10, 10, 64, 18)).toEqual({ columns: 10, rows: 5 })
})


const wordsOf = (cells: string) => [...new Uint32Array(Uint8Array.fromBase64(cells).buffer)]

test('paints a cell of two colors as a half block: the top one over the bottom one', () => {
  expect(wordsOf(toCells(parseBmp(bmp([[RED], [BLUE]])), 1, 1))).toEqual([0x2580, RED, BLUE])
})

test('paints the quarters of a cell that differ in the foreground', () => {
  expect(wordsOf(toCells(parseBmp(bmp([[RED, BLUE], [RED, RED]])), 1, 1))).toEqual([0x259d, BLUE, RED])
  expect(wordsOf(toCells(parseBmp(bmp([[RED, BLUE], [BLUE, RED]])), 1, 1))).toEqual([0x259a, RED, BLUE])
})

test('paints an edge between the halves of a cell with an eighth block', () => {
  const rows = [RED, RED, RED, RED, RED, RED, BLUE, BLUE].map(color => [color])
  expect(wordsOf(toCells(parseBmp(bmp(rows)), 1, 1))).toEqual([0x2582, BLUE, RED])
  const columns = [[RED, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]]
  expect(wordsOf(toCells(parseBmp(bmp([...columns, ...columns])), 1, 1))).toEqual([0x258f, RED, BLUE])
})

test('a pasted image gets a chip above the prompt, its card shown while the pointer is on it', cells, async ($, on) => {
  const w = world(on, { draft: 'what is wrong here? [Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)

  expect(await ui.find({ key: 'chip:1' })).toMatchObject({ type: 'Client' })
  expect(await ui.find({ type: 'Text', text: '[Image #1]', in: 'chip:1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeDefined()
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()

  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster', props: { columns: 2, rows: 1 } })
  expect(await ui.find({ type: 'Text', text: /\[Image #1\] PNG · 300 KB/ })).toBeDefined()
  expect(w.runs).toContainEqual(['sips', '-s', 'format', 'bmp', '-Z', '800', `${FOLDER}/images/1.png`, '--out', `${FOLDER}/image-preview/1.bmp`])

  await point(ui, 'chip:1', 'leave')
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
})

test('an image pasted while the session runs shows within half a second', cells, async ($, on) => {
  const w = world(on)
  await startSession($)
  w.box.text = 'and now? [Image #1]'
  await w.clock.advance(500)
  const ui = await band($)
  expect(await ui.find({ key: 'chip:1' })).toBeDefined()
})

test('off fullscreen, with no pointer to hover, the band is left as it was', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
    viewport: { columns: 120, rows: 40, isFullscreen: false }
  })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ key: 'chip:1' })).toBeUndefined()
})

test('with no image in the prompt the band is left as it was', cells, async ($, on) => {
  world(on, { draft: 'just words' })
  await startSession($)
  const ui = await band($)
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeUndefined()
})

test('an image the session never stored says so', cells, async ($, on) => {
  const w = world(on, { files: {}, draft: '[Image #7]' })
  await startSession($)
  await w.clock.advance(5000)
  const ui = await band($)
  await point(ui, 'chip:7')
  expect(await ui.find({ type: 'Text', text: /^\[Image #7\] no preview: not stored in this session/ })).toBeDefined()
})

test('sending the prompt takes the chips away, and the card a chip opened', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await $.prompt.submit({ text: '[Image #1]', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'chip:1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
})

test('under a sent prompt, each image the engine lists gets a chip over its row, unpainted', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.jpg': 4096 } })
  await startSession($)
  const message = await sent($, 'compare [Image #2] with [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  expect(await message.find({ key: 'engine' })).toBeDefined()
  expect(keyed(await message.drawn(), 'listed-1')).toMatchObject({ props: { position: 'absolute', bottom: -1, left: 5 } })
  expect(keyed(await message.drawn(), 'listed-2')).toMatchObject({ props: { position: 'absolute', bottom: -2, left: 5 } })
  expect(await message.find({ key: 'sent:2' })).toMatchObject({ type: 'Client', props: { width: 10, height: 1 } })
  expect(await message.find({ type: 'Text', in: 'sent:2' })).toBeUndefined()
})

test('a sent prompt whose image was never stored is drawn as the engine draws it', cells, async ($, on) => {
  const w = world(on, { files: {} })
  await startSession($)
  const message = await sent($, 'what about [Image #9]')
  await w.clock.advance(5000)
  expect(await message.drawn()).toMatchObject({ type: 'Box', props: { key: 'engine' } })
})

test('after /clear the new session reads its images again', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /\[Image #1\] PNG/ })).toBeDefined()

  w.session.id = 's-2'
  await w.clock.advance(5000)
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()
  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:1')
  expect(await ui.find({ type: 'Text', text: /^\[Image #1\] no preview: not stored in this session/ })).toBeDefined()
})

test('over a transcript that fills the rows, a chip opens its card over the lowest row, the band left alone', cells, async ($, on) => {
  const w = world(on, { draft: 'and this? [Image #1]' })
  await startSession($)
  await w.clock.settle()
  const first = await sent($, 'hello', { first: 0, last: 19, of: 20 })
  const last = await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  const ui = await band($)
  expect(await last.find({ key: 'float-1' })).toBeUndefined()

  await point(ui, 'chip:1')
  expect(keyed(await last.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 0, left: 0 } })
  expect(await last.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
  expect(await first.find({ key: 'float-1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()

  await point(ui, 'chip:1', 'leave')
  expect(await last.find({ key: 'float-1' })).toBeUndefined()
})

test('the card a chip opened follows the lowest row: the row it leaves draws none', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  await sent($, 'hello', { first: 0, last: 19, of: 20 })
  const before = await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  await point(await band($), 'chip:1')
  const after = await reply($, 'a-2', { first: 0, last: 5, of: 6 })
  await w.clock.advance(500)

  expect(await before.find({ key: 'float-1' })).toBeUndefined()
  expect(await after.find({ key: 'float-1' })).toBeDefined()
})

test('scrolled up, the card stands on the last row showing of the row cut at the foot', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  await reply($, 'a-0', null)
  const cut = await sent($, 'hello', { first: 0, last: 9, of: 20 })
  await reply($, 'a-1', null)
  await point(await band($), 'chip:1')

  expect(keyed(await cut.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 10 } })
})

test('a sent prompt\'s chip opens its card just above the prompt, never over its own row', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  const after = await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  await w.clock.settle()

  await point(message, 'sent:1')
  expect(keyed(await message.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 2 } })
  expect(await after.find({ key: 'float-1' })).toBeUndefined()

  await point(message, 'sent:1', 'leave')
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
})

test('a sent prompt at the top of the screen opens its card under its list, on the lowest row', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', null)
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  const after = await reply($, 'a-1', { first: 0, last: 19, of: 20 })
  await w.clock.settle()

  await point(message, 'sent:1')
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
  expect(keyed(await after.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 0 } })
})

test('the card a sent prompt opened closes once the transcript moves: its chip may have left the pointer', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()
  await point(message, 'sent:1')
  expect(await message.find({ key: 'float-1' })).toBeDefined()

  await reply($, 'a-1', { first: 0, last: 3, of: 4 })
  await w.clock.advance(500)
  expect(await message.find({ key: 'float-1' })).toBeUndefined()
})

test('on a screen too short to float a card over the transcript, the band holds it', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const only = await reply($, 'a-1', { first: 0, last: 1, of: 2 }, { ...SCREEN, rows: 20 })
  const ui = await band($)
  await point(ui, 'chip:1')

  expect(await only.find({ key: 'float-1' })).toBeUndefined()
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('a card writes every cell it covers, caption and all, so the transcript under it does not show through', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  const caption = await ui.find({ type: 'Text', text: /^\[Image #1\] PNG · 300 KB/ })
  expect(caption).toMatchObject({ text: '[Image #1] PNG · 300 KB'.padEnd(20) })
  // A picture two cells wide under a caption of 23: centered, the cells beside it written blank.
  expect((await ui.findAll({ type: 'Text', text: /^ +$/ })).map(found => found.text)).toEqual([' '.repeat(10), ' '.repeat(11)])
})

test('told the terminal draws pictures, the card sends it the picture as PNG bytes', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
  expect(w.runs).toContainEqual(['sips', '-s', 'format', 'png', '-Z', '1024', `${FOLDER}/images/1.png`, '--out', `${FOLDER}/image-preview/1.view.png`])
})

test('moving from one listed image to the next opens the next card, the leave and the enter in either order', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1] and [Image #2]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()

  await point(message, 'sent:1')
  await point(message, 'sent:1', 'leave')
  await point(message, 'sent:2')
  expect(await message.find({ type: 'Text', text: /^\[Image #2\] PNG/ })).toBeDefined()

  await point(message, 'sent:1')
  await point(message, 'sent:2', 'leave')
  expect(await message.find({ type: 'Text', text: /^\[Image #1\] PNG/ })).toBeDefined()
})

test('rows a resumed session draws all at once, its prompts apart, are put back in the transcript\'s order', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await startSession($)
  // As the engine draws a resumed session: its prompts first, then the rest.
  const first = await sent($, 'hello', { first: 0, last: 1, of: 2 }, 'm-1')
  const message = await sent($, 'look at [Image #1]', { first: 0, last: 2, of: 3 }, 'm-2')
  await reply($, 'a-1', { first: 0, last: 9, of: 10 })
  await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', component: 'TurnDuration', requestId: 't-1', props: { word: 'Baked', durationMs: 1000, onScreen: { first: 0, last: 1, of: 2 } }, viewport: SCREEN })
  const after = await reply($, 'a-2', { first: 0, last: 1, of: 2 })
  await w.clock.advance(1000)
  expect(await first.find({ key: 'float-1' })).toBeUndefined()

  // The prompt's rows above it are the first prompt's and the first reply's: 15 rows, more than under it.
  await point(message, 'sent:1')
  expect(keyed(await message.drawn(), 'float-1')).toMatchObject({ props: { position: 'absolute', bottom: 2 } })
  expect(await after.find({ key: 'float-1' })).toBeUndefined()
})

test('a click on a chip opens the image in Preview', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', '-a', 'Preview', `${FOLDER}/images/1.png`])
})

test('a sent prompt\'s [Image #N] on its first line takes the pointer and the click: hover shows, a click opens', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048, '2.png': 2048 } })
  await running($, w.clock)
  await reply($, 'a-0', { first: 0, last: 14, of: 15 })
  const message = await sent($, 'look at [Image #1] and [Image #2] [Image #1]\nthen [Image #9]', { first: 0, last: 2, of: 3 })
  await w.clock.settle()
  expect(keyed(await message.drawn(), 'token-1')).toMatchObject({ props: { position: 'absolute', top: 1, left: 10 } })
  expect(keyed(await message.drawn(), 'token-2')).toMatchObject({ props: { top: 1, left: 25 } })
  expect(await message.findAll({ key: 'token:1' })).toHaveLength(1)

  await point(message, 'token:2')
  expect(keyed(await message.drawn(), 'float-2')).toBeDefined()

  await message.resize({ columns: 10, rows: 1, in: 'token:1' })
  await message.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'token:1' })
  await message.pointer({ type: 'up', x: 30, y: 4, button: 'left', in: 'token:1' })
  await w.clock.settle()
  expect(w.runs.filter(argv => argv[0] === 'open')).toEqual([])

  await message.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'token:1' })
  await message.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'token:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', '-a', 'Preview', `${FOLDER}/images/1.png`])
})

test('an [Image #N] past where the first line could wrap gets no click target', cells, async ($, on) => {
  const w = world(on, { files: { '1.png': 2048 } })
  await running($, w.clock)
  const message = await sent($, `${'word '.repeat(30)}[Image #1]`, { first: 0, last: 3, of: 4 })
  await w.clock.settle()
  expect(await message.find({ key: 'token:1' })).toBeUndefined()
  expect(await message.find({ key: 'sent:1' })).toBeDefined()
})

test('where the terminal cannot draw the picture, the card opens in a window of its own by the pointer', async ($, on) => {
  const w = world(on, { draft: '[Image #1]' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)

  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]!.argv.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
  expect(w.windows[0]!.env).toMatchObject({ IMAGE_PREVIEW_FILE: `${FOLDER}/images/1.png`, IMAGE_PREVIEW_SIZE: '800' })
  expect(await ui.find({ key: 'image-1' })).toBeUndefined()

  // The pointer leaves: the program is ended at its next word.
  await point(ui, 'chip:1', 'leave')
  await w.clock.advance(200)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('moving from one image to the next ends the first window and opens the next', async ($, on) => {
  const w = world(on, { draft: '[Image #1] [Image #2]', files: { '1.png': 2048, '2.png': 2048 } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:2')
  await w.clock.advance(300)
  expect(w.windows.map(opened => [opened.env.IMAGE_PREVIEW_FILE, opened.isEnded])).toEqual([[`${FOLDER}/images/1.png`, true], [`${FOLDER}/images/2.png`, false]])
})

test('a system that shows no window has the terminal draw the card', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', window: 'error' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })

  // And the next card too, with no window tried.
  await point(ui, 'chip:1', 'leave')
  await point(ui, 'chip:1')
  expect(w.windows).toHaveLength(1)
})

test('over SSH the window would open on the other machine: the terminal draws the card', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', env: { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(w.windows).toHaveLength(0)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('on Linux with a display and Tk, the window is Tk\'s, showing the picture shrunk to a PNG', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: 'Linux', env: { DISPLAY: ':0' } })
  await startSession($)
  await w.clock.settle()
  await point(await band($), 'chip:1')
  await w.clock.advance(100)
  expect(w.runs).toContainEqual(['python3', '-c', 'import tkinter'])
  expect(w.runs).toContainEqual(['magick', `${FOLDER}/images/1.png`, '-resize', '800x800>', `PNG:${FOLDER}/image-preview/1.window.png`])
  expect(w.windows[0]!.argv.slice(0, 2)).toEqual(['python3', '-c'])
  expect(w.windows[0]!.env.IMAGE_PREVIEW_FILE).toBe(`${FOLDER}/image-preview/1.window.png`)
})

test('on Linux with no display the terminal draws the card', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: 'Linux' })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  expect(w.windows).toHaveLength(0)
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

// %TEMP%, as a path the engine under test (on macOS or Linux) can resolve.
const TEMP = '/Users/me/AppData/Local/Temp'

test('on Windows the window is PowerShell\'s, the images found under %TEMP%\\claude, never converted by the system\'s convert', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: '', temp: `${TEMP}/claude`, env: { OS: 'Windows_NT', TEMP } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(w.windows[0]!.argv.slice(0, 6)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  expect(w.windows[0]!.env.IMAGE_PREVIEW_FILE).toBe(`${TEMP}/claude/-project-app/s-1/images/1.png`)
  expect(w.runs.some(argv => argv[0] === 'id' || argv[0] === 'convert' || argv[0] === 'mkdir')).toBe(false)
})

test('on Windows the images are found under CLAUDE_CODE_TMPDIR\\claude when it is set', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: '', temp: '/d/tmp/claude', env: { OS: 'Windows_NT', TEMP, CLAUDE_CODE_TMPDIR: '/d/tmp\\' } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  await w.clock.advance(100)
  expect(w.windows[0]!.env.IMAGE_PREVIEW_FILE).toBe('/d/tmp/claude/-project-app/s-1/images/1.png')
})

test('on Windows a click opens the image in its own viewer', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: '', temp: `${TEMP}/claude`, env: { OS: 'Windows_NT', TEMP } })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer', '\\Users\\me\\AppData\\Local\\Temp\\claude\\-project-app\\s-1\\images\\1.png'])
})

// Under WSL the session is Linux, but the desktop, the pointer and the viewer are Windows'.
const WSL = { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0', WSLENV: 'WT_SESSION' }

test('under WSL the window is Windows\' PowerShell, its variables crossing over through WSLENV', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: 'Linux', env: WSL })
  await startSession($)
  await w.clock.settle()
  await point(await band($), 'chip:1')
  await w.clock.advance(100)
  expect(w.windows[0]!.argv.slice(0, 6)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  expect(w.windows[0]!.env.IMAGE_PREVIEW_FILE).toBe(`${FOLDER}/images/1.png`)
  expect(w.windows[0]!.env.WSLENV).toBe('WT_SESSION:IMAGE_PREVIEW_FILE/p:IMAGE_PREVIEW_SIZE:IMAGE_PREVIEW_LIFE')
  expect(w.runs).not.toContainEqual(['python3', '-c', 'import tkinter'])
})

test('under WSL without ImageMagick, Windows\' PowerShell shrinks the picture for the terminal', cells, async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: 'Linux', env: WSL, missing: ['magick', 'convert'] })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await point(ui, 'chip:1')
  const at = w.runs.findIndex(argv => argv[0] === 'powershell.exe')
  expect(at).toBeGreaterThan(-1)
  expect(w.runEnvs[at]).toMatchObject({ IMAGE_PREVIEW_FILE: `${FOLDER}/images/1.png`, IMAGE_PREVIEW_OUT: `${FOLDER}/image-preview/1.bmp`, WSLENV: 'WT_SESSION:IMAGE_PREVIEW_FILE/p:IMAGE_PREVIEW_OUT/p:IMAGE_PREVIEW_FORMAT:IMAGE_PREVIEW_SIZE' })
  expect(await ui.find({ key: 'image-1' })).toMatchObject({ type: 'Raster' })
})

test('under WSL a click opens the image in Windows\' viewer', async ($, on) => {
  const w = world(on, { draft: '[Image #1]', system: 'Linux', env: WSL })
  await startSession($)
  await w.clock.settle()
  const ui = await band($)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'chip:1' })
  await w.clock.settle()
  expect(w.runs).toContainEqual(['explorer.exe', '\\\\wsl.localhost\\Ubuntu\\tmp\\claude-501\\-project-app\\s-1\\images\\1.png'])
  expect(w.runs.some(argv => argv[0] === 'xdg-open')).toBe(false)
})
