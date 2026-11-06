// Text that came from outside the mod (GitHub, a model, a draft, the
// conversation), made safe to draw: a pane tree whose texts hold a control
// character other than tab and newline is refused, and the pane is closed.

/** Every C0 control but tab (U+0009) and newline (U+000A), DEL, and every C1 control. */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** `text` with line breaks as newlines (CR LF and a lone CR become LF) and every other control character dropped, tab and newline kept. */
export function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROLS, '')
}
