// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {}
}
const PANE = {
  title: 'After',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {}
}

type Answer = { isAnswered: true; text: string } | { isAnswered: false; reason: 'empty-reply' }

/**
 * Everything beneath the mod, answered from memory: the session, the clock, the store, the
 * turn and command bottoms, the prompts handed to Claude, the transcript lines and the model.
 */
function world (on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  const store: Record<string, unknown> = {}
  const prompts: { text: string; origin: unknown }[] = []
  const logs: string[] = []
  const commands: string[] = []
  const listed: { name: string; description: string; source: 'user' | 'plugin'; isFullscreen: boolean }[] = []
  const panes: unknown[] = []
  const model: { answer: Answer; calls: number } = { answer: { isAnswered: false, reason: 'empty-reply' }, calls: 0 }

  const session = { id: 's1' }
  on('session.id', () => ({ value: session.id }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.run', () => ({ text: 'no plugin answered' }))
  on('command.list', () => ({ value: listed }))
  on('prompt.submit', ($, e) => {
    prompts.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    panes.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.focus', { plugin: '*' }, () => ({}))
  // What the engine draws where the mod draws nothing
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('model.complete', () => {
    model.calls++
    return { value: { ...model.answer, usage: USAGE } }
  })

  type Stored = { items?: { id: number; text: string }[]; running?: unknown; done?: { text: string; status?: string }[] }
  const saved = () => store[`queue:${session.id}`] as Stored | undefined
  const queued = () => (saved()?.items ?? []).map(item => item.text)
  const ids = () => (saved()?.items ?? []).map(item => item.id)
  return { clock, store, session, prompts, logs, commands, listed, panes, model, saved, queued, ids }
}

const after = ($: Engine, args: string, command = 'after') => $.command.run({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 }
})
const turnStart = ($: Engine) => $.turn.start({ text: 'work', turnId: 't1' })
const turnEnd = ($: Engine, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

/** Draws what a command answered, as the transcript does under its echo. */
const mountCard = ($: Engine, text: string | undefined, command = 'after') => $.ui.mount({
  plugin: 'after',
  surface: 'terminal',
  component: 'CommandOutput',
  props: { command, args: '', text: `after: ${text}`, isErrored: false }
})

test('registers /after and /before when the session starts', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.commands).toEqual(['after', 'before'])
})

test('warns when command files left by After 0.1 would shadow the mod', async ($, on) => {
  const w = world(on)
  w.listed.push({ name: 'after', description: 'old shim', source: 'user', isFullscreen: false })
  await startSession($)
  expect(w.logs).toEqual([expect.stringMatching(/delete after\.md from ~\/\.claude\/commands/)])
})

test('a resumed session finds its queue, with nothing running', async ($, on) => {
  const w = world(on)
  w.store['queue:s1'] = {
    sessionId: 's1',
    items: [{ id: 2, text: 'update the README', createdAt: 0 }],
    running: { id: 1, text: 'add tests', createdAt: 0, startedAt: 0 },
    busy: true,
    nextId: 3
  }
  await startSession($)
  expect(w.queued()).toEqual(['update the README'])
  expect(w.saved()?.running).toBeNull()
  expect(w.saved()?.done?.[0]).toMatchObject({ text: 'add tests', status: 'stopped' })
})

test('/clear keeps the queue for the new conversation', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'write the docs')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  w.session.id = 's2'
  await after($, 'bump the version')
  expect(w.queued()).toEqual(['write the docs', 'bump the version'])
  expect(w.store['queue:s1']).toBeUndefined()
})

test('queues while Claude works and starts the task when the turn ends', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'write the docs')
  await after($, 'bump the version')
  expect(w.prompts).toHaveLength(0)
  expect(w.queued()).toEqual(['write the docs', 'bump the version'])

  await turnEnd($)
  await w.clock.settle()
  expect(w.prompts.map(prompt => prompt.text)).toEqual(['write the docs'])
  expect(w.prompts[0]?.origin).toMatchObject({ kind: 'plugin', name: 'after', asUser: true })
  expect(w.queued()).toEqual(['bump the version'])
})

test('/before goes to the front, and answers with a card the model never reads', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'second')
  const answer = await after($, 'first', 'before')
  expect(w.queued()).toEqual(['first', 'second'])
  // The transcript keeps (and the model reads) only a reference to the card
  expect(answer.text).toMatch(/^#[0-9a-z]+-[0-9a-z]+$/)
  const card = await mountCard($, answer.text, 'before')
  expect(await card.find({ type: 'Text', text: / Queued #1 · next up/ })).toBeDefined()
  expect(await card.find({ type: 'Text', text: /first/ })).toBeDefined()
  expect(await card.find({ type: 'Text', text: ' After ' })).toBeDefined()
  await card.unmount()
})

test('a resumed session draws its cards from the store', async ($, on) => {
  const w = world(on)
  w.store['card:zz-1'] = { tone: 'ok', icon: '✓', title: 'Queued #2', rows: [] }
  const card = await mountCard($, '#zz-1')
  expect(await card.find({ type: 'Text', text: ' Queued #2' })).toBeDefined()
  await card.unmount()
  const other = await $.ui.mount({
    plugin: 'after',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'cost', args: '', text: 'cost: #zz-1', isErrored: false }
  })
  expect(await other.find({ key: 'engine' })).toBeDefined()
  await other.unmount()
})

test('Esc leaves the queue alone until a turn ends normally', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'write the docs')
  await turnEnd($, 'aborted')
  await w.clock.settle()
  expect(w.prompts).toHaveLength(0)
  expect(w.queued()).toEqual(['write the docs'])
})

test('a task queued while Claude is idle starts right away', async ($, on) => {
  const w = world(on)
  await after($, 'reply with exactly OK')
  await w.clock.settle()
  expect(w.prompts.map(prompt => prompt.text)).toEqual(['reply with exactly OK'])
})

