import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, EventOf, Register, RenderElement } from 'claude-code'

import { fit, parseBmp, toCells } from './pixels'
import type { Pixels } from './pixels'
import { LINUX, MACOS, WINDOWS, WINDOWS_CONVERT, powershell } from './window'
import type { Picture, Shown } from '../types'

type Engine = EngineInterface
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>
type Bounds = { columns: number; rows: number }
type Ui = Elements['terminal']

// A transcript row: a card floats over the rows above the end of one.
type Row = RenderOf<'UserMessage' | 'AssistantMessage' | 'ToolUse' | 'ToolResult' | 'ToolGroup' | 'CommandOutput' | 'TurnDuration' | 'InfoNotice'>
type OnScreen = NonNullable<Row['props']['onScreen']>

const draft = atom({ plugin: 'image-preview', key: 'draft' } as const, [] as number[])
const pictures = atom({ plugin: 'image-preview', key: 'pictures' } as const, {} as Record<string, Picture>)
const shown = atom({ plugin: 'image-preview', key: 'shown' } as const, null as Shown | null)
const hosting = atom({ plugin: 'image-preview', key: 'hosting' } as const, false)

const TOKEN = /\[Image #(\d+)\]/g
const NOT_STORED = 'not stored in this session'
// The longest side a picture is shrunk to before it is sampled into cells, eight points a cell across.
const SOURCE_PIXELS = 800
const MAX_COLUMNS = 160
const MAX_ROWS = 48
// What the screen keeps under the transcript (the band's row, the prompt and its lines), and above
// its first row (the logo); the fewest rows a card is worth floating in, from the band's chips and
// from a sent prompt's.
const BOTTOM_ROWS = 7
const HEADER_ROWS = 4
const MIN_FLOAT_ROWS = 10
const MIN_CARD_ROWS = 6
// What a card adds around the picture: the border, and the caption under it.
const CARD_COLUMNS = 2
const CARD_ROWS = 3
// Under a sent prompt the engine lists its images, one a row, each after `  ⎿  `; the prompt's own
// first line starts after `❯ `, on the row after the blank one above it.
const LISTED_AT = 5
const PROMPT_AT = 2
const WAIT_MS = 200
// Pasting an image puts its placeholder in the box with no edit event: the box is looked at this often.
const POLL_MS = 500
const WAIT_TRIES = 15
// The longest side of the picture a terminal is sent to draw itself, and the most bytes it may take.
const VIEW_PIXELS = 1024
const VIEW_BYTES = 2 * 1024 * 1024
// The longest side of the picture in a window of its own, in points, and the most seconds it stays.
const WINDOW_SIZE = 800
const WINDOW_LIFE = 120

/** The ids of the `[Image #N]` placeholders in a text, each once, in order. */
export const idsIn = (text: string) => [...new Set([...text.matchAll(TOKEN)].map(match => Number(match[1])))]

const sameIds = (a: readonly number[], b: readonly number[] = []) => a.length === b.length && a.every((id, i) => id === b[i])

const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// How the terminal draws the picture itself: Ghostty and kitty read the file; one Claude Code was
// told draws pictures (CLAUDE_CODE_FORCE_TERMINAL_IMAGES) is sent its bytes; any other gets it in
// colored cells.
let graphics: 'none' | 'file' | 'bytes' = 'none'
let sessionId: string | undefined
let folder: string | undefined
// Claude Code's temp folder for every session of this user.
let temp: string | undefined
type Platform = 'macos' | 'linux' | 'windows' | 'other'
// The system the session runs on: what converts, opens and shows a picture there.
let platform: Promise<Platform> | undefined
type Tool = 'sips' | 'magick' | 'convert' | 'powershell'
type Command = { argv: string[]; env?: Record<string, string> }
// The converters each system is tried with, in order: sips on macOS, ImageMagick, and on Windows
// PowerShell's System.Drawing (there `convert` is the system's disk tool, never ImageMagick's).
const TOOLS: Record<Platform, Tool[]> = { macos: ['sips', 'magick', 'convert'], linux: ['magick', 'convert'], windows: ['magick', 'powershell'], other: ['magick', 'convert'] }
// The converter that worked here.
let tool: Tool | undefined
// Where a card opens in a window of its own, by the pointer: the system whose program shows it.
// Unset, the terminal draws the card. And the window open now, if any.
let windowing: Platform | undefined
let window: { id: number; isOpen: boolean } | undefined
// The pictures read, shrunk, by id; the cells drawn of them, by id and size.
const thumbs = new Map<number, Pixels>()
const loading = new Set<number>()
const cells = new Map<string, string>()
// The PNG bytes, base64, sent to a terminal that is not known to read files, by id.
const views = new Map<number, string>()
// Each transcript row drawn, by requestId: which it is, when first drawn, whether in the batch the
// session (or a reload) starts by drawing, and which of its rows show. Whether that batch is still
// coming in. How many times a row was added or moved, and how many when the card opened. And the
// screen's height, as the last drawing said.
type Noted = { component: Row['component']; seen: number; isBatch: boolean; onScreen: OnScreen | null | undefined }
const rows = new Map<string, Noted>()
let seenRows = 0
// The module loads as the session starts or reloads, and the engine draws every row right after.
let isBatching = true
let seenAtLastLook = 0
let moves = 0
let movesShown = 0
let screenRows = 40

/** The system the session runs on, asked once. */
function platformOf ($: Engine) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

// Whether the session runs under WSL: Linux, on a Windows desktop.
let wsl: Promise<boolean> | undefined

/**
 * Whether the session runs under WSL, asked once. There the session is Linux, but the desktop, the
 * pointer and the viewer are Windows': the picture is converted, shown and opened by Windows' own.
 */
function wslOf ($: Engine) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/**
 * A PowerShell command as WSL runs it: as `powershell.exe`, its variables crossing over through
 * WSLENV, the paths among them (`/p`) turned into their Windows form. Elsewhere, as it is.
 */
async function crossing ($: Engine, command: Command): Promise<Command> {
  if (command.argv[0] !== 'powershell' || !(await wslOf($))) return command
  const names = Object.keys(command.env ?? {}).map(name => (/^IMAGE_PREVIEW_(FILE|OUT)$/.test(name) ? `${name}/p` : name))
  const inherited = await $.env.get('WSLENV')
  return { argv: ['powershell.exe', ...command.argv.slice(1)], env: { ...command.env, WSLENV: [inherited, ...names].filter(Boolean).join(':') } }
}

/** Forgets what was read in another session: after /clear the ids start again from 1. */
async function follow ($: Engine) {
  const id = await $.session.id()
  if (id === sessionId) return
  // The rows drawn so far are this session's, unless another came before it.
  if (sessionId !== undefined) rows.clear()
  sessionId = id
  folder = undefined
  thumbs.clear()
  cells.clear()
  views.clear()
  await update($, pictures, () => ({}))
  await change($, () => null)
}

/**
 * Claude Code's temp folder: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`. Windows has no uid: there
 * it is `<CLAUDE_CODE_TMPDIR or the system's temp folder>\claude`.
 */
async function tempFolder ($: Engine) {
  if ((await platformOf($)) !== 'windows') {
    const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp').replace(/\/+$/, '')
    return `${base}/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  // The system's temp folder as Node finds it: %TEMP%, %TMP%, or the one in Windows' own folder.
  const system = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || `${(await $.env.get('SystemRoot')) || 'C:\\Windows'}\\temp`
  const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || system).replace(/[\\/]+$/, '')
  return `${base}/claude`
}

/**
 * Claude Code's temp folder for this session, where a pasted image is stored as
 * `images/<N>.<ext>`: `<temp folder>/<project path, dashed>/<session id>`.
 */
async function sessionFolder ($: Engine) {
  if (folder) return folder
  const id = await $.session.id()
  const root = (temp ??= await tempFolder($))
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(`${root}/${name}/${id}/images`)) return (folder = `${root}/${name}/${id}`)
  }
  // A project path too long for a folder name gets a hash after it: look for the session instead.
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${root}/${entry.name}/${id}/images`))) {
      return (folder = `${root}/${entry.name}/${id}`)
    }
  }
  return undefined
}

