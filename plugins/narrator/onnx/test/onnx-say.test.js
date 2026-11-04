import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../onnx-say', import.meta.url))

// A Python and the players as small scripts that write down how they were called: the Python
// writes the WAV it is asked for unless FAKE_PYTHON_FAILS is set.
const PYTHON = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG/python"
[ -z "$FAKE_PYTHON_FAILS" ] || exit 3
printf 'RIFF' > "$4"
echo "$4" > "$FAKE_LOG/wav"
`
const PLAYER = `#!/bin/sh
echo "$(basename "$0") $*" > "$FAKE_LOG/player"
`

describe('onnx-say', { skip: process.platform === 'win32' && 'a POSIX shell script' }, () => {
  let dir, bin, log

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onnx-say-test-'))
    bin = join(dir, 'bin')
    log = join(dir, 'log')
    for (const path of [bin, log, join(dir, 'tmp')]) spawnSync('mkdir', ['-p', path])
    writeFileSync(join(dir, 'python'), PYTHON)
    chmodSync(join(dir, 'python'), 0o755)
    for (const player of ['afplay', 'pw-play', 'paplay', 'aplay', 'ffplay']) {
      writeFileSync(join(bin, player), PLAYER)
      chmodSync(join(bin, player), 0o755)
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const say = (args, env = {}) => spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: join(dir, 'home'),
      TMPDIR: join(dir, 'tmp'),
      NARRATOR_ONNX_PYTHON: join(dir, 'python'),
      FAKE_LOG: log,
      NARRATOR_LANG: 'fr',
      NARRATOR_SPEED: '1.3',
      ...env
    }
  })
  const pythonArgs = () => readFileSync(join(log, 'python'), 'utf8').trimEnd().split('\n')
  const played = () => existsSync(join(log, 'player')) ? readFileSync(join(log, 'player'), 'utf8').trim() : null

  test('says the narration with the folder for its language, at its speed, and plays it', () => {
    const result = say(['en=/models/kokoro', 'fr=/models/piper-fr', 'Les tests passent.'])
    assert.equal(result.status, 0, result.stderr)
    const args = pythonArgs()
    assert.deepEqual(args.slice(0, 1), ['-I'])
    assert.deepEqual(args.slice(2), ['/models/piper-fr', readFileSync(join(log, 'wav'), 'utf8').trim(), 'Les tests passent.', '--lang', 'fr', '--speed', '1.3'])
    assert.match(args[1], /speak\.py$/)
    assert.match(played(), /^(afplay|pw-play|paplay|aplay|ffplay) .*narration\.wav$/)
  })

  test('takes the folder with no language when none is for the narration\'s', () => {
    const result = say(['en=/models/kokoro', '/models/any', 'Hola.'], { NARRATOR_LANG: 'es-MX' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(pythonArgs()[2], '/models/any')
    assert.deepEqual(pythonArgs().slice(5, 7), ['--lang', 'es'])
  })

  test('passes the speaker after # and opens ~/ in the user\'s home', () => {
    const result = say(['fr=~/models/kokoro#30', 'Bonjour.'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(pythonArgs()[2], join(dir, 'home', 'models/kokoro'))
    assert.deepEqual(pythonArgs().slice(-2), ['--speaker', '30'])
  })

  test('fails with no folder for the language, so the narrator\'s own voice speaks', () => {
    const result = say(['en=/models/kokoro', 'Bonjour.'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no model for fr/)
    assert.equal(existsSync(join(log, 'python')), false)
    assert.equal(played(), null)
  })

  test('fails when the model cannot say it, plays nothing and leaves no temp folder', () => {
    const result = say(['/models/any', 'Bonjour.'], { FAKE_PYTHON_FAILS: '1' })
    assert.equal(result.status, 1)
    assert.equal(played(), null)
    assert.deepEqual(readdirSync(join(dir, 'tmp')), [])
  })

  test('leaves no temp folder after playing', () => {
    assert.equal(say(['/models/any', 'Bonjour.']).status, 0)
    assert.deepEqual(readdirSync(join(dir, 'tmp')), [])
  })

  test('without a narration it says how to call it', () => {
    const result = say(['/models/any'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: onnx-say/)
  })
})
