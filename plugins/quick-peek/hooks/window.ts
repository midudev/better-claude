// The program that previews a path in a window of its own, by the pointer, outside the terminal:
// macOS's, run by `osascript` with what it needs in the environment (QUICK_PEEK_FILE, the path;
// QUICK_PEEK_LIFE, how many seconds at most it stays; QUICK_PEEK_HINT, the line that says what a
// click does; QUICK_PEEK_CODE, for a file of code or text, the lines it shows as JSON, an
// `Excerpt` without its source). It writes `shown` once the window is up, or a line starting
// `error`, then a `.` every tenth of a second, so the one reading it is woken to end it, and it
// ends when nobody reads. The window never takes the focus or the pointer: the terminal keeps both.

/**
 * macOS: JavaScript for Automation drawing an AppKit panel. A file of code or text shows its
 * lines, coloured, numbered, the one the path names lit; any other file its Quick Look thumbnail
 * (a video's frame, an image, a document's first page), else its icon; a folder its icon and its
 * first entries. Under it, the name, the kind, size and age as the system words them (a language's
 * name, and its lines, for code), and where it is.
 */
export const MACOS = String.raw`
ObjC.import('Cocoa')
ObjC.import('QuickLook')

// The colours of a token's kind (code.ts's Kind), on the panel's dark backdrop.
const PALETTE = { k: '569CD6', s: 'CE9178', n: 'B5CEA8', c: '6A9955', t: '4EC9B0', a: '9CDCFE', f: 'DCDCAA', '': 'D4D4D4' }

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const path = read('QUICK_PEEK_FILE')
  const files = $.NSFileManager.defaultManager
  const isFolder = Ref()
  if (!files.fileExistsAtPathIsDirectory(path, isFolder)) { say('error: not there'); return }
  const folder = !!isFolder[0]
  // An accessory app: no Dock icon, never the active one.
  $.NSApplication.sharedApplication.setActivationPolicy(1)

  const mouse = $.NSEvent.mouseLocation
  const screens = $.NSScreen.screens
  let screen = $.NSScreen.mainScreen
  for (let i = 0; i < screens.count; i++) {
    const frame = screens.objectAtIndex(i).frame
    if (mouse.x >= frame.origin.x && mouse.x < frame.origin.x + frame.size.width && mouse.y >= frame.origin.y && mouse.y < frame.origin.y + frame.size.height) screen = screens.objectAtIndex(i)
  }
  const area = screen.visibleFrame
  const scale = screen.backingScaleFactor
  const largest = Math.min(Number(read('QUICK_PEEK_SIZE')) || 360, area.size.width * 0.5, area.size.height * 0.5)

  const url = $.NSURL.fileURLWithPath(path)
  const keys = [$.NSURLLocalizedTypeDescriptionKey, $.NSURLFileSizeKey, $.NSURLContentModificationDateKey]
  const values = url.resourceValuesForKeysError($(keys), $())
  const value = key => (values.isNil() ? $() : values.objectForKey(key))

  // The picture: a text file's lines; else Quick Look's thumbnail; else the icon Finder shows.
  const code = read('QUICK_PEEK_CODE') ? JSON.parse(read('QUICK_PEEK_CODE')) : undefined
  let image = $()
  let width = 0
  let height = 0
  let lines = []
  const inset = 8
  if (code) {
    const mono = $.NSFont.monospacedSystemFontOfSizeWeight(11, 0)
    const inks = {}
    for (const kind in PALETTE) {
      const hex = PALETTE[kind]
      inks[kind] = $.NSColor.colorWithSRGBRedGreenBlueAlpha(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1)
    }
    const gutter = String(code.first + code.lines.length - 1).length
    // A line wider than the plate ends in an ellipsis, its letters not drawn closer: the columns stay.
    const cut = $.NSMutableParagraphStyle.alloc.init
    cut.lineBreakMode = 4
    cut.allowsDefaultTighteningForTruncation = false
    lines = code.lines.map((tokens, i) => {
      // JXA bridges no initWithString: here: the text is appended, then each piece coloured.
      const text = $.NSMutableAttributedString.alloc.init
      const add = (piece, ink) => {
        const at = text.length
        text.mutableString.appendString($(piece))
        text.addAttributeValueRange($.NSForegroundColorAttributeName, ink, $.NSMakeRange(at, piece.length))
      }
      add(String(code.first + i).padStart(gutter) + '  ', $.NSColor.tertiaryLabelColor)
      for (const [kind, piece] of tokens) add(piece, inks[kind] || inks[''])
      if (tokens.length === 0) add(' ', inks[''])
      text.addAttributeValueRange($.NSFontAttributeName, mono, $.NSMakeRange(0, text.length))
      text.addAttributeValueRange($.NSParagraphStyleAttributeName, cut, $.NSMakeRange(0, text.length))
      const field = $.NSTextField.labelWithAttributedString(text)
      field.maximumNumberOfLines = 1
      if (code.first + i === code.mark) {
        field.drawsBackground = true
        field.backgroundColor = $.NSColor.colorWithWhiteAlpha(1, 0.12)
      }
      return field
    })
    const widest = lines.reduce((most, field) => Math.max(most, field.sizeThatFits($.NSMakeSize(10000, 100)).width), 0)
    width = Math.round(Math.min(Math.max(widest + inset * 2, 280), largest * 1.6))
    height = lines.reduce((sum, field) => sum + Math.ceil(field.sizeThatFits($.NSMakeSize(10000, 100)).height), 0) + inset * 2
  }
  if (!folder && !code) {
    const thumbnail = $.QLThumbnailImageCreate($.kCFAllocatorDefault, url, $.CGSizeMake(largest * scale, largest * scale), $())
    if (thumbnail && !(thumbnail.isNil && thumbnail.isNil())) {
      image = $.NSImage.alloc.initWithCGImageSize(thumbnail, $.NSZeroSize)
      width = image.size.width / scale
      height = image.size.height / scale
    }
  }
  if (!code && (image.isNil() || width === 0)) {
    image = $.NSWorkspace.sharedWorkspace.iconForFile(path)
    width = height = folder ? 64 : 128
    image.size = $.NSMakeSize(width, height)
  }

  // The lines under it.
  const name = ObjC.unwrap(files.displayNameAtPath(path))
  const details = []
  // A language's name over the system's kind, which may be another's (a .ts is a video's to it).
  const kind = value($.NSURLLocalizedTypeDescriptionKey)
  if (code) details.push(code.language)
  else if (!kind.isNil()) details.push(ObjC.unwrap(kind))
  let entries = []
  if (folder) {
    const listed = files.contentsOfDirectoryAtPathError(path, $())
    if (!listed.isNil()) {
      entries = ObjC.unwrap(listed.sortedArrayUsingSelector('localizedStandardCompare:')).map(entry => ObjC.unwrap(entry)).filter(entry => !entry.startsWith('.'))
      details.push(entries.length === 1 ? '1 item' : entries.length + ' items')
    }
  } else {
    const size = value($.NSURLFileSizeKey)
    if (!size.isNil()) details.push(ObjC.unwrap($.NSByteCountFormatter.stringFromByteCountCountStyle(size.longLongValue, 0)))
    if (code) details.push(code.count === 1 ? '1 line' : code.count + ' lines')
  }
  const modified = value($.NSURLContentModificationDateKey)
  if (!modified.isNil()) {
    const ago = $.NSRelativeDateTimeFormatter.alloc.init
    details.push(ObjC.unwrap(ago.localizedStringForDateRelativeToDate(modified, $.NSDate.date)))
  }
  const home = ObjC.unwrap($.NSHomeDirectory())
  let where = ObjC.unwrap($(path).stringByDeletingLastPathComponent)
  if (where === home || where.startsWith(home + '/')) where = '~' + where.slice(home.length)

  const pad = 12
  const gap = 18
  const inner = Math.max(width, 280)
  const label = (text, font, color, lines) => {
    const field = $.NSTextField.labelWithString($(text))
    field.font = font
    field.textColor = color
    field.lineBreakMode = lines > 1 ? 0 : 5
    if (lines > 1) field.maximumNumberOfLines = lines
    field.preferredMaxLayoutWidth = inner
    const fit = field.sizeThatFits($.NSMakeSize(inner, 1000))
    field.frame = $.NSMakeRect(0, 0, inner, Math.ceil(fit.height))
    return field
  }
  const rows = []
  rows.push(label(name, $.NSFont.boldSystemFontOfSize(13), $.NSColor.labelColor, 2))
  if (details.length > 0) rows.push(label(details.join(' · '), $.NSFont.systemFontOfSize(11), $.NSColor.secondaryLabelColor, 1))
  if (folder && entries.length > 0) {
    const shown = entries.slice(0, 10).map(entry => {
      const inside = Ref()
      files.fileExistsAtPathIsDirectory(path + '/' + entry, inside)
      return entry + (inside[0] ? '/' : '')
    })
    if (entries.length > shown.length) shown.push('…')
    rows.push(label(shown.join('\n'), $.NSFont.monospacedSystemFontOfSizeWeight(11, 0), $.NSColor.secondaryLabelColor, shown.length))
  }
  rows.push(label(where, $.NSFont.systemFontOfSize(11), $.NSColor.tertiaryLabelColor, 1))
  const hint = read('QUICK_PEEK_HINT')
  if (hint) rows.push(label(hint, $.NSFont.systemFontOfSize(10), $.NSColor.tertiaryLabelColor, 1))

  const spacing = 3
  const texts = rows.reduce((sum, row) => sum + row.frame.size.height, 0) + spacing * (rows.length - 1)
  const outer = { width: inner + pad * 2, height: pad + height + 10 + texts + pad }
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
  panel.appearance = $.NSAppearance.appearanceNamed('NSAppearanceNameVibrantDark')
  const backdrop = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, outer.width, outer.height))
  backdrop.material = 13
  backdrop.state = 1
  backdrop.wantsLayer = true
  backdrop.layer.cornerRadius = 10
  backdrop.layer.masksToBounds = true
  // AppKit counts from the bottom: the lines first, the picture over them.
  let at = pad
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    row.frame = $.NSMakeRect(pad, at, inner, row.frame.size.height)
    backdrop.addSubview(row)
    at += row.frame.size.height + spacing
  }
  at += 10 - spacing
  const frame = $.NSMakeRect(pad + Math.round((inner - width) / 2), at, width, height)
  if (code) {
    // The lines on a darker plate, top first, each cut where the plate ends. A custom box paints
    // it: a layer's colour, a CGColor, crashes JXA.
    const plate = $.NSBox.alloc.initWithFrame(frame)
    plate.boxType = 4
    plate.titlePosition = 0
    plate.borderWidth = 0
    plate.cornerRadius = 6
    plate.fillColor = $.NSColor.colorWithWhiteAlpha(0, 0.3)
    plate.contentViewMargins = $.NSMakeSize(0, 0)
    let top = height - inset
    for (const field of lines) {
      const tall = Math.ceil(field.sizeThatFits($.NSMakeSize(10000, 100)).height)
      top -= tall
      field.frame = $.NSMakeRect(inset, top, width - inset * 2, tall)
      plate.addSubview(field)
    }
    backdrop.addSubview(plate)
  } else {
    const view = $.NSImageView.alloc.initWithFrame(frame)
    view.image = image
    view.imageScaling = 3
    backdrop.addSubview(view)
  }
  panel.contentView = backdrop
  if (read('QUICK_PEEK_DRY') === '1') { say('dry ' + Math.round(outer.width) + 'x' + Math.round(outer.height) + ' ' + rows.length + ' rows'); return }
  panel.orderFrontRegardless
  say('shown')
  // A pointer that leaves the terminal says nothing to it: the window also ends when another app
  // comes to the front, or the pointer goes rows away from the path.
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier
  const end = Date.now() + (Number(read('QUICK_PEEK_LIFE')) || 60) * 1000
  while (Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    if (Math.abs($.NSEvent.mouseLocation.y - mouse.y) > 120 || $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== app) return
    say('.')
  }
}
`

