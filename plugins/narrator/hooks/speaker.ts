// The programs that speak a narration: one a system, each the best free voice that system has. Each
// reads NARRATOR_TEXT, what to say; NARRATOR_LANG, its language as an ISO 639-1 code (empty: the
// program tells, or uses its default); and NARRATOR_VOICE, a voice's name (empty: the best one for
// the language, English's when the language has none; `Name (es-ES)` picks a name's voice in one
// language); NARRATOR_SPEED, how fast (1: the voice's normal pace); and NARRATOR_TICKET, when it was
// ready, its place in the line every window's narrations wait in (see QUEUE). Each writes
// `no voice <name>` when it has no voice by that name, `voice <name>` once it speaks, or a line
// starting `error`, then a `.` every tenth of a second while it speaks, so the one reading it is
// woken to end it, and `waiting <n>` each time the number of narrations waiting behind it in the
// line changes; while it waits in the line, a `.` every 0.3 s, and `skipped` if the line drops it.

/**
 * macOS: JavaScript for Automation, run by `osascript`, with AVSpeechSynthesizer, which reaches the
 * Siri voices (`say` does not). An empty NARRATOR_LANG is told from the text.
 */
export const MACOS = String.raw`
ObjC.import('AVFoundation')
ObjC.import('NaturalLanguage')

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const text = read('NARRATOR_TEXT')
  const wanted = read('NARRATOR_VOICE').toLowerCase()
  const speed = Number(read('NARRATOR_SPEED')) || 1
  if (!text) return

  const found = $.NLLanguageRecognizer.dominantLanguageForString(text)
  const language = read('NARRATOR_LANG').toLowerCase().split('-')[0] || (found.isNil() ? 'en' : ObjC.unwrap(found))

  const all = $.AVSpeechSynthesisVoice.speechVoices
  const voices = []
  for (let i = 0; i < all.count; i++) {
    const voice = all.objectAtIndex(i)
    voices.push({ voice, id: ObjC.unwrap(voice.identifier), name: ObjC.unwrap(voice.name), lang: ObjC.unwrap(voice.language), quality: Number(voice.quality) })
  }

  // The regions to prefer for a language: the person's own (es-MX before es-ES), then the usual one.
  const regionsFor = language => {
    const regions = []
    const preferred = $.NSLocale.preferredLanguages
    for (let i = 0; i < preferred.count; i++) {
      const [lang, region] = ObjC.unwrap(preferred.objectAtIndex(i)).split('-')
      if (lang === language && region) regions.push(region)
    }
    const country = $.NSLocale.currentLocale.countryCode
    if (!country.isNil()) regions.push(ObjC.unwrap(country))
    regions.push({ de: 'DE', en: 'US', es: 'ES', fr: 'FR', it: 'IT', ja: 'JP', pt: 'BR', zh: 'CN' }[language] || '')
    return regions
  }
  // Siri's natural voices first, then premium over enhanced over compact, then the preferred region.
  // The novelty voices (Bahh, Grandpa...) come last.
  const best = language => {
    const regions = regionsFor(language)
    const near = v => { const at = regions.indexOf(v.lang.split('-')[1]); return at < 0 ? 0 : 50 - at * 10 }
    const score = v =>
      (v.id.includes('.siri.') ? 1000 : 0) + v.quality * 100 + near(v) - (v.id.includes('.super-compact.') ? 1 : 0) -
      (/\.(speech\.synthesis|eloquence)\./.test(v.id) ? 10000 : 0)
    return voices.filter(v => v.lang.split('-')[0] === language).sort((a, b) => score(b) - score(a))[0]
  }
  // A name several languages share (Eddy) reads in the narration's language, else its best voice.
  const isNamed = v => [v.id, v.name, v.name + ' (' + v.lang + ')'].some(name => name.toLowerCase() === wanted)
  const inLanguage = v => (v.lang.split('-')[0] === language ? 1 : 0)
  const named = wanted && voices.filter(isNamed).sort((a, b) => inLanguage(b) - inLanguage(a) || b.quality - a.quality)[0]
  if (wanted && !named) say('no voice ' + read('NARRATOR_VOICE'))
  const picked = named || best(language) || best('en')

  const synth = $.AVSpeechSynthesizer.alloc.init
  const utterance = $.AVSpeechUtterance.speechUtteranceWithString(text)
  if (picked) utterance.voice = picked.voice
  // The voice's normal pace is a rate of 0.5; measured, each 0.1 above it speaks 0.6 times faster and
  // each 0.1 below 0.088 slower, the same for Siri's voices and the compact ones.
  utterance.rate = Math.min(Math.max(speed >= 1 ? 0.5 + (speed - 1) / 6 : 0.5 - (1 - speed) / 0.88, 0), 1)
  say('voice ' + (picked ? picked.id : 'default'))
  synth.speakUtterance(utterance)

  const loop = $.NSRunLoop.currentRunLoop
  let started = false
  for (let i = 0; i < 6000; i++) {
    loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    say('.')
    if (synth.speaking) started = true
    else if (started || i > 30) break
  }
  if (!started) say('error: the synthesizer did not speak')
}
`

