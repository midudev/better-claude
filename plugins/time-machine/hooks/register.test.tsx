// Mod tests, run against the engine itself: `claude plugin test .`
// git is a fake here, a working tree reduced to the id of its tree; src/git.js has its own
// tests against a real git (test/git.test.js).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Run = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout = ''): { value: Run } => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string): { value: Run } => ({ value: { exitCode: 128, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

/** What sits beneath the mod: a session, a store, the panes and a git whose tree a tool moves. */
function world (on: On, { inRepo = true } = {}) {
  const clock = mock.clock(on, { now: 1_000 })
  const store: Record<string, unknown> = {}
  const git: string[][] = []
  // Everything else the mod runs (cp, rm), and the index each git call used
  const other: string[][] = []
  const indexes = new Set<string>()
  const toasts: string[] = []
  // The working tree is the id of its tree; a tool call that "edits" moves it. `broken` makes
  // git fail, `ignored` are ignored files on disk a jump would write over, and `gate` holds a
  // tool call open until the test lets it go
  const disk = {
    tree: 'T0', edits: 0, commits: 0, user: 'Doc Brown', broken: false, ignored: [] as string[],
    diff: [['M', 'src/a.ts', 3, 1]] as [string, string, number, number][],
    gate: null as Promise<void> | null,
    // What .git holds besides the repository's own files: our indexes, by name and age
    gitFiles: [] as { name: string; mtimeMs: number }[]
  }

  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: 'no plugin answered' }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('fs.list', () => ({ value: disk.gitFiles.map(file => ({ ...file, kind: 'file' as const, size: 1, isLink: false })) }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', async ($, e) => {
    if (disk.gate) await disk.gate
    const looks = e.tool === 'Read' || e.tool.includes('__get_') || ('command' in e && typeof e.command === 'string' && e.command.startsWith('ls'))
    if (!looks) disk.tree = `E${++disk.edits}`
    return { result: {} as never, text: 'done' }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'git') {
      other.push(argv)
      return fail('not git')
    }
    const [, verb, ...rest] = argv
    git.push(argv.slice(1))
    if (e.init?.env?.GIT_INDEX_FILE) indexes.add(e.init.env.GIT_INDEX_FILE)
    if (!inRepo) return fail('fatal: not a git repository')
    if (disk.broken && verb !== 'rev-parse' && verb !== 'config') return fail('fatal: unable to write new index file')
    // check-ignore answers 1 when nothing is ignored
    if (verb === 'check-ignore') return disk.ignored.length ? ok(disk.ignored.map(path => `${path}\0`).join('')) : { value: { ...ok().value, exitCode: 1 } }
    if (verb === 'ls-files' && rest.includes('--others')) return ok(disk.ignored.map(path => `${path}\0`).join(''))
    if (verb === 'rev-parse') return ok(rest.includes('--show-toplevel') ? '/repo\n' : rest.includes('--absolute-git-dir') ? '/repo/.git\n' : 'h1\n')
    if (verb === 'config') return ok(`${disk.user}\n`)
    if (verb === 'write-tree') return ok(`${disk.tree}\n`)
    if (verb === 'commit-tree') return ok(`c${++disk.commits}\n`)
    if (verb === 'diff' && rest.includes('--name-only')) {
      return ok(disk.diff.filter(([status]) => status === 'A').map(([, path]) => `${path}\0`).join(''))
    }
    if (verb === 'diff') {
      return ok(rest.includes('--numstat')
        ? disk.diff.map(([, path, add, del]) => `${add}\t${del}\t${path}\0`).join('')
        : disk.diff.map(([status, path]) => `${status}\0${path}\0`).join(''))
    }
    // A jump: the files move to the second tree of read-tree's two
    if (verb === 'read-tree' && rest.includes('-u')) disk.tree = rest[rest.length - 1]!
    return ok()
  })
  return { store, git, other, indexes, toasts, disk, clock }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
