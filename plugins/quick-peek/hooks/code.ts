// Previewing a file of code or text: which files are, by their name; the lines a preview shows
// (the first ones, or those around the line a path names); and their tokens, coloured by kind.
// The window draws the tokens with a palette of its own; the terminal's card draws the lines with
// the engine's own highlighter.

/** A token's kind, the colour it takes: keyword or tag, string, number, comment, type, attribute or key, function; plain. */
export type Kind = 'k' | 's' | 'n' | 'c' | 't' | 'a' | 'f' | ''
export type Token = [Kind, string]
/** How a language is coloured: its rules, one alternation, the kind of each. */
type Grammar = { pattern: RegExp | undefined; kinds: Kind[] }
/** A language a preview knows: the name it shows, how it is coloured. */
export type Language = { name: string; grammar: Grammar }
/**
 * What a preview shows of a file: its language and how many lines it has; the lines from `first`,
 * as written (`source`) and as tokens; `mark`, the line the path names, 0 for none.
 */
export type Excerpt = { language: string; count: number; first: number; mark: number; source: string; lines: Token[][] }

// The most lines shown before the one a path names (a third of the rows, at most), a tab's
// columns, and the longest line kept.
const CONTEXT = 3
const TAB = '  '
const LINE_CHARS = 240

/** A grammar from its rules, tried in order where two start at the same place. None holds a capturing group. */
function grammar (rules: [Kind, string][], flags = '') {
  return { pattern: rules.length > 0 ? new RegExp(rules.map(([, source]) => `(${source})`).join('|'), `gm${flags}`) : undefined, kinds: rules.map(([kind]) => kind) }
}

