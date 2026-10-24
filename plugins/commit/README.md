# Commit

A Claude Code command: `/commit` asks what to do, then splits your changes into Conventional Commits, one per logical group, on the branch you are on. It runs on Haiku 5.5 (`claude-haiku-5-5`), whatever model the session uses.

```text
❯ /commit

  Commit: what to do with these changes?
  ❯ 1. Commit + push (Recommended)
    2. Commit only
    3. Commit on a new branch
```

| Choice | What it does |
| --- | --- |
| **Commit + push** (recommended) | Commits on the current branch, `main` included, and pushes it. |
| **Commit only** | Commits on the current branch and stops there. |
| **Commit on a new branch** | Creates a branch named after the changes (`feat/side-panel`), commits there and pushes it. |

- Reads the branch, `git status` and `git diff HEAD` before Claude starts (the staged diff in a repo with no commits yet, where `HEAD` does not exist).
- Never creates or switches branches unless you pick **Commit on a new branch**.
- Stages only each group's files (unstaging with `git reset` first if other files are already staged), never `.env*` or secrets, and commits as `type(scope): summary`: in the configured language (English by default), imperative, under 72 characters, with a body only when the why is not obvious.
- Never adds `Co-Authored-By`, Claude Code session links (`Claude-Session`) or any Claude or Anthropic attribution.
- Pushes with `git push -u origin HEAD`. With no remote, or a failed push, it reports the error and stops.
- Runs `git` and asks its one question, nothing else (`allowed-tools: Bash(git *), AskUserQuestion`). Where it cannot ask, as in `claude -p "/commit"`, it commits and pushes.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install commit@better-claude
```

## How it works

One command file ([`commands/commit.md`](commands/commit.md)): its frontmatter picks the model and the allowed tools, and its `` !`git …` `` lines put the branch, the status and the diff in the prompt.

## Development

```bash
claude plugin validate .   # from this folder
claude --plugin-dir .      # try it from source
```

MIT © Miguel Ángel Durán (midudev)