let turns = 0
/** A whole turn: its prompt, the tools it calls, its end. */
async function turnOf ($: Engine, text: string, tools: ('Edit' | 'Read' | 'Bash' | 'ls')[] = ['Edit']) {
  const turnId = `t${++turns}`
  await $.turn.start({ text, turnId })
  for (const tool of tools) {
    if (tool === 'Edit') await $.tool.call({ tool, tool_use_id: 'u1', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
    if (tool === 'Read') await $.tool.call({ tool, tool_use_id: 'u1', file_path: '/repo/src/a.ts' })
    if (tool === 'Bash') await $.tool.call({ tool, tool_use_id: 'u1', command: 'sed -i s/a/b/ src/a.ts' })
    if (tool === 'ls') await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls -la && git status' })
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}
const timeline = ($: Engine, args = '') => $.command.run({
  command: 'timeline',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 }
})
const prompt = ($: Engine, text = 'go on') => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
/** A slash command as the engine submits it: its own prompt.submit, marked with `command`. */
const slash = ($: Engine, name: string, args = '') => $.prompt.submit({ text: `/${name} ${args}`.trim(), origin: { kind: 'composer' }, wait: false, command: { name, args } })
const focus = ($: Engine, element: string) => $.ui.focus({ component: 'Pane', requestId: 'time-machine', plugin: 'time-machine', element, origin: { kind: 'person' } })
/** Holds the next tool calls open until the returned function is called. */
function hold (w: ReturnType<typeof world>) {
  let release = () => {}
  w.disk.gate = new Promise(resolve => { release = resolve })
  return () => { w.disk.gate = null; release() }
}
type Saved = { states: { id: number; kind: string; label: string; tree: string; parent: number | null }[]; cursor: number | null }
const saved = (store: Record<string, unknown>): Saved => (store['session:s1'] as Saved | undefined) ?? { states: [], cursor: null }
const PANE = { title: 'Time Machine', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const pane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', requestId: 'time-machine', props: PANE })

test('the first turn that changes files adds the start of the session and its end', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'fix the login form', ['Edit', 'Edit'])

  const { states, cursor } = saved(w.store)
  expect(states.map(s => [s.id, s.kind, s.label, s.tree, s.parent])).toEqual([
    [1, 'start', 'start of the session', 'T0', null],
    [2, 'turn', 'fix the login form', 'E2', 1]
  ])
  expect(cursor).toBe(2)
  // Each state is kept by a ref of the session; one snapshot before the turn, however many edits
  expect(w.git.filter(argv => argv[0] === 'update-ref').map(argv => argv[1])).toEqual(['refs/time-machine/s1/1', 'refs/time-machine/s1/2'])

  const listed = await timeline($)
  expect(listed.text).toMatch(/◉ #2 +fix the login form +~ src\/a\.ts/)
  expect(listed.text).toMatch(/● #1 +start of the session/)
})

test('a turn that only reads or only looks takes no snapshot; one that changes nothing keeps no state', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'look around', ['Read', 'ls'])
  expect(w.git.some(argv => argv[0] === 'commit-tree')).toBe(false)

  await $.turn.start({ text: 'run the tests', turnId: 'x' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'npm test' })
  w.disk.tree = 'T0'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })
  expect(saved(w.store).states).toEqual([])
  expect(w.git.some(argv => argv[0] === 'commit-tree' || argv[0] === 'update-ref')).toBe(false)
})

test('Bash that changes files counts like an Edit', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'rename with sed', ['Bash'])
  expect(saved(w.store).states.map(s => s.label)).toEqual(['start of the session', 'rename with sed'])
})

test('going to a state moves the cursor and the files, and adds no row', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  expect(saved(w.store).states.map(s => s.id)).toEqual([1, 2, 3])

  expect((await timeline($, '1')).text).toContain('⚡ 88 mph · At #1 · start of the session')
  expect(w.disk.tree).toBe('T0')
  expect((await timeline($, '3')).text).toContain('At #3 · second')
  expect(w.disk.tree).toBe('E2')
  expect(saved(w.store).cursor).toBe(3)
  expect(saved(w.store).states.length).toBe(3)
  expect((await timeline($, '3')).text).toContain('already at #3')
})

