import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { lineOf, merge, nextId } from '../src/states.js'

const state = (id, parent, at = id, commit = `c${id}`) => ({ id, kind: 'turn', label: `#${id}`, at, commit, tree: `t${id}`, parent, files: [] })

describe('lineOf', () => {
  test('the states the files are made of: from the cursor back to the start', () => {
    // 1 ← 2 ← 3, and 4 branched off 2
    const states = [state(1, null), state(2, 1), state(3, 2), state(4, 2)]
    assert.deepEqual([...lineOf(states, 4)], [4, 2, 1])
    assert.deepEqual([...lineOf(states, null)], [])
  })
})

describe('nextId', () => {
  test('one past the highest, gaps and all', () => {
    assert.equal(nextId([]), 1)
    assert.equal(nextId([state(1, null), state(5, 1)]), 6)
  })
})

describe('merge', () => {
  test('saved and live by commit, live winning, in the order they were made', () => {
    const saved = [state(1, null), state(2, 1)]
    const live = [state(1, null), state(2, 1), state(3, 2)]
    assert.deepEqual(merge(saved, live).states.map(one => one.id), [1, 2, 3])
    assert.deepEqual(merge(saved, []).states.map(one => one.id), [1, 2])
  })

  test('an id handed out twice: the later state gets a new one and stays the first one\'s child', () => {
    const { states, repaired } = merge([state(1, null), state(2, 1), state(2, 2, 3, 'c3')], [])
    assert.deepEqual(states.map(one => [one.id, one.commit, one.parent]), [[1, 'c1', null], [2, 'c2', 1], [3, 'c3', 2]])
    assert.deepEqual(repaired.map(one => [one.id, one.commit]), [[3, 'c3'], [2, 'c2']])
  })
})
