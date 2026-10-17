// How states and their files read, in the pane and in the transcript. Pure: text in, text out.

/** @typedef {import('../types').Change} Change */

const LABEL_MAX = 60
// A change of up to FEW files names them; past that, the total and the GROUPS biggest folders
const FEW = 2
const GROUPS = 2

export const ICON = /** @type {Record<string, string>} */ ({ A: '+', D: '−', M: '~' })

/** One line, cut to `max` with an ellipsis. @param {string} text */
export function shorten (text, max = LABEL_MAX) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `3 files +12 −4`. @param {Change[]} files */
export function summary (files) {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return files.length === 0 ? 'no files' : `${files.length} file${files.length === 1 ? '' : 's'} +${added} −${removed}`
}

/** A path cut to its last two parts: `hooks/register.tsx`, not the whole way from the root. @param {string} path */
const shortPath = path => path.split('/').slice(-2).join('/')

/**
 * The files of a change in one line, however many. One or two: each with its short path.
 * More: the total, the lines, and where they are: the biggest folders under the one they
 * all share (which every row would repeat, so it is left out).
 * @param {Change[]} files
 */
export function digest (files) {
  if (files.length <= FEW) return { kind: /** @type {const} */ ('few'), files: files.map(file => ({ ...file, name: shortPath(file.path) })) }

  const split = files.map(file => file.path.split('/'))
  let shared = 0
  while (split.every(parts => parts.length > shared + 1 && parts[shared] === split[0][shared])) shared++
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const parts of split) {
    const rest = parts.slice(shared)
    const group = rest.length > 1 ? `${rest[0]}/` : rest[0]
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return {
    kind: /** @type {const} */ ('many'),
    count: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    groups: ranked.slice(0, GROUPS).map(([name, n]) => n > 1 ? `${name} ×${n}` : name),
    more: Math.max(0, ranked.length - GROUPS)
  }
}

/** The same line as plain text, for the transcript. @param {Change[]} files */
export function digestText (files) {
  const d = digest(files)
  if (d.kind === 'few') return d.files.map(file => `${ICON[file.status] ?? '~'} ${file.name}`).join('  ')
  return `${d.count} files +${d.added} −${d.removed} · ${d.groups.join(' · ')}${d.more ? ` · +${d.more}` : ''}`
}

/** How long ago, in the unit that reads: `now`, `7m`, `3h`, `2d`. @param {number} ms */
export function ago (ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** How long the running turn has taken: `8s`, `1m 05s`. @param {number} ms */
export function elapsed (ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const THINKING = 'thinking…'
// What each tool is doing, in a word; the rest read as their own name
const VERB = /** @type {Record<string, string>} */ ({ Read: 'reading', Edit: 'editing', MultiEdit: 'editing', Write: 'writing', NotebookEdit: 'editing', Bash: 'running', Grep: 'searching', Glob: 'looking for', WebFetch: 'reading', WebSearch: 'searching the web for', Agent: 'asking an agent:', Task: 'asking an agent:' })

/**
 * What Claude is at, from the tool it calls: `editing hooks/register.tsx`, `running npm test`,
 * `searching "drawPane"`. Without a tool (between two), it is thinking.
 * @param {string | null} tool
 * @param {Record<string, unknown>} [input]
 */
export function activity (tool, input = {}) {
  if (!tool) return THINKING
  const text = (/** @type {string} */ key) => typeof input[key] === 'string' ? /** @type {string} */ (input[key]) : ''
  // Bash says what it does in `description` ("Type-check the mod"); without one, the command
  // without what only sets it up (`cd x &&`, `FOO=1`), which would fill the line
  if (tool === 'Bash' && text('description')) return shorten(text('description'), 60)
  const what = text('file_path') ? shortPath(text('file_path'))
    : text('notebook_path') ? shortPath(text('notebook_path'))
      : text('command') ? shorten(bare(text('command')), 40)
        : text('pattern') ? `"${shorten(text('pattern'), 30)}"`
          : text('query') ? `"${shorten(text('query'), 30)}"`
            : text('url') ? shorten(text('url'), 40)
              : text('description') ? shorten(text('description'), 40) : ''
  const verb = VERB[tool] ?? tool.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
  return what ? `${verb} ${what}` : verb
}

/** A command without the set-up in front: `cd src && FOO=1 npm test` is `npm test`. @param {string} command */
const bare = command => command.replace(/^\s*(?:cd\s+\S+\s*&&\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '') || command

/**
 * The scanner of a running turn at `frame`: a block of `size` sweeping a track of `width`, back
 * and forth. Gives the cells before it, so the track never changes length.
 * @param {number} frame
 */
export function sweep (frame, width = 8, size = 3) {
  const span = width - size
  const step = frame % (2 * span)
  return step <= span ? step : 2 * span - step
}
