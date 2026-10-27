import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, Timer } from 'claude-code'

import { LINUX, MACOS, MACOS_VOICES, QUEUE, WINDOWS, WINDOWS_VOICES, dispatcherRate, espeakWords, powershell } from './speaker'
import { cut, finalQuestion, guessLanguage, parseNarration, plain, withQuestion } from './text'

type Platform = 'macos' | 'windows' | 'linux' | 'other'
/** A program that speaks, and what it is told through its environment. */
type Command = { argv: string[]; env: Record<string, string>; program: string; isFallback?: boolean }
/** How a speaker spoke: the voice it used, and whether that is not the one asked for (none matched); or that the line dropped it. */
type Spoke = { voice: string; isFallback: boolean; isSkipped?: boolean }
/**
 * One narration: the model call that writes it, then the program that speaks it, until silenced;
 * once that speaks, how many narrations of other windows wait their turn behind it.
 */
type Narration = { isActive: boolean; abort: AbortController; isSpeaking?: boolean; waiting?: number }
/** The synthesizer found on Linux, the languages it has voices for and their names, lowercased (empty: it did not say). */
type LinuxSpeech = { tool?: 'spd-say' | 'espeak-ng' | 'espeak'; languages: Set<string>; names: Set<string> }

// The switch at the right of the prompt footer, in the style of the mode labels (⏵⏵ auto mode on),
// each in a quiet color, with the words it gives up first where the row is short. While it speaks,
// a click goes on to the next narration in the line, or, with none waiting, stops it. U+FE0E keeps
// the pause, skip and stop signs text glyphs, never emojis.
const SWITCH_ON = { icon: '\u23F5', words: ['narrator on', 'narrator'], color: 'success' } as const
const SWITCH_OFF = { icon: '\u23F8\uFE0E', words: ['narrator off', 'narrator'], color: 'inactive' } as const
const SWITCH_SKIP = { icon: '\u23ED\uFE0E', words: ['narrating'], color: 'permission' } as const
const SWITCH_STOP = { icon: '\u23F9\uFE0E', words: ['narrating'], color: 'permission' } as const
// While it speaks a lighter blue, the theme's own shimmer of it, sweeps the switch from left to
// right: three cells wide, a cell a tenth of a second (the footer redraws ten times a second at
// most), and a pause of four steps between sweeps.
const SHIMMER = 'permissionShimmer'
const SWEEP_MS = 100
const SWEEP_WIDTH = 3
const SWEEP_PAUSE = 4
// The terminal footer's row: two columns of padding at each end, the mode label at the left
// (`⏵⏵ accept edits on ·`, the longest but bypass's) and the hint after it, two columns at least
// between that and what is drawn here.
const FOOTER_PADDING = 4
const FOOTER_GAP = 2
const MODE_LABEL = 20
const SEPARATOR = ' · '
// Room left, when nothing of another plugin is beneath, for one that may wrap the switch and draw
// before it: Sub Meter's shortest meter (`week 100%`) and its separator.
const AROUND = 9 + SEPARATOR.length
// A little quicker than the voice's normal pace, unless the settings say otherwise.
const SPEED = 1.3
const MAX_ACTIONS = 40
const PREVIEW = 'Hello! This is a voice preview for Narrator.'
// The tool inputs that say best what a call did, in order of preference.
const DETAILS = ['description', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'command', 'prompt']
const LANGUAGE_CODE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i
const DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
// What /recap prints when it wrote no recap: nothing to say out loud.
const NO_RECAP = /^(Nothing to recap yet\b|Recap cancelled\.|Couldn't generate a recap\.|\/recap only runs\b|API Error:)/

/** The English name of a language code, or undefined where the runtime's language data does not know it. */
function languageName (code: string) {
  try {
    return DISPLAY_NAMES.of(code)
  } catch {
    return undefined
  }
}

/** The language the narrator is told to speak: the one set, else the one the user wrote in. */
function spoken (language: string) {
  if (!language) return "Speak the language the user wrote the request in; if that is unclear, the language of Claude's final message."
  return `Always speak ${languageName(language) ?? language} (${language}), whatever language the request or Claude's final message is in.`
}

const NARRATOR = (language: string) => `You are the voice of Claude Code, a coding assistant. After each of its turns you speak to the user, out loud, as Claude: in the first person, to them. You are Claude talking to the person, not a narrator talking about them.

You get the user's request, the actions Claude took and Claude's final message. Say what a colleague would say in passing: what was done and how it turned out, plus anything the user has to do or decide now. Leave out how it was done. If Claude only answered a question, give the gist of the answer.

Talk to the user, never about them: address them in the second person ("you"), in the language you speak, never as "the user". And you are Claude: say "I", never "Claude" or "the assistant". When you are given Claude's closing question, it is read right after your words, as Claude wrote it: do not ask it, report it or mention it. Otherwise, if Claude's final message asks the user something, end with that question, asked to them directly as a question ("Do I run the quick test?"), not reported ("I ask whether to run it") and with no label before it.

${spoken(language)}

Rules:
- A speech synthesizer reads it aloud: plain sentences only. No markdown, lists, emojis or code, and no file paths, URLs, hashes or version strings read out character by character: name files and commands the way a person says them ("the register file", "the tests").
- Short: one sentence, two only for a large change; never more than 30 words, plus Claude's question when it asked one.
- No preamble ("Sure", "In summary"), no question of your own, nothing Claude did not say or do.

Reply in exactly this form: the first line holds only the ISO 639-1 code of the language you speak (es, en, pt, fr...), and the narration starts on the second line.`

const enabled = atom({ plugin: 'narrator', key: 'isEnabled' } as const, false)
const speech = atom({ plugin: 'narrator', key: 'speech' } as const, null)
const sweepStep = atom({ plugin: 'narrator', key: 'sweepStep' } as const, 0)

/** An answer this short is read out as it is: no model call to write a narration of it. */
const SHORT_ANSWER = 200

let settings = { voice: '', model: 'haiku', speed: SPEED, shortAnswer: SHORT_ANSWER, language: '', command: '' }
// The main loop's turn so far: the prompt that started it and each tool call it made.
let request = ''
let actions: string[] = []
let current: Narration | undefined
let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
let linuxSpeech: Promise<LinuxSpeech> | undefined
let hasWarned = false
// The hint as last drawn on the terminal, in columns.
let hintWidth = 0
let lastHint = ''
// The language the last narration was said in: a short answer whose words do not tell is read in it.
let spokenLanguage = ''
// The last narration said, for `/narrator again`, and the main loop's last answer with its request, for `/narrator read`.
let lastSaid: { text: string; language: string } | undefined
let lastAnswer: { answer: string; request: string } | undefined
// The sweep across the switch, running while it speaks.
let sweep: Timer | undefined
let isNarratorEnabled = false
let lastCellsText = ''
let lastCells: string[] = []

/**
 * A language setting as its ISO 639 code (`es-MX` is `es`), checked against the language data the
 * runtime ships (`Intl.DisplayNames`), so a typo or any other text is not a language: empty, automatic.
 */
export function languageOf (value: unknown) {
  const code = String(value ?? '').trim()
  const language = LANGUAGE_CODE.test(code) ? code.split(/[-_]/)[0]!.toLowerCase() : ''
  return language && languageName(language) ? language : ''
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One tool call as a line the narrator reads: its tool, then the input that says most. */
function describe (e: object) {
  const input = e as Record<string, unknown>
  const detail = DETAILS.map(key => input[key]).find(value => typeof value === 'string' && value.trim() !== '')
  return detail === undefined ? String(input.tool) : `${String(input.tool)}: ${cut(String(detail).replace(/\s+/g, ' '), 200)}`
}

/** What the narrator is told about the turn, and Claude's closing question, which is read after it as it is. */
function brief (answer: string, question: string) {
  const did = actions.length > 0 ? actions.map(action => `- ${action}`).join('\n') : '(no tools: Claude only answered)'
  return [
    `The user's request:\n<request>\n${cut(request, 2000) || '(none: Claude went on by itself)'}\n</request>`,
    `What Claude did, in order:\n${did}`,
    `Claude's final message to the user:\n<message>\n${cut(answer, 6000)}\n</message>`,
    ...(question ? [`Claude's closing question, read right after your words as it is (do not ask, report or mention it):\n<question>\n${question}\n</question>`] : [])
  ].join('\n\n')
}

/** The system the session runs on, asked once. */
function platformOf ($: EngineInterface) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

/** Whether the session runs under WSL: Linux, on a Windows desktop whose voices are better. */
function wslOf ($: EngineInterface) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/** The language codes listed in a synthesizer's voice table, by their main part (`es` for es-419). */
function languagesIn (table: string) {
  const languages = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const code = line.trim().split(/\s+/).slice(1).find(word => LANGUAGE_CODE.test(word))
    if (code) languages.add(code.split(/[-_]/)[0]!.toLowerCase())
  }
  return languages
}

/** The voice names in `spd-say -L`'s table, lowercased: what comes before each row's language. */
function namesIn (table: string) {
  const names = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const words = line.trim().split(/\s+/)
    const at = words.findIndex((word, i) => i > 0 && LANGUAGE_CODE.test(word))
    if (at > 0) names.add(words.slice(0, at).join(' ').toLowerCase())
  }
  return names
}

