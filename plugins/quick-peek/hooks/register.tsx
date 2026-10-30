import type { Elements, EngineInterface, EventOf, FsStat, Register, RenderElement } from 'claude-code'

import { excerptOf, languageOf } from './code'
import type { Excerpt } from './code'
import { blocks, inline, items, markerOf, widthOf, wrap } from './markdown'
import type { Item, Row, Run } from './markdown'
import { lineOf, pathOfSpan, pathsIn, resolve } from './paths'
import { MACOS, WINDOWS, WINDOWS_BUILD, WINDOWS_OPEN, WINDOWS_REVEAL, WINDOWS_TYPES, powershell } from './window'

type Engine = EngineInterface
type Ui = Elements['terminal']
type Message = Extract<EventOf['ui.render'], { component: 'AssistantMessage', surface: 'terminal' }>
type Platform = 'macos' | 'linux' | 'windows' | 'other'

/**
 * A path a reply names that leads somewhere: where it lands, what is there, and the line it names;
 * with no window, the lines of code or text its card shows.
 */
type Target = { path: string; stat: FsStat; line?: number; code?: Excerpt }
/** An item of a list the mod draws: its marker, its runs, the items under it, blank lines before it. */
type DrawnItem = { marker: string; runs: Run[]; children: DrawnItem[]; gap: number }
/** A part of a reply: drawn by the engine's Markdown, or by the mod, its paths links. */
type Part =
  | { kind: 'markdown'; text: string; gap: number }
  | { kind: 'paragraph'; runs: Run[]; gap: number }
  | { kind: 'list'; items: DrawnItem[]; gap: number }
/** How the mod draws a reply: its parts, and the paths its runs link to (`Run.link` indexes them). */
type Plan = { parts: Part[]; targets: Target[] }

// The bullet the engine draws before a reply, by system, and the columns it takes.
const BULLET = { macos: '⏺', other: '●' }
const BULLET_COLUMNS = 2
// How long a path is taken to be there, or not there, before it is looked at again; and a plan.
const FOUND_MS = 30_000
const MISSING_MS = 3_000
const PLAN_MS = 10_000
const PLANS = 300
// The longest side of the preview's picture, in points, and the most seconds the window stays; the
// line under it that says what a click does, by system.
const WINDOW_SIZE = 360
const WINDOW_LIFE = 60
const WINDOW_HINT = { macos: 'click: show in Finder · ⌥ click: open', windows: 'click: show in Explorer · Alt click: open' }
// How long the pointer rests on a path before its window opens: crossing a list of paths opens
// none. How long a window stays once the pointer left its path, in case it comes back. How many
// programs in a row may fail to start before the terminal shows the cards.
const OPEN_MS = 150
const LEAVE_MS = 200
const FAILURES = 3
// The largest file of code or text read for its lines; the lines the window shows, the lines and
// columns a card shows.
const CODE_BYTES = 1024 * 1024
const WINDOW_LINES = 20
const CARD_LINES = 8
const CARD_COLUMNS = 100

const stats = new Map<string, { stat: FsStat | null; at: number }>()
const plans = new Map<string, { plan: Plan | null; at: number }>()
const excerpts = new Map<string, Excerpt | null>()
let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
// The system whose window a hover opens by the pointer (macOS, Windows); else none, and each path
// carries a card the terminal reveals over it. The path the pointer is on, and the part it is on;
// the window open; how many programs in a row ended without showing one. On Windows, where the
// compiled window is, and whether the system refused to start it.
let windowing: 'macos' | 'windows' | undefined
let hovered: { path: string; line: number | undefined; target: string } | undefined
let window: { path: string; line: number | undefined; isOpen: boolean } | undefined
let failures = 0
let assembly: Promise<string> | undefined
let isExeBlocked = false

/** The system the session runs on, asked once. */
function platformOf ($: Engine) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

/** Whether the session runs under WSL: Linux, on a Windows desktop, whose file manager shows the path. */
function wslOf ($: Engine) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/** What is at `path`, looked at again once its answer is old; null where nothing is. */
async function statOf ($: Engine, path: string) {
  const now = Date.now()
  const known = stats.get(path)
  if (known && now - known.at < (known.stat ? FOUND_MS : MISSING_MS)) return known.stat
  const stat = await $.fs.stat(path).catch(() => null)
  stats.set(path, { stat: stat && stat.kind !== 'other' ? stat : null, at: now })
  return stats.get(path)!.stat
}

