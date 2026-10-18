# Image Preview

A Claude Code mod: hover a pasted `[Image #1]` and the picture opens by the pointer, in a small window of its own or drawn in the terminal. Click it and the image opens in the system's viewer.

```text
[Image #1] hover to preview · click to open        ← hover: the picture opens by the pointer
──────────────────────────────────────────────────
❯ what is wrong in this screenshot? [Image #1]
```

- **While you write**: paste an image and a row above the prompt lists its `[Image #N]`. Put the pointer on one and its preview opens; move it off and the preview closes. Click it and the image opens in Preview on macOS, in the system's viewer elsewhere.
- **After you send it**: put the pointer on an `[Image #N]` in the first line of the prompt you sent, or on the `⎿ [Image #N]` rows Claude Code lists under it, and its preview opens. Click the `[Image #N]` in the prompt to open the image.

The preview shows only while the pointer is on the `[Image #N]` that opened it. Typing, sending the prompt or a click closes it, and so does the transcript moving under a sent prompt's; moving the pointer on the `[Image #N]` again opens it again.

Hovering needs the mouse, so it needs Claude Code's fullscreen interface (`"tui": "fullscreen"` in your settings, or `/config`).

## In a window, by the pointer

Where the terminal cannot draw a picture itself (Warp, iTerm2, Terminal.app, VS Code), the preview is a small borderless window outside the terminal: above the pointer and to its right, under it or to its left where the screen has no room, never over the pointer. It never takes the focus or the pointer, so you keep typing and hovering in the terminal, and it stands over every window, full-screen ones too. It shows in about a third of a second.

The picture shows as it is, sharp: a screenshot of text reads as it was. It is shrunk only to fit 800 points on its longest side and 70% of the screen, and never enlarged. Each system draws the window with what it has:

| System | The window | Needs |
| --- | --- | --- |
| macOS | An AppKit panel with the HUD material, round corners and a shadow, run by `osascript` (JavaScript for Automation) | Nothing to install |
| Windows | A Windows Forms tool window, run by PowerShell | Nothing to install |
| WSL | The same Windows Forms window, run by `powershell.exe` from WSL, by the Windows pointer | Nothing to install |
| Linux | A Tk tooltip window on X11, the picture shrunk to a PNG | Python's Tk (`python3-tk` on Debian and Ubuntu, `python3-tkinter` on Fedora) and ImageMagick |

Turn it off with the **Preview in a window** option (`/config`) to keep the preview in the terminal. Over SSH the window would open on the other machine, so there the terminal draws it. Where the window's program cannot show one, the terminal draws the previews for the rest of the session.

## In the terminal

In Ghostty and kitty the terminal draws the picture itself, through the kitty graphics protocol. Elsewhere, without the window, it is drawn in colored block elements: each cell is sampled at eight by eight points, in linear light, and drawn with the half, eighth or quarter block (`▀ ▂ ▎ ▚ …`) that splits those points best, in their two colors, in any terminal with true color. Cells are coarse: a screenshot of text shows its layout, not text you can read.

```text
  12
╭──────────────────────────────────────────╮
│▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
│▃▁▁▘▘▁▃▀▀▖▗▀▖▗▀▏▊▎▗▘▃▗▀▖▀▂▁▉▚▉▘▏▗▀▖▗▀▖▀▀▀│   ← the picture, in color, over the transcript
│[Image #1] PNG · 151 KB                   │
╰──────────────────────────────────────────╯
[Image #1] hover to preview · click to open
```

The card floats over the transcript and moves nothing: the transcript does not scroll, the prompt does not jump, and the `[Image #N]` that opened it stays uncovered. A card from the row above the prompt floats over the lowest rows of the transcript; on a screen too short for that, it opens in that row, which grows to hold it. One from a sent prompt opens above the prompt or under its list, wherever there are more rows; where neither has six, it does not open.