/** Which synthesizer Linux has, speech-dispatcher first, and its languages, asked once. */
function linuxSpeechOf ($: EngineInterface) {
  linuxSpeech ??= (async (): Promise<LinuxSpeech> => {
    const found = (await $.process.run(['sh', '-c', 'command -v spd-say espeak-ng espeak']).catch(() => undefined))?.stdout ?? ''
    const paths = found.split('\n').map(path => path.trim())
    const tool = (['spd-say', 'espeak-ng', 'espeak'] as const).find(name => paths.some(path => path.endsWith(`/${name}`)))
    if (!tool) return { languages: new Set(), names: new Set() }
    const listed = await $.process.run(tool === 'spd-say' ? ['spd-say', '-L'] : [tool, '--voices'], { timeoutMs: 5000 }).catch(() => undefined)
    const table = listed?.stdout ?? ''
    return { tool, languages: languagesIn(table), names: tool === 'spd-say' ? namesIn(table) : new Set() }
  })()
  return linuxSpeech
}

/** A speaker that first waits its turn in the line every window shares (PowerShell waits in its own). */
const inLine = (command: Command): Command => ({ ...command, argv: ['sh', '-c', QUEUE, 'narrator-line', ...command.argv] })

/** The programs that can say `text` here, best first; `ticket`, when it was ready, is its place in the line. */
async function speakersFor ($: EngineInterface, text: string, language: string, voice: string, ticket: string): Promise<Command[]> {
  const env = { NARRATOR_TEXT: text, NARRATOR_LANG: language, NARRATOR_VOICE: voice, NARRATOR_SPEED: String(settings.speed), NARRATOR_TICKET: ticket }
  const system = await platformOf($)
  // A speak command of the person's own, run by the system shell with the narration last. On
  // Windows the PowerShell speaker runs it after taking Windows' shared line and falls back itself.
  if (settings.command && system !== 'windows') {
    const argv = ['sh', '-c', LINUX, 'narrator', 'sh', '-c', `exec ${settings.command} "$1"`, 'narrator-command', text]
    return [inLine({ argv, env: { ...env, NARRATOR_SPEAKER: settings.command }, program: settings.command })]
  }
  if (system === 'macos') return [inLine({ argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env, program: 'osascript' })]
  if (system === 'windows') return [{ argv: powershell(WINDOWS), env: settings.command ? { ...env, NARRATOR_SPEAKER: settings.command } : env, program: 'powershell' }]
  if (system !== 'linux') return []

  const speakers: Command[] = []
  if (await wslOf($)) {
    const inherited = await $.env.get('WSLENV')
    const crossing = [inherited, 'NARRATOR_TEXT', 'NARRATOR_LANG', 'NARRATOR_VOICE', 'NARRATOR_SPEED', 'NARRATOR_TICKET'].filter(Boolean).join(':')
    speakers.push({ argv: powershell(WINDOWS, 'powershell.exe'), env: { ...env, WSLENV: crossing }, program: 'powershell.exe' })
  }
  const { tool, languages, names } = await linuxSpeechOf($)
  // A language the synthesizer has no voice for is read by its English voice.
  const lang = language && (languages.size === 0 || languages.has(language) ? language : 'en')
  // At speed 1 no rate is given: the synthesizer keeps the one it is set up with.
  const isPaced = settings.speed !== 1
  if (tool === 'spd-say') {
    const options = [...(lang ? ['-l', lang] : []), ...(voice ? ['-y', voice] : []), ...(isPaced ? ['-r', String(dispatcherRate(settings.speed))] : [])]
    // speech-dispatcher speaks a voice it does not have with its default one, and says nothing.
    const isFallback = voice !== '' && names.size > 0 && !names.has(voice.toLowerCase())
    speakers.push(inLine({ argv: ['sh', '-c', LINUX, 'narrator', 'spd-say', '-w', ...options, '--', text], env: { ...env, NARRATOR_STOP: 'spd-say -S' }, program: 'spd-say', isFallback }))
  } else if (tool) {
    const selectedVoice = voice || lang
    const options = [...(selectedVoice ? ['-v', selectedVoice] : []), ...(isPaced ? ['-s', String(espeakWords(settings.speed))] : [])]
    speakers.push(inLine({ argv: ['sh', '-c', LINUX, 'narrator', tool, ...options, '--', text], env, program: tool }))
  }
  return speakers
}