test('the card says a task starts at once when Claude is idle', async ($, on) => {
  world(on)
  const answer = await after($, 'reply with exactly OK')
  const card = await mountCard($, answer.text)
  expect(await card.find({ type: 'Text', text: ' Starting now' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: '← starting now' })).toBeDefined()
  await card.unmount()
})

test('a paused queue holds its tasks', async ($, on) => {
  const w = world(on)
  await after($, 'pause')
  await after($, 'write the docs')
  await w.clock.settle()
  expect(w.prompts).toHaveLength(0)
  await after($, 'resume')
  await w.clock.settle()
  expect(w.prompts.map(prompt => prompt.text)).toEqual(['write the docs'])
})

test('plain language asks the model, and only when it may refer to the queue', async ($, on) => {
  const w = world(on)
  w.model.answer = { isAnswered: true, text: '{"ops":[{"op":"remove","target":2}],"note":"the readme task"}' }
  await turnStart($)
  await after($, 'add tests for the parser')
  await after($, 'update the README')
  expect(w.model.calls).toBe(0)
  const answer = await after($, 'quita lo del readme')
  expect(w.model.calls).toBe(1)
  expect(w.queued()).toEqual(['add tests for the parser'])
  const card = await mountCard($, answer.text)
  expect(await card.find({ type: 'Text', text: ' ✦ Haiku ' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: ' Removed 1 task' })).toBeDefined()
  await card.unmount()
})

test('falls back to local matching when the model has no answer', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'add tests for the parser')
  await after($, 'update the README')
  await after($, 'remove adding tests')
  expect(w.model.calls).toBe(1)
  expect(w.queued()).toEqual(['update the README'])
})

test('plain language off never asks the model', { options: { smart: false } }, async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'add tests for the parser')
  await after($, 'remove adding tests')
  expect(w.model.calls).toBe(0)
  expect(w.queued()).toEqual([])
})

test('a turn that ends while the model thinks waits for the command to land', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'add tests for the parser')
  await after($, 'update the README')
  w.model.answer = { isAnswered: true, text: '{"ops":[{"op":"remove","target":1}],"note":"tests"}' }
  const removing = after($, 'remove the tests one')
  await turnEnd($)
  await removing
  await w.clock.settle()
  expect(w.prompts.map(prompt => prompt.text)).toEqual(['update the README'])
})

test('the band shows what comes next on every surface', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'write the docs')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'after', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: ' after ' })).toBeDefined()
    // The spinner above already says Claude is working
    expect(await ui.find({ type: 'Text', text: /working/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'write the docs' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'view' })).toBeDefined()
    await ui.unmount()
  }
  expect(w.queued()).toEqual(['write the docs'])
})

test('the band says what is running, then what comes next, or that the queue is paused', async ($, on) => {
  const w = world(on)
  await turnStart($)
  await after($, 'write the docs')
  await after($, 'bump the version')
  await turnEnd($)
  await w.clock.settle()
  const running = await $.ui.mount({ plugin: 'after', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await running.find({ type: 'Text', text: '▶ write the docs' })).toBeDefined()
  expect(await running.find({ type: 'Text', text: 'then' })).toBeDefined()
  await running.unmount()

  await after($, 'pause')
  const paused = await $.ui.mount({ plugin: 'after', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await paused.find({ type: 'Text', text: 'paused' })).toBeDefined()
  expect(await paused.find({ type: 'Text', text: 'then' })).toBeUndefined()
  await paused.unmount()
})

test('the band stays out of the way with an empty queue', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await $.ui.mount({ plugin: 'after', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: 'After' })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('bare /after opens the queue to edit it, and prints nothing', async ($, on) => {
  const w = world(on)
  const answer = await after($, '')
  expect(w.panes).toEqual([expect.objectContaining({ id: 'after', focus: true, closeOnEscape: true })])
  expect(answer.text).toBeUndefined()
  await after($, 'watch')
  expect(w.panes).toHaveLength(2)
})

test('the pane edits the queue on every surface that takes input', async ($, on) => {
  const w = world(on)
  await turnStart($)
  for (const surface of SURFACES) {
    await after($, 'clear')
    await after($, 'first')
    await after($, 'second')
    const ui = await $.ui.mount({ plugin: 'after', surface, component: 'Pane', requestId: 'after', props: PANE })
    const [first, second] = w.ids()

    // Enter on a task picks it and loads it into the input to rewrite it
    await ui.press({ key: `row-${second}` })
    await ui.input({ key: 'task', text: 'second, rewritten' })
    expect(w.queued()).toEqual(['first', 'second, rewritten'])

    // k and j move the picked task, d removes it
    await ui.press({ key: 'up' })
    expect(w.queued()).toEqual(['second, rewritten', 'first'])
    await ui.press({ key: 'down' })
    expect(w.queued()).toEqual(['first', 'second, rewritten'])

    // The arrows pick: the focus ring on a task selects it
    await $.ui.focus({ component: 'Pane', requestId: 'after', plugin: 'after', element: `row-${first}`, origin: { kind: 'person' } })
    expect(await ui.find({ type: 'Text', text: '❯ ' })).toBeDefined()
    await ui.press({ key: 'delete' })
    expect(w.queued()).toEqual(['second, rewritten'])

    await ui.input({ key: 'task', text: 'third' })
    expect(w.queued()).toEqual(['second, rewritten', 'third'])
    await ui.input({ key: 'task', text: 'rm 1' })
    expect(w.queued()).toEqual(['third'])

    await ui.press({ key: 'undo' })
    expect(w.queued()).toEqual(['second, rewritten', 'third'])
    await ui.unmount()
  }
})
