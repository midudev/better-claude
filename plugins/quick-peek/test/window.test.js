// The Windows window, run for real where it can be: PowerShell compiles it into an exe, and it lays
// out a file, a file of code, a folder and a PDF without showing them (QUICK_PEEK_DRY), and says how
// large it would be; the exe does too, started on its own. They write in a temp folder made for them,
// where the exe is compiled before them, and removed after. Elsewhere they are skipped, folder and all.
// `npm run test:node`
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { excerptOf, languageOf } from '../hooks/code.ts'
import { WINDOWS, WINDOWS_BUILD, WINDOWS_TYPES } from '../hooks/window.ts'

const skip = process.platform !== 'win32' && 'the window is Windows\''
// The folder the tests write in, and the exe compiled there before them: made by the suite.
let folder
let assembly
// PowerShell by its full path, as the mod starts it.
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
// What the program says when it lays a window out: its size, at 96 DPI, and its rows of text.
const DRY = /^dry (\d+)x(\d+) (\d+) rows$/m

/** The program as the mod runs it, told `env`, laying out instead of showing: through PowerShell, or the exe itself. */
function run (env, { isDirect = false } = {}) {
  const argv = isDirect ? [assembly] : [POWERSHELL, '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS, 'utf16le').toString('base64')]
  const started = performance.now()
  const result = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, QUICK_PEEK_ASSEMBLY: assembly, QUICK_PEEK_TYPES: WINDOWS_TYPES, QUICK_PEEK_DRY: '1', ...env }, encoding: 'utf8', timeout: 120_000 })
  return { said: result.stdout, status: result.status, ms: Math.round(performance.now() - started) }
}

