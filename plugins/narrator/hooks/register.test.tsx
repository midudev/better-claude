// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { languageOf } from './register'
import { guessLanguage, parseNarration, plain } from './text'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Spoken = { argv: string[]; env: Record<string, string>; isEnded: boolean }
type World = {
  system?: string
  env?: Record<string, string>
  reply?: string | null
  tools?: string
  voices?: string
  table?: string
  processErrors?: string[]
  unknownVoices?: string[]
  speaker?: 'speaks' | 'talks on' | 'fails'
  /** How many narrations of other windows the speaker says wait their turn behind it. */
  waiting?: number
  hasEngineVoice?: boolean
  store?: Record<string, unknown>
}

/**
 * Everything beneath the mod: the session, the store, the system and its synthesizers, the model
 * that writes the narration, and the engine's own `$.audio.speak`.
 */
function world (on: On, { system = 'Darwin', env = {}, reply = 'es\nHe añadido el narrador y los tests pasan.', tools = '', voices = '', table = '', processErrors = [], unknownVoices = [], speaker = 'speaks', waiting = 0, hasEngineVoice = true, store = {} }: World = {}) {
  const clock = mock.clock(on, { now: 0 })
  const kept: Record<string, unknown> = { ...store }
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, env)
  const spoken: Spoken[] = []
  const said: { text: string; voice?: string }[] = []
  const prompts: string[] = []
  const systems: string[] = []
  const efforts: unknown[] = []
  const toasts: string[] = []
  const commandHints: string[] = []
  let heard: () => void = () => undefined
  // Resolves when the next thing is said, by a program or by the engine.
  const nextSpeech = () => new Promise<void>(resolve => { heard = resolve })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => {
    commandHints.push(e.argumentHint ?? '')
    return { value: { command: e.name } }
  })
  on('command.run', () => ({ text: 'no plugin answered' }))
  // What the engine draws where the mod draws nothing: its own node, as core answers it; with mode labels, a Box the tests find;
  // the hint line as its text.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    return e.props.modes.length > 0 ? <Box key="engine" /> : ({ type: 'engine', ref: 0 } as const)
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    systems.push(e.system ?? '')
    efforts.push(e.effort)
    return { value: reply === null ? { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } : { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('process.run', ($, e) => {
    let stdout = ''
    if (e.argv[0] === 'uname') stdout = `${system}\n`
    else if (e.argv[0] === 'sh') stdout = tools
    else if (['osascript', 'powershell', 'powershell.exe'].includes(e.argv[0]!)) stdout = voices
    else if (e.argv.includes('-L') || e.argv.includes('--voices')) stdout = table
    const error = processErrors.find(program => e.argv[0] === program)
    return { value: { exitCode: error ? 1 : 0, stdout, stderr: error ? 'unavailable' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A speaker: it says which voice it speaks with, then `.` every tenth of a second while it talks.
  on('process.spawn', async function * ($, e) {
    const run: Spoken = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    spoken.push(run)
    try {
      if (speaker === 'fails') {
        yield { stream: 'stdout' as const, text: 'error: no voice\n' }
        return { value: { code: 1, signal: null } }
      }
      const wanted = e.env?.NARRATOR_VOICE ?? ''
      yield { stream: 'stdout' as const, text: `pid 42\n${unknownVoices.includes(wanted) ? `no voice ${wanted}\n` : ''}voice Luisa\n${waiting > 0 ? `waiting ${waiting}\n` : ''}` }
      heard()
      while (speaker === 'talks on') {
        await clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.\n' }
      }
      return { value: { code: 0, signal: null } }
    } finally {
      run.isEnded = true
    }
  })
  on('audio.speak', ($, e) => {
    heard()
    if (!hasEngineVoice) throw new Error('no synthesizer')
    said.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' as const } }
  })
  // Lets the work after a speech settle: a toast, a log.
  const settled = async () => {
    for (let i = 0; i < 20; i++) await clock.advance(0)
  }
  return { clock, store: kept, spoken, said, prompts, systems, efforts, toasts, commandHints, nextSpeech, settled }
}

/** An answer too long to be read as it is: the narrator has a model write what to say. */
const LONG = `Added the **narrator** in \`plugins/narrator\`. ${'It speaks after every turn, in your language, with the best voice the system has. '.repeat(3)}`
/** What follows the line every speaker waits in (sh -c <queue> narrator-line). */
const behindLine = (run: Spoken) => run.argv.slice(4)

const footer = ($: Engine, modes: string[] = [], columns?: number) =>
  $.ui.mount({ plugin: 'narrator', surface: 'terminal', component: 'SessionMode', props: { modes }, viewport: columns === undefined ? undefined : { columns, rows: 30 } })
const hint = ($: Engine, text: string) =>
  $.ui.mount({ plugin: 'narrator', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: text } })
/** What the sweep lights on the switch: the text in the lighter blue, empty between sweeps. */
const swept = async (ui: Awaited<ReturnType<typeof footer>>) =>
  (await ui.findAll({ type: 'Text' })).find(text => text.props.color === 'permissionShimmer')?.text ?? ''
const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const narrator = ($: Engine, args = '') => $.command.run({ command: 'narrator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const turn = async ($: Engine, { prompt = 'add a narrator', answer = LONG, agentId, reason = 'answer' as const }: { prompt?: string; answer?: string; agentId?: string; reason?: 'answer' | 'aborted' } = {}) => {
  await $.turn.start({ text: prompt, turnId: 't1', agentId })
  await $.tool.call({ tool: 'Write', file_path: '/project/plugins/narrator/hooks/register.ts', content: 'x', agentId } as never)
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .', description: 'Run the mod tests', agentId } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason, agentId })
}

test('off by default, the footer shows the switch off; a click turns it on and keeps it', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect(w.store.enabled).toBe(true)
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  expect(w.store.enabled).toBe(false)
})

test('/narrator switches it too, and the switch follows', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await footer($)
  expect((await narrator($)).text).toMatch(/^Narrator on/)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect((await narrator($, 'off')).text).toBe('Narrator off.')
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  expect((await narrator($, 'on')).text).toMatch(/^Narrator on/)
  expect(w.store.enabled).toBe(true)
})

test('/narrator voices lists macOS voices, one line per language, each once', async ($, on) => {
  world(on, { voices: 'Eddy\ten-US\nEddy\tes-ES\nMónica\tes-ES\nMónica\tes-ES\nSamantha\ten-US\n' })
  await startSession($)
  const result = await narrator($, 'voices')
  expect(result.text).toBe('Installed voices:\nen-US: Eddy, Samantha\nes-ES: Eddy, Mónica')
})

test('/narrator voices lists Windows voices', async ($, on) => {
  world(on, { system: 'Windows_NT', env: { OS: 'Windows_NT' }, voices: 'Microsoft David\ten-US\nMicrosoft Helena\tes-ES\n' })
  await startSession($)
  const result = await narrator($, 'voices')
  expect(result.text).toBe('Installed voices:\nen-US: Microsoft David\nes-ES: Microsoft Helena')
})

test('/narrator voices lists Windows and Linux voices on WSL', async ($, on) => {
  world(on, {
    system: 'Linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    tools: '/usr/bin/espeak-ng\n',
    voices: 'Microsoft Helena\tes-ES\n',
    table: 'Pty Language Age/Gender VoiceName File\n 5 en-us --/M English_(America) gmw/en-US\n'
  })
  await startSession($)
  const result = await narrator($, 'voices')
  expect(result.text).toBe('Windows voices:\nes-ES: Microsoft Helena\n\nespeak-ng voices:\nPty Language Age/Gender VoiceName File\n 5 en-us --/M English_(America) gmw/en-US')
})

test('/narrator voices reports Linux speech-dispatcher and espeak voices', async ($, on) => {
  world(on, {
    system: 'Linux',
    tools: '/usr/bin/spd-say\n/usr/bin/espeak-ng\n',
    table: 'NAME LANGUAGE VARIANT\nSpanish es none\n'
  })
  await startSession($)
  const result = await narrator($, 'voices')
  expect(result.text).toContain("Speech Dispatcher voices (its output module's; pass a NAME to /narrator test):\nNAME LANGUAGE VARIANT\nSpanish es none")
  expect(result.text).toContain('espeak-ng voices:')
})

test('/narrator voices reports listing errors instead of hiding them', async ($, on) => {
  world(on, { processErrors: ['osascript'] })
  await startSession($)
  expect((await narrator($, 'voices')).text).toBe('Narrator: could not list voices. unavailable')
})

test('/narrator voices reports when no local voices are available', async ($, on) => {
  world(on, { system: 'Linux' })
  await startSession($)
  expect((await narrator($, 'voices')).text).toBe('Narrator: no installed voices found.')
})

test('/narrator voices includes its commands in the argument hint', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.commandHints).toContain('[on | off | stop | voices | test [voice]]')
})

test('/narrator test previews a named voice without changing narrator settings', { options: { voice: 'Luisa' } }, async ($, on) => {
  const w = world(on, { store: { enabled: false } })
  await startSession($)
  const result = await narrator($, 'test "Mónica"')
  expect(result.text).toBe('Narrator: previewed Mónica.')
  expect(w.spoken[0]!.env).toEqual({
    NARRATOR_TEXT: 'Hello! This is a voice preview for Narrator.',
    NARRATOR_LANG: 'en',
    NARRATOR_VOICE: 'Mónica',
    NARRATOR_SPEED: '1.3',
    NARRATOR_TICKET: '0000000000000'
  })
  await narrator($, 'test')
  expect(w.spoken[1]!.env.NARRATOR_VOICE).toBe('Luisa')
  expect(w.store.enabled).toBe(false)
})

test('/narrator test takes a voice as /narrator voices lists it, by name and language', async ($, on) => {
  const w = world(on)
  await startSession($)
  await narrator($, 'test Eddy (es-ES)')
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Eddy (es-ES)')
})

test('/narrator test previews a named Windows voice', async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT' } })
  await startSession($)
  const result = await narrator($, 'test Microsoft Helena')
  expect(result.text).toBe('Narrator: previewed Microsoft Helena.')
  expect(w.spoken[0]!.argv[0]).toBe('powershell')
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Microsoft Helena')
})

