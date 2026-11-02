// The programs that show a picture in a window of its own, by the pointer, outside the terminal:
// one a system, each run with what it needs in the environment (IMAGE_PREVIEW_FILE, the picture;
// IMAGE_PREVIEW_SIZE, its longest side at most; IMAGE_PREVIEW_LIFE, how many seconds at most it
// stays). Each writes `shown` once the window is up, or a line starting `error`, then a `.` every
// tenth of a second, so the one reading it is woken to end it, and it ends when nobody reads. The
// window never takes the focus or the pointer: the terminal keeps both.

/** macOS: JavaScript for Automation, run by `osascript`, drawing an AppKit panel. */
export const MACOS = String.raw`
ObjC.import('Cocoa')

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const largest = Number(read('IMAGE_PREVIEW_SIZE')) || 800
  // An accessory app: no Dock icon, never the active one.
  $.NSApplication.sharedApplication.setActivationPolicy(1)
  const image = $.NSImage.alloc.initWithContentsOfFile(read('IMAGE_PREVIEW_FILE'))
  if (image.isNil() || image.representations.count === 0) { say('error: cannot read the image'); return }
  const pixels = image.representations.firstObject
  const mouse = $.NSEvent.mouseLocation
  const screens = $.NSScreen.screens
  let screen = $.NSScreen.mainScreen
  for (let i = 0; i < screens.count; i++) {
    const frame = screens.objectAtIndex(i).frame
    if (mouse.x >= frame.origin.x && mouse.x < frame.origin.x + frame.size.width && mouse.y >= frame.origin.y && mouse.y < frame.origin.y + frame.size.height) screen = screens.objectAtIndex(i)
  }
  const area = screen.visibleFrame
  let width = pixels.pixelsWide / screen.backingScaleFactor
  let height = pixels.pixelsHigh / screen.backingScaleFactor
  const fit = Math.min(1, largest / Math.max(width, height), (area.size.width * 0.7) / width, (area.size.height * 0.7) / height)
  width = Math.round(width * fit)
  height = Math.round(height * fit)
  const pad = 6
  const gap = 18
  const outer = { width: width + pad * 2, height: height + pad * 2 }
  const top = area.origin.y + area.size.height
  const right = area.origin.x + area.size.width
  // Above the pointer and to its right; under it, or to its left, where there is no room: never
  // over the pointer, which stays on the terminal.
  let x = mouse.x + gap
  let y = mouse.y + gap
  if (y + outer.height > top) y = mouse.y - gap - outer.height
  if (x + outer.width > right) x = mouse.x - gap - outer.width
  x = Math.max(area.origin.x, Math.min(x, right - outer.width))
  y = Math.max(area.origin.y, Math.min(y, top - outer.height))
  // Borderless and non-activating; over every app window, on every space, full-screen ones too.
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x, y, outer.width, outer.height), 128, 2, false)
  panel.level = 25
  panel.ignoresMouseEvents = true
  panel.hasShadow = true
  panel.opaque = false
  panel.backgroundColor = $.NSColor.clearColor
  panel.collectionBehavior = 1 | 16 | 256
  const backdrop = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, outer.width, outer.height))
  backdrop.material = 13
  backdrop.state = 1
  backdrop.wantsLayer = true
  backdrop.layer.cornerRadius = 10
  backdrop.layer.masksToBounds = true
  const view = $.NSImageView.alloc.initWithFrame($.NSMakeRect(pad, pad, width, height))
  view.image = image
  view.imageScaling = 3
  backdrop.addSubview(view)
  panel.contentView = backdrop
  panel.orderFrontRegardless
  say('shown')
  const end = Date.now() + (Number(read('IMAGE_PREVIEW_LIFE')) || 120) * 1000
  while (Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    say('.')
  }
}
`

/** Linux and other X11 desktops: Python's Tk, an undecorated tooltip window. The picture is a PNG. */
export const LINUX = String.raw`
import math, os, sys
try:
    import tkinter as tk
except ImportError:
    print('error: no tkinter', flush=True)
    sys.exit(1)

largest = int(os.environ.get('IMAGE_PREVIEW_SIZE') or 800)
life = float(os.environ.get('IMAGE_PREVIEW_LIFE') or 120)
try:
    root = tk.Tk()
except tk.TclError as error:
    print('error: no display: %s' % error, flush=True)
    sys.exit(1)
root.withdraw()
root.overrideredirect(True)
for name, value in (('-topmost', True), ('-type', 'tooltip')):
    try:
        root.attributes(name, value)
    except tk.TclError:
        pass
try:
    image = tk.PhotoImage(file=os.environ.get('IMAGE_PREVIEW_FILE', ''))
except tk.TclError:
    print('error: cannot read the image', flush=True)
    sys.exit(1)
screen_width, screen_height = root.winfo_screenwidth(), root.winfo_screenheight()
step = max(1, math.ceil(max(image.width() / min(largest, screen_width * 0.7), image.height() / min(largest, screen_height * 0.7))))
if step > 1:
    image = image.subsample(step)
pad, gap = 6, 18
width, height = image.width() + pad * 2, image.height() + pad * 2
root.configure(background='#202020')
tk.Label(root, image=image, borderwidth=0, highlightthickness=0, background='#202020').pack(padx=pad, pady=pad)
mouse_x, mouse_y = root.winfo_pointerxy()
# Above the pointer and to its right; under it, or to its left, where there is no room: never over
# the pointer, which stays on the terminal.
x, y = mouse_x + gap, mouse_y - gap - height
if y < 0:
    y = mouse_y + gap
if x + width > screen_width:
    x = mouse_x - gap - width
x = max(0, min(x, screen_width - width))
y = max(0, min(y, screen_height - height))
root.geometry('%dx%d+%d+%d' % (width, height, x, y))
root.deiconify()
root.update_idletasks()
print('shown', flush=True)


def beat():
    try:
        print('.', flush=True)
    except (BrokenPipeError, OSError):
        # Nobody reads: end, the pipe's last flush going nowhere.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        root.destroy()
        return
    root.after(100, beat)


beat()
root.after(int(life * 1000), root.destroy)
root.mainloop()
`

