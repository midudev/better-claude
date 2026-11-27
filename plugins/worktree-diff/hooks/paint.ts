// What colors the editor and the code view: the palette, the highlighters, the
// gutter marks. Shared by the hooks module and the editor's surface module.

export const baseName = (path: string) => path.split('/').pop() ?? path

// The editor's colors, after Cursor's dark theme.
export const INK = {
  text: '#d4d4d4',
  gutter: '#6e7681',
  dim: '#7d8590',
  heading: '#79b4d6',
  strong: '#e5c07b',
  code: '#d38fd0',
  link: '#4fc1ff',
  keyword: '#c586c0',
  string: '#ce9178',
  number: '#b5cea8',
  comment: '#6a9955',
  call: '#dcdcaa',
  type: '#4ec9b0',
  lineHover: '#1f1f1f',
  lineOn: '#202020',
  gutterOn: '#c6c6c6',
  editorBg: '#121212',
  barBg: '#1b1b1b',
  cursor: '#aeafad',
  tabOn: '#2f2f2f',
  added: '#2ea043',
  modified: '#3b8eea',
  deleted: '#f85149',
}

export type Span = { text: string; color: string; bold?: boolean; italic?: boolean }
export type Mark = 'added' | 'modified' | 'deleted'

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)
const CODE_FILE =
  /\.(m?[jt]sx?|c[jt]s|jsonc?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ya?ml|toml|css|scss|sql|lua|vue|svelte|astro|ini|conf)$|^(Makefile|Dockerfile)$/i
const HASH_COMMENTS = /\.(py|rb|sh|bash|zsh|ya?ml|toml|ini|conf)$|^(Makefile|Dockerfile|\.gitignore)$|^\.env/i
const HEADING = /^#{1,6}\s/
const KEYWORDS = new Set(
  (
    'import export from as default const let var function return if else for while do switch case break ' +
    'continue new class extends implements interface type enum async await yield try catch finally throw ' +
    'typeof instanceof in of void delete this super null undefined true false def self None True False ' +
    'lambda elif pass with fn pub mut impl struct use mod match func package go defer public private static'
  ).split(' '),
)

const INLINE_MD = /(`[^`]+`)|(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(<!--.*?-->)|(\*[^*\s][^*]*\*)/g

const inlineMarkdown = (text: string, color: string): Span[] => {
  const spans: Span[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_MD)) {
    const [all, code, strong, link, comment] = match
    if (match.index > last) spans.push({ text: text.slice(last, match.index), color })
    if (code) spans.push({ text: all, color: INK.code })
    else if (strong) spans.push({ text: all, color: INK.strong, italic: all.startsWith('***') })
    else if (link) {
      const cut = all.indexOf('](') + 1
      spans.push({ text: all.slice(0, cut), color: INK.link }, { text: all.slice(cut), color: INK.dim })
    } else if (comment) spans.push({ text: all, color: INK.dim })
    else spans.push({ text: all, color, italic: true })
    last = match.index + all.length
  }
  if (last < text.length) spans.push({ text: text.slice(last), color })
  return spans
}

const highlightMarkdown = (lines: string[]): Span[][] => {
  let isFenced = false
  return lines.map(row => {
    if (/^\s*(```|~~~)/.test(row)) {
      isFenced = !isFenced
      return [{ text: row, color: INK.code }]
    }
    if (isFenced) return [{ text: row, color: INK.string }]
    if (HEADING.test(row)) return inlineMarkdown(row, INK.heading)
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(row)) return [{ text: row, color: INK.dim }]
    const quote = /^(\s*>\s?)(.*)$/.exec(row)
    if (quote) return [{ text: quote[1] ?? '', color: INK.dim }, ...inlineMarkdown(quote[2] ?? '', INK.comment)]
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(row)
    if (item) return [{ text: item[1] ?? '', color: INK.dim }, ...inlineMarkdown(item[2] ?? '', INK.text)]
    return inlineMarkdown(row, INK.text)
  })
}