async function commandOutput ($: EngineInterface, argv: string[]) {
  const result = await $.process.run(argv, { timeoutMs: 10_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`)
  return result.stdout.trim()
}

/** `name<TAB>language` rows as one line per language: `es-ES: Eddy, Mónica`. A voice installed in two qualities is listed once: its name picks the best. */
function formatNamedVoices (output: string) {
  const byLanguage = new Map<string, Set<string>>()
  for (const line of output.split(/\r?\n/).map(row => row.trim()).filter(Boolean)) {
    const [name = '', language = '?'] = line.split('\t')
    byLanguage.set(language, (byLanguage.get(language) ?? new Set()).add(name))
  }
  return [...byLanguage].sort(([a], [b]) => a.localeCompare(b)).map(([language, names]) => `${language}: ${[...names].join(', ')}`)
}

/** Lists voices exposed by this system's speech synthesizers. */
async function listVoices ($: EngineInterface) {
  const system = await platformOf($)
  if (system === 'macos') {
    const output = await commandOutput($, ['osascript', '-l', 'JavaScript', '-e', MACOS_VOICES])
    const voices = formatNamedVoices(output)
    return voices.length ? `Installed voices:\n${voices.join('\n')}` : 'Narrator: no installed voices found.'
  }
  if (system === 'windows') {
    const output = await commandOutput($, powershell(WINDOWS_VOICES))
    const voices = formatNamedVoices(output)
    return voices.length ? `Installed voices:\n${voices.join('\n')}` : 'Narrator: no installed voices found.'
  }
  if (system !== 'linux') return 'Narrator: voice discovery is not supported on this system.'

  const sections: string[] = []
  const failures: string[] = []
  if (await wslOf($)) {
    try {
      const output = await commandOutput($, powershell(WINDOWS_VOICES, 'powershell.exe'))
      const voices = formatNamedVoices(output)
      if (voices.length) sections.push(`Windows voices:\n${voices.join('\n')}`)
    } catch (error) {
      failures.push(`Windows: ${message(error)}`)
    }
  }
  const found = await commandOutput($, ['sh', '-c', 'for tool in spd-say espeak-ng espeak; do command -v "$tool" || true; done'])
  const paths = found.split('\n').map(path => path.trim())
  const has = (name: string) => paths.some(path => path.endsWith(`/${name}`))
  if (has('spd-say')) {
    try {
      const output = await commandOutput($, ['spd-say', '-L'])
      if (output) sections.push(`Speech Dispatcher voices (its output module's; pass a NAME to /narrator test):\n${output}`)
    } catch (error) {
      failures.push(`Speech Dispatcher: ${message(error)}`)
    }
  }
  const espeak = has('espeak-ng') ? 'espeak-ng' : has('espeak') ? 'espeak' : undefined
  if (espeak) {
    try {
      const output = await commandOutput($, [espeak, '--voices'])
      if (output) sections.push(`${espeak} voices:\n${output}`)
    } catch (error) {
      failures.push(`${espeak}: ${message(error)}`)
    }
  }
  if (!sections.length && failures.length) return `Narrator: could not list voices. ${failures.join('; ')}`
  if (!sections.length) return 'Narrator: no installed voices found.'
  if (failures.length) sections.push(`Some voices could not be listed: ${failures.join('; ')}`)
  return sections.join('\n\n')
}

/** Shows on the switch whether this session's narration is speaking, and how many wait behind it; while it does, sweeps it. */
async function showSpeech ($: EngineInterface) {
  const speaking = current?.isSpeaking ? { waiting: current.waiting ?? 0 } : null
  await update($, speech, () => speaking)
  if (speaking && !sweep) sweep = $.clock.every(SWEEP_MS, () => void update($, sweepStep, step => step + 1))
  if (!speaking && sweep) {
    sweep.cancel()
    sweep = undefined
    await update($, sweepStep, () => 0)
  }
}

/** Follows what a speaker says of itself: `voice` once it speaks, `waiting <n>` while others wait their turn. */
async function follow ($: EngineInterface, narration: Narration, said: string) {
  const isSpeaking = narration.isSpeaking === true || /^voice /m.test(said)
  const told = [...said.matchAll(/^waiting (\d+)\r?$/gm)].at(-1)?.[1]
  const waiting = told === undefined ? narration.waiting ?? 0 : Number(told)
  if (isSpeaking === (narration.isSpeaking === true) && waiting === (narration.waiting ?? 0)) return
  narration.isSpeaking = isSpeaking
  narration.waiting = waiting
  await showSpeech($)
}

/** Runs one speaker till it ends or the narration is silenced; how it spoke, if it did. */
async function play ($: EngineInterface, narration: Narration, command: Command): Promise<Spoke | undefined> {
  let said = ''
  let failure = ''
  try {
    for await (const { text } of $.process.spawn(command)) {
      said = (said + text.replace(/^\.\r?$/gm, '')).slice(-4000)
      if (!narration.isActive) break
      await follow($, narration, said)
    }
  } catch (error) {
    failure = message(error)
  } finally {
    if (narration.isSpeaking) {
      narration.isSpeaking = false
      await showSpeech($)
    }
  }
  // A custom Windows command can fail after naming itself, then the system synthesizer names the
  // voice it falls back to. The last voice line is therefore the one that actually finished.
  const voice = [...said.matchAll(/^voice (.+?)\r?$/gm)].at(-1)?.[1]
  // Behind others for too long: the line dropped it, and nothing else should say it now.
  if (/^skipped\r?$/m.test(said)) {
    $.ui.log('narrator: not said, the line of narrations from other sessions was too long', { to: 'debug' })
    return { voice: '', isFallback: false, isSkipped: true }
  }
  failure ||= /^error.*$/m.exec(said)?.[0] ?? (voice ? '' : `${command.program} said nothing`)
  // End the whole Windows process tree: under WSL its side outlives the pipe, and a native custom
  // speak command is a child of PowerShell which would otherwise outlive its supervisor.
  const pid = /^pid (\d+)/m.exec(said)?.[1]
  if (!narration.isActive && pid && (command.program === 'powershell' || command.program === 'powershell.exe')) {
    await $.process.run(['taskkill.exe', '/PID', pid, '/T', '/F']).catch(() => undefined)
  }
  if (!narration.isActive) return undefined
  $.ui.log(failure ? `narrator: ${command.program}: ${failure}` : `narrator: spoke with ${voice}`, { to: 'debug' })
  return failure === '' ? { voice: voice!, isFallback: command.isFallback === true || /^no voice /m.test(said) } : undefined
}

/** Says `text` with the best speaker that works here, the engine's own synthesizer last; how, if it did. */
async function speak ($: EngineInterface, narration: Narration, text: string, language: string, voice = settings.voice): Promise<Spoke | undefined> {
  // Every window shares one line, so two sessions that finish together are said one after the other.
  const ticket = String(await $.clock.now()).padStart(13, '0')
  for (const command of await speakersFor($, text, language, voice, ticket)) {
    const spoke = await play($, narration, command)
    if (spoke || !narration.isActive) return spoke
  }
  try {
    await $.audio.speak(text, voice ? { voice } : undefined)
    return { voice: voice || "Claude Code's own voice", isFallback: false }
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
    if (hasWarned) return undefined
    hasWarned = true
    const system = await platformOf($)
    $.ui.toast(system === 'linux'
      ? 'Narrator: no voice to speak with. Install speech-dispatcher (spd-say) or espeak-ng.'
      : `Narrator: no voice to speak with (${message(error)}).`)
    return undefined
  }
}

/** Says a short sample with `voice` (empty: the one picked for English), and what came of it. */
async function testVoice ($: EngineInterface, voice: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    const spoke = await speak($, narration, PREVIEW, 'en', voice)
    if (!narration.isActive) return 'Narrator: preview stopped.'
    if (!spoke) return 'Narrator: could not play the voice preview.'
    if (spoke.isSkipped) return 'Narrator: not previewed, other sessions are speaking. Try again in a moment.'
    if (voice && spoke.isFallback) return `Narrator: there is no voice "${voice}", so the preview used ${spoke.voice}. /narrator voices lists the installed ones.`
    return `Narrator: previewed ${voice || spoke.voice}.`
  } catch (error) {
    $.ui.log(`narrator: voice preview: ${message(error)}`, { to: 'debug' })
    return `Narrator: could not play the voice preview. ${message(error)}`
  } finally {
    narration.isActive = false
    if (current === narration) current = undefined
  }
}