test('undo goes to the parent and redo comes back, even after a branch', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')

  await timeline($, 'undo')
  expect(saved(w.store).cursor).toBe(2)
  await timeline($, 'undo')
  expect(saved(w.store).cursor).toBe(1)
  expect((await timeline($, 'undo')).text).toContain('Great Scott! #1 is as far back as it goes.')
  await timeline($, 'redo')
  expect(saved(w.store).cursor).toBe(2)

  // A new turn from #2 branches off: its parent is #2, not the #3 it follows in time
  await turnOf($, 'another way')
  expect(saved(w.store).states.at(-1)).toMatchObject({ id: 4, parent: 2 })
  await timeline($, 'undo')
  expect(saved(w.store).cursor).toBe(2)
  // Redo takes the newest branch
  await timeline($, 'redo')
  expect(saved(w.store).cursor).toBe(4)
  expect(w.disk.tree).toBe('E3')
})

test('changes made by hand are kept as a state before a jump, never lost', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  w.disk.tree = 'MINE'

  expect((await timeline($)).text).toContain('◌ your changes, not saved yet')
  expect((await timeline($, '1')).text).toContain('kept as #3.')
  expect(saved(w.store).states.at(-1)).toMatchObject({ id: 3, kind: 'saved', tree: 'MINE', parent: 2 })
  await timeline($, '3')
  expect(w.disk.tree).toBe('MINE')
})

test('changes made by hand between turns become a state of their own', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  w.disk.tree = 'BYHAND'
  await turnOf($, 'second')
  expect(saved(w.store).states.map(s => [s.id, s.kind, s.parent])).toEqual([[1, 'start', null], [2, 'turn', 1], [3, 'outside', 2], [4, 'turn', 3]])
})

test('Claude hears once, with the next prompt, what differs from the files it left', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')

  // Five jumps that end where Claude left the files: nothing to say
  for (const id of ['1', '2', '1', '2', '3']) await timeline($, id)
  expect((await prompt($)).context ?? []).toEqual([])

  await timeline($, '1')
  await timeline($, '2')
  const first = await prompt($)
  expect(first.context?.length).toBe(1)
  expect(first.context?.[0]).toContain('M src/a.ts')
  expect((await prompt($, 'and now?')).context ?? []).toEqual([])
  expect(w.disk.tree).toBe('E1')
})

test('/timeline with an unknown number or text says how to use it', async ($, on) => {
  world(on)
  await startSession($)
  expect((await timeline($, '9')).text).toContain('there is no #9')
  expect((await timeline($, 'yesterday')).text).toContain('/timeline <n> | undo | redo')
  expect((await timeline($, 'redo')).text).toContain('nothing to redo')
})

test('outside a git repository it snapshots nothing and says so', async ($, on) => {
  const w = world(on, { inRepo: false })
  await startSession($)
  await turnOf($, 'edit')
  expect(w.git.every(argv => argv[0] === 'rev-parse')).toBe(true)
  expect((await timeline($)).text).toContain('not a git repository')
})

test('a resumed session finds its states and its cursor', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'keep me')
  await timeline($, '1')
  await startSession($)
  expect((await timeline($)).text).toMatch(/◉ #1 +start of the session/)
  expect(saved(w.store).states.length).toBe(2)
})

test('the pane marks where the files are and what is undone, on every surface', async ($, on) => {
  world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  await timeline($, '2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane($, surface)
    // #3 was undone: drawn dimmed; #2 is where the files are
    expect((await ui.find({ key: 'row-3' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'row-2' }))?.props.dimColor).toBe(false)
    expect(await ui.find({ type: 'Text', text: /you are here/ })).toBeDefined()
  }
})