const words = (list: string) => String.raw`\b(?:${list.split(' ').join('|')})\b`
const block = (open: string, close: string) => `${open}[\\s\\S]*?(?:${close}|(?![\\s\\S]))`
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`
const BT = String.raw`\`(?:[^\`\\]|\\[\s\S])*\`?`
const TRIPLE = String.raw`"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))`
const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b`
const TYPE = String.raw`\b[A-Z][A-Za-z0-9_]*\b`
const CALL = String.raw`\b[A-Za-z_$][\w$]*(?=\()`
const SLASHES: [Kind, string][] = [['c', '//.*'], ['c', block(String.raw`/\*`, String.raw`\*/`)]]

const JS_WORDS = 'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield'
const JS_RULES: [Kind, string][] = [...SLASHES, ['s', BT], ['s', DQ], ['s', SQ], ['k', words(JS_WORDS)], ['t', TYPE], ['f', CALL], ['n', NUMBER]]
const JS = grammar(JS_RULES)
// JSX: a tag's name after `<` (a component's, capitalised, a type's colour) and its attributes.
const JSX = grammar([...JS_RULES.slice(0, 5), ['t', String.raw`(?<=<|<\/)[A-Z][\w.]*`], ['k', String.raw`(?<=<|<\/)[a-z][\w.-]*`], ['a', String.raw`\b[A-Za-z_][\w-]*(?==[{"'])`], ...JS_RULES.slice(5)])

const C_WORDS = 'abstract and as assert async auto await bool boolean break byte case catch char class const constexpr continue data def default defer delete do double else enum explicit export extends extern false final finally float for fun func function goto guard if implements import in inline instanceof int interface internal is let long mutable namespace new nil null object operator override package private protected public readonly register return sealed self short signed sizeof static struct super switch synchronized template this throw throws true try typedef typename union unsigned using val var virtual void volatile when where while yield'
const C = grammar([...SLASHES, ['k', String.raw`^\s*#\s*\w+`], ['s', TRIPLE], ['s', DQ], ['s', SQ], ['f', String.raw`@\w+`], ['a', String.raw`\$\w+`], ['k', words(C_WORDS)], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const GO = grammar([...SLASHES, ['s', DQ], ['s', String.raw`\`[^\`]*\`?`], ['s', SQ], ['k', words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota any bool byte error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr')], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const RUST = grammar([...SLASHES, ['s', DQ], ['s', String.raw`'(?:[^'\\\n]|\\.)'`], ['t', String.raw`'[a-z_]\w*`], ['f', String.raw`\b\w+!`], ['k', words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str')], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const PYTHON = grammar([['c', '#.*'], ['s', TRIPLE], ['s', DQ], ['s', SQ], ['f', String.raw`@[\w.]+`], ['k', words('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try while with yield')], ['t', TYPE], ['f', CALL], ['n', NUMBER]])
const RUBY = grammar([['c', '#.*'], ['s', DQ], ['s', SQ], ['a', String.raw`@{1,2}\w+`], ['n', String.raw`(?<![\w:]):[A-Za-z_]\w*`], ['k', words('alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo require rescue retry return self super then true undef unless until when while yield')], ['t', TYPE], ['n', NUMBER]])
const SHELL = grammar([['c', String.raw`(?<![\w$#{])#.*`], ['s', DQ], ['s', `'[^'\\n]*'?`], ['a', String.raw`\$\{[^}\n]*\}?|\$[\w@#?$!*-]`], ['k', words('if then else elif fi for in do done while until case esac function return local export readonly declare set unset shift exit source alias echo cd')], ['n', NUMBER]])
const LUA = grammar([['c', block('--\\[\\[', '\\]\\]')], ['c', '--.*'], ['s', DQ], ['s', SQ], ['k', words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while')], ['f', CALL], ['n', NUMBER]])
const SQL = grammar([['c', '--.*'], ['c', block(String.raw`/\*`, String.raw`\*/`)], ['s', SQ], ['a', DQ], ['k', words('add all alter and as asc begin between by case check column commit constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction union unique update using values view when where with')], ['f', CALL], ['n', NUMBER]], 'i')

const JSON_ = grammar([...SLASHES, ['a', `${DQ}(?=\\s*:)`], ['s', DQ], ['k', words('true false null')], ['n', `-?${NUMBER}`]])
const YAML = grammar([['c', String.raw`(?<!\S)#.*`], ['k', '^(?:---|\\.\\.\\.)$'], ['a', String.raw`[\w.-][\w .-]*?(?=\s*:(?:\s|$))`], ['s', DQ], ['s', SQ], ['t', String.raw`[&*][\w-]+`], ['k', words('true false null')], ['n', NUMBER]])
const CONF = grammar([['c', String.raw`(?<!\S)[#;].*`], ['t', String.raw`^\s*\[[^\]\n]*\]`], ['a', String.raw`^\s*[\w.-]+(?=\s*[=:])`], ['s', TRIPLE], ['s', DQ], ['s', SQ], ['k', words('true false')], ['n', NUMBER]])
const DOCKER = grammar([['c', String.raw`^\s*#.*`], ['k', String.raw`^\s*[A-Z]{2,}\b`], ['s', DQ], ['s', SQ], ['a', String.raw`\$\{[^}\n]*\}?|\$\w+`], ['n', NUMBER]])
const MAKE = grammar([['c', '#.*'], ['k', String.raw`^\s*(?:include|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|override)\b`], ['f', String.raw`^[^\s:#=][^:#=\n]*(?=:(?!=))`], ['a', String.raw`\$[({][^)}\n]*[)}]?|\$[@<^?*%]`], ['s', DQ], ['s', SQ]])

// Markup: a tag's name, an attribute and its quoted value, an entity.
const MARKUP = grammar([['c', block('<!--', '-->')], ['k', String.raw`(?<=<)![A-Za-z]+`], ['k', String.raw`(?<=<|<\/)[A-Za-z][\w:.-]*`], ['a', String.raw`[\w:@.#-]+(?==)`], ['s', String.raw`(?<==)"[^"]*"?`], ['s', String.raw`(?<==)'[^']*'?`], ['n', String.raw`&[\w#]+;`]])
// Styles: at-rules, properties (a colon and a space after), selectors, functions, colours, numbers with units.
const CSS = grammar([['c', block(String.raw`/\*`, String.raw`\*/`)], ['c', String.raw`(?<![:\w])//.*`], ['s', DQ], ['s', SQ], ['k', String.raw`@[\w-]+|!important`], ['n', String.raw`#[\da-fA-F]{3,8}\b`], ['a', String.raw`--[\w-]+|[\w-]+(?=\s*:\s)`], ['t', String.raw`[.#][A-Za-z_-][\w-]*`], ['f', String.raw`[\w-]+(?=\()`], ['', String.raw`[A-Za-z_][\w-]*`], ['n', String.raw`-?(?:\d+\.?\d*|\.\d+)(?:%|[A-Za-z]+)?`]])
// Markdown: fences, headings, quotes, list markers, code spans, bold, links, HTML.
const MARKDOWN = grammar([['c', '^(?:```|~~~).*'], ['k', String.raw`^#{1,6}\s.*`], ['c', '^>.*'], ['n', String.raw`^\s*(?:[-*+]|\d+[.)])(?=\s)`], ['s', '`[^`\\n]+`'], ['t', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__`], ['a', String.raw`!?\[[^\]\n]*\]\([^)\n]*\)`], ['f', String.raw`<\/?[A-Za-z][^>\n]*>`]])
const PLAIN = grammar([])

const language = (name: string, grammar: Grammar): Language => ({ name, grammar })
const BY_EXTENSION: Record<string, Language> = {
  js: language('JavaScript', JS), mjs: language('JavaScript', JS), cjs: language('JavaScript', JS), jsx: language('JavaScript JSX', JSX),
  ts: language('TypeScript', JS), mts: language('TypeScript', JS), cts: language('TypeScript', JS), tsx: language('TypeScript JSX', JSX),
  json: language('JSON', JSON_), jsonc: language('JSON with comments', JSON_), json5: language('JSON5', JSON_), jsonl: language('JSON Lines', JSON_),
  html: language('HTML', MARKUP), htm: language('HTML', MARKUP), xhtml: language('XHTML', MARKUP), xml: language('XML', MARKUP), plist: language('Property list', MARKUP),
  vue: language('Vue', MARKUP), svelte: language('Svelte', MARKUP), astro: language('Astro', MARKUP),
  css: language('CSS', CSS), scss: language('SCSS', CSS), sass: language('Sass', CSS), less: language('Less', CSS),
  md: language('Markdown', MARKDOWN), markdown: language('Markdown', MARKDOWN), mdx: language('MDX', MARKDOWN),
  py: language('Python', PYTHON), pyi: language('Python', PYTHON), rb: language('Ruby', RUBY), go: language('Go', GO), rs: language('Rust', RUST), lua: language('Lua', LUA),
  c: language('C', C), h: language('C header', C), cpp: language('C++', C), cc: language('C++', C), cxx: language('C++', C), hpp: language('C++ header', C),
  cs: language('C#', C), java: language('Java', C), kt: language('Kotlin', C), kts: language('Kotlin', C), swift: language('Swift', C), dart: language('Dart', C),
  scala: language('Scala', C), php: language('PHP', C), m: language('Objective-C', C), mm: language('Objective-C++', C), zig: language('Zig', C),
  sh: language('Shell script', SHELL), bash: language('Shell script', SHELL), zsh: language('Shell script', SHELL), fish: language('Shell script', SHELL),
  yml: language('YAML', YAML), yaml: language('YAML', YAML), toml: language('TOML', CONF), ini: language('INI', CONF), cfg: language('Configuration', CONF),
  conf: language('Configuration', CONF), properties: language('Properties', CONF), env: language('Environment', CONF),
  sql: language('SQL', SQL), txt: language('Plain text', PLAIN), text: language('Plain text', PLAIN), log: language('Log', PLAIN), csv: language('CSV', PLAIN), tsv: language('TSV', PLAIN)
}
const BY_NAME: Record<string, Language> = {
  dockerfile: language('Dockerfile', DOCKER), containerfile: language('Containerfile', DOCKER),
  makefile: language('Makefile', MAKE), gnumakefile: language('Makefile', MAKE),
  gemfile: language('Ruby', RUBY), rakefile: language('Ruby', RUBY),
  '.bashrc': language('Shell script', SHELL), '.zshrc': language('Shell script', SHELL), '.profile': language('Shell script', SHELL),
  '.gitignore': language('Ignore list', CONF), '.dockerignore': language('Ignore list', CONF), '.npmignore': language('Ignore list', CONF), '.prettierignore': language('Ignore list', CONF),
  '.gitattributes': language('Configuration', CONF), '.editorconfig': language('Configuration', CONF), '.npmrc': language('Configuration', CONF), '.nvmrc': language('Plain text', PLAIN),
  license: language('Plain text', PLAIN), codeowners: language('Configuration', CONF), procfile: language('Configuration', CONF)
}

/**
 * The language of the file at `path`, by its name or extension; none for what is no code nor text
 * (an SVG is a picture). A Windows path written with `\` (`C:\project\Dockerfile`) reaches here so.
 */
export function languageOf (path: string): Language | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('.env')) return BY_EXTENSION.env
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return BY_NAME.dockerfile
  const dot = name.lastIndexOf('.')
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined
}

/** `source` cut into lines of tokens, in `grammar`'s kinds; the plain text between them a token too. */
export function tokenize (source: string, grammar: Grammar): Token[][] {
  const lines: Token[][] = [[]]
  const push = (kind: Kind, text: string) =>
    text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([])
      if (piece === '') return
      const line = lines.at(-1)!
      const last = line.at(-1)
      if (last?.[0] === kind) last[1] += piece
      else line.push([kind, piece])
    })
  let at = 0
  if (grammar.pattern) {
    for (const match of source.matchAll(grammar.pattern)) {
      if (match[0] === '') continue
      if (match.index > at) push('', source.slice(at, match.index))
      push(grammar.kinds[match.slice(1).findIndex(group => group !== undefined)] ?? '', match[0])
      at = match.index + match[0].length
    }
  }
  push('', source.slice(at))
  return lines
}

/**
 * The `rows` lines a preview shows of `text`: the first ones, or from a few before `line` when it
 * names one in the file, that one marked. Tabs are spaces, the indent they all share is cut, a
 * long line is cut. None for a file with no text, or with what text never holds (a NUL).
 */
export function excerptOf (text: string, language: Language, line: number | undefined, rows: number): Excerpt | undefined {
  if (text.trim() === '' || text.includes('\u0000') || (text.slice(0, 4096).match(/�/g)?.length ?? 0) > 8) return undefined
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all.at(-1) === '') all.pop()
  const mark = line !== undefined && line >= 1 && line <= all.length ? line : 0
  const first = mark > 0 ? Math.max(1, Math.min(mark - Math.min(CONTEXT, Math.floor(rows / 3)), all.length - rows + 1)) : 1
  const shown = all.slice(first - 1, first - 1 + rows).map(row => row.replaceAll('\t', TAB).trimEnd())
  while (shown.length > 1 && shown.at(-1) === '' && first + shown.length - 1 !== mark) shown.pop()
  const indent = Math.min(...shown.filter(row => row !== '').map(row => row.length - row.trimStart().length))
  const source = shown.map(row => row.slice(indent).slice(0, LINE_CHARS)).join('\n')
  return { language: language.name, count: all.length, first, mark, source, lines: tokenize(source, language.grammar) }
}
