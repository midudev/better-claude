// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agentTokens, bar, money, tokens } from './register'

const USAGE = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }

/** What sits beneath the mod: the session's usage, its agents and the engine's own hint line. */
function world (on: On, now = { percent: 22 as number | undefined, usd: 0 }, agents: { id: string; status: string }[] = []) {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: now.percent }, rateLimits: [], cost: { usd: now.usd } } as never }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: agents.map(a => ({ description: a.id, type: 'Explore', ...a })) as never }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return 'hint' in e.props ? <Text>{e.props.hint}</Text> : <Box key="engine" />
  })
  return { clock, now, agents }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const turnEnd = ($: Engine, usage?: typeof USAGE, agentId?: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage, agentId })
const hint = ($: Engine) =>
  $.ui.mount({ plugin: 'context-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })

test('bar fills the share of its cells and clamps to 0..100', () => {
  expect(bar(22)).toEqual({ on: '▓▓', off: '░░░░░░░░' })
  expect(bar(0)).toEqual({ on: '', off: '░░░░░░░░░░' })
  expect(bar(100)).toEqual({ on: '▓▓▓▓▓▓▓▓▓▓', off: '' })
  expect(bar(-5)).toEqual({ on: '', off: '░░░░░░░░░░' })
  expect(bar(140)).toEqual({ on: '▓▓▓▓▓▓▓▓▓▓', off: '' })
  expect(bar(Number.NaN)).toEqual({ on: '', off: '░░░░░░░░░░' })
  expect(bar(50, 4)).toEqual({ on: '▓▓', off: '░░' })
  expect(bar(90, 10, '█', '▇')).toEqual({ on: '█████████', off: '▇' })
})

test('tokens are short: 950, 1.2k, 71k, 18M', () => {
  expect(tokens(0)).toBe('0')
  expect(tokens(950)).toBe('950')
  expect(tokens(1000)).toBe('1k')
  expect(tokens(1234)).toBe('1.2k')
  expect(tokens(9960)).toBe('10k')
  expect(tokens(71_000)).toBe('71k')
  expect(tokens(93_400)).toBe('93k')
  expect(tokens(999_499)).toBe('999k')
  expect(tokens(999_500)).toBe('1M')
  expect(tokens(1_500_000)).toBe('1.5M')
  expect(tokens(18_000_000)).toBe('18M')
  expect(tokens(18_400_000)).toBe('18M')
  expect(tokens(-3)).toBe('0')
  expect(tokens(Number.NaN)).toBe('0')
})

test('money is an estimate: ~$0.06, ~$5, ~$120', () => {
  expect(money(0)).toBe('~$0')
  expect(money(-1)).toBe('~$0')
  expect(money(0.004)).toBe('<$0.01')
  expect(money(0.06)).toBe('~$0.06')
  expect(money(0.994)).toBe('~$0.99')
  expect(money(0.996)).toBe('~$1')
  expect(money(1.5)).toBe('~$1.5')
  expect(money(5)).toBe('~$5')
  expect(money(9.96)).toBe('~$10')
  expect(money(12.4)).toBe('~$12')
  expect(money(120.6)).toBe('~$121')
})

test('agentTokens adds up only the agents asked for', () => {
  expect(agentTokens({ a: 10, b: 20, c: 5 }, ['a', 'c'])).toBe(15)
  expect(agentTokens({ a: 10 }, ['x'])).toBe(0)
  expect(agentTokens({ a: 10 }, [])).toBe(0)
})

test("a finished message shows context, its cost, the session and the output after the engine's hint", async ($, on) => {
  const w = world(on)
  await startSession($)
  w.now.usd = 0.5
  await turnEnd($, USAGE)
  w.now.usd = 0.56
  await turnEnd($, USAGE)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '▓▓' }))?.props.color).toBe('claude')
  expect(await ui.find({ type: 'Text', text: '░░░░░░░░' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 22%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '█████████' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'msg ~$0.06 · ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '21k tok ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '~$0.56' }))?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Text', text: 'out 600' }))?.props.color).toBe('success')
})

test('the message cost is what the session total grew by since the last one', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.now.usd = 0.5
  await turnEnd($, USAGE)
  w.now.usd = 0.62
  await turnEnd($, USAGE)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: 'msg ~$0.12 · ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~$0.62' })).toBeDefined()
})

test('session tokens and output add up across messages', async ($, on) => {
  world(on)
  await startSession($)
  await turnEnd($, USAGE)
  await turnEnd($, { ...USAGE, output_tokens: 700 })
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '21k tok ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'out 1k' })).toBeDefined()
})

test('the context bar follows session.measure and turns red from 90%', async ($, on) => {
  world(on)
  await startSession($)
  await turnEnd($, USAGE)
  await $.session.measure({ context: { window: 200_000, percent: 91 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await hint($)
  expect((await ui.find({ type: 'Text', text: '▓▓▓▓▓▓▓▓▓' }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: ' 91%' })).toBeDefined()
})

test('a measured cost shows in the session total at once', async ($, on) => {
  world(on)
  await startSession($)
  await $.session.measure({ context: { window: 200_000, percent: 22 }, rateLimits: [], cost: { usd: 4.8 }, changed: ['cost'] } as never)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '~$4.8' })).toBeDefined()
})

test('running subagents show with the tokens they have spent', async ($, on) => {
  const w = world(on, undefined, [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'completed' }])
  await startSession($)
  await turnEnd($, USAGE)
  await turnEnd($, { ...USAGE, input_tokens: 80_000, output_tokens: 13_000, cache_read_input_tokens: 0 }, 'a1')
  await turnEnd($, { ...USAGE, input_tokens: 5000, output_tokens: 0, cache_read_input_tokens: 0 }, 'a2')
  await w.clock.advance(2000)
  const ui = await hint($)
  expect((await ui.find({ type: 'Text', text: 'agents 1 (93k)' }))?.props.color).toBe('suggestion')
})

test('a subagent that finished leaves the meter', async ($, on) => {
  const w = world(on, undefined, [{ id: 'a1', status: 'running' }])
  await startSession($)
  await turnEnd($, USAGE)
  await w.clock.advance(2000)
  w.agents[0].status = 'completed'
  await w.clock.advance(2000)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: 'agents 1 (0)' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'out 300' })).toBeDefined()
})

test('a subagent turn does not count as a message of its own', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.now.usd = 1
  await turnEnd($, USAGE, 'a1')
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: 'msg ~$1 · ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'msg ~$0 · ' })).toBeUndefined()
})

test('before anything is measured the hint line is left alone', async ($, on) => {
  world(on, { percent: undefined, usd: 0 })
  await startSession($)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx ' })).toBeUndefined()
})

test('a new session starts from zero', async ($, on) => {
  world(on, { percent: undefined, usd: 0 })
  await startSession($)
  await turnEnd($, USAGE)
  await startSession($)
  const ui = await hint($)
  expect(await ui.find({ type: 'Text', text: 'out 300' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
})