/**
 * Windows: PowerShell and Windows Forms, a tool window that is never activated, drawn in the
 * panel's dark colours. A file of code or text shows its lines, coloured, numbered, the one the
 * path names lit; any other file the thumbnail Explorer shows (a video's frame, an image, a
 * document's first page), else its icon; a folder its icon and its first entries. Under it, the
 * name, the kind as the system words it (a language's name, and its lines, for code), size and
 * age, and where it is. It ends when the pointer goes rows away from the path, or another window
 * comes to the front. The script is too long for a command line: it travels in QUICK_PEEK_PS.
 */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$say = { param($text) [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
$path = ($env:QUICK_PEEK_FILE -replace '/', '\')
if (-not (Test-Path -LiteralPath $path)) { & $say 'error: not there'; exit 1 }
$item = Get-Item -LiteralPath $path -Force
$folder = $item.PSIsContainer
# The window, the shell's thumbnails and kinds, the window in front: compiled once into the temp
# folder, then loaded from there, as compiling takes a second.
$assembly = Join-Path $env:TEMP 'quick-peek-popup-3.dll'
if (-not (Test-Path $assembly)) {
  try {
  Add-Type -OutputAssembly $assembly -OutputType Library -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class QuickPeekPopup : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams p = base.CreateParams;
      p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020;
      return p;
    }
  }
}
public static class QuickPeekShell {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow ();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware ();
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute (IntPtr window, int attribute, ref int value, int size);
  [DllImport("gdi32.dll")] static extern bool DeleteObject (IntPtr handle);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SHGetFileInfo (string path, uint attributes, ref FileInfo info, uint size, uint flags);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)] static extern void SHCreateItemFromParsingName (string path, IntPtr context, [MarshalAs(UnmanagedType.LPStruct)] Guid id, [MarshalAs(UnmanagedType.Interface)] out IImageFactory factory);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FileInfo {
    public IntPtr icon; public int index; public uint attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string kind;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Size2 { public int width; public int height; }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IImageFactory { [PreserveSig] int GetImage (Size2 size, int flags, out IntPtr bitmap); }

  // Rounded corners and a dark frame, where the system draws them (Windows 11).
  public static void Style (IntPtr window) {
    try { int round = 2; DwmSetWindowAttribute(window, 33, ref round, 4); int dark = 1; DwmSetWindowAttribute(window, 20, ref dark, 4); } catch { }
  }

  // The kind of file Explorer says it is.
  public static string KindOf (string path) {
    FileInfo info = new FileInfo();
    SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(info), 0x400);
    return info.kind;
  }

  // Explorer's picture of a file, side pixels at most: its thumbnail, or its icon. Null where there is none.
  public static Bitmap PictureOf (string path, int side, bool isIcon) {
    try {
      IImageFactory factory;
      SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IImageFactory).GUID, out factory);
      Size2 size; size.width = side; size.height = side;
      IntPtr handle;
      if (factory.GetImage(size, isIcon ? 0x4 : 0x8, out handle) != 0 || handle == IntPtr.Zero) return null;
      try { return Keep(handle); } finally { DeleteObject(handle); }
    } catch { return null; }
  }

  // A bitmap from the shell, its alpha kept: Image.FromHbitmap drops it, and an icon's corners go black.
  static Bitmap Keep (IntPtr handle) {
    Bitmap plain = Image.FromHbitmap(handle);
    if (Image.GetPixelFormatSize(plain.PixelFormat) < 32) return plain;
    Rectangle all = new Rectangle(0, 0, plain.Width, plain.Height);
    BitmapData data = plain.LockBits(all, ImageLockMode.ReadOnly, plain.PixelFormat);
    try {
      bool hasAlpha = false;
      // A bottom-up bitmap counts its rows back: a negative stride.
      int length = Math.Abs(data.Stride);
      byte[] row = new byte[length];
      for (int y = 0; y < data.Height && !hasAlpha; y++) {
        Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row, 0, length);
        for (int x = 3; x < data.Width * 4; x += 4) if (row[x] != 0) { hasAlpha = true; break; }
      }
      if (!hasAlpha) return new Bitmap(plain);
      using (Bitmap view = new Bitmap(data.Width, data.Height, data.Stride, PixelFormat.Format32bppPArgb, data.Scan0)) return new Bitmap(view);
    } finally { plain.UnlockBits(data); plain.Dispose(); }
  }
}
'@
  } catch {
    # Another preview compiling it at the same time: its file is used.
  }
}
Add-Type -Path $assembly
[void][QuickPeekShell]::SetProcessDPIAware()

