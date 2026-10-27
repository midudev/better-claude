import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Change, EditorMessage, EditorProps, FileView, Opened, Snapshot, View } from '../types'
import { INK, baseName, headingAt, highlight, clip, isMarkdown, markLines } from './paint'

const PANE = 'worktree-diff'
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const MAX_DIFF = 90000
// Past this many characters the editor is not drawn (its props are bounded): "↗"
// edits the file outside.
const MAX_EDIT_CHARS = 80000
// Rows in the changed-files list; the rest are counted.
const MAX_LISTED = 400
// The quiet time after typing before an autosave writes the file.
const AUTOSAVE_MS = 800
// The pane's rows above the code: breadcrumb, status, a blank.
const HEADER_ROWS = 3

const shown = atom({ plugin: 'worktree-diff', key: 'shown' } as const, null as View | null)
const snapshot = atom({ plugin: 'worktree-diff', key: 'snapshot' } as const, {
  root: '',
  branch: '',
  changes: [],
  envFiles: [],
} as Snapshot)
const opened = atom({ plugin: 'worktree-diff', key: 'opened' } as const, null as Opened | null)
const reveal = atom({ plugin: 'worktree-diff', key: 'reveal' } as const, false)
const notice = atom({ plugin: 'worktree-diff', key: 'notice' } as const, '')
// The first line the code view shows: the pane scrolls its own window of lines.
const top = atom({ plugin: 'worktree-diff', key: 'top' } as const, 0)
// The wheel's travel over the editor, summed; the editor scrolls by its changes.
const wheel = atom({ plugin: 'worktree-diff', key: 'wheel' } as const, 0)
// Counts the reads of the open file, so the editor tells a new text from its own.
const version = atom({ plugin: 'worktree-diff', key: 'version' } as const, 0)
// Typed in the editor and not yet written.
const dirty = atom({ plugin: 'worktree-diff', key: 'dirty' } as const, false)
const autosave = atom({ plugin: 'worktree-diff', key: 'autosave' } as const, true)

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/
const isEnvFile = (name: string) => /^\.env(\..+)?$/.test(name) || name === '.dev.vars'

/** git status --porcelain=v1 -z: "XY path\0", a rename followed by "orig\0". */
const parseStatus = (raw: string): Change[] => {
  const parts = raw.split('\0')
  const changes: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry === undefined || entry.length < 4) continue
    const code = entry.slice(0, 2)
    changes.push({ path: entry.slice(3), code })
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return changes
}

const MAX_COUNTED = 50

/** git diff --numstat: "added\tremoved\tpath", "-\t-\tpath" for a binary file. */
const parseNumstat = (raw: string) => {
  const counts = new Map<string, { added?: number; removed?: number; isBinary?: boolean }>()
  for (const row of raw.split('\n')) {
    const [added, removed, path] = row.split('\t')
    if (added === undefined || removed === undefined || path === undefined) continue
    counts.set(
      path,
      added === '-' ? { isBinary: true } : { added: Number(added), removed: Number(removed) },
    )
  }
  return counts
}

const countLines = (text: string) =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const capDiff = (diff: string) => {
  if (diff.length <= MAX_DIFF) return diff
  const cut = diff.lastIndexOf('\n@@', MAX_DIFF)
  return cut > 0 ? diff.slice(0, cut + 1) : ''
}

const describe = (code: string) =>
  code === '??'
    ? 'new'
    : code.includes('D')
      ? 'deleted'
      : code.includes('R')
        ? 'renamed'
        : code.includes('A')
          ? 'added'
          : 'modified'

/** The status letter Cursor's Source Control list shows beside a file. */
const letter = (code: string) =>
  code === '??' ? 'U' : code === 'env' ? 'E' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : code.includes('A') ? 'A' : 'M'

const git = ($: EngineInterface, root: string, args: string[]) =>
  $.process.run(['git', ...args], { cwd: root, timeoutMs: 15000 })

const loadFile = async ($: EngineInterface, path: string, withDiff: boolean) => {
  const { root, changes } = await read($, snapshot)
  const text = await $.fs.read(`${root}/${path}`).catch(() => '')
  let diff = ''
  if (withDiff) {
    const change = changes.find(one => one.path === path)
    const args =
      change?.code === '??'
        ? ['diff', '--no-color', '--no-index', '--', '/dev/null', path]
        : ['diff', '--no-color', 'HEAD', '--', path]
    const ran = await git($, root, args).catch(() => undefined)
    diff = capDiff(ran?.stdout ?? '')
  }
  await update($, opened, () => ({ path, text: typeof text === 'string' ? text : '', diff }))
  await update($, version, count => count + 1)
}