test('in the pane, choosing a row shows what would change, Enter goes there, u and r undo and redo', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  const ui = await pane($)
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'time-machine', plugin: 'time-machine', element, origin: { kind: 'person' } })

  // The preview has its own line, there before any row is chosen: moving never shifts the rows
  expect(await ui.find({ type: 'Text', text: /you are here/ })).toBeDefined()
  await focus('row-1')
  expect(await ui.find({ type: 'Text', text: /go here:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'a.ts' })).toBeDefined()
  await focus('row-2')
  expect(await ui.find({ type: 'Text', text: /go here|nothing would change/ })).toBeUndefined()

  await ui.press({ key: 'row-1' })
  expect(w.disk.tree).toBe('T0')
  await ui.press({ key: 'redo' })
  expect(w.disk.tree).toBe('E1')
  await ui.press({ key: 'undo' })
  expect(w.disk.tree).toBe('T0')
  expect(await ui.find({ type: 'Text', text: /At #1/ })).toBeDefined()
})

test('a reload that raced the end of a turn cannot leave two states with one id', async ($, on) => {
  const w = world(on)
  // What the race left behind: two #2, the later one a child of the first
  w.store['session:s1'] = {
    at: 1,
    cursor: 2,
    states: [
      { id: 1, kind: 'start', label: 'start of the session', at: 1, commit: 'c1', tree: 'T0', parent: null, files: [] },
      { id: 2, kind: 'turn', label: 'first', at: 2, commit: 'c2', tree: 'E1', parent: 1, files: [] },
      { id: 2, kind: 'turn', label: 'second', at: 3, commit: 'c3', tree: 'E2', parent: 2, files: [] }
    ]
  }
  await startSession($)
  expect(saved(w.store).states.map(s => [s.id, s.label, s.parent])).toEqual([[1, 'start of the session', null], [2, 'first', 1], [3, 'second', 2]])
  expect(w.git).toContainEqual(['update-ref', 'refs/time-machine/s1/3', 'c3'])
  expect(w.git).toContainEqual(['update-ref', 'refs/time-machine/s1/2', 'c2'])

  // And the next state takes a free id, whatever the module counted before the reload
  w.disk.tree = 'E2'
  await timeline($, '3')
  await turnOf($, 'third')
  expect(saved(w.store).states.at(-1)).toMatchObject({ id: 4, parent: 3 })
})

test('a hot reload keeps the states a turn saved after the store was read', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  // The store is behind the live states (the old module was still writing): the live ones win
  w.store['session:s1'] = { at: 1, cursor: null, states: [] }
  await startSession($)
  expect(saved(w.store).states.map(s => s.id)).toEqual([1, 2])
  await turnOf($, 'second')
  expect(saved(w.store).states.map(s => s.id)).toEqual([1, 2, 3])
})

test('a running turn shows at once at the top, fills in its files, and lands as a state', async ($, on) => {
  const w = world(on)
  await startSession($)
  await timeline($)
  await $.turn.start({ text: 'refactor the auth module', turnId: 'live' })
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'refactor the auth module' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'thinking…' })).toBeDefined()

  w.disk.diff = Array.from({ length: 5 }, (_, i) => ['M', `src/auth/f${i}.ts`, 2, 1])
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/src/auth/f0.ts', old_string: 'a', new_string: 'b' })
  await timeline($, '99')   // waits for the refresh queued behind the edit
  // Back to thinking after the edit, with the files so far behind it, and the scanner moving
  expect(await ui.find({ type: 'Text', text: /^thinking… · 5 files \+10 −5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▰▰▰' })).toBeDefined()

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'live', reason: 'answer' })
  // The spinner is gone; the prompt now shows in the footer, as the landed state's
  expect(await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeUndefined()
  expect(saved(w.store).states.at(-1)).toMatchObject({ label: 'refactor the auth module', kind: 'turn', prompt: 'refactor the auth module' })
})

test('the footer says which row is selected, where the files are and where they jumped from', async ($, on) => {
  world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  await timeline($, '1')
  const ui = await pane($)
  for (const [label, value] of [['selected', '#1'], ['current', '#1'], ['jumped from', '#3']]) {
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: value })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: "Where we're going, we don't need branches." })).toBeUndefined()   // the jump's note is up
  // git's user.name is Doc Brown here
  expect(await ui.find({ type: 'Text', text: "· Doc's DeLorean" })).toBeDefined()
})

test('the DeLorean is whoever git says is at the wheel', async ($, on) => {
  const w = world(on)
  w.disk.user = 'Marty McFly'
  await startSession($)
  await turnOf($, 'first')
  w.disk.tree = 'MINE'
  expect((await timeline($, '1')).text).toContain('Your changes are safe, Marty: kept as #3.')
  expect(await (await pane($)).find({ type: 'Text', text: "· Marty's DeLorean" })).toBeDefined()
})

