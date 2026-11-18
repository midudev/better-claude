export type SentAt = number | null

declare module 'claude-code' {
  interface PluginState {
    'message-timestamps': { sentAt: StateFamily<SentAt>; now: number }
  }
}
