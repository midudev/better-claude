import type { Elements, EngineInterface, EventOf, FsStat, Register, RenderElement } from 'claude-code'

import { excerptOf, languageOf } from './code'
import type { Excerpt } from './code'
import { blocks, inline, items, markerOf, widthOf, wrap } from './markdown'
import type { Item, Row, Run } from './markdown'
import { lineOf, pathOfSpan, pathsIn, quotedIn, resolve, spacedAfter } from './paths'
import type { Found } from './paths'
import { MACOS } from './window'

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
/** A part of a path in a sent prompt: the row of its text and the column it starts at, its text, its target. */
type Spot = { row: number; column: number; label: string; link: number }
/** The paths of a sent prompt that lead somewhere, and where each part of them lands. */
type Sent = { spots: Spot[]; targets: Target[] }

// The bullet the engine draws before a reply, by system, and the columns it takes.
const BULLET = { macos: '⏺', other: '●' }
const BULLET_COLUMNS = 2
// How long a path is taken to be there, or not there, before it is looked at again; and a plan.
const FOUND_MS = 30_000
const MISSING_MS = 3_000
const PLAN_MS = 10_000
const PLANS = 300
// The longest side of the preview's picture, in points, and the most seconds the window stays.
const WINDOW_SIZE = 360
const WINDOW_LIFE = 60
// The largest file of code or text read for its lines; the lines the window shows, the lines and
// columns a card shows.
const CODE_BYTES = 1024 * 1024
const WINDOW_LINES = 20
const CARD_LINES = 8
const CARD_COLUMNS = 100
// A sent prompt: the engine draws it after `❯ `, on the row under the blank one above it, short of
// the row's last column; as Markdown up to this many characters. The most words after an unquoted
// path that may still be part of it (`/a/Application Support/x.png`).
const PROMPT_LEFT = 2
const PROMPT_TOP = 1
const PROMPT_RIGHT = 1
const PROMPT_MARKDOWN = 4000
const SPACED_WORDS = 8
// A line the engine's Markdown would draw otherwise than written: a block's marker, emphasis,
// code, a link, an escape, HTML. Past one, the mod cannot tell where the prompt's text lands.
const MARKED = /^\s*(?:#|>|[-+*]\s|\d+[.)]\s|```|~~~|\|)|^ {4}|[`*]|~~|\]\(|<[A-Za-z/!]|\\[!-/:-@[-`{-~]|(?:^|\W)_|_(?:\W|$)/

const stats = new Map<string, { stat: FsStat | null; at: number }>()
const plans = new Map<string, { plan: Plan | null; at: number }>()
const sents = new Map<string, { sent: Sent | null; at: number }>()
const excerpts = new Map<string, Excerpt | null>()
let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
// Whether a hover opens a window by the pointer (macOS); else each path carries a card the
// terminal reveals over it. The path the pointer is on, and the part it is on; the window open.
let windowing = false
let hovered: { path: string; line: number | undefined; target: string } | undefined
let window: { path: string; line: number | undefined; isOpen: boolean } | undefined

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

/**
 * Where the paths a sent prompt names that lead somewhere land, its text wrapped `width` columns as
 * the engine wraps it: each path in quotes whole, spaces and all; one with none, with the words
 * after it that make a path that is there. Only the lines before the first blank one or the first
 * the engine's Markdown changes: past those the mod cannot tell where the text lands.
 */
async function sentOf ($: Engine, text: string, width: number): Promise<Sent | null> {
  if (text.length > PROMPT_MARKDOWN || width < 10) return null
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  const key = `${cwd}\n${root}\n${width}\n${text}`
  const known = sents.get(key)
  if (known && Date.now() - known.at < PLAN_MS) return known.sent

  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const pathsOf = (found: Found) => [...new Set([cwd, root].flatMap(base => resolve(found.target, base, home) ?? []))]
  const lines: { text: string; named: Found[][] }[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '' || MARKED.test(line)) break
    // Each path a list of what it may name, longest first; one in quotes, the quotes masked.
    const quoted = quotedIn(line)
    const masked = quoted.reduce((out, { start, end }) => out.slice(0, start - 1) + ' '.repeat(end - start + 2) + out.slice(end + 1), line)
    const bare = pathsIn(masked).map(found => [...spacedAfter(masked, found, SPACED_WORDS), found])
    lines.push({ text: line, named: [...quoted.map(found => [found]), ...bare].sort((a, b) => a[0]!.start - b[0]!.start) })
  }
  const paths = [...new Set(lines.flatMap(line => line.named.flat().flatMap(pathsOf)))]
  const found = new Map((await Promise.all(paths.map(async path => [path, await statOf($, path)] as const))).filter(([, stat]) => stat !== null) as [string, FsStat][])

  const targets: Target[] = []
  const spots: Spot[] = []
  let rows = 0
  for (const line of lines) {
    const kept: { start: number; end: number; link: number }[] = []
    for (const options of line.named) {
      if (options[0]!.start < (kept.at(-1)?.end ?? 0)) continue
      for (const option of options) {
        const path = pathsOf(option).find(candidate => found.has(candidate))
        if (path === undefined) continue
        const named = line.text.slice(option.start, option.end)
        const lineNamed = lineOf(named)
        kept.push({ start: option.start, end: option.end, link: targets.push({ path, stat: found.get(path)!, ...(lineNamed !== undefined && { line: lineNamed }) }) - 1 })
        break
      }
    }
    const wrapped = wrap(link({ text: line.text, style: {} }, kept), width, false)
    wrapped.forEach((row, i) => {
      let column = 0
      for (const run of row) {
        if (run.link !== undefined) spots.push({ row: rows + i, column, label: run.text, link: run.link })
        column += widthOf(run.text)
      }
    })
    rows += wrapped.length
  }
  if (!windowing) {
    await Promise.all(targets.map(async target => {
      const code = await excerptAt($, target.path, target.stat, target.line, CARD_LINES)
      if (code) target.code = code
    }))
  }
  const sent = targets.length > 0 ? { spots, targets } : null
  if (sents.size >= PLANS) sents.delete(sents.keys().next().value!)
  sents.set(key, { sent, at: Date.now() })
  return sent
}

