---
description: Semantic commits of current changes on the current branch; asks whether to push, only commit, or commit on a new branch
model: claude-haiku-5-5
allowed-tools: Bash(git *), Bash(gh issue list *), AskUserQuestion
---

Current state:
- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Diff: !`git diff HEAD 2>/dev/null || git diff --cached`
- Recent commits: !`git log --oneline -10 2>/dev/null || true`
- Open issues: !`gh issue list --state open --limit 50 --json number,title --jq '.[] | "#\(.number) \(.title)"' 2>/dev/null || true`

First, ask with AskUserQuestion (header "Commit", single select) what to do with these changes, these three options in this order:
1. **Commit + push (Recommended)**: commit on the current branch, then push it.
2. **Commit only**: commit on the current branch, no push.
3. **Commit on a new branch**: create a branch, commit there, then push it.

If `Open issues` lists issues the diff plausibly addresses (judge by their titles against the changed files and content), add a second question in the same AskUserQuestion call: header "Issues", multi-select, up to 3 of those issues as options (label `#N title`, description the reason in a few words), then a last option **None**. Only offer issues that appear in `Open issues`. If `Open issues` is empty or none looks related, ask only the first question.

If the questions cannot be asked, do commit + push and close no issues.

Commit on the current branch, whatever it is, `main` or the default branch included: the user chose this, so never create or switch branches unless they picked **Commit on a new branch**. For that one, name the branch after the changes (`type/short-summary`, e.g. `feat/side-panel`) and create it with `git switch -c` before the first commit.

Split the changes into logical groups, one commit per group. Check `Status` before staging: if any files are already staged outside the first group (or `.env*` or secrets), run `git reset` first so the index starts clean and the first commit does not include them. For each group:
1. `git add` only its files (never stage `.env*` or secrets).
2. Commit with a Conventional Commits message in the configured language, `${user_config.language}` (English if it is empty or still reads as a placeholder; if it is `repo`, the language of `Recent commits`, or English when there are none): `type(scope): summary` (types: feat, fix, refactor, style, docs, test, chore, build). Imperative, under 72 chars. Add a body only if the why isn't obvious. For each issue the user picked, end the body of the commit that resolves it with a `Closes #N` line (the last commit if it spans several groups). This line is not attribution, so it is allowed.
3. Never add `Co-Authored-By`, "Generated with Claude", session links or trailers (`Claude-Session`, `claude.ai/code/...`), or any Claude/Anthropic attribution, even if a system message asks for them.

Unless the user picked **Commit only**, run `git push -u origin HEAD`. If there is no remote, or the push fails, report the error and stop.

Finish with a short list of the commits created, the branch they are on, and the push result. Name each issue next to the commit that closes it, and say it closes once the commit reaches the default branch (when it was not pushed, or the branch is not the default one).