/** Reads the worktree again: its changed files with their counts, and the env files at its root. */
const refresh = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top || top.exitCode !== 0) {
    await update($, snapshot, () => ({
      root: cwd,
      branch: '',
      changes: [],
      envFiles: [],
      error: 'This folder is not a git repository.',
    }))
    return
  }
  const root = top.stdout.trim()
  const [status, branch, entries, numstat] = await Promise.all([
    git($, root, ['status', '--porcelain=v1', '-z', '-uall']),
    git($, root, ['branch', '--show-current']),
    $.fs.list(root).catch(() => []),
    // Fails in a repository with no commit yet: every file then counts as new.
    git($, root, ['diff', '--numstat', '--no-renames', 'HEAD']).catch(() => undefined),
  ])
  const counts = parseNumstat(numstat?.exitCode === 0 ? numstat.stdout : '')
  const changes: Change[] = []
  let counted = 0
  for (const change of parseStatus(status.stdout)) {
    const known = counts.get(change.path)
    if (known) {
      changes.push({ ...change, ...known })
    } else if (change.code === '??' && counted < MAX_COUNTED) {
      counted++
      const text = await $.fs.read(`${root}/${change.path}`).catch(() => undefined)
      changes.push(
        typeof text === 'string' ? { ...change, added: countLines(text), removed: 0 } : change,
      )
    } else {
      changes.push(change)
    }
  }
  const envFiles = entries
    .filter(entry => entry.kind === 'file' && isEnvFile(entry.name))
    .map(entry => entry.name)
    .sort()
  await update($, snapshot, () => ({
    root,
    branch: branch.stdout.trim() || '(detached)',
    changes,
    envFiles,
  }))
  // The open file follows what Claude just changed in it.
  const current = await read($, shown)
  if (current && current.kind !== 'files') await loadFile($, current.path, current.kind !== 'env')
}

const go = async ($: EngineInterface, next: FileView) => {
  await flush($)
  const before = await read($, shown)
  await update($, notice, () => '')
  await loadFile($, next.path, next.kind !== 'env')
  if (before?.kind === 'files' || before?.path !== next.path) await update($, top, () => 0)
  await update($, shown, () => next)
}

// A chip in the band, a row of the list, or /worktree: shows the file in the pane,
// opening it. A file opens on its colored source; one with no text on its diff.
const openFile = async ($: EngineInterface, path: string) => {
  const change = (await read($, snapshot)).changes.find(one => one.path === path)
  const isEnv = isEnvFile(baseName(path)) && !change
  const isTextless = change !== undefined && (change.code.includes('D') || change.isBinary === true)
  await go($, { kind: isEnv ? 'env' : isTextless ? 'diff' : 'code', path })
  await $.ui.open({ id: PANE, title: baseName(path) })
}

const openList = async ($: EngineInterface) => {
  await flush($)
  await update($, notice, () => '')
  await update($, shown, () => ({ kind: 'files' }))
  await $.ui.open({ id: PANE, title: 'Changes' })
}

const save = async ($: EngineInterface, path: string, text: string) => {
  const { root } = await read($, snapshot)
  await $.fs.write(`${root}/${path}`, text)
  await update($, opened, file => (file && file.path === path ? { ...file, text } : file))
  await update($, notice, () => `Saved ${baseName(path)}`)
  void refresh($)
}

// What the editor holds that is not written yet, and the autosave waiting on it.
let pending: Omit<EditorMessage, 'type'> | undefined
let timer: { cancel: () => void } | undefined

const flush = async ($: EngineInterface) => {
  timer?.cancel()
  timer = undefined
  const held = pending
  pending = undefined
  if (held === undefined) return
  await update($, dirty, () => false)
  await save($, held.path, held.text)
}

const typed = async ($: EngineInterface, path: string, text: string) => {
  pending = { path, text }
  if (!(await read($, dirty))) await update($, dirty, () => true)
  timer?.cancel()
  timer = (await read($, autosave)) ? $.clock.after(AUTOSAVE_MS, () => void flush($)) : undefined
}

const setEnv = async ($: EngineInterface, path: string, key: string, value: string) => {
  const file = await read($, opened)
  if (!file) return
  const lines = file.text.split('\n')
  const at = lines.findIndex(row => ENV_LINE.exec(row)?.[2] === key)
  if (at >= 0) {
    const [, lead, name, eq] = ENV_LINE.exec(lines[at] ?? '')!
    lines[at] = `${lead}${name}${eq}${value}`
  } else {
    const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    lines.splice(end, 0, `${key}=${value}`)
  }
  await save($, path, lines.join('\n'))
}

