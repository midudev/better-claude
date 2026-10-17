/** What the meter keeps of the session: the context fill, the cost, the tokens and what each subagent has spent. */
export type Stats = {
  /** Whole percentage of the context window in use; null until the first response of the window. */
  percent: number | null
  /** The session's cost so far, in US dollars (an estimate), as the engine totals it. */
  cost: number
  /** The cost when the last message ended, to tell what the next one added. */
  mark: number
  /** What the last message cost; null before the first one. */
  msg: number | null
  /** Every token the API counted this session, cached ones included. */
  tokens: number
  /** Output tokens this session. */
  output: number
  /** Share of the last message's input that came from the prompt cache, 0 to 100. */
  cache: number | null
  /** Tokens each subagent has spent so far, by agent id. */
  agents: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { stats: Stats; running: string[] }
  }
}
