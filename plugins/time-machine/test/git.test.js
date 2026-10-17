// The git side against a real git, on throwaway repositories: `node --test`.
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MoveBlocked, REF_ROOT, changes, keep, locate, move, pin, prune, snapshot, treeOf } from '../src/git.js'

/**
 * `$.process.run`, as the engine gives it, over node's child_process: it resolves with the exit
 * code, writes `stdin` and closes it, and REJECTS when the command cannot start (no such program),
 * as the engine does.
 */
function run (argv, init = {}) {
  return new Promise((resolve, reject) => {
    // Without stdin to send, the child starts with its input closed: writing to a child that has
    // already exited is an EPIPE, and on a fast runner git often exits first
    const hasStdin = init.stdin !== undefined
    const child = spawn(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }))
    if (hasStdin) {
      // A child may exit before it reads all of it (check-ignore with nothing ignored): not a failure
      child.stdin.on('error', () => {})
      child.stdin.end(init.stdin)
    }
  })
}

/** The same, on a machine without `cp` (Windows outside Git Bash). */
const runWithoutCp = (argv, init) => argv[0] === 'cp' ? Promise.reject(new Error('spawn cp ENOENT')) : run(argv, init)

async function repository (t, { commit = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'time-machine-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sh = (...argv) => run(['git', ...argv], { cwd: dir })
  await sh('init', '-q')
  await sh('config', 'user.name', 'test')
  await sh('config', 'user.email', 'test@localhost')
  // Windows runners turn on autocrlf: a move would write `one\r\n` where the test wrote `one\n`
  await sh('config', 'core.autocrlf', 'false')
  await writeFile(join(dir, '.gitignore'), 'secret.env\n')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  if (commit) {
    await sh('add', '.')
    await sh('commit', '-q', '-m', 'first')
  }
  return { dir, sh, file: name => join(dir, name) }
}

const exists = path => access(path).then(() => true, () => false)

test('locate finds the repository, and nothing outside one', async t => {
  const { dir } = await repository(t)
  const repo = await locate(run, dir)
  assert.ok(repo.gitDir.endsWith('.git'))
  const outside = await mkdtemp(join(tmpdir(), 'time-machine-none-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  assert.equal(await locate(run, outside), null)
})

test('a move brings back edits, deletes new files and recreates removed ones', async t => {
  const { dir, file, sh } = await repository(t)
  const repo = await locate(run, dir)
  await writeFile(file('untracked.txt'), 'kept\n')
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'turn 1')

  // The turn: an edit, a new file, a removed untracked file and a removed tracked one
  await writeFile(file('a.txt'), 'two\n')
  await writeFile(file('new.txt'), 'new\n')
  await rm(file('untracked.txt'))
  await rm(file('.gitignore'))

  const safety = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'back')
  const changed = await move(run, repo, safety.tree, before.tree)
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one\n')
  assert.equal(await exists(file('new.txt')), false)
  assert.equal(await readFile(file('untracked.txt'), 'utf8'), 'kept\n')
  assert.equal(await exists(file('.gitignore')), true)
  assert.deepEqual(changed.map(c => `${c.status} ${c.path}`).sort(),
    ['A .gitignore', 'A untracked.txt', 'D new.txt', 'M a.txt'])

  // The way back is a snapshot too
  await move(run, repo, (await treeOf(run, repo)).tree, safety.tree)
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'two\n')
  assert.equal(await exists(file('new.txt')), true)

  // Nothing of the person's: no new commit on the branch, an empty staging area
  assert.equal((await sh('rev-list', '--count', 'HEAD')).stdout.trim(), '1')
  assert.equal((await sh('diff', '--cached', '--name-only')).stdout.trim(), '')
})

test('ignored files are neither kept nor touched', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(run, dir)
  await writeFile(file('secret.env'), 'KEY=1\n')
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'turn 1')
  await writeFile(file('secret.env'), 'KEY=2\n')
  await move(run, repo, (await treeOf(run, repo)).tree, before.tree)
  assert.equal(await readFile(file('secret.env'), 'utf8'), 'KEY=2\n')
})

