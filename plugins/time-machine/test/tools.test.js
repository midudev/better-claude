import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { mayWrite } from '../src/tools.js'

describe('mayWrite', () => {
  test('the file tools write; reading, searching and asking do not', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) assert.equal(mayWrite(tool), true, tool)
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'Agent', 'AskUserQuestion']) assert.equal(mayWrite(tool), false, tool)
  })

  test('Bash by its command', () => {
    assert.equal(mayWrite('Bash', { command: 'git status' }), false)
    assert.equal(mayWrite('Bash', { command: 'npm test' }), true)
    assert.equal(mayWrite('Bash', {}), true)
  })

  test('an MCP tool by what its name says; one that does not say, and an unknown tool, may write', () => {
    assert.equal(mayWrite('mcp__github__get_issue'), false)
    assert.equal(mayWrite('mcp__filesystem__list_directory'), false)
    assert.equal(mayWrite('mcp__filesystem__write_file'), true)
    assert.equal(mayWrite('mcp__codegen__apply'), true)
    assert.equal(mayWrite('SomeNewTool'), true)
  })
})