async function fileOf ($: Engine, id: number) {
  const found = await sessionFolder($)
  if (!found) return undefined
  const name = (await $.fs.list(`${found}/images`).catch(() => [])).find(entry => entry.name.startsWith(`${id}.`))?.name
  return name && /^\d+\.[a-z]+$/.test(name) ? `${found}/images/${name}` : undefined
}

/** Runs the first converter that works here, and remembers it. */
async function convert ($: Engine, commandOf: (tool: Tool) => Command) {
  // Under WSL, Windows' PowerShell converts where ImageMagick is not installed.
  const tools = (await wslOf($)) ? [...TOOLS.linux, 'powershell' as const] : TOOLS[await platformOf($)]
  for (const name of tool ? [tool] : tools) {
    const { argv, env } = await crossing($, commandOf(name))
    const result = await $.process.run(argv, env && { env }).catch(() => undefined)
    if (result?.exitCode === 0) {
      tool = name
      return true
    }
  }
  return false
}

/**
 * How `tool` writes `file` as `format` to `out`, its longest side `side` pixels (`n` stretched or
 * shrunk to it, `n>` only shrunk; none, as it is).
 */
function shrink (tool: Tool, file: string, out: string, format: 'bmp' | 'png', side?: string): Command {
  if (tool === 'sips') return { argv: ['sips', '-s', 'format', format, ...(side ? ['-Z', side.replace('>', '')] : []), file, '--out', out] }
  if (tool === 'powershell') {
    return { argv: powershell(WINDOWS_CONVERT), env: { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_OUT: out, IMAGE_PREVIEW_FORMAT: format, ...(side && { IMAGE_PREVIEW_SIZE: side.replace('>', '') }) } }
  }
  const size = side && `${side.replace('>', '')}x${side}`
  return { argv: [tool, file, ...(size ? ['-resize', size] : []), `${format === 'bmp' ? 'BMP3' : 'PNG'}:${out}`] }
}

