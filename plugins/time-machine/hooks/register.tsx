// Time Machine as a Claude Code mod: one hooks module over git.
//
// The working tree has a history of STATES, like an editor's undo tree: the start of the
// session, the end of every turn that changed files, and changes made outside Claude. A
// cursor says which one the files are in now; going to another state moves the cursor and
// the files, and adds no row.
//
// - The first call of a turn that can change files (Edit, Write, NotebookEdit, Bash that does
//   not only look) snapshots the tree first; the end of the turn snapshots it again and adds
//   a state, its parent the state the turn started from.
// - /timeline opens the states in a pane: choosing a row shows what Enter would change,
//   Enter goes there, `u`/`r` undo and redo. /timeline <n>, undo and redo do the same.
// - The turn under way shows at once at the top, its files filling in as Claude edits.
// - Files changed by hand since the cursor are saved as a state before a jump: nothing is
//   ever lost, so a jump needs no confirmation.
// - Claude hears of jumps once, with the next prompt: what differs from the files it left.
// - Snapshots are commits no branch points at (refs/time-machine/<session>/<id>), built in an
//   index of their own: the staging area, HEAD and the branches are never touched.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventOf, Register, RenderElement } from 'claude-code'

import { ICON, activity, ago, digest, digestText, elapsed, shorten, summary, sweep } from '../src/format.js'
import { MoveBlocked, REF_ROOT, changes, keep, locate, move, pin, prune, treeOf } from '../src/git.js'
import { lineOf, merge, nextId } from '../src/states.js'
import { mayWrite } from '../src/tools.js'
import type { Change, Live, Preview, State } from '../types'

type Engine = EngineInterface
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C }>
type Repo = { top: string; gitDir: string; index: string }
// `outside`: no turn of the main loop, a background agent's tools: it blocks no jump
type Turn = { label: string; prompt: string; outside?: true; start: { tree: string; head: string | null } | null }

const PANE = 'time-machine'
const COMMAND = 'timeline'
const DAY_MS = 24 * 60 * 60 * 1000
const PROMPT_MAX = 2000
// The note about a jump names at most NOTE_FILES files: past that, how many more
const NOTE_FILES = 50
// The pinned footer of a docked pane: its rule, where things stand, the prompt (two lines),
// what Enter does, the keys
const FOOTER_ROWS = 6
const PROMPT_ROWS = 2
// A note stays NOTE_MS in the pane; the spinner of a running turn moves every SPIN_MS
const NOTE_MS = 6000
const SPIN_MS = 120
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The scanner under the running turn: a block of SWEEP_BLOCK cells crossing SWEEP_WIDTH
const SWEEP_WIDTH = 8
const SWEEP_BLOCK = 3
const ICON_COLOR: Record<string, string> = { A: 'success', D: 'error', M: 'warning' }

const SESSION = atom({ plugin: 'time-machine', key: 'session' } as const, '')
const STATES = atom({ plugin: 'time-machine', key: 'states' } as const, [] as State[])
const CURSOR = atom({ plugin: 'time-machine', key: 'cursor' } as const, null as number | null)
// The state the files left on the last jump: "jumped from" in the footer
const DEPARTED = atom({ plugin: 'time-machine', key: 'departed' } as const, null as number | null)
const DIRTY = atom({ plugin: 'time-machine', key: 'dirty' } as const, false)
const SELECTED = atom({ plugin: 'time-machine', key: 'selected' } as const, null as number | null)
const PREVIEW = atom({ plugin: 'time-machine', key: 'preview' } as const, null as Preview | null)
const LIVE = atom({ plugin: 'time-machine', key: 'live' } as const, null as Live | null)
const NOTE = atom({ plugin: 'time-machine', key: 'note' } as const, null as string | null)