/** Stops what is being said, and the narration being written. */
function silence () {
  if (!current) return
  current.isActive = false
  current.abort.abort()
  current = undefined
}

/** Tells, out loud, what the turn that ended with `answer` did. */
async function narrate ($: EngineInterface, answer: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    // A short answer already says it: read it out, with no model call to retell it, once its language
    // is known (macOS tells it from the text). With a language set, only when its words or the request
    // tell it is in that language: any other, the model says in it.
    const direct = plain(answer)
    const ownLanguage = guessLanguage(answer) || guessLanguage(`${request}\n${answer}`)
    const directLanguage = ownLanguage || spokenLanguage
    const isReadable = settings.language ? ownLanguage === settings.language : directLanguage !== '' || (await platformOf($)) === 'macos'
    if (direct !== '' && direct.length <= settings.shortAnswer && isReadable) {
      spokenLanguage = directLanguage
      lastSaid = { text: direct, language: directLanguage }
      await speak($, narration, direct, directLanguage)
      return
    }
    // The language to speak: the setting, else the request's when its words tell it. The model is told
    // it in so many words: left to tell it from a request in one language and tool calls in another, it
    // sometimes narrates in the wrong one.
    const asked = settings.language || guessLanguage(request)
    // Claude's closing question is said as Claude wrote it, after the narration: the model, asked to
    // pass it on, sometimes reports it ("I ask whether to do it") or drops it. Only when the answer is in
    // the language to speak: a question in another one is left to the model to ask in it.
    const answerLanguage = guessLanguage(answer)
    const question = asked !== '' && answerLanguage !== '' && answerLanguage !== asked ? '' : finalQuestion(answer)
    const reply = await $.model.complete(
      // A short summary: no deep thinking, so it is said right after the turn.
      { model: settings.model, system: NARRATOR(asked), prompt: brief(answer, question), maxTokens: 150, effort: 'low', timeoutMs: 30_000 },
      { signal: narration.abort.signal }
    ).catch(() => undefined)
    if (!narration.isActive) return
    const told = reply?.isAnswered ? parseNarration(reply.text) : undefined
    // A narration in another language than the request's is not said, whatever code the model wrote:
    // its words tell. The setting is left to the model, as the answer may be in neither.
    const toldLanguage = told ? guessLanguage(told.text) || told.language : ''
    const isOtherLanguage = !settings.language && asked !== '' && toldLanguage !== '' && toldLanguage !== asked
    if (isOtherLanguage) $.ui.log(`narrator: the model narrated in ${toldLanguage}, not ${asked}: reading the answer instead`, { to: 'debug' })
    // No narration written, or not in the request's language: the answer itself, as far as it reads aloud.
    const { text, language } = told?.text && !isOtherLanguage ? told : { text: cut(direct, 250), language: directLanguage }
    const said = withQuestion(text, question)
    if (!said) return
    // The voice follows the words, not the code the model wrote: a narration in English is never read
    // by a Spanish voice.
    const saidLanguage = guessLanguage(said) || language
    if (saidLanguage) spokenLanguage = saidLanguage
    lastSaid = { text: said, language: saidLanguage }
    await speak($, narration, said, saidLanguage)
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
  } finally {
    if (current === narration) current = undefined
  }
}