/** Makes the mod's cache folder. */
async function makeFolder ($: Engine, path: string) {
  if ((await platformOf($)) !== 'windows') return void (await $.process.run(['mkdir', '-p', path]))
  await $.process.run(powershell('New-Item -ItemType Directory -Force -Path $env:IMAGE_PREVIEW_OUT | Out-Null'), { env: { IMAGE_PREVIEW_OUT: path } })
}

async function decode ($: Engine, file: string, out: string): Promise<Pixels> {
  const isConverted = await convert($, name => shrink(name, file, out, 'bmp', String(SOURCE_PIXELS)))
  if (!isConverted) throw new Error('needs sips (macOS), ImageMagick or PowerShell (Windows) to read it')
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return parseBmp(Uint8Array.fromBase64(base64))
}

/** A PNG of the picture for the terminal to draw itself: the file, or a copy converted beside the cache. */
async function pngOf ($: Engine, file: string, out: string) {
  if (file.endsWith('.png')) return file
  return (await convert($, name => shrink(name, file, out, 'png'))) ? out : undefined
}

/** The picture shrunk to a PNG, base64, for a terminal sent the bytes: none past what one may take. */
async function viewOf ($: Engine, file: string, out: string) {
  const isConverted = await convert($, name => shrink(name, file, out, 'png', `${VIEW_PIXELS}>`))
  if (!isConverted || (await $.fs.stat(out)).size > VIEW_BYTES) return undefined
  return (await $.fs.read(out, { as: 'bytes' })).base64
}

/** Reads image `id` once: its file, then its pixels, shrunk; the drawings that wait on it redraw. */
async function load ($: Engine, id: number) {
  if (thumbs.has(id) || loading.has(id)) return
  loading.add(id)
  let picture: Picture
  try {
    // The engine writes the file just after the paste puts the placeholder in the box.
    let file = await fileOf($, id)
    for (let tries = 0; !file && tries < WAIT_TRIES; tries++) {
      await $.clock.sleep(WAIT_MS)
      file = await fileOf($, id)
    }
    if (!file) throw new Error(NOT_STORED)

    const cache = `${await sessionFolder($)}/image-preview`
    await makeFolder($, cache)
    const pixels = await decode($, file, `${cache}/${id}.bmp`)
    let png: string | undefined
    if (graphics === 'file') png = await pngOf($, file, `${cache}/${id}.png`)
    if (graphics === 'bytes') {
      const view = await viewOf($, file, `${cache}/${id}.view.png`)
      if (view) {
        views.set(id, view)
        png = `${cache}/${id}.view.png`
      }
    }
    const { size } = await $.fs.stat(file)
    thumbs.set(id, pixels)
    const format = file.slice(file.lastIndexOf('.') + 1)
    picture = { file, format, bytes: size, width: pixels.width, height: pixels.height, ...(png && { png }) }
  } catch (error) {
    picture = { error: error instanceof Error ? error.message : String(error) }
  } finally {
    loading.delete(id)
  }
  // Read in the background: a module unloaded meanwhile has no state to write to.
  await update($, pictures, all => ({ ...all, [id]: picture })).catch(() => undefined)
}