test('when git knows no name, the DeLorean is yours', async ($, on) => {
  const w = world(on)
  w.disk.user = ''
  await startSession($)
  await turnOf($, 'first')
  w.disk.tree = 'MINE'
  expect((await timeline($, '1')).text).toContain('Your changes are safe: kept as #3.')
  expect(await (await pane($)).find({ type: 'Text', text: '· Your DeLorean' })).toBeDefined()
})

test('the footer shows the whole prompt of the chosen row, cut to its two lines', async ($, on) => {
  world(on)
  await startSession($)
  const long = 'como mejora estaria muy guay que en cuanto mandas un mensaje aparezca en la timeline y se vayan actualizando las lineas escritas o que aparezca una especie de loader'
  await turnOf($, long)
  await turnOf($, 'second')
  const ui = await pane($)
  await $.ui.focus({ component: 'Pane', requestId: 'time-machine', plugin: 'time-machine', element: 'row-2', origin: { kind: 'person' } })
  // 80 columns: two lines of 78, the rest cut
  const prompt = (await ui.find({ type: 'Text', text: /^como mejora/ }))?.text ?? ''
  expect(prompt.length).toBe(155)
  expect(prompt.endsWith('…')).toBe(true)
  await $.ui.focus({ component: 'Pane', requestId: 'time-machine', plugin: 'time-machine', element: 'row-1', origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: 'The files as they were when the session started.' })).toBeDefined()
})

test('docked and short, the list is a window around the chosen row and the footer stays', async ($, on) => {
  world(on)
  await startSession($)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await turnOf($, `turn ${n}`)
  const ui = await $.ui.mount({ plugin: 'time-machine', surface: 'terminal', component: 'Pane', requestId: 'time-machine',
    props: { ...PANE, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 } } })
  // 20 rows: 2 of header, 6 of footer, 2 of more-lines: 5 states of 2 lines
  expect(await ui.find({ key: 'row-9' })).toBeDefined()
  expect(await ui.find({ key: 'row-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '↓ 4 older' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'selected' })).toBeDefined()

  await $.ui.focus({ component: 'Pane', requestId: 'time-machine', plugin: 'time-machine', element: 'row-6', origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: '↑ 1 newer' })).toBeDefined()
  expect(await ui.find({ key: 'row-4' })).toBeDefined()
})

// What the code review found the first tests let through

test('a slash command does not spend the note about a jump; the next real prompt gets it', async ($, on) => {
  world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  await timeline($, '1')
  expect((await slash($, 'timeline', '1')).context ?? []).toEqual([])
  expect((await prompt($)).context?.[0]).toContain('M src/a.ts')
})

test('after a resume, and after a turn that only read, the note compares with the files Claude last saw', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  // A new process: the module starts over, the states come from the store
  await startSession($)
  await timeline($, '1')
  expect((await prompt($)).context?.length).toBe(1)

  // Claude reads the files the person changed by hand; a jump back to #2 moves them off that
  await timeline($, '2')
  w.disk.tree = 'BYHAND'
  await turnOf($, 'just look', ['Read'])
  await timeline($, '2')
  expect((await prompt($)).context?.length).toBe(1)
})

test('no jump while a turn runs, even before it changed anything', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await $.turn.start({ text: 'reading for now', turnId: 'running' })
  expect((await timeline($, '1')).text).toContain('a turn is running')
  expect(w.disk.tree).toBe('E1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'running', reason: 'answer' })
  expect((await timeline($, '1')).text).toContain('At #1')
})

test('a jump that would write over an ignored file refuses, and says which', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  w.disk.diff = [['A', 'config.local.json', 1, 0]]
  w.disk.ignored = ['config.local.json']
  const answer = await timeline($, '1')
  expect(answer.text).toContain('config.local.json')
  expect(w.disk.tree).toBe('E1')
})

test('when git fails, the tool still runs and a toast says the turn has no way back', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.disk.broken = true
  await turnOf($, 'edit anyway')
  expect(w.disk.tree).toBe('E1')
  expect(w.toasts.some(text => text.includes('could not snapshot'))).toBe(true)
  expect(saved(w.store).states).toEqual([])
})

