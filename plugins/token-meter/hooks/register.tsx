import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tokens } from '../types'

const ZERO: Tokens = { input: 0, output: 0, cached: 0 }
const turn = atom({ plugin: 'token-meter', key: 'turn' } as const, null as Tokens | null)
const session = atom({ plugin: 'token-meter', key: 'session' } as const, ZERO)

// From 999_950 on, k would round to 1000.0k
const short = (n: number) => (n >= 999_950 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

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
        input: usage.input_tokens,
        output: usage.output_tokens,
        cached: usage.cache_read_input_tokens + usage.cache_creation_input_tokens
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