async function fileFor ($: Engine, id: number) {
  const picture = (await read($, pictures))[id]
  return picture && !('error' in picture) ? picture.file : await fileOf($, id)
}

/** Opens image `id` in the system's viewer: Preview on macOS, the desktop's own elsewhere. */
async function openImage ($: Engine, id: number) {
  const file = await fileFor($, id)
  if (!file) return
  if (await wslOf($)) {
    const path = (await $.process.run(['wslpath', '-w', file]).catch(() => undefined))?.stdout.trim()
    if (path) await $.process.run(['explorer.exe', path]).catch(() => undefined)
    return
  }
  const system = await platformOf($)
  const argv = system === 'macos' ? ['open', '-a', 'Preview', file] : system === 'windows' ? ['explorer', file.replaceAll('/', '\\')] : ['xdg-open', file]
  await $.process.run(argv).catch(() => undefined)
}

/** The program that shows image `id` in a window of its own here, and what it is told. */
async function windowCommand ($: Engine, id: number): Promise<Command | undefined> {
  const file = await fileFor($, id)
  if (!file) return undefined
  const env = { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_SIZE: String(WINDOW_SIZE), IMAGE_PREVIEW_LIFE: String(WINDOW_LIFE) }
  if (windowing === 'macos') return { argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env }
  if (windowing === 'windows') return crossing($, { argv: powershell(WINDOWS), env })
  // Tk reads a PNG: the picture shrunk to one, once.
  const cache = `${await sessionFolder($)}/image-preview`
  const out = `${cache}/${id}.window.png`
  if (!(await $.fs.exists(out))) {
    await makeFolder($, cache)
    if (!(await convert($, name => shrink(name, file, out, 'png', `${WINDOW_SIZE}>`)))) return undefined
  }
  return { argv: ['python3', '-c', LINUX], env: { ...env, IMAGE_PREVIEW_FILE: out } }
}

/**
 * Shows image `id` in a window of its own till `closeWindow`. The program says `.` ten times a
 * second, so the loop wakes to see it was closed, and leaving the loop ends the program. One that
 * ends without having shown a window says the system shows none: the card goes back to the terminal.
 */
async function openWindow ($: Engine, id: number) {
  if (window?.id === id && window.isOpen) return
  closeWindow()
  const opening = { id, isOpen: true }
  window = opening
  const command = await windowCommand($, id)
  let isShown = false
  let said = ''
  if (command && opening.isOpen) {
    try {
      for await (const { text } of $.process.spawn(command)) {
        if (said.length < 2000) said += text
        if (/^shown$/m.test(text)) isShown = true
        if (!opening.isOpen) break
      }
    } catch (error) {
      said += error instanceof Error ? error.message : String(error)
    }
  }
  if (window === opening) window = undefined
  if (isShown || !opening.isOpen) return
  $.ui.log(`image-preview: no window (${said.replace(/\.\n/g, '').trim().slice(0, 300) || 'the program could not start'}); the terminal draws the cards`, { to: 'debug' })
  windowing = undefined
  await change($, now => (now?.edge === 'window' ? placeFor(now.id, now.target) : now))
}

function closeWindow () {
  if (window) window.isOpen = false
  window = undefined
}

/**
 * The picture of image `id` in a bordered card, as large as the bounds allow, its caption under it.
 * It floats over the transcript, which shows through any cell it leaves unwritten: every line is
 * written to the card's width, spaces and all.
 */