/** The engine's drawing of a sent prompt, with a bare region over each part of a path in it. */
function drawSent (ui: Ui, drawn: RenderElement, sent: Sent, width: number) {
  const { Box } = ui
  const parts = new Map<number, number>()
  return (
    <Box flexDirection="column">
      {drawn}
      {sent.spots.map((spot, i) => (
        <Box key={`spot:${i}`} position="absolute" top={PROMPT_TOP + spot.row} left={PROMPT_LEFT + spot.column}>
          {pathPart(ui, spot.label, {}, spot.link, sent.targets, parts, spot.column, width, true)}
        </Box>
      ))}
    </Box>
  )
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
  const name = target.path.slice(target.path.lastIndexOf('/') + 1) || target.path
  const what = target.stat.kind === 'dir' ? 'folder' : sizeOf(target.stat.size)
  return ` ${name} · ${what} · ${ago(target.stat.mtimeMs)} · click: show in folder `
}

/**
 * A part of a path, `label`: the `Client` that takes the pointer, at column `at` of a row `width`
 * wide. `isBare`, an unpainted region over the text the engine draws there.
 */
function pathPart (ui: Ui, label: string, style: Run['style'], link: number, targets: Target[], parts: Map<number, number>, at: number, width: number, isBare = false) {
  const { Box, Client, Code, Text } = ui
  const { bold, italic, strike } = style
  const part = parts.get(link) ?? 0
  parts.set(link, part + 1)
  const target = targets[link]!
  const props = { label, path: target.path, ...(target.line !== undefined && { line: target.line }), ...(bold && { bold }), ...(italic && { italic }), ...(strike && { strike }), ...(isBare && { isBare }) }
  const client = isBare
    ? <Client key={`path:${link}:${part}`} module="./link.tsx" props={props} width={widthOf(label)} height={1} />
    : <Client key={`path:${link}:${part}`} module="./link.tsx" props={props} />
  if (windowing) return client
  // No window: a card over the path, which the terminal reveals while the pointer is on it,
  // moved left as far as it needs to end inside the reply. A file of code or text shows its
  // lines under the card's line, coloured by the engine, on the background of the theme.
  const card = cardOf(target)
  const excerpt = target.code
  const cardWidth = Math.min(excerpt ? Math.max(widthOf(card), CARD_COLUMNS) : widthOf(card), width)
  const left = Math.max(-at, Math.min(0, width - at - cardWidth))
  return (
    <Box key={`card:${link}:${part}`}>
      {client}
      <Box position="absolute" top={-1 - (excerpt?.lines.length ?? 0)} left={left} width={cardWidth} flexDirection="column" display="none" hover={{ display: 'flex' }} {...(excerpt && { backgroundColor: 'inverseText' })}>
        <Text inverse wrap="truncate-end">{card}</Text>
        {excerpt && <Code source={excerpt.source} path={target.path} startLine={excerpt.first} wrap="truncate-end" />}
      </Box>
    </Box>
  )
}

