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
    String.raw`[A-Za-z]:\\[^\s\`'"<>()[\]{}|*]+`,
    String.raw`[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)+\/?`,
    String.raw`[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
  ].map(source => `(?<![\\w/.~:\\\\@-])(?:${source})(?::\\d+(?::\\d+)?)?`).join('|'),
  'g'
)
// A whole inline code span that is a path: it may hold spaces when it starts as a path does.
const SPAN = /^(?:(?:~|\.{1,2})?\/|[A-Za-z]:\\)[^\n`]*[^\s`]$/

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
 * folded, no trailing `/`. A Windows path stays as written.
 */
export function resolve (target: string, cwd: string, home: string | undefined) {
  if (/^[A-Za-z]:\\/.test(target)) return target
  let path = target
  if (path === '~' || path.startsWith('~/')) {
    if (!home) return undefined
    path = home + path.slice(1)
  } else if (!path.startsWith('/')) {
    path = `${cwd}/${path}`
  }
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// A path in quotes, as a drop or a copy from the file manager writes one: it may hold spaces when
// it starts as a path does. Not a quote closing a word (`it's`).
const QUOTED = /(?<![\w])(['"])((?:(?:~|\.{1,2})?\/|[A-Za-z]:\\)[^\n'"]*[^\s'"])\1/g
// A word after a path, past its spaces (a `\ ` an escaped one): where a path with spaces goes on.
const WORD = /^ +[^\s`'"<>|]+/

/** The paths a text names in quotes (`'/a b/c.webp'`), in order: each the text inside the quotes. */
export function quotedIn (text: string): Found[] {
  return [...text.matchAll(QUOTED)].map(match => {
    const start = match.index + 1
    return { start, end: start + match[2]!.length, target: match[2]!.replace(LINE, '') }
  })
}

/**
 * What an absolute or home path `found` names in `text` with the next words after it, one more
 * each, up to `most`: `/a/Application Support/x.png` written with no quotes. Longest first; which
 * one leads somewhere only a look at the disk tells.
 */
export function spacedAfter (text: string, found: Found, most: number): Found[] {
  if (!/^~?\//.test(found.target)) return []
  const out: Found[] = []
  let end = found.end
  for (let i = 0; i < most; i++) {
    const word = WORD.exec(text.slice(end))
    if (!word) break
    end += word[0].length
    const written = text.slice(found.start, end).replace(TRAILING, '')
    const target = clean(written.replace(/\\ /g, ' '))
    if (target !== undefined) out.unshift({ start: found.start, end: found.start + written.length, target })
  }
  return out
}