test('changes counts lines per file', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(run, dir)
  const a = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await writeFile(file('a.txt'), 'one\ntwo\nthree\n')
  const b = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  assert.deepEqual(await changes(run, repo, a.tree, b.tree), [{ path: 'a.txt', status: 'M', added: 2, removed: 0 }])
  assert.deepEqual(await changes(run, repo, a.tree, a.tree), [])
})

test('works in a repository with no commit yet, and with no git identity', async t => {
  const { dir, file, sh } = await repository(t, { commit: false })
  await sh('config', '--unset', 'user.name')
  const repo = await locate(run, dir)
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'turn 1')
  await writeFile(file('a.txt'), 'changed\n')
  await move(run, repo, (await treeOf(run, repo)).tree, before.tree)
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one\n')
})

test('prune drops only the old snapshots', async t => {
  const { dir, sh } = await repository(t)
  const repo = await locate(run, dir)
  await snapshot(run, repo, `${REF_ROOT}/s/1`, 'one')
  const later = Date.now() + 8 * 24 * 60 * 60 * 1000
  assert.equal(await prune(run, repo, Date.now(), 7 * 24 * 60 * 60 * 1000), 0)
  assert.equal(await prune(run, repo, later, 7 * 24 * 60 * 60 * 1000), 1)
  assert.equal((await sh('for-each-ref', REF_ROOT)).stdout.trim(), '')
})

test('paths with spaces and accents, binaries and renames all count', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(run, dir)
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await mkdir(file('my dir'))
  await writeFile(file('my dir/canción.txt'), 'la\nla\n')
  await writeFile(file('logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
  await writeFile(file('b.txt'), 'one\n')
  await rm(file('a.txt'))   // a.txt "renamed" to b.txt: one removal and one addition
  const after = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  assert.deepEqual((await changes(run, repo, before.tree, after.tree)).sort((x, y) => x.path.localeCompare(y.path)), [
    { path: 'a.txt', status: 'D', added: 0, removed: 1 },
    { path: 'b.txt', status: 'A', added: 1, removed: 0 },
    { path: 'logo.png', status: 'A', added: null, removed: null },
    { path: 'my dir/canción.txt', status: 'A', added: 2, removed: 0 }
  ])
})

test('a jump never overwrites an ignored file: it refuses and says which', async t => {
  const { dir, file, sh } = await repository(t)
  const repo = await locate(run, dir)
  // config.local.json is snapshotted before it is ignored…
  await writeFile(file('config.local.json'), 'old\n')
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  // …then ignored and committed, and given real values
  await rm(file('config.local.json'))
  await writeFile(file('.gitignore'), 'secret.env\nconfig.local.json\n')
  await sh('commit', '-qam', 'ignore it')
  await writeFile(file('config.local.json'), 'precious\n')

  const now = await treeOf(run, repo)
  await assert.rejects(move(run, repo, now.tree, before.tree), error => error instanceof MoveBlocked && error.paths.includes('config.local.json'))
  assert.equal(await readFile(file('config.local.json'), 'utf8'), 'precious\n')
})

test('a file that becomes ignored leaves the snapshots: no secret is kept', async t => {
  const { dir, file, sh } = await repository(t)
  const repo = await locate(run, dir)
  await writeFile(file('.env'), 'KEY=placeholder\n')
  await snapshot(run, repo, `${REF_ROOT}/s/1`, 'before ignoring')
  await writeFile(file('.gitignore'), 'secret.env\n.env\n')
  await writeFile(file('.env'), 'KEY=SECRET\n')
  const after = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'after ignoring')
  const listed = await sh('ls-tree', '--name-only', after.tree)
  assert.equal(listed.stdout.split('\n').includes('.env'), false)
  // A tracked file the .gitignore matches is still the repository's: it stays
  await sh('add', '-f', '.env')
  await sh('commit', '-qm', 'track it anyway')
  const tracked = await snapshot(run, repo, `${REF_ROOT}/s/3`, 'tracked')
  assert.equal((await sh('ls-tree', '--name-only', tracked.tree)).stdout.split('\n').includes('.env'), true)
})