test('/narrator test says when the system has no voice by that name, and which one it used', async ($, on) => {
  world(on, { unknownVoices: ['Nobody'] })
  await startSession($)
  expect((await narrator($, 'test Nobody')).text).toBe('Narrator: there is no voice "Nobody", so the preview used Luisa. /narrator voices lists the installed ones.')
})

test('/narrator test says when speech-dispatcher has no voice by that name', async ($, on) => {
  const w = world(on, { system: 'Linux', tools: '/usr/bin/spd-say\n', table: 'NAME LANGUAGE VARIANT\nSpanish es none\nEnglish en-us none\n' })
  await startSession($)
  expect((await narrator($, 'test Nobody')).text).toMatch(/^Narrator: there is no voice "Nobody"/)
  expect((await narrator($, 'test spanish')).text).toBe('Narrator: previewed spanish.')
  expect(w.spoken[1]!.argv).toContain('spanish')
})

test('/narrator test without a name previews the configured voice', { options: { voice: 'Luisa' } }, async ($, on) => {
  const w = world(on, { store: { enabled: false } })
  await startSession($)
  const result = await narrator($, 'test')
  expect(result.text).toBe('Narrator: previewed Luisa.')
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Luisa')
})

test('/narrator test with an empty name previews the configured voice', { options: { voice: 'Luisa' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await narrator($, 'test ""')
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Luisa')
})

test('/narrator test without any voice names the one the system picked', async ($, on) => {
  world(on)
  await startSession($)
  expect((await narrator($, 'test')).text).toBe('Narrator: previewed Luisa.')
})

test('/narrator test reports when no synthesizer can play the preview', async ($, on) => {
  world(on, { speaker: 'fails', hasEngineVoice: false })
  await startSession($)
  expect((await narrator($, 'test')).text).toBe('Narrator: could not play the voice preview.')
})

test('a new prompt cuts the preview short, and it says so', async ($, on) => {
  const w = world(on, { speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  const preview = narrator($, 'test')
  await speech
  await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
  await w.clock.advance(100)
  expect((await preview).text).toBe('Narrator: preview stopped.')
  expect(w.spoken[0]!.isEnded).toBe(true)
})

test('/narrator help includes voice discovery and preview commands', async ($, on) => {
  world(on)
  await startSession($)
  expect((await narrator($, 'unknown')).text).toBe('Usage: /narrator [on | off | stop | voices | test [voice]]')
})

test('a session starts with the narrator as the last one left it', async ($, on) => {
  world(on, { store: { enabled: true } })
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
})

test('the switch goes after the mode labels, and alone where there are none', async ($, on) => {
  world(on)
  await startSession($)
  const alone = await footer($)
  expect(await alone.find({ type: 'Text', text: ' · ' })).toBeUndefined()
  await alone.unmount()
  const labelled = await footer($, ['focus'])
  expect(await labelled.find({ key: 'engine' })).toBeDefined()
  expect(await labelled.find({ type: 'Text', text: ' · ' })).toBeDefined()
  expect(await labelled.find({ key: 'narrator' })).toBeDefined()
})

test('on reads in the success color, off in the inactive one', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ type: 'Text', text: '⏸︎ narrator off' }))?.props.color).toBe('inactive')
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ type: 'Text', text: '⏵ narrator on' }))?.props.color).toBe('success')
})