/** The voices AVSpeechSynthesizer can use, with their language codes, but the novelty ones (Bahh, Bells...). */
export const MACOS_VOICES = String.raw`
ObjC.import('AVFoundation')
const all = $.AVSpeechSynthesisVoice.speechVoices
const rows = []
for (let i = 0; i < all.count; i++) {
  const voice = all.objectAtIndex(i)
  if (ObjC.unwrap(voice.identifier).includes('.speech.synthesis.')) continue
  rows.push(ObjC.unwrap(voice.name) + '\t' + ObjC.unwrap(voice.language))
}
rows.sort()
$.NSFileHandle.fileHandleWithStandardOutput.writeData($(rows.join('\n')).dataUsingEncoding($.NSUTF8StringEncoding))
`

/**
 * Windows (and WSL, through `powershell.exe`): the OneCore voices of Windows.Media.SpeechSynthesis,
 * the ones Narrator uses, played from memory; where WinRT cannot load, the desktop SAPI voices of
 * System.Speech. It also writes `pid <n>`, so WSL, whose end of the pipe cannot end it, can. It
 * waits in a line of its own, Windows', which the windows of WSL share.
 */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
$text = $env:NARRATOR_TEXT
$language = "$env:NARRATOR_LANG".ToLower().Split('-')[0]
$wanted = "$env:NARRATOR_VOICE"
# Read with a dot whatever the region's decimal mark.
$speed = 0.0
$null = [double]::TryParse("$env:NARRATOR_SPEED", [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$speed)
if ($speed -le 0) { $speed = 1.0 }
if (-not $text) { exit 0 }
$region = (Get-Culture).Name
function Say($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
Say "pid $PID"

# Among voices given as Name, Language and Item: the one named (or listed as "Name (es-ES)"); else
# the language's, the person's region first; else English's, en-US first.
function Pick($voices) {
  if ($wanted) {
    $named = @($voices | Where-Object { "$($_.Name) ($($_.Language))" -eq $wanted -or $_.Name -eq $wanted -or $_.Name -like "*$wanted*" })
    if ($named.Count -gt 0) { return $named[0] }
    Say "no voice $wanted"
  }
  foreach ($lang in @($language, 'en')) {
    if (-not $lang) { continue }
    $matching = @($voices | Where-Object { $_.Language.ToLower().Split('-')[0] -eq $lang })
    if ($matching.Count -eq 0) { continue }
    $preferred = if ($lang -eq $language) { $region } else { 'en-US' }
    $near = @($matching | Where-Object { $_.Language -eq $preferred })
    if ($near.Count -gt 0) { return $near[0] }
    return $matching[0]
  }
  return $null
}

$script:isSpeaking = $false

function Speak-OneCore {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { [pscustomobject]@{ Name = $_.DisplayName; Language = $_.Language; Item = $_ } })
  $picked = Pick $voices
  if ($picked) { $synth.Voice = $picked.Item }
  # A multiple of the voice's pace, from 0.5 to 6 (Windows 10 1803 on).
  if ($synth.Options) { $synth.Options.SpeakingRate = [Math]::Min([Math]::Max($speed, 0.5), 6) }
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
  $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync($text)))
  $null = $task.Wait(-1)
  $wav = New-Object System.IO.MemoryStream
  [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result.GetInputStreamAt(0)).CopyTo($wav)
  $bytes = $wav.ToArray()
  # How long it plays: the data after the 44-byte header, at the header's bytes per second.
  $seconds = ($bytes.Length - 44) / [Math]::Max([BitConverter]::ToInt32($bytes, 28), 1)
  $wav.Position = 0
  $player = New-Object System.Media.SoundPlayer($wav)
  $player.Load()
  $name = if ($picked) { $picked.Name } else { $synth.Voice.DisplayName }
  $script:isSpeaking = $true
  Say "voice $name"
  $player.Play()
  $end = (Get-Date).AddSeconds($seconds + 0.3)
  while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 100; Tick }
}

