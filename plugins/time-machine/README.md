# Time Machine

A Claude Code mod: your files get a history of states, like an editor's undo tree. Every turn that changes files is a git snapshot off your history, and `/timeline` takes the working tree to any of them and back. Edits, writes and Bash all count: a `sed`, a codegen or an `rm` is undone like an Edit. Nothing is ever lost: your own unsaved changes are kept before a jump.

```text
❯ /timeline

  ⏪ Time Machine · Marty's DeLorean                               5 states

  ⠹  add rate limiting to the API                                      12s
  │  8 files +212 −40 · api/ ×5 · middleware/ ×2 · +1
  ◉  #4  add a migration for the users table                            5m
  │  + migrations/0007_users.sql +48   ~ db/schema.ts +12 −3
  ○  #3  another way to do it                                           7m
  │  ~ src/auth.ts +9 −2
  ●  #1  start of the session                                          14m
     no files

  ──────────────────────────────────────────────────────────────────────
  selected #3 · 7m   current #4 · 5m   jumped from —
  › another way to do it: keep the sessions in Redis instead of the
    database, and drop the cleanup job
  ⏎ go here: ~ src/auth.ts +2 −9   − migrations/0007_users.sql −48
  ↑↓ choose · ⏎ go   undo   redo
```

- **One row per state, not per action.** Going to a state moves the cursor `◉` and the files; it adds no row.
- **You always see where the files are**: `◉` on their row and `current` in the footer, or a yellow row when you changed files by hand since.
- **Enter goes to a state; choosing a row shows first which files would change.** `u`/`r` undo and redo: undo goes to the state the current one came from, redo to the newest state that came from it.
- **Branches are kept.** Go back and let Claude take another way: the old way stays, dimmed (`○ … undone`), one Enter away.
- **Your changes are never lost.** Files changed by hand since the cursor are saved as a state (`your changes, kept before a jump`) before any jump, so a jump needs no confirmation.
- **Claude hears it once.** With your next prompt it reads which files differ from how it left them; five jumps that end where it left them say nothing.
- **The turn under way shows at once**, with a spinner and its time, the moment you send a prompt; its files and lines fill in as Claude edits, and it lands as a state when the turn ends (or goes, when it changed nothing).
- **The files fit one line, however many**: one or two by their short path; more as the total, the lines and the biggest folders under the one they all share (`8 files +212 −40 · api/ ×5 · tests/ ×2 · +1`).
- **The footer stays put**: docked beside the transcript it is pinned to the bottom, with the whole prompt of the chosen row (two lines), what Enter would do and the keys. Each part has a fixed height, so moving between rows only changes what is written; with more states than fit, the list is a window around the chosen row (`↑ 3 newer`, `↓ 2 older`).
- **Nothing moves under the pointer**: the running row is as tall as any other.
- From the prompt: `/timeline <n>`, `/timeline undo`, `/timeline redo`.

## The DeLorean

The DeLorean is yours: the header names the first name git knows you by (`Marty's DeLorean`), or `Your DeLorean`. Under the list, where things stand in the colors of its time circuits: **selected** (red) is the state Enter goes to, **current** (green) the one the files are in, **jumped from** (amber) the one they left on the last jump, so the way back is always in sight. A jump runs at ⚡ 88 mph, the oldest state is as far back as Great Scott allows, and where we're going, we don't need branches.

## How it differs from Claude Code's own checkpoints

Claude Code already rewinds the edits its file tools made (`Esc Esc`, `/rewind`). Time Machine snapshots the **whole working tree** with git instead, so it also brings back what Bash changed (a formatter, `npm install` touching the lockfile, a script that generates files, an `rm`), and the snapshots outlive the session: a resumed session finds them. The two live side by side.

## What it never touches

- **Your history**: snapshots are commits no branch points at, kept by refs under `refs/time-machine/<session>/<n>`. `git log` does not show them.
- **Your staging area**: they are built in an index of their own (`.git/time-machine.index`), so what you staged stays staged.
- **Ignored files**: `.env`, `node_modules/` and anything else `.gitignore` matches are neither saved nor put back.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install time-machine@better-claude
```

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| **Keep snapshots for (days)** | 7 | Older snapshots are dropped when a session starts; git's next gc frees their space. |

## Limits

- It needs a git repository; elsewhere `/timeline` says so and nothing is snapshotted.
- A snapshot stores every file that is not ignored, untracked ones included. A large untracked file that is not in `.gitignore` grows `.git` until its snapshot is dropped.
- A jump waits for the turn to end, and for any tool still writing (a background agent's included): until then it refuses. It also refuses when the files it would write include an ignored one on disk, or more than can all be checked.
- A turn whose tools leave the files as they were (a test run that writes nothing) adds no state.
- A Bash command that only looks (`ls`, `cat`, `grep`, `rg`, `git status`, `git log`, … chained with `|`, `&&` or `;`) takes no snapshot. Any redirection, `$(…)`, `tee`, `xargs`, `find -delete` or `-exec`, or a command it does not know, does: when unsure, it snapshots.

## Cost

Measured on a repository of 12,800 files (Apple Silicon):

| Step | Time |
| --- | --- |
| First snapshot of a session | 283 ms |
| Start of a turn that changes files | 154 ms |
| End of a turn | 142 ms |
| A jump back | ~170 ms |

Most of it is `git add -A` walking the tree, git's own floor; about 35 ms is the check that keeps files the .gitignore now matches out of the snapshots. The index starts as a copy of the repository's, which carries the stat data of every file (without it the first snapshot hashes the whole tree: 491 ms).

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)) over plain modules in `src/`, each tested on its own with `node --test`:

- [`src/git.js`](src/git.js): snapshots, moves and refs, run through `$.process.run`.
- [`src/states.js`](src/states.js): the history as data: which states the files are made of, the next id, the merge after a hot reload.
- [`src/tools.js`](src/tools.js) and [`src/bash.js`](src/bash.js): which tool calls may write, Bash by its command. When unsure, a call may write and gets its snapshot.
- [`src/format.js`](src/format.js): how states and their files read, in the pane and in the transcript.

The hooks:

- `tool.call` on any tool that may write (see `src/tools.js`: not Read, Grep, a Bash command that only looks or an MCP `get_`/`list_` tool): the first one of a turn writes the tree as it is before it runs (`add -A` and `write-tree` in Time Machine's own index, seeded from HEAD with `read-tree -m HEAD` whenever HEAD moves).
- `turn.complete` writes the tree again. Unchanged, nothing is kept. Changed, the turn becomes a state (`commit-tree` and a ref), its parent the state holding the starting tree, or a new `start of the session` / `changes outside Claude` state when none does.
- A jump reads the tree, keeps it as a state when it is no state's, then moves the files with `read-tree -m -u <now> <target>`: files the target lacks are removed and the rest written.
- `prompt.submit`, after jumps, compares the tree with the one Claude's last turn left and adds one note to the prompt's `context` when they differ.
- The states and the cursor live in `$.state` (the pane redraws from them) and in `$.store` under the session's id.

## Development

```bash
claude plugin validate ./plugins/time-machine          # from the repository root
claude plugin test ./plugins/time-machine              # hooks/register.test.tsx against the engine
node --test "plugins/time-machine/test/*.test.js"      # src/: git against a real git, the rest pure
```

MIT © DiegoMarty
