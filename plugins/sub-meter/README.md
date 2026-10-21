# Sub Meter

A Claude Code mod: your subscription usage and your context window, always at the bottom right, on the same line as the permission mode.

```text
⏵⏵ auto mode on                                   5h ━━━━━━──── 58% ↻ 2h 10m
⏵⏵ auto mode on                                   ctx ━━━━────── 42% 84k/200k
```

Every 8 seconds it switches between the **5-hour** window, the **weekly** one and the **context** window (change it in `/config`, `rotateSeconds`). The bar turns yellow from 75% and red from 90%. After the subscription windows, behind ↻, the time until that window resets; after the context window, its tokens over the window's size, as the status line counts them.

The context window takes its turn once the first response of the session reports its fill. Turn it off in `/config` (`showContext`).

Where the footer is short it fits the row instead of breaking to a second line: first the bar goes, then the reset time (or the tokens), and in a very narrow terminal the meter itself. Beside [Narrator](../narrator), the meter shrinks first, then the switch.

```text
⏵⏵ auto mode on ·      5h 58% ↻ 2h 10m · ⏵ narrator on
⏵⏵ auto mode on ·           5h 58% · ⏵ narrator
```

There is no monthly window: Claude Code only reports the 5-hour and the weekly ones. Off a subscription (API key billing) only the context window shows; with that off too, the footer stays as it is.

While it is on, it also drops the `(shift+tab to cycle)` hint after the permission mode and `esc to interrupt` while Claude works, to leave room for the meter. Turn either off in `/config` (`hideCycleHint`, `hideInterruptHint`).

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install sub-meter@better-claude
```

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)):

- `session.measure` hands it the rate-limit windows (`five_hour`, `seven_day`) and the context window's fill (`context.tokens` over `context.window`) after each response; `$.session.usage()` gives the first reading at start.
- The last rate-limit reading is kept in `$.store`, so a new session shows it before its first response. The context window is each session's own, so it is not.
- A `ui.render` hook on `SessionMode` draws the meter and, after it, what is beneath (the engine's mode labels, another plugin's switch such as Narrator's, which so stays last); `$.clock.every` switches the window.
- The room it has is the terminal's width (`e.viewport.columns`) less the footer's padding, the mode label and the hint, and less what is beneath; the meter takes the widest form that fits.
- A `ui.render` hook on `PromptHint` rewrites the hint line without `(shift+tab to cycle)` and `esc to interrupt`, and notes its width; the engine still draws it, and the mode label before it.

## Development

```bash
claude plugin validate ./sub-meter   # from the repository root
claude plugin test ./sub-meter       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
