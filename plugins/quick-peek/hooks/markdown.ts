// The part of markdown the mod draws itself: a reply cut into blocks, the inline runs of a
// paragraph or a list item, and those runs wrapped into rows as the engine wraps a reply's text.
// Every other block (a heading, a fence, a table, a quote) is drawn by the engine's own Markdown.

/** How a run is drawn. `href`, a link's address. */
export type Style = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; href?: string }

/** A run of inline text in one style; `link`, the path it names, by its index in the reply. */
export type Run = { text: string; style: Style; link?: number }

/** A row of a wrapped paragraph. */
export type Row = Run[]

/** A block of the reply: `prose` the mod may draw itself, `other` the engine draws. `gap`, blank lines before it. */
export type Block = { kind: 'paragraph' | 'list' | 'other'; text: string; gap: number }

/** A list item: its marker as written, its text (lines joined), the items under it, blank lines before it. */
export type Item = { ordered: boolean; number: number; text: string; children: Item[]; gap: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}#{1,6}(\s|$)/
const QUOTE = /^ {0,3}>/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:(\s+)(.*))?$/
const HTML = /^ {0,3}<\/?[a-zA-Z]/

const isBlank = (line: string) => line.trim() === ''
/** What kind of list a marker opens: its bullet, or an ordered list's delimiter. */
const kindOf = (marker: string) => (/\d/.test(marker) ? `1${marker.at(-1)}` : marker)
const indentOf = (line: string) => line.length - line.trimStart().length

/** Whether `line` starts a block of its own, so it ends a paragraph. */
function interrupts (line: string, next: string | undefined) {
  if (FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || HTML.test(line)) return true
  if (next !== undefined && line.includes('|') && TABLE_RULE.test(next) && next.includes('-')) return true
  const item = ITEM.exec(line)
  return !!item && item[4] !== undefined && item[4].trim() !== '' && indentOf(line) < 4 && (!/\d/.test(item[2]!) || /^1[.)]$/.test(item[2]!))
}