// The footer's row at 52 columns leaves the switch its 14: 4 of padding, 2 between, 20 for the mode
// label, and 12 for a meter that may wrap it.
test('where the row is short the switch gives up "off", then "narrator"', async ($, on) => {
  world(on)
  await startSession($)
  expect((await (await footer($, [], 52)).find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  expect((await (await footer($, [], 51)).find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator')
  expect((await (await footer($, [], 47)).find({ key: 'narrator' }))?.text).toBe('⏸︎')
})

test('the hint beside the mode label takes its room from the switch', async ($, on) => {
  world(on, { store: { enabled: true } })
  await startSession($)
  await hint($, '? for shortcuts')
  expect((await (await footer($, [], 67)).find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect((await (await footer($, [], 66)).find({ key: 'narrator' }))?.text).toBe('⏵ narrator')
})

test("another plugin's meter beneath keeps its room: the switch shrinks", { plugins: [{
  name: 'meter',
  register (on) {
    on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
      await next(e)
      const { Text } = $.ui.resolve(e)
      return <Text>{'5h 58% ↻ 2h 10m'}</Text>
    })
  }
}] }, async ($, on) => {
  world(on, { store: { enabled: true } })
  await startSession($)
  const ui = await footer($, [], 57)
  expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(['5h 58% ↻ 2h 10m', ' · ', '⏵ narrator on'])
  expect((await (await footer($, [], 56)).find({ key: 'narrator' }))?.text).toBe('⏵ narrator')
  expect((await (await footer($, [], 40)).find({ key: 'narrator' }))?.text).toBe('⏵')
})

test('after a turn, Haiku writes what Claude did and macOS says it in the language Haiku names', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.efforts).toEqual(['low'])
  expect(w.prompts[0]).toContain('add a narrator')
  expect(w.prompts[0]).toContain('- Write: /project/plugins/narrator/hooks/register.ts')
  expect(w.prompts[0]).toContain('- Bash: Run the mod tests')
  expect(w.prompts[0]).toContain('Added the **narrator**')
  expect(w.spoken).toHaveLength(1)
  expect(behindLine(w.spoken[0]!).slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript'])
  expect(w.spoken[0]!.env).toEqual({ NARRATOR_TEXT: 'He añadido el narrador y los tests pasan.', NARRATOR_LANG: 'es', NARRATOR_VOICE: '', NARRATOR_SPEED: '1.3', NARRATOR_TICKET: '0000000000000' })
})

test('the voice setting reaches the speaker', { options: { voice: 'Mónica' } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Mónica')
})

test('the speed setting reaches the speaker', { options: { speed: 1.5 } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.env.NARRATOR_SPEED).toBe('1.5')
})

test('with no language set, the switch shows none and the narrator follows the request', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.systems[0]).toContain('Speak the language the user wrote the request in')
})