/**
 * The rows of a wrapped paragraph, `width` columns: text in its style, each part of a path a
 * `Client` that takes the pointer.
 */
function drawRows (ui: Ui, rows: Row[], width: number, targets: Target[], parts: Map<number, number>) {
  const { Box, Link, Text } = ui
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
          return pathPart(ui, run.text, run.style, run.link, targets, parts, at, width)
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
    const windows = path.replaceAll('/', '\\')
    await run(isOpening ? ['explorer', windows] : ['explorer', `/select,${windows}`])
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
 * and leaving the loop ends the program. One that ends without having shown a window, on a path
 * that is there, says the system shows none: from then on the terminal shows the cards.
 */
async function openWindow ($: Engine, path: string, line: number | undefined) {
  closeWindow()
  const opening = { path, line, isOpen: true }
  window = opening
  const env: Record<string, string> = { QUICK_PEEK_FILE: path, QUICK_PEEK_SIZE: String(WINDOW_SIZE), QUICK_PEEK_LIFE: String(WINDOW_LIFE), QUICK_PEEK_HINT: 'click: show in Finder · ⌥ click: open' }
  const stat = await statOf($, path)
  const code = stat && (await excerptAt($, path, stat, line, WINDOW_LINES))
  if (!opening.isOpen) return
  if (code) {
    const { source, ...shown } = code
    env.QUICK_PEEK_CODE = JSON.stringify(shown)
  }
  let isShown = false
  let said = ''
  try {
    for await (const { text } of $.process.spawn({ argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env })) {
      if (said.length < 2000) said += text
      if (/^shown$/m.test(text)) isShown = true
      if (!opening.isOpen) break
    }
  } catch (error) {
    said += error instanceof Error ? error.message : String(error)
  }
  if (window === opening) window = undefined
  if (isShown || !opening.isOpen || /^error: not there/m.test(said)) return
  $.ui.log(`quick-peek: no window (${said.replace(/\.\n/g, '').trim().slice(0, 300) || 'the program could not start'}); the terminal shows the cards`, { to: 'debug' })
  windowing = false
  plans.clear()
  sents.clear()
}

function closeWindow () {
  if (window) window.isOpen = false
  window = undefined
}

/**
 * The pointer came onto a part of `path` naming `line` (`target`, the part's address): its preview
 * opens, unless it is open.
 */
function over ($: Engine, path: string, line: number | undefined, target: string) {
  const isOpen = hovered?.path === path && hovered.line === line && window?.path === path && window.line === line && window.isOpen
  hovered = { path, line, target }
  if (isOpen || !windowing) return
  void openWindow($, path, line)
}

/** The pointer left a part: the preview closes, unless the pointer is already on another part of it. */
function off (target: string) {
  if (hovered?.target !== target) return
  hovered = undefined
  closeWindow()
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const [system, sshConnection, sshTty] = await Promise.all([platformOf($), $.env.get('SSH_CONNECTION'), $.env.get('SSH_TTY')])
    // A window opens on the desktop the session runs on: not over SSH, where that is another machine's.
    windowing = options.window !== false && e.isInteractive && system === 'macos' && sshConnection === undefined && sshTty === undefined
    plans.clear()
    sents.clear()
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
    else off(target)
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

  // A prompt the user sent that names a path that leads somewhere: the engine draws it, and the
  // mod lays a bare region over each part of each path, which takes the pointer and the click.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen !== true || e.props.origin.kind !== 'composer') return next(e)
    const width = e.viewport.columns - PROMPT_LEFT - PROMPT_RIGHT
    const sent = await sentOf($, e.props.text, width).catch(() => null)
    if (!sent) return next(e)
    const drawn = await next(e)
    return drawSent($.ui.resolve(e), drawn, sent, width)
  })
}
