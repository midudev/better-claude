# Message Timestamps

A Claude Code mod: a gray timestamp right above each prompt you send and each reply Claude writes, so you can tell when anything in the transcript happened.

```text
  13:25 · 2m ago
❯ fix the failing test in the auth module

  Read(src/auth/session.test.ts)

  13:26 · 1m ago
⏺ The test expects the token to expire at 30 minutes, but…

✻ Worked for 41s · done 1:26 PM
```

- **Prompts and replies**: a reply gets one timestamp, on its first block. Tool calls get none.
- **Relative time stays current**: `just now` becomes `1m ago`, then `2h ago`, then `1d ago`, as you watch.
- **The format follows the message's age**: a message from today shows only the time, one from this week adds the weekday, older ones add the date.

Only what is drawn changes. The stored transcript, and what Claude reads, stay as they were.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install message-timestamps@better-claude
```

## Settings

Every setting is in `/config`.

### Formats

Each age range has its own pattern:

| Setting | Used for | Default | Example |
| --- | --- | --- | --- |
| `formatToday` | today | `HH:mm · relative` | `13:25 · 2m ago` |
| `formatWeek` | the 6 days before today | `ddd, HH:mm · relative` | `Fri, 13:25 · 1d ago` |
| `formatYear` | earlier this year | `MMM D, HH:mm · relative` | `Oct 20, 13:25 · 11d ago` |
| `formatOlder` | earlier years | `MMM D YYYY, HH:mm` | `Oct 20 2025, 13:25` |

A timestamp moves to the next pattern as days pass, at the next refresh. For one format everywhere, give all four the same pattern. A pattern left empty shows the time alone, `HH:mm`.

A pattern is text with tokens in it. The token names follow Moment.js and Day.js:

| Token | Gives | Token | Gives |
| --- | --- | --- | --- |
| `YYYY` | 2026 | `HH` | 15, 24-hour, padded |
| `YY` | 26 | `H` | 15, 24-hour |
| `MMM` | Oct | `hh` | 03, 12-hour, padded |
| `MM` | 10 | `h` | 3, 12-hour |
| `M` | 10 | `mm` / `m` | minutes, padded / not |
| `DD` | 05 | `ss` / `s` | seconds, padded / not |
| `D` | 5 | `A` | PM |
| `ddd` | Mon | `a` | pm |
| `relative` | how long ago: `just now`, `5m ago` | `Z` | -07:00, the UTC offset |
| | | `z` | PST, the zone's short name |

Text in `[brackets]` is shown as written. Any other letters that match a token are replaced, so write `[at] h:mm a` rather than `at h:mm a`, which would show `pmt 3:06 pm`. Month and weekday names are in English.

For a 12-hour clock, `3:06 pm · 2m ago`:

```text
formatToday  h:mm a · relative
formatWeek   ddd, h:mm a · relative
formatYear   MMM D, h:mm a · relative
formatOlder  MMM D YYYY, h:mm a
```

### Relative time

| `relativeUnits` | `relativeAgo` on | `relativeAgo` off |
| --- | --- | --- |
| `short` (default) | `1m ago`, `3h ago`, `2d ago` | `1m`, `3h`, `2d` |
| `long` | `1 min ago`, `3 hours ago`, `2 days ago` | `1 min`, `3 hours`, `2 days` |

Under a minute it reads `just now`. `refreshSeconds` (default 15, from 1 to 3600) is how often the timestamps are brought up to date, so a relative time is at most that far behind.

### Hover

While the pointer is on a timestamp, `formatHover` is shown in its place. It takes the same tokens as the other formats and defaults to `ddd MMM D [at] h:mm:ss a z`, which reads `Sun Nov 1 at 5:16:12 pm PST`. Leave it empty to turn the hover off.

`z` is the zone's short name as the system knows it. A zone with no common abbreviation shows its offset instead, `GMT-7`; to show a name of your own, write it in brackets: `[MZT]`.

### Icon

`icon` goes before the timestamp and `iconHover` before the hover text, each followed by a space. Both are empty by default. Any text works; a [Nerd Font](https://www.nerdfonts.com/) glyph such as `` (`nf-fa-clock_o`, U+F017) needs a terminal font that has it.

## Limits

- Timestamps start when the mod loads: the messages before it, and the history of a resumed session, have none.
- The prompt Claude Code pins to the top of the screen while you scroll shows no timestamp: a mod cannot draw there.
- Slash commands that run without Claude, such as `/model` or `/rename`, show no timestamp: Claude Code draws their row without the id of the message it stores, so there is no time to look up.
- The hover works in the terminal and the desktop app, not in VS Code. The terminal reports the pointer only in fullscreen mode (`"tui": "fullscreen"`).

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)):

- A `session.append` hook records the time each prompt and reply is stored, by its id, in `$.state`.
- A `ui.render` hook on `UserMessage` and on the first `AssistantMessage` block of each reply draws the timestamp over the blank line the engine's own row opens with, in a box placed `position: "absolute"`. Drawn after the row, the box sits above it for the pointer too.
- With a hover pattern, the timestamp is drawn by a `Client` surface module ([`hooks/stamp.tsx`](hooks/stamp.tsx)), which hears the pointer and swaps the timestamp for the hover text in place. VS Code and mobile have no `Client`, so there the timestamp is plain text with no hover.
- A row is drawn before its message is stored, so the hook reads the time from `$.state` and is drawn again once the time is recorded.
- A timer writes the time to `$.state` every `refreshSeconds`, which redraws each timestamp that reads it. It runs only when a pattern uses `relative` or the four patterns differ.

## Development

```bash
claude plugin validate .   # from this folder
claude plugin test .       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