// The repository of this session (null outside one), its id, and the turn under way
let repo: Repo | null = null
let sessionId = ''
// How long snapshots, and the saved states that point at them, are kept
let keepMs = 7 * DAY_MS
let turn: Turn | null = null
// The spinner of the running turn; a refresh of its files already waiting in the chain, so a
// burst of edits reads the tree once
let spinner: { cancel: () => void } | null = null
let liveQueued = false
// Whose DeLorean it is: the first name in git's user.name, empty when git has none
let driver = ''
// The tree Claude last left the files in, and whether a jump has moved them since
// Both are kept with the session's states, so a jump made before a restart still reaches Claude
let modelTree: string | null = null
let jumped = false
// Tool calls that may write and are still running, a background agent's included: no jump
// moves the files under one
let writing = 0
// Every git step goes one after another: a turn's start, its end and a jump never interleave
let chain: Promise<unknown> = Promise.resolve()
const exclusive = <T,>(work: () => Promise<T>): Promise<T> => {
  const next = chain.then(work, work)
  chain = next.catch(() => undefined)
  return next
}

const runner = ($: Engine) => (argv: readonly string[], init?: object) => $.process.run(argv, init)
const refOf = (id: number) => `${REF_ROOT}/${sessionId}/${id}`

type Saved = { states?: State[]; cursor?: number | null; modelTree?: string | null; jumped?: boolean }

async function save ($: Engine, states: State[], cursor: number | null) {
  await update($, STATES, () => states)
  await update($, CURSOR, () => cursor)
  await $.store.set(`session:${sessionId}`, { at: await $.clock.now(), states, cursor, modelTree, jumped })
}

/** Saves what Claude last saw and whether a jump moved it since, with the states as they are. */
async function remember ($: Engine) {
  await save($, await read($, STATES), await read($, CURSOR))
}

/** The state the cursor is on, if any. */
async function current ($: Engine) {
  const cursor = await read($, CURSOR)
  return (await read($, STATES)).find(state => state.id === cursor)
}

/** Adds a state, kept by a ref of its own, and puts the cursor on it. */
async function addState ($: Engine, now: { tree: string; head: string | null }, kind: State['kind'], label: string, parent: State | undefined, prompt?: string) {
  const run = runner($)
  const id = nextId(await read($, STATES))
  const commit = await keep(run, repo!, now, refOf(id), `time-machine: #${id} · ${label}`)
  const state: State = {
    id,
    kind,
    label,
    at: await $.clock.now(),
    commit,
    tree: now.tree,
    parent: parent?.id ?? null,
    files: parent ? await changes(run, repo!, parent.tree, now.tree) : [],
    ...(prompt ? { prompt } : {})
  }
  await save($, [...await read($, STATES), state], state.id)
  return state
}

/**
 * The states of this session on (re)start: the live ones, which a hot reload keeps, merged
 * with the saved ones (see merge), the refs of any state given a new id pointed again.
 */
async function loadStates ($: Engine, saved: Saved | undefined) {
  const isLive = await read($, SESSION) === sessionId
  const merged = merge(Array.isArray(saved?.states) ? saved.states : [], isLive ? await read($, STATES) : [])
  // A state older than the snapshots kept has lost its commit to prune: it goes, and a state
  // that came from it starts the line
  const since = await $.clock.now() - keepMs
  const kept = new Set(merged.states.filter(state => state.at >= since).map(state => state.id))
  const states = merged.states.filter(state => kept.has(state.id)).map(state => state.parent !== null && !kept.has(state.parent) ? { ...state, parent: null } : state)
  // A ref that cannot be pointed again (its commit collected) costs that state, not the session
  if (repo) for (const state of merged.repaired) await pin(runner($), repo, refOf(state.id), state.commit).catch(() => undefined)

  await update($, SESSION, () => sessionId)
  const cursor = isLive ? await read($, CURSOR) : saved?.cursor ?? null
  await save($, states, cursor !== null && kept.has(cursor) ? cursor : null)
}

/**
 * Removes the indexes of sessions that ended without saying so (a crash, a kill): any of ours
 * left untouched longer than the snapshots are kept, and the one shared index of before.
 */
async function pruneIndexes ($: Engine) {
  const since = await $.clock.now() - keepMs
  for (const entry of await $.fs.list(repo!.gitDir)) {
    const isOurs = /^time-machine(?:-.+)?\.index$/.test(entry.name) && `${repo!.gitDir}/${entry.name}` !== repo!.index
    if (isOurs && (entry.name === 'time-machine.index' || entry.mtimeMs < since)) {
      await $.process.run(['rm', '-f', `${repo!.gitDir}/${entry.name}`]).catch(() => undefined)
    }
  }
}

