# Commit

A Claude Code command: `/commit` asks what to do, then splits your changes into Conventional Commits, one per logical group, on the branch you are on. It runs on Haiku 5.5 (`claude-haiku-5-5`), whatever model the session uses.

```text
❯ /commit

  Commit: what to do with these changes?
  ❯ 1. Commit + push (Recommended)
    2. Commit only
    3. Commit on a new branch

  Issues: close any of these with the commit?
  ❯ [ ] #40 Commit: Ask for closing any gh issues
    [ ] None
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
- Reads the repository's open issues with `gh issue list`. When some look related to your changes, it asks a second question (multi-select, up to 3 issues, or none) and adds `Closes #N` to the commit that resolves each one picked, so GitHub closes them once the commit reaches the default branch. Without `gh`, a login or a GitHub remote, it skips this silently.
- Pushes with `git push -u origin HEAD`. With no remote, or a failed push, it reports the error and stops.
- Runs `git` and `gh issue list` and asks its questions, nothing else (`allowed-tools: Bash(git *), Bash(gh issue list *), AskUserQuestion`). Where it cannot ask, as in `claude -p "/commit"`, it commits and pushes, and closes no issues.

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
