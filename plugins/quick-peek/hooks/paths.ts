// Finding the paths a text names: absolute (`/Users/…`), from home (`~/…`), relative (`./x`,
// `src/x.ts`, `README.md`), each with an optional `:line` or `:line:column` after it. A path is
// only a candidate here: the hooks module links the ones that lead to a file or folder.

/** A path a text names: where it starts and ends in the text, and the path itself, `:line` cut. */
export type Found = { start: number; end: number; target: string }

// What a sentence puts after a path, and a line (and column) after a file.
const TRAILING = /[.,;:!?)\]}>'"»”’]+$/
const LINE = /:\d+(?::\d+)?$/
// An address: never a path, nor the paths inside it.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi
// Absolute, from home or explicitly relative; a relative path with a folder in it; a file name with
// an extension. None starts inside a word, an address or another path.
const CANDIDATE = new RegExp(
  [
    String.raw`(?:~|\.{1,2})?\/[^\s\`'"<>()[\]{}|*]+`,
    String.raw`[A-Za-z]:[\\/][^\s\`'"<>()[\]{}|*]+`,
    String.raw`[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)+\/?`,
    String.raw`[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
  ].map(source => `(?<![\\w/.~:\\\\@-])(?:${source})(?::\\d+(?::\\d+)?)?`).join('|'),
  'g'
)
// A whole inline code span that is a path: it may hold spaces when it starts as a path does.
const SPAN = /^(?:(?:~|\.{1,2})?\/|[A-Za-z]:[\\/])[^\n`]*[^\s`]$/
// A Windows path's drive.
const DRIVE = /^[A-Za-z]:[\\/]/

/** The path `found` names, with what a sentence or a line number adds after it cut; none when nothing is left. */
function clean (text: string) {
  let target = text.replace(TRAILING, '')
  target = target.replace(LINE, '')
  target = target.replace(TRAILING, '')
  return /[\w~]/.test(target) && target !== '~' ? target : undefined
}

/** The line a path's text names after it (`src/x.ts:12`, `src/x.ts:12:5`), if it names one. */
export function lineOf (text: string) {
  const line = text.trim().replace(TRAILING, '').match(LINE)?.[0]
  return line === undefined ? undefined : Number(line.slice(1).split(':')[0])
}

/** The paths named in plain text, in order. */
export function pathsIn (text: string): Found[] {
  const masked = text.replace(URL, match => ' '.repeat(match.length))
  const found: Found[] = []
  for (const match of masked.matchAll(CANDIDATE)) {
    const whole = match[0]
    const trimmed = whole.replace(TRAILING, '')
    const target = clean(whole)
    if (target === undefined) continue
    found.push({ start: match.index, end: match.index + trimmed.length, target })
  }
  return found
}

/** The path an inline code span holds whole (`` `~/a b/c.mp4` `` or `` `src/x.ts:12` ``), if it holds one. */
export function pathOfSpan (code: string): string | undefined {
  const text = code.trim()
  if (SPAN.test(text)) return text.replace(LINE, '')
  const found = pathsIn(text)
  return found.length === 1 && found[0]!.start === 0 && found[0]!.end === text.length ? found[0]!.target : undefined
}

/**
 * Where `target` lands: home for `~`, the working folder for a relative path; `.` and `..`
 * folded, no trailing `/`. A Windows path written with `\` stays as written; one that lands in a
 * Windows folder (`C:\Users\ana`, as the session names it there) keeps its drive, its separators
 * `/` (`C:/Users/ana/x`).
 */
export function resolve (target: string, cwd: string, home: string | undefined) {
  if (/^[A-Za-z]:\\/.test(target)) return target
  let path = target
  if (path === '~' || path.startsWith('~/')) {
    if (!home) return undefined
    path = home + path.slice(1)
  } else if (!path.startsWith('/') && !DRIVE.test(path)) {
    path = `${cwd}/${path}`
  }
  const drive = DRIVE.test(path) ? path.slice(0, 2) : ''
  if (drive) path = path.slice(2).replaceAll('\\', '/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}