/** The reply cut into blocks, in order; joined with their gaps, they give the text back. */
export function blocks (text: string): Block[] {
  const lines = text.split('\n')
  const found: Block[] = []
  let gap = 0
  let at = 0
  const push = (kind: Block['kind'], end: number) => {
    found.push({ kind, text: lines.slice(at, end).join('\n'), gap })
    gap = 0
    at = end
  }
  while (at < lines.length) {
    const line = lines[at]!
    if (isBlank(line)) {
      gap++
      at++
      continue
    }
    let end = at + 1
    const fence = FENCE.exec(line)
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`)
      while (end < lines.length && !close.test(lines[end]!)) end++
      push('other', Math.min(end + 1, lines.length))
      continue
    }
    if (line.includes('|') && end < lines.length && TABLE_RULE.test(lines[end]!) && lines[end]!.includes('-')) {
      while (end < lines.length && !isBlank(lines[end]!) && lines[end]!.includes('|')) end++
      push('other', end)
      continue
    }
    if (QUOTE.test(line)) {
      while (end < lines.length && !isBlank(lines[end]!)) end++
      push('other', end)
      continue
    }
    if (HEADING.test(line) || RULE.test(line) || HTML.test(line) || indentOf(line) >= 4) {
      if (indentOf(line) >= 4 || HTML.test(line)) while (end < lines.length && !isBlank(lines[end]!)) end++
      push('other', end)
      continue
    }
    const item = ITEM.exec(line)
    if (item && item[4] !== undefined) {
      // A list runs on through blank lines while what follows is an item of its kind or indented
      // under one; an item of another kind (`-` after `*`, `1.` after `-`) starts another list.
      const indent = indentOf(line)
      const kind = kindOf(item[2]!)
      const isOther = (next: string) => {
        const other = ITEM.exec(next)
        return !!other && indentOf(next) <= indent && kindOf(other[2]!) !== kind
      }
      while (end < lines.length) {
        const next = lines[end]!
        if (!isBlank(next)) {
          if (isOther(next)) break
          if (indentOf(next) === 0 && !ITEM.test(next) && (isBlank(lines[end - 1]!) || interrupts(next, lines[end + 1]))) break
          end++
          continue
        }
        let after = end
        while (after < lines.length && isBlank(lines[after]!)) after++
        const following = lines[after]
        if (following === undefined || isOther(following) || !(ITEM.test(following) || indentOf(following) >= 2)) break
        end = after
      }
      push('list', end)
      continue
    }
    while (end < lines.length && !isBlank(lines[end]!) && !interrupts(lines[end]!, lines[end + 1])) end++
    push('paragraph', end)
  }
  return found
}

/** A list block's items, nested as their indents say. */
export function items (text: string): Item[] {
  type Open = Item & { indent: number; content: number; lines: string[] }
  const roots: Open[] = []
  const stack: Open[] = []
  let gap = 0
  for (const line of text.split('\n')) {
    if (isBlank(line)) {
      gap++
      continue
    }
    const item = ITEM.exec(line)
    const indent = indentOf(line)
    if (!item) {
      // A line under an item continues the deepest one it is indented under, or the last (a lazy line).
      const open = [...stack].reverse().find(open => open.content <= indent) ?? stack.at(-1)
      open?.lines.push(line.trim())
      gap = 0
      continue
    }
    while (stack.length > 0 && indent < stack.at(-1)!.content) stack.pop()
    const marker = item[2]!
    const spaces = item[3]?.length ?? 1
    const open: Open = {
      ordered: /\d/.test(marker),
      number: Number.parseInt(marker, 10) || 1,
      text: '',
      children: [],
      gap,
      indent,
      content: indent + marker.length + (spaces > 4 ? 1 : spaces),
      lines: [item[4] ?? '']
    }
    const parent = stack.at(-1)
    ;(parent ? parent.children : roots).push(open)
    stack.push(open)
    gap = 0
  }
  const close = (list: Open[]): Item[] => {
    const start = list[0]?.number ?? 1
    return list.map((open, i) => ({
      ordered: open.ordered,
      number: start + i,
      text: open.lines.join('\n'),
      children: close(open.children as Open[]),
      gap: open.gap
    }))
  }
  return close(roots)
}

const LETTERS = (n: number) => {
  let out = ''
  for (let left = n; left > 0; left = Math.floor((left - 1) / 26)) out = String.fromCharCode(97 + ((left - 1) % 26)) + out
  return out
}
const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
const roman = (n: number) => {
  let out = ''
  let left = n
  for (const [value, letters] of ROMAN) while (left >= value) (out += letters), (left -= value)
  return out
}

/** The marker the engine draws for an item: `-`, or `1.`, `a.`, `i.` by depth. */
export function markerOf (item: Item, depth: number) {
  if (!item.ordered) return '-'
  const level = depth % 3
  return `${level === 0 ? item.number : level === 1 ? LETTERS(item.number) : roman(item.number)}.`
}

/** The inline runs of a paragraph's markdown: code spans, emphasis, strikes, links; a hard break as `\n`. */
export function inline (source: string, style: Style = {}): Run[] {
  const runs: Run[] = []
  let text = ''
  const flush = () => {
    if (text) runs.push({ text, style })
    text = ''
  }
  const emit = (inner: Run[]) => {
    flush()
    runs.push(...inner)
  }
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const rest = source.slice(i)
    if (c === '\\' && /^\\[!-/:-@[-`{-~]/.test(rest)) {
      text += source[i + 1]
      i += 2
      continue
    }
    // A hard break: a backslash or two spaces before the newline. A soft one is kept as written.
    if (/^(\\| {2,})\n/.test(rest)) {
      text += '\n'
      i += rest.indexOf('\n') + 1
      continue
    }
    if (c === '`') {
      const ticks = /^`+/.exec(rest)![0]
      const close = new RegExp(`(?<!\`)${ticks}(?!\`)`).exec(source.slice(i + ticks.length))
      if (close) {
        let code = source.slice(i + ticks.length, i + ticks.length + close.index).replace(/\n/g, ' ')
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1)
        emit([{ text: code, style: { ...style, code: true } }])
        i += ticks.length * 2 + close.index
        continue
      }
      text += ticks
      i += ticks.length
      continue
    }
    if (c === '[') {
      const link = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (link) {
        emit(inline(link[1]!, { ...style, href: link[2]! }))
        i += link[0].length
        continue
      }
    }
    const auto = /^<((?:https?|file):\/\/[^>\s]+)>/.exec(rest)
    if (auto) {
      emit([{ text: auto[1]!, style: { ...style, href: auto[1]! } }])
      i += auto[0].length
      continue
    }
    if (c === '*' || c === '_' || c === '~') {
      const run = new RegExp(`^\\${c}+`).exec(rest)![0]
      const before = source[i - 1] ?? ' '
      const after = source[i + run.length] ?? ' '
      const isIntraword = c === '_' && /\w/.test(before)
      const size = c === '~' ? (run.length === 2 ? 2 : 0) : Math.min(run.length, 3)
      if (size > 0 && !isIntraword && !/\s/.test(after)) {
        const marks = c.repeat(size)
        const from = i + size
        let close = -1
        for (let at = source.indexOf(marks, from + 1); at !== -1; at = source.indexOf(marks, at + 1)) {
          const isFlanked = !/\s/.test(source[at - 1]!) && (c !== '_' || !/\w/.test(source[at + size] ?? ' '))
          if (isFlanked && source[at + size] !== c) {
            close = at
            break
          }
        }
        if (close !== -1) {
          const inner = source.slice(from, close)
          const next: Style = c === '~' ? { ...style, strike: true } : { ...style, ...(size >= 2 && { bold: true }), ...(size !== 2 && { italic: true }) }
          emit(inline(inner, next))
          i = close + size
          continue
        }
      }
      text += run
      i += run.length
      continue
    }
    text += c
    i++
  }
  flush()
  return runs
}

