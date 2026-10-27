// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'worktree-diff',
  component: 'Pane',
  requestId: 'worktree-diff',
  props: {
    title: 'Worktree',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'worktree-diff',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('lists changed files above the prompt and opens one only when picked', async ($, on) => {
  const written: Record<string, string> = {}
  const opens: string[] = []
  const files: Record<string, string> = {
    '/repo/src/app.ts': 'const a = 1\nconst b = 2\n',
    '/repo/notes.md': 'uno\ndos\n',
    '/repo/.env': 'API_URL=http://localhost\nSECRET=abc\n',
  }

  // The engine's own band, beneath the plugin's chips.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('command.register', () => ({ value: { command: 'worktree' } }))
  on('ui.open', (_, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('rev-parse')
      ? '/repo\n'
      : args.includes('branch')
        ? 'feature-x\n'
        : args.includes('numstat')
          ? '1\t1\tsrc/app.ts\n'
          : args.includes('status')
            ? ' M src/app.ts\0?? notes.md\0'
            : args.includes('diff')
              ? '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 0\n+const a = 1\n const b = 2\n'
              : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', () => ({
    value: [
      { name: '.env', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    files[e.path] = e.text
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // Nothing opens by itself.
  expect(opens).toEqual([])

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'chip:src/app.ts' })).toBeDefined()
  expect(await band.find({ key: 'chip:notes.md' })).toBeDefined()
  expect(await band.find({ key: 'chip:.env' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^ \+2$/ })).toBeDefined()
  await band.press({ key: 'chip:src/app.ts' })
  expect(opens).toEqual(['worktree-diff'])
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /feature-x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /·\s+modified$/ })).toBeDefined()
  expect(await ui.find({ key: 'to-diff' })).toBeDefined()

  // It opens on its colored source; Edit is the editor, a surface module:
  // the keys it takes change its buffer, ctrl+s posts a save.
  expect(await ui.find({ key: 'edit-line:0' })).toBeDefined()
  await ui.press({ key: 'to-edit' })
  await ui.resize({ columns: 60, rows: 20, in: 'editor' })
  await ui.key({ key: 'down', in: 'editor' })
  await ui.key({ key: 'end', in: 'editor' })
  await ui.key({ key: 'backspace', in: 'editor' })
  await ui.key({ key: '3', in: 'editor' })
  await ui.key({ key: 's', ctrl: true, in: 'editor' })
  expect(written['/repo/src/app.ts']).toBe('const a = 1\nconst b = 3\n')
  await ui.unmount()

  // The summary opens every changed file as a list.
  const band3 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band3.press({ key: 'all-files' })
  await band3.unmount()
  const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await list.find({ key: 'file:src/app.ts' })).toBeDefined()
  await list.press({ key: 'file:notes.md' })
  await list.unmount()

  // A markdown file offers its preview beside its source.
  const md = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await md.find({ key: 'edit-line:0' })).toBeDefined()
  await md.press({ key: 'to-preview' })
  expect(await md.find({ key: 'edit-line:0' })).toBeUndefined()
  await md.unmount()

  // A .env with no change opens on its variables.
  const band2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band2.press({ key: 'chip:.env' })
  await band2.unmount()
  const env = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await env.find({ type: 'Text', text: /SECRET=••••••/ })).toBeDefined()
  await env.press({ key: 'reveal' })
  await env.input({ key: 'var:SECRET', text: 'xyz' })
  expect(written['/repo/.env']).toBe('API_URL=http://localhost\nSECRET=xyz\n')
  await env.input({ key: 'new-var', text: 'DEBUG=1' })
  expect(written['/repo/.env']).toBe('API_URL=http://localhost\nSECRET=xyz\nDEBUG=1\n')
  await env.unmount()
})