Warp speaks the kitty graphics protocol, but not the Unicode placeholders Claude Code draws pictures with, so Warp cannot draw it in the terminal. `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` makes this mod send the picture to a terminal Claude Code does not know draws pictures; it only helps in one that supports those placeholders. It sends a PNG of up to 1024 pixels and 2 MB; a larger one is drawn in cells.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install image-preview@better-claude
```

## Limits

- The text inside the prompt box can only be colored by a mod, not hovered, so while you write the pointer target is the row above it, not the `[Image #N]` in the box itself.
- In a sent prompt, the `[Image #N]` takes the pointer and the click in the prompt's first line only, before it would wrap: past that, the mod cannot tell where the line puts it. The `⎿ [Image #N]` rows show the preview but take no click, which Claude Code keeps for itself.
- A window stays two minutes at most, even with the pointer still on its `[Image #N]`: move off and back on to open it again.
- A click opens the image with `open -a Preview` on macOS, `explorer` on Windows, `explorer.exe` under WSL (the path turned into its Windows form by `wslpath -w`), `xdg-open` elsewhere.
- On Linux the window needs X11 (or XWayland): under Wayland alone there is none, and the terminal draws the card. Under XWayland the window may not stand by the pointer when the terminal is a Wayland window.
- On Windows the first window compiles a small helper into the temp folder, which takes a second. The Windows window and converter have been written and checked (the scripts parse, the commands are tested) and have been run on Windows from WSL.
- Under WSL (`WSL_DISTRO_NAME` is set) the session is Linux but the desktop is Windows', so the window, the converter and the viewer are Windows': a WSLg window could not tell where the pointer is over a Windows terminal.
- Hovering needs the terminal to report mouse motion. A terminal multiplexer between Claude Code and the terminal must pass it on: in testing, herdr 0.9.1 did not, and no preview opened.
- It reads the images Claude Code stores for the session, in its temp folder (`<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/…/images`; on Windows `<CLAUDE_CODE_TMPDIR or %TEMP%>\claude\…\images`), and keeps its shrunk copies in an `image-preview` folder beside them. Images from a session started before you installed the mod are found too; images from another session are not.
- A session resumed with `--continue` draws its rows all at once, its prompts apart from the rest; the mod puts them back in order by turns. A turn with no `done` line (one interrupted) can put a card a few rows off.
- It shrinks the picture with `sips` on macOS, ImageMagick (`magick` or `convert`) on Linux, and ImageMagick or PowerShell on Windows and under WSL (there `powershell.exe`, its variables passed through `WSLENV`). Without them, the card says it cannot read it.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)), a surface module for the pointer targets ([`hooks/chip.tsx`](hooks/chip.tsx)), a decoder ([`hooks/pixels.ts`](hooks/pixels.ts)) and the window programs ([`hooks/window.ts`](hooks/window.ts)):

- `prompt.edit` and a look at the box every half second (a paste puts the placeholder there without an edit event) keep the list of `[Image #N]` in the draft.
- Each image is found in the session's temp folder, shrunk to a BMP of 800 pixels with `sips`, ImageMagick or PowerShell, and parsed into pixels; each cell is sampled from them in linear light at eight by eight points.
- Each `[Image #N]` is a `Client`: in the band, a chip it draws; in a sent prompt, an unpainted region laid over the `[Image #N]` Claude Code draws, in the prompt and in the rows under it. It posts when the pointer comes onto it, moves on it and leaves it, and when it is clicked; a `ui.message` hook opens and closes the preview, or opens the image.
- In a window, a hover starts the system's program with `$.process.spawn`, told the picture, its largest side and how long it may stay (`IMAGE_PREVIEW_FILE`, `IMAGE_PREVIEW_SIZE`, `IMAGE_PREVIEW_LIFE`). It says `shown` once the window is up, then a `.` every tenth of a second, so the mod wakes to end it when the pointer leaves: it stops reading, and the program ends. One that ends without saying `shown` hands the previews back to the terminal.
- In the terminal, a `ui.render` hook on every transcript row notes which of its rows show. The card is drawn `position: "absolute"` (out of the flow, so it moves nothing) in the row that holds it: the lowest on screen for a chip of the band, the sent prompt itself or the lowest row for its list. It covers only rows drawn before that row, never the `[Image #N]` that opened it. Only the row the card leaves and the one it joins draw again (a state family, one flag per row).

## Development

```bash
claude plugin validate ./plugins/image-preview   # from the repository root
claude plugin test ./plugins/image-preview       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