function card ({ Box, Image, Raster, Text }: Ui, all: Record<string, Picture>, id: number, bounds: Bounds) {
  const label = `[Image #${id}]`
  const picture = all[id]
  const line = (text: string, width: number) => <Text dimColor wrap="truncate-end">{text.padEnd(width)}</Text>
  if (!picture || (!('error' in picture) && !thumbs.has(id))) return line(`${label} loading…`, bounds.columns)
  if ('error' in picture) return line(`${label} no preview: ${picture.error}`, bounds.columns)

  const { columns, rows } = fit(picture.width, picture.height, bounds.columns - CARD_COLUMNS, bounds.rows - CARD_ROWS)
  const view = views.get(id)
  const source = !picture.png ? undefined : graphics === 'file' ? { file: picture.png, format: 'png' as const } : view && { png: view }
  const key = `${id}:${columns}x${rows}`
  let painted = cells.get(key)
  if (!source && painted === undefined) {
    painted = toCells(thumbs.get(id)!, columns, rows)
    cells.set(key, painted)
  }
  const caption = `${label} ${picture.format.toUpperCase()} · ${sizeOf(picture.bytes)}`
  // A picture narrower than its caption is centered, the rows beside it written blank.
  const width = Math.max(columns, Math.min(caption.length, bounds.columns - CARD_COLUMNS))
  const side = (n: number) => n > 0 && <Text>{Array.from({ length: rows }, () => ' '.repeat(n)).join('\n')}</Text>
  const left = Math.floor((width - columns) / 2)
  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderDimColor flexShrink={0} width={width + CARD_COLUMNS}>
      <Box flexDirection="row">
        {side(left)}
        {source
          ? <Image key={`image-${id}`} source={source} columns={columns} rows={rows} alt={label} />
          : <Raster key={`image-${id}`} columns={columns} rows={rows} cells={painted!} />}
        {side(width - columns - left)}
      </Box>
      {line(caption, width)}
    </Box>
  )
}

const sameShown = (a: Shown | null, b: Shown | null) =>
  a === b || (a !== null && b !== null && a.id === b.id && a.target === b.target && a.host === b.host && a.rows === b.rows && a.edge === b.edge)

let changing = Promise.resolve()

/**
 * Opens, moves or closes (null) the card, one change at a time, each `next` handed the card the one
 * before left: the pointer leaving one chip and coming onto the next are two changes, in either
 * order. The row the card leaves and the one it joins draw again.
 */
function change ($: Engine, next: (now: Shown | null) => Shown | null) {
  const run = changing.then(async () => {
    const last = await read($, shown)
    const to = next(last)
    if (sameShown(last, to)) return
    movesShown = moves
    await update($, shown, () => to)
    if (last?.host && last.host !== to?.host) await update($, memberOf(hosting, { requestId: last.host }), () => false)
    if (to?.host && to.host !== last?.host) await update($, memberOf(hosting, { requestId: to.host }), () => true)
    if (to?.edge === 'window') void openWindow($, to.id)
    else closeWindow()
  })
  changing = run.catch(() => undefined)
  return run
}

/** Closes the card a chip of the band opened, if one did. */
const closeChipCard = (now: Shown | null) => (now && !isFromPrompt(now) ? null : now)

const isFromPrompt = (now: Shown) => /\/(sent|token):/.test(now.target)

/** Where the card a target opened goes: a target is `<site>/<chip key>`, the site a sent prompt's for its chips. */
const placeFor = (id: number, target: string) => placeOf(id, target, /\/chip:/.test(target) ? undefined : target.slice(0, target.indexOf('/')))

/** Notes a transcript row, and which of its rows show: before anything is awaited, so in the transcript's order. */
function note (e: Row) {
  if (e.viewport) screenRows = e.viewport.rows
  const onScreen = e.props.onScreen
  const row = rows.get(e.requestId)
  if (!row) {
    rows.set(e.requestId, { component: e.component, seen: seenRows++, isBatch: isBatching, onScreen })
    moves++
  } else if (row.onScreen?.first !== onScreen?.first || row.onScreen?.last !== onScreen?.last || row.onScreen?.of !== onScreen?.of) {
    row.onScreen = onScreen
    moves++
  }
}

/**
 * The rows in the transcript's order, as best known. A row drawn as it came is in place. The batch
 * a start or a reload draws comes in two runs, the sent prompts apart from the rest (each run in
 * order): each prompt is put back at the start of a turn, the row after a turn's duration line,
 * the newest prompt at the newest turn.
 */