function Speak-Sapi {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ Name = $_.VoiceInfo.Name; Language = $_.VoiceInfo.Culture.Name; Item = $_ } })
  $picked = Pick $voices
  if ($picked) { $synth.SelectVoice($picked.Name) }
  # From -10 to 10, each end about three times slower or faster than the voice's pace.
  $synth.Rate = [int][Math]::Max(-10, [Math]::Min(10, [Math]::Round(10 * [Math]::Log($speed) / [Math]::Log(3))))
  $script:isSpeaking = $true
  Say "voice $($synth.Voice.Name)"
  $spoken = $synth.SpeakAsync($text)
  while (-not $spoken.IsCompleted) { Start-Sleep -Milliseconds 100; Tick }
}

# The line every window waits in, as QUEUE's on macOS and Linux: a ticket (NARRATOR_TICKET, then
# this process's id) in a folder of the user's own, the oldest live one first, and a mutex for the
# one that speaks, which Windows lets go of when its process ends. False: dropped, not to be said.
$script:ticket = $null
$script:seat = $null
$script:line = $null
function Enter-Line {
  if ("$env:NARRATOR_TICKET" -notmatch '^\d+$') { return $true }
  $dir = Join-Path ([IO.Path]::GetTempPath()) 'claude-narrator-queue'
  $mine = "$($env:NARRATOR_TICKET)-$PID"
  $script:line = $dir
  try {
    $null = New-Item -ItemType Directory -Force -Path $dir
    $script:ticket = Join-Path $dir $mine
    $null = New-Item -ItemType File -Force -Path $script:ticket
    $script:seat = New-Object System.Threading.Mutex($false, 'Local\claude-narrator-line')
  } catch { return $true }
  $start = Get-Date
  while ($true) {
    $ahead = 0
    try {
      foreach ($file in @(Get-ChildItem -LiteralPath $dir -File | Sort-Object Name)) {
        if ($file.Name -eq $mine) { break }
        $owner = $null
        if ($file.Name -match '^\d+-(\d+)$') { $owner = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue }
        # Gone: not a ticket, its process has ended, or one that started after it was written took its id.
        $isGone = -not $owner
        if (-not $isGone) { try { $isGone = $owner.StartTime -gt $file.CreationTime } catch { $isGone = $true } }
        if ($isGone) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue; continue }
        $ahead++
      }
    } catch { return $true }
    if ($ahead -eq 0) {
      try { if ($script:seat.WaitOne(0)) { return $true } } catch [System.Threading.AbandonedMutexException] { return $true }
    }
    if ($ahead -ge 3 -or ((Get-Date) - $start).TotalSeconds -ge 120) { Exit-Line; return $false }
    Say '.'
    Start-Sleep -Milliseconds 300
  }
}
function Exit-Line {
  if ($script:seat) { try { $script:seat.ReleaseMutex() } catch {} }
  if ($script:ticket) { Remove-Item -LiteralPath $script:ticket -Force -ErrorAction SilentlyContinue }
}