const highlightCode = (lines: string[], path: string): Span[][] => {
  const comment = HASH_COMMENTS.test(baseName(path)) ? '#.*$' : '\\/\\/.*$'
  const token = new RegExp(
    `(${comment}|\\/\\*.*?(?:\\*\\/|$))|("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(\\b\\d[\\d_.xXa-fA-F]*\\b)|([A-Za-z_$][\\w$]*)`,
    'g',
  )
  let isInBlock = false
  return lines.map(row => {
    const spans: Span[] = []
    let from = 0
    if (isInBlock) {
      const end = row.indexOf('*/')
      if (end < 0) return [{ text: row, color: INK.comment }]
      spans.push({ text: row.slice(0, end + 2), color: INK.comment })
      from = end + 2
      isInBlock = false
    }
    let last = from
    token.lastIndex = from
    for (let match = token.exec(row); match !== null; match = token.exec(row)) {
      const [all, note, text, digits, word] = match
      if (match.index > last) spans.push({ text: row.slice(last, match.index), color: INK.text })
      if (note) {
        spans.push({ text: all, color: INK.comment })
        if (all.startsWith('/*') && !all.endsWith('*/')) isInBlock = true
      } else if (text) spans.push({ text: all, color: INK.string })
      else if (digits) spans.push({ text: all, color: INK.number })
      else if (word && KEYWORDS.has(word)) spans.push({ text: all, color: INK.keyword })
      else if (word && row[match.index + all.length] === '(') spans.push({ text: all, color: INK.call })
      else if (word && /^[A-Z]/.test(word)) spans.push({ text: all, color: INK.type })
      else spans.push({ text: all, color: INK.text })
      last = match.index + all.length
    }
    if (last < row.length) spans.push({ text: row.slice(last), color: INK.text })
    return spans
  })
}

export const highlight = (lines: string[], path: string): Span[][] =>
  isMarkdown(path)
    ? highlightMarkdown(lines)
    : CODE_FILE.test(baseName(path))
      ? highlightCode(lines, path)
      : lines.map(text => [{ text, color: INK.text }])

// Cuts a painted line to `room` columns, an ellipsis at the cut, so a code line is
// always one row; tabs drawn as two spaces.
export const clip = (spans: Span[], room: number): Span[] => {
  const flat = spans.map(span => ({ ...span, text: span.text.replace(/\t/g, '  ') }))
  const total = flat.reduce((sum, span) => sum + [...span.text].length, 0)
  if (total <= room) return flat
  const kept: Span[] = []
  let left = room - 1
  for (const span of flat) {
    if (left <= 0) break
    const chars = [...span.text]
    kept.push({ ...span, text: chars.slice(0, left).join('') })
    left -= chars.length
  }
  return [...kept, { text: '…', color: INK.dim }]
}

// Gutter marks by 1-based line of the file as it is now: a run of "-" then "+" is
// modified, a "+" alone added, a "-" alone marks the line after where it was.
export const markLines = (diff: string) => {
  const marks = new Map<number, Mark>()
  let at = 0
  let removed = 0
  for (const row of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row)
    if (hunk) {
      at = Number(hunk[1])
      removed = 0
    } else if (at === 0 || row.startsWith('\\')) {
      continue
    } else if (row.startsWith('+')) {
      marks.set(at++, removed > 0 ? 'modified' : 'added')
      if (removed > 0) removed--
    } else if (row.startsWith('-')) {
      removed++
    } else {
      if (removed > 0 && !marks.has(at)) marks.set(at, 'deleted')
      removed = 0
      at++
    }
  }
  if (removed > 0 && at > 1 && !marks.has(at - 1)) marks.set(at - 1, 'deleted')
  return marks
}

export const headingAt = (lines: string[], at: number) => {
  for (let i = Math.min(at, lines.length - 1); i >= 0; i--) {
    if (HEADING.test(lines[i] ?? '')) return lines[i]
  }
  return lines.find(row => HEADING.test(row))
}
