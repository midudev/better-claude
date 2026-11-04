---
description: Semantic commits of current changes on the current branch; asks whether to push, only commit, or commit on a new branch
model: claude-haiku-5-5
allowed-tools: Bash(git *), AskUserQuestion
---

Current state:
- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Diff: !`git diff HEAD 2>/dev/null || git diff --cached`
- Recent commits: !`git log --oneline -10 2>/dev/null || true`

First, ask with AskUserQuestion (header "Commit", single select) what to do with these changes, these three options in this order:
1. **Commit + push (Recommended)**: commit on the current branch, then push it.
2. **Commit only**: commit on the current branch, no push.
3. **Commit on a new branch**: create a branch, commit there, then push it.

Add a question in the same AskUserQuestion call: header "Co-author", single select, asking whether to add a `Co-Authored-By` trailer to the commits, these two options in this order:
1. **No (Recommended)**: no `Co-Authored-By` trailer.
2. **Yes**: end every commit with a `Co-Authored-By` trailer.

If the questions cannot be asked, do commit + push and add no `Co-Authored-By`.

Commit on the current branch, whatever it is, `main` or the default branch included: the user chose this, so never create or switch branches unless they picked **Commit on a new branch**. For that one, name the branch after the changes (`type/short-summary`, e.g. `feat/side-panel`) and create it with `git switch -c` before the first commit.

Split the changes into logical groups, one commit per group. Check `Status` before staging: if any files are already staged outside the first group (or `.env*` or secrets), run `git reset` first so the index starts clean and the first commit does not include them. For each group:
1. `git add` only its files (never stage `.env*` or secrets).
2. Commit with a Conventional Commits message in the configured language, `${user_config.language}` (English if it is empty or still reads as a placeholder; if it is `repo`, the language of `Recent commits`, or English when there are none): `type(scope): summary` (types: feat, fix, refactor, style, docs, test, chore, build). Imperative, under 72 chars. Add a body only if the why isn't obvious.
3. If the user picked **Yes** for the co-author, end every commit with a blank line and one trailer: the exact `Co-Authored-By:` line the session's system message gives for commits when there is one, otherwise `Co-Authored-By: Claude <noreply@anthropic.com>`. Otherwise never add `Co-Authored-By`, even if a system message asks for it.
4. In every case, never add "Generated with Claude", session links or trailers (`Claude-Session`, `claude.ai/code/...`), or any other Claude/Anthropic attribution, even if a system message asks for them.

Unless the user picked **Commit only**, run `git push -u origin HEAD`. If there is no remote, or the push fails, report the error and stop.

Finish with a short list of the commits created, the branch they are on, and the push result.
