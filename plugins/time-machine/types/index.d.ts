/** One file that differs between two states. `added`/`removed` are null for a binary file. */
export type Change = { path: string; status: string; added: number | null; removed: number | null }

/**
 * A state the working tree was in and can go back to: the start of the session, the end
 * of a turn, changes made outside Claude, or the person's own changes saved before a jump.
 * `parent` is the state it came from (undo goes there); `files`, what differs from it.
 */
export type State = {
  id: number
  kind: 'start' | 'turn' | 'outside' | 'saved'
  label: string
  at: number
  commit: string
  tree: string
  parent: number | null
  files: Change[]
  /** The prompt of the turn, whole (up to 2,000 characters); absent for other kinds. */
  prompt?: string
}

/** The turn under way, drawn at the top of the timeline while it runs: its files so far. */
/** `doing` is what Claude is at right now (`editing src/a.ts`, `thinking…`); `frame` moves the animation. */
export type Live = { label: string; prompt: string; at: number; files: Change[]; doing: string; frame: number }

/** What going to state `id` would change, from the files as they are now. */
export type Preview = { id: number; files: Change[] }

declare module 'claude-code' {
  interface PluginState {
    'time-machine': {
      session: string
      states: State[]
      cursor: number | null
      departed: number | null
      dirty: boolean
      selected: number | null
      preview: Preview | null
      live: Live | null
      note: string | null
    }
  }
}