# A dot while it speaks, every tenth of a second; every third, how many narrations wait their turn,
# each time that changes.
$script:ticks = 0
$script:told = 0
function Tick {
  Say '.'
  $script:ticks++
  if (-not $script:ticket -or $script:ticks % 3) { return }
  $mine = Split-Path -Leaf $script:ticket
  $waiting = 0
  try {
    foreach ($file in @(Get-ChildItem -LiteralPath $script:line -File)) {
      if ($file.Name -eq $mine -or $file.Name -notmatch '^\d+-(\d+)$') { continue }
      $owner = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
      try { if ($owner -and $owner.StartTime -le $file.CreationTime) { $waiting++ } } catch {}
    }
  } catch { return }
  if ($waiting -ne $script:told) { Say "waiting $waiting"; $script:told = $waiting }
}

if (-not (Enter-Line)) { Say 'skipped'; exit 0 }
try {
  try {
    Speak-OneCore
  } catch {
    if ($script:isSpeaking) { exit 0 }
    try { Speak-Sapi } catch { if (-not $script:isSpeaking) { Say "error: $($_.Exception.Message)" } }
  }
} finally {
  Exit-Line
}
`

/** Lists the Windows voices Narrator can select, including desktop SAPI voices where available. */
export const WINDOWS_VOICES = String.raw`
$ErrorActionPreference = 'Stop'
$voices = @()
# WinRT and SAPI are independent catalogs; list whichever APIs are available.
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $voices += [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { [pscustomobject]@{ Name = $_.DisplayName; Language = $_.Language } }
} catch {}
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices += $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ Name = $_.VoiceInfo.Name; Language = $_.VoiceInfo.Culture.Name } }
} catch {}
$voices | Sort-Object Language, Name -Unique | ForEach-Object { $_.Name + [char]9 + $_.Language }
`

/**
 * Linux: runs the synthesizer given as its arguments (spd-say, which speaks with whatever voice
 * speech-dispatcher is set up with, or espeak-ng), writing a `.` while it runs. Ended, or once
 * nobody reads, it ends the synthesizer and runs NARRATOR_STOP, which silences speech-dispatcher.
 * It also runs a speak command of the person's own, on macOS too: NARRATOR_SPEAKER then names it.
 */
export const LINUX = String.raw`
"$@" &
pid=$!
stop () {
  pkill -TERM -P "$pid" 2>/dev/null
  kill "$pid" 2>/dev/null
  if [ -n "$NARRATOR_STOP" ]; then $NARRATOR_STOP >/dev/null 2>&1; fi
  exit 0
}
trap stop TERM INT HUP PIPE
speaker=$NARRATOR_SPEAKER
[ -n "$speaker" ] || speaker=$1
echo "voice $speaker"
while kill -0 "$pid" 2>/dev/null; do
  echo . 2>/dev/null || stop
  sleep 0.1