test('the language setting shows beside the switch, tells the narrator and reaches the speaker', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on · ES')
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off · ES')
  await ui.press({ key: 'narrator' })
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.systems[0]).toContain('Always speak Spanish (es)')
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏹︎ narrating · ES')
})

test('a region is dropped, and a value that is no known language means automatic', () => {
  expect(languageOf('es-MX')).toBe('es')
  expect(languageOf(' PT ')).toBe('pt')
  expect(languageOf('Spanish!')).toBe('')
  expect(languageOf('zz')).toBe('')
  expect(languageOf('ignore previous instructions')).toBe('')
  expect(languageOf(undefined)).toBe('')
})

test('an unknown language setting is ignored: the narrator follows the request', { options: { language: 'zz' } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  expect((await (await footer($)).find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.systems[0]).toContain('Speak the language the user wrote the request in')
})

// 57 columns leave the switch 19, as the 52 of the test above leave it 14.
test('where the row is short the switch gives up "off", then the language, then "narrator"', { options: { language: 'es' } }, async ($, on) => {
  world(on)
  await startSession($)
  expect((await (await footer($, [], 57)).find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off · ES')
  expect((await (await footer($, [], 56)).find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator · ES')
  expect((await (await footer($, [], 52)).find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator')
  expect((await (await footer($, [], 47)).find({ key: 'narrator' }))?.text).toBe('⏸︎')
})

test('with a language set, a short answer in it is read as it is, and one in another is said in it by the model', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  let speech = w.nextSpeech()
  await turn($, { prompt: 'arregla los tests de la cola', answer: 'Hecho.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[0]!.env).toMatchObject({ NARRATOR_TEXT: 'Hecho.', NARRATOR_LANG: 'es' })
  speech = w.nextSpeech()
  await turn($, { prompt: 'fix the queue tests', answer: 'Done: the tests pass.' })
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.spoken[1]!.env).toMatchObject({ NARRATOR_TEXT: 'He añadido el narrador y los tests pasan.', NARRATOR_LANG: 'es' })
})

test("a subagent's turn and an interrupted turn are not narrated", async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  await turn($, { agentId: 'agent-1', answer: 'subagent report' })
  await turn($, { reason: 'aborted', answer: 'half done' })
  const speech = w.nextSpeech()
  await turn($, { answer: `all done. ${LONG}` })
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('all done')
  expect(w.prompts[0]).not.toContain('subagent')
})

test('a new prompt silences the narration on its way', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.isEnded).toBe(false)
  await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
})

test('while it speaks the switch reads narrating with a stop sign: a click stops it and leaves it on', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏹︎ narrating')
  expect((await ui.find({ type: 'Text', text: '⏹︎ narrating' }))?.props.color).toBe('permission')
  await ui.press({ key: 'narrator' })
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect(w.store.enabled).toBe(true)
})

test('with narrations of other windows waiting their turn, the sign skips to the next one', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on', waiting: 2 })
  await startSession($)
  const ui = await footer($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏭︎ narrating')
  await ui.press({ key: 'narrator' })
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
})

test('while it speaks a lighter blue sweeps the switch from left to right, and stops with it', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const ui = await footer($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  // What the sweep lights, a tenth of a second at a time, for two sweeps.
  const lit: string[] = []
  for (let i = 0; i < 36; i++) {
    await w.clock.advance(100)
    lit.push(await swept(ui))
  }
  const from = lit.indexOf('⏹︎')
  expect(from).toBeGreaterThanOrEqual(0)
  expect(lit.slice(from, from + 18)).toEqual(['⏹︎', '⏹︎ ', '⏹︎ n', ' na', 'nar', 'arr', 'rra', 'rat', 'ati', 'tin', 'ing', 'ng', 'g', '', '', '', '', ''])
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏹︎ narrating')
  await ui.press({ key: 'narrator' })
  await w.clock.advance(100)
  await w.clock.advance(100)
  expect(await swept(ui)).toBe('')
  expect((await ui.find({ type: 'Text', text: '⏵ narrator on' }))?.props.color).toBe('success')
})

test('narrating gives up its word where the row is short', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect((await (await footer($, [], 49)).find({ key: 'narrator' }))?.text).toBe('⏹︎ narrating')
  expect((await (await footer($, [], 48)).find({ key: 'narrator' }))?.text).toBe('⏹︎')
})

test('once it has said it, the switch reads on again', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const ui = await footer($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  await w.settled()
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
})

test('/narrator stop silences it and leaves it on', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect((await narrator($, 'stop')).text).toBe('Narrator: quiet.')
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
  expect(w.store.enabled).toBe(true)
})

test('without a narration from the model, the answer itself is read, as plain text', { options: { shortAnswer: 0 } }, async ($, on) => {
  const w = world(on, { store: { enabled: true }, reply: null })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'He creado el **narrador** en `plugins/narrator` y los tests pasan para que lo pruebes.' })
  await speech
  expect(w.spoken[0]!.env.NARRATOR_TEXT).toBe('He creado el narrador en narrator y los tests pasan para que lo pruebes.')
  expect(w.prompts).toHaveLength(1)
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
})

