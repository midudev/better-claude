import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { activity, ago, digest, digestText, elapsed, shorten, summary, sweep } from '../src/format.js'

const file = (path, added = 3, removed = 1, status = 'M') => ({ path, status, added, removed })

describe('digest', () => {
  test('one or two files: each by its short path', () => {
    assert.deepEqual(digest([file('plugins/time-machine/hooks/register.tsx', 19, 7)]), {
      kind: 'few', files: [{ ...file('plugins/time-machine/hooks/register.tsx', 19, 7), name: 'hooks/register.tsx' }]
    })
  })

  test('more: the total and the biggest folders under the one they share, which is left out', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      file(i < 14 ? `src/auth/f${i}.ts` : i < 24 ? `src/tests/t${i}.ts` : i < 28 ? `src/db/d${i}.ts` : `src/x${i}.ts`))
    assert.deepEqual(digest(many), { kind: 'many', count: 30, added: 90, removed: 30, groups: ['auth/ ×14', 'tests/ ×10'], more: 3 })
  })

  test('binary files count no lines', () => {
    assert.deepEqual(digest(['a', 'b', 'c'].map(path => file(path, null, null, 'A'))),
      { kind: 'many', count: 3, added: 0, removed: 0, groups: ['a', 'b'], more: 1 })
  })

  test('as plain text, for the transcript', () => {
    assert.equal(digestText([file('src/a.ts', 3, 1, 'A')]), '+ src/a.ts')
    assert.equal(digestText(['a/x', 'a/y', 'b/z'].map(path => file(path))), '3 files +9 −3 · a/ ×2 · b/')
  })
})

describe('the small ones', () => {
  test('shorten keeps one line and cuts with an ellipsis', () => {
    assert.equal(shorten('fix\n  the   login'), 'fix the login')
    assert.equal(shorten('abcdef', 4), 'abc…')
  })

  test('summary counts files and lines', () => {
    assert.equal(summary([]), 'no files')
    assert.equal(summary([file('a'), file('b', null, null)]), '2 files +3 −1')
  })

  test('ago and elapsed read in the unit that fits', () => {
    assert.deepEqual([0, 7 * 60e3, 3 * 3600e3, 50 * 3600e3].map(ago), ['now', '7m', '3h', '2d'])
    assert.deepEqual([8e3, 65e3].map(elapsed), ['8s', '1m 05s'])
  })
})

describe('the running turn', () => {
  test('activity says what Claude is at, from its tool', () => {
    assert.equal(activity(null), 'thinking…')
    assert.equal(activity('Edit', { file_path: '/repo/plugins/x/src/format.js' }), 'editing src/format.js')
    assert.equal(activity('Bash', { command: 'npm test' }), 'running npm test')
    // Bash's own description reads best; without it, the command without its set-up
    assert.equal(activity('Bash', { command: 'T=/x; cd y && tsc', description: 'Type-check the mod' }), 'Type-check the mod')
    assert.equal(activity('Bash', { command: 'cd plugins/x && NODE_ENV=test npm test' }), 'running npm test')
    assert.equal(activity('Grep', { pattern: 'drawPane' }), 'searching "drawPane"')
    assert.equal(activity('TodoWrite', {}), 'TodoWrite')
    assert.equal(activity('mcp__github__get_issue', { url: 'https://x' }), 'get issue https://x')
  })

  test('sweep goes back and forth over the track, never past it', () => {
    assert.deepEqual(Array.from({ length: 12 }, (_, frame) => sweep(frame, 8, 3)), [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1])
  })
})