done
wait "$pid" || echo "error: $speaker failed"
`

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * speech-dispatcher's rate for a speed, from -100 to 100, as its espeak-ng module reads it: 0 is 170
 * words a minute, -100 is 80 and 100 is 449.
 */
export const dispatcherRate = (speed: number) => Math.round(clamp(((speed - 1) * 170 * 100) / (speed >= 1 ? 279 : 90), -100, 100))

/** espeak's words a minute for a speed: 175 at its normal pace, within the 80 to 450 it takes. */
export const espeakWords = (speed: number) => Math.round(clamp(175 * speed, 80, 450))

const encodedCache = new Map<string, string>()

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
export function encodedCommand (script: string) {
  const cached = encodedCache.get(script)
  if (cached !== undefined) return cached
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  const encoded = bytes.toBase64()
  encodedCache.set(script, encoded)
  return encoded
}

/** How PowerShell runs one of these scripts: no profile, no prompts, no script policy in the way. */
export const powershell = (script: string, program = 'powershell') => [program, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)]

/**
 * The line every speaker waits in on macOS and Linux, shared by every window: it runs the speaker
 * given as its arguments once its turn comes. Each narration takes a ticket (NARRATOR_TICKET, then
 * this shell's id) in a folder of the user's own, and speaks once its ticket is the oldest of the
 * live ones and it holds the seat, a link no two can make at once, so one speaks at a time even when
 * a ticket came in late. A ticket whose process is gone, or older than a quarter of an hour (its id
 * may have been reused), is thrown away, so a window that was closed never holds the line; the shell
 * takes its ticket and the seat away as the speech ends, or as it is ended. A narration that would
 * wait behind three others, or for two minutes, is not said: it prints `skipped`. While its speaker
 * speaks it prints `waiting <n>` each time the number of narrations waiting their turn changes.
 */
export const QUEUE = String.raw`
case $NARRATOR_TICKET in '' | *[!0-9]*) exec "$@" ;; esac
dir=$TMPDIR
[ -n "$dir" ] || dir=/tmp
dir="$dir/claude-narrator-queue-$(id -u)"
here=$PWD
mkdir -p "$dir" 2>/dev/null && cd "$dir" 2>/dev/null || exec "$@"
mine=$NARRATOR_TICKET-$$
: > "$mine" 2>/dev/null || { cd "$here"; exec "$@"; }
pid=
leave () {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi
  rm -f "$dir/$mine"
  if [ "$(readlink "$dir/seat" 2>/dev/null)" = "$$" ]; then rm -f "$dir/seat"; fi
  exit 0
}
trap leave TERM INT HUP PIPE
# A ticket's two parts: the time it was ready, and its process.
parts () { IFS=-; set -- $1; IFS=' '; born=$1; owner=$2; }
start=$(date +%s)
while :; do
  now=$(date +%s)
  ahead=0
  for f in *-*; do
    [ -e "$f" ] || continue
    [ "$f" = "$mine" ] && break
    # Gone: not a ticket, its process has ended, or older than any speech lasts (a reused process id).
    case $f in *[!0-9-]* | -* | *- | *-*-*) rm -f "$f"; continue ;; esac
    parts "$f"
    if ! kill -0 "$owner" 2>/dev/null || [ $((now - born / 1000)) -gt 900 ]; then rm -f "$f"; continue; fi
    ahead=$((ahead + 1))
  done
  # First in line, it takes the seat: one speaks at a time, even when a ticket came in late.
  if [ "$ahead" -eq 0 ]; then
    holder=$(readlink seat 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -f seat; fi
    ln -s "$$" seat 2>/dev/null && break
  fi
  if [ "$ahead" -ge 3 ] || [ $((now - start)) -ge 120 ]; then
    rm -f "$mine"
    echo skipped
    exit 0
  fi
  echo . 2>/dev/null || leave
  sleep 0.3
done
cd "$here" 2>/dev/null
"$@" &
pid=$!
# While it speaks, how many narrations wait their turn, each time that changes.
cd "$dir" 2>/dev/null || { wait "$pid"; pid=; leave; }
told=0
while kill -0 "$pid" 2>/dev/null; do
  now=$(date +%s)
  waiting=0
  for f in *-*; do
    case $f in "$mine" | *[!0-9-]* | -* | *- | *-*-*) continue ;; esac
    parts "$f"
    if kill -0 "$owner" 2>/dev/null && [ $((now - born / 1000)) -le 900 ]; then waiting=$((waiting + 1)); fi
  done
  if [ "$waiting" -ne "$told" ]; then
    echo "waiting $waiting" 2>/dev/null || leave
    told=$waiting
  fi
  sleep 0.3
done
wait "$pid"
pid=
leave
`

/**
 * A speech server's speaker, run by LINUX on macOS and Linux: it posts NARRATOR_BODY, an OpenAI
 * speech request, to NARRATOR_SERVER's `/audio/speech` (OpenAI's, or any server that speaks that
 * API, as Kokoro-FastAPI), then plays the WAV that comes back with the system's player. NARRATOR_SERVER_KEY,
 * when set, goes to curl as its Authorization header on its standard input, never on a command line
 * others can read. Ended, it ends curl or the player, and leaves no file behind; a server that does
 * not answer with audio, or no player to play it, is an `error` line and an exit code other than 0,
 * so the next speaker says the narration.
 */
export const SERVER = String.raw`
tmp=$TMPDIR
[ -n "$tmp" ] || tmp=/tmp
dir=$(mktemp -d "$tmp/claude-narrator-XXXXXX") || { echo 'error: no folder for the speech'; exit 1; }
child=
end () {
  if [ -n "$child" ]; then kill "$child" 2>/dev/null; fi
  rm -rf "$dir"
  exit 1
}
trap 'rm -rf "$dir"' EXIT
trap end TERM INT HUP PIPE
# The narration goes in a file, by a builtin: on no command line others can read.
printf '%s' "$NARRATOR_BODY" > "$dir/body.json"
{ if [ -n "$NARRATOR_SERVER_KEY" ]; then printf 'Authorization: Bearer %s\n' "$NARRATOR_SERVER_KEY"; fi; } |
  curl -sS -H @- -H 'Content-Type: application/json' --connect-timeout 5 --max-time 60 --data-binary @"$dir/body.json" \
    -o "$dir/speech.wav" -w '%{http_code}' "$NARRATOR_SERVER/audio/speech" > "$dir/status" 2> "$dir/error" &