test('an aborted turn still lands its state', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'interrupted', turnId: 'x' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'x', reason: 'aborted' })
  expect(saved(w.store).states.at(-1)).toMatchObject({ label: 'interrupted', kind: 'turn' })
})

test('a subagent\'s tools count for the turn that spawned it, and its own start does not replace it', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'delegate the refactor', turnId: 'main' })
  await $.turn.start({ text: 'the agent\'s prompt', turnId: 'agent', agentId: 'a1' })
  // The engine stamps the agent's id on its calls; a test cannot, and the mod does not look
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'agent', reason: 'answer', agentId: 'a1' })
  expect(saved(w.store).states).toEqual([])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
  expect(saved(w.store).states.at(-1)).toMatchObject({ label: 'delegate the refactor' })
})

test('while a tool runs, the running row says what Claude is at', async ($, on) => {
  const w = world(on)
  await startSession($)
  await timeline($)
  await $.turn.start({ text: 'fix it', turnId: 'x' })
  const ui = await pane($)
  const release = hold(w)
  const running = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'npm test' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /^running npm test/ })).toBeDefined()
  release()
  await running
  expect(await ui.find({ type: 'Text', text: /^thinking…/ })).toBeDefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })
})

test('the spinner turns while the turn runs, pane opened before or not, and stops when it ends', async ($, on) => {
  const w = world(on)
  await startSession($)
  // No /timeline in this module's life: the pane was opened before a hot reload
  await $.turn.start({ text: 'fix it', turnId: 'x' })
  const ui = await pane($)
  const scanner = async () => (await ui.find({ type: 'Text', text: /^▱*$/ }))?.text ?? null
  const at = await scanner()
  await w.clock.advance(120)
  expect(await scanner()).not.toBe(at)
  await w.clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: ' 5s' })).toBeDefined()

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })
  expect(await scanner()).toBe(null)
})

test('the note of a jump leaves the header after six seconds', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await timeline($, '1')
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /88 mph/ })).toBeDefined()
  await w.clock.advance(6000)
  expect(await ui.find({ type: 'Text', text: /88 mph/ })).toBeUndefined()
})

test('after undo, the footer previews the chosen row again instead of staying on reading…', async ($, on) => {
  world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  const ui = await pane($)
  await focus($, 'row-3')
  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Text', text: /reading/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /go here:/ })).toBeDefined()
})

test('redo brings back the hand edits that undo put away', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  w.disk.tree = 'MINE'
  await timeline($, 'undo')
  expect(w.disk.tree).toBe('E1')
  await timeline($, 'redo')
  expect(w.disk.tree).toBe('MINE')
})

test('moving fast across rows reads the tree for the row it stops on, not for every row it crosses', async ($, on) => {
  const w = world(on)
  await startSession($)
  for (const n of [1, 2, 3, 4]) await turnOf($, `turn ${n}`)
  await pane($)
  const before = w.git.filter(argv => argv[0] === 'write-tree').length
  await Promise.all(['row-1', 'row-2', 'row-3', 'row-4'].map(row => focus($, row)))
  await timeline($, '99')   // waits for the chain
  // The first row is read at once; by the time its read is done the person is on row 4, so
  // rows 2 and 3 are never read: two reads, not four
  expect(w.git.filter(argv => argv[0] === 'write-tree').length - before).toBe(2)
})