/** Windows: PowerShell and Windows Forms, a tool window that is never activated. */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$largest = if ($env:IMAGE_PREVIEW_SIZE) { [int]$env:IMAGE_PREVIEW_SIZE } else { 800 }
$life = if ($env:IMAGE_PREVIEW_LIFE) { [int]$env:IMAGE_PREVIEW_LIFE } else { 120 }
# A form that shows without taking the focus, as a tool window, topmost, the pointer passing through.
# Compiled once into the temp folder, then loaded from there: compiling takes a second.
$assembly = Join-Path $env:TEMP 'image-preview-popup-2.dll'
if (-not (Test-Path $assembly)) {
  try {
  Add-Type -OutputAssembly $assembly -OutputType Library -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
public class ImagePreviewPopup : System.Windows.Forms.Form {
  public ImagePreviewPopup() { this.DoubleBuffered = true; }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams p = base.CreateParams;
      p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020;
      return p;
    }
  }
}
'@
  } catch {
    # Another preview compiling it at the same time: its file is used.
  }
}
Add-Type -Path $assembly
try { $image = [System.Drawing.Image]::FromFile($env:IMAGE_PREVIEW_FILE) } catch { [Console]::Out.WriteLine('error: cannot read the image'); exit 1 }
$cursor = [System.Windows.Forms.Cursor]::Position
$area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
$fit = [Math]::Min(1.0, [Math]::Min($largest / [Math]::Max($image.Width, $image.Height), [Math]::Min($area.Width * 0.7 / $image.Width, $area.Height * 0.7 / $image.Height)))
$pad = 6
$gap = 18
$width = [int]($image.Width * $fit) + $pad * 2
$height = [int]($image.Height * $fit) + $pad * 2
# Above the pointer and to its right; under it, or to its left, where there is no room: never over
# the pointer, which stays on the terminal.
$x = $cursor.X + $gap
$y = $cursor.Y - $gap - $height
if ($y -lt $area.Top) { $y = $cursor.Y + $gap }
if ($x + $width -gt $area.Right) { $x = $cursor.X - $gap - $width }
$x = [Math]::Max($area.Left, [Math]::Min($x, $area.Right - $width))
$y = [Math]::Max($area.Top, [Math]::Min($y, $area.Bottom - $height))
$form = New-Object ImagePreviewPopup
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle($x, $y, $width, $height)
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$form.Padding = New-Object System.Windows.Forms.Padding($pad)
# Starts invisible and is revealed once painted, so no unpainted (white) frame is ever shown.
$form.Opacity = 0
$box = New-Object System.Windows.Forms.PictureBox
$box.Dock = 'Fill'
$box.SizeMode = 'Zoom'
$box.Image = $image
$form.Controls.Add($box)
$form.add_Shown({ $form.Refresh(); $form.Opacity = 0.99; [Console]::Out.WriteLine('shown'); [Console]::Out.Flush() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $life * 1000
$timer.add_Tick({ $form.Close() })
$timer.Start()
$beat = New-Object System.Windows.Forms.Timer
$beat.Interval = 100
$beat.add_Tick({ try { [Console]::Out.WriteLine('.'); [Console]::Out.Flush() } catch { $form.Close() } })
$beat.Start()
[System.Windows.Forms.Application]::Run($form)
`

/**
 * Windows: PowerShell and System.Drawing, the converter where ImageMagick is not installed. Writes
 * IMAGE_PREVIEW_FILE shrunk to IMAGE_PREVIEW_SIZE at most, as IMAGE_PREVIEW_FORMAT (`bmp` or `png`),
 * to IMAGE_PREVIEW_OUT.
 */
export const WINDOWS_CONVERT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($env:IMAGE_PREVIEW_FILE)
$largest = if ($env:IMAGE_PREVIEW_SIZE) { [int]$env:IMAGE_PREVIEW_SIZE } else { [Math]::Max($source.Width, $source.Height) }
$fit = [Math]::Min(1.0, $largest / [Math]::Max($source.Width, $source.Height))
$width = [Math]::Max(1, [int]($source.Width * $fit))
$height = [Math]::Max(1, [int]($source.Height * $fit))
$picture = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$canvas = [System.Drawing.Graphics]::FromImage($picture)
$canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$canvas.DrawImage($source, 0, 0, $width, $height)
$canvas.Dispose()
$format = if ($env:IMAGE_PREVIEW_FORMAT -eq 'png') { [System.Drawing.Imaging.ImageFormat]::Png } else { [System.Drawing.Imaging.ImageFormat]::Bmp }
$picture.Save($env:IMAGE_PREVIEW_OUT, $format)
`

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
export const powershell = (script: string) => ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)]
