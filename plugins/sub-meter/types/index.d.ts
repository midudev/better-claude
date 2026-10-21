/** One rate-limit window of the subscription, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** The context window's fill, as the last response reported it: its tokens over the window's. */
export type Context = { tokens: number; window: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'sub-meter': { limits: Limit[]; context: Context | null; view: number }
  }
}
