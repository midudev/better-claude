# better-claude

<img width="1590" height="576" alt="CleanShot 2026-10-15 at 14 38 45@2x" src="https://github.com/user-attachments/assets/67b271e6-254e-4429-9273-9571fe98f79b" />

Plugins and mods for Claude Code by midudev, one per folder in [`plugins/`](plugins):

| Plugin | What it does | Folder |
| --- | --- | --- |
| **Image Preview** | Hover a pasted `[Image #N]` to see the picture, while you write and on the prompts you sent. | [`plugins/image-preview/`](plugins/image-preview/README.md) |
| **Sub Meter** | Subscription usage at the bottom right: the 5-hour and weekly windows, as a bar. | [`plugins/sub-meter/`](plugins/sub-meter/README.md) |
| **Commit** | `/commit` asks commit + push, commit only or a new branch, then splits your changes into Conventional Commits, on Haiku 5.5. | [`plugins/commit/`](plugins/commit/README.md) |

<!-- Hidden until they are on the web:
| **Time Machine** | Every turn that changes files is a git snapshot: `/timeline` puts the files back as before any turn, Bash changes included. | [`plugins/time-machine/`](plugins/time-machine/README.md) |
| **After** | A prompt queue: `/after <task>` runs it when Claude finishes, without steering it. | [`plugins/after/`](plugins/after/README.md) |
| **Use Haiku** | Start a prompt with `_` and that turn runs on Haiku. | [`plugins/use-haiku/`](plugins/use-haiku/README.md) |
| **Think Hard** | Start a prompt with `+` and that turn thinks at max effort. | [`plugins/think-hard/`](plugins/think-hard/README.md) |
| **Token Meter** | Each turn's tokens and the session total, in color under the prompt. | [`plugins/token-meter/`](plugins/token-meter/README.md) |
-->

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install image-preview@better-claude
/plugin install sub-meter@better-claude
/plugin install commit@better-claude
```

<!-- Hidden until they are on the web:
/plugin install time-machine@better-claude
/plugin install after@better-claude
/plugin install use-haiku@better-claude
/plugin install think-hard@better-claude
/plugin install token-meter@better-claude
-->

This repository is the marketplace: [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) lists each plugin folder as a source.

## Development

Each plugin is its own folder with its own manifest. One `package.json` at the root runs everything: `npm test`, `npm run validate`, `npm run test:node` (After's and Time Machine's unit tests) and `npm run test:mod` (every plugin's tests against the engine).

MIT © Miguel Ángel Durán (midudev)
