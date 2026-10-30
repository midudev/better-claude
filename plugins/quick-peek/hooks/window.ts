// The program that previews a path in a window of its own, by the pointer, outside the terminal:
// macOS's, run by `osascript`, and Windows', run by PowerShell, with what it needs in the
// environment (QUICK_PEEK_FILE, the path; QUICK_PEEK_LIFE, how many seconds at most it stays;
// QUICK_PEEK_HINT, the line that says what a click does; QUICK_PEEK_CODE, for a file of code or
// text, the lines it shows as JSON, an `Excerpt` without its source). It writes `shown` once the
// window is up, or a line starting `error`, then a `.` every tenth of a second, so the one reading
// it is woken to end it, and it ends when nobody reads. The window never takes the focus or the
// pointer: the terminal keeps both.

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
 * Windows: the window, in C#, which `WINDOWS` compiles once and runs. A Windows Forms tool window,
 * never activated, the pointer passing through it. A file of code or text shows its lines,
 * coloured, numbered, the one the path names lit; any other file the shell's thumbnail (a video's
 * frame, an image, a document's first page; a PDF's first page, which `WINDOWS` renders), else its
 * icon; a folder its icon and its first entries. Under it, the name, the kind and size as the shell
 * words them (a language's name, and its lines, for code), the date in the regional format, and
 * where it is. Sizes in pixels at 96 DPI, scaled to the screen's.
 */
export const WINDOWS_TYPES = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class QuickPeekWindow : Form {
  // The colours of a token's kind (code.ts's Kind), on the window's dark backdrop.
  static readonly Dictionary<string, Color> Palette = new Dictionary<string, Color> {
    { "k", Hex("569CD6") }, { "s", Hex("CE9178") }, { "n", Hex("B5CEA8") }, { "c", Hex("6A9955") },
    { "t", Hex("4EC9B0") }, { "a", Hex("9CDCFE") }, { "f", Hex("DCDCAA") }, { "", Hex("D4D4D4") }
  };
  static readonly Color Backdrop = Color.FromArgb(32, 32, 32);
  static readonly Color Plate = Color.FromArgb(21, 21, 21);
  static readonly Color Lit = Color.FromArgb(48, 48, 48);
  static readonly Color Primary = Color.FromArgb(242, 242, 242);
  static readonly Color Secondary = Color.FromArgb(166, 166, 166);
  static readonly Color Tertiary = Color.FromArgb(112, 112, 112);
  const TextFormatFlags Plain = TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
  const TextFormatFlags Line = Plain | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;

  class Row { public string Text; public Font Font; public Color Color; public TextFormatFlags Flags; public int Before; public Rectangle Bounds; }

  static float scale = 1;
  readonly List<Row> rows = new List<Row>();
  readonly List<string[][]> lines = new List<string[][]>();
  Image picture;
  Rectangle pictureAt;
  Rectangle plateAt;
  Font mono;
  float advance;
  int lineHeight;
  int first;
  int mark;
  int gutter;
  Point pointer;
  IntPtr front;
  DateTime end;
  Timer beat;

  static Color Hex (string hex) { return Color.FromArgb(255, Color.FromArgb(Convert.ToInt32(hex, 16))); }
  static int S (double pixels) { return (int)Math.Round(pixels * scale); }

  // Makes the program aware of each screen's scale, so the window is drawn sharp at its pixels, and
  // says the largest side, in pixels, its picture may have by the pointer.
  public static int Prepare () {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    Point at = Cursor.Position;
    try {
      uint x, y;
      if (GetDpiForMonitor(MonitorFromPoint(at, 2), 0, out x, out y) == 0) scale = x / 96f;
    } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
    Rectangle area = Screen.FromPoint(at).WorkingArea;
    int size;
    if (!int.TryParse(Environment.GetEnvironmentVariable("QUICK_PEEK_SIZE"), out size)) size = 360;
    return (int)Math.Min(S(size), Math.Min(area.Width * 0.5, area.Height * 0.5));
  }

  // Shows path till it ends; page, a PDF's first page, is its picture.
  public static int Run (string path, Image page) {
    int largest = Prepare();
    QuickPeekWindow window = new QuickPeekWindow(path, page, largest);
    if (Environment.GetEnvironmentVariable("QUICK_PEEK_DRY") == "1") {
      Say("dry " + (int)Math.Round(window.Width / scale) + "x" + (int)Math.Round(window.Height / scale) + " " + window.rows.Count + " rows");
      return 0;
    }
    Application.Run(window);
    return 0;
  }

  QuickPeekWindow (string path, Image page, int largest) {
    bool folder = Directory.Exists(path);
    pointer = Cursor.Position;
    Rectangle area = Screen.FromPoint(pointer).WorkingArea;
    int pad = S(12), gap = S(18), inset = S(8);
    mono = new Font(FontFamilyNamed("Cascadia Mono", "Consolas"), 12 * scale, GraphicsUnit.Pixel);
    Font name = new Font("Segoe UI Semibold", 14 * scale, GraphicsUnit.Pixel);
    Font small = new Font("Segoe UI", 12 * scale, GraphicsUnit.Pixel);
    Font smaller = new Font("Segoe UI", 11 * scale, GraphicsUnit.Pixel);

    // The picture: a text file's lines; else the page given, or the shell's thumbnail; else its icon.
    string json = Environment.GetEnvironmentVariable("QUICK_PEEK_CODE");
    string language = null;
    int count = 0;
    int width = 0, height = 0;
    if (!string.IsNullOrEmpty(json)) {
      Dictionary<string, object> code = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
      language = (string)code["language"];
      count = Convert.ToInt32(code["count"]);
      first = Convert.ToInt32(code["first"]);
      mark = Convert.ToInt32(code["mark"]);
      foreach (object line in (object[])code["lines"]) {
        List<string[]> tokens = new List<string[]>();
        foreach (object token in (object[])line) {
          object[] pair = (object[])token;
          tokens.Add(new string[] { (string)pair[0], (string)pair[1] });
        }
        lines.Add(tokens.ToArray());
      }
      // A monospaced font: a piece is as wide as its letters.
      advance = TextRenderer.MeasureText(new string('0', 100), mono, Size.Empty, Plain).Width / 100f;
      lineHeight = TextRenderer.MeasureText("Ag", mono, Size.Empty, Plain).Height + S(2);
      gutter = (first + lines.Count - 1).ToString().Length;
      int widest = 0;
      foreach (string[][] tokens in lines) {
        int letters = gutter + 2;
        foreach (string[] token in tokens) letters += token[1].Length;
        widest = Math.Max(widest, (int)Math.Ceiling(letters * advance));
      }
      width = (int)Math.Min(Math.Max(widest + inset * 2, S(280)), largest * 1.6);
      height = lines.Count * lineHeight + inset * 2;
    } else {
      picture = page;
      if (picture == null && !folder) picture = ShellImage(path, largest, 0x8 | 0x1);
      if (picture != null) {
        double fit = Math.Min(1.0, (double)largest / Math.Max(picture.Width, picture.Height));
        width = Math.Max(1, (int)(picture.Width * fit));
        height = Math.Max(1, (int)(picture.Height * fit));
      } else {
        width = height = S(folder ? 64 : 128);
        picture = ShellImage(path, width, 0x4);
      }
    }

    // The lines under it.
    List<string> details = new List<string>();
    ShFileInfo info = new ShFileInfo();
    SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(info), 0x200 | 0x400);
    // A language's name over the shell's kind, which may be another's (a .ts is a video's to it).
    if (language != null) details.Add(language);
    else if (!string.IsNullOrEmpty(info.szTypeName)) details.Add(info.szTypeName);
    List<string> entries = new List<string>();
    if (folder) {
      try {
        foreach (string entry in Directory.GetFileSystemEntries(path)) {
          string entryName = Path.GetFileName(entry);
          if (entryName.StartsWith(".") || (File.GetAttributes(entry) & FileAttributes.Hidden) != 0) continue;
          entries.Add(entryName + (Directory.Exists(entry) ? "\\" : ""));
        }
        entries.Sort(StrCmpLogicalW);
        details.Add(entries.Count == 1 ? "1 item" : entries.Count + " items");
      } catch (Exception) { }
    } else {
      StringBuilder size = new StringBuilder(32);
      StrFormatByteSizeW(new FileInfo(path).Length, size, size.Capacity);
      details.Add(size.ToString());
      if (language != null) details.Add(count == 1 ? "1 line" : count + " lines");
    }
    details.Add((folder ? Directory.GetLastWriteTime(path) : File.GetLastWriteTime(path)).ToString("g"));
    string home = (Environment.GetEnvironmentVariable("USERPROFILE") ?? "").TrimEnd('\\');
    string where = Path.GetDirectoryName(path) ?? path;
    if (home.Length > 0 && (where.Equals(home, StringComparison.OrdinalIgnoreCase) || where.StartsWith(home + "\\", StringComparison.OrdinalIgnoreCase))) where = "~" + where.Substring(home.Length);

    int inner = Math.Max(width, S(280));
    string shown = string.IsNullOrEmpty(info.szDisplayName) ? Path.GetFileName(path.TrimEnd('\\')) : info.szDisplayName;
    AddRow(string.IsNullOrEmpty(shown) ? path : shown, name, Primary, Plain | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis, 0, inner, 2);
    AddRow(string.Join(" · ", details.ToArray()), small, Secondary, Line, S(3), inner, 1);
    if (folder) {
      for (int i = 0; i < entries.Count && i < 10; i++) AddRow(entries[i], mono, Secondary, Line, i == 0 ? S(3) : 0, inner, 1);
      if (entries.Count > 10) AddRow("…", mono, Secondary, Line, 0, inner, 1);
    }
    AddRow(where, small, Tertiary, Plain | TextFormatFlags.SingleLine | TextFormatFlags.PathEllipsis, S(3), inner, 1);
    string hint = Environment.GetEnvironmentVariable("QUICK_PEEK_HINT");
    if (!string.IsNullOrEmpty(hint)) AddRow(hint, smaller, Tertiary, Line, S(3), inner, 1);

    // Top to bottom: the picture, then the lines.
    Rectangle at = new Rectangle(pad + (inner - width) / 2, pad, width, height);
    if (language != null) plateAt = at; else pictureAt = at;
    int top = pad + height + S(10);
    foreach (Row row in rows) {
      top += row.Before;
      row.Bounds = new Rectangle(pad, top, inner, row.Bounds.Height);
      top += row.Bounds.Height;
    }
    Size outer = new Size(inner + pad * 2, top + pad);

    // Above the pointer and to its right; under it, or to its left, where there is no room: never
    // over the pointer, which stays on the terminal.
    int left = pointer.X + gap;
    int over = pointer.Y - gap - outer.Height;
    if (over < area.Top) over = pointer.Y + gap;
    if (left + outer.Width > area.Right) left = pointer.X - gap - outer.Width;
    left = Math.Max(area.Left, Math.Min(left, area.Right - outer.Width));
    over = Math.Max(area.Top, Math.Min(over, area.Bottom - outer.Height));

    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.None;
    Bounds = new Rectangle(left, over, outer.Width, outer.Height);
    BackColor = Backdrop;
    DoubleBuffered = true;
    // Layered, so the pointer passes through it to the terminal; unseen till it is painted, so
    // the screen never shows it blank.
    Opacity = 0;
  }

  void AddRow (string text, Font font, Color color, TextFormatFlags flags, int before, int width, int most) {
    int tall = TextRenderer.MeasureText(text, font, new Size(width, int.MaxValue), flags).Height;
    int line = TextRenderer.MeasureText("Ag", font, Size.Empty, Plain).Height;
    Row row = new Row();
    row.Text = text;
    row.Font = font;
    row.Color = color;
    row.Flags = flags;
    row.Before = before;
    row.Bounds = new Rectangle(0, 0, width, Math.Min(tall, line * most));
    rows.Add(row);
  }

  // Never activated; a tool window (no taskbar button, no Alt+Tab), topmost, the pointer passing
  // through it; a shadow around it.
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams p = base.CreateParams;
      p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020;
      p.ClassStyle |= 0x00020000;
      return p;
    }
  }

  protected override void OnHandleCreated (EventArgs e) {
    base.OnHandleCreated(e);
    // Rounded corners, where the system draws them (Windows 11).
    int round = 2;
    try { DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch (Exception) { }
  }

  protected override void OnShown (EventArgs e) {
    base.OnShown(e);
    Update();
    Opacity = 0.98;
    Say("shown");
    // A pointer that leaves the terminal says nothing to it: the window also ends when another
    // window comes to the front, or the pointer goes rows away from the path.
    front = GetForegroundWindow();
    int life;
    if (!int.TryParse(Environment.GetEnvironmentVariable("QUICK_PEEK_LIFE"), out life)) life = 60;
    end = DateTime.Now.AddSeconds(life);
    beat = new Timer();
    beat.Interval = 100;
    beat.Tick += delegate {
      if (DateTime.Now > end || Math.Abs(Cursor.Position.Y - pointer.Y) > S(120) || GetForegroundWindow() != front || !Say(".")) Close();
    };
    beat.Start();
  }

  protected override void OnPaint (PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    if (lines.Count > 0) {
      // The lines on a darker plate, top first, each cut where the plate ends.
      using (GraphicsPath plate = Rounded(plateAt, S(6))) using (SolidBrush fill = new SolidBrush(Plate)) g.FillPath(fill, plate);
      int inset = S(8);
      int right = plateAt.Right - inset;
      int top = plateAt.Y + inset;
      for (int i = 0; i < lines.Count; i++) {
        int number = first + i;
        if (number == mark) using (SolidBrush lit = new SolidBrush(Lit)) g.FillRectangle(lit, plateAt.X + inset, top, plateAt.Width - inset * 2, lineHeight);
        float x = Piece(g, number.ToString().PadLeft(gutter) + "  ", Tertiary, plateAt.X + inset, top, right);
        foreach (string[] token in lines[i]) {
          Color ink;
          if (!Palette.TryGetValue(token[0], out ink)) ink = Palette[""];
          x = Piece(g, token[1], ink, x, top, right);
        }
        top += lineHeight;
      }
    } else if (picture != null) {
      g.DrawImage(picture, pictureAt);
    }
    foreach (Row row in rows) TextRenderer.DrawText(g, row.Text, row.Font, row.Bounds, row.Color, row.Flags);
  }

  // Draws text at x, ending in an ellipsis where the plate ends; says where the next piece starts.
  float Piece (Graphics g, string text, Color color, float x, int top, int right) {
    if (x >= right || text.Length == 0) return x;
    int at = (int)Math.Round(x);
    TextRenderer.DrawText(g, text, mono, new Rectangle(at, top, right - at, lineHeight), color, Line);
    return x + text.Length * advance;
  }

  static GraphicsPath Rounded (Rectangle r, int radius) {
    GraphicsPath path = new GraphicsPath();
    int d = radius * 2;
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }

  static string FontFamilyNamed (params string[] names) {
    foreach (string wanted in names) foreach (FontFamily family in FontFamily.Families) if (family.Name == wanted) return wanted;
    return FontFamily.GenericMonospace.Name;
  }

  // Says a line to the one reading; false once nobody reads.
  static bool Say (string text) {
    try {
      Console.Out.WriteLine(text);
      Console.Out.Flush();
      return true;
    } catch (IOException) {
      return false;
    }
  }

  // The shell's picture of path, side pixels at most: flags ask for a thumbnail (0x8) or the icon (0x4).
  static Bitmap ShellImage (string path, int side, int flags) {
    IShellItemImageFactory factory;
    try { SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory); } catch (Exception) { return null; }
    try {
      IntPtr handle;
      ShSize size;
      size.cx = side;
      size.cy = side;
      if (factory.GetImage(size, flags, out handle) != 0 || handle == IntPtr.Zero) return null;
      try { return WithAlpha(handle); } finally { DeleteObject(handle); }
    } finally {
      Marshal.ReleaseComObject(factory);
    }
  }

  // A bitmap of the shell's with its transparency kept; one with no alpha at all is opaque. Copied a
  // row at a time: the shell's are often bottom-up, their stride negative.
  static Bitmap WithAlpha (IntPtr handle) {
    using (Bitmap plain = Image.FromHbitmap(handle)) {
      if (Image.GetPixelFormatSize(plain.PixelFormat) < 32) return new Bitmap(plain);
      Rectangle all = new Rectangle(0, 0, plain.Width, plain.Height);
      Bitmap kept = new Bitmap(plain.Width, plain.Height, PixelFormat.Format32bppArgb);
      BitmapData from = plain.LockBits(all, ImageLockMode.ReadOnly, plain.PixelFormat);
      BitmapData to = kept.LockBits(all, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      bool hasAlpha = false;
      try {
        byte[] row = new byte[plain.Width * 4];
        for (int y = 0; y < plain.Height; y++) {
          Marshal.Copy(IntPtr.Add(from.Scan0, y * from.Stride), row, 0, row.Length);
          for (int i = 3; i < row.Length && !hasAlpha; i += 4) hasAlpha = row[i] != 0;
          Marshal.Copy(row, 0, IntPtr.Add(to.Scan0, y * to.Stride), row.Length);
        }
      } finally {
        plain.UnlockBits(from);
        kept.UnlockBits(to);
      }
      if (hasAlpha) return kept;
      kept.Dispose();
      return new Bitmap(plain);
    }
  }

  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage (ShSize size, int flags, out IntPtr bitmap); }
  [StructLayout(LayoutKind.Sequential)]
  struct ShSize { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ShFileInfo {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName (string path, IntPtr context, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItemImageFactory item);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo (string path, uint attributes, ref ShFileInfo info, uint size, uint flags);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr StrFormatByteSizeW (long size, StringBuilder buffer, int length);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int StrCmpLogicalW (string a, string b);
  [DllImport("gdi32.dll")]
  static extern bool DeleteObject (IntPtr handle);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow ();
  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext (IntPtr context);
  [DllImport("user32.dll")]
  static extern bool SetProcessDPIAware ();
  [DllImport("user32.dll")]
  static extern IntPtr MonitorFromPoint (Point point, uint flags);
  [DllImport("shcore.dll")]
  static extern int GetDpiForMonitor (IntPtr monitor, int kind, out uint x, out uint y);
  [DllImport("dwmapi.dll")]
  static extern int DwmSetWindowAttribute (IntPtr window, int attribute, ref int value, int size);
}
`

/**
 * Windows: PowerShell, which compiles the window (`WINDOWS_TYPES`, told in QUICK_PEEK_TYPES: too
 * long for a command line) once into the temp folder, named by its hash, then loads it from there;
 * a PDF's first page is rendered by Windows.Data.Pdf, as the shell may have no thumbnail for it.
 */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
# No progress records on stderr; what it says, in UTF-8.
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $source = $env:QUICK_PEEK_TYPES
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 12)
  $assembly = Join-Path $env:TEMP "quick-peek-window-$hash.dll"
  if (-not (Test-Path -LiteralPath $assembly)) {
    # Compiled aside, then moved in: another preview compiling it at the same time finds it whole.
    $building = Join-Path $env:TEMP "quick-peek-window-$hash-$PID.dll"
    try {
      Add-Type -OutputAssembly $building -OutputType Library -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition $source
      Move-Item -LiteralPath $building -Destination $assembly
    } catch {
      if (-not (Test-Path -LiteralPath $assembly)) { throw }
    } finally {
      Remove-Item -LiteralPath $building -ErrorAction SilentlyContinue
    }
  }
  Add-Type -Path $assembly
  $path = [IO.Path]::GetFullPath($env:QUICK_PEEK_FILE)
  if (-not (Test-Path -LiteralPath $path)) { [Console]::Out.WriteLine('error: not there'); exit 0 }
  $page = $null
  if (-not $env:QUICK_PEEK_CODE -and $path -match '\.pdf$') {
    try {
      $largest = [QuickPeekWindow]::Prepare()
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
      $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
      $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
      $tasks = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
      $operation = $tasks | Where-Object { $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1' }
      $action = $tasks | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' }
      function Wait ($pending, $type) {
        $task = $operation.MakeGenericMethod($type).Invoke($null, @($pending))
        $null = $task.Wait(5000)
        $task.Result
      }
      $file = Wait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
      $document = Wait ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
      $first = $document.GetPage(0)
      $fit = [Math]::Min($largest / $first.Size.Width, $largest / $first.Size.Height)
      $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $options.DestinationWidth = [uint32][Math]::Max(1, $first.Size.Width * $fit)
      $options.DestinationHeight = [uint32][Math]::Max(1, $first.Size.Height * $fit)
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      $null = $action.Invoke($null, @($first.RenderToStreamAsync($stream, $options))).Wait(5000)
      $stream.Seek(0)
      $memory = New-Object IO.MemoryStream
      [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream).CopyTo($memory)
      $memory.Position = 0
      $page = [System.Drawing.Image]::FromStream($memory)
    } catch {
      # A PDF it cannot read shows the shell's thumbnail, or its icon.
      $page = $null
    }
  }
  exit ([QuickPeekWindow]::Run($path, $page))
} catch {
  [Console]::Out.WriteLine('error: ' + $_.Exception.Message)
  exit 1
}
`

/**
 * Windows: Explorer with QUICK_PEEK_FILE selected, and the file or folder opened with its app.
 * Started hidden, as the engine starts a program, Explorer opens its window hidden too: the shell
 * is asked through PowerShell, which opens it shown.
 */
export const WINDOWS_REVEAL = String.raw`Start-Process explorer -ArgumentList ('/select,"' + $env:QUICK_PEEK_FILE + '"')`
export const WINDOWS_OPEN = String.raw`Invoke-Item -LiteralPath $env:QUICK_PEEK_FILE`

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

/**
 * How PowerShell runs one of these scripts: no profile, no prompts, no script policy in the way,
 * in a single-threaded apartment, as Windows Forms and the shell's objects need.
 */
export const powershell = (script: string) => ['powershell', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)]