const ZERO = /^[̀-ͯ҃-҉֑-ֽؐ-ًؚ-ٟ​-‏⃐-⃿︀-️︠-︯]$/u
const WIDE = /^[ᄀ-ᅟ⌚⌛〈〉⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]$/u

/** The columns a character takes in the terminal. */
const charWidth = (char: string) => (ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1)

/** The columns a text takes in the terminal. */
export const widthOf = (text: string) => {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * The first part of `text` that fits in `room` columns, cut at most that wide; a path is cut
 * after a `/` near the end where it has one, so each row ends at a folder.
 */
function cut (text: string, room: number, isPath: boolean) {
  let width = 0
  let end = 0
  for (const char of text) {
    const w = charWidth(char)
    if (width + w > room) break
    width += w
    end += char.length
  }
  if (isPath && end < text.length) {
    const slash = text.lastIndexOf('/', end - 1)
    if (slash > 0 && end - slash <= 16) end = slash + 1
  }
  return end === 0 ? Math.max(1, [...text][0]!.length) : end
}

/**
 * The runs wrapped into rows of `width` columns, as the engine wraps a reply: at spaces, a word
 * that does not fit moved to the next row, one longer than a row cut where it saves a row. The
 * spaces a wrap lands on are dropped. `isCutAtFolder` false, a path is cut where a row ends, as the
 * engine cuts the text it wraps itself.
 */
export function wrap (runs: Run[], width: number, isCutAtFolder = true): Row[] {
  type Piece = Run & { width: number }
  type Token = { kind: 'word' | 'space' | 'break'; pieces: Piece[]; width: number }
  const tokens: Token[] = []
  for (const run of runs) {
    for (const part of run.text.split(/(\n| +)/)) {
      if (part === '') continue
      const kind = part === '\n' ? 'break' : part.startsWith(' ') ? 'space' : 'word'
      const piece: Piece = { ...run, text: part, width: widthOf(part) }
      const last = tokens.at(-1)
      if (kind === 'word' && last?.kind === 'word') {
        last.pieces.push(piece)
        last.width += piece.width
      } else {
        tokens.push({ kind, pieces: [piece], width: piece.width })
      }
    }
  }

  const rows: Row[] = [[]]
  let column = 0
  let spaces: Piece[] = []
  const put = (piece: Piece) => {
    const row = rows.at(-1)!
    const last = row.at(-1)
    if (last && last.link === piece.link && sameStyle(last.style, piece.style)) last.text += piece.text
    else row.push({ text: piece.text, style: piece.style, ...(piece.link !== undefined && { link: piece.link }) })
    column += piece.width
  }
  const newRow = () => {
    rows.push([])
    column = 0
    spaces = []
  }
  for (const token of tokens) {
    if (token.kind === 'break') {
      newRow()
      continue
    }
    if (token.kind === 'space') {
      if (column > 0) spaces.push(...token.pieces)
      continue
    }
    const gap = spaces.reduce((sum, piece) => sum + piece.width, 0)
    if (column + gap + token.width <= width) {
      spaces.forEach(put)
      spaces = []
      token.pieces.forEach(put)
      continue
    }
    if (token.width <= width) {
      newRow()
      token.pieces.forEach(put)
      continue
    }
    // Longer than a row: started here only where that takes no more rows than starting below.
    const room = width - column - gap
    const startingHere = 1 + Math.floor((token.width - room - 1) / width)
    const startingBelow = Math.floor((token.width - 1) / width)
    if (column > 0 && (room <= 0 || startingBelow < startingHere)) newRow()
    else {
      spaces.forEach(put)
      spaces = []
    }
    for (const piece of token.pieces) {
      let left = piece.text
      while (left !== '') {
        if (column >= width) newRow()
        const end = cut(left, width - column, isCutAtFolder && piece.link !== undefined)
        const part = left.slice(0, end)
        put({ ...piece, text: part, width: widthOf(part) })
        left = left.slice(end)
        if (left !== '') newRow()
      }
    }
  }
  return rows.filter((row, i) => row.length > 0 || i < rows.length - 1)
}

const sameStyle = (a: Style, b: Style) =>
  !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && a.href === b.href