/** Says `text` again, as it is, in place of whatever is being said: the last narration, or an answer read in full. */
async function retell ($: EngineInterface, text: string, language: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    await speak($, narration, text, language)
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
  } finally {
    if (current === narration) current = undefined
  }
}

/** `/narrator again`: the last narration, said again with no model call. */
function sayAgain ($: EngineInterface) {
  if (!lastSaid) return 'Narrator: nothing said yet.'
  void retell($, lastSaid.text, lastSaid.language)
  return 'Narrator: saying it again.'
}

/** `/narrator read`: the last answer in full, as plain text, in the language its words or its request tell. */
function readAnswer ($: EngineInterface) {
  if (!lastAnswer) return 'Narrator: no answer to read yet.'
  const { answer, request: asked } = lastAnswer
  const text = plain(answer)
  if (!text) return 'Narrator: the last answer has nothing to read aloud.'
  void retell($, text, guessLanguage(answer) || guessLanguage(`${asked}\n${answer}`) || spokenLanguage || settings.language)
  return 'Narrator: reading the last answer.'
}

/** A click on the switch: while it speaks, on to the next narration in the line or quiet; else on or off. */
function press ($: EngineInterface) {
  if (current?.isSpeaking) return silence()
  void setEnabled($)
}

/** Switches the narrator on or off (no `value`: the other way), and keeps it for the next sessions. */
async function setEnabled ($: EngineInterface, value?: boolean) {
  let isEnabled = false
  await update($, enabled, now => (isEnabled = value ?? !now))
  isNarratorEnabled = isEnabled
  if (!isEnabled) silence()
  await $.store.set('enabled', isEnabled)
  return isEnabled
}

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

