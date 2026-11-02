// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 4100, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }

/** What sits beneath the mod: the turn's end and the engine's own hint line. */
function world (on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return 'hint' in e.props ? <Text>{e.props.hint}</Text> : <Box key="engine" />
  })
}

const turnEnd = ($: Engine, usage?: typeof USAGE) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage })
const hint = ($: Engine) =>
  $.ui.mount({ plugin: 'token-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })

test("a finished turn shows its tokens in color after the engine's hint", async ($, on) => {
  world(on)
  await turnEnd($, USAGE)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '↑' }))?.props.color).toBe('suggestion')
  expect(await ui.find({ type: 'Text', text: ' 1.2k  ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '↓' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: ' 340  ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'cache' }))?.props.color).toBe('claude')
  expect(await ui.find({ type: 'Text', text: ' 4.1k' })).toBeDefined()
})

test('the session total adds up across turns', async ($, on) => {
  world(on)
  await turnEnd($, USAGE)
  await turnEnd($, { ...USAGE, input_tokens: 800, output_tokens: 60, cache_read_input_tokens: 0 })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: ' 800  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ·  session ↑ 2.0k  ↓ 400' })).toBeDefined()
})

test('millions and billions of tokens read as M and B', async ($, on) => {
  world(on)
  await turnEnd($, { ...USAGE, input_tokens: 1_234_567, output_tokens: 42_000_000, cache_read_input_tokens: 3_456_789_012 })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: ' 1.2M  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 42.0M  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 3.5B' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ·  session ↑ 1.2M  ↓ 42.0M' })).toBeDefined()
})

test('a count that rounds to 1000 of a unit moves up to the next one', async ($, on) => {
  world(on)
  await turnEnd($, { ...USAGE, input_tokens: 999_949, output_tokens: 999_950, cache_read_input_tokens: 999_950_000 })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: ' 999.9k  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 1.0M  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 1.0B' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ·  session ↑ 999.9k  ↓ 1.0M' })).toBeDefined()
})

test('a half rounds up at every size', async ($, on) => {
  world(on)
  await turnEnd($, { ...USAGE, input_tokens: 1_150, output_tokens: 1_150_000, cache_read_input_tokens: 1_250_000 })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: ' 1.2k  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 1.2M  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 1.3M' })).toBeDefined()
})

test('a count missing from the usage reads as zero, not NaN', async ($, on) => {
  world(on)
  const missing = { ...USAGE, cache_creation_input_tokens: undefined } as unknown as typeof USAGE
  await turnEnd($, missing)
  await turnEnd($, missing)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: ' 4.1k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ·  session ↑ 2.4k  ↓ 680' })).toBeDefined()
})

test('before any turn the hint line is left alone', async ($, on) => {
  world(on)
  await turnEnd($)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↑' })).toBeUndefined()
})

test('a new session starts from zero', async ($, on) => {
  world(on)
  await turnEnd($, USAGE)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '↑' })).toBeUndefined()
})
