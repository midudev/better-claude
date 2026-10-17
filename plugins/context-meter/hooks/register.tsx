import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Stats } from '../types'

const FRESH: Stats = { percent: null, cost: 0, mark: 0, msg: null, tokens: 0, output: 0, cache: null, agents: {} }
const stats = atom({ plugin: 'context-meter', key: 'stats' } as const, FRESH)
const running = atom({ plugin: 'context-meter', key: 'running' } as const, [] as string[])

const CELLS = 10
const REFRESH_MS = 2000

/** The bar as two runs, the filled cells and the empty ones, so each can have its own color. */
export function bar (percent: number, cells = CELLS, full = '▓', empty = '░') {
  const clamped = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0
  const filled = Math.round((clamped / 100) * cells)
  return { on: full.repeat(filled), off: empty.repeat(cells - filled) }
}

/** "950", "1.2k", "71k", "18M": a token count in as few characters as reads well. */
export function tokens (n: number) {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))}`
  const [value, unit] = n < 999_500 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']
  const tenths = Math.round(value * 10) / 10
  return `${tenths < 10 ? tenths : Math.round(value)}${unit}`
}

/** "~$0.06", "~$5": an estimate in dollars, with the cents only while they matter. */
export function money (usd: number) {
  if (!(usd > 0)) return '~$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 0.995) return `~$${usd.toFixed(2)}`
  const tenths = Math.round(usd * 10) / 10
  return `~$${tenths < 10 ? tenths : Math.round(usd)}`
}

const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')

/** Tokens spent so far by the subagents that are running now. */
export const agentTokens = (spent: Record<string, number>, ids: readonly string[]) =>
  ids.reduce((sum, id) => sum + (spent[id] ?? 0), 0)

/** Keeps `running` to the subagents the engine lists as running; it only writes when that changed. */
async function refresh ($: EngineInterface) {
  const ids = (await $.agent.list()).filter(agent => agent.status === 'running').map(agent => agent.id).sort()
  const before = await read($, running)
  if (ids.join() !== before.join()) await update($, running, () => ids)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    const usd = usage.cost?.usd ?? 0
    await update($, stats, () => ({ ...FRESH, percent: usage.context.percent ?? null, cost: usd, mark: usd }))
    await update($, running, () => [])

    $.clock.every(REFRESH_MS, () => { void refresh($) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, stats, s => ({
      ...s,
      percent: e.changed.includes('context') ? e.context.percent ?? null : s.percent,
      cost: e.cost?.usd ?? s.cost
    }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    // The message's cost is what the session total grew by since the last message ended.
    const usd = isMain ? (await $.session.usage()).cost?.usd : undefined
    const usage = e.usage
    const input = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0
    const total = input + (usage?.output_tokens ?? 0)

    await update($, stats, s => ({
      ...s,
      tokens: s.tokens + total,
      output: s.output + (usage?.output_tokens ?? 0),
      cache: isMain && usage && input > 0 ? (usage.cache_read_input_tokens / input) * 100 : s.cache,
      agents: e.agentId === undefined ? s.agents : { ...s.agents, [e.agentId]: (s.agents[e.agentId] ?? 0) + total },
      ...(usd === undefined ? {} : { cost: usd, msg: Math.max(0, usd - s.mark), mark: usd })
    }))
    return next(e)
  })

  // The engine's hint line stays as it is (its pills live); the meter follows it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, stats)
    if (s.percent === null && s.tokens === 0 && s.cost === 0) return next(e)

    const ids = await read($, running)
    const { Box, Text } = $.ui.resolve(e)
    const context = s.percent === null ? null : bar(s.percent)
    const cache = s.cache === null ? null : bar(s.cache, CELLS, '█', '▇')
    const spent = agentTokens(s.agents, ids)

    return (
      <Box flexDirection="row">
        {await next(e)}
        <Text dimColor> · </Text>
        {context ? <Text dimColor>ctx </Text> : null}
        {context ? <Text color={colorFor(s.percent ?? 0)}>{context.on}</Text> : null}
        {context ? <Text dimColor>{context.off}</Text> : null}
        {context ? <Text> {Math.round(s.percent ?? 0)}%</Text> : null}
        {context && cache ? <Text> </Text> : null}
        {cache ? <Text color="suggestion">{cache.on}</Text> : null}
        {cache ? <Text dimColor>{cache.off}</Text> : null}
        {context ? <Text dimColor> · </Text> : null}
        {s.msg === null ? null : <Text dimColor>{`msg ${money(s.msg)} · `}</Text>}
        <Text dimColor>session </Text>
        <Text>{`${tokens(s.tokens)} tok `}</Text>
        <Text color="claude">{money(s.cost)}</Text>
        <Text dimColor> · </Text>
        <Text color="success">{`out ${tokens(s.output)}`}</Text>
        {ids.length > 0 ? <Text dimColor> · </Text> : null}
        {ids.length > 0 ? <Text color="suggestion">{`agents ${ids.length} (${tokens(spent)})`}</Text> : null}
      </Box>
    )
  })
}
