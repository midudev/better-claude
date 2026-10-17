// The history of states as data: which ones the files are made of, the next free id, and
// the merge that makes a list whole again after a hot reload. Pure: never touches git.

/** @typedef {import('../types').State} State */

/** The ids from `cursor` back to the start: the states the files are made of now. @param {State[]} states @param {number | null} cursor */
export function lineOf (states, cursor) {
  /** @type {Set<number>} */
  const line = new Set()
  let id = cursor
  while (id !== null && !line.has(id)) {
    line.add(id)
    id = states.find(state => state.id === id)?.parent ?? null
  }
  return line
}

/**
 * The next id: one past the highest. It comes from the states themselves, never from a
 * counter of the module, which a hot reload starts over while the states stay.
 * @param {State[]} states
 */
export const nextId = states => states.reduce((max, state) => Math.max(max, state.id), 0) + 1

/**
 * The saved states and the live ones (what a hot reload keeps), merged by commit, in the order
 * they were made. A reload that raced the end of a turn could hand out an id twice: the later
 * state with a taken id gets a new one. A state whose parent is that id came after the first,
 * so it stays the first's child. `repaired` lists the states whose ref has to be pointed again.
 * @param {State[]} saved
 * @param {State[]} live
 */
export function merge (saved, live) {
  /** @type {Map<string, State>} */
  const byCommit = new Map()
  for (const state of [...saved, ...live]) byCommit.set(state.commit, state)
  const merged = [...byCommit.values()].sort((a, b) => a.at - b.at || a.id - b.id)

  let max = nextId(merged) - 1
  /** @type {Set<number>} */
  const seen = new Set()
  /** @type {State[]} */
  const repaired = []
  const states = merged.map(state => {
    if (!seen.has(state.id)) {
      seen.add(state.id)
      return state
    }
    const moved = { ...state, id: ++max }
    const first = merged.find(one => one.id === state.id)
    repaired.push(moved, ...(first ? [first] : []))
    return moved
  })
  return { states, repaired }
}