/** A one-page PDF, portrait (612 by 792 points), a title on it. */
function pdf () {
  const text = 'BT /F1 28 Tf 72 720 Td (Quick Peek) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${object}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

describe('the Windows window', { skip }, () => {
  before(() => {
    folder = mkdtempSync(join(tmpdir(), 'quick-peek-'))
    assembly = join(folder, WINDOWS_BUILD)
    // The exe that the tests starting it on their own need, whichever of them runs.
    const file = join(folder, 'compile.bin')
    writeFileSync(file, 'x')
    const { said, status } = run({ QUICK_PEEK_FILE: file })
    assert.equal(status, 0, `the window did not compile: ${said}`)
  })

  // An exe that just ended may be held a moment.
  after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

  test('compiles the window and lays out a file: its picture, name, details and folder, and the hint', t => {
    const file = join(folder, 'data.bin')
    writeFileSync(file, 'x'.repeat(2048))
    // Compiled anew, in a folder of its own, to time it.
    const fresh = join(folder, 'fresh', WINDOWS_BUILD)
    const { said, status, ms } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_HINT: 'click: show in Explorer', QUICK_PEEK_ASSEMBLY: fresh })
    t.diagnostic(`first run, compiling: ${ms} ms`)
    assert.equal(status, 0, said)
    assert.match(said, DRY)
    assert.equal(said.match(DRY)[3], '4')
    // Compiled once: the next run loads it.
    t.diagnostic(`next run, compiled: ${run({ QUICK_PEEK_FILE: file, QUICK_PEEK_ASSEMBLY: fresh }).ms} ms`)
    // The exe on its own, as later hovers start it: the same window.
    const direct = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_HINT: 'click: show in Explorer' }, { isDirect: true })
    t.diagnostic(`the exe on its own: ${direct.ms} ms`)
    assert.equal(direct.status, 0, direct.said)
    assert.equal(direct.said.match(DRY)?.[0], said.match(DRY)[0])
  })

  test('the exe on its own says a path that is not there', () => {
    const { said, status } = run({ QUICK_PEEK_FILE: join(folder, 'missing.txt') }, { isDirect: true })
    assert.equal(status, 0)
    assert.match(said, /^skip: not there\r?$/m)
  })

  test('lays out a file of code: its lines on a plate at least as wide as the text under it', () => {
    const file = join(folder, 'app.ts')
    writeFileSync(file, 'const a = 1\n\n// b\n')
    const code = { language: 'TypeScript', count: 3, first: 1, mark: 2, lines: [[['k', 'const'], ['', ' a = 1']], [], [['c', '// b']]] }
    const { said, status } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_CODE: JSON.stringify(code) })
    assert.equal(status, 0, said)
    const [, width, , rows] = said.match(DRY).map(Number)
    assert.ok(width >= 280 + 24, said)
    assert.equal(rows, 3)
  })

  test('lays out a folder: its entries under its name, the hidden ones left out', () => {
    const inside = join(folder, 'folder')
    mkdirSync(join(inside, 'sub'), { recursive: true })
    for (const name of ['a.txt', 'b.txt', '.hidden']) writeFileSync(join(inside, name), name)
    const { said, status } = run({ QUICK_PEEK_FILE: inside })
    assert.equal(status, 0, said)
    // The name, the details, three entries, the folder it is in.
    assert.equal(said.match(DRY)[3], '6')
  })

  test('lists a folder that holds a file named nul, a name Windows reserves: its entries and count all the same', () => {
    const inside = join(folder, 'reserved')
    mkdirSync(join(inside, 'sub'), { recursive: true })
    writeFileSync(join(inside, 'a.txt'), 'a')
    // A Unix shell makes one with `> nul`; only the long form of its path names it.
    writeFileSync(`\\\\?\\${join(inside, 'nul')}`, 'x')
    const { said, status } = run({ QUICK_PEEK_FILE: inside })
    assert.equal(status, 0, said)
    // The name, the details, three entries (a.txt, nul, sub), the folder it is in.
    assert.equal(said.match(DRY)[3], '6')
  })

  test('renders a PDF\'s first page: a portrait page makes a window taller than wide', () => {
    const file = join(folder, 'page.pdf')
    writeFileSync(file, pdf())
    const { said, status } = run({ QUICK_PEEK_FILE: file })
    assert.equal(status, 0, said)
    const [, width, height] = said.match(DRY).map(Number)
    assert.ok(height > width, said)
  })

  test('the exe on its own skips a path too long for it: that path, not the system', () => {
    const { said, status } = run({ QUICK_PEEK_FILE: join(folder, 'a'.repeat(300), 'b.txt') }, { isDirect: true })
    assert.equal(status, 0, said)
    assert.match(said, /^skip: /m)
  })

  test('told no exe to keep, compiles the window in memory and lays out a file', () => {
    const file = join(folder, 'memory.bin')
    writeFileSync(file, 'x'.repeat(2048))
    const { said, status } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_ASSEMBLY: undefined })
    assert.equal(status, 0, said)
    assert.match(said, DRY)
  })

  test('compiles the window where its environment would pass the 64 KB .NET starts a program with: many tokens\' lines, a long PATH', () => {
    // A file of JSON whose lines are `0,1,2,…`: 12 of them, as many as the mod tells, some 27,000 characters.
    const text = Array.from({ length: 30 }, () => Array.from({ length: 120 }, (_, i) => i % 10).join(',')).join('\n')
    const file = join(folder, 'numbers.json')
    writeFileSync(file, text)
    const { source, ...shown } = excerptOf(text, languageOf(file), 10, 12)
    // Compiled anew, in a folder of its own that is not there yet.
    const { said, status } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_CODE: JSON.stringify(shown), QUICK_PEEK_ASSEMBLY: join(folder, 'large', WINDOWS_BUILD), LONG_PATH: 'x'.repeat(15_000) })
    assert.equal(status, 0, said)
    assert.match(said, DRY)
  })

  test('a PDF whose page does not come in time shows the window all the same, without it', t => {
    const file = join(folder, 'slow.pdf')
    writeFileSync(file, pdf())
    const { said, status, ms } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_PDF_MS: '1' })
    t.diagnostic(`given 1 ms: ${ms} ms, ${said.match(DRY)?.[0]}`)
    assert.equal(status, 0, said)
    assert.match(said, DRY)
  })

  test('compiling the window anew removes the exes of older sources, not one another preview is compiling', () => {
    const kept = join(folder, 'kept')
    mkdirSync(kept)
    const older = join(kept, 'quick-peek-window-00000000.exe')
    const building = join(kept, 'quick-peek-window-00000000-4242.exe')
    const other = join(kept, 'notes.txt')
    for (const file of [older, building, other]) writeFileSync(file, '')
    const file = join(folder, 'kept.bin')
    writeFileSync(file, 'x'.repeat(64))
    const { said, status } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_ASSEMBLY: join(kept, WINDOWS_BUILD) })
    assert.equal(status, 0, said)
    assert.deepEqual(readdirSync(kept).sort(), [WINDOWS_BUILD, 'notes.txt', 'quick-peek-window-00000000-4242.exe'].sort())
  })

  test('says a path that is not there', () => {
    const { said, status } = run({ QUICK_PEEK_FILE: join(folder, 'missing.txt') })
    assert.equal(status, 0)
    assert.match(said, /^skip: not there$/m)
  })
})