/**
 * The `rows` lines a preview shows of the file at `path`, around `line` when it names one: null
 * for a file that is no code nor text, too large, or holds none. Read again once the file changes.
 */
async function excerptAt ($: Engine, path: string, stat: FsStat, line: number | undefined, rows: number) {
  const language = languageOf(path)
  if (!language || stat.kind !== 'file' || stat.size > CODE_BYTES) return null
  const key = `${path}\n${stat.size}\n${stat.mtimeMs}\n${line ?? 0}\n${rows}`
  const known = excerpts.get(key)
  if (known !== undefined) return known
  const text = await $.fs.read(path).catch(() => undefined)
  const excerpt = typeof text === 'string' ? excerptOf(text, language, line, rows) ?? null : null
  if (excerpts.size >= PLANS) excerpts.delete(excerpts.keys().next().value!)
  excerpts.set(key, excerpt)
  return excerpt
}

/** A run cut where it names a path, each path a run of its own carrying the target it links to. */
function link (run: Run, found: { start: number; end: number; link: number }[]): Run[] {
  const out: Run[] = []
  let at = 0
  for (const { start, end, link } of found) {
    if (start > at) out.push({ text: run.text.slice(at, start), style: run.style })
    out.push({ text: run.text.slice(start, end), style: run.style, link })
    at = end
  }
  if (at < run.text.length) out.push({ text: run.text.slice(at), style: run.style })
  return out
}

/**
 * How the mod draws `text`: its paragraphs and lists that name a path that leads somewhere drawn
 * by the mod, each such path a link; every other block, and the runs between, by the engine's
 * own Markdown. Null when no path in it leads anywhere: the engine draws the reply.
 */
async function planOf ($: Engine, text: string): Promise<Plan | null> {
  // A relative path leads from the folder the shell is in, or else from the project's: Claude
  // names paths from the project even after a `cd` took the shell into one of its folders.
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  const key = `${cwd}\n${root}\n${text}`
  const known = plans.get(key)
  if (known && Date.now() - known.at < PLAN_MS) return known.plan

  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  type Pending = { run: Run; found: { start: number; end: number; paths: string[]; line?: number }[] }
  const pending: Pending[] = []
  const runsOf = (source: string) =>
    inline(source).map(run => {
      const found: Pending['found'] = []
      if (run.style.href === undefined) {
        const named = run.style.code ? [pathOfSpan(run.text)].flatMap(target => (target ? [{ start: 0, end: run.text.length, target }] : [])) : pathsIn(run.text)
        for (const { start, end, target } of named) {
          const paths = [...new Set([cwd, root].flatMap(base => resolve(target, base, home) ?? []))]
          const line = lineOf(run.text.slice(start, end))
          if (paths.length > 0) found.push({ start, end, paths, ...(line !== undefined && { line }) })
        }
      }
      const entry = { run, found }
      pending.push(entry)
      return entry
    })

  type Drafted = { kind: 'markdown'; text: string; gap: number } | { kind: 'paragraph'; runs: Pending[]; gap: number } | { kind: 'list'; items: DraftItem[]; gap: number }
  type DraftItem = { marker: string; runs: Pending[]; children: DraftItem[]; gap: number }
  const draftItems = (list: Item[], depth: number): DraftItem[] =>
    list.map(item => ({ marker: markerOf(item, depth), runs: runsOf(item.text), children: draftItems(item.children, depth + 1), gap: item.gap }))
  const cut = blocks(text)
  const drafted: Drafted[] = cut.map(block =>
    block.kind === 'paragraph' ? { kind: 'paragraph', runs: runsOf(block.text), gap: block.gap }
      : block.kind === 'list' ? { kind: 'list', items: draftItems(items(block.text), 0), gap: block.gap }
        : { kind: 'markdown', text: block.text, gap: block.gap })

  const paths = [...new Set(pending.flatMap(entry => entry.found.flatMap(found => found.paths)))]
  const found = new Map((await Promise.all(paths.map(async path => [path, await statOf($, path)] as const))).filter(([, stat]) => stat !== null) as [string, FsStat][])
  const targets: Target[] = []
  const finish = (runs: Pending[]) =>
    runs.flatMap(({ run, found: named }) => {
      const kept = named.flatMap(({ paths: candidates, ...entry }) => {
        const path = candidates.find(candidate => found.has(candidate))
        return path === undefined ? [] : [{ ...entry, link: targets.push({ path, stat: found.get(path)!, ...(entry.line !== undefined && { line: entry.line }) }) - 1 }]
      })
      return link(run, kept)
    })
  const linked = (runs: Run[]) => runs.some(run => run.link !== undefined)
  const finishItems = (list: DraftItem[]): DrawnItem[] => list.map(item => ({ marker: item.marker, runs: finish(item.runs), children: finishItems(item.children), gap: item.gap }))
  const anyLinked = (list: DrawnItem[]): boolean => list.some(item => linked(item.runs) || anyLinked(item.children))

  const parts: Part[] = []
  drafted.forEach((draft, i) => {
    let part: Part = { kind: 'markdown', text: cut[i]!.text, gap: draft.gap }
    if (draft.kind === 'paragraph') {
      const runs = finish(draft.runs)
      if (linked(runs)) part = { kind: 'paragraph', runs, gap: draft.gap }
    } else if (draft.kind === 'list') {
      const list = finishItems(draft.items)
      if (anyLinked(list)) part = { kind: 'list', items: list, gap: draft.gap }
    }
    // The blocks the engine draws next to each other are one Markdown, as written between them.
    const last = parts.at(-1)
    if (part.kind === 'markdown' && last?.kind === 'markdown') last.text += '\n'.repeat(part.gap + 1) + part.text
    else parts.push(part)
  })
  // With no window, a card shows a file of code or text: its lines are read now.
  if (!windowing) {
    await Promise.all(targets.map(async target => {
      const code = await excerptAt($, target.path, target.stat, target.line, CARD_LINES)
      if (code) target.code = code
    }))
  }
  const plan = targets.length > 0 ? { parts, targets } : null
  if (plans.size >= PLANS) plans.delete(plans.keys().next().value!)
  plans.set(key, { plan, at: Date.now() })
  return plan
}