child=$!
wait "$child"
fetched=$?
child=
status=$(cat "$dir/status" 2>/dev/null)
case $status in
  2??) if [ "$fetched" -ne 0 ]; then echo "error: the speech did not arrive whole: $(head -c 200 "$dir/error" | tr '\n' ' ')"; exit 1; fi ;;
  000 | '') echo "error: the speech server did not answer: $(head -c 200 "$dir/error" | tr '\n' ' ')"; exit 1 ;;
  *) echo "error: the speech server answered $status: $(head -c 200 "$dir/speech.wav" | tr '\n' ' ')"; exit 1 ;;
esac
if command -v afplay >/dev/null 2>&1; then set -- afplay
elif command -v pw-play >/dev/null 2>&1; then set -- pw-play
elif command -v paplay >/dev/null 2>&1; then set -- paplay
elif command -v aplay >/dev/null 2>&1; then set -- aplay -q
elif command -v ffplay >/dev/null 2>&1; then set -- ffplay -nodisp -autoexit -loglevel quiet
else echo 'error: no audio player to play the speech (afplay, pw-play, paplay, aplay or ffplay)'; exit 1
fi
"$@" "$dir/speech.wav" &
child=$!
wait "$child" || { echo "error: $1 could not play the speech"; exit 1; }
`

/**
 * The voices a speech server lists at NARRATOR_SERVER's `/audio/voices`, as JSON, where it has that
 * route (Kokoro-FastAPI does; OpenAI's API does not). The key goes as SERVER's does.
 */
export const SERVER_VOICES = String.raw`
{ if [ -n "$NARRATOR_SERVER_KEY" ]; then printf 'Authorization: Bearer %s\n' "$NARRATOR_SERVER_KEY"; fi; } |
  curl -sSf -H @- --connect-timeout 3 --max-time 10 "$NARRATOR_SERVER/audio/voices"
`

/** The voice names in a server's `/audio/voices` answer: `{ voices: [...] }`, each a name or `{ id, name }`. */
export function serverVoicesIn (answer: string) {
  try {
    const { voices } = JSON.parse(answer) as { voices?: unknown }
    if (!Array.isArray(voices)) return []
    return voices.map(voice => (typeof voice === 'string' ? voice : String((voice as { id?: unknown; name?: unknown })?.id ?? (voice as { name?: unknown })?.name ?? ''))).filter(Boolean)
  } catch {
    return []
  }
}

/** What a speech server is asked for when its voice setting names none. */
export const SERVER_VOICE = 'alloy'

/**
 * The speech server's voice for a language, from its setting: one voice (`nova`), or one per
 * language, as `es:ef_dora`, beside one without a language for the others (`nova, es:ef_dora`).
 * The language's own, else the one without a language, else English's, else the first.
 */
export function serverVoiceFor (setting: string, language: string) {
  const entries = setting.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const at = entry.indexOf(':')
    return at < 0 ? { language: '', voice: entry } : { language: entry.slice(0, at).trim().toLowerCase(), voice: entry.slice(at + 1).trim() }
  }).filter(entry => entry.voice)
  const of = (code: string) => entries.find(entry => entry.language === code)?.voice
  return of(language) ?? of('') ?? of('en') ?? entries[0]?.voice ?? SERVER_VOICE
}
