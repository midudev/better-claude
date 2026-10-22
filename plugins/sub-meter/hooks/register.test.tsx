// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const HOUR = 3_600_000
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: at(2 * HOUR + 10 * 60_000) },
  { kind: 'seven_day', percentUsed: 23.5, resetsAt: at(76 * HOUR) }
]

/** Everything beneath the mod: the clock, the store, the session's usage and what the engine draws. */
function world (on: On, rateLimits: SessionRateLimit[] = LIMITS) {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits } as never }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The engine's own node, as core answers it; with mode labels, a Box the tests find.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    return e.props.modes.length > 0 ? <Box key="engine" /> : ({ type: 'engine', ref: 0 } as const)
  })
  return { clock, store }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const footer = ($: Engine, modes: string[] = [], columns?: number) =>
  $.ui.mount({ plugin: 'sub-meter', surface: 'terminal', component: 'SessionMode', props: { modes }, viewport: columns === undefined ? undefined : { columns, rows: 30 } })
const hint = ($: Engine, text: string) =>
  $.ui.mount({ plugin: 'sub-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: text } })

test('shows the 5-hour window first, as a bar with the time until it resets', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '────' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 58%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↻ 2h 10m' })).toBeDefined()
})

test('takes turns with the weekly window', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(8000)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: 'week' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 24%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↻ 3d 4h' })).toBeDefined()
})

test('takes turns as often as rotateSeconds says', { options: { rotateSeconds: 30 } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(8000)
  expect(await (await footer($)).find({ type: 'Text', text: '5h' })).toBeDefined()
  await w.clock.advance(22_000)
  expect(await (await footer($)).find({ type: 'Text', text: 'week' })).toBeDefined()
})

test('both shows the two windows side by side', { options: { display: 'both' } }, async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  |  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'week' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 24%' })).toBeDefined()
})

test('session keeps only the 5-hour window', { options: { display: 'session' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(30_000)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'week' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '  |  ' })).toBeUndefined()
})

test('week keeps only the weekly window', { options: { display: 'week' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(30_000)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: 'week' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
})

test('a chosen window the subscription does not report falls back to the one there is', { options: { display: 'session' } }, async ($, on) => {
  world(on, [LIMITS[1]])
  await startSession($)
  expect(await (await footer($)).find({ type: 'Text', text: 'week' })).toBeDefined()
})

test('an unknown display takes turns, as the default does', { options: { display: 'nonsense' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(await (await footer($)).find({ type: 'Text', text: '5h' })).toBeDefined()
  await w.clock.advance(8000)
  expect(await (await footer($)).find({ type: 'Text', text: 'week' })).toBeDefined()
})

test('adopts a newer reading another session left in the shared store', { options: { display: 'session' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(await (await footer($)).find({ type: 'Text', text: ' 58%' })).toBeDefined()
  w.store.limits = [{ ...LIMITS[0], percentUsed: 91 }, LIMITS[1]]
  w.store.at = NOW + 1000
  await w.clock.advance(8000)
  expect(await (await footer($)).find({ type: 'Text', text: ' 91%' })).toBeDefined()
})

test('ignores a reading in the shared store that is older than its own', { options: { display: 'session' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  w.store.limits = [{ ...LIMITS[0], percentUsed: 10 }, LIMITS[1]]
  w.store.at = NOW - 1000
  await w.clock.advance(8000)
  expect(await (await footer($)).find({ type: 'Text', text: ' 58%' })).toBeDefined()
})

test('alone, with no mode labels, the meter ends the footer', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text).toBe(' ↻ 2h 10m')
})

test("keeps the engine's mode labels after the meter", async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($, ['focus'])
  const row = await ui.drawn()
  expect(row.children?.at(-1)).toMatchObject({ props: { key: 'engine' } })
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['5h', ' ━━━━━━', '────', ' 58%', ' ↻ 2h 10m', ' · '])
})

test("keeps another plugin's drawing there after the meter, so it stays last", async ($, on) => {
  // Beneath the meter: another plugin's switch, where the engine has no labels to draw.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'⏵ narrator on'}</Text>
  })
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text).slice(-3)).toEqual([' ↻ 2h 10m', ' · ', '⏵ narrator on'])
})

test('off a subscription the engine draws its own footer', async ($, on) => {
  world(on, [])
  await startSession($)
  const ui = await footer($, ['focus'])
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
})

test('a new measurement shows at once and is kept for the next session', async ($, on) => {
  const w = world(on, [])
  await startSession($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ ...LIMITS[0], percentUsed: 91 }], changed: ['rateLimits'] } as never)
  const ui = await footer($)
  const used = await ui.find({ type: 'Text', text: ' ━━━━━━━━━' })
  expect(used?.props.color).toBe('error')
  expect(w.store.limits).toEqual([{ ...LIMITS[0], percentUsed: 91 }])
})

