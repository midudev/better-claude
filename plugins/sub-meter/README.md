# Sub Meter

A Claude Code mod: your subscription usage, always at the bottom right, on the same line as the permission mode.

```text
⏵⏵ auto mode on                                   5h ━━━━━━──── 58% ↻ 2h 10m
```

By default it switches between the **5-hour** window and the **weekly** one every 8 seconds (`rotateSeconds` in `/config`). Set `display` there to change what it shows: `rotate` (the default), `both` (the two windows side by side, separated by `|`), `session` (only the 5-hour window) or `week` (only the weekly one). With a single reading available, every mode shows it. The bar turns yellow from 75% and red from 90%. After it, behind ↻, the time until that window resets.

Every open session shares the latest reading, so a window you are not using catches up within 8 seconds. It only sees what some Claude Code session measures: usage elsewhere (claude.ai, the mobile app) shows up at the next response.

Where the footer is short it fits the row instead of breaking to a second line: first the bar goes, then the reset time, and in a very narrow terminal the meter itself. Beside [Narrator](../narrator), the meter shrinks first, then the switch.

```text
⏵⏵ auto mode on ·      5h 58% ↻ 2h 10m · ⏵ narrator on
⏵⏵ auto mode on ·           5h 58% · ⏵ narrator
```

There is no monthly window: Claude Code only reports the 5-hour and the weekly ones. Off a subscription (API key billing) there is nothing to show, so the footer stays as it is.

While it is on, it also drops the `(shift+tab to cycle)` hint after the permission mode and `esc to interrupt` while Claude works, to leave room for the meter. Turn either off in `/config` (`hideCycleHint`, `hideInterruptHint`).

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install sub-meter@better-claude
```

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)):

- `session.measure` hands it the rate-limit windows after each response (`five_hour`, `seven_day`); `$.session.usage()` gives the first reading at start.
- The last reading is kept in `$.store` with the time it was taken, so a new session shows it before its first response, and every open session reads it back every 8 seconds: what one measures shows up in the others.
- A `ui.render` hook on `SessionMode` draws the meter and, after it, what is beneath (the engine's mode labels, another plugin's switch such as Narrator's, which so stays last); `$.clock.every` redraws the countdown every 8 seconds and, in `rotate`, switches the window.
- The room it has is the terminal's width (`e.viewport.columns`) less the footer's padding, the mode label and the hint, and less what is beneath; the meter takes the widest form that fits.
- A `ui.render` hook on `PromptHint` rewrites the hint line without `(shift+tab to cycle)` and `esc to interrupt`, and notes its width; the engine still draws it, and the mode label before it.

## Development

```bash
claude plugin validate ./plugins/sub-meter   # from the repository root
claude plugin test ./plugins/sub-meter       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
