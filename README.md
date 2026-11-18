# better-claude

<img width="1590" height="576" alt="CleanShot 2026-10-15 at 14 38 45@2x" src="https://github.com/user-attachments/assets/67b271e6-254e-4429-9273-9571fe98f79b" />

Plugins and mods for Claude Code by midudev, one per folder in [`plugins/`](plugins):

| Plugin | What it does | Folder |
| --- | --- | --- |
| **Quick Peek** | The paths in Claude's replies become links: hover one to preview it by the pointer, click it to show it in Finder. | [`plugins/quick-peek/`](plugins/quick-peek/README.md) |
| **Image Preview** | Hover a pasted `[Image #N]` to see the picture, while you write and on the prompts you sent. | [`plugins/image-preview/`](plugins/image-preview/README.md) |
| **Sub Meter** | Subscription usage at the bottom right: the 5-hour and weekly windows, as a bar. | [`plugins/sub-meter/`](plugins/sub-meter/README.md) |
| **Context Meter** | The session's context window fill, right above the prompt: yellow when it is time to `/compact`, red when a new session is better. | [`plugins/context-meter/`](plugins/context-meter/README.md) |
| **Commit** | `/commit` asks commit + push, commit only or a new branch, then splits your changes into Conventional Commits, on Haiku 5.5. | [`plugins/commit/`](plugins/commit/README.md) |
| **Narrator** | Click `⏸︎ narrator off` in the footer, or `/narrator`, and Claude tells you out loud what it did after each turn, in your language, with the best free voice your system has. | [`plugins/narrator/`](plugins/narrator/README.md) |
| **Time Machine** | Every turn that changes files is a git snapshot: `/timeline` puts the files back as before any turn, Bash changes included. | [`plugins/time-machine/`](plugins/time-machine/README.md) |
| **Worktree Diff** | The worktree's changed files in a row above the prompt: click one and a pane opens with its code, its diff and a Cursor-style editor. | [`plugins/worktree-diff/`](plugins/worktree-diff/README.md) |

<!-- Hidden until they are on the web:
| **After** | A prompt queue: `/after <task>` runs it when Claude finishes, without steering it. | [`plugins/after/`](plugins/after/README.md) |
| **Use Haiku** | Start a prompt with `_` and that turn runs on Haiku. | [`plugins/use-haiku/`](plugins/use-haiku/README.md) |
| **Think Hard** | Start a prompt with `+` and that turn thinks at max effort. | [`plugins/think-hard/`](plugins/think-hard/README.md) |
| **Token Meter** | Each turn's tokens and the session total, in color under the prompt. | [`plugins/token-meter/`](plugins/token-meter/README.md) |
-->

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install quick-peek@better-claude
/plugin install image-preview@better-claude
/plugin install sub-meter@better-claude
/plugin install context-meter@better-claude
/plugin install commit@better-claude
/plugin install narrator@better-claude
/plugin install time-machine@better-claude
/plugin install worktree-diff@better-claude
```

<!-- Hidden until they are on the web:
/plugin install after@better-claude
/plugin install use-haiku@better-claude
/plugin install think-hard@better-claude
/plugin install token-meter@better-claude
-->

To get new versions on their own, turn on auto-update: `/plugin` → **Marketplaces** → **better-claude** → **Enable auto-update**. Claude Code leaves it off for marketplaces outside Anthropic's.

This repository is the marketplace: [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) lists each plugin folder as a source.

## Development

Each plugin is its own folder with its own manifest. One `package.json` at the root runs everything: `npm test`, `npm run validate`, `npm run test:node` (After's and Time Machine's unit tests) and `npm run test:mod` (every plugin's tests against the engine).

MIT © Miguel Ángel Durán (midudev)