/** Drops the saved states of the sessions older than the snapshots kept: theirs are pruned. */
async function pruneStore ($: Engine) {
  const since = await $.clock.now() - keepMs
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:') || key === `session:${sessionId}`) continue
    const saved = await $.store.get(key) as { at?: number } | undefined
    if (typeof saved?.at !== 'number' || saved.at < since) await $.store.delete(key)
  }
}

/**
 * Snapshots the working tree before the turn's first change, once per turn: the tree only.
 * It becomes a commit (and a state) at the end of the turn, if no state already holds it.
 */
async function startTurn ($: Engine) {
  if (!repo) return
  if (!turn) turn = { label: '(outside a turn)', prompt: '', outside: true, start: null }
  if (turn.start) return
  turn.start = await treeOf(runner($), repo)
}

/**
 * The end of a turn: a state for where it started (unless one already is that tree) and
 * one for where it ended. A turn that changed nothing adds none.
 */
async function finishTurn ($: Engine) {
  const ended = turn
  turn = null
  if (!repo) return
  // Every turn ends with Claude having seen the files as they are now, read-only turns too
  const now = await treeOf(runner($), repo)
  modelTree = now.tree
  jumped = false
  if (!ended?.start || now.tree === ended.start.tree) {
    await remember($)
    return
  }
  const { start } = ended
  const here = await current($)
  // The files moved since the cursor without Claude, or this is the first turn
  const from = (here?.tree === start.tree ? here : [...await read($, STATES)].reverse().find(state => state.tree === start.tree)) ??
    await addState($, start, here ? 'outside' : 'start', here ? 'changes outside Claude' : 'start of the session', here)
  await addState($, now, 'turn', ended.label, from, ended.prompt)
  await update($, DIRTY, () => false)
  await previewChosen($)
}

/** Reads where the files are: the cursor follows a state with the same tree, else `dirty`. */
async function refresh ($: Engine) {
  const now = await treeOf(runner($), repo!)
  const here = await current($)
  if (here?.tree === now.tree) {
    await update($, DIRTY, () => false)
    return now
  }
  const states = await read($, STATES)
  const match = [...states].reverse().find(state => state.tree === now.tree)
  if (match) await save($, states, match.id)
  await update($, DIRTY, () => !match && states.length > 0)
  return now
}

/** Puts the files as they were in state `id`; the person's unsaved changes become a state first. */
async function goTo ($: Engine, id: number, read0?: { tree: string; head: string | null }): Promise<string> {
  if (!repo) return 'Time Machine: this folder is not a git repository.'
  // Mid-turn, Claude works on files it has read: moving them under it would go unnoticed
  if (turn && !turn.outside) return 'Time Machine: a turn is running. Jump when it ends.'
  // A background agent's tool may be writing right now: the files would move under it
  if (writing > 0) return 'Time Machine: a tool is still changing files. Jump when it ends.'
  const target = (await read($, STATES)).find(state => state.id === id)
  if (!target) return `Time Machine: there is no #${id}. /${COMMAND} lists them.`

  // undo and redo have just read the tree: no second walk
  const now = read0 ?? await refresh($)
  const leaving = await read($, CURSOR)
  // After a resume, nothing has told us what Claude saw: the files before the first jump
  if (modelTree === null) modelTree = now.tree
  if (now.tree === target.tree) {
    await save($, await read($, STATES), target.id)
    await update($, DIRTY, () => false)
    return `Time Machine: the files are already at #${id}.`
  }
  let kept = ''
  if (await read($, DIRTY)) {
    const saved = await addState($, now, 'saved', 'your changes, kept before a jump', await current($))
    kept = driver ? ` Your changes are safe, ${driver}: kept as #${saved.id}.` : ` Your changes are safe: kept as #${saved.id}.`
    await update($, DEPARTED, () => saved.id)
  } else {
    await update($, DEPARTED, () => leaving)
  }
  let moved: Change[]
  try {
    moved = await move(runner($), repo, now.tree, target.tree)
  } catch (error) {
    if (!(error instanceof MoveBlocked)) throw error
    return `Time Machine: not going to #${id}: ${error.message}.${error.paths.length > 0 ? ' Move them away first.' : ''}`
  }
  await save($, await read($, STATES), target.id)
  await update($, DIRTY, () => false)
  jumped = true
  await remember($)
  await previewChosen($)
  const text = `⚡ 88 mph · At #${id} · ${target.label} (${summary(moved)} changed).${kept}`
  await update($, NOTE, () => text)
  $.clock.after(NOTE_MS, () => { void update($, NOTE, shown => shown === text ? null : shown) })
  return text
}