test('a window past its reset shows as empty', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.set(NOW + 3 * HOUR)
  const ui = await footer($)
  expect(await ui.find({ type: 'Text', text: ' 0%' })).toBeDefined()
})

test('drops the cycle hint from the line after the mode', async ($, on) => {
  world(on)
  const ui = await hint($, '(shift+tab to cycle) · ← for agents')
  expect(await ui.find({ type: 'Text', text: '← for agents' })).toBeDefined()
})

test('keeps what is around the cycle hint, without empty parts', { options: { hideInterruptHint: false } }, async ($, on) => {
  world(on)
  const ui = await hint($, 'esc to interrupt (shift+tab to cycle) ·  · ctrl+t to hide tasks')
  expect(await ui.find({ type: 'Text', text: 'esc to interrupt · ctrl+t to hide tasks' })).toBeDefined()
})

test('drops "esc to interrupt" while Claude works', async ($, on) => {
  world(on)
  const ui = await hint($, 'esc to interrupt (shift+tab to cycle) ·  · ctrl+t to hide tasks')
  expect(await ui.find({ type: 'Text', text: 'ctrl+t to hide tasks' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /esc to interrupt/ })).toBeUndefined()
})

test('keeps the hints when told to', { options: { hideCycleHint: false, hideInterruptHint: false } }, async ($, on) => {
  world(on)
  const ui = await hint($, 'esc to interrupt (shift+tab to cycle)')
  expect(await ui.find({ type: 'Text', text: 'esc to interrupt (shift+tab to cycle)' })).toBeDefined()
})

test('leaves every other hint as it is', async ($, on) => {
  world(on)
  const ui = await hint($, '? for shortcuts')
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
})

// The footer's row at 56 columns leaves the meter its 26: 4 of padding, 2 between, 20 for the mode
// label, and 4 for a plugin that may wrap it.
const texts = async (ui: { findAll: (query: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(text => text.text)

test('where the row is short the meter gives up its bar, then the reset time, then itself', async ($, on) => {
  world(on)
  await startSession($)
  expect(await texts(await footer($, [], 56))).toEqual(['5h', ' ━━━━━━', '────', ' 58%', ' ↻ 2h 10m'])
  expect(await texts(await footer($, [], 55))).toEqual(['5h', ' 58%', ' ↻ 2h 10m'])
  expect(await texts(await footer($, [], 44))).toEqual(['5h', ' 58%'])
  const none = await footer($, [], 35)
  expect(await none.find({ type: 'Text', text: '5h' })).toBeUndefined()
})

test('the hint beside the mode label takes its room from the meter', async ($, on) => {
  world(on)
  await startSession($)
  await hint($, '? for shortcuts')
  expect(await texts(await footer($, [], 72))).toEqual(['5h', ' ━━━━━━', '────', ' 58%', ' ↻ 2h 10m'])
  expect(await texts(await footer($, [], 71))).toEqual(['5h', ' 58%', ' ↻ 2h 10m'])
})

test("another plugin's switch beneath keeps its room: the meter shrinks first", { plugins: [{
  name: 'switch',
  register (on) {
    on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
      await next(e)
      const { Text } = $.ui.resolve(e)
      return <Text>{'⏵ narrator on'}</Text>
    })
  }
}] }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await texts(await footer($, [], 68))).toEqual(['5h', ' ━━━━━━', '────', ' 58%', ' ↻ 2h 10m', ' · ', '⏵ narrator on'])
  expect(await texts(await footer($, [], 67))).toEqual(['5h', ' 58%', ' ↻ 2h 10m', ' · ', '⏵ narrator on'])
  expect(await texts(await footer($, [], 47))).toEqual(['⏵ narrator on'])
})

test('what a switch beneath gives up is not taken back: the meter only shrinks as the row does', { plugins: [{
  name: 'switch',
  register (on) {
    on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
      await next(e)
      const { Text } = $.ui.resolve(e)
      return <Text>{'⏵'}</Text>
    })
  }
}] }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await texts(await footer($, [], 54))).toEqual(['5h', ' 58%', ' ↻ 2h 10m', ' · ', '⏵'])
  expect(await texts(await footer($, [], 53))).toEqual(['5h', ' 58%', ' · ', '⏵'])
  expect(await texts(await footer($, [], 36))).toEqual(['5h', ' 58%', ' · ', '⏵'])
  expect(await texts(await footer($, [], 35))).toEqual(['⏵'])
})

test('off the terminal the meter is drawn whole', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await $.ui.mount({ plugin: 'sub-meter', surface: 'desktop', component: 'SessionMode', props: { modes: [] }, viewport: { columns: 30, rows: 30 } })
  expect(await ui.find({ type: 'Text', text: ' ━━━━━━' })).toBeDefined()
})