test('a session that starts in the middle of a merge conflict recovers once it is resolved', async t => {
  const { dir, file, sh } = await repository(t)
  await sh('checkout', '-qb', 'other')
  await writeFile(file('a.txt'), 'theirs\n')
  await sh('commit', '-qam', 'theirs')
  await sh('checkout', '-q', '-')
  await writeFile(file('a.txt'), 'ours\n')
  await sh('commit', '-qam', 'ours')
  await sh('merge', 'other')   // conflicts: the repository's index has unmerged entries
  const repo = await locate(run, dir)
  await treeOf(run, repo).catch(() => undefined)   // may fail mid-conflict; must not stick

  await writeFile(file('a.txt'), 'both\n')
  await sh('commit', '-qam', 'resolved')
  const snap = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'after the merge')
  assert.equal((await sh('show', `${snap.tree}:a.txt`)).stdout, 'both\n')
})

test('without cp, the index starts empty and snapshots still work', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(runWithoutCp, dir)
  const before = await snapshot(runWithoutCp, repo, `${REF_ROOT}/s/1`, 'a')
  await writeFile(file('a.txt'), 'two\n')
  await move(runWithoutCp, repo, (await treeOf(runWithoutCp, repo)).tree, before.tree)
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one\n')
})

test('HEAD moving between snapshots (a commit, a checkout) is followed', async t => {
  const { dir, file, sh } = await repository(t)
  const repo = await locate(run, dir)
  await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await writeFile(file('c.txt'), 'committed\n')
  await sh('add', 'c.txt')
  await sh('commit', '-qm', 'c')
  await sh('checkout', '-qb', 'feature')
  await writeFile(file('c.txt'), 'edited\n')
  const snap = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  assert.equal((await sh('show', `${snap.tree}:c.txt`)).stdout, 'edited\n')
})