$cursor = [System.Windows.Forms.Cursor]::Position
$area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
$probe = New-Object System.Windows.Forms.Form
$scale = $probe.CreateGraphics().DpiX / 96
$probe.Dispose()
$px = { param($points) [int][Math]::Round($points * $scale) }
$requested = if ($env:QUICK_PEEK_SIZE) { [int]$env:QUICK_PEEK_SIZE } else { 360 }
$largest = [int][Math]::Min((& $px $requested), [Math]::Min($area.Width * 0.5, $area.Height * 0.5))
$measureBox = New-Object System.Drawing.Size(10000, 10000)

$ink = { param($hex) [System.Drawing.ColorTranslator]::FromHtml('#' + $hex) }
$palette = @{ k = '569CD6'; s = 'CE9178'; n = 'B5CEA8'; c = '6A9955'; t = '4EC9B0'; a = '9CDCFE'; f = 'DCDCAA'; '' = 'D4D4D4' }
$backdrop = & $ink '252526'
$primary = & $ink 'E6E6E6'
$secondary = & $ink 'A0A0A0'
$tertiary = & $ink '707070'
$plain = [System.Windows.Forms.TextFormatFlags]'NoPadding, NoPrefix, SingleLine'
$mono = New-Object System.Drawing.Font('Consolas', 8.5)
$bold = New-Object System.Drawing.Font('Segoe UI Semibold', 9.75)
$small = New-Object System.Drawing.Font('Segoe UI', 8.25)
$tiny = New-Object System.Drawing.Font('Segoe UI', 7.5)

