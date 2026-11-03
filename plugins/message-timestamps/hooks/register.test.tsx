import type { On } from 'claude-code'
import type { Mounted } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const SENT = Date.UTC(2026, 9, 30, 14, 32)
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const sent = new Date(SENT)
const two = (n: number) => String(n).padStart(2, '0')
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][sent.getDay()]
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][sent.getMonth()]
const CLOCK = `${two(sent.getHours())}:${two(sent.getMinutes())}`
const OFFSET = (() => {
  const minutes = -sent.getTimezoneOffset()
  return `${minutes < 0 ? '-' : '+'}${two(Math.floor(Math.abs(minutes) / 60))}:${two(Math.abs(minutes) % 60)}`
})()

// A hover pattern draws the stamp through a Client, so tests that read it as plain text turn the hover off.
const sameForAll = (pattern: string) => ({ formatToday: pattern, formatWeek: pattern, formatYear: pattern, formatOlder: pattern, formatHover: '' })
const FIXED = sameForAll('HH:mm')

const prompt = (uuid: string) => ({
  message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  door: 'prompt',
  origin: { kind: 'person' },
  uuid,
}) as never

const reply = (uuid: string) => ({
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'x' }] },
  door: 'response',
  origin: { kind: 'model', model: 'm' },
  uuid,
}) as never

const USER_ROW = (surface: 'terminal' | 'vscode', requestId: string) =>
  ({
    plugin: 'message-timestamps',
    component: 'UserMessage',
    surface,
    requestId,
    props: { text: 'hi', origin: { kind: 'prompt' }, isExpanded: false },
  }) as never

const REPLY_ROW = (requestId: string, text: string, isFirstOfReply = true) =>
  ({
    plugin: 'message-timestamps',
    component: 'AssistantMessage',
    surface: 'vscode',
    requestId,
    props: { text, isFirstOfReply },
  }) as never

/** The engine beneath the plugin: a clock at SENT, a session, and rows that draw their own text. */
const engine = (on: On) => {
  const clock = mock.clock(on, { now: SENT })
  mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'text' in e.props ? String(e.props.text) : 'engine'}</Text>
  })
  return clock
}

test('the defaults show the time and how long ago, and the full date on hover', async ($, on) => {
  engine(on)

  await $.session.append(prompt('d1'))
  const ui = (await $.ui.mount(USER_ROW('terminal', 'd1'))) as Mounted<'terminal', 'UserMessage'>
  const scope = { in: 'stamp-d1' }
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [`${CLOCK} · just now`] })

  await ui.pointer({ type: 'enter', x: 0, y: 0, ...scope })
  const hour = `${sent.getHours() % 12 || 12}:${two(sent.getMinutes())}:00 ${sent.getHours() < 12 ? 'am' : 'pm'}`
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [expect.stringContaining(`${WEEKDAY} ${MONTH} ${sent.getDate()} at ${hour} `)] })
  await ui.unmount()
})

test('a prompt row shows its time and how long ago, on terminal and vscode', { options: sameForAll('HH:mm · relative') }, async ($, on) => {
  const clock = engine(on)

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.session.append(prompt('u1'))
  await clock.advance(23 * HOUR_MS)

  const rows = await Promise.all((['terminal', 'vscode'] as const).map(surface => $.ui.mount(USER_ROW(surface, 'u1'))))
  for (const ui of rows) expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${CLOCK} · 23h ago`)

  await clock.advance(HOUR_MS)
  for (const ui of rows) {
    expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${CLOCK} · 1d ago`)
    await ui.unmount()
  }
})

test('a row with no recorded time is left to the engine', async ($, on) => {
  engine(on)

  const ui = await $.ui.mount(USER_ROW('vscode', 'unknown'))
  expect(await ui.drawn()).toMatchObject({ type: 'Text' })
  await ui.unmount()
})

