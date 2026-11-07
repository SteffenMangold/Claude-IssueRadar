// Text that came from outside the mod (GitHub, a model, a draft, the
// conversation), made safe to draw. The engine refuses a pane tree whose texts
// hold a control character other than tab and newline, the kitty image
// placeholder U+10EEEE, U+2800 followed by a combining mark that image cells
// use, or a text or Link label that opens with such a mark; a refused tree is
// not drawn, and the pane is closed.

/** Every C0 control but tab (U+0009) and newline (U+000A), DEL, every C1 control, and the kitty image placeholder U+10EEEE. */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{10EEEE}]/gu
/** Combining marks right after U+2800, which image cells could draw together (the engine's marks are a subset of \p{M}). */
const BLANK_MARKS = /\u2800\p{M}+/gu
/** Combining marks at the very start, which could join the text drawn before them. */
const LEADING_MARKS = /^\p{M}+/u

/**
 * `text` as the pane may draw it: line breaks as newlines (CR LF and a lone CR become LF), every other control
 * character and the image placeholder dropped (tab and newline kept), no combining mark after U+2800 and none at the
 * start. The steps run in this order, so dropping one character never leaves a refused pair behind.
 */
export function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROLS, '').replace(BLANK_MARKS, '\u2800').replace(LEADING_MARKS, '')
}

/** `text` cleaned and folded to one line (runs of whitespace as one space, trimmed), then cleaned again: a trim can bare a leading mark. */
export function cleanLine(text: string): string {
  return clean(clean(text).replace(/\s+/g, ' ').trim())
}
