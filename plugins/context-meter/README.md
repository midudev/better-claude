# Context Meter

A Claude Code mod: how full the context window is, what the last message and the whole session cost, and the subagents at work, in one line that ends the hint line under the prompt.

```text
⏵⏵ auto mode on · ctx ▓▓░░░░░░░░ 22% ▇█████████ · msg ~$0.06 · session 18M tok ~$5 · out 71k · agents 1 (93k)
```

- `ctx` the context window in use, as a bar and a percentage; it turns yellow from 75% and red from 90%.
- The second bar is how much of the last message's input was read from the prompt cache.
- `msg` what the last message cost: how much the session total grew since the one before.
- `session` every token the API counted (cached ones too) and the cost so far.
- `out` the output tokens of the session.
- `agents` the subagents running now and the tokens they have spent so far. It leaves when they finish.

Costs are estimates (`~`): the engine prices each response, but the figure is not your bill. Token Meter shows each turn's tokens (up, down, cache); this one is about the window and the money, and it can sit next to it.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install context-meter@better-claude
```

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)):

- `$.session.usage()` gives the first reading at start; `session.measure` keeps the context percentage and the cost fresh after each response.
- `turn.complete` adds the turn's `usage` to the session tokens, and to the subagent's own when the turn ran in one (`agentId`). On the main loop it also reads the cost to tell what that message added.
- `$.clock.every` asks `$.agent.list()` for the running subagents, and only writes when they changed.
- A `ui.render` hook on `PromptHint` wraps what the engine draws there (`await next(e)`, so its pills stay live and other plugins still apply) and adds the meter after it.
- The formatting is four small exported functions (`bar`, `tokens`, `money`, `agentTokens`), tested on their own.

The line is long: on a narrow terminal it will wrap. Parts that have nothing to say are left out (`msg` before the first message, `agents` while none runs).

## Development

```bash
claude plugin validate ./context-meter   # from the repository root
claude plugin test ./context-meter       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