const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  const [value, unit] = seconds < 60 ? [seconds, 's'] : seconds < 3600 ? [Math.round(seconds / 60), 'min'] : seconds < 86400 ? [Math.round(seconds / 3600), 'h'] : [Math.round(seconds / 86400), 'd']
  return `${value} ${unit} ago`
}

/** The line the terminal shows over a path where no window can: what it is, and what a click does. */
function cardOf (target: Target) {
  const name = target.path.slice(Math.max(target.path.lastIndexOf('/'), target.path.lastIndexOf('\\')) + 1) || target.path
  const what = target.stat.kind === 'dir' ? 'folder' : sizeOf(target.stat.size)
  return ` ${name} · ${what} · ${ago(target.stat.mtimeMs)} · click: show in folder `
}

/**
 * The rows of a wrapped paragraph, `width` columns: text in its style, each part of a path a
 * `Client` that takes the pointer.
 */
function drawRows (ui: Ui, rows: Row[], width: number, targets: Target[], parts: Map<number, number>) {
  const { Box, Client, Code, Link, Text } = ui
  return rows.map(row => {
    let column = 0
    return (
      <Box flexDirection="row">
        {row.length === 0 && <Text> </Text>}
        {row.map(run => {
          const at = column
          column += widthOf(run.text)
          const { bold, italic, strike, code, href } = run.style
          if (run.link === undefined) {
            const style = { bold, italic, strikethrough: strike, ...(code && { color: 'permission' }) }
            return href === undefined ? <Text {...style}>{run.text}</Text> : <Text {...style}><Link href={href}>{run.text}</Link></Text>
          }
          const part = parts.get(run.link) ?? 0
          parts.set(run.link, part + 1)
          const target = targets[run.link]!
          const props = { label: run.text, path: target.path, ...(target.line !== undefined && { line: target.line }), ...(bold && { bold }), ...(italic && { italic }), ...(strike && { strike }) }
          const client = <Client key={`path:${run.link}:${part}`} module="./link.tsx" props={props} />
          if (windowing) return client
          // No window: a card over the path, which the terminal reveals while the pointer is on it,
          // moved left as far as it needs to end inside the reply. A file of code or text shows its
          // lines under the card's line, coloured by the engine, on the background of the theme.
          const card = cardOf(target)
          const excerpt = target.code
          const cardWidth = Math.min(excerpt ? Math.max(widthOf(card), CARD_COLUMNS) : widthOf(card), width)
          const left = Math.max(-at, Math.min(0, width - at - cardWidth))
          return (
            <Box key={`card:${run.link}:${part}`}>
              {client}
              <Box position="absolute" top={-1 - (excerpt?.lines.length ?? 0)} left={left} width={cardWidth} flexDirection="column" display="none" hover={{ display: 'flex' }} {...(excerpt && { backgroundColor: 'inverseText' })}>
                <Text inverse wrap="truncate-end">{card}</Text>
                {excerpt && <Code source={excerpt.source} path={target.path} startLine={excerpt.first} wrap="truncate-end" />}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

function drawList (ui: Ui, list: DrawnItem[], width: number, targets: Target[], parts: Map<number, number>): RenderElement[] {
  const { Box, Text } = ui
  return list.map((item, i) => {
    const indent = widthOf(item.marker) + 1
    return (
      <Box flexDirection="row" marginTop={i > 0 && item.gap > 0 ? 1 : 0}>
        <Box minWidth={indent} flexShrink={0}><Text>{item.marker}</Text></Box>
        <Box flexDirection="column" width={width - indent}>
          {drawRows(ui, wrap(item.runs, width - indent), width - indent, targets, parts)}
          {drawList(ui, item.children, width - indent, targets, parts)}
        </Box>
      </Box>
    )
  })
}

/** The reply as the engine lays it out, its bullet and its blocks, with the paths in it links. */
function draw (ui: Ui, e: Message, plan: Plan, bullet: string) {
  const { Box, Markdown, Text } = ui
  const width = Math.max(10, (e.viewport?.columns ?? 80) - BULLET_COLUMNS)
  const parts = new Map<number, number>()
  return (
    <Box flexDirection="row">
      <Box minWidth={BULLET_COLUMNS} flexShrink={0}>{e.props.isFirstOfReply && <Text color="text">{bullet}</Text>}</Box>
      <Box flexDirection="column" width={width}>
        {plan.parts.map((part, i) => {
          const marginTop = i > 0 && part.gap > 0 ? 1 : 0
          if (part.kind === 'markdown') return <Box marginTop={marginTop}><Markdown text={part.text} /></Box>
          const drawn = part.kind === 'paragraph' ? drawRows(ui, wrap(part.runs, width), width, plan.targets, parts) : drawList(ui, part.items, width, plan.targets, parts)
          return <Box flexDirection="column" marginTop={marginTop}>{drawn}</Box>
        })}
      </Box>
    </Box>
  )
}

/** The tree `next` drew with the engine's node in it swapped for `mine`: what other plugins drew around it stays. */
function swap (drawn: RenderElement, mine: RenderElement): RenderElement {
  let isSwapped = false
  const walk = (node: unknown): unknown => {
    if (isSwapped || node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walk)
    const element = node as { type?: unknown; children?: unknown[] }
    if (element.type === 'engine') {
      isSwapped = true
      return mine
    }
    return Array.isArray(element.children) ? { ...element, children: element.children.map(walk) } : node
  }
  const out = walk(drawn) as RenderElement
  return isSwapped ? out : mine
}

/** Shows `path` in the system's file manager, selected; with `isOpening`, opens it instead. */
async function reveal ($: Engine, path: string, isOpening: boolean) {
  const run = (argv: string[]) => $.process.run(argv).catch(() => undefined)
  if (await wslOf($)) {
    const windows = (await run(['wslpath', '-w', path]))?.stdout.trim()
    if (windows) await run(isOpening ? ['explorer.exe', windows] : ['explorer.exe', `/select,${windows}`])
    return
  }
  const system = await platformOf($)
  if (system === 'macos') {
    await run(isOpening ? ['open', path] : ['open', '-R', path])
    return
  }
  if (system === 'windows') {
    const env = { QUICK_PEEK_FILE: path.replaceAll('/', '\\') }
    await $.process.run(powershell(isOpening ? WINDOWS_OPEN : WINDOWS_REVEAL), { env }).catch(() => undefined)
    return
  }
  if (isOpening) {
    await run(['xdg-open', path])
    return
  }
  // The desktop's file manager selects it where it answers FileManager1; else its folder opens.
  const uri = `file://${path.split('/').map(encodeURIComponent).join('/')}`
  const shown = await run(['dbus-send', '--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'])
  if (shown?.exitCode !== 0) await run(['xdg-open', path.slice(0, path.lastIndexOf('/')) || '/'])
}

/**
 * Shows `path` in a window by the pointer till `closeWindow`; a file of code or text, its lines
 * around `line`. The program says `.` ten times a second, so the loop wakes to see it was closed,
 * and leaving the loop ends the program. One that says it shows no window (`error: …`), on a path
 * that is there, or `FAILURES` in a row that end without showing one, say the system shows none:
 * from then on the terminal shows the cards.
 */
async function openWindow ($: Engine, path: string, line: number | undefined) {
  closeWindow()
  const system = windowing
  if (!system) return
  const opening = { path, line, isOpen: true }
  window = opening
  // Only once the pointer rests on the path: one program, not one for each path it crosses.
  await $.clock.sleep(OPEN_MS)
  if (!opening.isOpen || hovered?.path !== path || hovered.line !== line) {
    if (window === opening) closeWindow()
    return
  }
  const env: Record<string, string> = { QUICK_PEEK_FILE: path, QUICK_PEEK_SIZE: String(WINDOW_SIZE), QUICK_PEEK_LIFE: String(WINDOW_LIFE), QUICK_PEEK_HINT: WINDOW_HINT[system] }
  const stat = await statOf($, path)
  const code = stat && (await excerptAt($, path, stat, line, WINDOW_LINES))
  if (!opening.isOpen) return
  if (code) {
    const { source, ...shown } = code
    env.QUICK_PEEK_CODE = JSON.stringify(shown)
  }
  let argv = ['osascript', '-l', 'JavaScript', '-e', MACOS]
  let isDirect = false
  if (system === 'windows') {
    // The window, compiled once into an exe by PowerShell, starts on its own: in a third of
    // PowerShell's time and memory. PowerShell runs it for a PDF, whose first page it renders, and
    // where the exe does not start; it is told the C#, too long for a command line, in the environment.
    const exe = await assemblyOf($)
    env.QUICK_PEEK_ASSEMBLY = exe
    isDirect = !isExeBlocked && !(!code && /\.pdf$/i.test(path)) && (await $.fs.exists(exe).catch(() => false))
    argv = isDirect ? [exe] : powershell(WINDOWS)
    if (!isDirect) env.QUICK_PEEK_TYPES = WINDOWS_TYPES
  }
  let { isShown, said } = await show($, opening, argv, env)
  if (isDirect && !isShown && opening.isOpen && !/^error: not there/m.test(said)) {
    // An exe the system will not start from the temp folder (AppLocker): PowerShell runs it from now on.
    isExeBlocked = true
    $.ui.log(`quick-peek: the window's exe did not start (${reasonOf(said)}); PowerShell runs it`, { to: 'debug' })
    ;({ isShown, said } = await show($, opening, powershell(WINDOWS), { ...env, QUICK_PEEK_TYPES: WINDOWS_TYPES }))
  }
  if (window === opening) window = undefined
  if (isShown) failures = 0
  if (isShown || !opening.isOpen || /^error: not there/m.test(said)) return
  // A program that failed to start (many PowerShells at once) may start the next time.
  if (!/^error/m.test(said) && ++failures < FAILURES) {
    $.ui.log(`quick-peek: no window (${reasonOf(said)}); the next hover tries again`, { to: 'debug' })
    return
  }
  $.ui.log(`quick-peek: no window (${reasonOf(said)}); the terminal shows the cards`, { to: 'debug' })
  windowing = undefined
  plans.clear()
}

/** Runs the window's program till it ends or `opening` closes: whether it showed a window, and what it said. */
async function show ($: Engine, opening: { isOpen: boolean }, argv: string[], env: Record<string, string>) {
  let isShown = false
  let said = ''
  try {
    for await (const { text } of $.process.spawn({ argv, env })) {
      if (said.length < 2000) said += text
      if (/^shown$/m.test(text)) isShown = true
      if (!opening.isOpen) break
    }
  } catch (error) {
    said += error instanceof Error ? error.message : String(error)
  }
  return { isShown, said }
}

/** What a program said as it failed, to log: PowerShell may write in UTF-16, its NULs dropped. */
const reasonOf = (said: string) => said.replaceAll('\u0000', '').replace(/\.\r?\n/g, '').trim().slice(0, 300) || 'the program could not start'

/** Where the compiled window is: the temp folder, named by its source's hash. */
function assemblyOf ($: Engine) {
  assembly ??= (async () => `${((await $.env.get('TEMP')) ?? 'C:\\Windows\\Temp').replace(/[\\/]+$/, '')}\\${WINDOWS_BUILD}`)()
  return assembly
}

function closeWindow () {
  if (window) window.isOpen = false
  window = undefined
}

/**
 * The pointer came onto a part of `path` naming `line` (`target`, the part's address): its preview
 * opens, unless it is open: one about to close, as the pointer had left, stays.
 */
function over ($: Engine, path: string, line: number | undefined, target: string) {
  hovered = { path, line, target }
  if (!windowing || (window?.path === path && window.line === line && window.isOpen)) return
  void openWindow($, path, line)
}

/**
 * The pointer left a part: the preview closes a moment later, unless the pointer is back on its
 * path. A terminal may say the pointer left as it comes on (Windows': a few milliseconds after),
 * and a window ended and opened again would blink, and come later.
 */
async function off ($: Engine, target: string) {
  if (hovered?.target !== target) return
  hovered = undefined
  const closing = window
  if (!closing) return
  await $.clock.sleep(LEAVE_MS)
  if (hovered?.path === closing.path && hovered.line === closing.line) return
  closing.isOpen = false
  if (window === closing) window = undefined
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const [system, sshConnection, sshTty] = await Promise.all([platformOf($), $.env.get('SSH_CONNECTION'), $.env.get('SSH_TTY')])
    // A window opens on the desktop the session runs on: not over SSH, where that is another machine's.
    const hasWindow = options.window !== false && e.isInteractive && sshConnection === undefined && sshTty === undefined
    windowing = hasWindow && (system === 'macos' || system === 'windows') ? system : undefined
    failures = 0
    isExeBlocked = false
    plans.clear()
    stats.clear()
    excerpts.clear()
    return result
  })

  on('session.end', ($, e, next) => {
    hovered = undefined
    closeWindow()
    return next(e)
  })

  // Typing or sending a prompt closes a preview: what is under the pointer may move.
  on('prompt.edit', ($, e, next) => {
    if (hovered) {
      hovered = undefined
      closeWindow()
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    hovered = undefined
    closeWindow()
    return next(e)
  }).catch(($, e, next) => next(e))

  // A part of a path says when the pointer comes onto it and leaves it: its preview opens and
  // closes. Clicked, the path shows in the file manager; alt-clicked, it opens.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    if (!e.element.startsWith('path:')) return result
    const data = e.data as { path?: unknown; line?: unknown; isOver?: unknown; isClicked?: unknown; isAlt?: unknown } | null
    if (typeof data?.path !== 'string') return result
    const target = `${e.requestId}/${e.element}`
    if (data.isClicked === true) {
      hovered = undefined
      closeWindow()
      void reveal($, data.path, data.isAlt === true)
      return result
    }
    if (data.isOver === true) over($, data.path, typeof data.line === 'number' ? data.line : undefined, target)
    else void off($, target)
    return result
  })

  // A reply that names a path that leads somewhere: the mod draws it, its bullet, its blocks the
  // engine's Markdown draws, and the paragraphs and lists that name paths, the paths links. Off
  // fullscreen the terminal reports no pointer: the engine draws it as it is.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen !== true || e.props.isSummary) return next(e)
    const plan = await planOf($, e.props.text).catch(() => null)
    if (!plan) return next(e)
    const drawn = await next(e)
    const bullet = (await platformOf($)) === 'macos' ? BULLET.macos : BULLET.other
    return swap(drawn, draw($.ui.resolve(e), e, plan, bullet))
  })
}