function transcriptOrder () {
  const bySeen = (a: [string, Noted], b: [string, Noted]) => a[1].seen - b[1].seen
  const batch = [...rows].filter(([, row]) => row.isBatch).sort(bySeen)
  const notices = batch.filter(([, row]) => row.component === 'InfoNotice')
  const prompts = batch.filter(([, row]) => row.component === 'UserMessage')
  const others = batch.filter(([, row]) => row.component !== 'InfoNotice' && row.component !== 'UserMessage')
  const starts = [0, ...others.flatMap(([, row], i) => (row.component === 'TurnDuration' && i + 1 < others.length ? [i + 1] : []))]
  const before = new Map<number, string[]>()
  prompts.forEach(([id], i) => {
    const at = starts[Math.max(0, starts.length - (prompts.length - i))]!
    before.set(at, [...(before.get(at) ?? []), id])
  })
  const ordered = [...notices.map(([id]) => id), ...others.flatMap(([id], i) => [...(before.get(i) ?? []), id])]
  if (others.length === 0) ordered.push(...prompts.map(([id]) => id))
  const order = new Map(ordered.map((id, i) => [id, i]))
  for (const [id, row] of rows) if (!row.isBatch) order.set(id, ordered.length + row.seen)
  return order
}

/**
 * Where the card of image `id` floats, from what the transcript's rows said of themselves; it never
 * covers the chip that opened it, and covers only rows drawn before the one it stands on (a row drawn
 * after paints over it).
 *
 * From the band's chip: over the rows above the end of the lowest row on screen; in the band
 * itself where too few rows show. From the list under a sent prompt (`prompt`, its requestId): over
 * the rows above the prompt, or over those under its list, whichever holds more; none where neither
 * holds a card. The rows counted are the rows the mod knows of, so a count is never too high.
 */
function placeOf (id: number, target: string, prompt?: string): Shown | null {
  if (windowing) return { id, target, host: null, rows: 0, edge: 'window' }
  const order = transcriptOrder()
  const showing = [...rows]
    .filter(([, row]) => !!row.onScreen)
    .map(([id, row]) => [id, { order: order.get(id)!, onScreen: row.onScreen! }] as const)
  // A row first drawn late (as one scrolled into view) still has its place where it is cut: the row
  // cut at the top is the first on screen, the one cut at the foot the last.
  const placeOn = ({ order, onScreen }: { order: number; onScreen: OnScreen }) =>
    onScreen.first > 0 ? -Infinity : onScreen.last < onScreen.of - 1 ? Infinity : order
  showing.sort((a, b) => placeOn(a[1]) - placeOn(b[1]) || a[1].order - b[1].order)
  const room = screenRows - BOTTOM_ROWS
  const lowest = showing.at(-1)
  const top = showing[0]?.[1]
  // A row off the screen, or the first on it cut, is a transcript that fills the screen.
  const isFull = top !== undefined && (top.onScreen.first > 0 || [...rows.values()].some(row => row.onScreen === null))
  const count = (list: typeof showing) => list.reduce((sum, [, row]) => sum + row.onScreen.last - row.onScreen.first + 1, 0)

  if (prompt === undefined) {
    // One row kept free: the count of the rows above is a guess.
    const above = !lowest ? 0 : (isFull ? room : Math.min(room, HEADER_ROWS + count(showing))) - 1
    return above >= MIN_FLOAT_ROWS
      ? { id, target, host: lowest![0], rows: above, edge: 'last' }
      : { id, target, host: null, rows: 0, edge: 'last' }
  }
  const at = showing.findIndex(([requestId]) => requestId === prompt)
  if (at === -1) return null
  const message = showing[at]![1].onScreen
  // Above: the rows before it that show, the logo's in a short transcript, and its own blank first row.
  const above = message.first > 0 ? 0 : Math.min(room, count(showing.slice(0, at)) + (isFull ? 0 : HEADER_ROWS) + 1)
  // Under: the rows after it, between its list and the foot of the lowest.
  const under = Math.min(room, count(showing.slice(at + 1)))
  if (Math.max(above, under) < MIN_CARD_ROWS) return null
  return above >= under
    ? { id, target, host: prompt, rows: above, edge: 'first' }
    : { id, target, host: lowest![0], rows: under, edge: 'last' }
}