/** Columns a text takes: one per character, none for a variation selector. */
const widthOf = (text: string) => [...text.replace(/[\uFE0E\uFE0F]/g, '')].length

/** A text's cells: one per character, a variation selector kept with the one before it. */
function cellsOf (text: string) {
  if (text === lastCellsText) return lastCells
  const cells: string[] = []
  for (const char of text) {
    if (/[\uFE0E\uFE0F]/.test(char) && cells.length > 0) cells[cells.length - 1] += char
    else cells.push(char)
  }
  lastCellsText = text
  lastCells = cells
  return cells
}

/** A label cut where the sweep is at `step`: before it, under it (empty between sweeps) and after it. */
function sweptAt (label: string, step: number) {
  const cells = cellsOf(label)
  const at = (step % (cells.length + SWEEP_WIDTH + SWEEP_PAUSE)) - SWEEP_WIDTH
  const start = Math.min(Math.max(at, 0), cells.length)
  const end = Math.min(Math.max(at + SWEEP_WIDTH, 0), cells.length)
  return [cells.slice(0, start), cells.slice(start, end), cells.slice(end)].map(part => part.join(''))
}

/** Columns a drawing beneath takes on one row; the engine's own node draws `modes`, joined by ` & `. */
function widthOfNode (node: RenderNode | undefined, modes: readonly string[]): number {
  if (node === undefined || node === null) return 0
  if (typeof node === 'string') return widthOf(node)
  if (node.type === 'engine') return widthOf(modes.join(' & '))
  return (node.children ?? []).reduce((sum, child) => sum + widthOfNode(child, modes), 0)
}

