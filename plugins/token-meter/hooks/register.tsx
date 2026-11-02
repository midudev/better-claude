import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tokens } from '../types'

const ZERO: Tokens = { input: 0, output: 0, cached: 0 }
const turn = atom({ plugin: 'token-meter', key: 'turn' } as const, null as Tokens | null)
const session = atom({ plugin: 'token-meter', key: 'session' } as const, ZERO)

const UNITS = ['k', 'M', 'B']

// One decimal, rounded half up from the count itself (an integer over a power of
// ten lands exactly on .5, where toFixed would see 1.15 as 1.1499…). A count that
// rounds to 1000 of a unit moves up to the next one: 999_950 reads 1.0M, not 1000.0k.
const short = (n: number) => {
  if (n < 1000) return `${n}`
  let unit = 0
  let tenths = Math.round(n / 100)
  while (tenths >= 10_000 && unit < UNITS.length - 1) tenths = Math.round(n / (100 * 1000 ** ++unit))
  return `${Math.floor(tenths / 10)}.${tenths % 10}${UNITS[unit]}`
}

// The engine fills a count the response left out with zero; should one come
// through missing anyway, it reads as zero rather than NaN for the rest of the session.
const count = (n?: number) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, turn, () => null)
    await update($, session, () => ZERO)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage) {
      const last: Tokens = {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cached: count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
      }
      await update($, turn, () => last)
      await update($, session, total => ({
        input: total.input + last.input,
        output: total.output + last.output,
        cached: total.cached + last.cached
      }))
    }
    return next(e)
  })

  // The engine's hint line stays as it is (its pills live); the meter follows it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const last = await read($, turn)
    if (last === null) return next(e)

    const total = await read($, session)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {await next(e)}
        <Text dimColor> · </Text>
        <Text color="suggestion">↑</Text>
        <Text> {short(last.input)}  </Text>
        <Text color="success">↓</Text>
        <Text> {short(last.output)}  </Text>
        <Text color="claude">cache</Text>
        <Text> {short(last.cached)}</Text>
        <Text dimColor>  ·  session ↑ {short(total.input)}  ↓ {short(total.output)}</Text>
      </Box>
    )
  })
}