test('inline, the pane shows every state: only a docked pane keeps a window', async ($, on) => {
  world(on)
  await startSession($)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await turnOf($, `turn ${n}`)
  const ui = await $.ui.mount({ plugin: 'time-machine', surface: 'terminal', component: 'Pane', requestId: 'time-machine',
    props: { ...PANE, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 20 } } })
  expect(await ui.find({ key: 'row-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /older/ })).toBeUndefined()
})

test('each session has an index of its own, removed when the session ends', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  expect([...w.indexes]).toEqual(['/repo/.git/time-machine-s1.index'])
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  expect(w.other).toContainEqual(['rm', '-f', '/repo/.git/time-machine-s1.index'])
})

test('old sessions leave the store with their snapshots; a state whose commit is gone is dropped', async ($, on) => {
  const w = world(on)
  const day = 24 * 60 * 60 * 1000
  w.store['session:old'] = { at: 1_000 - 8 * day, states: [], cursor: null }
  w.store['session:recent'] = { at: 1_000 - day, states: [], cursor: null }
  w.store['session:s1'] = {
    at: 1_000,
    cursor: 2,
    states: [
      { id: 1, kind: 'start', label: 'start of the session', at: 1_000 - 9 * day, commit: 'gone', tree: 'T0', parent: null, files: [] },
      { id: 2, kind: 'turn', label: 'fresh', at: 1_000, commit: 'c9', tree: 'E1', parent: 1, files: [] }
    ]
  }
  await startSession($)
  await timeline($, '99')   // waits for the chain
  expect(Object.keys(w.store).sort()).toEqual(['session:recent', 'session:s1'])
  expect(saved(w.store).states.map(s => [s.id, s.parent])).toEqual([[2, null]])
})

test('an MCP tool that writes files gets the turn its snapshot; one that only reads does not', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'look it up', turnId: 'read' })
  await $.tool.call({ tool: 'mcp__github__get_issue', tool_use_id: 'u1', number: 1 } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'read', reason: 'answer' })
  expect(saved(w.store).states).toEqual([])

  await $.turn.start({ text: 'write it down', turnId: 'write' })
  await $.tool.call({ tool: 'mcp__filesystem__write_file', tool_use_id: 'u2', path: '/repo/notes.md', content: 'x' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'write', reason: 'answer' })
  expect(saved(w.store).states.at(-1)).toMatchObject({ label: 'write it down' })
})

test('undo and redo read the tree once each', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  const reads = () => w.git.filter(argv => argv[0] === 'write-tree').length
  for (const step of ['undo', 'redo']) {
    const before = reads()
    await timeline($, step)
    expect([step, reads() - before]).toEqual([step, 1])
  }
})

test('the note about a jump names fifty files at most', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  w.disk.diff = Array.from({ length: 60 }, (_, i) => ['M', `src/f${i}.ts`, 1, 1])
  await timeline($, '1')
  const note = (await prompt($)).context?.[0] ?? ''
  expect(note).toContain('M src/f49.ts and 10 more')
  expect(note).not.toContain('src/f50.ts')
})

test('the indexes of sessions that crashed go; this session\'s own and the recent ones stay', async ($, on) => {
  const w = world(on)
  const day = 24 * 60 * 60 * 1000
  w.disk.gitFiles = [
    { name: 'time-machine-s1.index', mtimeMs: 1_000 - 30 * day },         // this session's
    { name: 'time-machine-crashed.index', mtimeMs: 1_000 - 8 * day },     // ended without saying
    { name: 'time-machine-other.index', mtimeMs: 1_000 - day },           // another session, maybe running
    { name: 'time-machine.index', mtimeMs: 1_000 },                       // the one shared index of before
    { name: 'index', mtimeMs: 0 }                                         // the repository's own
  ]
  await startSession($)
  await timeline($, '99')   // waits for the chain
  expect(w.other.filter(argv => argv[0] === 'rm').map(argv => argv[2]).sort()).toEqual([
    '/repo/.git/time-machine-crashed.index', '/repo/.git/time-machine.index'
  ])
})

// What Codex's review of the PR found

test('no jump while a background agent\'s tool is still writing files', async ($, on) => {
  const w = world(on)
  await startSession($)
  await turnOf($, 'first')
  // The main turn is over; an agent left running calls a tool that takes a while
  const release = hold(w)
  const writing = $.tool.call({ tool: 'Bash', tool_use_id: 'bg', command: 'npm run build' })
  await w.clock.settle()
  expect((await timeline($, '1')).text).toContain('a tool is still changing files')
  release()
  await writing
  expect((await timeline($, '1')).text).toContain('At #1')
})

test('a jump made before a restart still reaches Claude with the next prompt', async ($, on) => {
  world(on)
  await startSession($)
  await turnOf($, 'first')
  await turnOf($, 'second')
  await timeline($, '1')
  // Exit and resume (or a hot reload): the module starts over, the session's record stays
  await startSession($)
  const note = (await prompt($)).context?.[0] ?? ''
  expect(note).toContain('M src/a.ts')
  expect((await prompt($, 'and now?')).context ?? []).toEqual([])
})