# The picture: a text file's lines; else Explorer's thumbnail; else its icon.
$code = if ($env:QUICK_PEEK_CODE) { ConvertFrom-Json $env:QUICK_PEEK_CODE } else { $null }
$image = $null
$width = 0
$height = 0
$inset = & $px 8
if ($code) {
  $column = [System.Windows.Forms.TextRenderer]::MeasureText(('M' * 20), $mono, $measureBox, $plain).Width / 20
  $lineHeight = [System.Windows.Forms.TextRenderer]::MeasureText('Ag', $mono, $measureBox, $plain).Height + (& $px 1)
  $gutter = ([string]($code.first + $code.lines.Count - 1)).Length
  $widest = 0
  for ($i = 0; $i -lt $code.lines.Count; $i++) {
    $columns = $gutter + 2
    foreach ($token in @($code.lines[$i])) { if ($token) { $columns += ([string]$token[1]).Length } }
    $widest = [Math]::Max($widest, $columns)
  }
  $width = [int][Math]::Min([Math]::Max($widest * $column + $inset * 2, (& $px 280)), $largest * 1.6)
  $height = [int]($code.lines.Count * $lineHeight + $inset * 2)
} else {
  if (-not $folder) { $image = [QuickPeekShell]::PictureOf($item.FullName, $largest, $false) }
  if (-not $image) { $image = [QuickPeekShell]::PictureOf($item.FullName, (& $px $(if ($folder) { 64 } else { 128 })), $true) }
  if ($image) {
    $fit = [Math]::Min(1.0, $largest / [Math]::Max($image.Width, $image.Height))
    $width = [int]($image.Width * $fit)
    $height = [int]($image.Height * $fit)
  }
}

