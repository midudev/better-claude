# Quick Peek

A Claude Code mod: the paths in Claude's replies become links. Hover one and a preview opens by the pointer, a file of code with its lines coloured; click it and Finder opens with the file selected.

```text
⏺ I made two versions of the opening. Pick the one you like:

  - A, from inside the lamp: it starts against the glass and the camera shoots out.
    /Users/midudev/Dev/video/review/draft.mp4             ← hover: its frame · click: Finder
  - B, the journey: the camera flies along the wall.
    /Users/midudev/Dev/video/review/draft-01-journey.mp4

  The cut between them is set in src/timeline.ts:42       ← hover: its lines, 42 lit
```

- **Which paths**: absolute (`/Users/…`), from home (`~/…`), relative (`./x`, `src/app.ts`, `README.md`: from the folder the shell is in, else from the project's, so they still lead somewhere after a `cd`), with or without backticks, and with a `:line` or `:line:column` after them. Only the paths that lead to a file or a folder become links; the rest stay as Claude wrote them. Inside backticks a path may hold spaces.
- **Hover**: the path is underlined and a small window opens by the pointer, above it and to its right, without taking the focus: the file's Quick Look thumbnail (a video's frame, an image, a PDF's or a document's first page), else its icon; its name, its kind, size and age as your system words them, and the folder it is in. A folder shows its icon and its first entries. Move off the path and it closes.
- **Code**: a file of code or text (`.js`, `.ts`, `.tsx`, `.html`, `.css`, `.json`, `.md`, `.py`, `.go`, `.rs`, `.sh`, `.yml`, a `Dockerfile`, a `.env` and many more) shows its first 20 lines instead, numbered and coloured, its language and how many lines it has under them. A path with a line (`src/app.ts:42`) shows the lines around it, that one lit.
- **Click**: Finder opens the folder with the file selected (`open -R`). **Option-click** (**Alt-click** on Windows) opens the file itself, with its app.

A path a row cannot hold is drawn in parts, cut after a `/`, and each part is the link. Hovering needs the mouse, so it needs Claude Code's fullscreen interface (`"tui": "fullscreen"` in your settings, or `/config`).

## Other systems

| System | Click | Hover |
| --- | --- | --- |
| macOS | Finder, the file selected | A window by the pointer, with the Quick Look thumbnail |
| Linux | The file manager, the file selected (`org.freedesktop.FileManager1`), else its folder with `xdg-open` | A one-line card over the path: name, size, age; a file of code, its first 8 lines under it |
| Windows | Explorer, the file selected (`explorer /select,`) | A window by the pointer, with the shell's thumbnail (a PDF's first page, rendered by Windows itself), run by PowerShell: nothing to install |
| WSL | Windows' Explorer, the path turned into its Windows form by `wslpath -w` | The card |

Turn the window off with the **Preview in a window** option (`/config`) to get the card on macOS and Windows too. Over SSH the window would open on the other machine, so there the card shows. On Windows the date under the name is in your regional format, not an age; where PowerShell may not compile code (Constrained Language Mode, AppLocker), the card shows.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install quick-peek@better-claude
```

## Limits

- Only Claude's replies: paths in tool rows (`Read(…)`, a command's output) and in your prompts stay as they are.
- A reply with a path that leads somewhere is drawn by the mod: its paragraphs and lists that hold such a path are laid out by the mod as Claude Code lays them out (bold, italics, code, links, nested and numbered lists), and every other block (headings, code blocks, tables, quotes) by Claude Code's own Markdown. A path in a heading, a table, a quote or a code block is no link.
- In plain text a path ends at a space or a bracket: a path with spaces is a link only inside backticks.
- A path is looked at when the reply is drawn; one created later becomes a link the next time the reply is drawn (scrolling it into view).
- Dragging to select text that starts on a path does not select: the path takes the pointer.
- A window stays a minute at most, and closes when another app comes to the front or the pointer goes a few rows away (the terminal does not say when the pointer leaves it).
- The card is drawn over the rows above the path (nine for a file of code): on the first rows on screen it is cut.
- A file of code over 1 MB, or one with what text never holds (a NUL), shows its thumbnail or icon, not its lines. Its colours come from a small highlighter of the mod's own in the window, and from Claude Code's in the card; lines inside a block comment that opens above them are coloured as code.
- An SVG is a picture: it shows its thumbnail, not its source.
- Option-click needs the terminal to report the Option key with the click; some keep Option-click for themselves. On Windows, Windows Terminal and VS Code's terminal report Alt with the click.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)), a surface module for the links ([`hooks/link.tsx`](hooks/link.tsx)), the markdown it lays out ([`hooks/markdown.ts`](hooks/markdown.ts)), the paths it finds ([`hooks/paths.ts`](hooks/paths.ts)), the code it previews ([`hooks/code.ts`](hooks/code.ts)) and the window's program ([`hooks/window.ts`](hooks/window.ts)):

- A `ui.render` hook on `AssistantMessage` cuts the reply into blocks and finds the paths in its paragraphs and list items, inline code included. Each is resolved (`~`, the shell's folder, else the project's: `$.session.root()`) and looked at with `$.fs.stat`, the answers kept a few seconds.
- With none that leads somewhere, Claude Code draws the reply. Otherwise the mod draws it: the bullet, the blocks with no path as one `Markdown` each, and the others wrapped into rows the way Claude Code wraps a reply, each part of a path a `Client` drawing that part in the color of inline code. The tree replaces only Claude Code's own node, so what other mods draw around a reply stays.
- Each `Client` posts when the pointer comes onto it, moves on it and leaves it, and when it is clicked; a `ui.message` hook opens and closes the preview, or shows the path in the file manager.
- On macOS a hover starts `osascript` with a JavaScript for Automation program, told the path (`QUICK_PEEK_FILE`), the picture's largest side and how long it may stay. It draws an AppKit panel that never takes the focus or the pointer, with the thumbnail from `QLThumbnailImageCreate` and the kind, size and date from the file's resource values, formatted by the system. It says `shown`, then a `.` every tenth of a second, so the mod wakes to end it when the pointer leaves.
- On Windows a hover starts `powershell -STA` with the same protocol. Its window is a Windows Forms tool window in C#, never activated, the pointer passing through it, that PowerShell compiles once into `%TEMP%` (`quick-peek-window-<hash>.dll`: the first hover takes a second or two, the rest a few tenths) and is told in `QUICK_PEEK_TYPES`, as a command line would not hold it. The picture is the shell's thumbnail (`IShellItemImageFactory`), else its icon; a PDF's first page is rendered by `Windows.Data.Pdf`, as the shell may have no thumbnail for it. The kind and size are the shell's words.
- A file of code or text is known by its name. The mod reads it with `$.fs.read`, cuts the lines a preview shows (around the line the path names), and colours them with a regex highlighter per language; the window is told them as JSON (`QUICK_PEEK_CODE`) and draws them on a plate, one monospaced label a line, in place of the thumbnail.
- Without a window, each part of a path is a keyed `Box` holding a card drawn `display: "none"`, which the terminal reveals while the pointer is on the path, with no hook running. A file of code adds its lines to the card as a `Code` element, which Claude Code colours with its own highlighter.

## Development

```bash
claude plugin validate ./plugins/quick-peek   # from the repository root
claude plugin test ./plugins/quick-peek       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