/** Undo: the cursor's parent, or the cursor itself when the files moved off it. */
async function undo ($: Engine): Promise<string> {
  if (!repo) return 'Time Machine: this folder is not a git repository.'
  const now = await refresh($)
  const here = await current($)
  if (!here) return 'Time Machine: nothing to undo yet.'
  if (await read($, DIRTY)) return goTo($, here.id, now)
  if (here.parent === null) return `Great Scott! #${here.id} is as far back as it goes.`
  return goTo($, here.parent, now)
}

/** Redo: the newest state that came from the cursor. */
async function redo ($: Engine): Promise<string> {
  if (!repo) return 'Time Machine: this folder is not a git repository.'
  const now = await refresh($)
  if (await read($, DIRTY)) return 'Time Machine: the files changed since; undo first, or pick a state.'
  const cursor = await read($, CURSOR)
  const next = [...await read($, STATES)].reverse().find(state => state.parent === cursor)
  return next ? goTo($, next.id, now) : 'Time Machine: nothing to redo.'
}

/** What going to state `id` would change from the files as they are, for the footer. */
async function preview ($: Engine, id: number) {
  // Run in the chain: by its turn the person may have moved on, and then this row is not worth a tree
  if (await read($, SELECTED) !== id) return
  const target = (await read($, STATES)).find(state => state.id === id)
  if (!repo || !target) return
  if (id === await read($, CURSOR) && !await read($, DIRTY)) {
    await update($, PREVIEW, () => null)
    return
  }
  const now = await treeOf(runner($), repo)
  const files = await changes(runner($), repo, now.tree, target.tree)
  if (await read($, SELECTED) === id) await update($, PREVIEW, () => ({ id, files }))
}

/** The chosen row's preview, again: after a jump or a turn the files it compared with moved. */
async function previewChosen ($: Engine) {
  await update($, PREVIEW, () => null)
  const chosen = await read($, SELECTED)
  if (chosen !== null) await preview($, chosen)
}