test('a fixed format draws no relative part', { options: FIXED }, async ($, on) => {
  engine(on)

  await $.session.append(prompt('u2'))
  const ui = await $.ui.mount(USER_ROW('vscode', 'u2'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  await ui.unmount()
})

test('an empty format falls back to the time alone', { options: { ...FIXED, formatToday: '' } }, async ($, on) => {
  engine(on)

  await $.session.append(prompt('e1'))
  const ui = await $.ui.mount(USER_ROW('vscode', 'e1'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  await ui.unmount()
})

test('a reply shows its time above its first block only', { options: FIXED }, async ($, on) => {
  engine(on)

  await $.session.append(reply('a1'))
  const first = await $.ui.mount(REPLY_ROW('a1', 'Done.'))
  expect((await first.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  expect((await first.find({ type: 'Text', text: /Done/ }))?.text).toBe('Done.')
  await first.unmount()

  const later = await $.ui.mount(REPLY_ROW('a1', 'More.', false))
  expect(await later.drawn()).toMatchObject({ type: 'Text' })
  await later.unmount()
})

test('a row drawn before its message is stored redraws once the time is recorded', { options: FIXED }, async ($, on) => {
  engine(on)

  const ui = await $.ui.mount(USER_ROW('terminal', 'late'))
  expect(await ui.drawn()).toMatchObject({ type: 'Text' })

  await $.session.append(prompt('late'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  await ui.unmount()
})

test('a custom pattern draws its tokens and keeps bracketed text', { options: { ...FIXED, formatToday: '[at] ddd DD MMM YYYY, h:mm:ss A Z' } }, async ($, on) => {
  engine(on)

  const hour = `${sent.getHours() % 12 || 12}:${two(sent.getMinutes())}:${two(sent.getSeconds())} ${sent.getHours() < 12 ? 'AM' : 'PM'}`
  await $.session.append(prompt('p1'))
  const ui = await $.ui.mount(USER_ROW('vscode', 'p1'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(`at ${WEEKDAY} ${two(sent.getDate())} ${MONTH} ${sent.getFullYear()}, ${hour} ${OFFSET}`)
  await ui.unmount()
})

test('z names the time zone', { options: { ...FIXED, formatToday: 'z' } }, async ($, on) => {
  engine(on)

  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(sent).find(part => part.type === 'timeZoneName')?.value
  await $.session.append(prompt('z1'))
  const ui = await $.ui.mount(USER_ROW('vscode', 'z1'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(zone)
  await ui.unmount()
})

test('the relative part follows the refresh interval', { options: { ...sameForAll('relative'), refreshSeconds: 15 } }, async ($, on) => {
  const clock = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)
  await $.session.append(prompt('r1'))
  const ui = await $.ui.mount(USER_ROW('terminal', 'r1'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe('just now')

  // Sent 10s in: a minute has passed at 70s, and the tick at 75s shows it.
  await clock.advance(65_000)
  expect((await ui.find({ key: 'stamp' }))?.text).toBe('1m ago')
  await ui.unmount()
})

test('relative time keeps updating after /clear ends the session', { options: { ...sameForAll('relative'), refreshSeconds: 15 } }, async ($, on) => {
  const clock = engine(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await $.session.append(prompt('end1'))
  const ui = await $.ui.mount(USER_ROW('terminal', 'end1'))

  await clock.advance(2 * MINUTE_MS)
  expect((await ui.find({ key: 'stamp' }))?.text).toBe('2m ago')
  await ui.unmount()
})

// An hourly refresh keeps the clock's timer waits under the test kit's limit across 410 days.
test('each age range uses its own pattern', { options: { refreshSeconds: 3600, formatHover: '' } }, async ($, on) => {
  const clock = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append(prompt('age'))
  const ui = await $.ui.mount(USER_ROW('terminal', 'age'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${CLOCK} · just now`)

  await clock.advance(2 * DAY_MS)
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${WEEKDAY}, ${CLOCK} · 2d ago`)

  await clock.advance(8 * DAY_MS)
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${MONTH} ${sent.getDate()}, ${CLOCK} · 10d ago`)

  await clock.advance(400 * DAY_MS)
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(`${MONTH} ${sent.getDate()} ${sent.getFullYear()}, ${CLOCK}`)
  await ui.unmount()
})

for (const [units, hasAgo, minute, hours] of [
  ['short', true, '1m ago', '3h ago'],
  ['short', false, '1m', '3h'],
  ['long', true, '1 min ago', '3 hours ago'],
  ['long', false, '1 min', '3 hours'],
] as const) {
  test(`relative style ${units}, ago ${hasAgo ? 'on' : 'off'}`, { options: { ...sameForAll('relative'), relativeUnits: units, relativeAgo: hasAgo } }, async ($, on) => {
    const clock = engine(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.session.append(prompt('rel'))
    const ui = await $.ui.mount(USER_ROW('terminal', 'rel'))
    expect((await ui.find({ key: 'stamp' }))?.text).toBe('just now')

    await clock.advance(MINUTE_MS)
    expect((await ui.find({ key: 'stamp' }))?.text).toBe(minute)

    await clock.advance(3 * HOUR_MS)
    expect((await ui.find({ key: 'stamp' }))?.text).toBe(hours)
    await ui.unmount()
  })
}

test('hovering the timestamp shows the hover pattern in its place', { options: { ...FIXED, formatHover: 'YYYY-MM-DD HH:mm:ss Z' } }, async ($, on) => {
  engine(on)

  const full = `${sent.getFullYear()}-${two(sent.getMonth() + 1)}-${two(sent.getDate())} ${CLOCK}:${two(sent.getSeconds())} ${OFFSET}`
  await $.session.append(prompt('h1'))
  const ui = (await $.ui.mount(USER_ROW('terminal', 'h1'))) as Mounted<'terminal', 'UserMessage'>
  const scope = { in: 'stamp-h1' }
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [CLOCK] })

  await ui.pointer({ type: 'enter', x: 0, y: 0, ...scope })
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [full] })

  await ui.pointer({ type: 'leave', x: -1, y: 0, ...scope })
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [CLOCK] })
  await ui.unmount()
})

test('vscode has no Client, so the stamp stays plain text there', { options: { ...FIXED, formatHover: 'YYYY' } }, async ($, on) => {
  engine(on)

  await $.session.append(prompt('h3'))
  const ui = await $.ui.mount(USER_ROW('vscode', 'h3'))
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  await ui.unmount()
})

test('an empty hover pattern draws no hover', { options: FIXED }, async ($, on) => {
  engine(on)

  await $.session.append(prompt('h2'))
  const ui = await $.ui.mount(USER_ROW('terminal', 'h2'))
  expect(JSON.stringify(await ui.drawn())).not.toContain('Client')
  expect((await ui.find({ key: 'stamp' }))?.text).toBe(CLOCK)
  await ui.unmount()
})

test('an icon goes before the timestamp and another before the hover text', { options: { ...FIXED, formatHover: 'HH', icon: '>', iconHover: '*' } }, async ($, on) => {
  engine(on)

  await $.session.append(prompt('i1'))
  const ui = (await $.ui.mount(USER_ROW('terminal', 'i1'))) as Mounted<'terminal', 'UserMessage'>
  const scope = { in: 'stamp-i1' }
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [`> ${CLOCK}`] })

  await ui.pointer({ type: 'enter', x: 0, y: 0, ...scope })
  expect(await ui.drawn(scope)).toMatchObject({ type: 'Text', children: [`* ${two(sent.getHours())}`] })
  await ui.unmount()
})