test('Windows speaks through PowerShell', async ($, on) => {
  const w = world(on, { store: { enabled: true }, env: { OS: 'Windows_NT' } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['powershell', '-NoProfile'])
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
  expect(w.spoken[0]!.env.NARRATOR_TICKET).toBe('0000000000000')
})

test("WSL speaks with Windows' voices, its variables crossing over", async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, tools: '/usr/bin/espeak-ng\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv[0]).toBe('powershell.exe')
  expect(w.spoken[0]!.env.WSLENV).toBe('NARRATOR_TEXT:NARRATOR_LANG:NARRATOR_VOICE:NARRATOR_SPEED:NARRATOR_TICKET')
})

test('Linux speaks with speech-dispatcher in the language Haiku names', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/spd-say\n/usr/bin/espeak-ng\n', table: 'NAME LANGUAGE VARIANT\nSpanish es none\nEnglish en-us none\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(w.spoken[0]!.argv.slice(7)).toEqual(['narrator', 'spd-say', '-w', '-l', 'es', '-r', '18', '--', 'He añadido el narrador y los tests pasan.'])
  expect(w.spoken[0]!.env.NARRATOR_STOP).toBe('spd-say -S')
})

test('at speed 1 speech-dispatcher keeps the rate it is set up with', { options: { speed: 1 } }, async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/spd-say\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(7)).toEqual(['narrator', 'spd-say', '-w', '-l', 'es', '--', 'He añadido el narrador y los tests pasan.'])
})