/** /timeline: no argument opens the pane; `<n>`, `undo` and `redo` move the files. */
async function timeline ($: Engine, args: string): Promise<{ text: string }> {
  const arg = args.trim().replace(/^#/, '').toLowerCase()
  if (arg === 'undo') return { text: await exclusive(() => undo($)) }
  if (arg === 'redo') return { text: await exclusive(() => redo($)) }
  if (arg !== '') {
    const id = Number(arg)
    if (!Number.isInteger(id) || id < 1) return { text: `Time Machine: /${COMMAND} <n> | undo | redo` }
    return { text: await exclusive(() => goTo($, id)) }
  }
  await $.ui.open({ id: PANE, title: 'Time Machine' })
  if (!repo) return { text: 'Time Machine: this folder is not a git repository.' }
  await exclusive(() => refresh($))
  const states = await read($, STATES)
  if (states.length === 0) return { text: 'Time Machine: no turn has changed files yet.' }
  const cursor = await read($, CURSOR)
  const dirty = await read($, DIRTY)
  const line = lineOf(states, cursor)
  const now = await $.clock.now()
  const lines = [...states].reverse().map(state => {
    const node = state.id === cursor && !dirty ? '◉' : line.has(state.id) ? '●' : '○'
    const what = digestText(state.files)
    return ` ${node} ${`#${state.id}`.padEnd(4)} ${shorten(state.label, 34).padEnd(34)}  ${shorten(what, 44).padEnd(44)} ${ago(now - state.at)}`
  })
  if (dirty) lines.unshift(' ◌ your changes, not saved yet')
  return { text: `⏪ Time Machine · ${states.length} states · /${COMMAND} <n> | undo | redo\n${lines.join('\n')}` }
}

/** The files the running turn has changed so far; one read of the tree for a burst of edits. */
async function liveRefresh ($: Engine) {
  liveQueued = false
  if (!repo || !turn?.start) return
  const now = await treeOf(runner($), repo)
  const files = await changes(runner($), repo, turn.start.tree, now.tree)
  await update($, LIVE, live => live ? { ...live, files } : live)
}

/**
 * Starts the running row: at once on the prompt, its spinner ticking until the turn ends. It
 * ticks whether the pane shows or not (a tick only redraws what reads it), so a pane opened
 * before a hot reload, or by a session resumed, still moves.
 */
async function liveStart ($: Engine, label: string, prompt: string) {
  spinner?.cancel()
  const at = await $.clock.now()
  await update($, LIVE, () => ({ label, prompt, at, files: [], doing: activity(null), frame: 0 }))
  spinner = $.clock.every(SPIN_MS, () => {
    void update($, LIVE, live => live ? { ...live, frame: live.frame + 1 } : live)
  })
}

async function liveEnd ($: Engine) {
  spinner?.cancel()
  spinner = null
  await update($, LIVE, () => null)
}

/** What a key of the pane runs: one at a time, and a failure says so in the pane. */
function act ($: Engine, work: () => Promise<unknown>) {
  void exclusive(work).catch(() => update($, NOTE, () => 'Time Machine could not do that; the files were left as they were.'))
}

/** The note Claude gets about jumps: what differs from the files it left, or nothing. */
async function jumpNote ($: Engine, from: string) {
  const now = await treeOf(runner($), repo!)
  jumped = false
  modelTree = now.tree
  await remember($)
  const files = await changes(runner($), repo!, from, now.tree)
  if (files.length === 0) return null
  const named = files.slice(0, NOTE_FILES).map((file: Change) => `${file.status} ${file.path}`).join(', ')
  const list = files.length > NOTE_FILES ? `${named} and ${files.length - NOTE_FILES} more` : named
  return `Time Machine: since your last turn the user moved the working tree to another state. Files that differ from how you left them: ${list}. Read a file again before editing it.`
}

export const register: Register = (on, options) => {
  keepMs = (Number(options.keepDays) > 0 ? Number(options.keepDays) : 7) * DAY_MS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Time Machine: the states of your files, turn by turn · <n> | undo | redo',
      argumentHint: '[n | undo | redo]'
    })
    sessionId = await $.session.id()
    turn = null
    writing = 0
    const saved = await $.store.get(`session:${sessionId}`) as Saved | undefined
    // A resumed or reloaded session picks up a jump Claude has not heard of yet
    modelTree = typeof saved?.modelTree === 'string' ? saved.modelTree : null
    jumped = saved?.jumped === true
    const found = await locate(runner($), await $.session.cwd())
    // An index of its own per session: two sessions in one repository never share a lock
    repo = found && { ...found, index: `${found.gitDir}/time-machine-${sessionId}.index` }
    if (repo) {
      const name = await $.process.run(['git', 'config', 'user.name'], { cwd: repo.top })
      driver = name.stdout.trim().split(/\s+/)[0] ?? ''
    }
    await loadStates($, saved)
    await update($, DIRTY, () => false)
    await update($, DEPARTED, () => null)
    await update($, NOTE, () => null)
    await update($, PREVIEW, () => null)
    await update($, SELECTED, () => null)
    void exclusive(async () => {
      await pruneStore($)
      if (repo) {
        await prune(runner($), repo, await $.clock.now(), keepMs)
        await pruneIndexes($)
      }
    }).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The session's index goes with it (where `rm` cannot start, it stays: a file of the size of
  // the repository's index)
  on('session.end', async ($, e, next) => {
    if (repo) await $.process.run(['rm', '-f', repo.index]).catch(() => undefined)
    return next(e)
  })

  // One note per batch of jumps, with the next prompt: five jumps that end where Claude left
  // the files say nothing
  on('prompt.submit', async ($, e, next) => {
    // A slash command's prompt never reaches the model as a turn: the note waits for a real one
    if (e.command || !jumped || !repo || modelTree === null) return next(e)
    const from = modelTree
    const note = await exclusive(() => jumpNote($, from))
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A snapshot taken outside a turn (a background agent) ends where the next turn begins
      if (turn?.start) await exclusive(() => finishTurn($)).catch(() => undefined)
      turn = { label: shorten(e.text) || '(continued)', prompt: e.text.trim().slice(0, PROMPT_MAX), start: null }
      if (repo) await liveStart($, turn.label, turn.prompt)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const mutates = repo !== null && mayWrite(e.tool, e as unknown as Record<string, unknown>)
    // Once the turn has its snapshot, a tool never waits behind the chain
    if (mutates && !turn?.start) await exclusive(() => startTurn($))
    // The running row says what Claude is at while the tool runs, and that it thinks after
    await update($, LIVE, live => live ? { ...live, doing: activity(e.tool, e as unknown as Record<string, unknown>) } : live)
    if (mutates) writing++
    let result
    try {
      result = await next(e)
    } finally {
      if (mutates) writing--
    }
    await update($, LIVE, live => live ? { ...live, doing: activity(null) } : live)
    if (mutates && turn?.start && !liveQueued) {
      liveQueued = true
      void exclusive(() => liveRefresh($)).catch(() => undefined)
    }
    return result
  }).catch(async ($, e, next) => {
    // A snapshot that fails never blocks the tool: the turn just has no way back
    await $.ui.toast('Time Machine could not snapshot this turn; it runs without a way back.')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await exclusive(() => finishTurn($)).catch(async error => {
        await $.ui.toast(`Time Machine could not close the turn: ${(error as Error).message}`)
      })
      await liveEnd($)
    }
    return result
  })

  on('command.run', { command: COMMAND }, ($, e) => timeline($, e.args))
    .catch(() => ({ text: 'Time Machine could not do that; the files were left as they were.' }))

  // The pane's selection follows its focus ring: the arrows, Tab or a click on a row
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const id = e.element?.startsWith('row-') ? Number(e.element.slice(4)) : null
    if (id !== null && Number.isInteger(id)) {
      await update($, SELECTED, () => id)
      act($, () => preview($, id))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))
}

