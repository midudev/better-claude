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

const encodedCache = new Map<string, string>()

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
function encodedCommand (script: string) {
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

// Explorer takes `/select,` and the path as one argument, with quotes around the path alone.
// PowerShell hands it that line as written, the path read from the environment (QUICK_PEEK_FILE).
const SELECT = String.raw`Start-Process explorer.exe -ArgumentList ('/select,"' + $env:QUICK_PEEK_FILE + '"')`

/**
 * How Windows' Explorer is asked for `path`, a Windows path: opened (a folder in a window, a
 * file with its app), or its folder shown with it selected. An argument that holds a space is
 * quoted whole when it is run, and Explorer, given `"/select,C:\My Videos\a.mp4"`, opens
 * Documents: such a path, or one with a comma, goes through PowerShell.
 */
export function explorer (path: string, isOpening: boolean): { argv: string[]; env?: Record<string, string> } {
  if (isOpening) return { argv: ['explorer', path] }
  if (!/[\s,]/.test(path)) return { argv: ['explorer', `/select,${path}`] }
  return {
    argv: ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(SELECT)],
    env: { QUICK_PEEK_FILE: path }
  }
}