test('a linked worktree has its own index: snapshots and moves stay in it', async t => {
  const { dir, file, sh } = await repository(t)
  const linked = `${dir}-linked`
  t.after(() => rm(linked, { recursive: true, force: true }))
  await sh('worktree', 'add', '-q', linked)
  const repo = await locate(run, linked)
  assert.notEqual(repo.gitDir, (await locate(run, dir)).gitDir)

  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await writeFile(join(linked, 'a.txt'), 'linked edit\n')
  await move(run, repo, (await treeOf(run, repo)).tree, before.tree)
  assert.equal(await readFile(join(linked, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one\n')
})

test('two sessions in one repository each keep an index of their own', async t => {
  const { dir, file } = await repository(t)
  const found = await locate(run, dir)
  const a = { ...found, index: `${found.gitDir}/time-machine-a.index` }
  const b = { ...found, index: `${found.gitDir}/time-machine-b.index` }
  await writeFile(file('a.txt'), 'two\n')
  // At once: with one shared index, one of them would hit index.lock
  const [x, y] = await Promise.all([snapshot(run, a, `${REF_ROOT}/a/1`, 'a'), snapshot(run, b, `${REF_ROOT}/b/1`, 'b')])
  assert.equal(x.tree, y.tree)
  assert.equal(await exists(a.index), true)
  assert.equal(await exists(b.index), true)
})

test('pin points a ref at a commit; keep with no HEAD makes a root commit', async t => {
  const { dir, sh } = await repository(t, { commit: false })
  const repo = await locate(run, dir)
  const { tree, head } = await treeOf(run, repo)
  assert.equal(head, null)
  const commit = await keep(run, repo, { tree, head }, `${REF_ROOT}/s/1`, 'root')
  assert.equal((await sh('rev-list', '--parents', '-n', '1', commit)).stdout.trim(), commit)
  await pin(run, repo, `${REF_ROOT}/s/9`, commit)
  assert.equal((await sh('rev-parse', `${REF_ROOT}/s/9`)).stdout.trim(), commit)
})

test('prune drops a thousand old refs in one go', async t => {
  const { dir, sh } = await repository(t)
  const repo = await locate(run, dir)
  const { commit } = await snapshot(run, repo, `${REF_ROOT}/s/0`, 'one')
  await sh('update-ref', '--stdin').catch(() => undefined)
  await run(['git', 'update-ref', '--stdin'], { cwd: dir, stdin: Array.from({ length: 1000 }, (_, i) => `create ${REF_ROOT}/s/${i + 1} ${commit}\n`).join('') })
  let calls = 0
  const counting = (argv, init) => { calls++; return run(argv, init) }
  const later = Date.now() + 8 * 24 * 60 * 60 * 1000
  assert.equal(await prune(counting, repo, later, 7 * 24 * 60 * 60 * 1000), 1001)
  assert.ok(calls <= 2, `${calls} git calls`)
  assert.equal((await sh('for-each-ref', REF_ROOT)).stdout.trim(), '')
})

test('a listing cut at the engine\'s output limit keeps its whole entries only', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(run, dir)
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  for (const name of ['one.txt', 'two.txt', 'three.txt']) await writeFile(file(name), 'x\n')
  const after = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  // The engine keeps the first 4 MiB: here, cut in the middle of the last entry
  const cut = async (argv, init) => {
    const result = await run(argv, init)
    if (argv[1] !== 'diff') return result
    return { ...result, stdout: result.stdout.slice(0, result.stdout.length - 4), isStdoutTruncated: true }
  }
  const listed = await changes(cut, repo, before.tree, after.tree)
  assert.equal(listed.length, 2)
  assert.ok(listed.every(entry => ['one.txt', 'three.txt', 'two.txt'].includes(entry.path)))
})

test('a path with a tab in its name keeps it, and the ignored-file check sees it', { skip: process.platform === 'win32' && 'no tabs in Windows file names' }, async t => {
  const { dir, file, sh } = await repository(t)
  const repo = await locate(run, dir)
  await writeFile(file('a\tb.txt'), 'old\n')
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await rm(file('a\tb.txt'))
  await writeFile(file('.gitignore'), 'secret.env\na?b.txt\n')
  await sh('commit', '-qam', 'ignore it')
  const after = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  const listed = await changes(run, repo, after.tree, before.tree)
  assert.deepEqual(listed.find(entry => entry.path.startsWith('a')), { path: 'a\tb.txt', status: 'A', added: 1, removed: 0 })

  await writeFile(file('a\tb.txt'), 'precious\n')
  const now = await treeOf(run, repo)
  await assert.rejects(move(run, repo, now.tree, before.tree), error => error instanceof MoveBlocked && error.paths.includes('a\tb.txt'))
  assert.equal(await readFile(file('a\tb.txt'), 'utf8'), 'precious\n')
})

test('a move whose list of added files comes back cut refuses, and touches nothing', async t => {
  const { dir, file } = await repository(t)
  const repo = await locate(run, dir)
  const before = await snapshot(run, repo, `${REF_ROOT}/s/1`, 'a')
  await writeFile(file('a.txt'), 'two\n')
  await writeFile(file('new.txt'), 'new\n')
  const after = await snapshot(run, repo, `${REF_ROOT}/s/2`, 'b')
  await rm(file('new.txt'))
  await writeFile(file('a.txt'), 'one\n')
  // Past 4 MiB the engine cuts the output: here, the listing the check is built from
  const cut = async (argv, init) => {
    const result = await run(argv, init)
    return argv.includes('--diff-filter=A') ? { ...result, isStdoutTruncated: true } : result
  }
  const now = await treeOf(cut, repo)
  await assert.rejects(move(cut, repo, now.tree, after.tree), error => error instanceof MoveBlocked && error.paths.length === 0)
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one\n')
  assert.equal(await exists(file('new.txt')), false)
  assert.ok(before.tree)
})