/** Whether a drawing beneath holds another plugin's: the engine stamps each hook's root with its plugin. */
function holdsPlugin (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null || typeof node === 'string' || node.type === 'engine') return false
  return 'part' in node || (node.children ?? []).some(holdsPlugin)
}

/** Columns the footer leaves at its right end on the terminal, beside the mode label and the hint; elsewhere, no limit. */
function roomOf (e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== 'terminal' || e.viewport === undefined) return Infinity
  return e.viewport.columns - FOOTER_PADDING - FOOTER_GAP - MODE_LABEL - (hintWidth > 0 ? 1 + hintWidth : 0)
}

export const register: Register = (on, options) => {
  // Whether someone is at the session. Until session.start says otherwise (a mod loaded in the middle
  // of a session does not see it), someone is.
  let isInteractive = true
  isNarratorEnabled = false
  lastHint = ''
  const speed = Number(options.speed)
  const shortAnswer = Number(options.shortAnswer ?? SHORT_ANSWER)
  settings = {
    voice: String(options.voice ?? '').trim(),
    model: String(options.model || 'haiku'),
    speed: speed > 0 ? speed : SPEED,
    shortAnswer: shortAnswer >= 0 ? shortAnswer : SHORT_ANSWER,
    language: languageOf(options.language),
    command: String(options.command ?? '').trim()
  }

  on('session.start', async ($, e, next) => {
    // A session nobody is at (`claude -p`: a script, a bot that runs Claude Code) is not narrated.
    isInteractive = e.isInteractive
    const asked = String(options.language ?? '').trim()
    if (asked && !settings.language) $.ui.log(`narrator: "${cut(asked, 40)}" is not a language code (es, en, pt...): speaking the language you write in`, { to: 'debug' })
    await $.command.register({
      name: 'narrator',
      description: 'Claude tells you out loud what it did after each turn · no argument: switch on or off',
      argumentHint: '[on | off | stop | again | read | voices | test [voice]]',
      immediate: true
    })
    const isEnabled = (await $.store.get('enabled')) === true
    isNarratorEnabled = isEnabled
    await update($, enabled, () => isEnabled)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    silence()
    return next(e)
  })

  on('command.run', { command: 'narrator' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'voices') {
      try {
        return { text: await listVoices($) }
      } catch (error) {
        return { text: `Narrator: could not list voices. ${message(error)}` }
      }
    }
    const test = /^test(?:\s+([\s\S]+))?$/i.exec(e.args.trim())
    if (test) {
      const named = (test[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
      return { text: await testVoice($, named || settings.voice) }
    }
    if (arg === 'stop') {
      silence()
      return { text: 'Narrator: quiet.' }
    }
    if (arg === 'again') return { text: sayAgain($) }
    if (arg === 'read') return { text: readAnswer($) }
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Usage: /narrator [on | off | stop | again | read | voices | test [voice]]' }
    const isEnabled = await setEnabled($, arg === '' ? undefined : arg === 'on')
    return { text: isEnabled ? 'Narrator on: Claude will tell you out loud what it did after each turn.' : 'Narrator off.' }
  })

  // A new prompt means the person has moved on: stop talking.
  on('prompt.submit', ($, e, next) => {
    silence()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.text) request = e.text
      actions = []
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (isInteractive && isNarratorEnabled && e.agentId === undefined && actions.length < MAX_ACTIONS) {
      actions.push(describe(e) + (result.deny !== undefined ? ' (denied)' : result.isError ? ' (failed)' : ''))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Kept on or off, so `/narrator read` can read it whenever it is asked.
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim()) lastAnswer = { answer: e.answer, request }
    if (isInteractive && isNarratorEnabled && e.agentId === undefined && e.reason === 'answer' && e.answer.trim()) void narrate($, e.answer)
    return result
  })

  on('command.run', { command: 'recap' }, async ($, e, next) => {
    silence()
    const result = await next(e)
    if (isInteractive && isNarratorEnabled && result.text?.trim() && !NO_RECAP.test(result.text)) {
      actions = []
      void narrate($, result.text)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The switch, last in the footer's right end: a click turns the narrator on or off, and while it
  // speaks, skips to the next narration in the line or stops it.
  // A language that is set shows after the words (`⏵ narrator on · ES`); automatic shows none.
  // Where the row is short it gives up "on" or "off", then the language, then "narrator" (or
  // "narrating"): its sign and color still tell.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [isEnabled, speaking] = await Promise.all([read($, enabled), read($, speech)])
    const step = speaking ? await read($, sweepStep) : 0
    // Beneath: the engine's mode labels, or another plugin's drawing there.
    const beneath = await next(e)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { icon, words, color } = speaking ? (speaking.waiting > 0 ? SWITCH_SKIP : SWITCH_STOP) : isEnabled ? SWITCH_ON : SWITCH_OFF
    const room = roomOf(e) -
      (hasBeneath ? widthOfNode(beneath, e.props.modes) + SEPARATOR.length : 0) -
      (holdsPlugin(beneath) ? 0 : AROUND)
    const tag = settings.language ? `${SEPARATOR}${settings.language.toUpperCase()}` : ''
    const labels = [...words.map(word => `${icon} ${word}${tag}`), `${icon} ${words.at(-1)}`]
    const label = labels.find(text => widthOf(text) <= room) ?? icon
    const [before, under, after] = speaking ? sweptAt(label, step) : [label, '', '']

    return (
      <Box flexDirection="row">
        {hasBeneath ? beneath : null}
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        <Button key="narrator" plain onPress={() => press($)}>
          <Text color={color}>
            {before || null}
            {under ? <Text color={SHIMMER}>{under}</Text> : null}
            {after || null}
          </Text>
        </Button>
      </Box>
    )
  })

  // The hint line beside the mode label: its width tells the switch how much room is left.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal' && e.props.hint !== lastHint) {
      lastHint = e.props.hint
      const width = widthOf(e.props.hint)
      if (width !== hintWidth) {
        hintWidth = width
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })
}
