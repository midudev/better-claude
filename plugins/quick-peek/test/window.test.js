// The Windows window, run for real where it can be: PowerShell compiles it, and it lays out a file,
// a file of code, a folder and a PDF without showing them (QUICK_PEEK_DRY), and says how large it
// would be. Elsewhere these are skipped. `npm run test:node`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WINDOWS, WINDOWS_TYPES } from '../hooks/window.ts'

const skip = process.platform !== 'win32' && 'the window is Windows\''
const folder = mkdtempSync(join(tmpdir(), 'quick-peek-'))
// What the program says when it lays a window out: its size, at 96 DPI, and its rows of text.
const DRY = /^dry (\d+)x(\d+) (\d+) rows$/m

/** The program as the mod runs it, told `env`, laying out instead of showing. */
function run (env) {
  const argv = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS, 'utf16le').toString('base64')]
  const started = performance.now()
  const result = spawnSync('powershell', argv, { env: { ...process.env, QUICK_PEEK_TYPES: WINDOWS_TYPES, QUICK_PEEK_DRY: '1', ...env }, encoding: 'utf8', timeout: 120_000 })
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

test('compiles the window and lays out a file: its picture, name, details and folder, and the hint', { skip }, t => {
  const file = join(folder, 'data.bin')
  writeFileSync(file, 'x'.repeat(2048))
  const { said, status, ms } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_HINT: 'click: show in Explorer' })
  t.diagnostic(`first run, compiling: ${ms} ms`)
  assert.equal(status, 0, said)
  assert.match(said, DRY)
  assert.equal(said.match(DRY)[3], '4')
  // Compiled once: the next run loads it.
  t.diagnostic(`next run, compiled: ${run({ QUICK_PEEK_FILE: file }).ms} ms`)
})

test('lays out a file of code: its lines on a plate at least as wide as the text under it', { skip }, () => {
  const file = join(folder, 'app.ts')
  writeFileSync(file, 'const a = 1\n\n// b\n')
  const code = { language: 'TypeScript', count: 3, first: 1, mark: 2, lines: [[['k', 'const'], ['', ' a = 1']], [], [['c', '// b']]] }
  const { said, status } = run({ QUICK_PEEK_FILE: file, QUICK_PEEK_CODE: JSON.stringify(code) })
  assert.equal(status, 0, said)
  const [, width, , rows] = said.match(DRY).map(Number)
  assert.ok(width >= 280 + 24, said)
  assert.equal(rows, 3)
})

test('lays out a folder: its entries under its name, the hidden ones left out', { skip }, () => {
  const inside = join(folder, 'folder')
  mkdirSync(join(inside, 'sub'), { recursive: true })
  for (const name of ['a.txt', 'b.txt', '.hidden']) writeFileSync(join(inside, name), name)
  const { said, status } = run({ QUICK_PEEK_FILE: inside })
  assert.equal(status, 0, said)
  // The name, the details, three entries, the folder it is in.
  assert.equal(said.match(DRY)[3], '6')
})

test('renders a PDF\'s first page: a portrait page makes a window taller than wide', { skip }, () => {
  const file = join(folder, 'page.pdf')
  writeFileSync(file, pdf())
  const { said, status } = run({ QUICK_PEEK_FILE: file })
  assert.equal(status, 0, said)
  const [, width, height] = said.match(DRY).map(Number)
  assert.ok(height > width, said)
})

test('says a path that is not there', { skip }, () => {
  const { said, status } = run({ QUICK_PEEK_FILE: join(folder, 'missing.txt') })
  assert.equal(status, 0)
  assert.match(said, /^error: not there$/m)
})