test('a language the synthesizer has no voice for is read in English', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/espeak-ng\n', table: 'Pty Language Age/Gender VoiceName File\n 5  en-us --/M English_(America) gmw/en-US\n 5  fr-fr --/M French gmw/fr\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(7)).toEqual(['narrator', 'espeak-ng', '-v', 'en', '-s', '228', '--', 'He añadido el narrador y los tests pasan.'])
})

test('where no speaker works, the engine speaks; where it cannot either, a toast says what to install', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'fails' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.said).toEqual([{ text: 'He añadido el narrador y los tests pasan.', voice: undefined }])
  expect(w.toasts).toEqual([])
})

test('a Linux with no synthesizer says what to install, once', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', hasEngineVoice: false })
  await startSession($)
  for (const answer of ['first', 'second']) {
    const speech = w.nextSpeech()
    await turn($, { answer })
    await speech
    await w.settled()
  }
  expect(w.spoken).toEqual([])
  expect(w.toasts).toEqual(['Narrator: no voice to speak with. Install speech-dispatcher (spd-say) or espeak-ng.'])
})

test('the narration is read as plain text, in the language it names', () => {
  expect(parseNarration('es\nHe cambiado el **archivo** `register.ts`.')).toEqual({ language: 'es', text: 'He cambiado el archivo register.' })
  expect(parseNarration('"en"\n\nI fixed the tests.')).toEqual({ language: 'en', text: 'I fixed the tests.' })
  expect(parseNarration('He arreglado los tests y ahora todo pasa en la rama principal.').language).toBe('es')
  expect(plain('## Done\n- one\n- two [link](https://x.dev)\n```ts\ncode\n```\nend')).toBe('Done one two link end')
  expect(guessLanguage('ok')).toBe('')
})

test('a path is said by its name and a hash is left out; a date, a version or and/or stay', () => {
  expect(plain('Hecho en `plugins/narrator/hooks/register.tsx` y `README.md`, commit `a1b2c3d`.')).toBe('Hecho en register y README, commit.')
  expect(plain('Run /narrator on, see ~/.claude/settings.json or src/app/main; and/or 20/10/2026.')).toBe('Run narrator on, see settings or main; and/or 20/10/2026.')
  expect(plain('Subí sub-meter a 0.2.2 (`abc1234`) y `npm test` pasa.')).toBe('Subí sub-meter a 0.2.2 y npm test pasa.')
})

test('a short answer is read as it is, with no model call', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'Hecho: los tests pasan y el **narrador** habla.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[0]!.env.NARRATOR_TEXT).toBe('Hecho: los tests pasan y el narrador habla.')
})

test('shortAnswer 0 narrates every answer', { options: { shortAnswer: 0 } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'all done' })
  await speech
  expect(w.prompts).toHaveLength(1)
})

test('a short answer is said in the language of the request, else the last narration', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/spd-say\n' })
  await startSession($)
  let speech = w.nextSpeech()
  await turn($, { prompt: 'arregla los tests de la cola', answer: 'Hecho.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
  speech = w.nextSpeech()
  await turn($, { prompt: 'ok', answer: 'Done.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[1]!.env.NARRATOR_LANG).toBe('es')
})

test('a short answer in no language it tells is narrated on Windows and Linux, read on macOS', async ($, on) => {
  const w = world(on, { store: { enabled: true }, env: { OS: 'Windows_NT' } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { prompt: 'ok', answer: 'Done.' })
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
})

test('on macOS a short answer is read in whatever language it is, with no model call', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { prompt: 'ok', answer: 'Done in `hooks/speaker.ts`.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[0]!.env.NARRATOR_TEXT).toBe('Done in speaker.')
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('')
})

test('every speaker waits in the line shared by all windows: a shell before it, PowerShell in its own', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(w.spoken[0]!.argv[3]).toBe('narrator-line')
  expect(w.spoken[0]!.env.NARRATOR_TICKET).toMatch(/^\d{13}$/)
})