# The lines under it.
$details = @()
if ($code) { $details += $code.language } else { $kind = [QuickPeekShell]::KindOf($item.FullName); if ($kind) { $details += $kind } }
$entries = @()
if ($folder) {
  $entries = @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('.') -and -not ($_.Attributes -band [IO.FileAttributes]::Hidden) } | Sort-Object Name)
  $details += $(if ($entries.Count -eq 1) { '1 item' } else { '' + $entries.Count + ' items' })
} else {
  $bytes = $item.Length
  $details += $(if ($bytes -lt 1KB) { '' + $bytes + ' B' } elseif ($bytes -lt 1MB) { '' + [Math]::Round($bytes / 1KB) + ' KB' } elseif ($bytes -lt 1GB) { ($bytes / 1MB).ToString('0.0') + ' MB' } else { ($bytes / 1GB).ToString('0.0') + ' GB' })
  if ($code) { $details += $(if ($code.count -eq 1) { '1 line' } else { '' + $code.count + ' lines' }) }
}
$seconds = [Math]::Max(0, [int]((Get-Date) - $item.LastWriteTime).TotalSeconds)
$details += $(if ($seconds -lt 60) { '' + $seconds + ' s ago' } elseif ($seconds -lt 3600) { '' + [Math]::Round($seconds / 60) + ' min ago' } elseif ($seconds -lt 86400) { '' + [Math]::Round($seconds / 3600) + ' h ago' } else { '' + [Math]::Round($seconds / 86400) + ' d ago' })
$where = Split-Path -Parent $item.FullName
if (-not $where) { $where = $item.FullName }
$userHome = $env:USERPROFILE
if ($userHome -and ($where -eq $userHome -or $where.StartsWith($userHome + '\', [StringComparison]::OrdinalIgnoreCase))) { $where = '~' + $where.Substring($userHome.Length) }

$pad = & $px 12
$gap = & $px 18
$spacing = & $px 3
$inner = [Math]::Max($width, (& $px 280))
$rows = New-Object System.Collections.ArrayList
$row = {
  param($text, $font, $color, $lines)
  $flags = if ($lines -gt 1) { [System.Windows.Forms.TextFormatFlags]'NoPadding, NoPrefix, WordBreak, EndEllipsis' } else { [System.Windows.Forms.TextFormatFlags]'NoPadding, NoPrefix, SingleLine, EndEllipsis' }
  $one = [System.Windows.Forms.TextRenderer]::MeasureText('Ag', $font, $measureBox, $plain).Height
  $tall = [System.Windows.Forms.TextRenderer]::MeasureText($text, $font, (New-Object System.Drawing.Size($inner, 10000)), $flags).Height
  [void]$rows.Add(@{ text = $text; font = $font; color = $color; flags = $flags; height = [Math]::Min($tall, $one * $lines) })
}
& $row $item.Name $bold $primary 2
if ($details.Count -gt 0) { & $row ($details -join ' · ') $small $secondary 1 }
if ($folder -and $entries.Count -gt 0) {
  $shown = @($entries | Select-Object -First 10 | ForEach-Object { $_.Name + $(if ($_.PSIsContainer) { '\' } else { '' }) })
  if ($entries.Count -gt $shown.Count) { $shown += '…' }
  & $row ($shown -join [Environment]::NewLine) $mono $secondary $shown.Count
}
& $row $where $small $tertiary 1
if ($env:QUICK_PEEK_HINT) { & $row $env:QUICK_PEEK_HINT $tiny $tertiary 1 }
$texts = 0
foreach ($r in $rows) { $texts += $r.height }
$texts += $spacing * ($rows.Count - 1)
$pictureGap = if ($height -gt 0) { & $px 10 } else { 0 }
$outerWidth = $inner + $pad * 2
$outerHeight = $pad + $height + $pictureGap + $texts + $pad
if ($env:QUICK_PEEK_DRY -eq '1') { & $say ('dry ' + $outerWidth + 'x' + $outerHeight + ' ' + $rows.Count + ' rows'); exit 0 }

# Above the pointer and to its right; under it, or to its left, where there is no room: never over
# the pointer, which stays on the terminal.
$x = $cursor.X + $gap
$y = $cursor.Y - $gap - $outerHeight
if ($y -lt $area.Top) { $y = $cursor.Y + $gap }
if ($x + $outerWidth -gt $area.Right) { $x = $cursor.X - $gap - $outerWidth }
$x = [Math]::Max($area.Left, [Math]::Min($x, $area.Right - $outerWidth))
$y = [Math]::Max($area.Top, [Math]::Min($y, $area.Bottom - $outerHeight))

$form = New-Object QuickPeekPopup
$form.AutoScaleMode = 'None'
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle($x, $y, $outerWidth, $outerHeight)
$form.BackColor = $backdrop
$form.Opacity = 0.97
$form.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance, NonPublic').SetValue($form, $true, $null)
$form.add_Paint({
  param($source, $e)
  $g = $e.Graphics
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $frame = New-Object System.Drawing.Rectangle(($pad + [int](($inner - $width) / 2)), $pad, $width, $height)
  if ($code) {
    # The lines on a darker plate, top first, each cut where the plate ends.
    $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(77, 0, 0, 0))), $frame)
    $g.SetClip((New-Object System.Drawing.Rectangle(($frame.X + $inset), $frame.Y, ($frame.Width - $inset * 2), $frame.Height)))
    $top = $frame.Y + $inset
    for ($i = 0; $i -lt $code.lines.Count; $i++) {
      $number = $code.first + $i
      if ($number -eq $code.mark) { $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(31, 255, 255, 255))), $frame.X, $top, $frame.Width, $lineHeight) }
      $left = $frame.X + $inset
      $label = ([string]$number).PadLeft($gutter) + '  '
      [System.Windows.Forms.TextRenderer]::DrawText($g, $label, $mono, (New-Object System.Drawing.Point([int]$left, [int]$top)), $tertiary, $plain)
      $left += $label.Length * $column
      foreach ($token in @($code.lines[$i])) {
        if (-not $token) { continue }
        $piece = [string]$token[1]
        $hex = $palette[[string]$token[0]]
        if (-not $hex) { $hex = $palette[''] }
        [System.Windows.Forms.TextRenderer]::DrawText($g, $piece, $mono, (New-Object System.Drawing.Point([int]$left, [int]$top)), (& $ink $hex), $plain)
        $left += $piece.Length * $column
      }
      $top += $lineHeight
    }
    $g.ResetClip()
  } elseif ($image) {
    $g.DrawImage($image, $frame)
  }
  $at = $pad + $height + $pictureGap
  foreach ($r in $rows) {
    [System.Windows.Forms.TextRenderer]::DrawText($g, $r.text, $r.font, (New-Object System.Drawing.Rectangle($pad, $at, $inner, $r.height)), $r.color, $r.flags)
    $at += $r.height + $spacing
  }
})
$form.add_HandleCreated({ [QuickPeekShell]::Style($form.Handle) })
$form.add_Shown({ & $say 'shown' })
$front = [QuickPeekShell]::GetForegroundWindow()
$reach = & $px 120
$end = (Get-Date).AddSeconds($(if ($env:QUICK_PEEK_LIFE) { [int]$env:QUICK_PEEK_LIFE } else { 60 }))
# A pointer that leaves the terminal says nothing to it: the window also ends when another window
# comes to the front, or the pointer goes rows away from the path.
$beat = New-Object System.Windows.Forms.Timer
$beat.Interval = 100
$beat.add_Tick({
  try { & $say '.' } catch { $form.Close(); return }
  if ((Get-Date) -gt $end -or [Math]::Abs([System.Windows.Forms.Cursor]::Position.Y - $cursor.Y) -gt $reach -or [QuickPeekShell]::GetForegroundWindow() -ne $front) { $form.Close() }
})
$beat.Start()
[System.Windows.Forms.Application]::Run($form)
`

/**
 * How PowerShell runs the Windows script: no profile, no prompts, no script policy in the way; the
 * script read from QUICK_PEEK_PS, as a command line holds 32 767 characters at most.
 */
export const WINDOWS_ARGV = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Invoke-Expression $env:QUICK_PEEK_PS']
