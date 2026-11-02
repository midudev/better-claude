import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const sentAt = atom({ plugin: 'message-timestamps', key: 'sentAt' } as const, null)
const now = atom({ plugin: 'message-timestamps', key: 'now' } as const, 0)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Longer tokens come first so MMM is not read as MM followed by M.
const TOKEN = /\[([^\]]*)\]|relative|YYYY|YY|MMM|MM|M|DD|D|ddd|HH|H|hh|h|mm|m|ss|s|A|a|Z|z/g

const pad = (n: number) => String(n).padStart(2, '0')

type Settings = {
  formats: { today: string; week: string; year: string; older: string }
  isLongUnits: boolean
  hasAgo: boolean
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

function relative(at: number, current: number, settings: Settings): string {
  const elapsed = Math.max(0, current - at)
  if (elapsed < MINUTE) return 'just now'

  const minutes = Math.floor(elapsed / MINUTE)
  const hours = Math.floor(elapsed / HOUR)
  const days = Math.floor(elapsed / DAY)
  const amount = settings.isLongUnits
    ? elapsed < HOUR ? `${minutes} min` : elapsed < DAY ? plural(hours, 'hour') : plural(days, 'day')
    : elapsed < HOUR ? `${minutes}m` : elapsed < DAY ? `${hours}h` : `${days}d`

  return settings.hasAgo ? `${amount} ago` : amount
}

function daysBefore(t: number, days: number): number {
  const d = new Date(t)
  d.setDate(d.getDate() - days)

  return d.setHours(0, 0, 0, 0)
}

function formatFor(at: number, current: number, settings: Settings): string {
  const { formats } = settings
  if (at >= daysBefore(current, 0)) return formats.today
  if (at >= daysBefore(current, 6)) return formats.week
  if (new Date(at).getFullYear() === new Date(current).getFullYear()) return formats.year

  return formats.older
}

function offset(d: Date): string {
  const minutes = -d.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'

  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

// Intl names a zone by its abbreviation where it has a common one (PST) and by its offset (GMT-7)
// where it has none.
const ZONE = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })

function zoneName(d: Date): string {
  const parts = ZONE.formatToParts(d)

  return parts.find(part => part.type === 'timeZoneName')?.value ?? offset(d)
}

function formatTime(at: number, current: number, format: string, settings: Settings): string {
  const d = new Date(at)
  const hour12 = d.getHours() % 12 || 12
  const tokens: Record<string, () => string> = {
    relative: () => relative(at, current, settings),
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MMM: () => MONTHS[d.getMonth()] ?? '',
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    ddd: () => WEEKDAYS[d.getDay()] ?? '',
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(hour12),
    h: () => String(hour12),
    mm: () => pad(d.getMinutes()),
    m: () => String(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    s: () => String(d.getSeconds()),
    A: () => (d.getHours() < 12 ? 'AM' : 'PM'),
    a: () => (d.getHours() < 12 ? 'am' : 'pm'),
    Z: () => offset(d),
    z: () => zoneName(d),
  }

  return format.replace(TOKEN, (token, literal?: string) => literal ?? tokens[token]?.() ?? token)
}

const label = (at: number, current: number, settings: Settings) =>
  formatTime(at, current, formatFor(at, current, settings), settings)

export const register: Register = (on, options) => {
  // The engine fills each option from the manifest's default, so plugin.json holds them all. A
  // format cleared to nothing would draw an empty stamp, so it falls back to the time alone.
  const format = (key: string) => String(options[key] || 'HH:mm')
  const settings: Settings = {
    formats: {
      today: format('formatToday'),
      week: format('formatWeek'),
      year: format('formatYear'),
      older: format('formatOlder'),
    },
    isLongUnits: options.relativeUnits === 'long',
    hasAgo: options.relativeAgo !== false,
  }
  // An empty hover pattern turns the hover off.
  const hoverFormat = String(options.formatHover ?? '')
  const patterns = [...Object.values(settings.formats), hoverFormat]
  // A message moves to another pattern as days pass, so differing patterns need the clock too.
  const isLive =
    new Set(Object.values(settings.formats)).size > 1 ||
    patterns.some(pattern => pattern.replace(/\[[^\]]*\]/g, '').includes('relative'))
  const refreshMs = Math.max(1, Number(options.refreshSeconds)) * 1000
  const withIcon = (icon: unknown, shown: string) => (icon ? `${String(icon)} ${shown}` : shown)

  on('session.start', async ($, e, next) => {
    if (isLive) {
      const tick = async () => {
        const at = await $.clock.now()
        await update($, now, () => at)
      }
      await tick()
      $.clock.every(refreshMs, () => void tick())
    }

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const isMessage =
      e.door === 'prompt' || (e.door === 'response' && e.message.role === 'assistant')
    if (isMessage) {
      const at = await $.clock.now()
      await update($, memberOf(sentAt, { requestId: e.uuid }), () => at)
    }

    return next(e)
  })

  on('ui.render', async ($, e, next) => {
    const isStamped =
      e.component === 'UserMessage' ||
      (e.component === 'AssistantMessage' && e.props.isFirstOfReply)
    if (!isStamped) return next(e)

    const at = await read($, memberOf(sentAt, e))
    if (at === null) return next(e)
    const current = isLive ? Math.max(at, await read($, now)) : at
    const stamp = withIcon(options.icon, label(at, current, settings))
    const hover = hoverFormat && withIcon(options.iconHover, formatTime(at, current, hoverFormat, settings))

    const { Box, Text } = $.ui.resolve(e)
    let shown = <Text dimColor>{stamp}</Text>
    // Only a Client hears the pointer, and VS Code and mobile have none, so there the stamp stays plain text.
    if (hover && (e.surface === 'terminal' || e.surface === 'desktop')) {
      const { Client } = $.ui.resolve(e)
      shown = <Client key={`stamp-${e.requestId}`} module="./stamp.tsx" props={{ stamp, hover }} />
    }

    // The engine's row opens with a blank line, so the stamp floats over it. Drawn after the row, it
    // also sits above it for the pointer, which a row laid over the stamp would take instead. The
    // margin gives back the blank line the stamp took, which kept the row apart from the one above.
    return (
      <Box flexDirection="column" marginTop={1}>
        {await next(e)}
        <Box key="stamp" position="absolute" top={0} left={2}>
          {shown}
        </Box>
      </Box>
    )
  })
}