/**
 * Keeps the open card in step with the transcript. A sent prompt's list moves with it, and a chip
 * that moves from under a resting pointer says nothing: its card closes when anything moves (a move
 * of the pointer opens it again). The band's chips stay put: their card follows the lowest row.
 */
async function settle ($: Engine) {
  if (seenRows === seenAtLastLook) isBatching = false
  seenAtLastLook = seenRows
  await change($, now => !now ? null : !isFromPrompt(now) ? placeFor(now.id, now.target) : moves === movesShown ? now : null)
}

/** A transcript row, drawn with the open card where it holds it: out of the flow, so it moves nothing. */
async function float ($: Engine, e: Row, drawn: RenderElement, overlays: RenderElement[] = []) {
  const now = (await read($, memberOf(hosting, e))) ? await read($, shown) : null
  const onScreen = e.props.onScreen
  const isHost = now !== null && now.host === e.requestId && !!onScreen
  if (!isHost && overlays.length === 0) return drawn
  const ui = $.ui.resolve(e)
  const { Box } = ui
  let floating: RenderElement | undefined
  if (isHost) {
    const bounds = { columns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - 4)), rows: Math.min(MAX_ROWS, now.rows) }
    // On the last row of this one that shows (the rest are past the screen's edge), or ending on
    // its first, the blank row above a message.
    const bottom = now.edge === 'last' ? onScreen.of - 1 - onScreen.last : onScreen.of - 1
    floating = (
      <Box key={`float-${now.id}`} position="absolute" bottom={bottom} left={0}>
        {card(ui, await read($, pictures), now.id, bounds)}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {drawn}
      {overlays}
      {floating}
    </Box>
  )
}

