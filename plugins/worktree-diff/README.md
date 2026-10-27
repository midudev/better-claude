# Worktree Diff

A Claude Code mod: the files that changed in the session's worktree, in one row above the prompt. Click one and a pane opens with its code, its diff and a Cursor-style editor, so you see what Claude changed without leaving the terminal.

```text
⎇ 23 changes +412 -88 │ [README.md] +2 [register.tsx] +210 -60 [pane.test.tsx] +15 -5 +20 more
──────────────────────────────────────────────────────────────────
❯
```

- **The row above the prompt**: always one line. It starts with a summary (`⎇ 23 changes +412 -88`) that opens the list of every changed file, goes on with a `[file]` for each one that fits, and ends with `+N more`.
- **The list**: like Cursor's Source Control pane: name, folder in gray, lines added and removed, and the status letter (M, U, A, D). Click one to open it; `‹` goes back to the list. `/worktree` opens it. **✕** closes the pane.
- **Code**: the file with a breadcrumb (`folder › file › # section`), line numbers, syntax highlighting (Markdown and code) and a mark in the gutter on every line added (green), modified (blue) or deleted (red). It scrolls with the wheel and draws only what is in view, so a file of any size works.
- **Edit**: an editor like Warp's, inside the pane: line numbers, colors, change marks, a cursor and a status bar (`Ln 12, Col 4 · ✓ saved`). Click the text to type; arrows, Home/End, PageUp/PageDown, Tab; Enter keeps the indentation. With *Autosave* on it saves once you stop typing; `ctrl+s` saves at once; Esc gives the keyboard back to the prompt.
- **Tabs**: *Preview* and *Markdown* on `.md` files, *Code* on the rest, *Edit*, and *Changes* with the diff in color.
- **Environment variables**: `.env`, `.env.*` and `.dev.vars` at the root of the repository show too, even when `.gitignore` hides them from git. Their values stay masked until you press *Show values*; then each one can be edited, removed or added one by one.
- **↗**: opens the file in your external editor (configurable).
- The pane has a darker background than the terminal (configurable). It works with the keyboard or the mouse.

The row shows up above the prompt as soon as the worktree has changes. Clicking it needs Claude Code's fullscreen interface (`"tui": "fullscreen"` in your settings, or `/config`); without a mouse, ctrl+x tab moves the focus to the row.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install worktree-diff@better-claude
```

## Options

In `/config`:

- **External editor**: the command that opens a file, the path appended at the end. `open` by default (the default app on macOS). Examples: `open -a Warp`, `code -g`, `zed`, `cursor`.
- **Pane background**: the pane's background color. `#0a0a0a` by default. Left empty, the pane uses the terminal's background (handy with a light theme).

## Limits

- The list and the row cover the session's worktree alone: what `git status` reports from its root, plus the env files at that root.
- Only the terminal draws the editor (a surface module). The desktop and mobile apps show the code, the diff and the variables; there, *Edit* says to use ↗ instead.
- A file over 80,000 characters is not editable in the pane (↗ opens it outside), and a diff is cut at 90,000 characters.
- The counts of a new file come from reading it, for the first 50 new files; the rest show without counts.
- The list shows the first 400 files and counts the rest.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)), the editor as a surface module ([`hooks/editor.tsx`](hooks/editor.tsx)) and the palette and highlighters they share ([`hooks/paint.ts`](hooks/paint.ts)):

- `session.start` registers `/worktree` and reads the worktree: `git status --porcelain -z`, `git diff --numstat` for the counts, `git branch --show-current`, and the root's entries for the env files. A `tool.call` hook reads it again after every `Edit`, `Write`, `MultiEdit`, `NotebookEdit` or `Bash`, and the open file follows what Claude just changed in it.
- A `ui.render` hook on `AbovePrompt` draws the row under what is beneath: as many chips as fit in the row's columns, the rest counted.
- Clicking a chip or a row of the list reads the file and its diff (`git diff HEAD -- <file>`, or `--no-index` against `/dev/null` for a new one) and opens the pane (`$.ui.open`), drawn by a `ui.render` hook on `Pane`.
- The code view draws only the lines in view: a `ui.scroll` hook moves its window, and the gutter marks come from the diff's hunks (a `-` then `+` run is modified, a `+` alone added, a `-` alone marks where lines were).
- The editor is a `Client` surface module with its own buffer, cursor and window. It posts what is typed as a `ui.message`; the hooks module saves it after a pause under autosave (`$.clock.after`), or at once on `ctrl+s` (`$.fs.write`). A file read again replaces a buffer with nothing unsaved.
- The variables view parses `KEY=value` lines; each change rewrites that line alone and keeps the rest of the file as it was.

## Development

```bash
claude plugin validate ./plugins/worktree-diff   # from the repository root
claude plugin test ./plugins/worktree-diff       # runs hooks/register.test.tsx against the engine
```

MIT © Neftali Hernandez (NNeshz)
