import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { EditorMessage, EditorProps } from '../types'
import { INK, type Span, clip, highlight } from './paint'

// The editor: a buffer with a cursor, drawn like Warp's inline editor. A click
// gives it the keyboard; Escape hands it back. Every edit is posted to the hooks
// module, which saves it (at once with ctrl+s, after a pause under autosave).

type State = {
  lines: string[]
  row: number
  col: number
  top: number
  left: number
  // Which `version` of the file the buffer came from; a newer one on disk
  // replaces an unedited buffer.
  version: number
  // The text last posted or loaded: the buffer differs from it while unsaved.
  saved: string
  wheel: number
  isFocused: boolean
}

const TAB = '  '
const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])

const splitText = (text: string) => {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const fresh = (props: EditorProps, prior?: State): State => ({
  lines: splitText(props.text),
  row: 0,
  col: 0,
  top: 0,
  left: 0,
  version: props.version,
  saved: props.text,
  wheel: prior?.wheel ?? props.wheel,
  isFocused: prior?.isFocused ?? false,
})

const joined = (lines: string[]) => `${lines.join('\n')}\n`

const chars = (text: string) => [...text]

// Keeps the cursor on a line of the buffer and inside its text.
const clampCursor = (s: State) => {
  s.row = Math.max(0, Math.min(s.lines.length - 1, s.row))
  s.col = Math.max(0, Math.min(chars(s.lines[s.row] ?? '').length, s.col))
}

// Moves the window so the cursor is in view.
const follow = (s: State, rows: number, columns: number) => {
  if (s.row < s.top) s.top = s.row
  if (s.row >= s.top + rows) s.top = s.row - rows + 1
  if (s.col < s.left) s.left = s.col
  if (s.col >= s.left + columns) s.left = s.col - columns + 1
  s.top = Math.max(0, s.top)
  s.left = Math.max(0, s.left)
}

const insert = (s: State, text: string) => {
  const line = s.lines[s.row] ?? ''
  const head = chars(line).slice(0, s.col).join('')
  const tail = chars(line).slice(s.col).join('')
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  if (parts.length === 1) {
    s.lines[s.row] = head + text + tail
    s.col += chars(text).length
    return
  }
  const last = parts[parts.length - 1] ?? ''
  s.lines.splice(s.row, 1, head + (parts[0] ?? ''), ...parts.slice(1, -1), last + tail)
  s.row += parts.length - 1
  s.col = chars(last).length
}

const backspace = (s: State) => {
  const line = s.lines[s.row] ?? ''
  if (s.col > 0) {
    const all = chars(line)
    s.lines[s.row] = [...all.slice(0, s.col - 1), ...all.slice(s.col)].join('')
    s.col--
  } else if (s.row > 0) {
    const above = s.lines[s.row - 1] ?? ''
    s.lines.splice(s.row - 1, 2, above + line)
    s.row--
    s.col = chars(above).length
  }
}

const del = (s: State) => {
  const line = s.lines[s.row] ?? ''
  const all = chars(line)
  if (s.col < all.length) {
    s.lines[s.row] = [...all.slice(0, s.col), ...all.slice(s.col + 1)].join('')
  } else if (s.row < s.lines.length - 1) {
    s.lines.splice(s.row, 2, line + (s.lines[s.row + 1] ?? ''))
  }
}

// Applies one key to the state; true when the buffer changed.
const press = (s: State, e: ClientKeyEvent, rows: number): boolean => {
  const key = e.key.toLowerCase()
  if (e.ctrl && key === 'a') {
    s.col = 0
    return false
  }
  if (e.ctrl && key === 'e') {
    s.col = chars(s.lines[s.row] ?? '').length
    return false
  }
  if (e.ctrl || e.meta) return false
  switch (key) {
    case 'up':
      s.row--
      return false
    case 'down':
      s.row++
      return false
    case 'left':
      if (s.col > 0) s.col--
      else if (s.row > 0) {
        s.row--
        s.col = chars(s.lines[s.row] ?? '').length
      }
      return false
    case 'right':
      if (s.col < chars(s.lines[s.row] ?? '').length) s.col++
      else if (s.row < s.lines.length - 1) {
        s.row++
        s.col = 0
      }
      return false
    case 'home':
      s.col = 0
      return false
    case 'end':
      s.col = chars(s.lines[s.row] ?? '').length
      return false
    case 'pageup':
      s.row -= rows
      s.top -= rows
      return false
    case 'pagedown':
      s.row += rows
      s.top += rows
      return false
    case 'return':
    case 'enter': {
      // A new line keeps the indentation of the one it leaves.
      const indent = /^\s*/.exec(s.lines[s.row] ?? '')?.[0] ?? ''
      insert(s, `\n${s.col >= indent.length ? indent : ''}`)
      return true
    }
    case 'tab':
      insert(s, TAB)
      return true
    case 'backspace':
      backspace(s)
      return true
    case 'delete':
      del(s)
      return true
    default:
      if (SPECIAL.has(key) || e.key.length === 0) return false
      insert(s, e.key)
      return true
  }
}

const Editor: ClientModule<EditorProps, State> = (props, surface: ClientSurface<State>) => {
  const { Box, Text } = surface.elements
  const width = String(Math.max(1, splitText(props.text).length + 1)).length
  const gutter = width + 3
  const rows = Math.max(1, surface.rows - 1)
  const columns = Math.max(8, surface.columns - gutter)

  const post = (type: EditorMessage['type'], s: State) => {
    s.saved = joined(s.lines)
    surface.post({ type, path: props.path, text: s.saved } satisfies EditorMessage)
  }

  let s = surface.state
  if (s === undefined) {
    s = fresh(props)
    surface.onKey((e: ClientKeyEvent) => {
      const now = surface.state ?? fresh(props)
      now.isFocused = true
      if (e.ctrl && e.key.toLowerCase() === 's') {
        post('save', now)
        surface.setState({ ...now })
        return
      }
      const changed = press(now, e, rows)
      clampCursor(now)
      follow(now, rows, columns)
      if (changed) surface.post({ type: 'change', path: props.path, text: joined(now.lines) } satisfies EditorMessage)
      surface.setState({ ...now })
    })
    surface.onPointer((e: ClientPointerEvent) => {
      if (e.type !== 'down' || e.button !== 'left') return
      const now = surface.state ?? fresh(props)
      now.isFocused = true
      now.row = now.top + e.y
      now.col = now.left + Math.max(0, e.x - gutter)
      clampCursor(now)
      surface.setState({ ...now })
    })
    surface.setState(s)
  } else {
    // The file was read again: a buffer with nothing unsaved follows the disk.
    if (props.version !== s.version && joined(s.lines) === s.saved) {
      const next = fresh(props, s)
      next.row = Math.min(s.row, next.lines.length - 1)
      next.col = s.col
      next.top = s.top
      clampCursor(next)
      s = next
      surface.setState(s)
    } else if (props.version !== s.version) {
      s = { ...s, version: props.version, saved: props.text }
      surface.setState(s)
    }
    // The wheel moved over the pane: scroll by its travel since last drawn.
    if (props.wheel !== s.wheel) {
      const by = props.wheel - s.wheel
      s = { ...s, wheel: props.wheel, top: Math.max(0, Math.min(Math.max(0, s.lines.length - rows), s.top + by)) }
      surface.setState(s)
    }
  }

  const isDirty = joined(s.lines) !== s.saved
  const first = Math.max(0, Math.min(s.top, Math.max(0, s.lines.length - 1)))
  const shown = s.lines.slice(first, first + rows)
  const painted = highlight(s.lines.slice(0, first + rows), props.path).slice(first)
  const marks = new Map(props.marks)

  // The cursor's line is drawn by the cell, the cursor's cell inverted.
  const cursorLine = (spans: Span[]) => {
    const cells: Span[] = []
    for (const span of spans) for (const ch of chars(span.text.replace(/\t/g, TAB))) cells.push({ ...span, text: ch })
    const row = cells.slice(s!.left, s!.left + columns)
    const at = s!.col - s!.left
    const runs: (Span & { isCursor?: boolean })[] = []
    row.forEach((cell, i) => {
      const last = runs[runs.length - 1]
      if (i === at) runs.push({ ...cell, isCursor: true })
      else if (last && !last.isCursor && last.color === cell.color && last.bold === cell.bold && last.italic === cell.italic) last.text += cell.text
      else runs.push({ ...cell })
    })
    if (at >= row.length && at < columns) runs.push({ text: ' ', color: INK.text, isCursor: true })
    return runs
  }

  return (
    <Box flexDirection="column" width={surface.columns} height={surface.rows} backgroundColor={INK.editorBg}>
      {shown.map((text, offset) => {
        const index = first + offset
        const mark = marks.get(index + 1)
        const isCursorRow = index === s!.row
        const spans = painted[offset] ?? [{ text, color: INK.text }]
        return (
          <Box key={`line:${index}`} flexDirection="row" backgroundColor={isCursorRow ? INK.lineOn : undefined}>
            <Text color={isCursorRow ? INK.gutterOn : INK.gutter}>
              {String(index + 1).padStart(width)}
              <Text color={mark ? INK[mark] : INK.gutter}>{mark === 'deleted' ? ' ▸ ' : mark ? ' ▎ ' : '   '}</Text>
            </Text>
            <Text wrap="truncate-end">
              {isCursorRow
                ? cursorLine(spans).map(run =>
                    run.isCursor ? (
                      <Text color={INK.editorBg} backgroundColor={INK.cursor}>
                        {run.text}
                      </Text>
                    ) : (
                      <Text color={run.color} bold={run.bold} italic={run.italic}>
                        {run.text}
                      </Text>
                    ),
                  )
                : clip(
                    s!.left > 0
                      ? [{ text: chars(text.replace(/\t/g, TAB)).slice(s!.left).join(''), color: INK.text }]
                      : spans,
                    columns,
                  ).map(span => (
                    <Text color={span.color} bold={span.bold} italic={span.italic}>
                      {span.text}
                    </Text>
                  ))}
              {text === '' && !isCursorRow ? ' ' : ''}
            </Text>
          </Box>
        )
      })}
      {shown.length < rows && <Box flexGrow={1} />}
      <Box flexDirection="row" justifyContent="space-between" backgroundColor={INK.barBg} paddingX={1}>
        <Text color={INK.dim} wrap="truncate-end">
          {s.isFocused ? '' : 'click to type · '}
          Ln {s.row + 1}, Col {s.col + 1}
          <Text color={INK.dim}>{`  ·  ${s.lines.length} lines`}</Text>
        </Text>
        <Text wrap="truncate-start">
          {isDirty ? (
            <Text color={INK.strong}>● unsaved{props.autosave ? ' · saving…' : ''}</Text>
          ) : (
            <Text color={INK.added}>✓ saved</Text>
          )}
          <Text color={INK.dim}>  ·  ctrl+s saves  ·  esc leaves</Text>
        </Text>
      </Box>
    </Box>
  )
}

export default Editor
