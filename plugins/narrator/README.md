# Narrator

A Claude Code mod: click `⏸︎ narrator off` at the bottom right of the prompt, or type `/narrator`, and after each turn Claude tells you out loud what it did, in your language, with the best free voice your system has.

```text
❯ _
  ? for shortcuts                                   ⏵ narrator on
```

The switch reads like the footer's mode labels (`⏵⏵ auto mode on`), in quiet colors: `⏵ narrator on` in green, `⏸︎ narrator off` in gray. A click switches it (in fullscreen, where the terminal reports clicks); `/narrator` does it anywhere.

While it speaks the switch reads `⏹︎ narrating` in blue, a lighter blue sweeping across it from left to right, and a click stops it, leaving the narrator on. When narrations of other windows wait their turn behind it, it reads `⏭︎ narrating`, and a click skips to the next one.

With a language set (see Settings) the switch shows it after its words: `⏵ narrator on · ES`, `⏸︎ narrator off · ES`, `⏹︎ narrating · ES`.

Where the footer is short the switch gives up `on` or `off`, then the language, then `narrator` (or `narrating`), and stays a `⏵`, `⏸︎`, `⏹︎` or `⏭︎` in its color, so the row never breaks in two. Beside [Sub Meter](../sub-meter), the meter shrinks first.

When a turn ends, Haiku (at low effort, so it is quick) reads your request, the tools Claude used and its final message, and writes one or two short spoken sentences in first person, said to you ("I added the narrator and the tests pass"), ending with Claude's question when it asked you one ("Do I open a PR?"), in the language you wrote in, or the one you set (see Settings). Haiku also names that language, and the mod picks the best voice installed for it; where there is none, the English one. When the request's words tell its language, Haiku is told to speak it, and a narration in another language is not said: the answer itself is read instead. A short answer already says it, so it is read out as it is, with no Haiku call: a path by its file's name (`hooks/register.tsx`: "register") and no commit hashes, in the language its words or your request tell, else the one the last narration was in (on Windows and Linux, Haiku narrates it while neither tells; macOS tells the language from the text). With a language set, a short answer is read as it is only when its words or your request tell it is in that language; any other, Haiku says in it. `/recap` is spoken too.

| System | Voice |
| --- | --- |
| macOS | AVSpeechSynthesizer: Siri's natural voices first, then premium, enhanced and compact ones, in your region (`say` cannot reach Siri's) |
| Windows | Windows.Media.SpeechSynthesis, the OneCore voices Narrator uses; the desktop SAPI voices where WinRT does not load |
| WSL | Windows' voices, through `powershell.exe`; Linux's where that does not run |
| Linux | `spd-say` (speech-dispatcher, with whatever module it is set up with: espeak-ng, RHVoice, Piper...), else `espeak-ng` or `espeak` |

A new prompt cuts the narration short. It stays on in your next sessions until you switch it off. A session nobody is at (`claude -p`, as a script or a bot that runs Claude Code uses) is not narrated.

```text
/narrator         switch on or off
/narrator on|off
/narrator stop    quiet now, stay on
/narrator again   say the last narration again
/narrator read    read the last answer in full
/narrator voices  list the installed voices, by language
/narrator test [voice]  say a short sample with a voice
```

`/narrator again` says the last narration again, as it was, with no model call. `/narrator read` reads Claude's last answer in full instead of its summary, as plain text (no code blocks, a path by its file's name), even with the narrator off; a long one takes a while, and `/narrator stop`, a click on the switch or a new prompt cuts it short.

`/narrator voices` lists the voices your system has, one line per language (`es-ES: Eddy, Mónica`); on macOS it leaves out the novelty ones (Bahh, Bells...). On Linux it shows speech-dispatcher's table, whose NAME column holds the voices of its output module, and eSpeak's.

`/narrator test` says a short English sample with the voice in `/config` (or, if it is empty, the one the system picks), and tells you which voice spoke. Pass a voice to try it without changing `/config`: `/narrator test Microsoft Helena`. A name several languages share (Eddy) can take its language, as `/narrator voices` shows it: `/narrator test Eddy (es-MX)`. If the system has no voice by that name, the preview says so and names the one it used instead.

### Better voices

- **macOS**: System Settings → Accessibility → Spoken Content → System voice → Manage Voices, and download a Siri voice or a Premium one for your language.
- **Windows**: Settings → Time & language → Speech → Add voices.
- **Linux**: `sudo apt install speech-dispatcher espeak-ng`; for natural voices, set speech-dispatcher up with RHVoice or Piper.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install narrator@better-claude
```

## Settings

In `/config`:

- **Voice**: a voice's name (`Mónica`, `Microsoft Helena`, or `Eddy (es-MX)` for one language's) to always speak with. Empty: the best one for the language. `/narrator voices` lists them and `/narrator test` tries one.
- **Language**: a language code (`es`, `en`, `pt`) to always narrate in, whatever language you write in; a region is dropped (`es-MX`: `es`, the voice's region still comes from the system). It is checked against the runtime's language list: an unknown value (`zz`, a typo, any other text) is ignored, and the narrator goes back to automatic. The switch then shows it (`⏵ narrator on · ES`). Empty: the language you write in, and the switch shows none.
- **Speed**: how fast it speaks, as a multiple of the voice's normal pace, from `0.5` to `2`: `1.3` by default, a little quicker; `1` is the voice's own. The engine's voice, the last resort, keeps its own pace.
- **Read short answers as they are**: an answer up to this many characters (200 by default) is read out as it is, with no Haiku call to retell it. `0`: Haiku narrates every answer.
- **Model that writes the narration**: `haiku` by default.
- **Speak command**: a program of your own to say each narration with, in place of the system's voice, on macOS, Windows and Linux (WSL too). The system shell runs it with the narration as its last argument, so `my-tts --voice Mónica` runs `my-tts --voice Mónica "<narration>"`; it can also read `NARRATOR_TEXT` and `NARRATOR_LANG`, the narration and its language. On Windows, `.cmd`/`.bat` scripts and `cmd.exe` read the narration from `NARRATOR_TEXT` only, because placing arbitrary text on a batch command line is unsafe. It waits its turn in the line like any voice, and a new prompt ends it. The Voice and Speed settings are the program's to read (`NARRATOR_VOICE`, `NARRATOR_SPEED`). If it fails, the system voice says the narration. Empty: the system's voice.

## Several windows

Every window shares one line, a folder in your temp directory: when two sessions finish together, their narrations are said one after the other, in the order they were ready. On Windows the line is Windows' own, and WSL's windows share it. One that would wait behind three others, or for two minutes, is dropped. A window that closes never holds the line. A new prompt, `/narrator stop` or switching it off cuts a narration short, also while it waits its turn; a click on `⏭︎ narrating` cuts the one being said and lets the next speak.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)): a `ui.render` hook on the footer's `SessionMode` draws the switch as a Button, as wide as the terminal's width leaves room for beside the mode label and the hint (which a hook on `PromptHint` measures), `turn.start` and `tool.call` note the request and each tool call of the main loop, and `turn.complete` (and `command.run` on `/recap`) asks the model for the narration and hands it to a speaker ([`hooks/speaker.ts`](hooks/speaker.ts)): JavaScript for Automation on macOS, PowerShell on Windows, a shell wrapper on Linux. Each writes a `.` while it speaks, so the mod can end it the moment you send a new prompt, and `waiting <n>` when the number of narrations waiting behind it changes, which the switch shows. Where none works, the engine's own `$.audio.speak`.

## Development

```bash
claude plugin validate .   # from this folder
claude plugin test .       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