/** Keeps the band's list of the draft's images in step with the prompt box. */
async function track ($: Engine, text: string) {
  await follow($)
  const ids = idsIn(text)
  if (!sameIds(ids, await read($, draft))) {
    await update($, draft, () => ids)
    await change($, closeChipCard)
  }
  for (const id of ids) void load($, id)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const program = await $.env.get('TERM_PROGRAM')
    const term = await $.env.get('TERM')
    const isNative = program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (await $.env.get('KITTY_WINDOW_ID')) !== undefined
    const isForced = /^(1|true|yes|on)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')
    graphics = isNative ? 'file' : isForced ? 'bytes' : 'none'
    // Where the terminal cannot draw the picture itself, a card opens in a window of its own, by
    // the pointer, on the desktop the session runs on: not over SSH, where that is another machine's.
    windowing = undefined
    const isRemote = (await $.env.get('SSH_CONNECTION')) !== undefined || (await $.env.get('SSH_TTY')) !== undefined
    if (options.window !== false && graphics === 'none' && e.isInteractive && !isRemote) {
      const system = await platformOf($)
      if (system === 'macos' || system === 'windows') windowing = system
      // Under WSL the window is Windows', by the pointer: not WSLg's, which cannot tell where it is.
      if (await wslOf($)) windowing = 'windows'
      else if (system === 'linux' && (await $.env.get('DISPLAY'))) {
        const tk = await $.process.run(['python3', '-c', 'import tkinter']).catch(() => undefined)
        if (tk?.exitCode === 0) windowing = 'linux'
      }
    }
    // A reload starts with an empty cache: read again what is in the box.
    await follow($)
    await track($, (await $.prompt.read()).text)
    if (e.isInteractive) {
      // A look that fails (the module unloading under it) waits for the next.
      $.clock.every(POLL_MS, () => {
        void $.prompt.read().then(box => track($, box.text)).then(() => settle($)).catch(() => undefined)
      })
    }
    return result
  })

  // Typing closes the card a chip opened: the box may grow and move the chip from under the pointer.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await change($, closeChipCard)
    await track($, box.text)
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'composer') return result
    await update($, draft, () => [])
    await change($, () => null)
    for (const id of idsIn(e.text)) void load($, id)
    return result
  }).catch(($, e, next) => next(e))

  // A chip says when the pointer comes onto it (or moves on it) and when it leaves: its card opens
  // and closes. Clicked, it opens the image in the system's viewer.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    const chip = /^(chip|sent|token):(\d+)$/.exec(e.element)
    if (!chip) return result
    const target = `${e.requestId}/${e.element}`
    const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
    // Clicked, the image opens in its viewer, over which a card left open would stand.
    if (data?.isClicked === true) {
      void openImage($, Number(chip[2]))
      await change($, () => null)
      return result
    }
    const isOver = data?.isOver === true
    await change($, now => (!isOver ? (now?.target === target ? null : now) : now?.target === target ? now : placeFor(Number(chip[2]), target)))
    return result
  })

  // Every transcript row is noted in one hook, so rows drawn again together (as after a reload) are
  // noted in the transcript's order. A sent prompt: under it the engine lists its images, `⎿ [Image #N]`
  // a row; each gets a chip of its own over it, unpainted, so the engine's row shows as it was and
  // the pointer on it opens the card.
  on('ui.render', { component: ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen === false) return next(e)
    note(e)
    if (e.component !== 'UserMessage') return float($, e, await next(e))
    const all = await read($, pictures)
    const ids = e.props.origin.kind === 'composer' ? idsIn(e.props.text) : []
    for (const id of ids) if (!all[id]) void load($, id)
    const drawn = await next(e)
    // The engine lists the images it was sent, in the order pasted: each one stored, read or not.
    const listed = ids.filter(id => { const picture = all[id]; return picture && !('error' in picture && picture.error === NOT_STORED) })
    listed.sort((a, b) => a - b)
    const { Box, Client } = $.ui.resolve(e)
    const overlays: RenderElement[] = []
    listed.forEach((id, i) => {
      if ('error' in all[id]!) return
      overlays.push(
        <Box key={`listed-${id}`} position="absolute" bottom={-1 - i} left={LISTED_AT}>
          <Client key={`sent:${id}`} module="./chip.tsx" width={`[Image #${id}]`.length} height={1} />
        </Box>
      )
    })
    // The rows the engine lists the images in take the pointer but not a click, which stays the
    // engine's: a click opens an image from its `[Image #N]` in the prompt's first line, where the
    // place of each can be told (before the line wraps, after text one cell a character).
    const line = e.props.text.split('\n')[0]!
    const width = (e.viewport?.columns ?? 80) - 1
    const placed = new Set<number>()
    for (const match of line.matchAll(TOKEN)) {
      const id = Number(match[1])
      const at = PROMPT_AT + match.index
      const picture = all[id]
      if (placed.has(id) || !picture || 'error' in picture || !/^[\u0020-\u02ff]*$/.test(line.slice(0, match.index)) || at + match[0].length > width) continue
      placed.add(id)
      overlays.push(
        <Box key={`token-${id}`} position="absolute" top={1} left={at}>
          <Client key={`token:${id}`} module="./chip.tsx" width={match[0].length} height={1} />
        </Box>
      )
    }
    return float($, e, drawn, overlays)
  })

  // Above the prompt: the draft's images, each a chip that opens its card while the pointer is on
  // it. The card floats over the transcript; where too few of its rows show, the band holds it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Off fullscreen the terminal reports no pointer: nothing could be hovered.
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.viewport?.isFullscreen === false) return next(e)
    const ids = await read($, draft)
    const now = await read($, shown)
    const inBand = now && now.host === null && now.edge !== 'window' ? now.id : undefined
    if (ids.length === 0 && inBand === undefined) return next(e)
    if (e.viewport) screenRows = e.viewport.rows

    const ui = $.ui.resolve(e)
    const { Box, Client, Text } = ui
    const below: RenderElement = await next(e)
    const bounds = {
      columns: Math.max(8, Math.min(MAX_COLUMNS, e.props.bodyColumns)),
      rows: Math.max(4, Math.min(MAX_ROWS, e.props.maxRows - 1))
    }
    return (
      <Box flexDirection="column">
        {below}
        {inBand !== undefined && card(ui, await read($, pictures), inBand, bounds)}
        {ids.length > 0 && (
          <Box flexDirection="row" columnGap={1}>
            {ids.map(id => <Client key={`chip:${id}`} module="./chip.tsx" props={{ label: `[Image #${id}]` }} />)}
            <Text dimColor>hover to preview · click to open</Text>
          </Box>
        )}
      </Box>
    )
  })
}
