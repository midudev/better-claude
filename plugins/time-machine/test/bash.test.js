import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { readOnly } from '../src/bash.js'

describe('readOnly', () => {
  test('commands that only look, alone or chained', () => {
    for (const command of ['ls', 'cat a.ts | grep x', 'cd src && ls', 'git log --oneline -5', 'git branch --show-current',
      'rg foo -g "*.ts"', 'git for-each-ref refs/heads', 'git -C ../other status', 'git stash list', 'env', 'git diff HEAD~1 && git status', 'git status 2>&1', 'rg foo src 2>/dev/null | head']) {
      assert.equal(readOnly(command), true, command)
    }
  })

  test('anything that can write, or that it does not know, is not: when unsure it snapshots', () => {
    for (const command of ['echo hi > a.txt', 'cat a >> b', 'ls | xargs rm', 'find . -name x -delete', 'find . -exec rm {} +',
      'cat a | tee b', 'echo $(rm -rf x)', 'ls `rm x`', 'npm test', 'git checkout .', 'git branch -D old', 'git stash',
      'ls; rm a', 'sed -i s/a/b/ f', '',
      // Commands that run other commands, or write through an option
      'env rm -rf build', 'env NODE_ENV=production npm run build', 'fd -e tmp -x rm', 'fd -e tmp --exec rm',
      'ls & rm -rf x', 'diff <(rm x) b', 'git diff --output=patch.diff', 'tree -o out.txt', 'find . -fls out.txt',
      'rg --pre ./script.sh foo']) {
      assert.equal(readOnly(command), false, command)
    }
  })
})