/** The pane: the states as a timeline, and a footer of fixed height pinned to its bottom. */
async function drawPane ($: Engine, e: RenderOf<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (!repo) return <Text dimColor>Not a git repository: nothing to snapshot.</Text>
  const states = await read($, STATES)
  const cursor = await read($, CURSOR)
  const dirty = await read($, DIRTY)
  const selected = await read($, SELECTED)
  const shown = await read($, PREVIEW)
  const note = await read($, NOTE)
  const live = await read($, LIVE)
  const departed = await read($, DEPARTED)
  const now = await $.clock.now()
  const line = lineOf(states, cursor)
  const rows = [...states].reverse()
  const columns = Math.max(20, e.props.bodyColumns)
  const chosen = states.find(state => state.id === (selected ?? cursor))

  // Docked, the pane has a height of its own: the footer is pinned to its bottom and the list
  // shows the window of rows around the chosen one. Inline, the pane is as tall as its tree
  const pinned = e.props.placement === 'dock'
  const listRows = e.props.scroll.bodyRows - 2 - FOOTER_ROWS - (live ? 2 : 0) - (dirty ? 2 : 0)
  const fits = !pinned || rows.length * 2 <= listRows
  const room = fits ? rows.length : Math.max(1, Math.floor((listRows - 2) / 2))
  const focus = Math.max(0, rows.findIndex(state => state.id === chosen?.id))
  const first = fits ? 0 : Math.min(Math.max(0, focus - Math.floor(room / 2)), rows.length - room)
  const visible = rows.slice(first, first + room)

  // One line of the timeline: the rail on the left (a node or its line), the content beside it
  const rail = (key: string, mark: string, content: RenderElement, color?: string) => (
    <Box key={key} flexDirection="row" height={1} overflow="hidden">
      <Box width={3} flexShrink={0}><Text color={color} dimColor={!color}>{mark}</Text></Box>
      <Box flexGrow={1} flexDirection="row" overflow="hidden">{content}</Box>
    </Box>
  )
  // The files of a change, one line however many (see digest)
  const files = (key: string, list: Change[], empty = 'no files') => {
    if (list.length === 0) return <Text key={key} dimColor>{empty}</Text>
    const d = digest(list)
    if (d.kind === 'few') {
      return (
        <Box key={key} flexDirection="row" gap={2}>
          {d.files.map(file => (
            <Box key={`${key}-${file.path}`} flexDirection="row" gap={1}>
              <Text color={ICON_COLOR[file.status] ?? 'warning'}>{ICON[file.status] ?? '~'}</Text>
              <Text dimColor wrap="truncate-start">{file.name}</Text>
              {file.added ? <Text color="success">+{file.added}</Text> : null}
              {file.removed ? <Text color="error">−{file.removed}</Text> : null}
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box key={key} flexDirection="row" gap={1}>
        <Text dimColor>{d.count} files</Text>
        <Text color="success">+{d.added}</Text>
        <Text color="error">−{d.removed}</Text>
        <Text dimColor wrap="truncate-end">· {d.groups.join(' · ')}{d.more ? ` · +${d.more}` : ''}</Text>
      </Box>
    )
  }
  // Where things stand, in the colors of the DeLorean's time circuits: a label, the state,
  // and how long ago it was
  const where = (key: string, label: string, color: string, id: number | null, { instead, when = true }: { instead?: string; when?: boolean } = {}) => {
    const state = states.find(one => one.id === id)
    return (
      <Box key={key} flexDirection="row" gap={1} flexShrink={0}>
        <Text dimColor>{label}</Text>
        <Text bold color={color}>{instead ?? (state ? `#${state.id}` : '—')}</Text>
        {!instead && when && state && <Text dimColor>· {ago(now - state.at)}</Text>}
      </Box>
    )
  }
  // The prompt of the chosen row, cut to the footer's two lines
  const promptOf = (state: State | undefined) => {
    if (!state) return ''
    const text = state.prompt ?? (state.kind === 'start' ? 'The files as they were when the session started.'
      : state.kind === 'outside' ? 'Files changed outside Claude, between two turns.'
        : state.kind === 'saved' ? 'Your own changes, kept before a jump.' : state.label)
    const flat = text.replace(/\s+/g, ' ').trim()
    const max = (columns - 2) * PROMPT_ROWS - 1
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  }

  return (
    <Box flexDirection="column" height={pinned ? e.props.scroll.bodyRows : undefined}>
      <Box key="head" flexDirection="row" justifyContent="space-between" gap={2} height={1} overflow="hidden">
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text bold color="claude">⏪ Time Machine</Text>
          <Text dimColor>· {driver ? `${driver}'s` : 'Your'} DeLorean</Text>
        </Box>
        {note
          ? <Text color="success" wrap="truncate-end">{note}</Text>
          : <Text dimColor>{states.length} state{states.length === 1 ? '' : 's'}</Text>}
      </Box>

      <Box key="list" flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {states.length === 0 && !live && <Text key="empty" dimColor italic>Where we're going, we don't need branches. Each turn that changes files lands here.</Text>}
        {/* The turn under way: as tall as any row, so it never shifts them when it lands */}
        {live && rail('live', SPIN[live.frame % SPIN.length]!, (
          <Box flexGrow={1} flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color="claude" wrap="truncate-end">{live.label}</Text>
            </Box>
            <Text dimColor>{elapsed(now - live.at).padStart(3)}</Text>
          </Box>
        ), 'claude')}
        {live && rail('live-doing', '│', (
          <Box flexDirection="row" gap={1}>
            {/* The scanner: a block sweeping a track of fixed width, so the text never moves */}
            <Box flexDirection="row" flexShrink={0}>
              <Text dimColor>{'▱'.repeat(sweep(live.frame, SWEEP_WIDTH, SWEEP_BLOCK))}</Text>
              <Text color="claude">{'▰'.repeat(SWEEP_BLOCK)}</Text>
              <Text dimColor>{'▱'.repeat(SWEEP_WIDTH - SWEEP_BLOCK - sweep(live.frame, SWEEP_WIDTH, SWEEP_BLOCK))}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">{live.doing}{live.files.length > 0 ? ` · ${digestText(live.files)}` : ''}</Text>
          </Box>
        ))}
        {dirty && rail('dirty', '◌', <Text color="warning" wrap="truncate-end">your changes, not saved yet</Text>, 'warning')}
        {dirty && rail('dirty-since', '│', <Text dimColor wrap="truncate-end">since #{cursor}</Text>)}
        {!fits && rail('newer', ' ', <Text dimColor>{first > 0 ? `↑ ${first} newer` : ' '}</Text>)}
        {visible.map((state, i) => {
          const isHere = state.id === cursor && !dirty
          const isOff = !line.has(state.id)
          const isLast = first + i === rows.length - 1
          const tag = state.kind === 'saved' ? 'kept' : state.kind === 'outside' ? 'by hand' : ''
          return (
            <Box key={`state-${state.id}`} flexDirection="column">
              {rail(`head-${state.id}`, isHere ? '◉' : isOff ? '○' : '●', (
                <Box flexGrow={1} flexDirection="row" justifyContent="space-between" gap={2}>
                  {/* The title clips first; the tag and the time keep their width */}
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Button key={`row-${state.id}`} label={`#${state.id}  ${state.label}`} plain dimColor={isOff}
                      autoFocus={isHere ? true : undefined} onPress={() => act($, () => goTo($, state.id))} />
                  </Box>
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    {tag && <Text color="warning">{tag}</Text>}
                    <Text dimColor>{ago(now - state.at).padStart(3)}</Text>
                  </Box>
                </Box>
              ), isHere ? 'claude' : isOff ? undefined : 'text')}
              {rail(`files-${state.id}`, isLast ? ' ' : '│', files(`f-${state.id}`, state.files))}
            </Box>
          )
        })}
        {!fits && rail('older', ' ', <Text dimColor>{first + room < rows.length ? `↓ ${rows.length - first - room} older` : ' '}</Text>)}
      </Box>

      {/* The footer: pinned to the bottom when docked, each part one fixed height, so moving
          between rows only changes what is written in it */}
      {states.length > 0 && (
        <Box key="footer" flexDirection="column" flexShrink={0}>
          <Text dimColor>{'─'.repeat(columns)}</Text>
          <Box key="where" flexDirection="row" gap={3} height={1} overflow="hidden">
            {where('selected', 'selected', 'error', selected ?? cursor)}
            {where('current', 'current', 'success', dirty ? null : cursor, { instead: dirty ? 'unsaved' : undefined })}
            {where('from', 'jumped from', 'warning', departed, { when: false })}
          </Box>
          <Box key="prompt" flexDirection="row" height={PROMPT_ROWS} overflow="hidden">
            <Box width={2} flexShrink={0}><Text color="claude">›</Text></Box>
            <Text italic={!chosen?.prompt} dimColor={!chosen?.prompt} wrap="wrap">{promptOf(chosen)}</Text>
          </Box>
          <Box key="detail" flexDirection="row" gap={1} height={1} overflow="hidden">
            {!chosen || (chosen.id === cursor && !dirty)
              ? <Text dimColor wrap="truncate-end">◉ you are here</Text>
              : shown?.id !== chosen.id
                ? <Text dimColor wrap="truncate-end">⏎ reading…</Text>
                : shown.files.length === 0
                  ? <Text color="suggestion" wrap="truncate-end">⏎ nothing would change</Text>
                  : (
                    <Box flexDirection="row" gap={1}>
                      <Text color="suggestion">⏎ go here:</Text>
                      {files(`p-${chosen.id}`, shown.files)}
                    </Box>
                    )}
          </Box>
          <Box key="keys" flexDirection="row" gap={2} height={1} overflow="hidden">
            <Text dimColor>↑↓ choose · ⏎ go</Text>
            <Button key="undo" label="undo" hotkey="u" plain dimColor onPress={() => act($, () => undo($))} />
            <Button key="redo" label="redo" hotkey="r" plain dimColor onPress={() => act($, () => redo($))} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