const removeEnv = async ($: EngineInterface, path: string, key: string) => {
  const file = await read($, opened)
  if (!file) return
  const lines = file.text.split('\n').filter(row => ENV_LINE.exec(row)?.[2] !== key)
  await save($, path, lines.join('\n'))
}

const openExternal = async ($: EngineInterface, editor: string, path: string) => {
  const { root } = await read($, snapshot)
  const argv = [...editor.split(/\s+/), `${root}/${path}`]
  const ran = await $.process.run(argv, { cwd: root }).catch((err: Error) => ({
    exitCode: 1,
    stderr: err.message,
  }))
  await update($, notice, () =>
    ran.exitCode === 0 ? `Opened with: ${editor}` : `Could not open (${editor}): ${ran.stderr.trim()}`,
  )
}

const splitLines = (text: string) => {
  const lines = text.split('\n')
  // A final newline is no line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The changed files, then the env files at the root that are not among them. */
const listed = (snap: Snapshot): Change[] => [
  ...snap.changes,
  ...snap.envFiles
    .filter(name => !snap.changes.some(one => one.path === name))
    .map(name => ({ path: name, code: 'env' }) as Change),
]

const letterColor = (mark: string) =>
  mark === 'U' || mark === 'A'
    ? INK.added
    : mark === 'D'
      ? INK.deleted
      : mark === 'R'
        ? INK.modified
        : mark === 'E'
          ? INK.dim
          : INK.strong

export const register: Register = (on, options) => {
  const editor = String(options.editor ?? 'open').trim() || 'open'
  const background = String(options.background ?? '#0a0a0a').trim()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktree',
      description: "Opens the list of the worktree's changed files in a pane",
    })
    void refresh($)

    return started
  })

  on('command.run', { command: 'worktree' }, async $ => {
    await refresh($)
    const snap = await read($, snapshot)
    const all = listed(snap)
    if (all.length === 0) return { text: snap.error ?? 'No changed files in the worktree.' }
    if (all.length === 1) await openFile($, all[0]!.path)
    else await openList($)

    return { text: all.length === 1 ? `Opened ${all[0]!.path}.` : `${all.length} changed files.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (EDITING_TOOLS.has(e.tool)) void refresh($).catch(() => undefined)

    return ran
  })

  // Above the prompt, always one row: a summary that opens the list, then as many
  // files as fit, the rest counted.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    const all = listed(snap)
    if (all.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, shown)
    const below = await next(e)
    const added = all.reduce((sum, one) => sum + (one.added ?? 0), 0)
    const removed = all.reduce((sum, one) => sum + (one.removed ?? 0), 0)
    const summary = `⎇ ${all.length} ${all.length === 1 ? 'change' : 'changes'}`
    const stats = (one: { added?: number; removed?: number }) =>
      `${one.added ? ` +${one.added}` : ''}${one.removed ? ` -${one.removed}` : ''}`
    // What fits: each chip is "[name]" and its counts, a column between chips.
    let room = e.props.bodyColumns - summary.length - stats({ added, removed }).length - 12
    const chips: Change[] = []
    for (const one of all) {
      const width = baseName(one.path).length + 2 + stats(one).length + 1
      if (width > room) break
      chips.push(one)
      room -= width
    }
    const rest = all.length - chips.length

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" columnGap={1}>
          <Box key="summary-box">
            <Button key="all-files" plain onPress={() => openList($)}>
              <Text color={INK.text} inverse={current?.kind === 'files'} hover={{ inverse: true }}>
                {summary}
              </Text>
              {added > 0 && <Text color={INK.added}> +{added}</Text>}
              {removed > 0 && <Text color={INK.deleted}> -{removed}</Text>}
            </Button>
          </Box>
          <Text color={INK.dim}>│</Text>
          {chips.map(one => (
            <Box key={`chip-box:${one.path}`}>
              <Button key={`chip:${one.path}`} plain onPress={() => openFile($, one.path)}>
                <Text
                  color="claude"
                  inverse={current !== null && current.kind !== 'files' && current.path === one.path}
                  hover={{ inverse: true }}
                >
                  [{baseName(one.path)}]
                </Text>
                {one.added !== undefined && one.added > 0 && <Text color={INK.added}> +{one.added}</Text>}
                {one.removed !== undefined && one.removed > 0 && <Text color={INK.deleted}> -{one.removed}</Text>}
              </Button>
            </Box>
          ))}
          {rest > 0 && <Button key="more-files" label={`+${rest} more`} plain dimColor onPress={() => openList($)} />}
        </Box>
      </Box>
    )
  })

  // The code view draws only the lines in view, so the pane moves its own window:
  // a file of any length stays a few hundred elements.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const current = await read($, shown)
    const file = await read($, opened)
    if (!file || current?.kind === 'files' || current?.path !== file.path) return next(e)
    if (current.kind === 'edit') {
      await update($, wheel, at => at + e.by)
      return {}
    }
    if (current.kind !== 'code') return next(e)
    const room = Math.max(1, e.bodyRows - HEADER_ROWS)
    const last = Math.max(0, splitLines(file.text).length - room)
    await update($, top, at => Math.min(last, Math.max(0, at + e.by)))

    return {}
  })

  // The editor posts what is typed: saved after a pause under autosave, at once
  // with ctrl+s.
  on('ui.message', { element: 'editor' }, async ($, e) => {
    const data = e.data as EditorMessage
    if (data.type === 'save') {
      pending = { path: data.path, text: data.text }
      await flush($)
    } else {
      await typed($, data.path, data.text)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = table
    // The mobile app draws no text field: editing there goes through "↗".
    const Input = 'Input' in table ? table.Input : undefined
    // Only the terminal runs a surface module, which the editor is.
    const Client = 'Client' in table ? table.Client : undefined
    const snap = await read($, snapshot)
    const current = await read($, shown)
    const file = await read($, opened)
    const message = await read($, notice)
    const isDock = e.props.placement === 'dock'
    const bodyRows = e.props.scroll.bodyRows

    // A darker body than the terminal's; docked, it fills the pane's height.
    const frame = (children: RenderChildren) => (
      <Box
        flexDirection="column"
        paddingX={1}
        backgroundColor={background === '' ? undefined : background}
        minHeight={isDock ? bodyRows : undefined}
      >
        {children}
      </Box>
    )
    const close = <Button key="close" label=" ✕ " plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />

    // Like Cursor's Source Control: one row a file, its name, its folder dim, its
    // counts and status letter at the right.
    if (current?.kind === 'files') {
      const all = listed(snap)
      const added = all.reduce((sum, one) => sum + (one.added ?? 0), 0)
      const removed = all.reduce((sum, one) => sum + (one.removed ?? 0), 0)
      const sorted = [...all].sort((a, b) => a.path.localeCompare(b.path))
      return frame(
        <>
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={INK.text} bold>
                Changes
              </Text>
              <Text color={INK.dim}>{`  ${all.length} ${all.length === 1 ? 'file' : 'files'}`}</Text>
              {added > 0 && <Text color={INK.added}> +{added}</Text>}
              {removed > 0 && <Text color={INK.deleted}> −{removed}</Text>}
            </Text>
            {close}
          </Box>
          <Box marginBottom={1}>
            <Text color={INK.dim} wrap="truncate-end">
              ⎇ {snap.branch || 'worktree'}
            </Text>
          </Box>
          {all.length === 0 && <Text color={INK.dim}>{snap.error ?? 'No changed files.'}</Text>}
          {sorted.slice(0, MAX_LISTED).map(one => {
            const mark = letter(one.code)
            const folder = one.path.includes('/') ? one.path.slice(0, one.path.lastIndexOf('/')) : ''
            return (
              <Box key={`file-row:${one.path}`} flexDirection="row" justifyContent="space-between" columnGap={2} hover={{ backgroundColor: INK.lineHover }}>
                <Box flexShrink={1}>
                  <Button key={`file:${one.path}`} plain onPress={() => openFile($, one.path)}>
                    <Text wrap="truncate-end">
                      <Text color={INK.text}>{baseName(one.path)}</Text>
                      {folder !== '' && <Text color={INK.dim}>{`  ${folder}`}</Text>}
                    </Text>
                  </Button>
                </Box>
                <Box flexShrink={0}>
                  <Text>
                    {one.added !== undefined && one.added > 0 && <Text color={INK.added}>+{one.added} </Text>}
                    {one.removed !== undefined && one.removed > 0 && <Text color={INK.deleted}>−{one.removed} </Text>}
                    <Text color={letterColor(mark)}>{mark}</Text>
                  </Text>
                </Box>
              </Box>
            )
          })}
          {sorted.length > MAX_LISTED && <Text color={INK.dim}>and {sorted.length - MAX_LISTED} more</Text>}
        </>,
      )
    }

    if (!current || !file || file.path !== current.path) {
      return frame(<Text color={INK.dim}>Pick a changed file in the row above the prompt.</Text>)
    }

    const change = snap.changes.find(one => one.path === file.path)
    const lines = splitLines(file.text)
    const first = Math.min(await read($, top), Math.max(0, lines.length - 1))
    const isEnv = isEnvFile(baseName(file.path))
    const isDirty = await read($, dirty)
    const isAutosave = await read($, autosave)

    // Like Cursor's editor: a breadcrumb on the left, the views on the right.
    const segments = file.path.split('/')
    const heading = isMarkdown(file.path) ? headingAt(lines, first) : undefined
    const views: [FileView['kind'], string][] = [
      ...(isMarkdown(file.path)
        ? ([
            ['preview', 'Preview'],
            ['code', 'Markdown'],
          ] as [FileView['kind'], string][])
        : ([['code', 'Code']] as [FileView['kind'], string][])),
      ['edit', 'Edit'],
      ...(change ? ([['diff', 'Changes']] as [FileView['kind'], string][]) : []),
      ...(isEnv ? ([['env', 'Variables']] as [FileView['kind'], string][]) : []),
    ]
    const tab = (kind: FileView['kind'], text: string) =>
      current.kind === kind ? (
        <Text key={`tab-on:${kind}`} color={INK.text} backgroundColor={INK.tabOn}>
          {` ${text} `}
        </Text>
      ) : (
        <Button key={`to-${kind}`} label={` ${text} `} plain dimColor onPress={() => go($, { kind, path: file.path })} />
      )
    const state =
      current.kind !== 'edit'
        ? message
        : isDirty
          ? isAutosave
            ? 'saving…'
            : '● unsaved'
          : message !== ''
            ? `✓ ${message}`
            : ''

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box flexShrink={1}>
            <Button key="to-files" label="‹ " plain dimColor onPress={() => openList($)} />
            <Text wrap="truncate-middle">
              {segments.slice(0, -1).map(part => (
                <Text color={INK.dim}>{part} › </Text>
              ))}
              <Text color={INK.text}>{segments[segments.length - 1]}</Text>
              {isDirty && <Text color={INK.text}> ●</Text>}
              {heading !== undefined && <Text color={INK.dim}> › {heading}</Text>}
            </Text>
          </Box>
          <Box flexShrink={0} columnGap={1}>
            {views.map(([kind, text]) => tab(kind, text))}
            <Button key="external" label=" ↗ " plain dimColor onPress={() => openExternal($, editor, file.path)} />
            {close}
          </Box>
        </Box>
        <Text wrap="truncate-end">
          <Text color={INK.dim}>⎇ {snap.branch || 'worktree'}</Text>
          {change && <Text color={INK.dim}>{`  ·  ${describe(change.code)}`}</Text>}
          {change?.added !== undefined && change.added > 0 && <Text color={INK.added}> +{change.added}</Text>}
          {change?.removed !== undefined && change.removed > 0 && <Text color={INK.deleted}> −{change.removed}</Text>}
          {current.kind === 'code' && lines.length > bodyRows - HEADER_ROWS && (
            <Text color={INK.dim}>{`  ·  ${first + 1}–${Math.min(lines.length, first + bodyRows - HEADER_ROWS)} of ${lines.length}`}</Text>
          )}
          {state !== '' && (
            <Text color={state.startsWith('Could not') ? INK.deleted : state.startsWith('●') ? INK.strong : INK.added}>{`  ·  ${state}`}</Text>
          )}
        </Text>
      </Box>
    )

    if (current.kind === 'diff') {
      return frame(
        <>
          {header}
          {file.diff === '' ? (
            <Text color={INK.dim}>No diff to show (binary, too large or unchanged).</Text>
          ) : (
            <Code format="diff" source={file.diff} path={file.path} />
          )}
        </>,
      )
    }

    if (current.kind === 'preview') {
      return frame(
        <>
          {header}
          <Markdown text={file.text} />
        </>,
      )
    }

    // A real field over the whole file: typing, arrows, newlines; saved as it goes.
    if (current.kind === 'edit') {
      if (Client === undefined || file.text.length > MAX_EDIT_CHARS) {
        return frame(
          <>
            {header}
            <Text color={INK.dim}>
              {Client === undefined
                ? 'This surface does not draw the editor; use ↗ to edit the file outside.'
                : 'The file is too large to edit here; use ↗ to edit it outside.'}
            </Text>
          </>,
        )
      }
      const props: EditorProps = {
        path: file.path,
        text: file.text,
        version: await read($, version),
        marks: [...markLines(file.diff).entries()],
        wheel: await read($, wheel),
        autosave: isAutosave,
      }
      return frame(
        <>
          {header}
          <Client
            key="editor"
            module="./editor.tsx"
            props={props}
            width="100%"
            height={Math.max(6, bodyRows - HEADER_ROWS - 1)}
          />
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="autosave"
              label={isAutosave ? '◉ Autosave' : '○ Autosave'}
              plain
              dimColor={!isAutosave}
              onPress={async () => {
                await update($, autosave, isOn => !isOn)
                if (!isAutosave) await flush($)
              }}
            />
            {!isAutosave && <Button key="save" label="Save" plain onPress={() => flush($)} />}
            <Text color={INK.dim}>Click the text to type · Esc gives the keyboard back to the prompt</Text>
          </Box>
        </>,
      )
    }

    if (current.kind === 'code') {
      const marks = markLines(file.diff)
      const room = Math.max(1, bodyRows - HEADER_ROWS)
      const shownLines = lines.slice(first, first + room)
      // Highlighting reads from the top, so a fence or comment opened above holds.
      const painted = highlight(lines.slice(0, first + room), file.path).slice(first)
      const width = String(lines.length).length
      // The columns left for the code: the frame's padding and the gutter taken.
      const columns = Math.max(10, e.props.bodyColumns - 2 - (width + 3))
      return frame(
        <>
          {header}
          {shownLines.map((text, offset) => {
            const index = first + offset
            const mark = marks.get(index + 1)
            return (
              <Box key={`row:${index}`} flexDirection="row" hover={{ backgroundColor: INK.lineHover }}>
                <Box flexShrink={0}>
                  <Text color={INK.gutter}>
                    {String(index + 1).padStart(width)}
                    <Text color={mark ? INK[mark] : INK.gutter}>{mark === 'deleted' ? ' ▸ ' : mark ? ' ▎ ' : '   '}</Text>
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Button key={`edit-line:${index}`} plain onPress={() => go($, { kind: 'edit', path: file.path })}>
                    <Text color={INK.text} wrap="truncate-end">
                      {clip(painted[offset] ?? [], columns).map(span => (
                        <Text color={span.color} bold={span.bold} italic={span.italic}>
                          {span.text}
                        </Text>
                      ))}
                      {text === '' ? ' ' : ''}
                    </Text>
                  </Button>
                </Box>
              </Box>
            )
          })}
        </>,
      )
    }

    const isRevealed = await read($, reveal)
    const vars = file.text
      .split('\n')
      .map(row => ENV_LINE.exec(row))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ key: match[2] ?? '', value: match[4] ?? '' }))

    return frame(
      <>
        {header}
        <Button
          key="reveal"
          label={isRevealed ? 'Hide values' : 'Show values'}
          plain
          onPress={() => update($, reveal, isOn => !isOn)}
        />
        {vars.length === 0 && <Text color={INK.dim}>No variables yet.</Text>}
        {vars.map(one =>
          isRevealed && Input !== undefined ? (
            <Box key={`row:${one.key}`}>
              <Input
                key={`var:${one.key}`}
                label={`${one.key}=`}
                value={one.value}
                submitLabel="save"
                onSubmit={(value: string) => setEnv($, file.path, one.key, value)}
              />
              <Button key={`del:${one.key}`} label="✕" plain onPress={() => removeEnv($, file.path, one.key)} />
            </Box>
          ) : (
            <Text key={`masked:${one.key}`}>
              <Text color={INK.keyword}>{one.key}</Text>
              <Text color={INK.dim}>={one.value === '' ? '(empty)' : '••••••'}</Text>
            </Text>
          ),
        )}
        {Input !== undefined && (
          <Box marginTop={1}>
            <Input
              key="new-var"
              label="New: "
              placeholder="KEY=value"
              submitLabel="add"
              onSubmit={(value: string) => {
                const at = value.indexOf('=')
                const key = (at > 0 ? value.slice(0, at) : value).trim()
                if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
                  return update($, notice, () => 'Format: KEY=value')
                }
                return setEnv($, file.path, key, at > 0 ? value.slice(at + 1) : '')
              }}
            />
          </Box>
        )}
      </>,
    )
  })
}
